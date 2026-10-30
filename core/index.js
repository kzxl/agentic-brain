/**
 * core/index.js - Barrel export for all core modules
 * 
 * Tất cả CLI scripts và server.js require('./core') thay vì require riêng lẻ.
 */
const config = require('./config');
const pool = require('./db');
const { embed, MODEL_DIMS, MODEL_NAME } = require('./embed');
const { askLLM, askWithReasoning, askLocal, askLocalStream, askCloud, DEFAULT_MODEL } = require('./llm-local');
const { extractKeywords, extractRegistryKeywords, DOMAIN_PATTERNS, inferTags, TAG_RULES, normalizeTags } = require('./keywords');
const { callServer, streamServer, isServerUp, PORT: SERVER_PORT } = require('./client');
const { qaRankingQuery, recipeRankingQuery, skillRankingQuery, tokenize } = require('./queries');
const storageAme = require('./storage-ame');
const { captureKnowledge } = require('./knowledge');
const { resolveScope } = require('./scope');
const { normalizeKnowledge, validateAtoms } = require('./normalizer');
const { ingestText } = require('./ingest');

module.exports = {
  config,
  pool,
  embed, MODEL_DIMS, MODEL_NAME,
  askLLM, askWithReasoning, askLocal, askLocalStream, askCloud, DEFAULT_MODEL,
  extractKeywords, extractRegistryKeywords, DOMAIN_PATTERNS, inferTags, TAG_RULES, normalizeTags,
  callServer, streamServer, isServerUp, PORT: SERVER_PORT,
  qaRankingQuery, recipeRankingQuery, skillRankingQuery, tokenize,
  storageAme,
  captureKnowledge,
  resolveScope,
  normalizeKnowledge,
  validateAtoms,
  ingestText,
};
