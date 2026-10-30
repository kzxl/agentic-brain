/**
 * save-qa.js - Single CLI entry point for writing knowledge.
 *
 * Phase 0:
 *   - PostgreSQL is canonical; AME is written only when explicitly enabled.
 *   - `--project` is preserved and enforced by KnowledgeWriter.
 *   - confidence is never inflated to 1.0 by default.
 *
 * Usage:
 *   node tools/save-qa.js "<Question>" "<Answer>" [--source=manual] [--confidence=0.5]
 *        [--category=general] [--tags=a,b] [--project=erp] [--pinned]
 */
const { pool, storageAme, config, captureKnowledge } = require('../core');

function parseArgs(args) {
  const opts = {
    source: 'manual',
    category: 'general',
    tags: [],
    confidence: 0.5,
    project: null,
    pinned: false,
    scope: null,
    allowLong: false,
  };
  for (const arg of args) {
    if (arg.startsWith('--source=')) opts.source = arg.split('=')[1];
    else if (arg.startsWith('--category=')) opts.category = arg.split('=')[1];
    else if (arg.startsWith('--confidence=')) opts.confidence = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--tags=')) opts.tags = arg.split('=')[1].split(',').map(t => t.trim()).filter(Boolean);
    else if (arg.startsWith('--project=')) opts.project = arg.split('=')[1].trim().toLowerCase();
    else if (arg.startsWith('--scope=')) {
      const scope = arg.split('=')[1].trim().toLowerCase();
      if (scope === 'global' || scope === 'project') opts.scope = scope;
    }
    else if (arg === '--pinned') opts.pinned = true;
    else if (arg === '--allow-long') opts.allowLong = true;
  }
  return opts;
}

async function saveQA(question, answer) {
  if (!question || !answer) {
    console.log('Usage: node save-qa.js "<Question>" "<Answer>" [--source=manual] [--confidence=0.5] [--category=general] [--tags=a,b] [--project=erp] [--scope=global|project] [--pinned] [--allow-long]');
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(4));

  if (answer.length > 2000 && !opts.allowLong) {
    console.error('[REJECTED] Answer exceeds 2000 characters. Split it into atomic lessons or pass --allow-long explicitly.');
    process.exit(1);
  }

  try {
    // AME is opt-in. backend=ame requires it; backend=postgres does not.
    const ameEnabled = config.ame?.write === true || config.backend === 'ame';
    let ameSaved = false;

    if (ameEnabled) {
      try {
        const status = await storageAme.isAmeAvailable();
        if (status.available) {
          const res = await storageAme.saveQA(question, answer, opts);
          ameSaved = true;
          console.log(`[+] AME saved (${res.backend}) [project: ${opts.project || 'global'}]`);
        } else {
          console.warn(`[WARN] AME requested but unavailable: ${status.reason || 'unknown'}`);
        }
      } catch (err) {
        console.warn(`[WARN] AME save failed: ${err.message}`);
      }
    }

    if (config.backend === 'ame') {
      if (!ameSaved) {
        console.error('[FATAL] MEMORY_BACKEND=ame but AME is unavailable; refusing to report success.');
        process.exitCode = 2;
      }
      return;
    }

    const result = await captureKnowledge({
      question,
      answer,
      source: opts.source,
      category: opts.category,
      tags: opts.tags,
      confidence: opts.confidence,
      project: opts.project,
      pinned: opts.pinned,
      scope: opts.scope,
    });

    if (result.status === 'updated') {
      console.log(`[~] QA updated [${result.matchType}] id=${result.id} [project: ${opts.project || 'global'}]`);
    } else {
      console.log(`[+] QA saved id=${result.id} [project: ${opts.project || 'global'}]`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

saveQA(process.argv[2], process.argv[3]);
