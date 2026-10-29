/**
 * find-tags.js - Lấy nhanh khối lượng kiến thức bằng Tags (Graph-like Lookup) thay vì so khớp Vector (Vector Search).
 * 
 * Cách dùng:
 *   node find-tags.js "tag1,tag2" [--mode=and|or]
 */
const { pool, callServer } = require('../core');

async function findByTags() {
  const argTags = process.argv[2];
  if (!argTags) {
    console.log('Usage: node find-tags.js "tag1,tag2" [--mode=or]');
    process.exit(1);
  }

  const tags = argTags.split(',').map(t => t.trim().toLowerCase()).filter(t => t);
  const modeArg = process.argv.find(a => a.startsWith('--mode=')) || '--mode=or';
  const mode = modeArg.split('=')[1] === 'and' ? 'and' : 'or';

  // Fast path: try warm server first
  const serverResult = await callServer(`/find-tags?tags=${encodeURIComponent(tags.join(','))}&mode=${mode}`);
  if (serverResult && Array.isArray(serverResult)) {
    if (serverResult.length === 0) {
      console.log(`[TAG MISS] Không tìm thấy Node kiến thức nào cho tags: ${tags.join(', ')}`);
      process.exit(0);
    }
    console.log(`[TAG HIT] Tìm thấy ${serverResult.length} Nodes (Mode: ${mode.toUpperCase()}, server: fast):\n`);
    serverResult.forEach(r => {
      console.log(`- [ID: ${r.id} | Score: ${r.confidence}] [Tags: ${(r.tags || []).join(', ')}]`);
      console.log(`  Q: ${r.question}`);
      const shortAns = r.answer.length > 100
        ? r.answer.slice(0, 100).replace(/\n/g, ' ') + '...'
        : r.answer.replace(/\n/g, ' ');
      console.log(`  A: ${shortAns}\n`);
    });
    process.exit(0);
  }

  // Slow path: direct DB query

  try {
    let query, params;
    if (mode === 'and') {
      // Chứa TOÀN BỘ tag (@>)
      query = `
        SELECT id, question, answer_context, tags, confidence_score, source 
        FROM agent_qa_cache 
        WHERE tags @> $1::text[]
        ORDER BY confidence_score DESC, hit_count DESC
        LIMIT 10
      `;
      params = [tags];
    } else {
      // Chứa BẤT KỲ tag nào (&&)
      query = `
        SELECT id, question, answer_context, tags, confidence_score, source 
        FROM agent_qa_cache 
        WHERE tags && $1::text[]
        ORDER BY confidence_score DESC, hit_count DESC
        LIMIT 10
      `;
      params = [tags];
    }

    const { rows } = await pool.query(query, params);
    
    if (rows.length === 0) {
      console.log(`[TAG MISS] Không tìm thấy Node kiến thức nào cho tags: ${tags.join(', ')}`);
      process.exit(0);
    }

    console.log(`[TAG HIT] Tìm thấy ${rows.length} Nodes (Mode: ${mode.toUpperCase()}):\n`);
    rows.forEach(r => {
      console.log(`- [ID: ${r.id} | Score: ${r.confidence_score}] [Tags: ${(r.tags || []).join(', ')}]`);
      console.log(`  Q: ${r.question}`);
      // In một phần answer để overview
      const shortAns = r.answer_context.length > 100 
        ? r.answer_context.slice(0, 100).replace(/\n/g, ' ') + '...' 
        : r.answer_context.replace(/\n/g, ' ');
      console.log(`  A: ${shortAns}\n`);
    });

  } catch (e) {
    console.error('[ERROR]', e.message);
  } finally {
    await pool.end();
  }
}

findByTags();
