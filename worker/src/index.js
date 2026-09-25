// Belajarlagi Form API on Cloudflare Workers + D1.
// Speaks the same JSON protocol as apps-script/Code.gs, so the frontend
// adapter is shared. Static files in ../app are served by Workers Assets.
import {
  validateAnswer, partialsEnabled, contactFrom, cleanPartialAnswers, PARTIAL_RETENTION_DAYS,
  variantForm, allQuestions, variantTag, answerText, cleanSlug, slugProblem,
} from '../../app/js/logic.js';
import { answerIncrements, statsFromAggregates, SEGMENT_DIMS } from '../../app/js/stats.js';
import { deviceOf, validDevice, cleanSource } from '../../app/js/traffic.js';
import { sendCapi } from './meta.js';
import { hasGoogleCredentials, parseSheetId, writeHeader, appendRows } from './google.js';
import { HttpError, CORS, json, validId, validSession, uid } from './http.js';
import * as auth from './auth.js';
import { can } from '../../app/js/roles.js';
import { handleUpload, handleMedia, serveFile, serveMedia, resolveFileAnswers, signResponses, purgePendingUploads, deleteFormFiles } from './files.js';

const MAX_BODY = 100_000;
const MAX_VALUE = 5000;
const AUTO_HIDDEN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
const FORM_CACHE_SEC = 30;

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

/** Device / source / A-B variant of a visit, as sent by the form page (validated here). */
function visitDims(form, x, request) {
  const [experimentId, variant] = String(x?.variant || '').split(':');
  return {
    device: validDevice(x?.device) || deviceOf(request?.headers.get('User-Agent') || ''),
    source: cleanSource(x?.source),
    variant: variantTag(form, experimentId, variant),
  };
}

function bumpSegments(env, formId, day, dims, field) {
  return SEGMENT_DIMS.filter((d) => dims?.[d]).map((d) => env.DB.prepare(`
    INSERT INTO segments (form_id, day, dim, value, ${field}) VALUES (?1, ?2, ?3, ?4, 1)
    ON CONFLICT(form_id, day, dim, value) DO UPDATE SET ${field} = ${field} + 1`).bind(formId, day, d, dims[d]));
}

// ─── Forms ──────────────────────────────────────────────────────────────────
async function loadForm(env, id, { cache = true } = {}) {
  validId(id);
  const cacheKey = new Request(`https://belajarlagiform.cache/form/${id}`);
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
  delete f.experiments; // finished A/B tests
  return f;
}

const TOP_SOURCES = 25;

/** Sources are free text (utm_source, referrer host); keep the biggest and fold the long tail into one row. */
function topSources(rows) {
  const sources = rows.filter((r) => r.dim === 'source').sort((a, b) => b.views - a.views);
  if (sources.length <= TOP_SOURCES) return rows;
  const rest = { dim: 'source', value: '(lainnya)', views: 0, starts: 0, completions: 0 };
  for (const r of sources.slice(TOP_SOURCES)) for (const k of ['views', 'starts', 'completions']) rest[k] += Number(r[k] || 0);
  return [...rows.filter((r) => r.dim !== 'source'), ...sources.slice(0, TOP_SOURCES), rest];
}

const EXPERIMENT_LOG = { running: 'experiment.start', paused: 'experiment.pause', ended: 'experiment.end' };

async function saveForm(env, form, actor) {
  if (!form || typeof form !== 'object') throw new HttpError(400, 'Form kosong.');
  validId(form.id);
  const before = await env.DB.prepare('SELECT json FROM forms WHERE id = ?').bind(form.id).first();
  const prev = before ? JSON.parse(before.json) : null;
  // A GTM container runs any script on the builder's own origin, where a signed-in
  // session lives. Only admins and the owner may add or change it.
  const gtm = String(form.tracking?.gtmId || '');
  if (gtm !== String(prev?.tracking?.gtmId || '') && !can(actor.role, 'team.manage')) {
    throw new HttpError(403, 'Hanya Admin atau Pemilik yang bisa mengubah GTM Container ID.');
  }
  const now = new Date().toISOString();
  form.updatedAt = now;
  if (form.slug) form.slug = cleanSlug(form.slug); else delete form.slug;
  const json = JSON.stringify(form);
  if (json.length > 500_000) throw new HttpError(413, 'Form terlalu besar.');
  const sheetInput = form.integrations?.sheetUrl;
  const sheetId = sheetInput ? parseSheetId(sheetInput) : null;
  if (sheetInput && !sheetId) throw new HttpError(400, 'Link Google Sheet tidak valid.');
  const slug = form.slug ? await claimSlug(env, form) : null;
  await env.DB.prepare(`
    INSERT INTO forms (id, title, json, sheet_id, slug, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?6, ?5, ?5)
    ON CONFLICT(id) DO UPDATE SET title = ?2, json = ?3, sheet_id = ?4, slug = ?6, updated_at = ?5,
      sheet_cols = CASE WHEN forms.sheet_id IS ?4 THEN forms.sheet_cols ELSE '[]' END`)
    .bind(form.id, String(form.title || '').slice(0, 300), json, sheetId, now, slug).run();
  if (typeof caches !== 'undefined') await caches.default.delete(new Request(`https://belajarlagiform.cache/form/${form.id}`));
  await auth.audit(env, actor, prev ? 'form.publish' : 'form.create', form.title || form.id);
  const x = form.experiment;
  const was = prev?.experiment;
  if (x && (x.id !== was?.id || x.status !== was?.status) && EXPERIMENT_LOG[x.status]) {
    await auth.audit(env, actor, EXPERIMENT_LOG[x.status], form.title || form.id, `${x.id} · ${x.split ?? 50}% ke B`);
  } else if (!x && was) {
    const done = (form.experiments || []).find((e) => e.id === was.id);
    await auth.audit(env, actor, 'experiment.end', form.title || form.id, done?.winner ? `${was.id} · pemenang ${done.winner}` : was.id);
  }
  return { ok: true, form, sheetUrl: sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : '' };
}

/** Checks a custom link and makes sure no other form uses it. */
async function claimSlug(env, form) {
  const problem = slugProblem(form.slug);
  if (problem) throw new HttpError(400, problem);
  const other = await env.DB.prepare('SELECT title FROM forms WHERE slug = ? AND id != ?').bind(form.slug, form.id).first();
  if (other) throw new HttpError(409, `Link /${form.slug} sudah dipakai form "${other.title || 'lain'}". Pilih nama lain.`);
  return form.slug;
}

async function formIdForSlug(env, raw) {
  const slug = cleanSlug(raw);
  if (slugProblem(slug) || slug !== String(raw)) return null;
  const row = await env.DB.prepare('SELECT id FROM forms WHERE slug = ?').bind(slug).first();
  return row?.id || null;
}

async function listForms(env) {
  const { results } = await env.DB.prepare('SELECT id, title, slug, sheet_id, updated_at FROM forms ORDER BY updated_at DESC').all();
  return results.map((r) => ({ id: r.id, title: r.title, slug: r.slug || '', updatedAt: r.updated_at, sheetUrl: r.sheet_id ? `https://docs.google.com/spreadsheets/d/${r.sheet_id}/edit` : '' }));
}

async function deleteForm(env, id, actor) {
  validId(id);
  const row = await env.DB.prepare('SELECT title FROM forms WHERE id = ?').bind(id).first();
  await deleteFormFiles(env, id);
  await env.DB.batch(['forms', 'responses', 'sessions', 'daily', 'funnel', 'answer_counts', 'partials', 'segments', 'uploads'].map((t) =>
    env.DB.prepare(`DELETE FROM ${t} WHERE ${t === 'forms' ? 'id' : 'form_id'} = ?`).bind(id)));
  if (typeof caches !== 'undefined') await caches.default.delete(new Request(`https://belajarlagiform.cache/form/${id}`));
  await auth.audit(env, actor, 'form.delete', row?.title || id);
  return { ok: true };
}

// ─── Funnel bookkeeping ─────────────────────────────────────────────────────
// Every event carries the full path so far; we only count what is new since
// the last event of the same session, so retries and repeated beacons never
// double count.
async function applyPath(env, form, sessionId, rawPath, { complete = false, now = new Date(), dims = null } = {}) {
  const ids = new Set(allQuestions(form).map((q) => q.id));
  const path = (Array.isArray(rawPath) ? rawPath : []).map(String).filter((q) => ids.has(q)).slice(0, 200);
  const stmts = [];
  let s = await env.DB.prepare('SELECT day, started, completed, path, device, source, variant FROM sessions WHERE form_id = ? AND id = ?').bind(form.id, sessionId).first();
  if (!s) {
    // No view event recorded (blocked or lost) — start tracking the session now.
    s = { day: localDay(env, now), started: 0, completed: 0, path: '[]', ...(dims || {}) };
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO sessions (form_id, id, day, device, source, variant) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(form.id, sessionId, s.day, s.device || '', s.source || '', s.variant || ''));
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
    stmts.push(...bumpSegments(env, form.id, s.day, s, 'starts'));
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
async function upsertPartial(env, form, sessionId, body, dims) {
  if (!partialsEnabled(form) || !body.answers || typeof body.answers !== 'object') return false;
  const shown = variantForm(form, dims.variant.split(':')[1]); // the questions this visitor was shown
  const answers = cleanPartialAnswers(shown, body.answers);
  const contact = contactFrom(shown, answers);
  if (!contact) return false;
  const ids = new Set(shown.questions.map((q) => q.id));
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

async function logEvent(env, body, request) {
  const type = String(body.type || '');
  // 'partial' = progress saved right after contact details were entered.
  if (!['view', 'start', 'abandon', 'partial'].includes(type)) throw new HttpError(400, 'Event tidak valid.');
  const sessionId = validSession(body.sessionId);
  if (!sessionId) throw new HttpError(400, 'Session tidak valid.');
  const form = await loadForm(env, body.formId);
  const dims = visitDims(form, body, request);
  if (type === 'view') {
    const day = localDay(env);
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO sessions (form_id, id, day, device, source, variant) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(form.id, sessionId, day, dims.device, dims.source, dims.variant).run();
    if (ins.meta.changes) {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO daily (form_id, day, views) VALUES (?, ?, 1)
          ON CONFLICT(form_id, day) DO UPDATE SET views = views + 1`).bind(form.id, day),
        ...bumpSegments(env, form.id, day, dims, 'views'),
      ]);
    }
  } else {
    await applyPath(env, form, sessionId, body.path, { dims });
    if (type === 'abandon' || type === 'partial') await upsertPartial(env, form, sessionId, body, dims);
  }
  return { ok: true };
}

// ─── Submissions ────────────────────────────────────────────────────────────
async function submit(env, body, request, ctx) {
  const form = await loadForm(env, body.formId);
  if (body.hp) return { ok: true, responseId: uid('r') }; // honeypot: pretend success

  const m = body.meta || {};
  const sessionId = validSession(m.sessionId);
  const dims = visitDims(form, m, request);
  // Answers are checked against the questions of the variant the visitor saw.
  const shown = variantForm(form, dims.variant.split(':')[1]);
  const qById = Object.fromEntries((shown.questions || []).map((q) => [q.id, q]));
  let answers = {};
  for (const [k, v] of Object.entries(body.answers || {})) {
    const q = qById[k];
    if (!q || q.type === 'statement') continue;
    // Required-ness depends on the logic path the respondent took, so only check format here.
    const err = validateAnswer({ ...q, required: false }, v);
    if (err) throw new HttpError(422, `${q.title || k}: ${err}`);
    answers[k] = q.type === 'file_upload' ? v : clean(v);
  }
  const files = await resolveFileAnswers(env, form, shown.questions || [], answers, sessionId, new URL(request.url).origin);
  answers = files.answers;
  const hidden = cleanHidden(form, body.hidden);
  const meta = Object.fromEntries(Object.entries({
    durationSec: Number(m.durationSec) || 0, pageUrl: m.pageUrl, referrer: m.referrer, sessionId: m.sessionId,
    eventId: m.eventId, userAgent: m.userAgent, fbp: m.fbp, fbc: m.fbc, ...dims,
  }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, typeof v === 'number' ? v : String(v).slice(0, 1000)]));

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
  // Counted under the segments of the visit (fixed by its first event), falling back to what this request says.
  const session = sessionId ? await env.DB.prepare('SELECT device, source, variant FROM sessions WHERE form_id = ? AND id = ?').bind(form.id, sessionId).first() : null;
  const stmts = [env.DB.prepare(`INSERT INTO daily (form_id, day, completions) VALUES (?, ?, 1)
    ON CONFLICT(form_id, day) DO UPDATE SET completions = completions + 1`).bind(form.id, day),
  ...bumpSegments(env, form.id, day, session || dims, 'completions')];
  for (const [qid, value] of answerIncrements(shown, answers, hidden, meta)) {
    stmts.push(env.DB.prepare(`INSERT INTO answer_counts (form_id, day, question_id, value, count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(form_id, day, question_id, value) DO UPDATE SET count = count + 1`).bind(form.id, day, qid, value));
  }
  for (let i = 0; i < files.keys.length; i += 90) {
    const chunk = files.keys.slice(i, i + 90);
    stmts.push(env.DB.prepare(`UPDATE uploads SET response_id = ? WHERE key IN (${chunk.map(() => '?').join(',')})`).bind(responseId, ...chunk));
  }
  await env.DB.batch(stmts);
  if (sessionId) {
    await applyPath(env, form, sessionId, m.path, { complete: true, now, dims });
    // The finished response replaces its unfinished copy.
    await env.DB.prepare('DELETE FROM partials WHERE form_id = ? AND session_id = ?').bind(form.id, sessionId).run();
  }

  // Side effects run after the response is sent (ctx.waitUntil) — the respondent never waits on Meta or webhooks.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const side = [];
  side.push(sendCapi(env, shown, { answers, hidden, meta, ip, now }));
  const hook = form.integrations?.webhookUrl;
  if (hook && /^https:\/\//.test(hook)) {
    const readable = Object.fromEntries((shown.questions || []).filter((q) => answers[q.id] !== undefined).map((q) => [q.title || q.id, answers[q.id]]));
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
  const [daily, funnel, counts, recent, total, fm, partials, segments] = await env.DB.batch([
    env.DB.prepare('SELECT day, views, starts, completions FROM daily WHERE form_id = ? AND day >= ?').bind(form.id, since),
    env.DB.prepare('SELECT question_id, SUM(reached) AS reached, SUM(dropped) AS dropped FROM funnel WHERE form_id = ? AND day >= ? GROUP BY question_id').bind(form.id, since),
    env.DB.prepare('SELECT question_id, value, SUM(count) AS count FROM answer_counts WHERE form_id = ? AND day >= ? GROUP BY question_id, value').bind(form.id, since),
    env.DB.prepare('SELECT id, submitted_at, answers, hidden, meta FROM responses WHERE form_id = ? ORDER BY submitted_at DESC LIMIT 100').bind(form.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?').bind(form.id),
    env.DB.prepare('SELECT sheet_id, sheet_status FROM forms WHERE id = ?').bind(form.id),
    env.DB.prepare(`SELECT session_id, updated_at, answers, hidden, contact, last_question, answered_count FROM partials
      WHERE form_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 500`).bind(form.id, partialCutoff),
    env.DB.prepare(`SELECT dim, value, SUM(views) AS views, SUM(starts) AS starts, SUM(completions) AS completions FROM segments
      WHERE form_id = ? AND day >= ? GROUP BY dim, value`).bind(form.id, since),
  ]);
  const recentParsed = await signResponses(env, recent.results.map(parseResponse));
  const stats = statsFromAggregates(form, { daily: daily.results, funnel: funnel.results, counts: counts.results, segments: topSources(segments.results), recent: recentParsed }, { days, today });
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

/** Daily views / starts / completions of both variants of an A/B test, over its whole run. */
async function getExperiment(env, formId, experimentId) {
  validId(formId);
  if (!/^x_[a-z0-9]{4,20}$/.test(String(experimentId || ''))) throw new HttpError(400, 'ID uji tidak valid.');
  const { results } = await env.DB.prepare(`SELECT day, value, views, starts, completions FROM segments
    WHERE form_id = ? AND dim = 'variant' AND value IN (?, ?) ORDER BY day`).bind(formId, `${experimentId}:A`, `${experimentId}:B`).all();
  return { ok: true, days: results.map((r) => ({ day: r.day, variant: r.value.split(':')[1], views: r.views, starts: r.starts, completions: r.completions })) };
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
  for (const q of allQuestions(form)) if (q.type !== 'statement') want.push([`q:${q.id}`, String(q.title || q.id).replace(/\{\{\s*[\w:-]+\s*\}\}/g, '…')]);
  for (const h of [...AUTO_HIDDEN, ...(form.hiddenFields || [])]) want.push([`h:${h}`, h]);
  want.push(['m:durationSec', 'Durasi (detik)'], ['m:pageUrl', 'Page URL'], ['m:referrer', 'Referrer'], ['m:sessionId', 'Session ID'],
    ['m:device', 'Perangkat'], ['m:source', 'Sumber']);
  if (form.variants?.B || form.experiments?.length) want.push(['m:variant', 'Varian A/B']);
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
    return typeof v === 'number' ? v : answerText(v);
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

// Actions for signed-in members, with the permission each one needs (app/js/roles.js).
const MEMBER_ACTIONS = {
  listForms: ['results.view', async (env) => ({ ok: true, forms: await listForms(env) })],
  getResults: ['results.view', (env, body) => getResults(env, body.formId, Number(body.days) || 30)],
  getExperiment: ['results.view', (env, body) => getExperiment(env, body.formId, body.experimentId)],
  exportResponses: ['results.view', (env, body) => exportResponses(env, body.formId, body.after, body.limit)],
  info: ['results.view', (env) => ({ ok: true, serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '', capi: !!env.FB_CAPI_TOKEN, files: !!env.FILES })],
  saveForm: ['forms.edit', (env, body, actor) => saveForm(env, body.form, actor)],
  deleteForm: ['forms.edit', (env, body, actor) => deleteForm(env, body.id, actor)],
  syncSheets: ['forms.edit', (env) => syncSheets(env)],
};

// Account and team actions (they check their own permissions).
const AUTH_ACTIONS = {
  authStatus: (env) => auth.authStatus(env),
  authSetup: auth.authSetup,
  authLogin: auth.authLogin,
  authLogout: auth.authLogout,
  authMe: auth.authMe,
  inviteInfo: auth.inviteInfo,
  inviteAccept: auth.inviteAccept,
  accountUpdate: auth.accountUpdate,
  teamList: auth.teamList,
  teamInvite: auth.teamInvite,
  teamRevokeInvite: auth.teamRevokeInvite,
  teamSetRole: auth.teamSetRole,
  teamRemove: auth.teamRemove,
  teamResetLink: auth.teamResetLink,
  teamTransferOwner: auth.teamTransferOwner,
};

/** The form page's HTML, served under a custom link (following the assets' own .html → clean-URL redirect). */
async function formPage(env, url) {
  let res = await env.ASSETS.fetch(new Request(new URL('/form.html', url)));
  if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) res = await env.ASSETS.fetch(new Request(new URL(res.headers.get('Location'), url)));
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-cache');
  return out;
}

async function handleApi(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const action = url.searchParams.get('action');
    if (action === 'getForm') {
      const slug = url.searchParams.get('slug');
      const id = slug ? await formIdForSlug(env, slug) : url.searchParams.get('id');
      if (!id) throw new HttpError(404, 'Form tidak ditemukan. Periksa lagi link-nya.');
      const form = await loadForm(env, id);
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
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON tidak valid.');
  if (await rateLimited(env, request, body.action)) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
  if (body.action === 'submit') return json(await submit(env, body, request, ctx));
  if (body.action === 'event') return json(await logEvent(env, body, request));
  if (Object.hasOwn(MEMBER_ACTIONS, body.action)) {
    const [permission, run] = MEMBER_ACTIONS[body.action];
    const actor = await auth.requirePermission(env, request, body, permission);
    return json(await run(env, body, actor));
  }
  if (Object.hasOwn(AUTH_ACTIONS, body.action)) {
    const out = await AUTH_ACTIONS[body.action](env, request, body);
    return out instanceof Response ? out : json(out);
  }
  throw new HttpError(400, 'Unknown action');
}

async function withErrors(run) {
  try {
    return await run();
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    return json({ ok: false, error: status === 500 ? 'Server error.' : err.message }, status);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname === '/api/') return withErrors(() => handleApi(request, env, ctx));
    if (url.pathname === '/api/upload') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return withErrors(() => handleUpload(request, env, loadForm));
    }
    if (url.pathname === '/api/media') return withErrors(() => handleMedia(request, env));
    if (url.pathname.startsWith('/f/')) return withErrors(() => serveFile(request, env, url));
    if (url.pathname.startsWith('/m/')) return withErrors(() => serveMedia(env, url));
    // Tells the static frontend (served from the same Worker) to use this API.
    if (url.pathname === '/belajarlagiform-config.js') {
      return new Response('window.BELAJARLAGIFORM_CONFIG={backend:"cloud",apiUrl:"/api"};', {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      });
    }
    // Custom form link: /<slug> shows the form page; form.js reads the slug from the path.
    if (env.ASSETS && request.method === 'GET' && /^\/[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(url.pathname)) {
      if (await formIdForSlug(env, url.pathname.slice(1))) return formPage(env, url);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([syncSheets(env), purgeOldPartials(env), purgePendingUploads(env), auth.purgeAuth(env)]));
  },
};
