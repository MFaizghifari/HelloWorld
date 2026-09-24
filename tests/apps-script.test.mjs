// Runs apps-script/Code.gs against in-memory fakes of the Apps Script services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

function fakeSheet(name) {
  const data = []; // 2D array, 1-indexed access via helpers
  const notes = {};
  const sheet = {
    name,
    data,
    setName(n) { sheet.name = n; return sheet; },
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    appendRow(row) { data.push([...row]); return sheet; },
    setFrozenRows() {},
    deleteRow(r) { data.splice(r - 1, 1); },
    deleteRows(r, n) { data.splice(r - 1, n); },
    getRange(row, col, nr = 1, nc = 1) {
      const range = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => data[row - 1 + i]?.[col - 1 + j] ?? '')),
        setValues(vals) {
          vals.forEach((r, i) => r.forEach((v, j) => {
            while (data.length < row + i) data.push([]);
            data[row - 1 + i][col - 1 + j] = v;
          }));
          return range;
        },
        getValue: () => data[row - 1]?.[col - 1] ?? '',
        setValue(v) { return range.setValues([[v]]); },
        getNotes: () => Array.from({ length: nr }, () => Array.from({ length: nc }, (_, j) => notes[col + j] || '')),
        setNote(n) { notes[col] = n; if (!data[0]) data.push([]); if (data[0][col - 1] === undefined) data[0][col - 1] = ''; return range; },
        setFontWeight: () => range,
        setNumberFormat: () => range,
        clearContent() { for (let j = 0; j < nc; j++) if (data[row - 1]) data[row - 1][col - 1 + j] = ''; return range; },
      };
      return range;
    },
  };
  return sheet;
}

function makeEnv() {
  const files = {};
  const props = {};
  const cache = {};
  const fetched = [];
  let n = 0;
  const createSS = (title) => {
    const id = `ss${++n}`;
    const sheets = [fakeSheet('Sheet1')];
    const ss = {
      title, sheets, editors: [],
      getId: () => id,
      getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit`,
      getSheets: () => sheets,
      getSheetByName: (nm) => sheets.find((s) => s.name === nm) || null,
      insertSheet(nm) { const s = fakeSheet(nm); sheets.push(s); return s; },
      getEditors: () => ss.editors.map((e) => ({ getEmail: () => e })),
      addEditors(list) { ss.editors.push(...list); },
    };
    files[id] = ss;
    return ss;
  };
  const ctx = {
    console,
    SpreadsheetApp: { create: createSS, openById: (id) => files[id] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
    Utilities: {
      getUuid: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_a, s) => [...createHash('sha256').update(s, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    },
    UrlFetchApp: { fetchAll: (reqs) => { fetched.push(...reqs); return reqs.map(() => ({ getResponseCode: () => 200, getContentText: () => '' })); } },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail() {} },
    DriveApp: {},
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return { ctx, props, files, fetched, post };
}

const form = {
  id: 'f_abc123',
  title: 'Tes',
  questions: [
    { id: 'q_name1', type: 'short_text', title: 'Nama' },
    { id: 'q_mail1', type: 'email', title: 'Email' },
    { id: 'q_phon1', type: 'phone', title: 'HP' },
    { id: 'q_pick1', type: 'multiple_choice', title: 'Pilih', options: [{ label: 'A' }, { label: 'B' }] },
  ],
  hiddenFields: ['ref'],
  tracking: { fbPixelId: '1234567890123456', capi: true, fbSubmitEvent: 'Lead' },
  integrations: { webhookUrl: 'https://hook.example.com/x', sheetEditors: 'tim@belajarlagi.id, bad-email' },
};

test('admin gate, save, submit, results, CAPI & webhook', () => {
  const env = makeEnv();
  env.ctx.setup();
  const key = env.props.ADMIN_KEY;
  assert.ok(key);

  assert.equal(env.post({ action: 'saveForm', key: 'wrong', form }).ok, false);
  const saved = env.post({ action: 'saveForm', key, form });
  assert.equal(saved.ok, true, saved.error);
  assert.match(saved.sheetUrl, /docs\.google\.com/);

  // Per-form spreadsheet shared with valid emails only
  const formSS = Object.values(env.files).find((f) => f.title === 'FormFlow — Tes');
  assert.deepEqual(formSS.editors, ['tim@belajarlagi.id']);

  // Public GET hides integrations (webhook URL, editors)
  const pub = env.ctx.doGet({ parameter: { action: 'getForm', id: form.id } });
  assert.equal(pub.ok, true);
  assert.equal(pub.form.integrations, undefined);

  env.props.FB_CAPI_TOKEN = 'TOKEN';
  const sub = env.post({
    action: 'submit', formId: form.id,
    answers: { q_name1: '=cmd()', q_mail1: ' Foo@Example.com ', q_phon1: '0812-3456-7890', q_pick1: ['A', 'B'], q_evil: 'x' },
    hidden: { utm_source: 'ig', ref: 'abc' },
    meta: { sessionId: 's_1', eventId: 'lead.1', path: ['q_name1', 'q_mail1'], durationSec: 42, fbp: 'fb.1.1.2' },
  });
  assert.equal(sub.ok, true, sub.error);

  const resp = formSS.getSheetByName('Responses');
  assert.equal(resp.getLastRow(), 2);
  const row = resp.data[1];
  assert.ok(row.includes("'=cmd()"), 'formula injection neutralised');
  assert.ok(row.includes('A, B'));
  assert.ok(row.includes('ig') && row.includes('abc'));
  assert.ok(!row.includes('x'), 'unknown question ids are dropped');

  const capi = env.fetched.find((r) => r.url.includes('graph.facebook.com'));
  const payload = JSON.parse(capi.payload).data[0];
  assert.equal(payload.event_id, 'lead.1');
  assert.equal(payload.user_data.em[0], createHash('sha256').update('foo@example.com').digest('hex'));
  assert.equal(payload.user_data.ph[0], createHash('sha256').update('6281234567890').digest('hex'));
  assert.ok(env.fetched.some((r) => r.url === 'https://hook.example.com/x'));

  // Honeypot: pretends success, writes nothing
  env.post({ action: 'submit', formId: form.id, hp: 'spam', answers: {}, meta: {} });
  assert.equal(resp.getLastRow(), 2);

  env.post({ action: 'event', formId: form.id, type: 'view', sessionId: 's_1' });
  assert.equal(env.post({ action: 'event', formId: form.id, type: 'bogus' }).ok, false);

  const res = env.post({ action: 'getResults', key, formId: form.id, days: 30 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.responses.length, 1);
  assert.equal(res.responses[0].answers.q_name1, '=cmd()');
  assert.equal(res.responses[0].hidden.ref, 'abc');
  assert.equal(res.responses[0].meta.durationSec, 42);
  assert.deepEqual(res.events.map((e) => e.type).sort(), ['complete', 'view']);

  // Renaming + adding a question keeps old columns aligned (mapping by note, not title)
  const f2 = JSON.parse(JSON.stringify(form));
  f2.questions[0].title = 'Nama lengkap';
  f2.questions.unshift({ id: 'q_new01', type: 'short_text', title: 'Baru' });
  env.post({ action: 'saveForm', key, form: f2 });
  env.post({ action: 'submit', formId: form.id, answers: { q_new01: 'n', q_name1: 'Budi' }, meta: {} });
  const res2 = env.post({ action: 'getResults', key, formId: form.id, days: 30 });
  assert.equal(res2.responses[1].answers.q_name1, 'Budi');
  assert.equal(res2.responses[1].answers.q_new01, 'n');
  assert.ok(resp.data[0].includes('Nama lengkap'));

  assert.equal(env.post({ action: 'listForms', key }).forms.length, 1);
});
