#!/usr/bin/env node
/**
 * ingest-knowledge.js — Agent-side atomic knowledge ingestion.
 *
 * No LLM is called. The calling agent supplies atoms:
 *
 *   {
 *     "project": "erp",
 *     "scope": "project",
 *     "source": "agent",
 *     "source_ref": "session/commit",
 *     "confidence": 0.7,
 *     "tags": ["async", "inventory"],
 *     "atoms": [
 *       {
 *         "question": "How to avoid deadlock in inventory service?",
 *         "answer": "Use Task instead of .Result and order lock acquisition.",
 *         "scope_hint": "project",
 *         "tags": ["async"],
 *         "evidence": ["InventoryService.cs:42"]
 *       }
 *     ]
 *   }
 *
 * Usage:
 *   node tools/ingest-knowledge.js --file=atoms.json --project=erp
 *   node tools/ingest-knowledge.js --json='{"atoms":[...]}' --project=erp
 *   echo '{"atoms":[...]}' | node tools/ingest-knowledge.js --project=erp
 *   node tools/ingest-knowledge.js --file=atoms.json --dry-run
 */
const fs = require('fs');
const { pool, parseIngestPayload, normalizeKnowledge, ingestText } = require('../core');

const FILE_ARG = process.argv.find(a => a.startsWith('--file='))?.split('=')[1];
const JSON_ARG = process.argv.find(a => a.startsWith('--json='))?.slice('--json='.length);
const PROJECT_ARG = process.argv.find(a => a.startsWith('--project='))?.split('=')[1]?.trim().toLowerCase();
const SCOPE_ARG = process.argv.find(a => a.startsWith('--scope='))?.split('=')[1]?.trim().toLowerCase();
const SOURCE_ARG = process.argv.find(a => a.startsWith('--source='))?.split('=')[1];
const SOURCE_REF_ARG = process.argv.find(a => a.startsWith('--source-ref='))?.slice('--source-ref='.length);
const CONFIDENCE_ARG = process.argv.find(a => a.startsWith('--confidence='))?.split('=')[1];
const TRUST_ARG = process.argv.find(a => a.startsWith('--trust='))?.split('=')[1];
const VERIFIER_ARG = process.argv.find(a => a.startsWith('--verifier='))?.slice('--verifier='.length);
const VALID_FROM_ARG = process.argv.find(a => a.startsWith('--valid-from='))?.slice('--valid-from='.length);
const VALID_TO_ARG = process.argv.find(a => a.startsWith('--valid-to='))?.slice('--valid-to='.length);
const TAGS_ARG = process.argv.find(a => a.startsWith('--tags='))?.split('=')[1];
const DRY_RUN = process.argv.includes('--dry-run');

function usage() {
  console.log(`Usage:
  node tools/ingest-knowledge.js --file=atoms.json --project=erp
  node tools/ingest-knowledge.js --json='{"atoms":[...]}' --project=erp
  echo '{"atoms":[...]}' | node tools/ingest-knowledge.js --project=erp

Options:
  --project=name      Project scope (omit for global)
  --scope=project|global
  --source=agent      Source label
  --source-ref=...    Session/commit/file reference
  --confidence=0.7
  --trust=observation|hypothesis|inference|verified_fact|user_decision
  --verifier=build|test|user
  --valid-from=2026-01-01 --valid-to=2027-01-01
  --tags=a,b
  --dry-run           Validate and print, do not write`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function loadPayload() {
  if (FILE_ARG) {
    if (!fs.existsSync(FILE_ARG)) {
      throw new Error(`file not found: ${FILE_ARG}`);
    }
    return fs.readFileSync(FILE_ARG, 'utf8');
  }
  if (JSON_ARG !== undefined) return JSON_ARG;
  if (!process.stdin.isTTY) return readStdin();
  return null;
}

function parseScope(value) {
  if (!value) return null;
  if (value === 'global' || value === 'project') return value;
  throw new Error('--scope must be "global" or "project"');
}

async function main() {
  const raw = await loadPayload();
  if (!raw || !String(raw).trim()) {
    usage();
    process.exit(1);
  }

  const payload = parseIngestPayload(raw);
  const atoms = payload.atoms || [];
  if (atoms.length === 0) {
    throw new Error('atoms array is empty');
  }
  const scope = parseScope(SCOPE_ARG || payload.scope);
  const project = PROJECT_ARG || payload.project || null;
  const source = SOURCE_ARG || payload.source || 'agent-harvest';
  const sourceRef = SOURCE_REF_ARG || payload.source_ref || payload.sourceRef || null;
  const confidence = CONFIDENCE_ARG !== undefined
    ? parseFloat(CONFIDENCE_ARG)
    : (payload.confidence !== undefined ? payload.confidence : 0.6);
  const trustLevel = TRUST_ARG || payload.trust_level || payload.trustLevel || null;
  const verifier = VERIFIER_ARG || payload.verifier || null;
  const validFrom = VALID_FROM_ARG || payload.valid_from || payload.validFrom || null;
  const validTo = VALID_TO_ARG || payload.valid_to || payload.validTo || null;
  const sourceType = payload.source_type || payload.sourceType || source;
  const tags = TAGS_ARG
    ? TAGS_ARG.split(',').map(t => t.trim()).filter(Boolean)
    : (Array.isArray(payload.tags) ? payload.tags : []);

  const text = payload.text
    || payload.document
    || atoms.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');

  const normalized = await normalizeKnowledge({ text, atoms, sourceRef });

  console.log(`[INGEST] ${normalized.atoms.length} atom(s) | project: ${project || 'global'} | scope: ${scope || 'auto'} | source: ${source}`);
  normalized.atoms.forEach((atom, i) => {
    console.log(`  [${i + 1}] Q: ${atom.question}`);
    console.log(`     A: ${atom.answer.substring(0, 140)}${atom.answer.length > 140 ? '...' : ''}`);
    console.log(`     Scope hint: ${atom.scopeHint || 'auto'} | Tags: ${atom.tags.join(', ') || '-'}`);
  });

  if (DRY_RUN) {
    console.log('[DRY-RUN] No rows written.');
    return;
  }

  const result = await ingestText({
    text,
    atoms: normalized.atoms,
    project,
    scope,
    source,
    sourceRef,
    tags,
    confidence,
    trustLevel,
    sourceType,
    verifier,
    validFrom,
    validTo,
  });

  console.log(`\n[DONE] ${result.count} atom(s) saved | parent: ${result.parentId || 'none'} | ids: ${result.ids.join(',')}`);
}

main()
  .catch(err => {
    console.error(`[INGEST][${err.code || 'ERROR'}]`, err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
