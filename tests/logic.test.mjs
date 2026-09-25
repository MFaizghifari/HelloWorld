import test from 'node:test';
import assert from 'node:assert/strict';
import {
  END, nextQuestionId, validateAnswer, evaluateCondition, interpolate, estimatePath, progress, findLogicProblems,
  contactFrom, whatsappLink, cleanPartialAnswers,
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

test('contact detection and WhatsApp links for follow-up', () => {
  const f = { questions: [{ id: 'n', type: 'short_text' }, { id: 'e', type: 'email' }, { id: 'p', type: 'phone' }, { id: 'c', type: 'multiple_choice', options: [{ label: 'A' }] }] };
  assert.equal(contactFrom(f, { n: 'Faiz' }), null);
  assert.equal(contactFrom(f, { n: 'Faiz', e: 'nope' }), null);
  assert.deepEqual(contactFrom(f, { n: 'Faiz', p: '0812 3456 7890' }), { email: '', phone: '0812 3456 7890', name: 'Faiz' });
  assert.equal(whatsappLink('0812-3456-7890'), 'https://wa.me/6281234567890');
  assert.equal(whatsappLink('+62 812 3456 7890', 'Halo Faiz'), 'https://wa.me/6281234567890?text=Halo%20Faiz');
  assert.equal(whatsappLink('123'), '');
  assert.deepEqual(cleanPartialAnswers(f, { n: 'Faiz', e: 'bad', c: 'Z', x: 1 }), { n: 'Faiz' });
});

test('custom link names', async () => {
  const { cleanSlug, slugProblem } = await import('../app/js/logic.js');
  assert.equal(cleanSlug('  Beasiswa S2 — Jakarta 2026! '), 'beasiswa-s2-jakarta-2026');
  assert.equal(cleanSlug('Kelas Café'), 'kelas-cafe');
  assert.equal(slugProblem('kelas-excel'), null);
  assert.match(slugProblem('ab'), /minimal/);
  assert.match(slugProblem('dashboard'), /sistem/);
  assert.match(slugProblem('-kelas'), /huruf kecil/);
});
