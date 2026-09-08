#!/usr/bin/env node
/**
 * context-fetch.js — Smart Pre-Fetch Context Runner
 *
 * Automatically resolves project context from .project-rule.md or Git root,
 * infers multi-dimensional domain & tech tags, and delegates to find-qa-context.js.
 *
 * Usage:
 *   node E:\Tools\SemanticBrain\tools\context-fetch.js "<mô tả task>" [--tags=extra1,extra2] [--limit=5] [--full]
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { getProjectInfo, inferTechTags } = require('./project-helper');

const taskDesc = process.argv.slice(2).find(a => !a.startsWith('--'));

if (!taskDesc) {
  console.log(`
Usage:
  node E:\\Tools\\SemanticBrain\\tools\\context-fetch.js "<mô tả task>" [--tags=tag1,tag2] [--full] [--limit=N]

Example:
  node E:\\Tools\\SemanticBrain\\tools\\context-fetch.js "Triển khai Windows notification bridge"
`);
  process.exit(1);
}

// 1. Resolve project info
const projectInfo = getProjectInfo(process.cwd());
const projectName = projectInfo.projectName;

// 2. Resolve tags
const customTagsArg = process.argv.find(a => a.startsWith('--tags='));
const customTags = customTagsArg ? customTagsArg.split('=')[1].split(',').map(t => t.trim()).filter(Boolean) : [];

const tagSet = new Set();
if (projectInfo.domain) tagSet.add(projectInfo.domain);
for (const t of inferTechTags(process.cwd())) tagSet.add(t);
for (const t of customTags) tagSet.add(t);

// Fallback tag if empty
if (tagSet.size === 0) tagSet.add('general');

const combinedTags = Array.from(tagSet).join(',');

// 3. Assemble arguments for find-qa-context.js
const targetScript = path.join(__dirname, 'find-qa-context.js');
const forwardedArgs = [
  taskDesc,
  `--project=${projectName}`,
  `--tags=${combinedTags}`
];

for (const arg of process.argv.slice(2)) {
  if (arg === taskDesc) continue;
  if (arg.startsWith('--tags=')) continue; // already merged
  if (arg.startsWith('--project=')) continue; // override handled
  forwardedArgs.push(arg);
}

console.log(`[CONTEXT-FETCH] Project: ${projectName} | Tags: [${combinedTags}]`);

// 4. Execute find-qa-context.js
const result = spawnSync('node', [targetScript, ...forwardedArgs], {
  stdio: 'inherit',
  cwd: __dirname,
  env: process.env
});

process.exit(result.status ?? 0);
