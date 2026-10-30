const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKnowledge, validateAtoms } = require('../core/normalizer');

test('structured input yields one atom', async () => {
  const { atoms } = await normalizeKnowledge({
    text: 'Deadlock on commit | Missing composite index | Add index and sort lock order',
    structured: true,
  });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].question, 'Deadlock on commit');
  assert.match(atoms[0].answer, /Missing composite index/);
});

test('extractor output is validated and deduplicated', async () => {
  const extractor = async () => [
    {
      question: 'How to avoid deadlock in inventory service?',
      answer: 'Use Task instead of .Result and order lock acquisition consistently.',
      scope_hint: 'project',
      tags: ['inventory', 'async'],
      evidence: ['InventoryService.cs:42'],
    },
    {
      question: 'How to avoid deadlock in inventory service?',
      answer: 'Duplicate question should be dropped.',
      scope_hint: 'project',
    },
    {
      question: 'When should a DTO replace loose parameters?',
      answer: 'Use a DTO when the parameter set is a stable contract shared by layers.',
      scope_hint: 'global',
    },
  ];

  const { atoms } = await normalizeKnowledge({
    text: 'long session text '.repeat(60),
  }, { extractor });

  assert.equal(atoms.length, 2);
  assert.equal(atoms[0].scopeHint, 'project');
  assert.equal(atoms[1].scopeHint, 'global');
});

test('long input with no extracted atoms is rejected', async () => {
  await assert.rejects(
    () => normalizeKnowledge({ text: 'x'.repeat(700) }, { extractor: async () => [] }),
    /no atomic lesson extracted/
  );
});

test('long answer is rejected', () => {
  assert.throws(
    () => validateAtoms([{ question: 'A valid atomic question?', answer: 'x'.repeat(2000) }]),
    /exceeds 1500/
  );
});

test('short input falls back to one atom when extractor is unavailable', async () => {
  const text = 'A short note about a deadlock fix that uses Task instead of Result.';
  const { atoms } = await normalizeKnowledge(
    { text },
    { extractor: async () => { throw new Error('LLM offline'); } }
  );
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].answer, text);
});

test('too-short input is rejected', async () => {
  await assert.rejects(
    () => normalizeKnowledge({ text: 'short' }),
    /at least 40 characters/
  );
});
