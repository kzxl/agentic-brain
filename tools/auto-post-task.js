#!/usr/bin/env node
/**
 * auto-post-task.js — Smart Post-Harvest Runner
 *
 * Automatically resolves project name from local .project-rule.md or Git root,
 * dynamically generates multi-dimensional tags (Domain + Tech),
 * and delegates to post-task.js to save knowledge into SemanticBrain.
 *
 * Usage:
 *   node E:\Tools\SemanticBrain\tools\auto-post-task.js "<tóm tắt bài học kỹ thuật>" [--tags=extra1,extra2] [--file=walkthrough.md] [--direct] [--dry-run]
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { getProjectInfo, inferTechTags } = require('./project-helper');

const textArg = process.argv.slice(2).find(a => !a.startsWith('--'));
const fileArg = process.argv.find(a => a.startsWith('--file='));

if (!textArg && !fileArg) {
  console.log(`
Usage:
  node E:\\Tools\\SemanticBrain\\tools\\auto-post-task.js "<tóm tắt bài học kỹ thuật>" [--tags=extra1,extra2] [--file=walkthrough.md] [--direct] [--dry-run]

Example:
  node E:\\Tools\\SemanticBrain\\tools\\auto-post-task.js "Triển khai WindowsNotificationBridge kết nối Action Center và phục hồi focus window"
`);
  process.exit(1);
}

// 1. Resolve project info
const projectInfo = getProjectInfo(process.cwd());
const projectName = projectInfo.projectName;

// 2. Resolve & merge multi-dimensional tags (Domain + Technical)
const customTagsArg = process.argv.find(a => a.startsWith('--tags='));
const customTags = customTagsArg ? customTagsArg.split('=')[1].split(',').map(t => t.trim()).filter(Boolean) : [];

const tagSet = new Set();

// Add domain tag
if (projectInfo.domain) {
  tagSet.add(projectInfo.domain);
} else {
  tagSet.add('production'); // fallback domain
}

// Add inferred tech tags
for (const t of inferTechTags(process.cwd())) tagSet.add(t);
for (const t of customTags) tagSet.add(t);

// Ensure at least 1 technical tag
const techCandidates = ['winforms', 'wpf', 'webapi', 'sql', 'scada', 'refactor', 'perf', 'async', 'pattern', 'test'];
const hasTechTag = Array.from(tagSet).some(t => techCandidates.includes(t));
if (!hasTechTag) {
  tagSet.add('pattern');
}

const combinedTags = Array.from(tagSet).join(',');

// 3. Assemble arguments for post-task.js (textArg MUST be first argument for post-task.js)
const targetScript = path.join(__dirname, 'post-task.js');
const forwardedArgs = [];

if (textArg) forwardedArgs.push(textArg);
forwardedArgs.push(`--project=${projectName}`);
forwardedArgs.push(`--tags=${combinedTags}`);

for (const arg of process.argv.slice(2)) {
  if (arg === textArg) continue;
  if (arg.startsWith('--tags=')) continue;
  if (arg.startsWith('--project=')) continue;
  forwardedArgs.push(arg);
}

console.log(`[AUTO-POST-TASK] Project: ${projectName} | Inferred Tags: [${combinedTags}]`);

// 4. Execute post-task.js
const result = spawnSync('node', [targetScript, ...forwardedArgs], {
  stdio: 'inherit',
  cwd: __dirname,
  env: process.env
});

process.exit(result.status ?? 0);
