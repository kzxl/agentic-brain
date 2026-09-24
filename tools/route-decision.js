#!/usr/bin/env node
/**
 * route-decision.js — In-Process System 1 Decision & Fast Routing Engine
 *
 * Implements reflexive System 1 decision primitives (Choice, Noul, Score)
 * without external AI services, Python runtimes, or background daemons.
 *
 * Usage:
 *   node route-decision.js "<task description>" [--json] [--explain]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getProjectInfo, inferTechTags } = require('./project-helper');

// 1. Resolve AgentOption Root (rules.json, shortcuts.json)
function resolveAgentOptionRoot() {
  const candidates = [
    process.env.AGENT_ROOT,
    'E:\\16. AgentOption',
    'D:\\16. AgentOption',
    path.resolve(__dirname, '../../16. AgentOption'),
    path.resolve(__dirname, '../../../16. AgentOption'),
    path.resolve(process.cwd(), '../16. AgentOption'),
    process.cwd()
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'shortcuts.json')) && fs.existsSync(path.join(c, 'rules.json'))) {
      return c;
    }
  }
  return null;
}

// 2. Tokenize & Clean Text
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// 3. Evaluate Risk Level (Score 1 to 5)
function evaluateRisk(text) {
  const lower = text.toLowerCase();
  
  // Risk 5: Critical/Destructive
  if (/(drop\s+table|delete\s+from|truncate|rm\s+-rf|format\s+[a-z]:|force\s+push|reset\s+--hard)/i.test(lower)) {
    return { score: 5, reason: 'Potentially destructive database/system operation detected' };
  }
  
  // Risk 4: Security/Auth/Data Migration
  if (/(auth|jwt|token|secret|credential|password|permission|rbac|crypto|migration|schema\s+change|privilege)/i.test(lower)) {
    return { score: 4, reason: 'Security, authorization, or schema migration boundary' };
  }

  // Risk 3: Structural Refactoring / Concurrency
  if (/(refactor|rewrite|deadlock|race\s+condition|concurrency|async\s+void|memory\s+leak|breaking)/i.test(lower)) {
    return { score: 3, reason: 'Complex refactoring or concurrency lifecycle impact' };
  }

  // Risk 2: Standard Feature / Test Implementation
  if (/(feature|implement|add|create|endpoint|service|view|component|unit\s+test)/i.test(lower)) {
    return { score: 2, reason: 'Standard constructive engineering task' };
  }

  // Risk 1: Formatting / Documentation
  return { score: 1, reason: 'Low-impact documentation, styling, or minor enhancement' };
}

// 4. Dead Loop & Stagnation Detection (Noul Primitive)
function evaluateDeadLoop(taskText, project) {
  const cacheDir = path.join(__dirname, '../data');
  const cacheFile = path.join(cacheDir, '.last-decision-cache.json');
  const now = Date.now();
  const taskHash = crypto.createHash('sha256').update(`${project}:${taskText.trim().toLowerCase()}`).digest('hex');

  let state = { lastHash: null, lastTimestamp: 0, repeatCount: 0 };

  try {
    if (fs.existsSync(cacheFile)) {
      state = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch {
    // Ignore cache read error
  }

  const isRecent = (now - (state.lastTimestamp || 0)) < 600000; // 10 minutes
  let isDeadLoop = false;
  let repeatCount = 1;

  if (isRecent && state.lastHash === taskHash) {
    repeatCount = (state.repeatCount || 1) + 1;
    if (repeatCount >= 2) {
      isDeadLoop = true;
    }
  }

  // Save new state
  try {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      lastHash: taskHash,
      lastTimestamp: now,
      repeatCount,
      taskText
    }, null, 2), 'utf8');
  } catch {
    // Ignore cache write error
  }

  return {
    is_dead_loop: isDeadLoop,
    repeat_count: repeatCount,
    confidence: isDeadLoop ? 0.95 : 0.90
  };
}

// 5. Match Rules & Shortcuts (Choice Primitive)
function matchRulesAndShortcuts(taskText, techTags, agentRoot) {
  const matchedRules = [];
  const matchedSkills = [];

  if (!agentRoot) {
    return { rules: [], skills: [] };
  }

  const rulesMap = JSON.parse(fs.readFileSync(path.join(agentRoot, 'rules.json'), 'utf8'));
  const shortcutsMap = JSON.parse(fs.readFileSync(path.join(agentRoot, 'shortcuts.json'), 'utf8'));

  const taskTokens = tokenize(taskText);
  const combinedTokens = new Set([...taskTokens, ...techTags]);

  // A. Score Rules
  for (const [ruleKey, desc] of Object.entries(rulesMap)) {
    const descTokens = tokenize(desc);
    let matchScore = 0;

    for (const t of combinedTokens) {
      if (descTokens.includes(t)) matchScore += 1;
    }

    // Technology Tag Boost
    const rk = ruleKey.toLowerCase();
    if (techTags.includes('wpf') && rk.includes('wpf')) matchScore += 3;
    if (techTags.includes('winforms') && (rk.includes('wpf') || rk.includes('winform'))) matchScore += 3;
    if (techTags.includes('webapi') && rk.includes('api')) matchScore += 3;
    if (techTags.includes('sql') && rk.includes('db')) matchScore += 3;

    if (matchScore > 0) {
      matchedRules.push({
        id: ruleKey,
        score: matchScore,
        desc: desc.substring(0, 90) + '...'
      });
    }
  }

  // B. Score Shortcuts / Skills
  for (const [sKey, sVal] of Object.entries(shortcutsMap)) {
    const sDescTokens = tokenize(sVal.desc || '');
    let sScore = 0;

    for (const t of combinedTokens) {
      if (sDescTokens.includes(t)) sScore += 1;
      if (sKey.toLowerCase() === t) sScore += 3;
    }

    // Boost if shortcuts map to high priority rules
    if (sVal.rules && Array.isArray(sVal.rules)) {
      for (const r of matchedRules.slice(0, 3)) {
        if (sVal.rules.includes(r.id)) sScore += 1.5;
      }
    }

    if (sScore > 0) {
      matchedSkills.push({
        shortcut: sKey,
        name: sVal.name || sKey,
        score: sScore,
        target: sVal.target,
        desc: sVal.desc
      });
    }
  }

  matchedRules.sort((a, b) => b.score - a.score);
  matchedSkills.sort((a, b) => b.score - a.score);

  return {
    rules: matchedRules.slice(0, 4),
    skills: matchedSkills.slice(0, 4)
  };
}

// Main Analyzer
function decideRoute(taskText, options = {}) {
  const projectInfo = getProjectInfo(options.cwd || process.cwd());
  const techTags = inferTechTags(options.cwd || process.cwd());
  const agentRoot = resolveAgentOptionRoot();

  // 1. Tag Inference
  const tagSet = new Set();
  if (projectInfo.domain) tagSet.add(projectInfo.domain);
  for (const t of techTags) tagSet.add(t);
  
  // Keyword-based tag deduction
  const lower = taskText.toLowerCase();
  if (/(jwt|auth|token|security|hash)/.test(lower)) tagSet.add('security');
  if (/(api|rest|endpoint|controller)/.test(lower)) tagSet.add('api');
  if (/(refactor|clean|simplify)/.test(lower)) tagSet.add('refactor');
  if (/(winforms|form|control|ui)/.test(lower)) tagSet.add('winforms');
  if (/(wpf|xaml)/.test(lower)) tagSet.add('wpf');
  if (/(scada|plc|modbus)/.test(lower)) tagSet.add('scada');
  if (/(inventory|stock)/.test(lower)) tagSet.add('inventory');
  if (/(sales|order)/.test(lower)) tagSet.add('sales');
  if (tagSet.size === 0) tagSet.add('general');

  const suggestedTags = Array.from(tagSet);

  // 2. Choice Primitives (Rules & Skills)
  const matches = matchRulesAndShortcuts(taskText, suggestedTags, agentRoot);

  // 3. Score Primitive (Risk)
  const risk = evaluateRisk(taskText);

  // 4. Noul Primitive (Dead-Loop)
  const loopCheck = evaluateDeadLoop(taskText, projectInfo.projectName);

  // 5. Calibrated Confidence Calculation
  let confidence = 0.60;
  if (matches.rules.length > 0) confidence += Math.min(0.25, matches.rules[0].score * 0.05);
  if (projectInfo.hasRuleFile) confidence += 0.08;
  if (techTags.length > 0) confidence += 0.05;
  confidence = Math.min(0.98, parseFloat(confidence.toFixed(2)));

  // 6. Execution Mode
  let executionMode = 'FAST_EXECUTE';
  if (loopCheck.is_dead_loop) {
    executionMode = 'TRIP_CIRCUIT_BREAKER';
  } else if (risk.score >= 4 || confidence < 0.70) {
    executionMode = 'PROBE_AND_SPIKE';
  }

  return {
    project: projectInfo.projectName,
    domain: projectInfo.domain || 'general',
    decision: {
      target_rules: matches.rules.map(r => r.id),
      target_skills: matches.skills.map(s => ({
        shortcut: s.shortcut,
        target: s.target,
        desc: s.desc
      })),
      suggested_tags: suggestedTags,
      is_dead_loop: loopCheck.is_dead_loop,
      confidence_score: confidence,
      risk_level: risk.score,
      risk_reason: risk.reason,
      execution_mode: executionMode
    },
    meta: {
      agent_root: agentRoot,
      has_project_rule: projectInfo.hasRuleFile,
      rule_details: matches.rules
    }
  };
}

// CLI Execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const taskText = args.find(a => !a.startsWith('--'));

  if (!taskText) {
    console.log(`
⚡ System 1 Decision & Fast Routing Engine:
  node route-decision.js "<task description>" [--json]

Example:
  node route-decision.js "Triển khai xác thực JWT và kiểm tra bảo mật API"
`);
    process.exit(1);
  }

  const result = decideRoute(taskText);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  const d = result.decision;
  console.log(`\n🎯 [SYSTEM 1 DECISION GATE] Project: ${result.project} (${result.domain})`);
  console.log(`─────────────────────────────────────────────────────────────────`);
  console.log(`✦ Mode          : \x1b[36m${d.execution_mode}\x1b[0m (Confidence: ${(d.confidence_score * 100).toFixed(0)}%)`);
  console.log(`✦ Risk Level    : \x1b[33mLevel ${d.risk_level}/5\x1b[0m — ${d.risk_reason}`);
  console.log(`✦ Dead-Loop     : ${d.is_dead_loop ? '\x1b[31mTRIPPED (Cycle Detected)\x1b[0m' : '\x1b[32mCLEAR (Safe)\x1b[0m'}`);
  console.log(`✦ Suggested Tags: [${d.suggested_tags.join(', ')}]`);
  
  if (d.target_rules.length > 0) {
    console.log(`\n📜 Active Rules to Enforce:`);
    result.meta.rule_details.forEach(r => {
      console.log(`  • \x1b[1m${r.id}\x1b[0m: ${r.desc}`);
    });
  }

  if (d.target_skills.length > 0) {
    console.log(`\n⚡ Recommended Skills / Blueprints:`);
    d.target_skills.forEach(s => {
      console.log(`  • [\x1b[32m${s.shortcut}\x1b[0m] ${s.desc} -> ${s.target}`);
    });
  }
  console.log(`─────────────────────────────────────────────────────────────────\n`);
  process.exit(0);
}

module.exports = { decideRoute };
