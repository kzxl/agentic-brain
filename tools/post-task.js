#!/usr/bin/env node
/**
 * post-task.js — One-shot Post-Task Pipeline
 *
 * Agent gọi 1 lần duy nhất sau task phức tạp.
 * Tự động: extract knowledge → save DB → (optional) mark recipe
 *
 * Usage:
 *   node tools/post-task.js "<tóm tắt task>" --tags=ua,inventory [--project=erp]
 *   node tools/post-task.js --file=walkthrough.md --tags=ua [--project=erp]
 *   node tools/post-task.js "<tóm tắt>" --tags=ua --dry-run
 *   node tools/post-task.js "<Câu hỏi>|<Câu trả lời>" --tags=ua --direct
 *     (--direct: bypass LLM, lưu thẳng — dùng khi agent đã tự tổng hợp nội dung)
 *
 * Multi-tenant: --project=erp sẽ inject tag 'project:erp' để phân biệt nguồn dữ liệu
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOOLS_DIR = __dirname; // Thu muc tools/ cua project nay
const DRY_RUN = process.argv.includes('--dry-run');
const DIRECT = process.argv.includes('--direct');
const PINNED = process.argv.includes('--pinned');
const FORCE = process.argv.includes('--force');

// Parse args
const TAGS = process.argv.find(a => a.startsWith('--tags='))?.split('=')[1] || '';
const FILE_ARG = process.argv.find(a => a.startsWith('--file='))?.split('=')[1];
const PROJECT_ARG = process.argv.find(a => a.startsWith('--project='))?.split('=')[1]?.toLowerCase() || '';
const TEXT_ARG = process.argv[2];

// Build full tags string (bao gồm project tag nếu có)
const buildTagsArg = () => {
  const parts = TAGS ? TAGS.split(',').map(t => t.trim()).filter(t => t) : [];
  if (PROJECT_ARG) {
    const projectTag = `project:${PROJECT_ARG}`;
    if (!parts.includes(projectTag)) parts.push(projectTag);
  }
  if (PINNED && !parts.includes('pinned')) {
    parts.push('pinned');
  }
  return parts.join(',');
};
const FULL_TAGS = buildTagsArg();

// Get input text
let inputText = '';
if (FILE_ARG) {
  const filePath = path.resolve(FILE_ARG);
  if (fs.existsSync(filePath)) {
    inputText = fs.readFileSync(filePath, 'utf-8');
  } else {
    console.error(`[ERROR] File not found: ${filePath}`);
    process.exit(1);
  }
} else if (TEXT_ARG && !TEXT_ARG.startsWith('--')) {
  inputText = TEXT_ARG;
}

if (!inputText || inputText.length < 30) {
  console.log(`Usage: node tools/post-task.js "<tóm tắt task đã làm>" --tags=ua,inventory [--project=erp] [--pinned]`);
  console.log(`       node tools/post-task.js --file=walkthrough.md --tags=ua [--project=erp]`);
  console.log(`\nInput phải >= 30 ký tự.`);
  process.exit(1);
}

// ── Harvest Quality Guard ──
function validateHarvestQuality(text, isDirect) {
  const lower = text.toLowerCase();
  
  // 1. Transient environment patterns that should not be persisted
  const transientPatterns = [
    { regex: /\b(vpn|openvpn|wireguard)\b/i, reason: 'VPN or network tunnel connectivity issues are environment-specific and transient.' },
    { regex: /\b(econnrefused|etimedout|socket hang up|connection refused)\b/i, reason: 'Transient network or socket timeouts must not be persisted as permanent technical knowledge.' },
    { regex: /\b(missing api key|unauthorized 401|401 unauthorized|expired token|invalid token)\b/i, reason: 'Missing secrets, credentials, or expired tokens are local operator setup issues, not architectural lessons.' },
    { regex: /\b(disk full|out of memory|enospc|device full)\b/i, reason: 'Machine-level hardware resource exhaustion is temporary and environment-specific.' },
    { regex: /\b(command not found|is not recognized as an internal or external command)\b/i, reason: 'Missing local shell binaries are setup prerequisites, not durable engineering principles.' },
    { regex: /\b(tool\s+(?:is\s+)?broken|cannot\s+use\s+tool|tool\s+does\s+not\s+work)\b/i, reason: 'Negative absolute assertions about tools create persistent false self-refusals.' }
  ];

  for (const item of transientPatterns) {
    if (item.regex.test(lower)) {
      return { valid: false, reason: item.reason };
    }
  }

  // 2. Direct format validation: [Symptom/Problem] | [Root Cause] | [Solution/Gotchas]
  if (isDirect) {
    const parts = text.split('|').map(p => p.trim());
    if (parts.length < 2) {
      return { valid: false, reason: 'Direct harvest must follow structured format: "<Problem> | <Solution & Gotchas>" or "<Symptom> | <Root Cause> | <Fix>"' };
    }
    if (parts[0].length < 10) {
      return { valid: false, reason: 'Problem/Question part is too short (< 10 chars). Please describe the technical symptom clearly.' };
    }
    if (parts[1].length < 15) {
      return { valid: false, reason: 'Solution part is too short (< 15 chars). Please provide actionable engineering guidance.' };
    }
  }

  return { valid: true };
}

const qualityCheck = validateHarvestQuality(inputText, DIRECT);
if (!qualityCheck.valid) {
  if (FORCE) {
    console.warn(`\n⚠️ [QUALITY GUARD WARNING] ${qualityCheck.reason} (--force active, proceeding anyway)`);
  } else {
    console.error(`\n❌ [HARVEST REJECTED BY QUALITY GUARD]`);
    console.error(`   Reason: ${qualityCheck.reason}`);
    console.error(`   👉 Harvest must capture durable architectural rules, gotchas, or root causes—not transient environment glitches.`);
    console.error(`   👉 To override in exceptional cases, append --force.\n`);
    process.exit(1);
  }
}

const projectLabel = PROJECT_ARG ? ` | Project: ${PROJECT_ARG}` : '';
console.log(`\n╔═══════════════════════════════════════════════╗`);
console.log(`║  POST-TASK PIPELINE                           ║`);
console.log(`║  ${DRY_RUN ? 'Mode: DRY-RUN' : 'Mode: ⚡ LIVE '}  Tags: ${(FULL_TAGS || 'auto').substring(0, 15).padEnd(15)}  ║`);
console.log(`╚═══════════════════════════════════════════════╝${projectLabel}\n`);

// Step 1: Auto-harvest (hoặc Direct Save)
console.log(`── Step 1: ${DIRECT ? 'Direct Save (bypass LLM)' : 'Auto-Harvest Knowledge'} ──`);
try {
  if (DIRECT) {
    const parts = inputText.includes('|') ? inputText.split('|') : [inputText, inputText];
    const question = parts[0].trim();
    const answer = parts.slice(1).join('|').trim() || question;

    const saveArgs = [
      path.join(TOOLS_DIR, 'save-qa.js'),
      question,
      answer,
      '--source=agent-direct',
      '--confidence=0.7',
    ];
    if (FULL_TAGS) saveArgs.push(`--tags=${FULL_TAGS}`);
    if (PROJECT_ARG) saveArgs.push(`--project=${PROJECT_ARG}`);
    if (PINNED) saveArgs.push('--pinned');

    execFileSync('node', saveArgs, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 30000
    });
  } else {
    const harvestArgs = [
      path.join(TOOLS_DIR, 'auto-harvest.js'),
      inputText,
    ];
    if (FULL_TAGS) harvestArgs.push(`--tags=${FULL_TAGS}`);
    if (DRY_RUN) harvestArgs.push('--dry-run');

    execFileSync('node', harvestArgs, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 120000
    });
  }
} catch (e) {
  console.error(`[HARVEST ERROR] ${e.message}`);
}

// Step 2: Quick health check + alerts
console.log(`\n── Step 2: Quick Health Summary ──`);
try {
  const statsScriptPath = path.join(TOOLS_DIR, 'stats.js');
  const statsArgs = [];
  if (PROJECT_ARG) statsArgs.push(`--project=${PROJECT_ARG}`);

  const statsOut = execFileSync('node', [statsScriptPath, '--json', ...statsArgs], {
    encoding: 'utf-8',
    timeout: 10000,
  });

  // dotenv có thể inject dòng prefix vào stdout → lấy dòng JSON thực sự
  const jsonLine = statsOut.split('\n').find(l => l.trim().startsWith('{'));
  if (!jsonLine) throw new Error('No JSON output from stats.js');
  const stats = JSON.parse(jsonLine);
  console.log(`   Total: ${stats.total} | Used: ${stats.used} (${stats.use_pct}%) | No tags: ${stats.no_tags} | Ultra-cold: ${stats.ultra_cold}`);

  // Alerts
  const alerts = [];
  if (stats.no_tags > 0) alerts.push(`${stats.no_tags} entries missing tags → run: node tools/tag-patch.js --fix`);
  if (stats.ultra_cold > 5) alerts.push(`${stats.ultra_cold} ultra-cold entries → run: node tools/qa-health.js --fix`);
  if (parseFloat(stats.use_pct) < 25) alerts.push(`Usage rate ${stats.use_pct}% too low → run /semantic-maintenance`);

  if (alerts.length > 0) {
    console.log(`   ⚠️ ALERTS:`);
    alerts.forEach(a => console.log(`     - ${a}`));
  } else {
    console.log(`   ✅ No issues detected`);
  }
} catch (e) {
  console.log(`   (DB stats unavailable)`);
}

console.log(`\n═══════════════════════════════════════════════`);
console.log(`[DONE] Post-task pipeline completed.`);
console.log(`═══════════════════════════════════════════════\n`);
