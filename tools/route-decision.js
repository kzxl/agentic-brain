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

// 5. Match Rules, Shortcuts & Agent Personas (Choice Primitive)
const RULE_TO_PATH_SEGMENTS = {
  R_RUST: ['standards/rust/', 'skills/rust/', 'rust'],
  R_PY: ['standards/python/', 'skills/python/', 'python'],
  R_GO: ['standards/golang/', 'golang'],
  R_PHP: ['standards/php/', 'php'],
  R_REACT: ['standards/react/', 'skills/react/', 'react'],
  R_NODE: ['standards/nodejs/', 'skills/nodejs/', 'nodejs'],
  R_CPP: ['standards/cpp/', 'cpp', 'interop'],
  R_EMBEDDED: ['standards/embedded/', 'skills/embedded/', 'embedded', 'rtos', 'firmware'],
  R_GODOT: ['godot', 'skills/game/'],
  R_GAME: ['skills/game/', 'game'],
  R_ANDROID: ['standards/android/', 'android'],
  R_CS: ['standards/csharp/', 'skills/csharp/', 'csharp'],
  R_WPF: ['standards/csharp/wpf', 'standards/csharp/winforms', 'baseform'],
  R_API: ['standards/csharp/webapi', 'folder-per-feature'],
  R_DB: ['standards/database/', 'skills/database/', 'sql'],
  R_UI: ['ui-design-system', 'standards/universal/ui-'],
  R_TEAM: ['multi-agent-teamwork', 'multi-agent'],
  R_PENTEST: ['skills/pentest/', 'security-pentest'],
  R_REVERSE: ['skills/reversing/', 'reverse-engineering'],
  R_RESEARCH: ['skills/research/', 'scientific-research'],
  R_DOMAIN_INV: ['standards/erp/inventory', 'inventory-domain'],
  R_DOMAIN_PROD: ['standards/erp/production', 'production-lot'],
  R_DOMAIN_SALES: ['standards/erp/sales']
};

function matchRulesAndShortcuts(taskText, techTags, agentRoot) {
  const matchedRules = [];
  const matchedSkills = [];
  const matchedAgents = [];

  if (!agentRoot) {
    return { rules: [], skills: [], agents: [] };
  }

  const rulesMap = JSON.parse(fs.readFileSync(path.join(agentRoot, 'rules.json'), 'utf8'));
  const shortcutsMap = JSON.parse(fs.readFileSync(path.join(agentRoot, 'shortcuts.json'), 'utf8'));

  const taskTokens = tokenize(taskText);
  const combinedTokens = new Set([...taskTokens, ...techTags]);

  // A. Score Rules across all 13 stacks + domains
  for (const [ruleKey, desc] of Object.entries(rulesMap)) {
    const descTokens = tokenize(desc);
    let matchScore = 0;

    for (const t of combinedTokens) {
      if (descTokens.includes(t)) matchScore += 1;
    }

    // Technology Tag & Stack Boost
    const rk = ruleKey.toUpperCase();
    if (techTags.includes('wpf') && rk === 'R_WPF') matchScore += 4;
    if (techTags.includes('winforms') && (rk === 'R_WPF' || rk === 'R_CS')) matchScore += 3;
    if ((techTags.includes('webapi') || techTags.includes('api')) && rk === 'R_API') matchScore += 3;
    if (techTags.includes('csharp') && rk === 'R_CS') matchScore += 3;
    if (techTags.includes('sql') && rk === 'R_DB') matchScore += 3;
    if (techTags.includes('rust') && rk === 'R_RUST') matchScore += 4;
    if (techTags.includes('python') && rk === 'R_PY') matchScore += 4;
    if (techTags.includes('golang') && rk === 'R_GO') matchScore += 4;
    if (techTags.includes('php') && rk === 'R_PHP') matchScore += 4;
    if (techTags.includes('react') && rk === 'R_REACT') matchScore += 4;
    if (techTags.includes('nodejs') && rk === 'R_NODE') matchScore += 4;
    if (techTags.includes('cpp') && rk === 'R_CPP') matchScore += 4;
    if (techTags.includes('embedded') && rk === 'R_EMBEDDED') matchScore += 4;
    if (techTags.includes('godot') && (rk === 'R_GODOT' || rk === 'R_GAME')) matchScore += 4;
    if (techTags.includes('game') && rk === 'R_GAME') matchScore += 3;
    if (techTags.includes('android') && rk === 'R_ANDROID') matchScore += 4;
    if ((techTags.includes('teamwork') || techTags.includes('multi-agent')) && rk === 'R_TEAM') matchScore += 4;
    if (techTags.includes('ui') && rk === 'R_UI') matchScore += 3;
    if (techTags.includes('reversing') && rk === 'R_REVERSE') matchScore += 4;
    if ((techTags.includes('pentest') || techTags.includes('security')) && (rk === 'R_PENTEST' || rk === 'R_SEC' || rk === 'R_SEC_STD')) matchScore += 3;
    if (techTags.includes('inventory') && rk === 'R_DOMAIN_INV') matchScore += 4;
    if (techTags.includes('production') && rk === 'R_DOMAIN_PROD') matchScore += 4;
    if (techTags.includes('sales') && rk === 'R_DOMAIN_SALES') matchScore += 4;
    if (techTags.includes('refactor') && rk === 'R_NEV') matchScore += 3;
    if (techTags.includes('perf') && (rk === 'R_PERF' || rk === 'R_BENCH')) matchScore += 3;
    if ((techTags.includes('test') || techTags.includes('unit-test')) && rk === 'R_TDD') matchScore += 3;

    if (matchScore > 0) {
      matchedRules.push({
        id: ruleKey,
        score: matchScore,
        desc: desc.substring(0, 90) + '...'
      });
    }
  }

  matchedRules.sort((a, b) => b.score - a.score);
  const topRules = matchedRules.slice(0, 4);

  // B. Score Shortcuts / Skills & Agent Personas using target path segments
  for (const [sKey, sVal] of Object.entries(shortcutsMap)) {
    const targetNorm = String(sVal.target || '').replace(/\\/g, '/').toLowerCase();
    const sDescTokens = tokenize(`${sVal.name || ''} ${sVal.desc || ''} ${targetNorm}`);
    let sScore = 0;

    for (const t of combinedTokens) {
      if (sDescTokens.includes(t)) sScore += 1;
      if (sKey.toLowerCase() === t) sScore += 3;
    }

    // Match target path segments (standards/<stack>/, skills/<stack>/, agents/)
    for (const tag of techTags) {
      if (
        targetNorm.includes(`standards/${tag}/`) ||
        targetNorm.includes(`skills/${tag}/`)
      ) {
        sScore += 2.5;
      }
    }

    if (
      (techTags.includes('wpf') || techTags.includes('winforms') || techTags.includes('webapi')) &&
      (targetNorm.includes('standards/csharp/') || targetNorm.includes('skills/csharp/'))
    ) {
      sScore += 1.5;
    }
    if (techTags.includes('sql') && (targetNorm.includes('standards/database/') || targetNorm.includes('skills/database/'))) {
      sScore += 2.5;
    }

    // Boost if shortcut target path matches top priority rules
    for (const r of topRules) {
      const segments = RULE_TO_PATH_SEGMENTS[r.id] || [];
      if (segments.some(seg => targetNorm.includes(seg))) {
        sScore += 2.0;
      }
    }

    const isAgentShortcut = sKey.startsWith('AGT_') || targetNorm.startsWith('agents/');

    if (sScore > 0) {
      const entry = {
        shortcut: sKey,
        name: sVal.name || sKey,
        score: sScore,
        target: sVal.target,
        desc: sVal.desc
      };
      if (isAgentShortcut) {
        matchedAgents.push(entry);
      } else {
        matchedSkills.push(entry);
      }
    }
  }

  matchedSkills.sort((a, b) => b.score - a.score);
  matchedAgents.sort((a, b) => b.score - a.score);

  return {
    rules: topRules,
    skills: matchedSkills.slice(0, 4),
    agents: matchedAgents.slice(0, 3)
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

  // Keyword-based tag deduction across all 13 stacks & domains
  const lower = String(taskText || '').toLowerCase();
  if (/(jwt|auth|token|security|hash|idor|bola|sqli|xss|ssrf|cvss|pentest)/.test(lower)) tagSet.add('security');
  if (/(pentest|idor|bola|sqli|xss|ssrf|cvss|exploit|fuzz)/.test(lower)) tagSet.add('pentest');
  if (/(reverse|reversing|ghidra|frida|deobfuscat|unpack|il2cpp|firmware\s+dump)/.test(lower)) tagSet.add('reversing');
  if (/(api|rest|endpoint|controller|webapi)/.test(lower)) tagSet.add('api');
  if (/(refactor|clean|simplify|modularize)/.test(lower)) tagSet.add('refactor');
  if (/(winforms|baseform|xtraform|gridcontrol)/.test(lower)) tagSet.add('winforms');
  if (/(wpf|xaml|mvvm)/.test(lower)) tagSet.add('wpf');
  if (/(csharp|\bc#\b|dotnet|\.net|dapper|linq)/.test(lower)) tagSet.add('csharp');
  if (/(rust|cargo|no_std|clippy|borrow|lifetime|ffi|crate|\brs\b)/.test(lower)) tagSet.add('rust');
  if (/(python|fastapi|pydantic|asyncio|mypy|pytest|langgraph|\bpy\b)/.test(lower)) tagSet.add('python');
  if (/(golang|\bgo\b|goroutine|errgroup|channel)/.test(lower)) tagSet.add('golang');
  if (/(\bphp\b|pdo|laravel|symfony|psr-4)/.test(lower)) tagSet.add('php');
  if (/(react|jsx|tsx|redux|zustand|useeffect|usestate|tailwind)/.test(lower)) tagSet.add('react');
  if (/(node|nodejs|express|middleware|commonjs)/.test(lower)) tagSet.add('nodejs');
  if (/(\bc\+\+|cpp|cmake|simd|native\s+interop|libraryimport)/.test(lower)) tagSet.add('cpp');
  if (/(embedded|rtos|firmware|dma|isr|mmio|bare-metal|stm32)/.test(lower)) tagSet.add('embedded');
  if (/(godot|gdscript|tscn|canvaslayer|packedscene)/.test(lower)) tagSet.add('godot');
  if (/(game|arpg|hfsm|tick|loot)/.test(lower)) tagSet.add('game');
  if (/(android|kotlin|compose|ndk|camerax|jni)/.test(lower)) tagSet.add('android');
  if (/(sql|database|query|index|deadlock|sarg)/.test(lower)) tagSet.add('sql');
  if (/(teamwork|multi-agent|subagent|orchestrat|adversarial\s+team|parallel\s+agent)/.test(lower)) {
    tagSet.add('teamwork');
    tagSet.add('multi-agent');
  }
  if (/(ui|ux|design\s+system|theme|dark\s+mode|layout|token)/.test(lower)) tagSet.add('ui');
  if (/(scada|plc|modbus)/.test(lower)) tagSet.add('scada');
  if (/(inventory|stock|warehouse)/.test(lower)) tagSet.add('inventory');
  if (/(production|lot|bom|mes)/.test(lower)) tagSet.add('production');
  if (/(sales|order|packing)/.test(lower)) tagSet.add('sales');
  if (/(benchmark|perf|latency|simd|zero-alloc)/.test(lower)) tagSet.add('perf');
  if (tagSet.size === 0) tagSet.add('general');

  const suggestedTags = Array.from(tagSet);

  // 2. Choice Primitives (Rules, Skills, and Agents)
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
      recommended_agents: matches.agents.map(a => ({
        shortcut: a.shortcut,
        name: a.name,
        target: a.target,
        desc: a.desc
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

  if (d.recommended_agents && d.recommended_agents.length > 0) {
    console.log(`\n🎭 Recommended Agent Personas:`);
    d.recommended_agents.forEach(a => {
      console.log(`  • [\x1b[35m${a.shortcut}\x1b[0m] ${a.name}: ${a.desc} -> ${a.target}`);
    });
  }
  console.log(`─────────────────────────────────────────────────────────────────\n`);
  process.exit(0);
}

module.exports = { decideRoute, matchRulesAndShortcuts };

