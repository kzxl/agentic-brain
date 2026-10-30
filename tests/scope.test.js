const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveScope } = require('../core/scope');

test('explicit global wins', () => {
  const r = resolveScope({ explicitScope: 'global', project: 'erp', content: 'MDS inventory' });
  assert.equal(r.scope, 'global');
  assert.equal(r.origin, 'explicit');
});

test('explicit project requires project context', () => {
  const r = resolveScope({ explicitScope: 'project', project: null, content: 'generic note' });
  assert.equal(r.scope, 'global');
  assert.match(r.reason, /without project context/);
});

test('project-specific identifier stays project', () => {
  const r = resolveScope({
    project: 'erp',
    content: 'Fix deadlock in MDS InventoryService under Features/Inventory',
  });
  assert.equal(r.scope, 'project');
  assert.equal(r.candidate, null);
  assert.equal(r.reviewStatus, 'none');
});

test('generic lesson inside a project becomes a global candidate', () => {
  const r = resolveScope({
    project: 'erp',
    content: 'Use async/await instead of blocking calls in JavaScript services',
  });
  assert.equal(r.scope, 'project');
  assert.equal(r.candidate, 'global');
  assert.equal(r.reviewStatus, 'pending');
});

test('no project context stays global even for project-like text', () => {
  const r = resolveScope({ project: null, content: 'Fix MDS InventoryService deadlock' });
  assert.equal(r.scope, 'global');
  assert.match(r.reason, /without project context/);
});

test('normalizer global hint inside a project is queued, not published', () => {
  const r = resolveScope({
    project: 'erp',
    content: 'A reusable pattern',
    scopeHint: 'global',
    scopeHintConfidence: 0.9,
  });
  assert.equal(r.scope, 'project');
  assert.equal(r.candidate, 'global');
  assert.equal(r.reviewStatus, 'pending');
});

test('normalizer global hint without project publishes global', () => {
  const r = resolveScope({ project: null, content: 'A reusable pattern', scopeHint: 'global' });
  assert.equal(r.scope, 'global');
  assert.equal(r.reviewStatus, 'none');
});
