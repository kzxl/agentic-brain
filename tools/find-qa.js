/**
 * find-qa.js - Tìm câu trả lời với Local LLM Reasoning (RAG + Ollama)
 *
 * Cấp 1: Vector match trực tiếp (score > 0.7) → trả raw answer
 * Cấp 2: Lấy top 3 context → LLM local tổng hợp câu trả lời thông minh
 * Cấp 3: Không có context → Auto-QA (gọi cloud API sinh + lưu DB)
 *
 * Usage: node tools/find-qa.js "<question>" [--raw] [--tags=domain:inv,tech:ua]
 */
const { pool, embed, askLocal, callServer, streamServer, isServerUp, tokenize, qaRankingQuery, normalizeTags, storageAme, config } = require('../core');

const MODE = process.argv.includes('--raw') ? 'raw' : 'smart';
const PROJECT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project='));
  return arg ? arg.split('=')[1].trim().toLowerCase() : null;
})();
const ALL_PROJECTS = process.argv.includes('--all-projects');
const TAGS = (() => {
  const arg = process.argv.find(a => a.startsWith('--tags='));
  const raw = arg ? arg.split('=')[1].split(',').map(t => t.trim()).filter(t => t) : [];
  return normalizeTags(raw);
})();

async function findQA(question) {
  if (!question || question.trim().length === 0) {
    console.log('Usage: node tools/find-qa.js "<Question>" [--raw] [--backend=ame|postgres] [--project=erp] [--all-projects]');
    process.exit(1);
  }

  const BACKEND_ARG = process.argv.find(a => a.startsWith('--backend='))?.split('=')[1]?.toLowerCase();
  const isAmeActive = BACKEND_ARG === 'ame' || config.backend === 'ame';

  if (isAmeActive) {
    try {
      const ameResults = await storageAme.queryContext(question, {
        limit: 3,
        minSimilarity: 0.15,
        tags: TAGS,
        project: PROJECT
      });

      if (ameResults && ameResults.length > 0) {
        const top = ameResults[0];
        console.log(`[QA HIT (⚡ AME)] (score: ${(top.final_score * 100).toFixed(0)}%, conf: ${top.confidence_score})`);
        console.log(`Q: ${top.question}`);
        console.log(`A: ${top.answer_context}`);
        process.exit(0);
      } else {
        console.log(`[QA MISS (⚡ AME)] "${question}"`);
        process.exit(0);
      }
    } catch (ameErr) {
      console.error('[AME ERROR]', ameErr.message);
    }
  }

  // Fast path: try warm server first
  if (await isServerUp()) {
    let isFirstToken = true;
    const tagsParam = TAGS.length > 0 ? `&tags=${encodeURIComponent(TAGS.join(','))}` : '';
    const projectParam = PROJECT ? `&project=${encodeURIComponent(PROJECT)}` : '';
    const allProjectsParam = ALL_PROJECTS ? '&all_projects=true' : '';
    const serverResult = await streamServer(`/find-qa?q=${encodeURIComponent(question)}&mode=${MODE}${tagsParam}${projectParam}${allProjectsParam}&stream=true`, (token) => {
      if (isFirstToken) {
        console.log(`[QA SMART] (server: fast, stream: active)`);
        console.log(`Q: ${question}`);
        process.stdout.write(`A: `);
        isFirstToken = false;
      }
      process.stdout.write(token);
    });

    if (serverResult && !serverResult.error) {
      if (serverResult.status === 'HIT' || serverResult.status === 'SMART') {
        if (isFirstToken) {
          console.log(`[QA ${serverResult.status}] (score: ${serverResult.score || serverResult.topScore}%, server: fast)`);
          console.log(`Q: ${serverResult.question || question}`);
          console.log(`A: ${serverResult.answer || serverResult.full_answer || serverResult.text}`);
        } else {
          console.log(); // newline
        }
        if (serverResult.source) console.log(`[via: ${serverResult.source}]`);
        process.exit(0);
      }
      if (serverResult.status === 'MISS') {
        console.log(`[QA MISS] "${question}"`);
        process.exit(0);
      }
    }
  }

  // Slow path: direct execution
  const query = question.trim().toLowerCase();
  const tokens = tokenize(query);
  const vec = await embed(query);

  try {
    const filterTags = TAGS.length > 0 ? TAGS : null;
    const qq = qaRankingQuery({ limit: 3, project: PROJECT, allProjects: ALL_PROJECTS });
    const result = await pool.query(qq.text, qq.params(tokens, JSON.stringify(vec), filterTags, query, PROJECT));
    if (result.rows.length === 0) {
      console.log(`[QA MISS] "${question}"`);
      process.exit(0);
    }

    const top = result.rows[0];
    await pool.query(
      'UPDATE agent_qa_cache SET hit_count = hit_count + 1, retrieval_count = retrieval_count + 1, last_retrieved_at = NOW() WHERE id = $1',
      [top.id]
    );

    pool.query(
      'INSERT INTO agent_qa_querylog (query, top_result_id, score, tags, tokens_saved) VALUES ($1, $2, $3, $4, $5)',
      [question, top.id, top.final_score, TAGS.length > 0 ? TAGS : null, top.answer_context ? Math.max(0, Math.round(2000 - top.answer_context.length * 0.35)) : 0]
    ).catch(() => {});

    if (MODE === 'raw' || top.final_score > 0.7) {
      console.log(`[QA HIT] (score: ${(top.final_score*100).toFixed(0)}%, conf: ${top.confidence_score})`);
      console.log(`Q: ${top.question}`);
      console.log(`A: ${top.answer_context}`);
      process.exit(0);
    }

    // Cấp 2: LLM local tổng hợp từ top 3 context
    const contexts = result.rows.map((r, i) =>
      `[${i+1}] Q: ${r.question}\nA: ${r.answer_context}`
    ).join('\n\n');

    const config = require('../core/config');
    const domainDesc = config.domain.description;

    const prompt = `Dựa vào các kiến thức sau đây, trả lời câu hỏi một cách chính xác và ngắn gọn bằng tiếng Việt.\n\n=== KIẾN THỨC THAM KHẢO ===\n${contexts}\n\n=== CÂU HỎI ===\n${question}\n\n=== TRẢ LỜI ===`;
    const system = `Bạn là ${domainDesc}. Chỉ trả lời dựa trên kiến thức được cung cấp. Ngắn gọn, kỹ thuật.`;

    console.log(`[QA SMART] (${result.rows.length} contexts, top: ${(top.final_score*100).toFixed(0)}%)`);

    const llmResult = await askLocal(prompt, { system });
    console.log(`Q: ${question}`);
    console.log(`A: ${llmResult.text}`);
    console.log(`[via: ${llmResult.source}]`);

  } catch (err) {
    console.error('[ERROR]', err.message);
  } finally {
    await pool.end();
  }
}

findQA(process.argv[2]);
