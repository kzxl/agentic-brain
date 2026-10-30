/**
 * server.js - Semantic Brain Warm Server
 *
 * Giữ DB pool + Embedding model warm trong memory.
 * CLI scripts tự động kết nối nếu server đang chạy, fallback nếu không.
 *
 * Start:  node server.js   (hoặc: npm start)
 * Stop:   Ctrl+C hoặc gọi POST /shutdown
 * Status: GET /health
 */
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const { pool, embed, askLocal, tokenize, qaRankingQuery, recipeRankingQuery, skillRankingQuery, captureKnowledge, ingestText } = require('./core');
const config = require('./core/config');

const PORT = config.server.port;
const HOST = config.server.host;
const MAX_BODY_BYTES = config.server.maxBodyBytes;
const API_TOKEN = config.server.apiToken;

// Domain-driven system prompt — lấy từ .env, không hardcode
const DOMAIN_DESCRIPTION = config.domain.description;
const AGENT_ROOT = config.agentRoot;

const PUBLIC_PATHS = new Set(['/health', '/ready']);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isAuthorized(req) {
  if (!API_TOKEN) return true; // local-only mode; BIND_HOST defaults to 127.0.0.1
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  return safeEqual(token, API_TOKEN);
}

// ============================================================
// Route handlers
// ============================================================

async function handleFindQA(query, mode, tags, project = null, allProjects = false, resStream = null) {
  const tokens = tokenize(query);
  const vec = await embed(query);
  const filterTags = Array.isArray(tags) && tags.length > 0 ? tags : null;

  const qq = qaRankingQuery({ limit: 3, project, allProjects });
  const result = await pool.query(
    qq.text,
    qq.params(tokens, JSON.stringify(vec), filterTags, query, project)
  );

  if (result.rows.length === 0) {
    return { status: 'MISS', question: query };
  }

  const top = result.rows[0];
  await pool.query(
    `UPDATE agent_qa_cache
     SET hit_count = hit_count + 1,
         retrieval_count = retrieval_count + 1,
         last_retrieved_at = NOW()
     WHERE id = $1`,
    [top.id]
  );

  // Log query for analytics (fire-and-forget)
  pool.query(
    'INSERT INTO agent_qa_querylog (query, top_result_id, score, tags, source, tokens_saved) VALUES ($1, $2, $3, $4, $5, $6)',
    [query, top.id, top.final_score, tags || null, 'server', top.answer_context ? Math.max(0, Math.round(2000 - top.answer_context.length * 0.35)) : 0]
  ).catch(() => {});

  if (mode === 'raw' || top.final_score > 0.7) {
    return {
      status: 'HIT',
      score: +(top.final_score * 100).toFixed(0),
      confidence: top.confidence_score,
      question: top.question,
      answer: top.answer_context,
    };
  }

  // Smart mode: LLM synthesis
  const contexts = result.rows.map((r, i) =>
    `[${i + 1}] Q: ${r.question}\nA: ${r.answer_context}`
  ).join('\n\n');

  const prompt = `Dựa vào các kiến thức sau đây, trả lời câu hỏi một cách chính xác và ngắn gọn bằng tiếng Việt.\n\n=== KIẾN THỨC THAM KHẢO ===\n${contexts}\n\n=== CÂU HỎI ===\n${query}\n\n=== TRẢ LỜI ===`;
  const system = `Bạn là ${DOMAIN_DESCRIPTION}. Chỉ trả lời dựa trên kiến thức được cung cấp. Ngắn gọn, kỹ thuật.`;

  if (resStream) {
    // Streaming mode
    resStream.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const { askLocalStream } = require('./core');
    const finalAns = await askLocalStream(prompt, { system }, (token) => {
      resStream.write(`data: ${JSON.stringify({ token })}\n\n`);
    });

    // Optional auto-save. Disabled by default; when enabled, normalize into atoms.
    if (config.smartAutoSave && finalAns.text.length > 50 && top.final_score > 0.5) {
      ingestText({
        text: `Q: ${query}\nA: ${finalAns.text}`,
        project,
        source: 'smart-rag',
        sourceRef: `smart-rag:${Date.now()}`,
        confidence: 0.5,
      }).catch(err => console.error('[AUTO-SAVE]', err.message));
    }

    resStream.write(`data: ${JSON.stringify({
      status: 'SMART',
      contexts: result.rows.length,
      topScore: +(top.final_score * 100).toFixed(0),
      question: query,
      full_answer: finalAns.text,
      source: finalAns.source
    })}\n\n`);

    resStream.write('data: [DONE]\n\n');
    resStream.end();
    return null; // Sent stream
  } else {
    const llmResult = await askLocal(prompt, { system });

    // Optional auto-save. Disabled by default; when enabled, normalize into atoms.
    if (config.smartAutoSave && llmResult.text.length > 50 && top.final_score > 0.5) {
      ingestText({
        text: `Q: ${query}\nA: ${llmResult.text}`,
        project,
        source: 'smart-rag',
        sourceRef: `smart-rag:${Date.now()}`,
        confidence: 0.5,
      }).catch(err => console.error('[AUTO-SAVE]', err.message));
    }

    return {
      status: 'SMART',
      contexts: result.rows.length,
      topScore: +(top.final_score * 100).toFixed(0),
      question: query,
      answer: llmResult.text,
      source: llmResult.source
    };
  }
}

async function handleFindRecipe(intent, pathVal) {
  const query = intent.trim().toLowerCase();
  const tokens = tokenize(query);
  const vec = await embed(query);

  const rq = recipeRankingQuery({ limit: 1 });
  const result = await pool.query(rq.text, rq.params(tokens, JSON.stringify(vec), pathVal));

  if (result.rows.length === 0) {
    return { error: 'RECIPE_MISS' };
  }

  const row = result.rows[0];
  await pool.query('UPDATE agent_recipes SET hit_count = hit_count + 1 WHERE id = $1', [row.id]);
  const steps = typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps;

  return {
    _req: row.intent,
    _id: row.id,
    pattern: row.target_pattern || undefined,
    steps: steps.map(s => ({ act: s.action, params: s.params })),
  };
}

async function handleFindSkill(intent, topN) {
  const query = intent.trim().toLowerCase();
  const tokens = tokenize(query);
  const vec = await embed(query);

  const sq = skillRankingQuery();
  const result = await pool.query(sq.text, sq.params(tokens, topN || 3, JSON.stringify(vec)));

  const path_ = require('path');

  return result.rows.map(r => ({
    name: r.name,
    type: r.type,
    path: (AGENT_ROOT && r.path.startsWith(AGENT_ROOT))
      ? r.path.substring(AGENT_ROOT.length + 1).replace(/\\/g, '/')
      : r.path,
    desc: r.description ? r.description.substring(0, 100) : '',
    score: +(r.final_score * 100).toFixed(0),
  }));
}

async function handleSaveQA(question, answer, opts = {}) {
  if (!question || !answer) {
    const err = new Error('question and answer are required');
    err.status = 400;
    throw err;
  }

  if (answer.length > 2000 && !opts.allow_long && !opts.allowLong) {
    const err = new Error('answer exceeds 2000 characters; split into atomic lessons or pass allow_long=true');
    err.status = 400;
    throw err;
  }

  const tags = Array.isArray(opts.tags)
    ? opts.tags
    : (typeof opts.tags === 'string'
        ? opts.tags.split(',').map(t => t.trim()).filter(Boolean)
        : []);

  return captureKnowledge({
    question,
    answer,
    source: opts.source || 'api',
    category: opts.category || 'general',
    tags,
    confidence: opts.confidence !== undefined ? opts.confidence : 0.5,
    project: opts.project || null,
    pinned: Boolean(opts.pinned),
    scope: opts.scope || null,
  });
}

async function handleMarkRecipe(id, success) {
  if (success) {
    await pool.query('UPDATE agent_recipes SET success_count = success_count + 1, updated_at = NOW() WHERE id = $1', [id]);
  } else {
    await pool.query('UPDATE agent_recipes SET updated_at = NOW() WHERE id = $1', [id]);
  }
  return { status: success ? 'success' : 'fail', id };
}

// ============================================================
// Find Tags (Graph-like Lookup)
// ============================================================
async function handleFindTags(tagsStr, mode) {
  const tags = tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(t => t);
  if (tags.length === 0) return [];

  const op = mode === 'and' ? '@>' : '&&';
  const result = await pool.query(`
    SELECT id, question, answer_context, tags, confidence_score, source
    FROM agent_qa_cache
    WHERE tags ${op} $1::text[]
    ORDER BY confidence_score DESC
    LIMIT 10
  `, [tags]);

  return result.rows.map(r => ({
    id: r.id, question: r.question, answer: r.answer_context,
    tags: r.tags, confidence: r.confidence_score, source: r.source
  }));
}

// ============================================================
// Find QA Deep (Iterative Reasoning with References)
// ============================================================
async function handleFindQADeep(question, tags, project = null, allProjects = false, maxDepth = 3) {
  const MAX_DEPTH = maxDepth;
  const visited = new Set();

  function detectReferences(text) {
    const refs = [];
    const seePattern = /(?:see|refer to|xem|tham khảo):\s*([^.\n]+\?)/gi;
    let match;
    while ((match = seePattern.exec(text)) !== null) {
      refs.push(match[1].trim());
    }
    const idPattern = /\(see QA #(\d+)\)/gi;
    while ((match = idPattern.exec(text)) !== null) {
      refs.push(`#${match[1]}`);
    }
    return refs;
  }

  async function findQADeep(q, depth = 0) {
    if (depth >= MAX_DEPTH) return null;
    if (visited.has(q.toLowerCase())) return null;
    visited.add(q.toLowerCase());

    let result;
    if (q.startsWith('#')) {
      const id = parseInt(q.substring(1));
      result = await pool.query('SELECT * FROM agent_qa_cache WHERE id = $1', [id]);
    } else {
      const tokens = tokenize(q);
      const vec = await embed(q);
      const filterTags = Array.isArray(tags) && tags.length > 0 ? tags : null;

      const qq = qaRankingQuery({ limit: 1, project, allProjects });
      result = await pool.query(
        qq.text,
        qq.params(tokens, JSON.stringify(vec), filterTags, q, project)
      );
    }

    if (result.rows.length === 0) return null;

    const qa = result.rows[0];
    await pool.query(
      `UPDATE agent_qa_cache
       SET hit_count = hit_count + 1,
           retrieval_count = retrieval_count + 1,
           last_retrieved_at = NOW()
       WHERE id = $1`,
      [qa.id]
    );

    const refs = detectReferences(qa.answer_context);
    const expandedRefs = [];

    for (const ref of refs) {
      const refAnswer = await findQADeep(ref, depth + 1);
      if (refAnswer) expandedRefs.push(refAnswer);
    }

    return {
      question: qa.question,
      answer: qa.answer_context,
      id: qa.id,
      confidence: qa.confidence_score,
      depth,
      references: expandedRefs
    };
  }

  const tree = await findQADeep(question, 0);
  if (!tree) return { status: 'MISS', question };

  function buildContext(node, level = 0) {
    const indent = '  '.repeat(level);
    let text = `${indent}[DEPTH ${node.depth}] Q: ${node.question}\n${indent}A: ${node.answer}\n`;
    if (node.references && node.references.length > 0) {
      text += `${indent}References:\n`;
      for (const ref of node.references) {
        text += buildContext(ref, level + 1);
      }
    }
    return text;
  }

  const fullContext = buildContext(tree);
  const prompt = `Dựa vào kiến thức phân cấp sau đây, tổng hợp thành câu trả lời hoàn chỉnh cho câu hỏi gốc. Bao gồm tất cả chi tiết từ các tham chiếu.

=== KNOWLEDGE GRAPH ===
${fullContext}

=== ORIGINAL QUESTION ===
${question}

=== SYNTHESIZED ANSWER ===
Trả lời đầy đủ, bao gồm tất cả chi tiết từ các tham chiếu:`;

  const system = 'Bạn là chuyên gia tổng hợp kiến thức. Kết hợp tất cả thông tin từ knowledge graph thành câu trả lời hoàn chỉnh, chi tiết.';
  const llmResult = await askLocal(prompt, { system });

  return {
    status: 'DEEP',
    question,
    answer: tree.answer,
    synthesized: llmResult.text,
    depth: tree.depth,
    references: tree.references.length,
    mode: 'deep'
  };
}

// ============================================================
// HTTP Server
// ============================================================

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const q = parsed.query;
  const respond = (data, code = 200) => {
    const headers = { 'Content-Type': 'application/json' };
    if (code >= 400) headers.Connection = 'close';
    res.writeHead(code, headers);
    res.end(JSON.stringify(data));
  };

  try {
    if (!PUBLIC_PATHS.has(parsed.pathname) && !isAuthorized(req)) {
      respond({ error: 'unauthorized' }, 401);
      return;
    }

    switch (parsed.pathname) {

      case '/health': {
        const stats = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM agent_qa_cache)::int as qa_total,
            (SELECT COUNT(*) FROM agent_qa_cache WHERE COALESCE(retrieval_count, 0) > 0)::int as qa_used,
            (SELECT SUM(COALESCE(retrieval_count, 0)) FROM agent_qa_cache)::int as qa_retrievals,
            (SELECT COUNT(*) FROM agent_recipes)::int as recipes,
            (SELECT COUNT(*) FROM agent_registry)::int as registry
        `);
        respond({
          status: 'ok',
          domain: config.domain.name,
          uptime: process.uptime() | 0,
          ...stats.rows[0]
        });
        break;
      }

      case '/ready': {
        await pool.query('SELECT 1');
        respond({ status: 'ready' });
        break;
      }

      case '/find-qa': {
        const qaQuery = (q.q || '').toLowerCase();
        const qaMode = q.mode || 'smart';
        const qaProject = q.project || null;
        const qaAll = q.all_projects === 'true';
        const qaTags = q.tags ? q.tags.split(',').map(t => t.trim()).filter(t => t) : null;
        if (q.stream === 'true') {
          const resObj = await handleFindQA(qaQuery, qaMode, qaTags, qaProject, qaAll, res);
          if (resObj) respond(resObj);
        } else {
          respond(await handleFindQA(qaQuery, qaMode, qaTags, qaProject, qaAll));
        }
        break;
      }

      case '/find-recipe':
        respond(await handleFindRecipe(q.q || '', q.path || ''));
        break;

      case '/find-skill':
        respond(await handleFindSkill(q.q || '', parseInt(q.top) || 3));
        break;

      case '/find-tags':
        respond(await handleFindTags(q.tags || '', q.mode || 'or'));
        break;

      case '/find-qa-deep': {
        const deepQuery = (q.q || '').toLowerCase();
        const deepProject = q.project || null;
        const deepAll = q.all_projects === 'true';
        const deepTags = q.tags ? q.tags.split(',').map(t => t.trim()).filter(t => t) : null;
        const maxDepth = parseInt(q.depth) || 3;
        respond(await handleFindQADeep(deepQuery, deepTags, deepProject, deepAll, maxDepth));
        break;
      }

      case '/save-qa':
        if (req.method !== 'POST') { respond({ error: 'POST only' }, 405); break; }
        const body = await readBody(req, MAX_BODY_BYTES);
        respond(await handleSaveQA(body.question, body.answer, body));
        break;

      case '/mark-recipe':
        if (req.method !== 'POST') { respond({ error: 'POST only' }, 405); break; }
        const mbody = await readBody(req, MAX_BODY_BYTES);
        respond(await handleMarkRecipe(mbody.id, mbody.success));
        break;

      case '/shutdown':
        if (req.method !== 'POST') { respond({ error: 'POST only' }, 405); break; }
        respond({ status: 'shutting_down' });
        setTimeout(() => process.exit(0), 100);
        break;

      default:
        respond({ error: 'not_found' }, 404);
    }
  } catch (err) {
    respond({ error: err.message }, err.status || 500);
  }
});

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let done = false;

    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        const err = new Error('payload too large');
        err.status = 413;
        req.pause();
        reject(err);
        return;
      }
      data += c;
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(data));
      } catch {
        const err = new Error('invalid json');
        err.status = 400;
        reject(err);
      }
    });

    req.on('error', err => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

// Warm up embedding model trước khi accept requests
async function warmup() {
  console.log(`[*] Semantic Brain Server — Domain: ${config.domain.name}`);
  console.log('[*] Warming up embedding model...');
  const s = Date.now();
  await embed('warmup test');
  console.log(`[+] Model ready in ${Date.now() - s}ms`);

  // Verify DB
  await pool.query('SELECT 1');
  console.log('[+] DB connection verified');
}

warmup().then(() => {
  server.listen(PORT, HOST, () => {
    if (!API_TOKEN && HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.warn('[WARN] SEMANTIC_API_TOKEN is empty while binding to a non-local host.');
    }
    console.log(`[+] Semantic Brain Server running on http://${HOST}:${PORT}`);
    console.log(`    Auth:      ${API_TOKEN ? 'enabled (Bearer)' : 'disabled (local-only)'}`);
    console.log(`    Endpoints: /find-qa, /find-qa-deep, /find-recipe, /find-skill, /find-tags, /save-qa, /mark-recipe`);
    console.log(`    Health:    http://${HOST}:${PORT}/health  Ready: /ready`);
    console.log(`    Stop:      POST /shutdown or Ctrl+C`);
  });
}).catch(err => {
  console.error('[FATAL] Warmup failed:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[*] Shutting down...');
  server.close();
  await pool.end();
  process.exit(0);
});
