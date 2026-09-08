#!/usr/bin/env node
/**
 * git-safe-commit.js — Atomic Git Commit Guard
 *
 * Protects project-rule files, environment secrets, and ensures atomic commits.
 *
 * Usage:
 *   node E:\Tools\SemanticBrain\tools\git-safe-commit.js -m "feat(scope): commit message" [files to stage...]
 *   node E:\Tools\SemanticBrain\tools\git-safe-commit.js -m "chore: update rules" --allow-config .project-rule.md
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');

const PROTECTED_FILES = [
  '.project-rule.md',
  '.env',
  'credentials.json',
  'appsettings.development.json'
];

function isProtected(filePath) {
  const baseName = path.basename(filePath).toLowerCase();
  if (PROTECTED_FILES.includes(baseName)) return true;
  if (baseName.startsWith('.env.') && !baseName.endsWith('.example')) return true;
  return false;
}

const args = process.argv.slice(2);
let message = null;
const filesToStage = [];
let allowConfig = false;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-m' || arg === '--message') {
    message = args[++i];
  } else if (arg.startsWith('-m=')) {
    message = arg.substring(3);
  } else if (arg.startsWith('--message=')) {
    message = arg.substring(10);
  } else if (arg === '--allow-config') {
    allowConfig = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (!arg.startsWith('-')) {
    filesToStage.push(arg);
  }
}

if (!message) {
  console.error(`
[ERROR] Missing commit message (-m "<message>").

Usage:
  node E:\\Tools\\SemanticBrain\\tools\\git-safe-commit.js -m "<commit message>" [files...] [--allow-config] [--dry-run]
`);
  process.exit(1);
}

// 1. Stage requested files if provided
if (filesToStage.length > 0) {
  console.log(`[GIT-GUARD] Staging ${filesToStage.length} specified file(s)...`);
  try {
    execSync(`git add ${filesToStage.map(f => `"${f}"`).join(' ')}`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`[GIT-GUARD] Failed to stage files:`, e.message);
    process.exit(1);
  }
}

// 2. Inspect currently staged files
let stagedOutput = '';
try {
  stagedOutput = execSync('git diff --cached --name-only', { encoding: 'utf-8' }).trim();
} catch (e) {
  console.error(`[GIT-GUARD] Not a git repository or git error:`, e.message);
  process.exit(1);
}

if (!stagedOutput) {
  console.error(`[GIT-GUARD] No staged changes found to commit.`);
  process.exit(1);
}

const stagedFiles = stagedOutput.split(/\r?\n/).map(f => f.trim()).filter(Boolean);

// 3. Scan for protected files
const violations = [];
for (const file of stagedFiles) {
  if (isProtected(file) && !allowConfig) {
    violations.push(file);
  }
}

if (violations.length > 0) {
  console.error(`\n============================================================`);
  console.error(`[GIT-GUARD: BLOCKED] Protected configuration file(s) detected in staged changes:`);
  for (const v of violations) {
    console.error(`  ❌ ${v}`);
  }
  console.error(`\nAuto-unstaging protected file(s) to protect repository integrity...`);

  for (const v of violations) {
    try {
      execSync(`git reset HEAD -- "${v}"`, { stdio: 'ignore' });
      console.error(`  ↩️  Unstaged: ${v}`);
    } catch {
      try {
        execSync(`git rm --cached -- "${v}"`, { stdio: 'ignore' });
        console.error(`  ↩️  Unstaged: ${v}`);
      } catch {
        // ignore
      }
    }
  }

  console.error(`\nTip: If you INTENTIONALLY want to commit this file, add the --allow-config flag.`);
  console.error(`============================================================\n`);

  // Re-check if any staged files remain
  const remainingStaged = execSync('git diff --cached --name-only', { encoding: 'utf-8' }).trim();
  if (!remainingStaged) {
    console.error(`[GIT-GUARD] No other staged files remaining. Commit successfully BLOCKED and aborted.`);
    process.exit(1);
  }
  console.log(`[GIT-GUARD] Proceeding with remaining staged file(s)...`);
}

// 4. Conventional commit format advisory
const conventionalPattern = /^(feat|fix|refactor|chore|docs|style|test|perf|ci|build)(\([a-zA-Z0-9_\-]+\))?:\s+.+$/;
if (!conventionalPattern.test(message)) {
  console.log(`[GIT-GUARD ADVISORY] Message does not follow Conventional Commits standard: "${message}"`);
  console.log(`  Expected format: feat(scope): message, fix(scope): message, etc.`);
}

// 5. Atomic scope advisory (R_GIT)
if (stagedFiles.length > 15) {
  console.log(`[GIT-GUARD ADVISORY] Staged changes contain ${stagedFiles.length} files.`);
  console.log(`  Per R_GIT, please ensure this is an atomic commit and not a bundle of unrelated features.`);
}

if (dryRun) {
  console.log(`[GIT-GUARD] DRY-RUN completed successfully. Commit not executed.`);
  process.exit(0);
}

// 6. Execute commit
console.log(`[GIT-GUARD] Executing atomic commit: "${message}"`);
const commitResult = spawnSync('git', ['commit', '-m', message], { stdio: 'inherit' });
process.exit(commitResult.status ?? 0);
