// FormFlow API on Cloudflare Workers + D1.
// Speaks the same JSON protocol as apps-script/Code.gs, so the frontend
// adapter is shared. Static files in ../app are served by Workers Assets.
import { validateAnswer, partialsEnabled, contactFrom, cleanPartialAnswers, PARTIAL_RETENTION_DAYS } from '../../app/js/logic.js';
import { answerIncrements, statsFromAggregates } from '../../app/js/stats.js';
import { sendCapi } from './meta.js';
import { hasGoogleCredentials, parseSheetId, writeHeader, appendRows } from './google.js';

const MAX_BODY = 100_000;
const MAX_VALUE = 5000;
const AUTO_HIDDEN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
const META_KEYS = ['durationSec', 'pageUrl', 'referrer', 'sessionId'];
const FORM_CACHE_SEC = 30;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ─── Utilities ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });
}

function validId(id) {
  if (!/^[a-z]_[a-z0-9]{4,20}$/.test(String(id || ''))) throw new HttpError(400, 'ID tidak valid.');
  return id;
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function requireAdmin(env, body) {
  if (!env.ADMIN_KEY) throw new HttpError(500, 'ADMIN_KEY belum di-set (wrangler secret put ADMIN_KEY).');
  if (!body.key || !safeEqual(String(body.key), env.ADMIN_KEY)) throw new HttpError(401, 'Admin key salah.');
}

export function tzOffsetMs(env) {
  const m = Number(env.TZ_OFFSET_MINUTES ?? 420); // default WIB (UTC+7)
  return (Number.isFinite(m) ? m : 420) * 60_000;
}

/** Calendar day in the configured timezone, e.g. 2026-09-24. */
export function localDay(env, date = new Date()) {
  return new Date(date.getTime() + tzOffsetMs(env)).toISOString().slice(0, 10);
}

function clean(v) {
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => String(x).slice(0, 500));
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v ?? '').slice(0, MAX_VALUE);
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ─── Forms ──────────────────────────────────────────────────────────────────
async function loadForm(env, id, { cache = true } = {}) {
  validId(id);
  const cacheKey = new Request(`https://formflow.cache/form/${id}`);
  const edge = typeof caches !== 'undefined' && cache ? caches.default : null;
  if (edge) {
    const hit = await edge.match(cacheKey);
    if (hit) return hit.json();
  }
  const row = await env.DB.prepare('SELECT json FROM forms WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Form tidak ditemukan.');
  const form = JSON.parse(row.json);
  if (edge) {
    await edge.put(cacheKey, new Response(row.json, { headers: { 'Cache-Control': `max-age=${FORM_CACHE_SEC}` } }));
  }
  return form;
}

function publicForm(form) {
  const f = structuredClone(form);
  delete f.integrations; // webhook URLs & sheet ids stay server-side
  return f;
}

async function saveForm(env, form) {
  if (!form || typeof form !== 'object') throw new HttpError(400, 'Form kosong.');
  validId(form.id);
  const now = new Date().toISOString();
  form.updatedAt = now;
  const json = JSON.stringify(form);
  if (json.length > 500_000) throw new HttpError(413, 'Form terlalu besar.');
  const sheetInput = form.integrations?.sheetUrl;
  const sheetId = sheetInput ? parseSheetId(sheetInput) : null;
  if (sheetInput && !sheetId) throw new HttpError(400, 'Link Google Sheet tidak valid.');
  await env.DB.prepare(`
    INSERT INTO forms (id, title, json, sheet_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    ON CONFLICT(id) DO UPDATE SET title = ?2, json = ?3, sheet_id = ?4, updated_at = ?5,
      sheet_cols = CASE WHEN forms.sheet_id IS ?4 THEN forms.sheet_cols ELSE '[]' END`)
    .bind(form.id, String(form.title || '').slice(0, 300), json, sheetId, now).run();
  if (typeof caches !== 'undefined') await caches.default.delete(new Request(`https://formflow.cache/form/${form.id}`));
  return { ok: true, form, sheetUrl: sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : '' };
}

async function listForms(env) {
  const { results } = await env.DB.prepare('SELECT id, title, sheet_id, updated_at FROM forms ORDER BY updated_at DESC').all();
  return results.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, sheetUrl: r.sheet_id ? `https://docs.google.com/spreadsheets/d/${r.sheet_id}/edit` : '' }));
}

async function deleteForm(env, id) {
  validId(id);
  await env.DB.batch(['forms', 'responses', 'sessions', 'daily', 'funnel', 'answer_counts', 'partials'].map((t) =>
    env.DB.prepare(`DELETE FROM ${t} WHERE ${t === 'forms' ? 'id' : 'form_id'} = ?`).bind(id)));
  return { ok: true };
}

// ─── Funnel bookkeeping ─────────────────────────────────────────────────────
// Every event carries the full path so far; we only count what is new since
// the last event of the same session, so retries and repeated beacons never
// double count.
async function applyPath(env, form, sessionId, rawPath, { complete = false, now = new Date() } = {}) {
  const ids = new Set((form.questions || []).map((q) => q.id));
  const path = (Array.isArray(rawPath) ? rawPath : []).map(String).filter((q) => ids.has(q)).slice(0, 200);
  const stmts = [];
  let s = await env.DB.prepare('SELECT day, started, completed, path FROM sessions WHERE form_id = ? AND id = ?').bind(form.id, sessionId).first();
  if (!s) {
    // No view event recorded (blocked or lost) — start tracking the session now.
    s = { day: localDay(env, now), started: 0, completed: 0, path: '[]' };
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO sessions (form_id, id, day) VALUES (?, ?, ?)').bind(form.id, sessionId, s.day));
  }
  if (s.completed) return;
  const old = JSON.parse(s.path || '[]');
  const seen = new Set(old);
  const added = path.filter((q) => !seen.has(q));
  const merged = [...old, ...added];
  const oldLast = old[old.length - 1];
  const newLast = path[path.length - 1] ?? oldLast;
  const bump = (col, qid, delta) => env.DB.prepare(`
    INSERT INTO funnel (form_id, day, question_id, ${col}) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(form_id, day, question_id) DO UPDATE SET ${col} = ${col} + ?4`).bind(form.id, s.day, qid, delta);

  const started = s.started || merged.length > 0 || complete;
  if (!s.started && started) {
    stmts.push(env.DB.prepare(`INSERT INTO daily (form_id, day, starts) VALUES (?, ?, 1)
      ON CONFLICT(form_id, day) DO UPDATE SET starts = starts + 1`).bind(form.id, s.day));
  }
  for (const q of added) stmts.push(bump('reached', q, 1));
  // "dropped" = sessions whose furthest question is this one and that never finished.
  const moved = newLast !== oldLast;
  if (oldLast && (moved || complete)) stmts.push(bump('dropped', oldLast, -1));
  if (!complete && newLast && (moved || !oldLast)) stmts.push(bump('dropped', newLast, 1));
  stmts.push(env.DB.prepare('UPDATE sessions SET started = ?, completed = ?, path = ? WHERE form_id = ? AND id = ?')
    .bind(started ? 1 : 0, complete ? 1 : 0, JSON.stringify(merged), form.id, sessionId));
  await env.DB.batch(stmts);
}

function cleanHidden(form, hidden) {
  const keys = new Set([...AUTO_HIDDEN, ...(form.hiddenFields || [])]);
  return Object.fromEntries(Object.entries(hidden || {}).filter(([k]) => keys.has(k)).map(([k, v]) => [k, String(v).slice(0, 500)]));
}

/**
 * Keeps the unfinished answers of a session, only when the form opts in and a
 * valid email/phone is present. Never overwrites a session that already submitted.
 */
async function upsertPartial(env, form, sessionId, body) {
  if (!partialsEnabled(form) || !body.answers || typeof body.answers !== 'object') return false;
  const answers = cleanPartialAnswers(form, body.answers);
  const contact = contactFrom(form, answers);
  if (!contact) return false;
  const ids = new Set(form.questions.map((q) => q.id));
  const path = (Array.isArray(body.path) ? body.path : []).map(String).filter((q) => ids.has(q));
  const r = await env.DB.prepare(`
    INSERT INTO partials (form_id, session_id, updated_at, answers, hidden, contact, last_question, answered_count)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE NOT EXISTS (SELECT 1 FROM responses WHERE form_id = ?1 AND session_id = ?2)
    ON CONFLICT(form_id, session_id) DO UPDATE SET updated_at = excluded.updated_at, answers = excluded.answers,
      hidden = excluded.hidden, contact = excluded.contact, last_question = excluded.last_question, answered_count = excluded.answered_count`)
    .bind(form.id, sessionId, new Date().toISOString(), JSON.stringify(answers), JSON.stringify(cleanHidden(form, body.hidden)),
      JSON.stringify(contact), path[path.length - 1] || '', Object.keys(answers).length).run();
  return r.meta.changes > 0;
}

async function logEvent(env, body) {
  const type = String(body.type || '');
  // 'partial' = progress saved right after contact details were entered.
  if (!['view', 'start', 'abandon', 'partial'].includes(type)) throw new HttpError(400, 'Event tidak valid.');
  const sessionId = String(body.sessionId || '').slice(0, 40);
  if (!/^s_[a-z0-9]+$/.test(sessionId)) throw new HttpError(400, 'Session tidak valid.');
  const form = await loadForm(env, body.formId);
  if (type === 'view') {
    const day = localDay(env);
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO sessions (form_id, id, day) VALUES (?, ?, ?)').bind(form.id, sessionId, day).run();
    if (ins.meta.changes) {
      await env.DB.prepare(`INSERT INTO daily (form_id, day, views) VALUES (?, ?, 1)
        ON CONFLICT(form_id, day) DO UPDATE SET views = views + 1`).bind(form.id, day).run();
    }
  } else {
    await applyPath(env, form, sessionId, body.path);
    if (type === 'abandon' || type === 'partial') await upsertPartial(env, form, sessionId, body);
  }
  return { ok: true };
}

// ─── Submissions ────────────────────────────────────────────────────────────
async function submit(env, body, request, ctx) {
  const form = await loadForm(env, body.formId);
  if (body.hp) return { ok: true, responseId: uid('r') }; // honeypot: pretend success

  const qById = Object.fromEntries((form.questions || []).map((q) => [q.id, q]));
  const answers = {};
  for (const [k, v] of Object.entries(body.answers || {})) {
    const q = qById[k];
    if (!q || q.type === 'statement') continue;
    // Required-ness depends on the logic path the respondent took, so only check format here.
    const err = validateAnswer({ ...q, required: false }, v);
    if (err) throw new HttpError(422, `${q.title || k}: ${err}`);
    answers[k] = clean(v);
  }
  const hidden = cleanHidden(form, body.hidden);
  const m = body.meta || {};
  const meta = Object.fromEntries(Object.entries({
    durationSec: Number(m.durationSec) || 0, pageUrl: m.pageUrl, referrer: m.referrer, sessionId: m.sessionId,
    eventId: m.eventId, userAgent: m.userAgent, fbp: m.fbp, fbc: m.fbc,
  }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, typeof v === 'number' ? v : String(v).slice(0, 1000)]));
  const sessionId = /^s_[a-z0-9]+$/.test(meta.sessionId || '') ? meta.sessionId : null;

  const now = new Date();
  const responseId = uid('r');
  // One submission per session: a client retry after a lost response is ignored.
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO responses (id, form_id, submitted_at, session_id, answers, hidden, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(responseId, form.id, now.toISOString(), sessionId, JSON.stringify(answers), JSON.stringify(hidden), JSON.stringify(meta)).run();
  if (!ins.meta.changes) {
    const prev = await env.DB.prepare('SELECT id FROM responses WHERE form_id = ? AND session_id = ?').bind(form.id, sessionId).first();
    return { ok: true, responseId: prev?.id, duplicate: true };
  }

  const day = localDay(env, now);
  const stmts = [env.DB.prepare(`INSERT INTO daily (form_id, day, completions) VALUES (?, ?, 1)
    ON CONFLICT(form_id, day) DO UPDATE SET completions = completions + 1`).bind(form.id, day)];
  for (const [qid, value] of answerIncrements(form, answers, hidden, meta)) {
    stmts.push(env.DB.prepare(`INSERT INTO answer_counts (form_id, day, question_id, value, count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(form_id, day, question_id, value) DO UPDATE SET count = count + 1`).bind(form.id, day, qid, value));
  }
  await env.DB.batch(stmts);
  if (sessionId) {
    await applyPath(env, form, sessionId, m.path, { complete: true, now });
    // The finished response replaces its unfinished copy.
    await env.DB.prepare('DELETE FROM partials WHERE form_id = ? AND session_id = ?').bind(form.id, sessionId).run();
  }

  // Side effects run after the response is sent (ctx.waitUntil) — the respondent never waits on Meta or webhooks.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const side = [];
  side.push(sendCapi(env, form, { answers, hidden, meta, ip, now }));
  const hook = form.integrations?.webhookUrl;
  if (hook && /^https:\/\//.test(hook)) {
    const readable = Object.fromEntries((form.questions || []).filter((q) => answers[q.id] !== undefined).map((q) => [q.title || q.id, answers[q.id]]));
    side.push(fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formId: form.id, formTitle: form.title, responseId, submittedAt: now.toISOString(), answers: readable, rawAnswers: answers, hidden }),
    }));
  }
  ctx?.waitUntil?.(Promise.allSettled(side).then((r) => r.forEach((x) => x.status === 'rejected' && console.warn('side effect failed', x.reason))));
  return { ok: true, responseId };
}

// ─── Dashboard ──────────────────────────────────────────────────────────────
function parseResponse(r) {
  return { responseId: r.id, submittedAt: r.submitted_at, answers: JSON.parse(r.answers), hidden: JSON.parse(r.hidden), meta: JSON.parse(r.meta) };
}

async function getResults(env, formId, days) {
  const form = await loadForm(env, formId, { cache: false });
  days = Math.min(Math.max(Math.round(days) || 30, 1), 400);
  const today = new Date(Date.now() + tzOffsetMs(env));
  const since = new Date(today.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const partialCutoff = new Date(Date.now() - PARTIAL_RETENTION_DAYS * 86_400_000).toISOString();
  const [daily, funnel, counts, recent, total, fm, partials] = await env.DB.batch([
    env.DB.prepare('SELECT day, views, starts, completions FROM daily WHERE form_id = ? AND day >= ?').bind(form.id, since),
    env.DB.prepare('SELECT question_id, SUM(reached) AS reached, SUM(dropped) AS dropped FROM funnel WHERE form_id = ? AND day >= ? GROUP BY question_id').bind(form.id, since),
    env.DB.prepare('SELECT question_id, value, SUM(count) AS count FROM answer_counts WHERE form_id = ? AND day >= ? GROUP BY question_id, value').bind(form.id, since),
    env.DB.prepare('SELECT id, submitted_at, answers, hidden, meta FROM responses WHERE form_id = ? ORDER BY submitted_at DESC LIMIT 100').bind(form.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?').bind(form.id),
    env.DB.prepare('SELECT sheet_id, sheet_status FROM forms WHERE id = ?').bind(form.id),
    env.DB.prepare(`SELECT session_id, updated_at, answers, hidden, contact, last_question, answered_count FROM partials
      WHERE form_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 500`).bind(form.id, partialCutoff),
  ]);
  const recentParsed = recent.results.map(parseResponse);
  const stats = statsFromAggregates(form, { daily: daily.results, funnel: funnel.results, counts: counts.results, recent: recentParsed }, { days, today });
  const f = fm.results[0] || {};
  return {
    ok: true,
    stats,
    responses: recentParsed, // newest first, max 100
    totalResponses: total.results[0].n,
    partials: partials.results.map((p) => ({
      sessionId: p.session_id, updatedAt: p.updated_at, answers: JSON.parse(p.answers), hidden: JSON.parse(p.hidden),
      contact: JSON.parse(p.contact), lastQuestion: p.last_question, answeredCount: p.answered_count,
    })),
    sheetUrl: f.sheet_id ? `https://docs.google.com/spreadsheets/d/${f.sheet_id}/edit` : '',
    sheetStatus: f.sheet_status || '',
  };
}

/** Paged raw export (for CSV). Cursor = "submitted_at|id" of the last row. */
async function exportResponses(env, formId, after, limit) {
  validId(formId);
  limit = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
  const [ts, id] = String(after || '|').split('|');
  const { results } = await env.DB.prepare(`SELECT id, submitted_at, answers, hidden, meta FROM responses
    WHERE form_id = ?1 AND (submitted_at > ?2 OR (submitted_at = ?2 AND id > ?3)) ORDER BY submitted_at, id LIMIT ?4`)
    .bind(formId, ts || '', id || '', limit).all();
  const last = results[results.length - 1];
  return { ok: true, responses: results.map(parseResponse), next: results.length === limit ? `${last.submitted_at}|${last.id}` : null };
}

// ─── Google Sheets mirror ───────────────────────────────────────────────────
export function sheetColumns(form, existing = []) {
  const want = [['submittedAt', 'Submitted At'], ['responseId', 'Response ID']];
  for (const q of form.questions || []) if (q.type !== 'statement') want.push([`q:${q.id}`, String(q.title || q.id).replace(/\{\{\s*[\w:-]+\s*\}\}/g, '…')]);
  for (const h of [...AUTO_HIDDEN, ...(form.hiddenFields || [])]) want.push([`h:${h}`, h]);
  want.push(['m:durationSec', 'Durasi (detik)'], ['m:pageUrl', 'Page URL'], ['m:referrer', 'Referrer'], ['m:sessionId', 'Session ID']);
  // Existing columns keep their position (rows already written rely on it); titles are refreshed.
  const title = Object.fromEntries(want);
  const cols = existing.map(([k, t]) => [k, title[k] ?? t]);
  const have = new Set(cols.map(([k]) => k));
  for (const w of want) if (!have.has(w[0])) { cols.push(w); have.add(w[0]); }
  return cols;
}

function sheetRow(cols, r) {
  return cols.map(([k]) => {
    if (k === 'submittedAt') return r.submittedAt;
    if (k === 'responseId') return r.responseId;
    const [kind, key] = [k.slice(0, 1), k.slice(2)];
    const v = kind === 'q' ? r.answers[key] : kind === 'h' ? r.hidden[key] : r.meta[key];
    if (v === undefined || v === null) return '';
    return Array.isArray(v) ? v.join(', ') : v;
  });
}

export async function syncSheets(env, { fetchImpl = fetch, batchSize = 500 } = {}) {
  if (!hasGoogleCredentials(env)) return { ok: true, synced: 0, skipped: 'no credentials' };
  const { results: forms } = await env.DB.prepare('SELECT id, json, sheet_id, sheet_cols FROM forms WHERE sheet_id IS NOT NULL').all();
  let synced = 0;
  for (const f of forms) {
    const { results } = await env.DB.prepare(`SELECT id, submitted_at, answers, hidden, meta FROM responses
      WHERE synced = 0 AND form_id = ? ORDER BY submitted_at LIMIT ?`).bind(f.id, batchSize).all();
    if (!results.length) continue;
    const form = JSON.parse(f.json);
    const prevCols = JSON.parse(f.sheet_cols || '[]');
    const cols = sheetColumns(form, prevCols);
    try {
      if (JSON.stringify(cols) !== JSON.stringify(prevCols)) await writeHeader(env, fetchImpl, f.sheet_id, cols.map(([, t]) => t));
      await appendRows(env, fetchImpl, f.sheet_id, results.map((r) => sheetRow(cols, parseResponse(r))));
      const ids = results.map((r) => r.id);
      const stmts = [];
      for (let i = 0; i < ids.length; i += 90) { // D1 allows max 100 bound parameters per statement
        const chunk = ids.slice(i, i + 90);
        stmts.push(env.DB.prepare(`UPDATE responses SET synced = 1 WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
      }
      stmts.push(env.DB.prepare('UPDATE forms SET sheet_cols = ?, sheet_status = ? WHERE id = ?')
        .bind(JSON.stringify(cols), `OK ${new Date().toISOString()} (+${ids.length})`, f.id));
      await env.DB.batch(stmts);
      synced += ids.length;
    } catch (err) {
      // Rows stay unsynced and are retried on the next cron run.
      await env.DB.prepare('UPDATE forms SET sheet_status = ? WHERE id = ?').bind(`ERROR ${new Date().toISOString()}: ${String(err.message).slice(0, 300)}`, f.id).run();
      console.error('sheet sync failed', f.id, err.message);
    }
  }
  return { ok: true, synced };
}

/** Data minimisation: unfinished answers are kept for 30 days at most. */
export async function purgeOldPartials(env) {
  const cutoff = new Date(Date.now() - PARTIAL_RETENTION_DAYS * 86_400_000).toISOString();
  const r = await env.DB.prepare('DELETE FROM partials WHERE updated_at < ?').bind(cutoff).run();
  return r.meta.changes;
}

// ─── Router ─────────────────────────────────────────────────────────────────
async function rateLimited(env, request, action) {
  if (!env.SUBMIT_LIMITER || (action !== 'submit' && action !== 'event')) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.SUBMIT_LIMITER.limit({ key: `${action}:${ip}` });
  return !success;
}

async function handleApi(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const action = url.searchParams.get('action');
    if (action === 'getForm') {
      const form = await loadForm(env, url.searchParams.get('id'));
      return json({ ok: true, form: publicForm(form) }, 200, { 'Cache-Control': `public, max-age=${FORM_CACHE_SEC}` });
    }
    if (action === 'health') return json({ ok: true, time: new Date().toISOString() });
    throw new HttpError(400, 'Unknown action');
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, 'Payload terlalu besar.');
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'JSON tidak valid.'); }
  if (await rateLimited(env, request, body.action)) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
  switch (body.action) {
    case 'submit': return json(await submit(env, body, request, ctx));
    case 'event': return json(await logEvent(env, body));
    case 'saveForm': requireAdmin(env, body); return json(await saveForm(env, body.form));
    case 'listForms': requireAdmin(env, body); return json({ ok: true, forms: await listForms(env) });
    case 'deleteForm': requireAdmin(env, body); return json(await deleteForm(env, body.id));
    case 'getResults': requireAdmin(env, body); return json(await getResults(env, body.formId, Number(body.days) || 30));
    case 'exportResponses': requireAdmin(env, body); return json(await exportResponses(env, body.formId, body.after, body.limit));
    case 'syncSheets': requireAdmin(env, body); return json(await syncSheets(env));
    case 'info': requireAdmin(env, body); return json({ ok: true, serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '', capi: !!env.FB_CAPI_TOKEN });
    default: throw new HttpError(400, 'Unknown action');
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname === '/api/') {
      try {
        return await handleApi(request, env, ctx);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        return json({ ok: false, error: status === 500 ? 'Server error.' : err.message }, status);
      }
    }
    // Tells the static frontend (served from the same Worker) to use this API.
    if (url.pathname === '/formflow-config.js') {
      return new Response('window.FORMFLOW_CONFIG={backend:"cloud",apiUrl:"/api"};', {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      });
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([syncSheets(env), purgeOldPartials(env)]));
  },
};

