const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTrustLevel, trustRank, TRUST_LEVELS } = require('../core/trust');

test('seed/manual sources are verified facts', () => {
  assert.equal(normalizeTrustLevel(undefined, { source: 'seed' }), 'verified_fact');
  assert.equal(normalizeTrustLevel(undefined, { source: 'manual' }), 'verified_fact');
});

test('agent writes default to observation', () => {
  assert.equal(normalizeTrustLevel(undefined, { source: 'agent-direct' }), 'observation');
  assert.equal(normalizeTrustLevel(undefined, { source: 'agent-harvest', evidence: ['test:1'] }), 'hypothesis');
});

test('verified_fact requires evidence or a verifier', () => {
  assert.equal(normalizeTrustLevel('verified_fact', { source: 'agent' }), 'hypothesis');
  assert.equal(normalizeTrustLevel('verified_fact', { source: 'agent', evidence: ['build:ok'] }), 'verified_fact');
  assert.equal(normalizeTrustLevel('verified_fact', { source: 'agent', verifier: 'build' }), 'verified_fact');
});

test('user_decision is explicit and user-sourced', () => {
  assert.equal(normalizeTrustLevel('user_decision', { source: 'user' }), 'user_decision');
  assert.equal(normalizeTrustLevel('user_decision', { source: 'agent-direct' }), 'hypothesis');
});

test('trust rank ordering is stable', () => {
  assert.equal(TRUST_LEVELS.length, 5);
  assert.ok(trustRank('user_decision') > trustRank('verified_fact'));
  assert.ok(trustRank('verified_fact') > trustRank('inference'));
  assert.ok(trustRank('inference') > trustRank('hypothesis'));
  assert.ok(trustRank('hypothesis') > trustRank('observation'));
});
