import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, splitMulti, toCSV } from '../app/js/stats.js';

const form = {
  questions: [
    { id: 'a', type: 'short_text', title: 'Nama' },
    { id: 'b', type: 'multiple_choice', title: 'Pilih', options: [{ label: 'X, Y' }, { label: 'Z' }] },
    { id: 'c', type: 'opinion_scale', title: 'NPS', settings: { start: 0, steps: 11 } },
  ],
  hiddenFields: ['utm_source'],
};
const today = new Date('2026-09-24T12:00:00Z');
const ts = '2026-09-23T10:00:00Z';

test('funnel, completion and NPS', () => {
  const events = [
    { ts, sessionId: 's1', type: 'view', path: [], device: 'mobile', source: 'facebook' },
    { ts, sessionId: 's2', type: 'view', path: [], device: 'mobile', source: 'instagram' },
    { ts, sessionId: 's3', type: 'view', path: [], device: 'desktop', source: 'facebook' },
    { ts, sessionId: 's4', type: 'view', path: [], device: 'desktop', source: '(langsung)' },
    { ts, sessionId: 's1', type: 'start', path: ['a'] },
    { ts, sessionId: 's1', type: 'complete', path: ['a', 'b', 'c'] },
    { ts, sessionId: 's2', type: 'start', path: ['a'] },
    { ts, sessionId: 's2', type: 'abandon', path: ['a', 'b'] },
    { ts, sessionId: 's3', type: 'abandon', path: ['a'] },
  ];
  const responses = [
    { submittedAt: ts, answers: { a: 'Faiz', b: 'X, Y, Z', c: 10 }, hidden: { utm_source: 'fb' }, meta: { sessionId: 's1' } },
    // No events for this session (blocked tracker): counted under the segments in its meta.
    { submittedAt: ts, answers: { a: 'Ana', b: 'Z', c: 3 }, hidden: {}, meta: { sessionId: 's9', device: 'tablet', source: 'tiktok' } },
  ];
  const s = computeStats(form, responses, events, { days: 7, today });
  assert.equal(s.views, 4);
  assert.equal(s.starts, 3);
  assert.equal(s.completions, 2);
  assert.equal(s.completionRate, 0.5);
  const fa = s.funnel.find((f) => f.id === 'a');
  const fb = s.funnel.find((f) => f.id === 'b');
  assert.equal(fa.reached, 3);
  assert.equal(fa.droppedHere, 1);
  assert.equal(fb.droppedHere, 1);
  const b = s.perQuestion.find((q) => q.id === 'b');
  assert.deepEqual(b.counts, { 'X, Y': 1, Z: 2 });
  const c = s.perQuestion.find((q) => q.id === 'c');
  assert.equal(c.nps, 0); // 1 promoter, 1 detractor
  assert.deepEqual(s.segments.device, {
    mobile: { views: 2, starts: 2, completions: 1 },
    desktop: { views: 2, starts: 1, completions: 0 },
    tablet: { views: 0, starts: 0, completions: 1 },
  });
  assert.deepEqual(s.segments.source.facebook, { views: 2, starts: 2, completions: 1 });
  assert.deepEqual(s.segments.variant, {});
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily.at(-2).completions, 2);
});

test('splitMulti prefers known labels containing commas', () => {
  assert.deepEqual(splitMulti('X, Y, Z', form.questions[1].options).sort(), ['X, Y', 'Z']);
  assert.deepEqual(splitMulti('lain, dll', []), ['lain', 'dll']);
});

test('CSV neutralises formulas', () => {
  const csv = toCSV(form, [{ submittedAt: ts, responseId: 'r1', answers: { a: '=HYPERLINK("x")' }, hidden: {} }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});
