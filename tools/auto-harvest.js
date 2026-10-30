#!/usr/bin/env node
/**
 * auto-harvest.js — Post-task atomic ingestion.
 *
 * The LLM proposes atomic lessons; the normalizer validates them; the ingest
 * pipeline stores a parent document (when needed) plus one row per atom.
 *
 * Usage:
 *   node auto-harvest.js "<summary text>" --tags=ua,inventory
 *   node auto-harvest.js --file=walkthrough.md --tags=ua,refactor
 *   node auto-harvest.js "<summary>" --tags=ua --dry-run
 */
const fs = require('fs');
const path = require('path');
const { pool, normalizeKnowledge, ingestText } = require('../core');

const DRY_RUN = process.argv.includes('--dry-run');
const TAGS = (() => {
  const arg = process.argv.find(a => a.startsWith('--tags='));
  return arg ? arg.split('=')[1].split(',').map(t => t.trim()).filter(Boolean) : [];
})();
const FILE_ARG = process.argv.find(a => a.startsWith('--file='))?.split('=')[1];
const TEXT_ARG = process.argv[2];
const PROJECT = (() => {
  const tag = TAGS.find(t => t.startsWith('project:'));
  return tag ? tag.slice('project:'.length) : null;
})();

async function harvest(inputText) {
  if (!inputText || inputText.trim().length < 50) {
    console.log('Usage: node auto-harvest.js "<summary>" --tags=ua,inventory [--dry-run]');
    console.log('       node auto-harvest.js --file=walkthrough.md --tags=ua');
    console.log('\nInput must be at least 50 characters.');
    process.exit(1);
  }

  const sourceRef = FILE_ARG
    ? path.resolve(FILE_ARG)
    : `auto-harvest:${Date.now()}`;

  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  AUTO-HARVEST — Atomic Knowledge Ingestion    ║');
  console.log(`║  Mode: ${DRY_RUN ? 'DRY-RUN (preview)' : '⚡ SAVE (writing DB)'}${DRY_RUN ? '       ' : '       '}║`);
  console.log('╚═══════════════════════════════════════════════╝\n');

  console.log(`[INPUT] ${inputText.length} chars | Tags: ${TAGS.length > 0 ? TAGS.join(',') : 'auto-detect'}`);
  console.log(`[LLM] Extracting atomic lessons...\n`);

  let normalized;
  try {
    normalized = await normalizeKnowledge({
      text: inputText,
      project: PROJECT,
      sourceRef,
    });
  } catch (err) {
    console.error(`[HARVEST REJECTED] ${err.code || 'ERROR'}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!normalized.atoms || normalized.atoms.length === 0) {
    console.log('[SKIP] No atomic lessons extracted (spam filter / no durable lesson).');
    return;
  }

  console.log(`[EXTRACTED] ${normalized.atoms.length} atomic lesson(s):\n`);
  normalized.atoms.forEach((atom, i) => {
    console.log(`  [${i + 1}] Q: ${atom.question}`);
    console.log(`     A: ${atom.answer.substring(0, 140)}${atom.answer.length > 140 ? '...' : ''}`);
    console.log(`     Scope hint: ${atom.scopeHint || 'auto'} (${atom.scopeConfidence}) | Tags: ${atom.tags.join(', ') || '-'}\n`);
  });

  if (DRY_RUN) {
    console.log(`[DRY-RUN] ${normalized.atoms.length} atom(s) would be saved. Run without --dry-run to save.`);
    return;
  }

  const result = await ingestText({
    text: inputText,
    atoms: normalized.atoms,
    project: PROJECT,
    source: 'auto-harvest',
    sourceRef,
    tags: TAGS,
    confidence: 0.6,
  });

  console.log(`\n[DONE] ${result.count} atom(s) saved (parent: ${result.parentId || 'none'}, source: auto-harvest, conf: 0.6)`);
}

(async () => {
  let inputText;
  if (FILE_ARG) {
    const filePath = path.resolve(FILE_ARG);
    if (!fs.existsSync(filePath)) {
      console.error(`[ERROR] File not found: ${filePath}`);
      process.exit(1);
    }
    inputText = fs.readFileSync(filePath, 'utf-8');
  } else {
    inputText = TEXT_ARG;
  }

  try {
    await harvest(inputText);
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
