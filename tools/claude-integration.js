/**
 * claude-integration.js - Claude Code Semantic Integration Layer
 *
 * Tích hợp semantic brain vào workflow của Claude Code:
 * 1. Pre-task: Query recipe/QA trước khi execute
 * 2. Post-task: Auto-save successful workflows
 * 3. Context loading: Pre-fetch domain knowledge
 *
 * Usage (from Claude Code):
 *   node .agent/tools/semantic/claude-integration.js --mode=pre --intent="<task>"
 *   node .agent/tools/semantic/claude-integration.js --mode=post --intent="<task>" --steps='<JSON>' --success=true
 */

const { execFileSync } = require('child_process');
const path = require('path');

const MODE = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1];
const INTENT = process.argv.find(a => a.startsWith('--intent='))?.split('=')[1];
const STEPS = process.argv.find(a => a.startsWith('--steps='))?.split('=')[1];
const SUCCESS = process.argv.includes('--success=true');
const CONTEXT_PATH = process.argv.find(a => a.startsWith('--path='))?.split('=')[1];
const SUMMARY = process.argv.find(a => a.startsWith('--summary='))?.split('=')[1];
const SUMMARY_FILE = process.argv.find(a => a.startsWith('--summary-file='))?.split('=')[1];

const SEMANTIC_DIR = __dirname;

/**
 * PRE-TASK: Query semantic brain before executing task
 * Returns: { type: 'recipe'|'qa'|'skill'|'none', data: {...} }
 */
async function preTask(intent, contextPath) {
  console.log(`[SEMANTIC PRE] Analyzing: "${intent}"`);

  // Step 1: Try Recipe first (fastest path)
  try {
    const recipeArgs = [path.join(SEMANTIC_DIR, 'find-recipe.js'), intent];
    if (contextPath) recipeArgs.push('--path', contextPath);

    const recipeOut = execFileSync('node', recipeArgs, { encoding: 'utf-8' });
    const recipe = JSON.parse(recipeOut);

    if (!recipe.error) {
      console.log(`[RECIPE HIT] id=${recipe._id}, steps=${recipe.steps.length}`);
      return { type: 'recipe', data: recipe };
    }
  } catch (e) {
    // Recipe MISS or error - continue to next step
  }

  // Step 2: Check if it's a question (not a task)
  const questionPatterns = [
    /^(what|how|why|when|where|who|which|can|is|are|does|do)/i,
    /\?$/,
    /giải thích|hướng dẫn|cách|tại sao|như thế nào/i
  ];

  const isQuestion = questionPatterns.some(p => p.test(intent));

  if (isQuestion) {
    try {
      // Use deep lookup for questions (auto-traverse references)
      const qaOut = execFileSync('node', [
        path.join(SEMANTIC_DIR, 'find-qa-deep.js'),
        intent
      ], { encoding: 'utf-8' });

      // Parse deep QA output
      const synthesizedMatch = qaOut.match(/=== SYNTHESIZED ANSWER ===\n([\s\S]+?)$/);
      const rawMatch = qaOut.match(/Q:\s*(.+?)\nA:\s*(.+?)(?:\n\[|$)/s);

      if (synthesizedMatch) {
        console.log(`[QA DEEP] Found complete answer with references`);
        return {
          type: 'qa',
          data: {
            answer: synthesizedMatch[1].trim(),
            mode: 'deep'
          }
        };
      } else if (rawMatch) {
        console.log(`[QA HIT] Found answer in knowledge base`);
        return {
          type: 'qa',
          data: {
            answer: rawMatch[2].trim(),
            mode: 'simple'
          }
        };
      }
    } catch (e) {
      // QA MISS - continue
    }
  }

  // Step 3: Find relevant skills
  try {
    const skillOut = execFileSync('node', [
      path.join(SEMANTIC_DIR, 'find-skill.js'),
      intent,
      '3'
    ], { encoding: 'utf-8' });

    if (!skillOut.includes('[NO MATCH]')) {
      console.log(`[SKILL MATCH] Found relevant skills`);
      // Parse skill output: [1] name | type | path
      const skills = [];
      const lines = skillOut.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/\[(\d+)\]\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(.+)/);
        if (match) {
          const desc = lines[i + 1]?.match(/>\s+(.+)/)?.[1] || '';
          skills.push({
            rank: parseInt(match[1]),
            name: match[2].trim(),
            type: match[3].trim(),
            path: match[4].trim(),
            desc: desc.trim()
          });
        }
      }
      return { type: 'skill', data: { skills } };
    }
  } catch (e) {
    // Skill MISS
  }

  console.log(`[SEMANTIC MISS] No cached knowledge found - will execute from scratch`);
  return { type: 'none', data: {} };
}

/**
 * POST-TASK: Save successful workflow as recipe
 */
async function postTask(intent, stepsJson, success, summaryText) {
  if (!success) {
    console.log(`[SEMANTIC POST] Task failed - not saving`);
    return;
  }

  // 1. Agent-side harvest: summary must be atomic JSON.
  if (summaryText && summaryText.length > 50) {
    try {
      const parsed = JSON.parse(summaryText);
      const isAtoms = Array.isArray(parsed) || (parsed && Array.isArray(parsed.atoms));
      if (!isAtoms) {
        console.warn('[HARVEST WARN] Summary is not atomic JSON; skipping (local LLM extraction removed).');
      } else {
        console.log(`[SEMANTIC POST] Ingesting agent-provided atoms...`);
        const tags = detectTags(intent);
        const harvestArgs = [
          path.join(SEMANTIC_DIR, 'ingest-knowledge.js'),
          `--json=${summaryText}`,
          `--tags=${tags.join(',')}`
        ];
        execFileSync('node', harvestArgs, { encoding: 'utf-8', stdio: 'inherit' });
      }
    } catch (e) {
      console.warn('[HARVEST WARN] Summary is not JSON atoms; skipping (local LLM extraction removed).');
    }
  }

  // 2. Save recipe if steps provided
  if (stepsJson) {
    try {
      const steps = JSON.parse(stepsJson);
      const skillsUsed = new Set();
      const toolsUsed = new Set();

      steps.forEach(step => {
        if (step.action.startsWith('skill:')) {
          skillsUsed.add(step.action.replace('skill:', ''));
        } else {
          toolsUsed.add(step.action);
        }
      });

      const recipe = {
        intent,
        category: detectCategory(intent),
        target_pattern: detectPattern(intent),
        steps,
        skills_used: Array.from(skillsUsed),
        tools_used: Array.from(toolsUsed)
      };

      execFileSync('node', [
        path.join(SEMANTIC_DIR, 'save-recipe.js'),
        JSON.stringify(recipe)
      ], { encoding: 'utf-8', stdio: 'inherit' });

      console.log(`[SEMANTIC POST] Recipe saved successfully`);
    } catch (e) {
      console.error(`[RECIPE WARN] ${e.message}`);
    }
  }
}

/**
 * CONTEXT-LOAD: Pre-fetch domain knowledge by tags
 */
async function loadContext(tags) {
  try {
    const tagsOut = execFileSync('node', [
      path.join(SEMANTIC_DIR, 'find-tags.js'),
      tags,
      '--mode=or'
    ], { encoding: 'utf-8' });

    const contexts = JSON.parse(tagsOut);
    console.log(`[CONTEXT LOADED] ${contexts.length} knowledge entries`);
    return contexts;
  } catch (e) {
    console.log(`[CONTEXT LOAD] No relevant context found`);
    return [];
  }
}

// Helper: Detect category from intent
function detectCategory(intent) {
  const lower = intent.toLowerCase();
  if (/refactor|modernize|migrate|ua/i.test(lower)) return 'refactor';
  if (/fix|bug|issue|error/i.test(lower)) return 'bugfix';
  if (/add|create|implement|new/i.test(lower)) return 'feature';
  if (/test|verify|check/i.test(lower)) return 'testing';
  if (/optimize|improve|performance/i.test(lower)) return 'optimization';
  return 'general';
}

// Helper: Detect target pattern from intent
function detectPattern(intent) {
  const featureMatch = intent.match(/Features?\/([^\/\s]+\/[^\/\s]+)/i);
  if (featureMatch) return `Features/${featureMatch[1]}`;

  const moduleMatch = intent.match(/(Inventory|Production|Sales|SystemSecurity)\/([^\/\s]+)/i);
  if (moduleMatch) return `Features/${moduleMatch[1]}/${moduleMatch[2]}`;

  return '';
}

// Helper: Detect tags from intent for auto-harvest
function detectTags(intent) {
  const tags = [];
  const lower = intent.toLowerCase();
  if (/refactor|ua|modernize/.test(lower)) tags.push('ua', 'refactor');
  if (/inventory|kho|stock/.test(lower)) tags.push('inventory');
  if (/production|sản xuất/.test(lower)) tags.push('production');
  if (/sales|bán/.test(lower)) tags.push('sales');
  if (/inspection|qc|kiểm tra/.test(lower)) tags.push('inspection');
  if (/handover|bàn giao/.test(lower)) tags.push('handover');
  if (/winform|form|view/.test(lower)) tags.push('winforms');
  if (/bug|fix|lỗi/.test(lower)) tags.push('bug');
  if (/pattern|architecture/.test(lower)) tags.push('pattern');
  if (tags.length === 0) tags.push('general');
  return tags;
}

// Main execution
(async () => {
  if (!MODE) {
    console.log('Usage:');
    console.log('  Pre-task:  node claude-integration.js --mode=pre --intent="<task>" [--path="<file>"]');
    console.log('  Post-task: node claude-integration.js --mode=post --intent="<task>" --success=true [--summary="<text>"] [--steps=\'<JSON>\']');
    console.log('  Harvest:   node claude-integration.js --mode=harvest --intent="<task>" --summary="<text>" [--tags=ua,inv]');
    console.log('  Context:   node claude-integration.js --mode=context --tags="ua,inventory"');
    process.exit(1);
  }

  try {
    if (MODE === 'pre') {
      const result = await preTask(INTENT, CONTEXT_PATH);
      console.log(JSON.stringify(result, null, 2));
    } else if (MODE === 'post') {
      const summary = SUMMARY || (SUMMARY_FILE ? require('fs').readFileSync(SUMMARY_FILE, 'utf-8') : null);
      await postTask(INTENT, STEPS, SUCCESS, summary);
    } else if (MODE === 'harvest') {
      // Standalone harvest mode: atomic JSON only.
      const summary = SUMMARY || (SUMMARY_FILE ? require('fs').readFileSync(SUMMARY_FILE, 'utf-8') : null);
      if (!summary) {
        console.error('[ERROR] --summary or --summary-file required for harvest mode');
        process.exit(1);
      }
      let parsed;
      try {
        parsed = JSON.parse(summary);
      } catch {
        console.error('[ERROR] Harvest summary must be atomic JSON (local LLM extraction removed).');
        console.error('        Use: node tools/ingest-knowledge.js --file=atoms.json');
        process.exit(1);
      }
      if (!Array.isArray(parsed) && !(parsed && Array.isArray(parsed.atoms))) {
        console.error('[ERROR] Harvest summary must contain an atoms array.');
        process.exit(1);
      }
      const tags = process.argv.find(a => a.startsWith('--tags='))?.split('=')[1];
      const harvestArgs = [path.join(SEMANTIC_DIR, 'ingest-knowledge.js'), `--json=${summary}`];
      if (tags) harvestArgs.push(`--tags=${tags}`);
      execFileSync('node', harvestArgs, { encoding: 'utf-8', stdio: 'inherit' });
    } else if (MODE === 'context') {
      const tags = process.argv.find(a => a.startsWith('--tags='))?.split('=')[1];
      const contexts = await loadContext(tags);
      console.log(JSON.stringify(contexts, null, 2));
    } else {
      console.error(`Unknown mode: ${MODE}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    process.exit(1);
  }
})();
