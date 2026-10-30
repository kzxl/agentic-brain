#!/usr/bin/env node
/**
 * migrations/run.js — Idempotent migration runner.
 *
 * Usage:
 *   node migrations/run.js
 *   npm run migrate
 *
 * Each .sql file is applied once, inside a transaction, and recorded in
 * schema_migrations. A PostgreSQL advisory lock prevents concurrent runners.
 */
const fs = require('fs');
const path = require('path');
const config = require('../core/config');

const MIGRATIONS_DIR = __dirname;

async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('semanticbrain_migrations'))");

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => /^\d+_.*\.sql$/.test(f))
      .sort();

    const applied = [];
    for (const file of files) {
      const version = path.basename(file, '.sql');
      const seen = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [version]
      );
      if (seen.rowCount > 0) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[MIGRATE] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${err.message}`);
      }
    }

    if (applied.length === 0) {
      console.log('[MIGRATE] schema up to date');
    } else {
      console.log(`[MIGRATE] applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('semanticbrain_migrations'))").catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations };

if (require.main === module) {
  const { Pool } = require('pg');
  const pool = new Pool({ ...config.db, max: 1 });
  runMigrations(pool)
    .then(() => pool.end())
    .catch(async (err) => {
      console.error('[MIGRATE][FATAL]', err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
