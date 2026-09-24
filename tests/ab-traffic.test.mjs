import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleSizePerVariant, compareVariants, normCdf, assignVariant, MIN_DAYS } from '../app/js/ab.js';
import { deviceOf, sourceOf, cleanSource, DIRECT } from '../app/js/traffic.js';
import { variantForm, allQuestions, experimentRunning, variantTag, answerText, fileRules, validateAnswer } from '../app/js/logic.js';

test('sample size matches the standard two-proportion formula (Evan Miller\'s calculator)', () => {
  assert.equal(sampleSizePerVariant(0.5, 0.05), 1565);
  assert.equal(sampleSizePerVariant(0.3, 0.05), 1377);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normCdf(-1) - 0.158655) < 1e-5);
});

test('verdict waits for the planned sample and a full week, then calls the winner', () => {
  const small = compareVariants({ views: 150, completions: 78 }, { views: 150, completions: 92 }, { days: 12 });
  assert.equal(small.verdict, 'collecting');
  assert.ok(small.probBBetter > 0.9 && small.probBBetter < 0.97);
  assert.ok(small.ci[0] < 0 && small.ci[1] > 0, 'interval still includes zero');

  const big = { a: { views: 2000, completions: 1000 }, b: { views: 2000, completions: 1120 } };
  assert.equal(compareVariants(big.a, big.b, { days: MIN_DAYS - 1 }).verdict, 'collecting', 'not before a full week');
  const done = compareVariants(big.a, big.b, { days: 10 });
  assert.deepEqual([done.verdict, done.winner], ['winner', 'B']);
  assert.ok(done.pValue < 0.001);

  const flat = compareVariants({ views: 2000, completions: 1000 }, { views: 2000, completions: 1010 }, { days: 10 });
  assert.equal(flat.verdict, 'no-difference');
  assert.equal(compareVariants({ views: 0, completions: 0 }, { views: 0, completions: 0 }).pValue, 1);
});

test('assignment follows the split', () => {
  let n = 0;
  let x = 0;
  const rand = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  for (let i = 0; i < 10000; i++) if (assignVariant(30, rand) === 'B') n++;
  assert.ok(Math.abs(n / 10000 - 0.3) < 0.02, `${n}`);
  assert.equal(assignVariant(0, () => 0), 'A');
  assert.equal(assignVariant(100, () => 0.999), 'B');
});

test('device and source classification', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 [FBAN/FBIOS]'), 'mobile');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 Chrome/128 Safari/537.36'), 'tablet');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17 Safari/605.1.15', { touchPoints: 5 }), 'tablet', 'iPadOS');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128'), 'desktop');
  assert.equal(sourceOf({ utm_source: ' IG ' }), 'instagram');
  assert.equal(sourceOf({ fbclid: 'abc' }), 'meta');
  assert.equal(sourceOf({}, 'https://l.facebook.com/l.php?u=x'), 'facebook');
  assert.equal(sourceOf({}, 'https://www.google.co.id/'), 'google');
  assert.equal(sourceOf({}, 'https://belajarlagi.id/kelas'), 'belajarlagi.id');
  assert.equal(sourceOf({}, ''), DIRECT);
  assert.equal(cleanSource('ig_story/2<b>'), 'ig_story-2-b-');
});

test('variants: B replaces the screens, everything else is shared', () => {
  const form = {
    id: 'f_ab0001', title: 'T', tracking: { fbPixelId: '1' },
    questions: [{ id: 'q_a1', type: 'short_text', title: 'Nama' }],
    variants: { B: { questions: [{ id: 'q_a1', type: 'short_text', title: 'Siapa namamu?' }, { id: 'q_b2', type: 'email', title: 'Email' }], welcome: { title: 'Halo B' } } },
    experiment: { id: 'x_ab0001', status: 'running', split: 50 },
  };
  const b = variantForm(form, 'B');
  assert.equal(b.questions.length, 2);
  assert.equal(b.welcome.title, 'Halo B');
  assert.equal(b.tracking, form.tracking);
  assert.equal(variantForm(form, 'A'), form);
  assert.deepEqual(allQuestions(form).map((q) => q.id), ['q_a1', 'q_b2']);
  assert.equal(allQuestions(form)[0].title, 'Nama', 'A wins for shared ids');
  assert.equal(experimentRunning(form), true);
  assert.equal(experimentRunning({ ...form, experiment: { ...form.experiment, status: 'paused' } }), false);
  assert.equal(variantTag(form, 'x_ab0001', 'B'), 'x_ab0001:B');
  assert.equal(variantTag(form, 'x_old999', 'B'), '', 'stale experiment');
  assert.equal(variantTag(form, 'x_ab0001', 'C'), '');
});

test('file answers: rules, validation, text form', () => {
  const q = { type: 'file_upload', settings: { fileKind: 'pdf', maxSizeMb: 99, maxFiles: 0 } };
  assert.deepEqual([fileRules(q).maxMb, fileRules(q).maxFiles], [25, 1], 'capped at 25 MB, at least 1 file');
  const f = { ref: 'u/f_x/1', name: 'cv.pdf', type: 'application/pdf', size: 2000, url: 'https://x/f/u/f_x/1' };
  assert.equal(validateAnswer(q, [f]), null);
  assert.match(validateAnswer(q, [f, f]), /Maksimal 1 file/);
  assert.match(validateAnswer(q, [{ ...f, type: 'image/png' }]), /tidak diterima/);
  assert.match(validateAnswer(q, 'cv.pdf'), /tidak valid/);
  assert.equal(answerText([f]), 'cv.pdf (https://x/f/u/f_x/1)');
});
