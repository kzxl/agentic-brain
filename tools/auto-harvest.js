#!/usr/bin/env node
/**
 * auto-harvest.js — DEPRECATED.
 *
 * Local LLM extraction was removed: the calling agent already has the task
 * context and must supply atomic JSON. Use tools/ingest-knowledge.js.
 *
 * This shim forwards JSON payloads to ingest-knowledge.js so existing scripts
 * fail with a clear message instead of silently using a local model.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const FILE_ARG = process.argv.find(a => a.startsWith('--file='))?.split('=')[1];
const HAS_JSON = process.argv.some(a => a.startsWith('--json='))
  || Boolean(FILE_ARG && FILE_ARG.toLowerCase().endsWith('.json'));

if (!HAS_JSON) {
  console.error('[DEPRECATED] auto-harvest no longer runs a local LLM to re-analyze summaries.');
  console.error('The calling agent must provide atomic JSON atoms:');
  console.error('  node tools/ingest-knowledge.js --file=atoms.json --project=erp');
  console.error('  echo \'{"atoms":[...]}\' | node tools/ingest-knowledge.js --project=erp');
  console.error('For a single structured lesson use:');
  console.error('  node tools/post-task.js "Problem | Cause | Fix" --direct --project=erp');
  process.exit(1);
}

const result = spawnSync(
  'node',
  [path.join(__dirname, 'ingest-knowledge.js'), ...process.argv.slice(2)],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);
