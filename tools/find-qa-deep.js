/**
 * find-qa-deep.js - Deep Reasoning với Iterative Knowledge Lookup
 *
 * Thay vì trả về answer ngay, tool này:
 * 1. Tìm answer ban đầu
 * 2. Phát hiện references trong answer (e.g., "see QA #123", "refer to X pattern")
 * 3. Tự động lookup referenced knowledge
 * 4. Tổng hợp thành complete answer
 *
 * Example:
 *   Q: "How to refactor to UA?"
 *   A1: "Extract Service layer (see: How to create Service?)"
 *   → Auto-lookup: "How to create Service?"
 *   A2: "Create Service class with constructor injection..."
 *   → Merge: A1 + A2 = Complete answer
 */

const { pool, embed, askLocal, tokenize, qaRankingQuery } = require('../core');

const MAX_DEPTH = 3; // Prevent infinite loops
const MODE = process.argv.includes('--raw') ? 'raw' : 'smart';
const PROJECT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project='));
  return arg ? arg.split('=')[1].trim().toLowerCase() : null;
})();
const ALL_PROJECTS = process.argv.includes('--all-projects');

async function findQADeep(question, depth = 0) {
  if (depth >= MAX_DEPTH) {
    console.log(`[DEPTH LIMIT] Reached max depth ${MAX_DEPTH}`);
    return null;
  }

  console.log(`${'  '.repeat(depth)}[DEPTH ${depth}] Query: "${question}"`);

  // Step 1: Find initial answer
  const query = question.trim().toLowerCase();
  const tokens = tokenize(query);
  const vec = await embed(query);

  const qq = qaRankingQuery({ limit: 1, project: PROJECT, allProjects: ALL_PROJECTS });
  const result = await pool.query(qq.text, qq.params(tokens, JSON.stringify(vec), null, query, PROJECT));

  if (result.rows.length === 0) {
    console.log(`${'  '.repeat(depth)}[MISS] No answer found`);
    return null;
  }

  const qa = result.rows[0];
  await pool.query(
    'UPDATE agent_qa_cache SET hit_count = hit_count + 1, retrieval_count = retrieval_count + 1, last_retrieved_at = NOW() WHERE id = $1',
    [qa.id]
  );

  console.log(`${'  '.repeat(depth)}[HIT] QA #${qa.id} (score: ${(qa.final_score * 100).toFixed(0)}%)`);

  // Step 2: Detect references in answer
  const references = detectReferences(qa.answer_context);

  if (references.length === 0) {
    // No references, return as-is
    return {
      question: qa.question,
      answer: qa.answer_context,
      references: [],
      depth
    };
  }

  console.log(`${'  '.repeat(depth)}[REFS] Found ${references.length} references`);

  // Step 3: Recursively lookup referenced knowledge
  const expandedRefs = [];
  for (const ref of references) {
    console.log(`${'  '.repeat(depth)}  → "${ref}"`);
    const refAnswer = await findQADeep(ref, depth + 1);
    if (refAnswer) {
      expandedRefs.push(refAnswer);
    }
  }

  // Step 4: Merge answers
  return {
    question: qa.question,
    answer: qa.answer_context,
    references: expandedRefs,
    depth
  };
}

/**
 * Detect references in answer text
 * Patterns:
 * - "see: How to X?"
 * - "refer to X pattern"
 * - "(see QA #123)"
 * - "check X documentation"
 */
function detectReferences(text) {
  const refs = [];

  // Pattern 1: "see: Question?"
  const seePattern = /see:\s*([^.]+\?)/gi;
  let match;
  while ((match = seePattern.exec(text)) !== null) {
    refs.push(match[1].trim());
  }

  // Pattern 2: "refer to X"
  const referPattern = /refer to\s+([^.,]+)/gi;
  while ((match = referPattern.exec(text)) !== null) {
    const topic = match[1].trim();
    refs.push(`How to ${topic}?`);
  }

  // Pattern 3: "(see QA #123)"
  const qaIdPattern = /\(see QA #(\d+)\)/gi;
  while ((match = qaIdPattern.exec(text)) !== null) {
    refs.push(`qa_id:${match[1]}`);
  }

  return refs;
}

/**
 * Format deep answer for display
 */
function formatDeepAnswer(result, indent = 0) {
  const prefix = '  '.repeat(indent);
  let output = '';

  output += `${prefix}Q: ${result.question}\n`;
  output += `${prefix}A: ${result.answer}\n`;

  if (result.references.length > 0) {
    output += `${prefix}[Expanded References]:\n`;
    for (const ref of result.references) {
      output += formatDeepAnswer(ref, indent + 1);
    }
  }

  return output;
}

/**
 * Synthesize complete answer using LLM
 */
async function synthesizeAnswer(deepResult, originalQuestion) {
  // Flatten all answers into context
  const contexts = [];

  function collectAnswers(node, depth = 0) {
    contexts.push(`[Depth ${depth}] ${node.question}\n${node.answer}`);
    for (const ref of node.references) {
      collectAnswers(ref, depth + 1);
    }
  }

  collectAnswers(deepResult);

  const prompt = `Dựa vào các kiến thức sau (đã được tra cứu đệ quy), tổng hợp thành câu trả lời hoàn chỉnh cho câu hỏi ban đầu.

=== KIẾN THỨC (ĐÃ TRA CỨU ĐỆ QUY) ===
${contexts.join('\n\n')}

=== CÂU HỎI BAN ĐẦU ===
${originalQuestion}

=== TRẢ LỜI HOÀN CHỈNH ===`;

  const system = 'Bạn là chuyên gia tổng hợp kiến thức. Kết hợp tất cả thông tin đã tra cứu thành câu trả lời mạch lạc, đầy đủ.';

  const llmResult = await askLocal(prompt, { system, maxTokens: 1024 });
  return llmResult.text;
}

// Main execution
(async () => {
  const question = process.argv[2];

  if (!question) {
    console.log('Usage: node find-qa-deep.js "<Question>" [--project=erp] [--all-projects] [--raw]');
    console.log('Example: node find-qa-deep.js "How to refactor to UA?"');
    process.exit(1);
  }

  try {
    console.log(`[DEEP SEARCH] Starting iterative lookup for: "${question}"\n`);

    const deepResult = await findQADeep(question);

    if (!deepResult) {
      console.log('\n[MISS] No answer found');
      process.exit(0);
    }

    console.log('\n=== DEEP ANSWER (RAW) ===');
    console.log(formatDeepAnswer(deepResult));

    if (MODE === 'smart' && deepResult.references.length > 0) {
      console.log('\n=== SYNTHESIZED ANSWER ===');
      const synthesized = await synthesizeAnswer(deepResult, question);
      console.log(synthesized);
    }

  } catch (err) {
    console.error('[ERROR]', err.message);
  } finally {
    await pool.end();
  }
})();
