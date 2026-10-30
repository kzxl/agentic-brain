/**
 * storage-ame.js - Agent Memory Engine (AME) Storage Adapter
 * 
 * Provides sub-millisecond cognitive retrieval and memory harvesting
 * via Named Pipe IPC (\\.\pipe\ame_pipe) with automatic fallback to AME CLI.
 */

const net = require('net');
const path = require('path');
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const config = require('./config');

const DEFAULT_PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\ame_pipe' : '/tmp/ame.sock';
const PIPE_NAME = config.ame?.pipeName ? (process.platform === 'win32' ? `\\\\.\\pipe\\${config.ame.pipeName}` : `/tmp/${config.ame.pipeName}`) : DEFAULT_PIPE;

const DEFAULT_DB_PATH = config.ame?.defaultDb || path.resolve(__dirname, '..', 'data', 'semantic_brain.ame');

function resolveCliPath() {
  const candidates = [
    config.ame?.cliPath,
    'E:\\15. Other\\AgentMemoryEngine\\dist\\lite\\AgentMemoryEngine.Cli.exe',
    'E:\\15. Other\\AgentMemoryEngine\\dist\\full\\AgentMemoryEngine.Cli.exe',
    path.resolve(__dirname, '../../15. Other/AgentMemoryEngine/dist/lite/AgentMemoryEngine.Cli.exe'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveProjectDb(project) {
  // 1. Check current working directory for local .ame
  const cwdCandidates = [
    path.join(process.cwd(), '.agents', 'memory.ame'),
    path.join(process.cwd(), 'agent_memory.ame'),
    path.join(process.cwd(), 'memory.ame'),
  ];
  if (project) {
    cwdCandidates.unshift(path.join(process.cwd(), '.agents', `${project}.ame`));
    cwdCandidates.unshift(path.join(process.cwd(), `${project}.ame`));
  }

  for (const c of cwdCandidates) {
    if (fs.existsSync(c)) return c;
  }

  // 2. Default central database
  const dir = path.dirname(DEFAULT_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return DEFAULT_DB_PATH;
}

function ensureDbExists(dbPath) {
  if (fs.existsSync(dbPath)) return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const cli = resolveCliPath();
  if (cli) {
    execFileSync(cli, ['init', dbPath, '--dim', '384'], { encoding: 'utf-8', timeout: 10000 });
  } else {
    // Fallback dotnet run
    const csproj = 'E:\\15. Other\\AgentMemoryEngine\\src\\AgentMemoryEngine.Cli';
    if (fs.existsSync(csproj)) {
      execSync(`dotnet run --project "${csproj}" -c Release -- init "${dbPath}" --dim 384`, { encoding: 'utf-8', timeout: 30000 });
    }
  }
}

/**
 * Sends a JSON-RPC 2.0 command over Named Pipe IPC with timeout.
 */
function ipcCall(method, params = {}, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const socket = net.connect(PIPE_NAME);
    let buffer = '';

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error(`AME IPC call timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.on('connect', () => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      }) + '\n';
      socket.write(payload);
    });

    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) {
        const line = buffer.trim().split('\n')[0];
        try {
          const res = JSON.parse(line);
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            socket.end();
            if (res.error) {
              reject(new Error(res.error.message || 'IPC Error'));
            } else {
              resolve(res.result);
            }
          }
        } catch (e) {
          // Wait for complete JSON line
        }
      }
    });

    socket.on('error', err => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Checks if AME is ready (either via running IPC named pipe or CLI binary).
 */
async function isAmeAvailable() {
  try {
    // Quick test on named pipe (300ms timeout)
    await ipcCall('inspect', {}, 300);
    return { available: true, mode: 'ipc', pipe: PIPE_NAME };
  } catch {
    // Fallback: check if CLI binary exists
    const cli = resolveCliPath();
    if (cli) {
      return { available: true, mode: 'cli', cliPath: cli };
    }
    // Check dotnet project
    const csproj = 'E:\\15. Other\\AgentMemoryEngine\\src\\AgentMemoryEngine.Cli';
    if (fs.existsSync(csproj)) {
      return { available: true, mode: 'dotnet', csproj };
    }
    return { available: false, reason: 'Neither AME IPC pipe nor CLI binary found' };
  }
}

/**
 * Formats a Q&A item into an AME cognitive payload with full-text searchable tokens and metadata header.
 */
function serializePayload(qa) {
  const tagsStr = (qa.tags || []).join(', ');
  const projectStr = qa.project || 'global';
  const question = qa.question || '';
  const answer = qa.answer_context || qa.answer || '';
  const metaJson = JSON.stringify({
    q: question,
    a: answer,
    tags: qa.tags || [],
    project: projectStr,
    useful_count: qa.useful_count || 0,
    confidence: qa.confidence_score || 1.0,
    source: qa.source || 'auto'
  });

  return `[QUESTION]\n${question}\n\n[ANSWER]\n${answer}\n\n[METADATA]\nTags: ${tagsStr} | Project: ${projectStr}\n\n<!-- AME_JSON:${metaJson} -->`;
}

/**
 * Deserializes an AME payload back into a structured Q&A object.
 */
function deserializePayload(rawPayload, memoryId, score) {
  if (!rawPayload) {
    return { id: memoryId, question: '', answer_context: '', tags: [], project: 'global', final_score: score, max_db_score: score };
  }

  // 1. Direct JSON (from imported jsonl or raw JSON payloads)
  try {
    const directObj = JSON.parse(rawPayload);
    if (directObj && (directObj.question || directObj.answer_context)) {
      const projTag = Array.isArray(directObj.tags) ? directObj.tags.find(t => t.startsWith('project:')) : null;
      return {
        id: memoryId,
        question: directObj.question || '',
        answer_context: directObj.answer_context || '',
        tags: Array.isArray(directObj.tags) ? directObj.tags : [],
        project: directObj.project || (projTag ? projTag.replace('project:', '') : 'global'),
        useful_count: directObj.useful_count || directObj.hit_count || 0,
        confidence_score: directObj.confidence_score !== undefined ? directObj.confidence_score : 1.0,
        final_score: score,
        max_db_score: score
      };
    }
  } catch {}

  const jsonMatch = rawPayload.match(/<!-- AME_JSON:(.+?) -->/);
  if (jsonMatch) {
    try {
      const meta = JSON.parse(jsonMatch[1]);
      return {
        id: memoryId,
        question: meta.q,
        answer_context: meta.a,
        tags: meta.tags,
        project: meta.project,
        useful_count: meta.useful_count,
        confidence_score: meta.confidence,
        final_score: score,
        max_db_score: score
      };
    } catch {
      // Fallback to text parsing
    }
  }

  // Fallback text parsing
  const qMatch = rawPayload.match(/\[QUESTION\]\n([\s\S]*?)(?=\n\n\[ANSWER\]|$)/);
  const aMatch = rawPayload.match(/\[ANSWER\]\n([\s\S]*?)(?=\n\n\[METADATA\]|$)/);
  const tagsMatch = rawPayload.match(/Tags:\s*([^|\n]+)/);

  return {
    id: memoryId,
    question: qMatch ? qMatch[1].trim() : rawPayload.substring(0, 100),
    answer_context: aMatch ? aMatch[1].trim() : rawPayload,
    tags: tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [],
    project: 'global',
    useful_count: 1,
    confidence_score: 1.0,
    final_score: score,
    max_db_score: score
  };
}

/**
 * Queries cognitive memory using AME (Single-Pass Fused SIMD Search).
 */
async function queryContext(taskDescription, options = {}) {
  const topK = options.limit || 8;
  const minScore = options.minSimilarity || 0.15;
  const project = options.project || null;
  const tags = options.tags || [];

  const dbPath = resolveProjectDb(project);
  ensureDbExists(dbPath);

  let rawResults = [];

  // 1. Try Named Pipe IPC
  try {
    const res = await ipcCall('query_fused', {
      query: taskDescription,
      topK,
      minScore
    }, 1500);
    rawResults = res?.results || [];
  } catch {
    // 2. Fallback CLI execution
    const cli = resolveCliPath();
    if (cli) {
      try {
        const out = execFileSync(cli, [
          'query',
          dbPath,
          taskDescription,
          '--top',
          topK.toString(),
          '--min-score',
          minScore.toString(),
          '--json'
        ], { encoding: 'utf-8', timeout: 15000 });
        rawResults = JSON.parse(out);
      } catch (e) {
        rawResults = [];
      }
    }
  }

  // 3. Deserialize and map to SemanticBrain QA format
  const rows = [];
  for (const r of rawResults) {
    const item = deserializePayload(r.payload, r.memoryId, r.compositeScore);

    // Optional tag filtering in memory if tags specified
    if (tags && tags.length > 0 && item.tags && item.tags.length > 0) {
      const hasIntersection = tags.some(t => item.tags.includes(t));
      if (!hasIntersection) {
        // Lower score slightly if tag didn't match, or skip if strict
        item.final_score *= 0.85;
      }
    }

    // Optional project filtering
    if (project && item.project && item.project !== 'global' && item.project !== project) {
      continue;
    }

    rows.push(item);
  }

  return rows;
}

/**
 * Saves or updates a Q&A lesson into the AME cognitive database.
 */
async function saveQA(question, answer, options = {}) {
  const project = options.project || null;
  const dbPath = options.dbPath ? path.resolve(options.dbPath) : resolveProjectDb(project);
  ensureDbExists(dbPath);

  const payload = serializePayload({
    question,
    answer_context: answer,
    tags: options.tags || [],
    project: project || 'global',
    confidence_score: options.confidence !== undefined ? options.confidence : 1.0,
    source: options.source || 'auto'
  });

  const tier = options.tier || 'Episodic';
  const importance = options.importance || 80;
  const confidence = options.confidence !== undefined ? Math.round(options.confidence * 100) : 100;

  // 1. Try IPC
  try {
    const res = await ipcCall('harvest', {
      payload,
      tier,
      importance,
      confidence
    }, 2000);
    return { success: true, memoryId: res?.memoryId || 1, backend: 'ame-ipc' };
  } catch {
    // 2. Fallback CLI
    const cli = resolveCliPath();
    if (cli) {
      execFileSync(cli, [
        'post',
        dbPath,
        payload,
        '--tier',
        tier,
        '--importance',
        importance.toString(),
        '--confidence',
        confidence.toString(),
        '--json'
      ], { encoding: 'utf-8', timeout: 15000 });
      return { success: true, memoryId: 1, backend: 'ame-cli' };
    }
  }

  throw new Error('Could not persist to AME: both IPC and CLI unavailable');
}

/**
 * Views a single Q&A record by its memory ID.
 */
async function viewQA(memoryId, options = {}) {
  const project = options.project || null;
  const dbPath = resolveProjectDb(project);
  ensureDbExists(dbPath);

  // 1. Try IPC
  try {
    const res = await ipcCall('view', { memoryId }, 1500);
    if (res && res.payload) {
      const item = deserializePayload(res.payload, res.memoryId, 1.0);
      item.tier = res.tier;
      item.importance = res.importance;
      item.confidence_score = (res.confidence || 100) / 100;
      item.hit_count = res.accessFrequency || 1;
      return item;
    }
  } catch {
    // 2. Fallback CLI
    const cli = resolveCliPath();
    if (cli) {
      try {
        const out = execFileSync(cli, [
          'view',
          dbPath,
          memoryId.toString(),
          '--json'
        ], { encoding: 'utf-8', timeout: 10000 });
        const res = JSON.parse(out);
        if (res && res.payload) {
          const item = deserializePayload(res.payload, res.memoryId, 1.0);
          item.tier = res.tier;
          item.importance = res.importance;
          item.confidence_score = (res.confidence || 100) / 100;
          item.hit_count = res.accessFrequency || 1;
          return item;
        }
      } catch (e) {
        return null;
      }
    }
  }

  return null;
}

module.exports = {
  isAmeAvailable,
  queryContext,
  saveQA,
  viewQA,
  resolveProjectDb,
  ensureDbExists,
  resolveCliPath,
  serializePayload,
  deserializePayload
};
