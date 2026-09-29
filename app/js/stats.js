// Pure analytics aggregation shared by every backend.
// responses: [{ submittedAt: ISO, responseId, answers: {qid: value}, hidden: {k: v}, meta: {sessionId, device, source, variant} }]
// events:    [{ ts: ISO, sessionId, type: 'view'|'start'|'abandon'|'partial'|'complete', path: [qid], device?, source?, variant? }]

import { scaleRange, plainTitle, isFileList, answerText, allQuestions, withAllQuestions } from './logic.js';

export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function lastNDays(n, today = new Date()) {
  const out = [];
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

export function splitMulti(value, options) {
  if (Array.isArray(value)) return value;
  const s = String(value ?? '').trim();
  if (!s) return [];
  // Labels that contain ", " would be split wrongly, so match known labels first.
  const known = (options || []).map((o) => o.label).filter((l) => s === l || s.includes(l));
  if (known.length) {
    let rest = s;
    known.forEach((l) => { rest = rest.split(l).join(''); });
    const others = rest.split(',').map((x) => x.trim()).filter(Boolean);
    return [...known, ...others];
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}


// ─── Segments: views / starts / completions per device, source, A/B variant ─
export const SEGMENT_DIMS = ['device', 'source', 'variant'];

function emptySegments() {
  return Object.fromEntries(SEGMENT_DIMS.map((d) => [d, {}]));
}

/** The segment values a session is counted under: fixed by its first event that carries them. */
export function segmentDims(x = {}) {
  const dims = { device: String(x.device || ''), source: String(x.source || ''), variant: String(x.variant || '') };
  return dims.device || dims.source || dims.variant ? dims : null;
}

function bumpSegments(seg, dims, field) {
  if (!dims) return;
  for (const d of SEGMENT_DIMS) {
    const v = dims[d];
    if (!v) continue;
    const row = (seg[d][v] ||= { views: 0, starts: 0, completions: 0 });
    row[field]++;
  }
}

export function computeStats(form, responses, events, { days = 30, today = new Date() } = {}) {
  const merged = withAllQuestions(form); // A + questions only variant B has
  const questions = allQuestions(form).filter((q) => q.type !== 'statement');

  // --- Sessions -------------------------------------------------------------
  const sessions = new Map();
  for (const e of events) {
    if (!e.sessionId) continue;
    const s = sessions.get(e.sessionId) || { view: false, start: false, complete: false, path: [], ts: e.ts, dims: null };
    s.dims ||= segmentDims(e);
    if (e.type === 'view') s.view = true;
    if (e.type === 'start') s.start = true;
    if (e.type === 'complete') { s.complete = true; s.start = true; }
    // 'partial' = progress saved after contact details were entered; same funnel meaning as 'abandon'.
    if (e.type === 'abandon' || e.type === 'partial') s.start = s.start || (e.path || []).length > 0;
    if ((e.path || []).length > s.path.length) s.path = e.path;
    sessions.set(e.sessionId, s);
  }
  const all = [...sessions.values()];
  const views = all.filter((s) => s.view).length;
  const starts = all.filter((s) => s.start).length;
  // Submissions are the source of truth for completions (events can be blocked).
  const completions = responses.length;

  // --- Daily trend ----------------------------------------------------------
  const range = lastNDays(days, today);
  const daily = Object.fromEntries(range.map((d) => [d, { date: d, views: 0, starts: 0, completions: 0 }]));
  for (const s of all) {
    const k = dayKey(s.ts);
    if (daily[k]) {
      if (s.view) daily[k].views++;
      if (s.start) daily[k].starts++;
    }
  }
  for (const r of responses) {
    const k = dayKey(r.submittedAt);
    if (daily[k]) daily[k].completions++;
  }

  // --- Funnel / drop-off ----------------------------------------------------
  const tracked = all.filter((s) => s.path.length);
  const funnel = questions.map((q) => {
    const reached = tracked.filter((s) => s.path.includes(q.id)).length;
    const droppedHere = tracked.filter((s) => !s.complete && s.path[s.path.length - 1] === q.id).length;
    return { id: q.id, title: plainTitle(q.title), reached, droppedHere, dropRate: reached ? droppedHere / reached : 0 };
  });

  // --- Per-question distributions ------------------------------------------
  const hist = {}; // question id → { value: count }, same shape the Worker stores in D1
  const answered = {};
  for (const r of responses) {
    for (const [qid, value] of answerIncrements(merged, r.answers || {}, r.hidden || {}, r.meta || {})) {
      if (value === ANSWERED) { answered[qid] = (answered[qid] || 0) + 1; continue; }
      (hist[qid] ||= {})[value] = (hist[qid][value] || 0) + 1;
    }
  }
  const recentValues = (q) => responses.filter((r) => r.answers?.[q.id]).slice(-RECENT).reverse().map((r) => r.answers[q.id]);
  const perQuestion = questions.map((q) => questionSummary(q, hist[q.id] || {}, answered[q.id] || 0, recentValues(q)));

  // --- Segments -------------------------------------------------------------
  const segments = emptySegments();
  for (const s of all) {
    if (s.view) bumpSegments(segments, s.dims, 'views');
    if (s.start) bumpSegments(segments, s.dims, 'starts');
  }
  for (const r of responses) bumpSegments(segments, sessions.get(r.meta?.sessionId)?.dims || segmentDims(r.meta), 'completions');

  return {
    views,
    starts,
    completions,
    startRate: views ? starts / views : 0,
    completionRate: views ? completions / views : 0,
    completionOfStarts: starts ? Math.min(1, completions / starts) : 0,
    daily: Object.values(daily),
    funnel,
    perQuestion,
    segments,
    medianDurationSec: histogramMedian(hist[DURATION_KEY] || {}),
  };
}

/**
 * Views / starts / completions per day and variant for one A/B test, from raw
 * events: the same rows the Worker returns from its segments table.
 */
export function experimentDays(responses, events, experimentId) {
  const prefix = `${experimentId}:`;
  const sessions = new Map();
  for (const e of events) {
    if (!e.sessionId) continue;
    const s = sessions.get(e.sessionId) || { view: false, start: false, variant: '', day: dayKey(e.ts) };
    s.variant ||= String(e.variant || '');
    if (e.type === 'view') s.view = true;
    if (e.type === 'start' || e.type === 'complete' || ((e.type === 'abandon' || e.type === 'partial') && (e.path || []).length)) s.start = true;
    sessions.set(e.sessionId, s);
  }
  const rows = {};
  const bump = (day, tag, field) => {
    if (!day || !tag.startsWith(prefix)) return;
    const variant = tag.slice(prefix.length);
    (rows[`${day}|${variant}`] ||= { day, variant, views: 0, starts: 0, completions: 0 })[field]++;
  };
  for (const s of sessions.values()) {
    if (s.view) bump(s.day, s.variant, 'views');
    if (s.start) bump(s.day, s.variant, 'starts');
  }
  for (const r of responses) bump(dayKey(r.submittedAt), sessions.get(r.meta?.sessionId)?.variant || String(r.meta?.variant || ''), 'completions');
  return Object.values(rows).sort((x, y) => x.day.localeCompare(y.day) || x.variant.localeCompare(y.variant));
}

// ─── Shared aggregation rules (browser + Cloudflare Worker) ─────────────────
export const ANSWERED = '__n__';
export const DURATION_KEY = '__duration';
const COUNTED = new Set(['multiple_choice', 'dropdown', 'yes_no', 'rating', 'opinion_scale', 'number']);
const RECENT = 8; // latest answers kept per text / file question

/**
 * Counter increments for one submission: [questionId, value] pairs.
 * The Worker turns each pair into `answer_counts.count += 1`, so the dashboard
 * never needs to scan raw responses.
 */
export function answerIncrements(form, answers, hidden = {}, meta = {}) {
  const out = [];
  for (const q of form.questions || []) {
    const v = answers[q.id];
    if (q.type === 'statement' || v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out.push([q.id, ANSWERED]);
    if (!COUNTED.has(q.type)) continue;
    if (q.type === 'multiple_choice' || q.type === 'dropdown') {
      for (const item of splitMulti(v, q.options)) out.push([q.id, String(item).slice(0, 200)]);
    } else if (q.type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out.push([q.id, String(n)]);
    } else {
      out.push([q.id, String(v)]);
    }
  }
  const d = Number(meta.durationSec);
  if (d > 0 && d < 7200) out.push([DURATION_KEY, String(Math.round(d / 5) * 5)]);
  return out;
}

function histogramEntries(hist) {
  return Object.entries(hist).map(([k, c]) => [Number(k), Number(c)]).filter(([k, c]) => Number.isFinite(k) && c > 0).sort((a, b) => a[0] - b[0]);
}

export function histogramMedian(hist) {
  const e = histogramEntries(hist);
  const total = e.reduce((a, [, c]) => a + c, 0);
  if (!total) return null;
  const at = (rank) => { let seen = 0; for (const [k, c] of e) { seen += c; if (seen > rank) return k; } return e[e.length - 1][0]; };
  return total % 2 ? at((total - 1) / 2) : (at(total / 2 - 1) + at(total / 2)) / 2;
}

/**
 * Summary card data for one question from its value histogram.
 * `recent` = the latest raw answers, newest first.
 */
export function questionSummary(q, hist, answered, recent = []) {
  const base = { id: q.id, title: plainTitle(q.title), type: q.type, answered };
  if (q.type === 'multiple_choice' || q.type === 'dropdown' || q.type === 'yes_no') {
    const labels = q.type === 'yes_no' ? ['Ya', 'Tidak'] : (q.options || []).map((o) => o.label);
    const counts = Object.fromEntries(labels.map((l) => [l, 0]));
    for (const [k, c] of Object.entries(hist)) counts[k] = (counts[k] || 0) + Number(c);
    return { ...base, kind: 'choice', counts };
  }
  if (q.type === 'rating' || q.type === 'opinion_scale' || q.type === 'number') {
    const e = histogramEntries(hist);
    const n = e.reduce((a, [, c]) => a + c, 0);
    const out = {
      ...base, kind: 'numeric',
      avg: n ? e.reduce((a, [k, c]) => a + k * c, 0) / n : null,
      median: histogramMedian(hist),
      min: n ? e[0][0] : null,
      max: n ? e[e.length - 1][0] : null,
    };
    if (q.type !== 'number') {
      const { min, max } = scaleRange(q);
      out.counts = {};
      for (let i = min; i <= max; i++) out.counts[i] = 0;
      e.forEach(([k, c]) => { if (out.counts[k] !== undefined) out.counts[k] += c; });
      if (q.type === 'opinion_scale' && max - min === 10) {
        // Net Promoter Score when the scale is 0–10.
        const promoters = e.filter(([k]) => k >= 9).reduce((a, [, c]) => a + c, 0);
        const detractors = e.filter(([k]) => k <= 6).reduce((a, [, c]) => a + c, 0);
        out.nps = n ? Math.round(((promoters - detractors) / n) * 100) : null;
      }
    }
    return out;
  }
  if (q.type === 'file_upload') {
    return { ...base, kind: 'files', files: recent.flatMap((v) => (isFileList(v) ? v : [])).slice(0, 12) };
  }
  return { ...base, kind: 'text', recent: recent.slice(0, 5).map(answerText) };
}

/**
 * Same output as computeStats(), built from D1 aggregate rows:
 *   daily:  [{ day, views, starts, completions }]
 *   funnel: [{ question_id, reached, dropped }]            (already summed over the range)
 *   counts: [{ question_id, value, count }]                 (already summed over the range)
 *   segments: [{ dim, value, views, starts, completions }]  (already summed over the range)
 *   recent: [{ submittedAt, answers, hidden, meta }]        (newest first)
 */
export function statsFromAggregates(form, { daily = [], funnel = [], counts = [], segments = [], recent = [] }, { days = 30, today = new Date() } = {}) {
  const byDay = Object.fromEntries(daily.map((d) => [d.day, d]));
  const dailyOut = lastNDays(days, today).map((date) => ({
    date, views: Number(byDay[date]?.views || 0), starts: Number(byDay[date]?.starts || 0), completions: Number(byDay[date]?.completions || 0),
  }));
  const views = dailyOut.reduce((a, d) => a + d.views, 0);
  const starts = dailyOut.reduce((a, d) => a + d.starts, 0);
  const completions = dailyOut.reduce((a, d) => a + d.completions, 0);

  const hist = {};
  const answered = {};
  for (const r of counts) {
    if (r.value === ANSWERED) answered[r.question_id] = Number(r.count);
    else (hist[r.question_id] ||= {})[r.value] = Number(r.count);
  }
  const fmap = Object.fromEntries(funnel.map((f) => [f.question_id, f]));
  const questions = allQuestions(form).filter((q) => q.type !== 'statement');
  const seg = emptySegments();
  for (const r of segments) {
    if (!seg[r.dim] || !r.value) continue;
    seg[r.dim][r.value] = { views: Number(r.views || 0), starts: Number(r.starts || 0), completions: Number(r.completions || 0) };
  }
  return {
    views,
    starts,
    completions,
    startRate: views ? starts / views : 0,
    completionRate: views ? completions / views : 0,
    completionOfStarts: starts ? Math.min(1, completions / starts) : 0,
    daily: dailyOut,
    funnel: questions.map((q) => {
      const reached = Number(fmap[q.id]?.reached || 0);
      const droppedHere = Math.max(0, Number(fmap[q.id]?.dropped || 0));
      return { id: q.id, title: plainTitle(q.title), reached, droppedHere, dropRate: reached ? droppedHere / reached : 0 };
    }),
    perQuestion: questions.map((q) => questionSummary(q, hist[q.id] || {}, answered[q.id] || 0,
      recent.filter((r) => r.answers?.[q.id]).slice(0, RECENT).map((r) => r.answers[q.id]))),
    segments: seg,
    medianDurationSec: histogramMedian(hist[DURATION_KEY] || {}),
  };
}

/** RFC 4180 CSV with spreadsheet formula injection neutralised. */
export function rowsToCSV(head, rows) {
  const esc = (v) => {
    let s = answerText(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [head, ...rows].map((row) => row.map(esc).join(',')).join('\n');
}

export function toCSV(form, responses) {
  const qs = allQuestions(form).filter((q) => q.type !== 'statement');
  const hiddenKeys = form.hiddenFields || [];
  const head = ['Submitted At', 'Response ID', ...qs.map((q) => plainTitle(q.title)), ...hiddenKeys];
  const rows = responses.map((r) => [
    r.submittedAt, r.responseId, ...qs.map((q) => r.answers?.[q.id]), ...hiddenKeys.map((k) => r.hidden?.[k]),
  ]);
  return rowsToCSV(head, rows);
}

/** Unfinished responses (contacts to follow up), newest first. */
export function partialsCSV(form, partials) {
  const qs = allQuestions(form).filter((q) => q.type !== 'statement');
  const title = (id, fallback) => plainTitle(qs.find((q) => q.id === id)?.title) || fallback || '';
  const head = ['Terakhir aktif', 'Nama', 'Email', 'Telepon', 'Berhenti di', 'utm_source', ...qs.map((q) => plainTitle(q.title))];
  const rows = partials.map((p) => [
    p.updatedAt, p.contact?.name, p.contact?.email, p.contact?.phone, title(p.lastQuestion, p.lastQuestionTitle), p.hidden?.utm_source,
    ...qs.map((q) => p.answers?.[q.id]),
  ]);
  return rowsToCSV(head, rows);
}
