/**
 * export.js - Backup dữ liệu từ Semantic DB ra JSONL (JSON Lines)
 * 
 * Cách dùng:
 *   node export.js --table=qa_cache                     → stdout
 *   node export.js --table=recipes                      → stdout
 *   node export.js --table=registry                     → stdout
 *   node export.js --table=qa_cache --out=backup.jsonl  → file
 *   node export.js --all --out=full_backup.jsonl        → tất cả tables
 */
const pool = require('../core/db');
const fs = require('fs');

const TABLE_MAP = {
  qa_cache: { table: 'agent_qa_cache', columns: 'id, question, answer_context, source, category, tags, keywords, confidence_score, hit_count, useful_count, retrieval_count, use_count, last_retrieved_at, last_used_at, created_at, updated_at' },
  recipes: { table: 'agent_recipes', columns: 'id, intent, category, target_pattern, steps, skills_used, tools_used, keywords, hit_count, success_count, created_at, updated_at' },
  registry: { table: 'agent_registry', columns: 'id, name, type, path, description, keywords, content_preview, updated_at' },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { tables: [], out: null };
  
  for (const arg of args) {
    if (arg.startsWith('--table=')) opts.tables.push(arg.split('=')[1]);
    else if (arg.startsWith('--out=')) opts.out = arg.split('=')[1];
    else if (arg === '--all') opts.tables = Object.keys(TABLE_MAP);
  }
  
  return opts;
}

async function exportTable(tableName) {
  const config = TABLE_MAP[tableName];
  if (!config) {
    console.error(`[ERROR] Unknown table: ${tableName}. Available: ${Object.keys(TABLE_MAP).join(', ')}`);
    return [];
  }

  const result = await pool.query(`SELECT ${config.columns} FROM ${config.table} ORDER BY id ASC`);
  
  return result.rows.map(row => ({
    _table: tableName,
    ...row,
    // Normalize JSONB fields
    steps: row.steps ? (typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps) : undefined,
    tags: row.tags || undefined,
    keywords: row.keywords || undefined,
    skills_used: row.skills_used || undefined,
    tools_used: row.tools_used || undefined,
  }));
}

async function main() {
  const opts = parseArgs();
  
  if (opts.tables.length === 0) {
    console.log('Usage: node export.js --table=<qa_cache|recipes|registry> [--out=file.jsonl]');
    console.log('       node export.js --all [--out=full_backup.jsonl]');
    process.exit(1);
  }

  try {
    const lines = [];
    
    for (const tableName of opts.tables) {
      const rows = await exportTable(tableName);
      for (const row of rows) {
        lines.push(JSON.stringify(row));
      }
      console.error(`[+] Exported ${rows.length} rows from ${tableName}`);
    }

    const output = lines.join('\n') + '\n';

    if (opts.out) {
      fs.writeFileSync(opts.out, output, 'utf-8');
      console.error(`[+] Written to ${opts.out} (${lines.length} lines, ${output.length} bytes)`);
    } else {
      process.stdout.write(output);
    }

  } catch (err) {
    console.error('[ERROR]', err.message);
  } finally {
    await pool.end();
  }
}

main();
