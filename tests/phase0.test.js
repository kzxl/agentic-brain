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
  assert.equal(config.autoQa, false);
  assert.equal(config.proxyAutoHarvest, false);
});

test('ranking query enforces project scope', () => {
  const qq = qaRankingQuery({ limit: 3, project: 'demo' });
  assert.match(qq.text, /\('project:' \|\| \$5::text\) = ANY\(tags\) OR 'project:global' = ANY\(tags\)/);
  const params = qq.params(['a'], '[]', ['tech:ua'], 'query', 'demo');
  assert.deepEqual(params, ['[]', ['tech:ua'], 'query', 3, 'demo']);
});

test('missing project defaults to global-only', () => {
  const qq = qaRankingQuery({ limit: 3 });
  assert.match(qq.text, /'project:global' = ANY\(tags\)/);
  assert.doesNotMatch(qq.text, /\$5::text/);
  assert.equal(qq.params([], '[]', null, 'query').length, 4);
});

test('all-projects is explicit', () => {
  const qq = qaRankingQuery({ limit: 3, allProjects: true });
  assert.match(qq.text, /AND TRUE/);
  assert.equal(qq.params([], '[]', null, 'query').length, 4);
});

test('ranking query clamps limit and minSimilarity', () => {
  const qq = qaRankingQuery({ limit: 9999, minSimilarity: 5 });
  const params = qq.params([], '[]', null, 'q', null);
  assert.equal(params[3], 100);
  assert.match(qq.text, /vector_similarity > 1 OR/);
});

test('tag normalization keeps project scope explicit', () => {
  assert.deepEqual(normalizeTags(['inventory', 'project:erp']), ['domain:inventory', 'project:erp']);
  const tags = inferTags('Fix inventory deadlock', 'Use a composite index', ['project:erp']);
  assert.ok(tags.includes('project:erp'));
  assert.ok(tags.includes('domain:inventory'));
});
