#!/usr/bin/env node
/**
 * migrate-pg-to-ame.js - One-Click Migration from PostgreSQL to AME Container
 * 
 * Usage:
 *   node tools/migrate-pg-to-ame.js [--out=data/semantic_brain.ame] [--project=all] [--batch=50]
 */

const { pool, storageAme } = require('../core');
const path = require('path');
const fs = require('fs');

const OUT_ARG = process.argv.find(a => a.startsWith('--out='))?.split('=')[1];
const PROJECT_ARG = process.argv.find(a => a.startsWith('--project='))?.split('=')[1]?.toLowerCase();
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='))?.split('=')[1];

async function migrate() {
  console.log('\n=============================================================');
  console.log('  🚀 PostgreSQL (pgvector) -> Agent Memory Engine (AME) Migrator');
  console.log('=============================================================\n');

  const targetDb = OUT_ARG ? path.resolve(OUT_ARG) : storageAme.resolveProjectDb(PROJECT_ARG);
  storageAme.ensureDbExists(targetDb);
  console.log(`📁 Target AME Container: ${targetDb}`);

  let query = `
    SELECT id, question, answer_context, tags, confidence_score, hit_count, updated_at
    FROM agent_qa_cache
  `;
  const params = [];

  if (PROJECT_ARG && PROJECT_ARG !== 'all') {
    query += ` WHERE 'project:' || $1 = ANY(tags) OR $1 = ANY(tags)`;
    params.push(PROJECT_ARG);
  }

  query += ` ORDER BY id ASC`;
  if (LIMIT_ARG) {
    query += ` LIMIT ${parseInt(LIMIT_ARG)}`;
  }

  try {
    console.log('📡 Fetching records from PostgreSQL...');
    const result = await pool.query(query, params);
    const rows = result.rows;
    console.log(`✅ Loaded ${rows.length} records from PostgreSQL.\n`);

    if (rows.length === 0) {
      console.log('No records found to migrate.');
      return;
    }

    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        await storageAme.saveQA(r.question, r.answer_context, {
          tags: r.tags || [],
          project: PROJECT_ARG || 'global',
          confidence: r.confidence_score || 1.0,
          source: 'pg-migration',
          dbPath: targetDb
        });
        successCount++;
        if ((i + 1) % 25 === 0 || i === rows.length - 1) {
          process.stdout.write(`\r  -> Migrated ${i + 1} / ${rows.length} (${Math.round(((i + 1) / rows.length) * 100)}%)...`);
        }
      } catch (err) {
        failCount++;
      }
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n\n=============================================================');
    console.log(`  🎉 Migration Complete in ${elapsedSec}s`);
    console.log(`  - Successfully Migrated: ${successCount}`);
    console.log(`  - Failed:                ${failCount}`);
    console.log(`  - Target Container:      ${targetDb}`);
    console.log('=============================================================\n');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    try {
      await pool.end();
    } catch {}
  }
}

migrate();
