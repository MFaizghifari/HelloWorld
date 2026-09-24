// Runs worker/src/index.js against a real SQLite database (node:sqlite) shaped
// like Cloudflare D1, with the real migration applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, createHash } from 'node:crypto';
import worker, { syncSheets, sheetColumns, purgeOldPartials } from '../worker/src/index.js';
import { computeStats } from '../app/js/stats.js';
import { nextQuestionId, END } from '../app/js/logic.js';

// ─── Minimal D1 shim ────────────────────────────────────────────────────────
function d1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../worker/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => (/^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...params) } : { results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

function makeEnv(extra = {}) {
  return { DB: d1(), ADMIN_KEY: 'secret-key', TZ_OFFSET_MINUTES: '0', ...extra };
}

async function api(env, body, { ip = '203.0.113.9', waits = [] } = {}) {
  const req = new Request('https://formflow.test/api', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip } });
  const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  return { status: res.status, ...(await res.json()) };
}

const form = {
  id: 'f_test01',
  title: 'Tes',
  questions: [
    { id: 'q_name', type: 'short_text', title: 'Nama', required: true },
    { id: 'q_mail', type: 'email', title: 'Email' },
    { id: 'q_phone', type: 'phone', title: 'HP' },
    { id: 'q_role', type: 'multiple_choice', title: 'Status', settings: { multiple: true }, options: [{ label: 'Mahasiswa' }, { label: 'Karyawan' }, { label: 'Pemilik bisnis' }],
      logic: [{ match: 'all', conditions: [{ field: 'q_role', op: 'neq', value: 'Pemilik bisnis' }], goto: 'q_nps' }] },
    { id: 'q_size', type: 'number', title: 'Karyawan' },
    { id: 'q_nps', type: 'opinion_scale', title: 'NPS', settings: { start: 0, steps: 11 } },
  ],
  hiddenFields: ['ref'],
  tracking: { fbPixelId: '1234567890123456', capi: true, fbSubmitEvent: 'Lead' },
  integrations: { webhookUrl: 'https://hook.example.com/x' },
};

test('admin gate, public form hides integrations, validation, idempotent submit, CAPI with IP', async () => {
  const env = makeEnv({ FB_CAPI_TOKEN: 'TOKEN' });
  assert.equal((await api(env, { action: 'saveForm', key: 'nope', form })).status, 401);
  const saved = await api(env, { action: 'saveForm', key: 'secret-key', form });
  assert.equal(saved.ok, true, saved.error);

  const pub = await worker.fetch(new Request('https://formflow.test/api?action=getForm&id=f_test01'), env, {});
  const pubBody = await pub.json();
  assert.equal(pubBody.form.integrations, undefined);
  assert.equal(pub.headers.get('Access-Control-Allow-Origin'), '*');

  const bad = await api(env, { action: 'submit', formId: form.id, answers: { q_mail: 'not-an-email' }, meta: {} });
  assert.equal(bad.status, 422);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body }); return new Response('{}', { status: 200 }); };
  try {
    const waits = [];
    const body = {
      action: 'submit', formId: form.id,
      answers: { q_name: '=HACK()', q_mail: 'Foo@Example.com', q_phone: '0812-3456-7890', q_role: ['Mahasiswa'], q_bogus: 'x' },
      hidden: { utm_source: 'ig', ref: 'abc', evil: 'nope' },
      meta: { sessionId: 's_abc123', eventId: 'lead.1', path: ['q_name', 'q_mail', 'q_phone', 'q_role', 'q_nps'], durationSec: 33 },
    };
    const first = await api(env, body, { waits });
    assert.equal(first.ok, true, first.error);
    await Promise.all(waits);
    const again = await api(env, body); // client retry after a lost response
    assert.equal(again.duplicate, true);
    assert.equal(again.responseId, first.responseId);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM responses').get().n, 1);

    const row = env.DB.raw.prepare('SELECT answers, hidden FROM responses').get();
    assert.deepEqual(Object.keys(JSON.parse(row.answers)).sort(), ['q_mail', 'q_name', 'q_phone', 'q_role']);
    assert.deepEqual(JSON.parse(row.hidden), { utm_source: 'ig', ref: 'abc' });

    const capi = calls.find((c) => c.url.includes('graph.facebook.com'));
    const ev = JSON.parse(capi.body).data[0];
    assert.equal(ev.event_id, 'lead.1');
    assert.equal(ev.user_data.client_ip_address, '203.0.113.9');
    assert.equal(ev.user_data.em[0], createHash('sha256').update('foo@example.com').digest('hex'));
    assert.equal(ev.user_data.ph[0], createHash('sha256').update('6281234567890').digest('hex'));
    assert.ok(calls.some((c) => c.url === 'https://hook.example.com/x'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('D1 aggregates match stats computed from raw data (300 simulated sessions)', async () => {
  const env = makeEnv();
  await api(env, { action: 'saveForm', key: 'secret-key', form: { ...form, integrations: {} } });
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const rawEvents = [];
  const rawResponses = [];
  const ts = new Date().toISOString();

  for (let i = 0; i < 300; i++) {
    const sessionId = `s_sim${i}`;
    const hidden = rnd() < 0.5 ? { utm_source: pick(['facebook', 'instagram', 'tiktok']) } : {};
    await api(env, { action: 'event', formId: form.id, type: 'view', sessionId });
    rawEvents.push({ ts, sessionId, type: 'view', path: [] });
    if (rnd() < 0.2) continue; // bounced on the welcome screen

    const answers = {};
    const path = [];
    let q = 'q_name';
    const quitAt = rnd() < 0.4 ? Math.floor(rnd() * 5) : 99;
    let completed = false;
    while (q !== END) {
      if (path.length === quitAt) break;
      path.push(q);
      if (q === 'q_name') answers[q] = `User ${i}`;
      if (q === 'q_mail') answers[q] = `u${i}@mail.com`;
      if (q === 'q_phone') answers[q] = '081234567890';
      if (q === 'q_role') answers[q] = rnd() < 0.3 ? ['Mahasiswa', 'Karyawan'] : [pick(['Mahasiswa', 'Karyawan', 'Pemilik bisnis'])];
      if (q === 'q_size') answers[q] = Math.floor(rnd() * 50);
      if (q === 'q_nps') answers[q] = Math.floor(rnd() * 11);
      if (path.length === 1) {
        await api(env, { action: 'event', formId: form.id, type: 'start', sessionId, path: [...path] });
        rawEvents.push({ ts, sessionId, type: 'start', path: [...path] });
      }
      // Mobile tab switches send extra abandon beacons mid-way; they must not double count.
      if (rnd() < 0.3) {
        await api(env, { action: 'event', formId: form.id, type: 'abandon', sessionId, path: [...path] });
        rawEvents.push({ ts, sessionId, type: 'abandon', path: [...path] });
      }
      q = nextQuestionId(form, q, answers);
      if (q === END) completed = true;
    }
    if (completed) {
      const meta = { sessionId, path, durationSec: 10 + Math.floor(rnd() * 100) };
      const r = await api(env, { action: 'submit', formId: form.id, answers, hidden, meta });
      assert.equal(r.ok, true, r.error);
      rawEvents.push({ ts, sessionId, type: 'complete', path });
      rawResponses.push({ submittedAt: ts, answers, hidden, meta });
    } else {
      await api(env, { action: 'event', formId: form.id, type: 'abandon', sessionId, path });
      rawEvents.push({ ts, sessionId, type: 'abandon', path });
    }
  }

  const res = await api(env, { action: 'getResults', key: 'secret-key', formId: form.id, days: 7 });
  assert.equal(res.ok, true, res.error);
  const cloud = res.stats;
  const local = computeStats(form, rawResponses, rawEvents, { days: 7 });
  for (const k of ['views', 'starts', 'completions', 'medianDurationSec']) assert.equal(cloud[k], local[k], k);
  assert.deepEqual(cloud.funnel, local.funnel);
  assert.deepEqual(cloud.sources, local.sources);
  assert.deepEqual(cloud.daily, local.daily);
  for (const [i, q] of local.perQuestion.entries()) {
    const c = cloud.perQuestion[i];
    assert.equal(c.answered, q.answered, q.id);
    if (q.kind !== 'text') {
      assert.deepEqual(c.counts, q.counts, q.id);
      for (const k of ['avg', 'median', 'min', 'max', 'nps']) assert.equal(c[k], q[k], `${q.id}.${k}`);
    }
  }
  assert.ok(cloud.completions > 50 && cloud.completions < cloud.views, 'simulation produced a realistic mix');
  assert.equal(res.responses.length, 100);
  assert.equal(res.totalResponses, cloud.completions);

  // Paged export returns every row exactly once.
  const seen = new Set();
  let after = null;
  do {
    const page = await api(env, { action: 'exportResponses', key: 'secret-key', formId: form.id, after, limit: 37 });
    page.responses.forEach((r) => seen.add(r.responseId));
    after = page.next;
  } while (after);
  assert.equal(seen.size, cloud.completions);
});

test('Google Sheets sync: header, RAW append, retry after failure, column stability', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const env = makeEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sync@proj.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') });
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0';
  const f = structuredClone(form);
  f.integrations = { sheetUrl };
  assert.equal((await api(env, { action: 'saveForm', key: 'secret-key', form: f })).ok, true);
  await api(env, { action: 'submit', formId: f.id, answers: { q_name: '=IMPORTXML("x")', q_role: ['Mahasiswa', 'Karyawan'] }, hidden: { utm_source: 'fb' }, meta: { sessionId: 's_one' } });

  const calls = [];
  let fail = true;
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (String(url).includes('oauth2')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (fail && String(url).includes(':append')) return Response.json({ error: { message: 'The caller does not have permission' } }, { status: 403 });
    return Response.json({});
  };

  await syncSheets(env, { fetchImpl: fakeFetch });
  let status = env.DB.raw.prepare('SELECT sheet_status FROM forms').get().sheet_status;
  assert.match(status, /^ERROR .*permission/);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM responses WHERE synced = 0').get().n, 1, 'kept for retry');

  fail = false;
  calls.length = 0;
  const out = await syncSheets(env, { fetchImpl: fakeFetch });
  assert.equal(out.synced, 1);
  const header = calls.find((c) => c.method === 'PUT');
  assert.match(header.url, /1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\/values\/A1\?valueInputOption=RAW/);
  const append = calls.find((c) => c.url.includes(':append'));
  assert.match(append.url, /valueInputOption=RAW/);
  const row = JSON.parse(append.body).values[0];
  assert.ok(row.includes('=IMPORTXML("x")'), 'stored as RAW text, never evaluated');
  assert.ok(row.includes('Mahasiswa, Karyawan'));
  status = env.DB.raw.prepare('SELECT sheet_status FROM forms').get().sheet_status;
  assert.match(status, /^OK .*\(\+1\)/);

  // Nothing new → no calls. Adding a question appends a column at the end, old positions stay.
  calls.length = 0;
  await syncSheets(env, { fetchImpl: fakeFetch });
  assert.equal(calls.length, 0);
  const before = sheetColumns(f, []);
  const f2 = structuredClone(f);
  f2.questions.unshift({ id: 'q_new', type: 'short_text', title: 'Baru' });
  const after = sheetColumns(f2, before);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.at(-1), ['q:q_new', 'Baru']);
});

test('worker serves config script and falls back to assets', async () => {
  const env = makeEnv({ ASSETS: { fetch: async () => new Response('asset') } });
  const cfg = await worker.fetch(new Request('https://x.test/formflow-config.js'), env, {});
  assert.match(await cfg.text(), /backend:"cloud",apiUrl:"\/api"/);
  const page = await worker.fetch(new Request('https://x.test/form.html'), env, {});
  assert.equal(await page.text(), 'asset');
  const bad = await api(env, { action: 'event', formId: 'f_nope01', type: 'view', sessionId: 's_x' });
  assert.equal(bad.status, 404);
});

test('partial responses: opt-in, needs valid contact, sanitised, replaced by submit, purged after 30 days', async () => {
  const env = makeEnv();
  const f = { ...structuredClone(form), integrations: {}, recovery: { partials: false } };
  await api(env, { action: 'saveForm', key: 'secret-key', form: f });
  const partial = (sessionId, answers, type = 'partial') => api(env, { action: 'event', formId: f.id, type, sessionId, path: Object.keys(answers), answers, hidden: { utm_source: 'fb', evil: 'x' } });
  const count = () => env.DB.raw.prepare('SELECT COUNT(*) n FROM partials').get().n;

  await partial('s_p1', { q_name: 'Faiz', q_mail: 'faiz@mail.com' });
  assert.equal(count(), 0, 'feature off: nothing stored');

  f.recovery = { partials: true };
  await api(env, { action: 'saveForm', key: 'secret-key', form: f });
  await partial('s_p1', { q_name: 'Faiz' });
  assert.equal(count(), 0, 'no contact yet: nothing stored');
  await partial('s_p1', { q_name: 'Faiz', q_mail: 'not-an-email' });
  assert.equal(count(), 0, 'invalid email is not a contact');

  await partial('s_p1', { q_name: 'Faiz', q_mail: 'faiz@mail.com', q_bogus: 'x' });
  await partial('s_p1', { q_name: 'Faiz', q_mail: 'faiz@mail.com', q_phone: '0812-3456-7890' }, 'abandon');
  await partial('s_p2', { q_name: 'Ana', q_phone: '+62 811 2222 3333' }, 'abandon');
  assert.equal(count(), 2, 'upserted per session');
  const row = env.DB.raw.prepare("SELECT * FROM partials WHERE session_id = 's_p1'").get();
  assert.deepEqual(Object.keys(JSON.parse(row.answers)).sort(), ['q_mail', 'q_name', 'q_phone'], 'unknown question dropped');
  assert.deepEqual(JSON.parse(row.hidden), { utm_source: 'fb' }, 'unknown hidden field dropped');
  assert.deepEqual(JSON.parse(row.contact), { email: 'faiz@mail.com', phone: '0812-3456-7890', name: 'Faiz' });
  assert.equal(row.last_question, 'q_phone');

  // Funnel still counts partial/abandon progress exactly once.
  const res = await api(env, { action: 'getResults', key: 'secret-key', formId: f.id, days: 7 });
  assert.equal(res.partials.length, 2);
  assert.equal(res.partials[0].contact.name, 'Ana', 'newest first');
  assert.equal(res.stats.funnel.find((x) => x.id === 'q_name').reached, 2);

  // Submitting replaces the unfinished copy, and a late beacon cannot bring it back.
  await api(env, { action: 'submit', formId: f.id, answers: { q_name: 'Faiz', q_mail: 'faiz@mail.com' }, meta: { sessionId: 's_p1', path: ['q_name', 'q_mail'] } });
  assert.equal(count(), 1);
  await partial('s_p1', { q_name: 'Faiz', q_mail: 'faiz@mail.com' }, 'abandon');
  assert.equal(count(), 1, 'no partial for a submitted session');

  env.DB.raw.prepare("UPDATE partials SET updated_at = '2020-01-01T00:00:00.000Z'").run();
  assert.equal(await purgeOldPartials(env), 1);
  assert.equal(count(), 0);
});
