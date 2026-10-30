/**
 * find-qa-context.js - Pre-flight Context Sweep
 *
 * Mục tiêu: Thay vì gọi find-qa.js 1 lần với 1 câu hỏi,
 * tool này tự động decompose task thành nhiều sub-query (multi-angle search),
 * sweep DB 1 lần duy nhất, dedup, và trả về toàn bộ context liên quan.
 *
 * Usage:
 *   node tools/find-qa-context.js "<task description>" [--tags=ua,winforms] [--limit=5]
 */

const { pool, embed, tokenize, qaRankingQuery, normalizeTags, inferTags, storageAme, config } = require('../core');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Parse args
const task = process.argv[2];
const IS_FULL = process.argv.includes('--full');
const BACKEND_ARG = process.argv.find(a => a.startsWith('--backend='))?.split('=')[1]?.toLowerCase();
const PROJECT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project='));
  return arg ? arg.split('=')[1].trim().toLowerCase() : null;
})();
const ALL_PROJECTS = process.argv.includes('--all-projects');

function inferTagsFromGit() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 2000 });
    const lines = status.split('\n');
    const tags = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      const filePath = line.substring(3).trim();
      const parts = filePath.replace(/\\/g, '/').split('/');
      
      // Infer project branch (MDS, RAF, MOP, MLG2)
      if (parts.includes('MDS')) tags.add('project:mds');
      if (parts.includes('RAF')) tags.add('project:raf');
      if (parts.includes('MOP')) tags.add('project:mop');
      if (parts.includes('MLG2')) tags.add('project:mlg2');
      
      // Infer feature name
      const featuresIdx = parts.indexOf('Features');
      if (featuresIdx !== -1 && parts[featuresIdx + 1]) {
        const feature = parts[featuresIdx + 1].trim().toLowerCase();
        if (feature) tags.add(feature);
      }
    }
    return [...tags];
  } catch (e) {
    return [];
  }
}

const TAGS = (() => {
  const arg = process.argv.find(a => a.startsWith('--tags='));
  const raw = arg ? arg.split('=')[1].split(',').map(t => t.trim()).filter(t => t) : [];
  
  // 1. Infer from git status modified files
  const gitTags = inferTagsFromGit();
  
  // 2. Infer from query text (task description) using inferTags
  const textTags = inferTags(task, '', []);
  
  // Combine all raw tags
  const combinedRaw = [...new Set([...raw, ...gitTags, ...textTags])];
  return normalizeTags(combinedRaw);
})();
const LIMIT = (() => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  return arg ? parseInt(arg.split('=')[1]) : 8;
})();
const MIN_SCORE = 0.38;

/**
 * Load decomposition angles from config file
 */
const ANGLES = (() => {
  try {
    // Look for decompose-angles.json alongside this file
    const configPath = path.join(__dirname, 'decompose-angles.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')).angles || [];
  } catch (e) {
    console.warn('[WARN] decompose-angles.json not found, using empty angles');
    return [];
  }
})();

/**
 * Decompose một task description thành nhiều sub-queries để search đa góc độ
 */
function decomposeToQueries(taskDescription) {
  const queries = [taskDescription];
  const lower = taskDescription.toLowerCase();

  for (const angle of ANGLES) {
    if (new RegExp(angle.match, 'i').test(lower)) {
      for (const q of angle.queries) {
        queries.push(q.replace('{task}', taskDescription));
      }
    }
  }

  return [...new Set(queries)];
}

async function resolveActiveBackend() {
  if (BACKEND_ARG === 'ame') return 'ame';
  if (BACKEND_ARG === 'postgres' || BACKEND_ARG === 'pg') return 'postgres';
  if (config.backend === 'ame') return 'ame';
  if (config.backend === 'postgres') return 'postgres';

  // auto mode: check if AME is ready
  const status = await storageAme.isAmeAvailable();
  if (status.available) return 'ame';
  return 'postgres';
}

/**
 * Search DB với 1 query, return top rows
 */
async function searchOne(question, tagsFilter, activeBackend, project, allProjects) {
  if (activeBackend === 'ame') {
    try {
      return await storageAme.queryContext(question, {
        limit: 5,
        minSimilarity: MIN_SCORE,
        tags: tagsFilter,
        project: allProjects ? null : project
      });
    } catch (e) {
      return [];
    }
  }

  // PostgreSQL fallback
  const query = question.trim().toLowerCase();
  const tokens = tokenize(query);
  const vec = await embed(query);

  const filterTags = tagsFilter.length > 0 ? tagsFilter : null;
  const qq = qaRankingQuery({
    limit: 5,
    minSimilarity: MIN_SCORE,
    project,
    allProjects,
  });
  const result = await pool.query(
    qq.text,
    qq.params(tokens, JSON.stringify(vec), filterTags, query, project)
  );

  return result.rows;
}

/**
 * Main: Multi-angle sweep + dedup + format
 */
async function findQAContext(taskDescription) {
  const activeBackend = await resolveActiveBackend();
  console.log(`[CONTEXT SWEEP] Task: "${taskDescription}"`);
  console.log(`[CONTEXT SWEEP] Backend: ${activeBackend === 'ame' ? '⚡ AME (Sub-millisecond Cognitive)' : '🐘 PostgreSQL'}`);
  console.log(`[CONTEXT SWEEP] Scope: ${ALL_PROJECTS ? 'all projects (explicit)' : PROJECT ? `project:${PROJECT} + global` : 'global only'}`);
  console.log(`[CONTEXT SWEEP] Tags filter: ${TAGS.length > 0 ? TAGS.join(',') : 'none'}\n`);

  const queries = decomposeToQueries(taskDescription);
  console.log(`[ANGLES] ${queries.length} sub-queries generated:`);
  queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  console.log();

  const seen = new Map();

  for (const q of queries) {
    try {
      const rows = await searchOne(q, TAGS, activeBackend, PROJECT, ALL_PROJECTS);
      rows.forEach((row, index) => {
        const rank = index + 1;
        const crossRrfAdd = 1.0 / (60.0 + rank);

        if (!seen.has(row.id)) {
          seen.set(row.id, {
            ...row,
            matched_queries: [q],
            cross_rrf_score: crossRrfAdd,
            max_db_score: row.final_score
          });
        } else {
          const existing = seen.get(row.id);
          existing.matched_queries.push(q);
          existing.cross_rrf_score += crossRrfAdd;
          existing.max_db_score = Math.max(existing.max_db_score, row.final_score);
        }
      });
    } catch (err) {
      // continue on single query failure
    }
  }

  if (seen.size === 0) {
    console.log('[CONTEXT MISS] No relevant knowledge found in DB.');
    return;
  }

  const collected = Array.from(seen.values());
  collected.sort((a, b) => b.cross_rrf_score - a.cross_rrf_score);
  const top = collected.slice(0, LIMIT);

  const ids = top.map(r => r.id);
  if (ids.length > 0 && activeBackend === 'postgres') {
    try {
      await pool.query(
        `UPDATE agent_qa_cache
         SET hit_count = hit_count + 1,
             retrieval_count = retrieval_count + 1,
             last_retrieved_at = NOW()
         WHERE id = ANY($1::int[])`,
        [ids]
      );
    } catch {}
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[CONTEXT RESULT] ${top.length} relevant QA entries found (from ${collected.length} total matches, ${queries.length} angles)`);
  console.log(`${'='.repeat(60)}\n`);

  if (!IS_FULL) {
    console.log(`📌 [PROGRESSIVE DISCLOSURE: L0 INDEX] (Append --full for complete context, or run: node brain.js view <id>)\n`);
    top.forEach((row, i) => {
      const score = (row.max_db_score * 100).toFixed(0);
      const tags = (row.tags || []).join(', ');
      const cleanAnswer = (row.answer_context || '').replace(/\r?\n+/g, ' ').trim();
      const preview = cleanAnswer.length > 140 ? cleanAnswer.substring(0, 137) + '...' : cleanAnswer;

      console.log(`[#${row.id}] (${score}% match) [${tags}] ${row.question}`);
      console.log(`      └─ Gotcha/Fix: ${preview}`);
    });
    console.log(`\n💡 To view detailed root cause & code snippet for any entry, run: node brain.js view <id>`);
  } else {
    top.forEach((row, i) => {
      const score = (row.max_db_score * 100).toFixed(0);
      const rrfDisplay = (row.cross_rrf_score * 100).toFixed(1);
      const tags = (row.tags || []).join(', ');
      console.log(`--- [${i + 1}] QA #${row.id} | DB_Score: ${score}% | Cross_RRF: ${rrfDisplay} | Tags: ${tags} ---`);
      console.log(`Q: ${row.question}`);
      console.log(`A: ${row.answer_context}`);
      console.log(`   [matched via: ${row.matched_queries.map(q => `"${q}"`).join(', ')}]\n`);
    });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[SUMMARY] ${top.length} knowledge items resolved. Use these as pre-context before coding.`);
  console.log(`${'='.repeat(60)}`);
}

// Entry
(async () => {
  if (!task) {
    console.log('Usage: node tools/find-qa-context.js "<task description>" [--tags=ua,winforms] [--limit=8] [--project=erp] [--all-projects]');
    process.exit(1);
  }

  try {
    await findQAContext(task);
  } catch (err) {
    console.error('[ERROR]', err.message);
  } finally {
    await pool.end();
  }
})();
