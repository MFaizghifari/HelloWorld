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

// Google Drive: folders, files, sharing (enough for uploads and media).
function fakeDrive() {
  const files = {};
  const folders = {};
  let n = 0;
  const makeFolder = (name) => {
    const id = `fold${++n}`;
    const f = {
      name, viewers: [], children: [],
      getId: () => id,
      getFoldersByName: (nm) => { const hit = f.children.filter((c) => c.name === nm); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; },
      createFolder: (nm) => { const c = makeFolder(nm); f.children.push(c); return c; },
      createFile: (blob) => {
        const fid = `file${++n}`;
        const file = { blob, sharing: null, trashed: false, getId: () => fid, getUrl: () => `https://drive.google.com/file/d/${fid}/view`, setSharing(a, p) { file.sharing = [a, p]; }, setTrashed(t) { file.trashed = t; } };
        files[fid] = file;
        return file;
      },
      getViewers: () => f.viewers.map((e) => ({ getEmail: () => e })),
      getEditors: () => [],
      addViewers(list) { f.viewers.push(...list); },
    };
    folders[id] = f;
    return f;
  };
  const root = makeFolder('root');
  return {
    files, folders,
    api: {
      getRootFolder: () => root, getFolderById: (id) => folders[id], getFileById: (id) => files[id],
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
    },
  };
}

function makeEnv() {
  const files = {};
  const drive = fakeDrive();
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
      // Apps Script byte arrays are signed.
      base64Decode: (s) => [...Buffer.from(s, 'base64')].map((b) => (b > 127 ? b - 256 : b)),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      formatDate: (d) => d.toISOString().slice(0, 10).replace(/-/g, ''),
    },
    UrlFetchApp: { fetchAll: (reqs) => { fetched.push(...reqs); return reqs.map(() => ({ getResponseCode: () => 200, getContentText: () => '' })); } },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail() {} },
    DriveApp: drive.api,
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return { ctx, props, files, fetched, post, drive };
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
  const formSS = Object.values(env.files).find((f) => f.title === 'Belajarlagi Form — Tes');
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

test('Apps Script: unfinished responses go to "Belum selesai" and are removed on submit', () => {
  const env = makeEnv();
  env.ctx.setup();
  const key = env.props.ADMIN_KEY;
  const f = { ...JSON.parse(JSON.stringify(form)), id: 'f_part01', title: 'Partial', recovery: { partials: true } };
  assert.equal(env.post({ action: 'saveForm', key, form: f }).ok, true);
  const ss = Object.values(env.files).find((x) => x.title === 'Belajarlagi Form — Partial');

  env.post({ action: 'event', formId: f.id, type: 'partial', sessionId: 's_a1', path: ['q_name1', 'q_mail1'], answers: { q_name1: '=Faiz', q_mail1: 'faiz@mail.com' }, hidden: { utm_source: 'ig' } });
  env.post({ action: 'event', formId: f.id, type: 'abandon', sessionId: 's_a1', path: ['q_name1', 'q_mail1', 'q_phon1'], answers: { q_name1: '=Faiz', q_mail1: 'faiz@mail.com', q_phon1: '0812 3456 7890' } });
  env.post({ action: 'event', formId: f.id, type: 'partial', sessionId: 's_a2', path: ['q_name1'], answers: { q_name1: 'No contact' } });
  const sh = ss.getSheetByName('Belum selesai');
  assert.equal(sh.getLastRow(), 2, 'one row per session, only with a contact');
  assert.equal(sh.data[1][2], "'=Faiz", 'formula injection neutralised');
  assert.equal(sh.data[1][4], '0812 3456 7890', 'updated in place by the later event');

  const res = env.post({ action: 'getResults', key, formId: f.id, days: 30 });
  assert.equal(res.partials.length, 1);
  assert.equal(res.partials[0].contact.email, 'faiz@mail.com');
  assert.equal(res.partials[0].lastQuestion, 'q_phon1');

  env.post({ action: 'submit', formId: f.id, answers: { q_name1: 'Faiz' }, meta: { sessionId: 's_a1', path: ['q_name1'] } });
  assert.equal(sh.getLastRow(), 1, 'deleted after submit');
});

test('Apps Script: uploads land in Drive, are checked by content, tied to the visit, and pruned if never submitted', () => {
  const env = makeEnv();
  env.ctx.setup();
  const key = env.props.ADMIN_KEY;
  const f = {
    id: 'f_upl001', title: 'Beasiswa', integrations: { sheetEditors: 'tim@belajarlagi.id' },
    questions: [{ id: 'q_name1', type: 'short_text', title: 'Nama' }, { id: 'q_ktm01', type: 'file_upload', title: 'KTM', settings: { fileKind: 'image', maxSizeMb: 1 } }],
    experiment: { id: 'x_real01', status: 'running' }, variants: { B: { questions: [{ id: 'q_name1', type: 'short_text', title: 'Nama' }] } },
  };
  assert.equal(env.post({ action: 'saveForm', key, form: f }).ok, true);
  const ss = Object.values(env.files).find((x) => x.title === 'Belajarlagi Form — Beasiswa');
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]).toString('base64');
  const up = env.post({ action: 'upload', formId: f.id, questionId: 'q_ktm01', sessionId: 's_u1', name: 'ktm.png', type: 'image/png', data: png });
  assert.equal(up.ok, true, up.error);
  assert.match(up.file.ref, /^drive:file\d+$/);
  const folder = Object.values(env.drive.folders).find((x) => x.name === 'Beasiswa (f_upl001)');
  assert.deepEqual(folder.viewers, ['tim@belajarlagi.id'], 'shared with the team, not public');
  const html = Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.match(env.post({ action: 'upload', formId: f.id, questionId: 'q_ktm01', sessionId: 's_u1', name: 'x.png', data: html }).error, /tidak diterima/);

  assert.match(env.post({ action: 'submit', formId: f.id, answers: { q_ktm01: [up.file] }, meta: { sessionId: 's_other' } }).error, /tidak ditemukan/);
  const sub = env.post({ action: 'submit', formId: f.id, answers: { q_name1: 'Ayu', q_ktm01: [{ ...up.file, name: 'palsu.exe' }] }, meta: { sessionId: 's_u1', device: 'mobile', source: 'IG', variant: 'x_real01:A' } });
  assert.equal(sub.ok, true, sub.error);
  const row = ss.getSheetByName('Responses').data[1];
  const fileId = up.file.ref.slice(6);
  assert.ok(row.includes(`ktm.png (https://drive.google.com/file/d/${fileId}/view)`), 'server-side name, Drive link');
  assert.ok(row.includes('mobile') && row.includes('ig') && row.includes('x_real01:A'));
  assert.equal(ss.getSheetByName('Uploads').data[1][7], sub.responseId, 'attached to the response');

  const res = env.post({ action: 'getResults', key, formId: f.id, days: 30 });
  assert.deepEqual(res.responses[0].answers.q_ktm01, [{ ref: up.file.ref, name: 'ktm.png', url: `https://drive.google.com/file/d/${fileId}/view` }]);
  assert.equal(res.responses[0].meta.device, 'mobile');

  // An upload from a visit that never submitted is trashed after a day.
  const late = env.post({ action: 'upload', formId: f.id, questionId: 'q_ktm01', sessionId: 's_gone', name: 'b.png', data: png });
  ss.getSheetByName('Uploads').data[2][0] = new Date(Date.now() - 2 * 86400000);
  env.ctx.pruneOldEvents();
  assert.equal(env.drive.files[late.file.ref.slice(6)].trashed, true);
  assert.equal(env.drive.files[fileId].trashed, false);

  // Builder images are shared by link so respondents can see them.
  const media = env.post({ action: 'media', key, formId: f.id, name: 'logo.png', data: png });
  assert.match(media.url, /^https:\/\/drive\.google\.com\/thumbnail\?id=file\d+&sz=w2000$/);
  assert.equal(env.post({ action: 'media', key: 'wrong', formId: f.id, name: 'logo.png', data: png }).ok, false);

  // A daily byte budget per form protects the Drive quota.
  env.props.UPLOAD_DAILY_MB = String(30 / 1024 / 1024); // 30 bytes; 24 already used today, this file is 12
  assert.match(env.post({ action: 'upload', formId: f.id, questionId: 'q_ktm01', sessionId: 's_u9', name: 'c.png', data: png }).error, /penuh/);
});

test('Apps Script: events carry device / source / A-B variant; forged variants are dropped', () => {
  const env = makeEnv();
  env.ctx.setup();
  const key = env.props.ADMIN_KEY;
  const f = { ...JSON.parse(JSON.stringify(form)), id: 'f_dim001', title: 'Dim', experiment: { id: 'x_real01', status: 'running' }, variants: { B: { questions: form.questions } } };
  env.post({ action: 'saveForm', key, form: f });
  env.post({ action: 'event', formId: f.id, type: 'view', sessionId: 's_1', device: 'mobile', source: 'Facebook', variant: 'x_real01:B' });
  env.post({ action: 'event', formId: f.id, type: 'view', sessionId: 's_2', device: 'toaster', source: 'x', variant: 'x_fake01:B' });
  const res = env.post({ action: 'getResults', key, formId: f.id, days: 30 });
  assert.deepEqual(res.events.map((e) => [e.device, e.source, e.variant]), [['mobile', 'facebook', 'x_real01:B'], ['', 'x', '']]);
});
