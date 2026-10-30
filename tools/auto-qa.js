#!/usr/bin/env node
/**
 * auto-qa.js — Generate a candidate answer on a retrieval MISS.
 *
 * Phase 0 safety:
 *   - disabled unless AUTO_QA_ENABLED=true (or --force)
 *   - writes through KnowledgeWriter with confidence 0.5 and `unverified` tag
 *   - never writes confidence 1.0
 *
 * Usage:
 *   node tools/auto-qa.js "<question>" [--project=erp] [--force]
 */
const { askWithReasoning, captureKnowledge, pool, config } = require('../core');
const { getProjectInfo } = require('./project-helper');

const question = process.argv[2];
const PROJECT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project='));
  if (arg) return arg.split('=')[1].trim().toLowerCase();
  try {
    return getProjectInfo(process.cwd()).projectName || null;
  } catch {
    return null;
  }
})();
const FORCE = process.argv.includes('--force');

async function autoQA() {
  if (!question || question.startsWith('--')) {
    console.log('Usage: node tools/auto-qa.js "<question>" [--project=erp] [--force]');
    process.exit(1);
  }

  if (!config.autoQa && !FORCE) {
    console.error('[AUTO-QA] Disabled. Set AUTO_QA_ENABLED=true or pass --force.');
    process.exit(0);
  }

  const prompt = `You are a strict technical database semantic proxy. The user has a system-related question or wants an explanation: "${question}".
Please provide a detailed, accurate, and concise reasoning context or explanation. Focus purely on technical details, system constraints, or logic without conversational filler.`;

  try {
    console.log(`[QA AUTO-REASON] Reasoning for "${question}"...`);
    const response = await askWithReasoning(prompt);
    const answerText = String(response.result || '').trim();
    if (answerText.length < 20) {
      throw new Error('generated answer is too short');
    }

    const result = await captureKnowledge({
      question,
      answer: answerText,
      source: `auto-qa:${response.source}`,
      confidence: 0.5,
      tags: ['unverified'],
      project: PROJECT,
    });

    console.log(`[QA AUTO-REASON] ${result.status === 'updated' ? 'Updated' : 'Saved'} QA #${result.id} (inference, confidence 0.5)`);
    console.log(answerText);
  } catch (err) {
    console.error('[ERROR] Failed to generate/save reasoned QA:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

autoQA();
