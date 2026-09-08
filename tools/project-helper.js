/**
 * project-helper.js — Shared Project Discovery & Context Helper
 *
 * Automatically detects project root, reads .project-rule.md safely,
 * resolves project name & domain, and infers technical tags from Git changes.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  let gitDir = null;
  let projectRulePath = null;

  while (true) {
    const candidateRule = path.join(current, '.project-rule.md');
    const candidateGit = path.join(current, '.git');

    if (fs.existsSync(candidateRule) && !projectRulePath) {
      projectRulePath = candidateRule;
    }
    if (fs.existsSync(candidateGit) && !gitDir) {
      gitDir = candidateGit;
    }

    if (projectRulePath && gitDir) {
      return { rootDir: current, projectRulePath, gitDir };
    }

    const parent = path.dirname(current);
    if (parent === current) break; // Reached root drive
    current = parent;
  }

  // Fallback to git root or startDir
  const rootDir = gitDir ? path.dirname(gitDir) : (projectRulePath ? path.dirname(projectRulePath) : path.resolve(startDir));
  return { rootDir, projectRulePath, gitDir };
}

function parseProjectRule(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const info = {};

    // Match YAML frontmatter between --- and ---
    const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const textToScan = yamlMatch ? yamlMatch[1] : content;

    const lines = textToScan.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        let val = match[2].trim();
        // Remove quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        info[key] = val;
      }
    }

    return info;
  } catch (e) {
    return null;
  }
}

function getProjectInfo(startDir = process.cwd()) {
  const { rootDir, projectRulePath, gitDir } = findProjectRoot(startDir);
  const ruleInfo = parseProjectRule(projectRulePath);

  let projectName = ruleInfo?.project_name || ruleInfo?.project;
  let domain = ruleInfo?.domain || '';

  // Fallback if not specified in .project-rule.md
  if (!projectName) {
    if (gitDir) {
      projectName = path.basename(path.dirname(gitDir));
    } else {
      projectName = path.basename(rootDir);
    }
  }

  // Clean and normalize
  projectName = (projectName || 'unknown').trim().toLowerCase();

  return {
    projectName,
    domain,
    rootDir,
    projectRulePath,
    hasRuleFile: Boolean(projectRulePath),
    metadata: ruleInfo || {}
  };
}

function inferTechTags(startDir = process.cwd()) {
  const tags = new Set();
  try {
    // 1. Check staged or recently modified files
    let output = '';
    try {
      output = execSync('git status --porcelain', { cwd: startDir, encoding: 'utf-8', timeout: 3000 });
    } catch {
      // not a git repo or git not found
    }

    if (!output.trim()) {
      try {
        output = execSync('git diff --name-only HEAD~1', { cwd: startDir, encoding: 'utf-8', timeout: 3000 });
      } catch {
        // ignore
      }
    }

    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const cleanPath = line.replace(/^[AMD?RCU\s]+/g, '').replace(/\\/g, '/').toLowerCase();

      if (cleanPath.includes('wpf') || cleanPath.endsWith('.xaml')) tags.add('wpf');
      if (cleanPath.includes('winforms') || cleanPath.includes('.designer.cs')) tags.add('winforms');
      if (cleanPath.includes('controller') || cleanPath.includes('webapi') || cleanPath.includes('endpoint')) tags.add('webapi');
      if (cleanPath.includes('test') || cleanPath.endsWith('tests.cs')) tags.add('test');
      if (cleanPath.includes('scada') || cleanPath.includes('plc') || cleanPath.includes('modbus')) tags.add('scada');
      if (cleanPath.includes('migration') || cleanPath.endsWith('.sql')) tags.add('sql');
      if (cleanPath.includes('inventory')) tags.add('inventory');
      if (cleanPath.includes('sales')) tags.add('sales');
      if (cleanPath.includes('production') || cleanPath.includes('mes')) tags.add('production');
      if (cleanPath.includes('inspection') || cleanPath.includes('qc')) tags.add('inspection');
      if (cleanPath.includes('warehouse') || cleanPath.includes('wms')) tags.add('warehouse');
      if (cleanPath.includes('refactor')) tags.add('refactor');
      if (cleanPath.includes('benchmark') || cleanPath.includes('perf')) tags.add('perf');
    }
  } catch {
    // Ignore errors
  }

  return Array.from(tags);
}

module.exports = {
  findProjectRoot,
  getProjectInfo,
  inferTechTags
};
