import test from 'node:test';
import assert from 'node:assert/strict';
import {
  END, nextQuestionId, validateAnswer, evaluateCondition, interpolate, estimatePath, progress, findLogicProblems,
} from '../app/js/logic.js';

const form = {
  questions: [
    { id: 'q_name', type: 'short_text', title: 'Nama', required: true },
    { id: 'q_role', type: 'multiple_choice', title: 'Status', options: [{ label: 'Mahasiswa' }, { label: 'Pemilik bisnis' }],
      logic: [{ match: 'all', conditions: [{ field: 'q_role', op: 'neq', value: 'Pemilik bisnis' }], goto: 'q_nps' }] },
    { id: 'q_size', type: 'number', title: 'Karyawan',
      logic: [{ match: 'any', conditions: [{ field: 'q_size', op: 'lt', value: 1 }, { field: 'utm_source', op: 'eq', value: 'test' }], goto: END }] },
    { id: 'q_nps', type: 'opinion_scale', title: 'NPS', settings: { start: 0, steps: 11 } },
  ],
  hiddenFields: ['utm_source'],
};

test('sequential flow when no rule matches', () => {
  assert.equal(nextQuestionId(form, 'q_name', {}), 'q_role');
  assert.equal(nextQuestionId(form, 'q_role', { q_role: 'Pemilik bisnis' }), 'q_size');
  assert.equal(nextQuestionId(form, 'q_nps', {}), END);
});

test('logic jump skips questions', () => {
  assert.equal(nextQuestionId(form, 'q_role', { q_role: 'Mahasiswa' }), 'q_nps');
  assert.equal(nextQuestionId(form, 'q_size', { q_size: 0 }), END);
  assert.equal(nextQuestionId(form, 'q_size', { q_size: 5 }), 'q_nps');
  // hidden field condition with "any"
  assert.equal(nextQuestionId(form, 'q_size', { q_size: 5, utm_source: 'test' }), END);
});

test('default next overrides sequential order and deleted targets end the form', () => {
  const f = { questions: [{ id: 'a', next: 'c' }, { id: 'b' }, { id: 'c', next: 'gone' }] };
  assert.equal(nextQuestionId(f, 'a', {}), 'c');
  assert.equal(nextQuestionId(f, 'c', {}), END);
});

test('conditions on multi-select arrays and numbers', () => {
  assert.ok(evaluateCondition({ field: 'x', op: 'eq', value: 'b' }, { x: ['a', 'B'] }));
  assert.ok(evaluateCondition({ field: 'x', op: 'contains', value: 'bis' }, { x: ['Pemilik bisnis'] }));
  assert.ok(evaluateCondition({ field: 'x', op: 'not_contains', value: 'z' }, { x: ['a'] }));
  assert.ok(evaluateCondition({ field: 'n', op: 'gte', value: '10' }, { n: 10 }));
  assert.ok(!evaluateCondition({ field: 'n', op: 'gt', value: 'abc' }, { n: 10 }));
  assert.ok(evaluateCondition({ field: 'n', op: 'not_answered' }, {}));
  assert.ok(evaluateCondition({ field: 'n', op: 'answered' }, { n: 0 }));
});

test('validation per type', () => {
  assert.equal(validateAnswer({ type: 'email', required: true }, 'a@b.co'), null);
  assert.ok(validateAnswer({ type: 'email', required: true }, 'a@b'));
  assert.ok(validateAnswer({ type: 'short_text', required: true }, '  '));
  assert.equal(validateAnswer({ type: 'short_text', required: false }, ''), null);
  assert.equal(validateAnswer({ type: 'phone' }, '0812-3456-7890'), null);
  assert.equal(validateAnswer({ type: 'phone' }, '+62 812 3456 7890'), null);
  assert.ok(validateAnswer({ type: 'phone' }, '123'));
  assert.ok(validateAnswer({ type: 'number', settings: { min: 1 } }, 0));
  assert.equal(validateAnswer({ type: 'number', settings: { min: 0 } }, 0), null);
  assert.ok(validateAnswer({ type: 'opinion_scale', settings: { start: 0, steps: 11 } }, 11));
  assert.equal(validateAnswer({ type: 'opinion_scale', settings: { start: 0, steps: 11 } }, 10), null);
  assert.equal(validateAnswer({ type: 'rating', settings: { steps: 5 } }, 5), null);
  assert.equal(validateAnswer({ type: 'date' }, '1995-02-28'), null);
  assert.equal(validateAnswer({ type: 'date' }, '2024-02-29'), null); // leap year
  assert.ok(validateAnswer({ type: 'date' }, '1995-02-31'), 'impossible date');
  assert.ok(validateAnswer({ type: 'date' }, '0000-01-01'));
  const mc = { type: 'multiple_choice', options: [{ label: 'A' }, { label: 'B' }], settings: { multiple: true, maxSelections: 1 } };
  assert.ok(validateAnswer(mc, ['A', 'B']));
  assert.ok(validateAnswer(mc, ['C']));
  assert.equal(validateAnswer(mc, ['A']), null);
});

test('answer piping', () => {
  assert.equal(interpolate('Halo {{q_name}} dari {{hidden:utm_source}}!', { q_name: 'Faiz' }, { utm_source: 'ig' }), 'Halo Faiz dari ig!');
  assert.equal(interpolate('{{q_x}}', { q_x: ['a', 'b'] }), 'a, b');
  assert.equal(interpolate('{{missing}}', {}), '');
});

test('progress follows logic path and survives cycles', () => {
  assert.deepEqual(estimatePath(form, 'q_role', { q_role: 'Mahasiswa' }), ['q_role', 'q_nps']);
  assert.equal(progress(form, ['q_name'], 'q_role', { q_role: 'Mahasiswa' }), 1 / 3);
  const loop = { questions: [{ id: 'a', next: 'b' }, { id: 'b', next: 'a' }] };
  assert.deepEqual(estimatePath(loop, 'a', {}), ['a', 'b']);
  assert.ok(findLogicProblems({ questions: [{ id: 'a', logic: [{ goto: 'a', conditions: [] }] }] }).length);
});
