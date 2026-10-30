#!/usr/bin/env node
/**
 * promote-trust.js — Promote a knowledge atom's trust level.
 *
 * Usage:
 *   node tools/promote-trust.js --list [--limit=20]
 *   node tools/promote-trust.js --id=42 --to=verified_fact --verifier=build --evidence=build:ok
 *   node tools/promote-trust.js --id=42 --to=user_decision --user
 *
 * Rules:
 *   - only upgrades are allowed
 *   - verified_fact requires --evidence or --verifier
 *   - user_decision requires --user
 */
const { pool, trustRank, TRUST_LEVELS } = require('../core');

const LIST = process.argv.includes('--list');
const ID = process.argv.find(a => a.startsWith('--id='))?.split('=')[1];
const TO = process.argv.find(a => a.startsWith('--to='))?.split('=')[1];
const VERIFIER = process.argv.find(a => a.startsWith('--verifier='))?.slice('--verifier='.length) || null;
const EVIDENCE = (() => {
  const arg = process.argv.find(a => a.startsWith('--evidence='));
  if (!arg) return [];
  return arg.slice('--evidence='.length).split(',').map(e => e.trim()).filter(Boolean);
})();
const USER_CONFIRMED = process.argv.includes('--user');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '20', 10);

async function list() {
  const rows = (await pool.query(
    `SELECT id, trust_level, confidence_score, project_id,
            LEFT(question, 100) AS question, evidence
     FROM agent_qa_cache
     WHERE status = 'active'
       AND trust_level IN ('observation','hypothesis','inference')
     ORDER BY id ASC
     LIMIT $1`,
    [Math.max(1, Math.min(200, LIMIT))]
  )).rows;

  if (rows.length === 0) {
    console.log('[TRUST] No promotable records.');
    return;
  }
  console.log(`[TRUST] ${rows.length} promotable record(s):\n`);
  for (const r of rows) {
    console.log(`  #${r.id} [${r.trust_level}] project=${r.project_id} conf=${r.confidence_score}`);
    console.log(`       ${r.question}`);
  }
  console.log('\nPromote: node tools/promote-trust.js --id=<id> --to=verified_fact --verifier=build --evidence=build:ok');
}

async function promote() {
  const id = parseInt(ID, 10);
  if (!Number.isInteger(id) || !TO || !TRUST_LEVELS.includes(TO)) {
    console.error('Usage: node tools/promote-trust.js --id=<id> --to=observation|hypothesis|inference|verified_fact|user_decision');
    process.exit(1);
  }
  if (TO === 'verified_fact' && EVIDENCE.length === 0 && !VERIFIER) {
    console.error('[TRUST] verified_fact requires --evidence or --verifier.');
    process.exit(1);
  }
  if (TO === 'user_decision' && !USER_CONFIRMED) {
    console.error('[TRUST] user_decision requires --user (explicit human confirmation).');
    process.exit(1);
  }

  const current = (await pool.query(
    'SELECT id, trust_level, source_type, evidence FROM agent_qa_cache WHERE id = $1',
    [id]
  )).rows[0];
  if (!current) {
    console.error(`[TRUST] #${id} not found.`);
    process.exit(1);
  }

  const oldRank = trustRank(current.trust_level);
  const newRank = trustRank(TO);
  if (newRank <= oldRank) {
    console.error(`[TRUST] Refusing non-upgrade: ${current.trust_level} -> ${TO}.`);
    process.exit(1);
  }

  const updated = (await pool.query(
    `UPDATE agent_qa_cache
     SET trust_level = $2,
         source_type = CASE WHEN $2 = 'user_decision' THEN 'user' ELSE source_type END,
         verifier = COALESCE($3, verifier),
         verified_at = CASE WHEN $2 IN ('verified_fact','user_decision') THEN NOW() ELSE verified_at END,
         evidence = CASE WHEN $4::jsonb <> '[]'::jsonb THEN $4::jsonb ELSE COALESCE(evidence, '[]'::jsonb) END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, trust_level, source_type, verifier, verified_at, evidence`,
    [id, TO, VERIFIER, JSON.stringify(EVIDENCE)]
  )).rows[0];

  console.log(`[TRUST] #${id}: ${current.trust_level} -> ${updated.trust_level}`);
  console.log(`        source_type=${updated.source_type} verifier=${updated.verifier || '-'} verified_at=${updated.verified_at || '-'}`);
}

(async () => {
  try {
    if (LIST || !ID) await list();
    else await promote();
  } catch (err) {
    console.error('[TRUST][ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
