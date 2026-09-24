// Example data for the preview Artifact, so the Results tab has something to
// show. Everything written here is fictitious and labelled as such in the UI.
import { END, firstQuestionId, nextQuestionId, scaleRange, partialsEnabled, contactFrom } from './logic.js';

const NAMES = ['Ayu', 'Budi', 'Citra', 'Dimas', 'Eka', 'Fajar', 'Gita', 'Hendra', 'Intan', 'Joko', 'Kirana', 'Lukman', 'Maya', 'Nanda', 'Oki', 'Putri', 'Rizky', 'Sari', 'Tono', 'Wulan'];
const SOURCES = [['facebook', 0.45], ['instagram', 0.25], ['tiktok', 0.1], [null, 0.2]];

function rng(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

function weighted(r, pairs) {
  let t = r();
  for (const [v, w] of pairs) { if ((t -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

function answerFor(q, r, i) {
  const name = NAMES[i % NAMES.length];
  switch (q.type) {
    case 'short_text': return name;
    case 'long_text': return ['Materinya jelas, ingin ada sesi lanjutan.', 'Tolong kirim rekaman kelasnya.', 'Mantap!'][Math.floor(r() * 3)];
    case 'email': return `${name.toLowerCase()}${i}@contoh.id`;
    case 'phone': return `+62 81${String(Math.floor(r() * 1e9)).padStart(9, '0')}`;
    case 'number': return 1 + Math.floor(r() ** 2 * 60);
    case 'date': return `199${Math.floor(r() * 10)}-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`;
    case 'yes_no': return r() < 0.7 ? 'Ya' : 'Tidak';
    case 'dropdown': return q.options?.[Math.floor(r() * q.options.length)]?.label;
    case 'multiple_choice': {
      const opts = (q.options || []).map((o) => o.label);
      if (!opts.length) return undefined;
      // Skewed so the bars differ: earlier options are picked more often.
      const pick = opts[Math.min(opts.length - 1, Math.floor(r() ** 1.6 * opts.length))];
      return q.settings?.multiple ? [pick] : pick;
    }
    case 'rating':
    case 'opinion_scale': {
      const { min, max } = scaleRange(q);
      return Math.round(min + (max - min) * (0.55 + 0.45 * r() ** 0.7)); // mostly positive
    }
    default: return undefined;
  }
}

/** Writes ~150 sessions over the last 14 days into the local backend's storage. */
export function seedExampleData(form, { days = 14, sessions = 150, seed = 42 } = {}) {
  const r = rng(seed);
  const responses = [];
  const events = [];
  const partials = {};
  const now = Date.now();
  for (let i = 0; i < sessions; i++) {
    // Traffic grows towards today, like a campaign ramping up.
    const dayAgo = Math.floor((1 - Math.sqrt(r())) * days);
    const t0 = now - dayAgo * 86400000 - Math.floor(r() * 10 * 3600000);
    const sessionId = `s_demo${i}`;
    const ts = (dt) => new Date(Math.min(now, t0 + dt * 1000)).toISOString();
    events.push({ ts: ts(0), sessionId, type: 'view', path: [] });
    if (r() < 0.25) continue; // bounced on the welcome screen

    const answers = {};
    const path = [];
    let id = firstQuestionId(form);
    let completed = false;
    while (id && id !== END) {
      const q = form.questions.find((x) => x.id === id);
      path.push(id);
      if (r() < 0.07) break; // dropped off at this question
      const v = answerFor(q, r, i);
      if (v !== undefined && q.type !== 'statement') answers[id] = v;
      id = nextQuestionId(form, id, answers);
      if (id === END) completed = true;
    }
    events.push({ ts: ts(5), sessionId, type: 'start', path: path.slice(0, 1) });
    const duration = 25 + Math.floor(r() * 120);
    if (completed) {
      const src = weighted(r, SOURCES);
      responses.push({
        responseId: `r_demo${i}`, submittedAt: ts(duration), answers,
        hidden: src ? { utm_source: src, utm_campaign: 'kelas-gratis' } : {},
        meta: { sessionId, path, durationSec: duration },
      });
      events.push({ ts: ts(duration), sessionId, type: 'complete', path });
    } else {
      events.push({ ts: ts(duration / 2), sessionId, type: 'abandon', path });
      const contact = partialsEnabled(form) && contactFrom(form, answers);
      if (contact) {
        const src = weighted(r, SOURCES);
        partials[sessionId] = {
          sessionId, updatedAt: ts(duration / 2), answers, hidden: src ? { utm_source: src } : {}, contact,
          lastQuestion: path[path.length - 1], answeredCount: Object.keys(answers).length,
        };
      }
    }
  }
  responses.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  try {
    localStorage.setItem(`tf_resp_${form.id}`, JSON.stringify(responses));
    localStorage.setItem(`tf_evt_${form.id}`, JSON.stringify(events));
    localStorage.setItem(`tf_part_${form.id}`, JSON.stringify(partials));
  } catch { /* storage unavailable: the Results tab simply starts empty */ }
  return { responses: responses.length, sessions };
}
