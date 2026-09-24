// Pure analytics aggregation shared by every backend.
// responses: [{ submittedAt: ISO, responseId, answers: {qid: value}, hidden: {k: v} }]
// events:    [{ ts: ISO, sessionId, type: 'view'|'start'|'abandon'|'complete', path: [qid] }]

import { scaleRange, plainTitle } from './logic.js';

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

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

export function computeStats(form, responses, events, { days = 30, today = new Date() } = {}) {
  const questions = (form.questions || []).filter((q) => q.type !== 'statement');

  // --- Sessions -------------------------------------------------------------
  const sessions = new Map();
  for (const e of events) {
    if (!e.sessionId) continue;
    const s = sessions.get(e.sessionId) || { view: false, start: false, complete: false, path: [], ts: e.ts };
    if (e.type === 'view') s.view = true;
    if (e.type === 'start') s.start = true;
    if (e.type === 'complete') { s.complete = true; s.start = true; }
    if (e.type === 'abandon') s.start = s.start || (e.path || []).length > 0;
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
  const perQuestion = questions.map((q) => {
    const values = responses.map((r) => r.answers?.[q.id]).filter((v) => v !== undefined && v !== null && v !== '');
    const base = { id: q.id, title: plainTitle(q.title), type: q.type, answered: values.length };
    if (q.type === 'multiple_choice' || q.type === 'dropdown' || q.type === 'yes_no') {
      const labels = q.type === 'yes_no' ? ['Ya', 'Tidak'] : (q.options || []).map((o) => o.label);
      const counts = Object.fromEntries(labels.map((l) => [l, 0]));
      for (const v of values) {
        for (const item of splitMulti(v, q.options)) counts[item] = (counts[item] || 0) + 1;
      }
      return { ...base, kind: 'choice', counts };
    }
    if (q.type === 'rating' || q.type === 'opinion_scale' || q.type === 'number') {
      const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      const out = { ...base, kind: 'numeric', avg, median: median(nums), min: nums[0] ?? null, max: nums[nums.length - 1] ?? null };
      if (q.type !== 'number') {
        const { min, max } = scaleRange(q);
        out.counts = {};
        for (let i = min; i <= max; i++) out.counts[i] = 0;
        nums.forEach((n) => { if (out.counts[n] !== undefined) out.counts[n]++; });
        if (q.type === 'opinion_scale' && max - min === 10) {
          // Net Promoter Score when the scale is 0–10.
          const promoters = nums.filter((n) => n >= 9).length;
          const detractors = nums.filter((n) => n <= 6).length;
          out.nps = nums.length ? Math.round(((promoters - detractors) / nums.length) * 100) : null;
        }
      }
      return out;
    }
    const recent = responses
      .filter((r) => r.answers?.[q.id])
      .slice(-5)
      .reverse()
      .map((r) => String(r.answers[q.id]));
    return { ...base, kind: 'text', recent };
  });

  // --- Traffic sources (UTM hidden fields) ---------------------------------
  const sources = {};
  for (const r of responses) {
    const src = r.hidden?.utm_source || (r.hidden?.fbclid ? 'facebook (fbclid)' : '(direct)');
    sources[src] = (sources[src] || 0) + 1;
  }

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
    sources,
  };
}

export function toCSV(form, responses) {
  const qs = (form.questions || []).filter((q) => q.type !== 'statement');
  const hiddenKeys = form.hiddenFields || [];
  const head = ['Submitted At', 'Response ID', ...qs.map((q) => plainTitle(q.title)), ...hiddenKeys];
  const esc = (v) => {
    let s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = responses.map((r) => [
    r.submittedAt, r.responseId, ...qs.map((q) => r.answers?.[q.id]), ...hiddenKeys.map((k) => r.hidden?.[k]),
  ]);
  return [head, ...rows].map((row) => row.map(esc).join(',')).join('\n');
}
