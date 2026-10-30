const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../core/config');
const { qaRankingQuery } = require('../core/queries');
const { normalizeTags, inferTags } = require('../core/keywords');

test('Phase 0 defaults are safe', () => {
  assert.equal(config.backend, 'postgres');
  assert.equal(config.ame.write, false);
  assert.equal(config.server.host, '127.0.0.1');
  assert.ok(config.server.maxBodyBytes > 0);
});

test('ranking query enforces project scope', () => {
  const qq = qaRankingQuery({ limit: 3, project: 'demo' });
  assert.match(qq.text, /\$5::text = project_id OR scope = 'global'|project_id = \$5::text OR scope = 'global'/);
  assert.match(qq.text, /COALESCE\(chunk_type, 'atom'\) = 'atom'/);
  const params = qq.params(['a'], '[]', ['tech:ua'], 'query', 'demo');
  assert.deepEqual(params, ['[]', ['tech:ua'], 'query', 3, 'demo', false, 100]);
});

test('missing project defaults to global-only', () => {
  const qq = qaRankingQuery({ limit: 3 });
  assert.match(qq.text, /scope = 'global'/);
  assert.doesNotMatch(qq.text, /\$5::text IS NULL OR/);
  const params = qq.params([], '[]', null, 'query');
  assert.equal(params.length, 7);
  assert.equal(params[4], null);
  assert.equal(params[5], false);
});

test('all-projects is explicit', () => {
  const qq = qaRankingQuery({ limit: 3, allProjects: true });
  assert.match(qq.text, /\$6::boolean = true/);
  const params = qq.params([], '[]', null, 'query');
  assert.equal(params.length, 7);
  assert.equal(params[5], true);

  // Even if a project is supplied, all-projects wins.
  const both = qaRankingQuery({ limit: 3, project: 'demo', allProjects: true });
  const bothParams = both.params([], '[]', null, 'query', 'demo');
  assert.equal(bothParams.length, 7);
  assert.equal(bothParams[5], true);
});

test('ranking query clamps limit and minSimilarity', () => {
  const qq = qaRankingQuery({ limit: 9999, minSimilarity: 5 });
  const params = qq.params([], '[]', null, 'q', null);
  assert.equal(params[3], 100);
  assert.equal(params[6], 100);
  assert.match(qq.text, /vector_similarity > 1 OR/);
});

test('tag normalization keeps project scope explicit', () => {
  assert.deepEqual(normalizeTags(['inventory', 'project:erp']), ['domain:inventory', 'project:erp']);
  const tags = inferTags('Fix inventory deadlock', 'Use a composite index', ['project:erp']);
  assert.ok(tags.includes('project:erp'));
  assert.ok(tags.includes('domain:inventory'));
});
