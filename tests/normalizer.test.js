const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeKnowledge,
  validateAtoms,
  parseIngestPayload,
} = require('../core/normalizer');

test('agent-provided atoms are validated and deduplicated', async () => {
  const { atoms } = await normalizeKnowledge({
    atoms: [
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
    ],
  });

  assert.equal(atoms.length, 2);
  assert.equal(atoms[0].scopeHint, 'project');
  assert.equal(atoms[1].scopeHint, 'global');
});

test('structured input yields one atom', async () => {
  const { atoms } = await normalizeKnowledge({
    text: 'Deadlock on commit | Missing composite index | Add index and sort lock order',
    structured: true,
  });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].question, 'Deadlock on commit');
  assert.match(atoms[0].answer, /Missing composite index/);
});

test('raw walkthrough text requires agent-provided atoms', async () => {
  await assert.rejects(
    () => normalizeKnowledge({ text: 'x'.repeat(700) }),
    /agent must provide atomic JSON atoms/
  );
});

test('too-short question is rejected', () => {
  assert.throws(
    () => validateAtoms([{ question: 'short', answer: 'A long enough answer for validation.' }]),
    /question is shorter/
  );
});

test('long answer is rejected', () => {
  assert.throws(
    () => validateAtoms([{ question: 'A valid atomic question?', answer: 'x'.repeat(2000) }]),
    /exceeds 1500/
  );
});

test('parseIngestPayload accepts array, object, and single atom', () => {
  const atom = {
    question: 'A valid atomic question?',
    answer: 'A long enough answer for validation.',
  };
  assert.equal(parseIngestPayload(JSON.stringify([atom])).atoms.length, 1);
  assert.equal(parseIngestPayload(JSON.stringify({ atoms: [atom] })).atoms.length, 1);
  assert.equal(parseIngestPayload(JSON.stringify(atom)).atoms.length, 1);
});
