/**
 * retrieval-db.js — Execute ranking queries with index-first planning.
 *
 * pgvector's cost model can choose a sequential scan for ANN even when HNSW is
 * dramatically faster. Retrieval queries therefore run in a short transaction
 * with `enable_seqscan=off`; GIN/HNSW indexes are still available.
 */
const pool = require('./db');
const config = require('./config');

async function queryRetrieval(text, params, opts = {}) {
  const forceIndex = opts.forceIndex !== undefined
    ? opts.forceIndex
    : config.retrieval?.forceIndex !== false;

  if (!forceIndex) return pool.query(text, params);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { queryRetrieval };
