// Example data for the preview Artifact, so every tab has something to show.
// Everything written here is fictitious and labelled as such in the UI.
import { END, firstQuestionId, nextQuestionId, scaleRange, partialsEnabled, contactFrom, variantForm, uid } from './logic.js';

const NAMES = ['Ayu', 'Budi', 'Citra', 'Dimas', 'Eka', 'Fajar', 'Gita', 'Hendra', 'Intan', 'Joko', 'Kirana', 'Lukman', 'Maya', 'Nanda', 'Oki', 'Putri', 'Rizky', 'Sari', 'Tono', 'Wulan'];
// Rough shape of Indonesian ad traffic: mostly phones, mostly Meta.
const DEVICES = [['mobile', 0.74], ['desktop', 0.22], ['tablet', 0.04]];
const SOURCES = [['facebook', 0.34], ['instagram', 0.26], ['(langsung)', 0.14], ['google', 0.1], ['tiktok', 0.09], ['whatsapp', 0.07]];
const EXPERIMENT_DAYS = 12;

function rng(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

function weighted(r, pairs) {
  let t = r();
  for (const [v, w] of pairs) { if ((t -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

/**
 * The sample form plus what the new tabs need: a KTM upload for students
 * (with logic), and a running A/B test whose variant B has another headline.
 */
export function demoForm(form) {
  const f = structuredClone(form);
  const [qName, , , qRole, qSize, qNps] = f.questions;
  const qKtm = {
    id: uid(), type: 'file_upload', title: `${'{{'}${qName.id}}}, unggah foto KTM Anda`,
    description: 'Mahasiswa mendapat potongan 50% untuk kelas lanjutan. Foto hanya bisa dilihat tim kami.',
    required: false, settings: { fileKind: 'image', maxSizeMb: 5, maxFiles: 1 }, logic: [], next: qNps.id,
  };
  qRole.logic = [
    { match: 'all', conditions: [{ field: qRole.id, op: 'eq', value: 'Mahasiswa' }], goto: qKtm.id },
    { match: 'all', conditions: [{ field: qRole.id, op: 'eq', value: 'Karyawan' }], goto: qNps.id },
  ];
  qRole.next = qSize.id; // business owners: number of employees
  f.questions.splice(f.questions.indexOf(qSize), 0, qKtm);
  const b = structuredClone({ welcome: f.welcome, questions: f.questions, thankyou: f.thankyou, theme: f.theme });
  b.welcome.title = 'Belajar Data Analytics gratis: 60 menit, langsung praktik';
  b.welcome.description = 'Isi 1 menit. Link Zoom dan materi dikirim ke WhatsApp Anda.';
  f.variants = { B: b };
  f.experiment = { id: uid('x'), status: 'running', split: 50, startedAt: new Date(Date.now() - EXPERIMENT_DAYS * 86400000).toISOString() };
  return f;
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

/** A few placeholder "KTM" cards drawn on a canvas, stored like real uploads (IndexedDB). */
async function demoKtmFiles(formId, count = 6) {
  const colors = ['#3967BD', '#0B7A46', '#8A5A2B', '#6D28D9', '#C2410C', '#0E7490'];
  const out = [];
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('formflow', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    for (let i = 0; i < count; i++) {
      const c = document.createElement('canvas');
      c.width = 480; c.height = 300;
      const g = c.getContext('2d');
      g.fillStyle = '#F4F6FA'; g.fillRect(0, 0, 480, 300);
      g.fillStyle = colors[i % colors.length]; g.fillRect(0, 0, 480, 64);
      g.fillStyle = '#fff'; g.font = 'bold 22px sans-serif'; g.fillText('KARTU TANDA MAHASISWA', 24, 41);
      g.fillStyle = '#C9D2E3'; g.fillRect(24, 92, 120, 150);
      g.fillStyle = '#060B14'; g.font = 'bold 24px sans-serif'; g.fillText(NAMES[(i * 3) % NAMES.length], 168, 120);
      g.font = '18px sans-serif'; g.fillStyle = '#4A5568';
      g.fillText(`NIM 21${String(1000 + i * 137).padStart(6, '0')}`, 168, 154);
      g.fillText('Universitas Contoh', 168, 184);
      g.fillStyle = colors[i % colors.length]; g.font = 'bold 14px sans-serif'; g.fillText('CONTOH · BUKAN DOKUMEN ASLI', 168, 232);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
      const ref = `idb:demo_ktm_${i}`;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ blob, name: `ktm-${NAMES[(i * 3) % NAMES.length].toLowerCase()}.jpg`, type: 'image/jpeg', size: blob.size, formId }, ref);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      out.push({ ref, name: `ktm-${NAMES[(i * 3) % NAMES.length].toLowerCase()}.jpg`, type: 'image/jpeg', size: blob.size });
    }
  } catch { /* no canvas/IndexedDB: the upload question just shows no files */ }
  return out;
}

/** A small fictitious team with some history, for the Tim dialog. */
function demoTeam(form) {
  const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
  return {
    me: 'u_you',
    members: [
      { id: 'u_you', name: 'Anda', email: 'anda@contoh.id', role: 'owner', createdAt: ago(24 * 60), lastSeenAt: ago(0) },
      { id: 'u_rina', name: 'Rina Wulandari', email: 'rina@contoh.id', role: 'admin', createdAt: ago(24 * 40), lastSeenAt: ago(3) },
      { id: 'u_dimas', name: 'Dimas Pratama', email: 'dimas@contoh.id', role: 'editor', createdAt: ago(24 * 30), lastSeenAt: ago(26) },
      { id: 'u_sari', name: 'Sari (Admisi)', email: 'sari@contoh.id', role: 'viewer', createdAt: ago(24 * 20), lastSeenAt: ago(1) },
    ],
    invites: [{ id: 'i_demo1', email: 'tim.iklan@contoh.id', role: 'viewer', createdAt: ago(20), expiresAt: new Date(Date.now() + 6 * 86400000).toISOString() }],
    activity: [
      { ts: ago(2), actor: 'Sari (Admisi)', action: 'account.password', target: 'sari@contoh.id', detail: '' },
      { ts: ago(20), actor: 'Rina Wulandari', action: 'team.invite', target: 'tim.iklan@contoh.id', detail: 'viewer' },
      { ts: ago(24 * EXPERIMENT_DAYS), actor: 'Dimas Pratama', action: 'experiment.start', target: form.title, detail: '' },
      { ts: ago(24 * EXPERIMENT_DAYS + 1), actor: 'Dimas Pratama', action: 'form.publish', target: form.title, detail: '' },
      { ts: ago(24 * 20), actor: 'Sari (Admisi)', action: 'team.join', target: 'sari@contoh.id', detail: 'viewer' },
      { ts: ago(24 * 30), actor: 'Dimas Pratama', action: 'team.join', target: 'dimas@contoh.id', detail: 'editor' },
    ],
  };
}

/**
 * Writes ~320 visits over the last 14 days into the local backend's storage:
 * devices and sources, the A/B split during the test, drop-offs, KTM uploads.
 */
export async function seedExampleData(form, { days = 14, sessions = 320, seed = 42 } = {}) {
  const r = rng(seed);
  const responses = [];
  const events = [];
  const partials = {};
  const now = Date.now();
  const testStart = form.experiment ? new Date(form.experiment.startedAt).getTime() : Infinity;
  const ktm = await demoKtmFiles(form.id);
  for (let i = 0; i < sessions; i++) {
    // Traffic grows towards today, like a campaign ramping up.
    const dayAgo = Math.floor((1 - Math.sqrt(r())) * days);
    const t0 = now - dayAgo * 86400000 - Math.floor(r() * 10 * 3600000);
    const sessionId = `s_demo${i}`;
    const ts = (dt) => new Date(Math.min(now, t0 + dt * 1000)).toISOString();
    const device = weighted(r, DEVICES);
    const source = weighted(r, SOURCES);
    const v = t0 >= testStart ? (r() < 0.5 ? 'B' : 'A') : null;
    const dims = { device, source, variant: v ? `${form.experiment.id}:${v}` : '' };
    const shown = v === 'B' ? variantForm(form, 'B') : form;
    events.push({ ts: ts(0), sessionId, type: 'view', path: [], ...dims });
    // Desktop visitors from search leave more often; variant B's headline keeps more people.
    const bounce = 0.24 + (device === 'desktop' ? 0.14 : 0) + (source === 'tiktok' ? 0.08 : 0) - (v === 'B' ? 0.08 : 0);
    if (r() < bounce) continue;

    const answers = {};
    const path = [];
    let id = firstQuestionId(shown);
    let completed = false;
    while (id && id !== END) {
      const q = shown.questions.find((x) => x.id === id);
      path.push(id);
      if (r() < (device === 'desktop' ? 0.1 : 0.06)) break; // dropped off at this question
      const a = q.type === 'file_upload' ? (ktm.length && r() < 0.8 ? [ktm[i % ktm.length]] : undefined) : answerFor(q, r, i);
      if (a !== undefined && q.type !== 'statement') answers[id] = a;
      id = nextQuestionId(shown, id, answers);
      if (id === END) completed = true;
    }
    events.push({ ts: ts(5), sessionId, type: 'start', path: path.slice(0, 1), ...dims });
    const duration = 25 + Math.floor(r() * 120);
    if (completed) {
      const hidden = source === '(langsung)' || source === 'google' ? {} : { utm_source: source, utm_campaign: 'kelas-gratis' };
      responses.push({
        responseId: `r_demo${i}`, submittedAt: ts(duration), answers, hidden,
        meta: { sessionId, path, durationSec: duration, ...dims },
      });
      events.push({ ts: ts(duration), sessionId, type: 'complete', path, ...dims });
    } else {
      events.push({ ts: ts(duration / 2), sessionId, type: 'abandon', path, ...dims });
      const contact = partialsEnabled(form) && contactFrom(shown, answers);
      if (contact) {
        const kept = Object.fromEntries(Object.entries(answers).filter(([k]) => shown.questions.find((q) => q.id === k)?.type !== 'file_upload'));
        partials[sessionId] = {
          sessionId, updatedAt: ts(duration / 2), answers: kept, hidden: source === '(langsung)' ? {} : { utm_source: source }, contact,
          lastQuestion: path[path.length - 1], answeredCount: Object.keys(kept).length,
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
    localStorage.setItem('tf_team', JSON.stringify(demoTeam(form)));
  } catch { /* storage unavailable: the Results tab simply starts empty */ }
  return { responses: responses.length, sessions };
}
