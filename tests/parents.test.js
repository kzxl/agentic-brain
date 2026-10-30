const test = require('node:test');
const assert = require('node:assert/strict');
const { attachParents } = require('../core/parents');

test('attachParents fetches the parent document for atoms', async () => {
  let captured = null;
  const db = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ id: 1, question: 'Parent doc', answer_context: 'Parent body' }] };
    },
  };

  const rows = await attachParents([
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: null },
  ], db);

  assert.equal(rows[0].parent.id, 1);
  assert.equal(rows[0].parent.question, 'Parent doc');
  assert.equal(rows[1].parent, null);
  assert.deepEqual(captured.params[0], [1]);
});

test('attachParents skips the query when no parent ids exist', async () => {
  let called = false;
  const db = { query: async () => { called = true; return { rows: [] }; } };
  const rows = await attachParents([{ id: 2, parent_id: null }], db);
  assert.equal(called, false);
  assert.equal(rows[0].parent, null);
});

test('attachParents normalizes bigint parent_id strings', async () => {
  const db = {
    query: async () => ({ rows: [{ id: 1, question: 'Parent doc', answer_context: 'Body' }] }),
  };
  const rows = await attachParents([{ id: 2, parent_id: '1' }], db);
  assert.equal(rows[0].parent.id, 1);
});
