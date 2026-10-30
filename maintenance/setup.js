/**
 * setup.js — Initialize schema and index skills/workflows.
 *
 * Phase 0: schema creation is delegated to migrations/run.js, so a fresh
 * install and an existing database converge on the same schema.
 *
 * Usage:
 *   node maintenance/setup.js
 *   node maintenance/setup.js --reindex --force
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { embed } = require('../core');
const config = require('../core/config');
const { extractRegistryKeywords } = require('../core/keywords');
const { runMigrations } = require('../migrations/run');

// AGENT_ROOT points at the project's .agent directory (e.g. E:\00.ERP\ERP\.agent).
// Falls back to <cwd>/.agent so the repository also works standalone.
const AGENT_DIR = config.agentRoot || path.join(process.cwd(), '.agent');
const WORKFLOWS_DIR = path.join(AGENT_DIR, 'workflows');
const SKILLS_DIR = path.join(AGENT_DIR, 'skills');

const adminPool = new Pool({
  ...config.db,
  database: 'postgres',
  max: 2,
});

const appPool = new Pool(config.db);

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function ensureDatabase() {
  const client = await adminPool.connect();
  try {
    const res = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [config.db.database]
    );
    if (res.rows.length === 0) {
      await client.query(`CREATE DATABASE ${quoteIdent(config.db.database)}`);
      console.log(`[+] Created database: ${config.db.database}`);
    } else {
      console.log(`[=] Database ${config.db.database} already exists`);
    }
  } finally {
    client.release();
    await adminPool.end();
  }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result = {};
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)/);
    if (kv) result[kv[1].trim()] = kv[2].trim();
  }
  return result;
}

function extractContentPreview(content, maxLen = 200) {
  const body = content.replace(/^---[\s\S]*?---\r?\n?/, '').trim();
  return body.substring(0, maxLen).replace(/\n/g, ' ');
}

async function indexWorkflows() {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    console.log(`[!] Workflows directory not found, skipping: ${WORKFLOWS_DIR}`);
    return;
  }
  const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md'));
  let count = 0;

  for (const file of files) {
    const filePath = path.join(WORKFLOWS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    const name = path.basename(file, '.md');
    const description = fm.description || fm.desc || '';
    const preview = extractContentPreview(content);
    const keywords = extractRegistryKeywords(name, description, content);
    const searchText = `${name} ${description} ${preview}`.toLowerCase();
    const vec = await embed(searchText);

    await appPool.query(`
      INSERT INTO agent_registry (name, type, path, description, keywords, content_preview, search_text, embedding)
      VALUES ($1, 'workflow', $2, $3, $4, $5, $6, $7)
      ON CONFLICT (name, type)
      DO UPDATE SET description = $3, keywords = $4, content_preview = $5,
                    search_text = $6, embedding = $7, updated_at = NOW()
    `, [name, filePath, description, keywords, preview, searchText, JSON.stringify(vec)]);
    count++;
  }

  console.log(`[+] Indexed ${count} workflows`);
}

async function indexSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log(`[!] Skills directory not found, skipping: ${SKILLS_DIR}`);
    return;
  }
  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  let count = 0;
  for (const dir of dirs) {
    const skillFile = path.join(SKILLS_DIR, dir.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const content = fs.readFileSync(skillFile, 'utf-8');
    const fm = parseFrontmatter(content);
    const name = dir.name;
    const description = fm.description || fm.desc || '';
    const preview = extractContentPreview(content);
    const keywords = extractRegistryKeywords(name, description, content);
    const searchText = `${name} ${description} ${preview}`.toLowerCase();
    const vec = await embed(searchText);

    await appPool.query(`
      INSERT INTO agent_registry (name, type, path, description, keywords, content_preview, search_text, embedding)
      VALUES ($1, 'skill', $2, $3, $4, $5, $6, $7)
      ON CONFLICT (name, type)
      DO UPDATE SET description = $3, keywords = $4, content_preview = $5,
                    search_text = $6, embedding = $7, updated_at = NOW()
    `, [name, skillFile, description, keywords, preview, searchText, JSON.stringify(vec)]);
    count++;
  }

  console.log(`[+] Indexed ${count} skills`);
}

async function main() {
  const reindex = process.argv.includes('--reindex');
  const force = process.argv.includes('--force');

  try {
    if (reindex && !force) {
      console.error('[ERROR] --reindex drops agent_qa_cache/recipes/registry. Re-run with --force.');
      process.exit(1);
    }

    await ensureDatabase();

    if (reindex) {
      await appPool.query('DROP TABLE IF EXISTS agent_qa_history CASCADE');
      await appPool.query('DROP TABLE IF EXISTS agent_qa_cache CASCADE');
      await appPool.query('DROP TABLE IF EXISTS agent_recipes CASCADE');
      await appPool.query('DROP TABLE IF EXISTS agent_registry CASCADE');
      await appPool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await appPool.query('TRUNCATE schema_migrations');
      console.log('[!] Dropped registry/recipes/qa_cache/history and reset migrations for full reindex');
    }

    await runMigrations(appPool);
    await indexWorkflows();
    await indexSkills();

    const stats = await appPool.query(`
      SELECT type, COUNT(*) as count FROM agent_registry GROUP BY type
    `);
    console.log('\n[REGISTRY STATS]');
    stats.rows.forEach(r => console.log(`  ${r.type}: ${r.count} items`));

    const total = await appPool.query('SELECT COUNT(*) as total FROM agent_registry');
    console.log(`  TOTAL: ${total.rows[0].total} items indexed`);
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    await appPool.end();
  }
}

main();
