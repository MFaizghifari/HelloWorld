// Form builder UI (Typeform-style create page): question list on the left,
// a live WYSIWYG canvas in the middle, settings/design on the right.
import { getBackend } from './api.js';
import { DEFAULT_CONFIG, getConfig, saveConfig, getAdminKey, setAdminKey, serverConfig } from './config.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import {
  END, QUESTION_TYPES, OPERATORS, uid, findLogicProblems, plainTitle, nextQuestionId, partialsEnabled, DEFAULT_CONSENT_TEXT, PARTIAL_RETENTION_DAYS,
  VARIANT_KEYS, variantForm, allQuestions, FILE_KINDS, fileRules,
} from './logic.js';
import {
  applyTheme, normalizeTheme, THEME_PRESETS, FONTS, PHONE_COUNTRIES, questionNumber, welcomeScreen, questionScreen, thankYouScreen, brandLogo,
} from './renderer.js';
import { ID_PATTERNS, FB_STANDARD_EVENTS } from './tracking.js';
import { mountForm } from './runner.js';
import { mountResults } from './results.js';
import { TYPE_META, typeTile } from './types.js';
import { can, allowedTabs, ROLES } from './roles.js';
import { createTeamUI } from './team.js';
import { renderAbTab, endExperiment } from './abtest.js';

const panel = document.getElementById('panel');
const picker = document.getElementById('formPicker');
const titleInput = document.getElementById('formTitle');
let backend = getBackend();

// Set by the preview Artifact: runs on browser storage with example data, no external backend.
const DEMO = !!serverConfig().demo;

const state = {
  form: null,
  forms: [],
  user: null, // signed-in (Cloudflare) or simulated (local) member; null = admin key (Apps Script)
  variant: 'A', // which A/B variant the Konten and Logika tabs edit
  tab: 'content', // content | logic | connect | share | ab | results
  selected: null, // 'welcome' | 'ending' | question id
  side: 'settings', // settings | design
  device: 'desktop', // desktop | mobile
  dirty: false,
  sheetUrl: '',
  shareMode: 'inline',
};

// ─── A/B variants ───────────────────────────────────────────────────────────
// doc() is what the Konten and Logika tabs edit: the form itself, or, while
// variant B is selected, a view whose screens (welcome, questions, ending,
// theme) are B's and everything else is the form's. Writes land where reads
// come from, so every editor below works unchanged on either variant.
const SCREEN_KEYS = new Set(VARIANT_KEYS);
let docView = null;
function doc() {
  const f = state.form;
  const b = state.variant === 'B' ? f.variants?.B : null;
  if (!b) return f;
  if (docView?.form !== f || docView.b !== b) {
    docView = {
      form: f, b,
      proxy: new Proxy(f, {
        get: (t, k) => (SCREEN_KEYS.has(k) ? b[k] : t[k]),
        set: (t, k, v) => { if (SCREEN_KEYS.has(k)) b[k] = v; else t[k] = v; return true; },
      }),
    };
  }
  return docView.proxy;
}

/** B always carries its own copy of every screen, so edits to B never touch A. */
function normalizeVariants(f) {
  const b = f.variants?.B;
  if (!b) { if (state.variant === 'B') state.variant = 'A'; return; }
  for (const k of VARIANT_KEYS) if (b[k] === undefined) b[k] = structuredClone(f[k] ?? (k === 'questions' ? [] : {}));
}

const canEdit = () => can(state.user?.role || 'owner', 'forms.edit');

// ─── Question type catalogue (colours follow Typeform's category grouping) ──
const CATEGORIES = [
  ['contact', 'Info kontak'], ['choice', 'Pilihan'], ['text', 'Teks'], ['rating', 'Rating & skala'], ['other', 'Lainnya'],
];
const TYPE_HELP = {
  email: 'Validasi format email', phone: 'Dengan kode negara', short_text: 'Jawaban satu baris', long_text: 'Jawaban panjang',
  statement: 'Teks informasi tanpa input', multiple_choice: 'Satu atau beberapa pilihan', dropdown: 'Daftar panjang yang bisa dicari',
  yes_no: 'Dua pilihan cepat', rating: 'Bintang 3–10', opinion_scale: 'Skala angka, NPS', number: 'Angka dengan batas', date: 'Hari / bulan / tahun',
  file_upload: 'Gambar, PDF, dokumen',
};

// Longer help and a realistic sample for the "Tambah konten" preview pane.
const TYPE_DESC = {
  email: 'Kolom email dengan validasi format. Cocok sebagai kontak utama.',
  phone: 'Nomor telepon dengan pilihan kode negara, default +62.',
  short_text: 'Jawaban satu baris, misalnya nama atau jabatan.',
  long_text: 'Jawaban panjang. Responden memakai Shift + Enter untuk baris baru.',
  statement: 'Teks informasi tanpa jawaban, misalnya jadwal atau aturan kelas.',
  multiple_choice: 'Satu atau beberapa pilihan. Responden bisa menjawab dengan tombol A, B, C.',
  dropdown: 'Daftar panjang yang bisa dicari, misalnya kota atau kampus.',
  yes_no: 'Dua pilihan cepat: tombol Y untuk Ya, N untuk Tidak.',
  rating: 'Bintang 3 sampai 10. Rata-rata dan sebarannya muncul di Hasil.',
  opinion_scale: 'Skala angka. Skala 0 sampai 10 otomatis dihitung NPS di Hasil.',
  number: 'Angka dengan batas minimum dan maksimum.',
  date: 'Tanggal dengan format HH / BB / TTTT.',
  file_upload: 'Responden mengunggah file: foto KTM, CV, bukti transfer. Hanya anggota tim yang bisa membukanya.',
};
const SAMPLE = {
  email: 'Apa email Anda?', phone: 'Nomor WhatsApp yang bisa dihubungi?', short_text: 'Siapa nama Anda?',
  long_text: 'Apa yang ingin Anda pelajari di kelas ini?', statement: 'Kelas dimulai pukul 19.00 WIB lewat Zoom.',
  multiple_choice: 'Apa status Anda saat ini?', dropdown: 'Di kota mana Anda tinggal?', yes_no: 'Bersedia dihubungi lewat WhatsApp?',
  rating: 'Seberapa puas dengan kelas sebelumnya?', opinion_scale: 'Seberapa mungkin Anda merekomendasikan kami?',
  number: 'Berapa jumlah karyawan di bisnis Anda?', date: 'Kapan tanggal lahir Anda?',
  file_upload: 'Unggah foto KTM Anda',
};

function sampleQuestion(type) {
  const q = newQuestion(type);
  q.title = SAMPLE[type];
  if (type === 'multiple_choice') q.options = ['Mahasiswa', 'Karyawan', 'Pemilik bisnis'].map((label) => ({ id: uid('o'), label }));
  if (type === 'dropdown') q.options = ['Jakarta', 'Bandung', 'Surabaya'].map((label) => ({ id: uid('o'), label }));
  if (type === 'opinion_scale') Object.assign(q.settings, { labelLeft: 'Tidak mungkin', labelRight: 'Sangat mungkin' });
  return q;
}


// ─── Templates ──────────────────────────────────────────────────────────────
function defaultTheme() {
  const { name, ...t } = THEME_PRESETS[0];
  return { ...t, corners: 'small', align: 'left', brightness: 0 };
}

function blankForm() {
  const q1 = uid(); const q2 = uid(); const q3 = uid(); const q4 = uid(); const q5 = uid(); const q6 = uid();
  return {
    id: uid('f'),
    title: 'Pendaftaran Kelas',
    theme: defaultTheme(),
    welcome: { enabled: true, title: 'Daftar kelas gratis', description: 'Isi 1 menit saja. Tim kami akan menghubungi Anda.', buttonText: 'Mulai' },
    thankyou: { title: `Terima kasih, {{${q1}}}!`, description: 'Kami akan menghubungi Anda via WhatsApp dalam 1×24 jam.', buttonText: '', buttonUrl: '', redirectUrl: '' },
    questions: [
      { id: q1, type: 'short_text', title: 'Siapa nama Anda?', required: true, settings: {}, logic: [] },
      { id: q2, type: 'email', title: `Halo {{${q1}}}, apa email Anda?`, required: true, settings: {}, logic: [] },
      { id: q3, type: 'phone', title: 'Nomor WhatsApp?', required: true, settings: {}, logic: [] },
      {
        id: q4, type: 'multiple_choice', title: 'Apa status Anda saat ini?', required: true, settings: {},
        options: [{ id: uid('o'), label: 'Mahasiswa' }, { id: uid('o'), label: 'Karyawan' }, { id: uid('o'), label: 'Pemilik bisnis' }],
        logic: [{ match: 'all', conditions: [{ field: q4, op: 'neq', value: 'Pemilik bisnis' }], goto: q6 }],
      },
      { id: q5, type: 'number', title: 'Berapa jumlah karyawan di bisnis Anda?', required: false, settings: { min: 0 }, logic: [] },
      { id: q6, type: 'opinion_scale', title: 'Seberapa mungkin Anda merekomendasikan kami ke teman?', required: false, settings: { start: 0, steps: 11, labelLeft: 'Tidak mungkin', labelRight: 'Sangat mungkin' }, logic: [] },
    ],
    hiddenFields: ['utm_source', 'utm_campaign'],
    tracking: { fbPixelId: '', fbSubmitEvent: 'Lead', stepEvents: false, capi: false, ga4Id: '', gtmId: '' },
    integrations: { webhookUrl: '', notifyEmail: '' },
    recovery: { partials: true, consentText: DEFAULT_CONSENT_TEXT, resume: false },
    createdAt: new Date().toISOString(),
  };
}

function newQuestion(type) {
  const q = { id: uid(), type, title: '', required: false, settings: {}, logic: [] };
  if (QUESTION_TYPES[type].choices) q.options = [{ id: uid('o'), label: 'Pilihan 1' }, { id: uid('o'), label: 'Pilihan 2' }];
  if (type === 'rating') q.settings = { steps: 5 };
  if (type === 'opinion_scale') q.settings = { start: 0, steps: 11 };
  if (type === 'statement') q.settings = { buttonText: 'Lanjut' };
  if (type === 'file_upload') q.settings = { fileKind: 'image', maxSizeMb: 10, maxFiles: 1 };
  return q;
}

// ─── Small UI helpers ───────────────────────────────────────────────────────
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

/** In-page confirmation (window.confirm is blocked in sandboxed previews and looks foreign anyway). */
function confirmDialog(title, text, { okLabel = 'Lanjut', danger = false } = {}) {
  const dlg = document.getElementById('confirmDialog');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').textContent = text;
  const ok = document.getElementById('confirmOk');
  ok.textContent = okLabel;
  ok.classList.toggle('danger', danger);
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

/** Copy with a visible fallback: some embedded views refuse clipboard access. */
function copyText(text, done = 'Disalin ✓') {
  const ok = navigator.clipboard?.writeText(text);
  if (!ok) { toast('Salin manual: pilih teksnya lalu Ctrl/Cmd + C', 'bad'); return; }
  ok.then(() => toast(done), () => toast('Salin manual: pilih teksnya lalu Ctrl/Cmd + C', 'bad'));
}

function setUrl(query) {
  try { history.replaceState(null, '', query || location.pathname); } catch { /* sandboxed frame */ }
}

function updateStatus() {
  const s = document.getElementById('saveStatus');
  s.textContent = state.dirty ? 'Belum terbit' : 'Terbit';
  s.title = state.dirty ? 'Ada perubahan yang belum diterbitkan' : 'Semua perubahan sudah terbit';
  s.classList.toggle('dirty', state.dirty);
}

function markDirty() {
  state.dirty = true;
  updateStatus();
}

function bind(obj, key, { type = 'text', rerender = false, canvas = false, transform, placeholder } = {}) {
  const onInput = (e) => {
    let v = type === 'checkbox' ? e.target.checked : e.target.value;
    if (type === 'number' || type === 'range') v = v === '' ? '' : Number(v);
    if (transform) v = transform(v);
    obj[key] = v;
    markDirty();
    if (rerender) render();
    else if (canvas) renderCanvas();
  };
  if (type === 'checkbox') return el('input', { type: 'checkbox', checked: !!obj[key], onchange: onInput });
  if (type === 'textarea') return el('textarea', { rows: 2, value: obj[key] ?? '', placeholder, oninput: onInput });
  return el('input', { type, value: obj[key] ?? '', placeholder, oninput: onInput });
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', { text: label }), control, hint ? el('small', { class: 'muted', text: hint }) : null);
}

/** iOS-style switch row, like Typeform's settings toggles. */
function toggle(label, obj, key, { rerender = true, hint } = {}) {
  return el('label', { class: 'switch-row' },
    el('span', { class: 'switch-text' }, el('span', { text: label }), hint ? el('small', { class: 'muted', text: hint }) : null),
    el('span', { class: 'switch' },
      el('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; markDirty(); if (rerender) render(); else renderCanvas(); } }),
      el('span', { class: 'switch-slider' })));
}

function selectEl(options, value, onchange, attrs = {}) {
  return el('select', { onchange: (e) => onchange(e.target.value), ...attrs },
    options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value), text: label })));
}

function segmented(options, value, onchange) {
  return el('div', { class: 'seg' }, options.map(([v, label]) => el('button', {
    type: 'button', class: v === value ? 'active' : '', onclick: () => onchange(v),
  }, label)));
}

function qLabel(q, i) {
  return `${i + 1}. ${plainTitle(q.title) || '(tanpa judul)'}`;
}

function questionTitle(q) {
  return plainTitle(q.title) || (q.type === 'statement' ? '(pernyataan kosong)' : '(tanpa judul)');
}

function shareUrl() {
  const u = new URL('form.html', location.href);
  u.searchParams.set('id', state.form.id);
  const cfg = getConfig();
  // Carry the backend URL unless config.js already hard-codes the same one.
  if (cfg.backend === 'sheets' && cfg.sheetsUrl && cfg.sheetsUrl !== DEFAULT_CONFIG.sheetsUrl) {
    u.searchParams.set('api', cfg.sheetsUrl);
  }
  // Same-origin Worker API that the host does not announce by itself (e.g. a custom path).
  const announced = serverConfig().apiUrl || DEFAULT_CONFIG.apiUrl;
  if (cfg.backend === 'cloud' && cfg.apiUrl && cfg.apiUrl !== announced) u.searchParams.set('api', cfg.apiUrl);
  return u.href;
}

let cloudInfo = null; // { serviceAccountEmail, capi } from the Worker
async function loadCloudInfo() {
  if (backend.name !== 'cloud' || cloudInfo || !state.user) return;
  try { cloudInfo = await backend.info(); if (state.tab === 'connect') render(); } catch { /* shown elsewhere */ }
}

// ─── Content tab: sidebar ───────────────────────────────────────────────────
function ensureSelection() {
  const f = doc();
  const valid = state.selected === 'welcome' || state.selected === 'ending' || f.questions.some((q) => q.id === state.selected);
  if (!valid) state.selected = f.questions[0]?.id || 'welcome';
}

let dragId = null;
function sidebarItem(q, i) {
  const f = doc();
  const item = el('li', {
    class: `bw-item${state.selected === q.id ? ' active' : ''}`, draggable: 'true', tabindex: 0, 'data-id': q.id,
    'aria-label': `Pertanyaan ${i + 1}: ${questionTitle(q)}. Alt + panah untuk memindahkan.`,
    onclick: () => select(q.id),
    onkeydown: (e) => {
      if (e.key === 'Enter') select(q.id);
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const j = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (j < 0 || j >= f.questions.length) return;
        [f.questions[i], f.questions[j]] = [f.questions[j], f.questions[i]];
        markDirty(); render();
        panel.querySelector(`.bw-item[data-id="${q.id}"]`)?.focus();
      }
    },
    ondragstart: (e) => { dragId = q.id; e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); },
    ondragend: () => { dragId = null; item.classList.remove('dragging'); },
    ondragover: (e) => {
      if (!dragId || dragId === q.id) return;
      e.preventDefault();
      const r = item.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      item.classList.toggle('drop-before', !after);
      item.classList.toggle('drop-after', after);
    },
    ondragleave: () => item.classList.remove('drop-before', 'drop-after'),
    ondrop: (e) => {
      e.preventDefault();
      const after = item.classList.contains('drop-after');
      item.classList.remove('drop-before', 'drop-after');
      const from = f.questions.findIndex((x) => x.id === dragId);
      const [moved] = f.questions.splice(from, 1);
      let to = f.questions.findIndex((x) => x.id === q.id);
      if (after) to += 1;
      f.questions.splice(to, 0, moved);
      markDirty(); render();
    },
  },
  el('span', { class: 'bw-grip', 'aria-hidden': 'true' }, icon('grip', { size: 14 })),
  typeTile(q.type, q.type === 'statement' ? undefined : questionNumber(f, q)),
  el('span', { class: 'bw-item-title', text: questionTitle(q) }),
  (q.logic || []).length ? el('span', { class: 'bw-item-logic', title: 'Punya aturan logika' }, icon('arrowRight', { size: 12 })) : null,
  el('span', { class: 'bw-item-actions' },
    el('button', { type: 'button', class: 'icon-btn sm', title: 'Duplikat', 'aria-label': 'Duplikat', onclick: (e) => { e.stopPropagation(); duplicate(q); } }, icon('copy', { size: 14 })),
    el('button', { type: 'button', class: 'icon-btn sm danger', title: 'Hapus', 'aria-label': 'Hapus', onclick: (e) => { e.stopPropagation(); remove(q); } }, icon('trash', { size: 14 }))));
  return item;
}

function renderSidebar() {
  const f = doc();
  const w = f.welcome || {};
  const special = (id, iconName, label, sub, off) => el('li', {
    class: `bw-item bw-special${state.selected === id ? ' active' : ''}${off ? ' off' : ''}`, tabindex: 0,
    onclick: () => select(id), onkeydown: (e) => { if (e.key === 'Enter') select(id); },
  }, el('span', { class: 'type-tile neutral' }, icon(iconName, { size: 14 })),
  el('span', { class: 'bw-item-title' }, el('span', { text: label }), sub ? el('small', { text: sub }) : null));

  return el('aside', { class: 'bw-left' },
    variantNotice(),
    el('button', { class: 'btn-soft add-btn', type: 'button', onclick: openAddDialog }, icon('plus', { size: 16 }), 'Tambah konten'),
    el('div', { class: 'bw-scroll' },
      el('ul', { class: 'bw-list' }, special('welcome', 'welcome', 'Halaman pembuka', w.enabled === false ? 'nonaktif' : plainTitle(w.title || f.title), w.enabled === false)),
      el('div', { class: 'bw-list-title', text: `Pertanyaan (${f.questions.length})` }),
      el('ol', { class: 'bw-list' }, f.questions.map(sidebarItem)),
      f.questions.length ? null : el('p', { class: 'muted small bw-empty', text: 'Belum ada pertanyaan. Klik "Tambah konten".' }),
      el('div', { class: 'bw-list-title', text: 'Halaman akhir' }),
      el('ul', { class: 'bw-list' }, special('ending', 'ending', 'Terima kasih', plainTitle(f.thankyou?.title || 'Terima kasih!')))));
}

function refreshSidebarText() {
  const f = doc();
  f.questions.forEach((q) => {
    const n = panel.querySelector(`.bw-item[data-id="${q.id}"] .bw-item-title`);
    if (n) n.textContent = questionTitle(q);
  });
}

function select(id) {
  state.selected = id;
  if (state.side === 'design') state.side = 'settings';
  render();
}

function duplicate(q) {
  const f = doc();
  const copy = structuredClone(q);
  copy.id = uid();
  copy.logic = [];
  (copy.options || []).forEach((o) => { o.id = uid('o'); });
  f.questions.splice(f.questions.indexOf(q) + 1, 0, copy);
  state.selected = copy.id;
  markDirty(); render();
}

async function remove(q) {
  const f = doc();
  if (!await confirmDialog('Hapus pertanyaan?', `"${questionTitle(q)}" dan aturan logikanya akan dihapus dari form.`, { okLabel: 'Hapus', danger: true })) return;
  const i = f.questions.indexOf(q);
  f.questions.splice(i, 1);
  state.selected = f.questions[Math.max(0, i - 1)]?.id || 'welcome';
  markDirty(); render();
}

// ─── Add-content dialog ─────────────────────────────────────────────────────
/** Renders a sample of the question type with the form's own theme, like Typeform's picker. */
function showAddPreview(type) {
  const host = document.getElementById('addPreview');
  document.querySelectorAll('#addGrid .add-item').forEach((b) => b.classList.toggle('is-preview', b.dataset.type === type));
  const q = sampleQuestion(type);
  const root = el('div', { class: 'ff' });
  applyTheme(root, doc().theme);
  const screen = questionScreen({ ...variantForm(state.form, state.variant), questions: [q] }, q, { mode: 'live', answers: {}, hidden: {}, isLast: false, onSubmit: () => {}, upload: async () => { throw new Error('Contoh saja.'); } });
  root.append(el('div', { class: 'ff-stage' }, screen.el));
  host.replaceChildren(
    el('div', { class: 'add-preview-frame', inert: true, 'aria-hidden': 'true' }, root),
    el('div', { class: 'row', style: 'gap:10px' }, typeTile(type), el('h3', { text: QUESTION_TYPES[type].label })),
    el('p', { text: TYPE_DESC[type] }),
    el('p', {}, 'Klik untuk menambahkan setelah pertanyaan yang sedang dipilih.'));
}

function openAddDialog() {
  const dlg = document.getElementById('addDialog');
  const search = document.getElementById('addSearch');
  const grid = document.getElementById('addGrid');
  const draw = () => {
    const term = search.value.trim().toLowerCase();
    grid.replaceChildren(...CATEGORIES.map(([cat, label]) => {
      const types = Object.keys(TYPE_META).filter((t) => TYPE_META[t].cat === cat)
        .filter((t) => !term || QUESTION_TYPES[t].label.toLowerCase().includes(term) || TYPE_HELP[t].toLowerCase().includes(term));
      if (!types.length) return null;
      return el('section', { class: 'add-cat' }, el('h3', { text: label }), types.map((t) => el('button', {
        type: 'button', class: 'add-item', 'data-type': t,
        onclick: () => { addQuestion(t); dlg.close(); },
        onmouseenter: () => showAddPreview(t), onfocus: () => showAddPreview(t),
      }, typeTile(t), el('span', { class: 'add-item-text' }, el('strong', { text: QUESTION_TYPES[t].label }), el('small', { text: TYPE_HELP[t] })))));
    }).filter(Boolean));
    const first = grid.querySelector('.add-item');
    if (first) showAddPreview(first.dataset.type);
    else {
      document.getElementById('addPreview').replaceChildren(el('p', { text: `Tidak ada jenis pertanyaan untuk "${search.value.trim()}".` }));
    }
  };
  search.value = '';
  search.oninput = draw;
  search.onkeydown = (e) => { if (e.key === 'Enter') grid.querySelector('.add-item.is-preview, .add-item')?.click(); };
  draw();
  dlg.showModal();
  search.focus();
}

function addQuestion(type) {
  const f = doc();
  const q = newQuestion(type);
  const idx = f.questions.findIndex((x) => x.id === state.selected);
  f.questions.splice(idx === -1 ? f.questions.length : idx + 1, 0, q);
  state.selected = q.id;
  markDirty(); render();
  setTimeout(() => panel.querySelector('.bw-frame .ff-title .ff-editable')?.focus(), 50);
}

// ─── Canvas ─────────────────────────────────────────────────────────────────
function recallOptions(q) {
  const f = doc();
  const upto = q ? f.questions.indexOf(q) : f.questions.length;
  return [
    ...f.questions.slice(0, upto).filter((x) => x.type !== 'statement').map((x) => ({ token: x.id, label: plainTitle(x.title) || x.id, kind: QUESTION_TYPES[x.type].label })),
    ...(f.hiddenFields || []).map((h) => ({ token: `hidden:${h}`, label: h, kind: 'Parameter URL' })),
  ];
}

function renderCanvas() {
  const host = panel.querySelector('.bw-frame');
  if (!host) return;
  const f = doc();
  const root = el('div', { class: 'ff ff-edit' });
  applyTheme(root, f.theme);
  const stage = el('div', { class: 'ff-stage' });
  const ctx = {
    mode: 'edit',
    onEdit: (opts = {}) => {
      markDirty();
      refreshSidebarText();
      if (opts.rerender) {
        renderCanvas();
        if (opts.focusLast) {
          const labels = host.querySelectorAll('.ff-choice:not(.ff-choice-add) .ff-choice-label.ff-editable');
          labels[labels.length - 1]?.focus();
        }
      }
    },
  };
  let screen;
  if (state.selected === 'welcome') screen = welcomeScreen(f, { ...ctx, recall: recallOptions(null).filter((r) => r.token.startsWith('hidden:')) });
  else if (state.selected === 'ending') screen = thankYouScreen(f, { ...ctx, recall: recallOptions(null) });
  else {
    const q = f.questions.find((x) => x.id === state.selected);
    screen = questionScreen(f, q, {
      ...ctx, recall: recallOptions(q), isLast: nextQuestionId(f, q.id, {}) === END,
      consent: partialsEnabled(f) ? (f.recovery.consentText || DEFAULT_CONSENT_TEXT) : '',
    });
  }
  stage.append(screen.el);
  root.append(stage);
  const logo = brandLogo(f.theme);
  if (logo) root.append(logo);
  host.replaceChildren(root);
}

/** Welcome, every question, ending: the order the canvas arrows step through. */
function canvasOrder() {
  return ['welcome', ...doc().questions.map((q) => q.id), 'ending'];
}

function canvasWhere() {
  const f = doc();
  if (state.selected === 'welcome') return [el('span', { class: 'type-tile neutral' }, icon('welcome', { size: 14 })), f.welcome?.enabled === false ? 'Halaman pembuka (nonaktif)' : 'Halaman pembuka'];
  if (state.selected === 'ending') return [el('span', { class: 'type-tile neutral' }, icon('ending', { size: 14 })), 'Halaman akhir'];
  const i = f.questions.findIndex((q) => q.id === state.selected);
  const q = f.questions[i];
  return [typeTile(q.type), `Pertanyaan ${i + 1} dari ${f.questions.length}`];
}

/** A | B switch, shown once the form has a variant B. */
function variantSwitch() {
  if (!state.form.variants?.B) return null;
  return el('div', { class: 'seg seg-variant', role: 'group', 'aria-label': 'Varian yang diedit' }, ['A', 'B'].map((v) => el('button', {
    type: 'button', class: state.variant === v ? 'active' : '', 'aria-pressed': String(state.variant === v),
    title: v === 'A' ? 'Edit versi asli' : 'Edit varian B (uji A/B)',
    onclick: () => { if (state.variant !== v) { state.variant = v; state.selected = null; render(); } },
  }, el('span', { class: `ab-letter ab-letter-${v} sm`, text: v }), v === 'A' ? 'Asli' : 'Varian')));
}

function variantNotice() {
  if (state.variant !== 'B') return null;
  const running = state.form.experiment?.status === 'running';
  return el('p', { class: `variant-notice${running ? ' warn' : ''}` },
    el('span', { class: 'tag', text: 'Varian B' }),
    running ? 'Uji sedang berjalan: perubahan di sini ikut mengubah hasilnya.' : 'Anda mengedit varian B. Pengaturan Integrasi dan Bagikan berlaku untuk kedua varian.');
}

function renderCenter() {
  const order = canvasOrder();
  const at = order.indexOf(state.selected);
  const step = (d) => { const id = order[at + d]; if (id) select(id); };
  return el('section', { class: 'bw-center' },
    el('div', { class: 'bw-canvas-bar' },
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, segmented([['desktop', 'Desktop'], ['mobile', 'Ponsel']], state.device, (v) => { state.device = v; render(); }), variantSwitch()),
      el('div', { class: 'canvas-where', 'aria-live': 'polite' }, canvasWhere()),
      el('div', { class: 'canvas-nav' },
        el('button', { class: 'icon-btn sm', type: 'button', title: 'Sebelumnya', 'aria-label': 'Layar sebelumnya', disabled: at <= 0, onclick: () => step(-1) }, icon('chevronUp', { size: 18 })),
        el('button', { class: 'icon-btn sm', type: 'button', title: 'Berikutnya', 'aria-label': 'Layar berikutnya', disabled: at >= order.length - 1, onclick: () => step(1) }, icon('chevronDown', { size: 18 })))),
    el('div', { class: 'bw-canvas' }, el('div', { class: `bw-frame ${state.device}` })));
}

// ─── Right panel: question settings ─────────────────────────────────────────
function changeType(q, type) {
  q.type = type;
  if (QUESTION_TYPES[type].choices && !q.options?.length) q.options = newQuestion(type).options;
  if (QUESTION_TYPES[type].scale) q.settings = { ...q.settings, ...newQuestion(type).settings };
  if (type === 'statement') q.required = false;
  markDirty(); render();
}

/**
 * Image picker: upload a file (stored by the backend) or paste an https URL.
 * Uploaded images in local mode are data URLs, so only a thumbnail is shown.
 */
function imageField(obj, key, label, hint) {
  const picker = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', hidden: true });
  const button = el('button', { class: 'btn-soft small', type: 'button', onclick: () => picker.click() }, icon('upload', { size: 14 }), obj[key] ? 'Ganti' : 'Unggah');
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    button.disabled = true; button.lastChild.textContent = 'Mengunggah…';
    try {
      obj[key] = (await backend.uploadMedia(state.form.id, file)).url;
      markDirty(); render();
      toast('Gambar diunggah ✓');
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false; button.lastChild.textContent = obj[key] ? 'Ganti' : 'Unggah';
    }
  });
  const value = obj[key] || '';
  const inline = value.startsWith('data:');
  return el('div', { class: 'field image-field' },
    el('span', { text: label }),
    value ? el('div', { class: 'image-chip' }, el('img', { src: value, alt: '' }),
      el('span', { class: 'image-chip-name', text: inline ? 'Gambar diunggah' : value.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) }),
      el('button', { class: 'icon-btn sm', type: 'button', title: 'Hapus gambar', 'aria-label': 'Hapus gambar', onclick: () => { delete obj[key]; markDirty(); render(); } }, icon('close', { size: 14 }))) : null,
    el('div', { class: 'row image-row' },
      button, picker,
      inline ? null : bind(obj, key, { type: 'url', canvas: true, placeholder: 'atau tempel URL https://…' })),
    hint ? el('small', { class: 'muted', text: hint }) : null);
}

function imageSection(obj, { layouts = true } = {}) {
  const layout = obj.layout || 'stack';
  return el('div', { class: 'rp-section' },
    el('h4', { text: 'Gambar' }),
    imageField(obj, 'imageUrl', 'Gambar pertanyaan'),
    layouts && obj.imageUrl ? el('div', { class: 'layout-picker' }, [['stack', 'Di bawah teks'], ['split-left', 'Kiri'], ['split-right', 'Kanan']].map(([v, label]) => el('button', {
      type: 'button', class: `layout-opt${layout === v ? ' active' : ''}`, 'aria-label': `Tata letak: ${label}`,
      onclick: () => { obj.layout = v; markDirty(); render(); },
    }, el('span', { class: `layout-thumb lt-${v}` }, el('i'), el('b')), el('small', { text: label })))) : null);
}

function questionSettings(q) {
  const s = q.settings ||= {};
  const t = q.type;
  const parts = [
    el('div', { class: 'rp-section' },
      el('h4', { text: 'Jenis pertanyaan' }),
      el('div', { class: 'type-select' }, typeTile(t),
        selectEl(Object.entries(QUESTION_TYPES).map(([k, v]) => [k, v.label]), t, (v) => changeType(q, v), { 'aria-label': 'Jenis pertanyaan' }))),
  ];
  const opts = el('div', { class: 'rp-section' }, el('h4', { text: 'Pengaturan' }));
  if (t !== 'statement') opts.append(toggle('Wajib diisi', q, 'required'));
  if (t === 'multiple_choice') {
    opts.append(toggle('Boleh pilih lebih dari satu', s, 'multiple'));
    if (s.multiple) opts.append(field('Maks. pilihan (kosong = bebas)', bind(s, 'maxSelections', { type: 'number', canvas: true })));
    opts.append(toggle('Acak urutan pilihan', s, 'randomize', { hint: 'Hanya berlaku untuk responden' }), toggle('Susun horizontal', s, 'horizontal'));
  }
  if (t === 'multiple_choice' || t === 'dropdown') {
    opts.append(el('details', { class: 'bulk' },
      el('summary', { text: 'Tempel banyak pilihan sekaligus' }),
      el('textarea', {
        rows: 4, placeholder: 'Satu pilihan per baris', 'aria-label': 'Pilihan, satu per baris',
        onchange: (e) => {
          const lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return;
          (q.options ||= []).push(...lines.map((label) => ({ id: uid('o'), label })));
          markDirty(); render();
          toast(`${lines.length} pilihan ditambahkan`);
        },
      })));
  }
  if (['short_text', 'long_text', 'email', 'number'].includes(t)) opts.append(field('Placeholder', bind(s, 'placeholder', { canvas: true })));
  if (t === 'short_text' || t === 'long_text') opts.append(field('Batas karakter', bind(s, 'maxLength', { type: 'number', placeholder: t === 'short_text' ? '500' : '5000' })));
  if (t === 'number') opts.append(el('div', { class: 'row' }, field('Minimum', bind(s, 'min', { type: 'number' })), field('Maksimum', bind(s, 'max', { type: 'number' }))));
  if (t === 'phone') opts.append(field('Negara default', selectEl(PHONE_COUNTRIES.map(([iso, flag, code]) => [iso, `${flag} ${iso} (${code})`]), s.defaultCountry || 'ID', (v) => { s.defaultCountry = v; markDirty(); renderCanvas(); })));
  if (t === 'rating') opts.append(field('Jumlah bintang', segmented([3, 4, 5, 7, 10].map((n) => [n, String(n)]), Number(s.steps || 5), (v) => { s.steps = v; markDirty(); render(); })));
  if (t === 'opinion_scale') {
    opts.append(
      field('Mulai dari', segmented([[0, '0'], [1, '1']], Number(s.start ?? 0), (v) => { s.start = v; markDirty(); render(); })),
      field('Jumlah langkah', segmented([5, 7, 10, 11].map((n) => [n, String(n)]), Number(s.steps || 11), (v) => { s.steps = v; markDirty(); render(); }), 'Skala 0–10 (11 langkah) otomatis dihitung NPS di dashboard.'),
      field('Label kiri', bind(s, 'labelLeft', { canvas: true, placeholder: 'mis. Tidak mungkin' })),
      field('Label tengah', bind(s, 'labelCenter', { canvas: true })),
      field('Label kanan', bind(s, 'labelRight', { canvas: true, placeholder: 'mis. Sangat mungkin' })));
  }
  if (t === 'statement') opts.append(field('Teks tombol', bind(s, 'buttonText', { canvas: true, placeholder: 'Lanjut' })));
  if (t === 'file_upload') {
    const rules = fileRules(q);
    opts.append(...[
      field('Jenis file', segmented(Object.keys(FILE_KINDS).map((k) => [k, k === 'any' ? 'Semua' : FILE_KINDS[k].label]), rules.kind, (v) => { s.fileKind = v; markDirty(); render(); }), FILE_KINDS[rules.kind].hint),
      field('Ukuran maksimal per file', segmented([2, 5, 10, 25].map((n) => [n, `${n} MB`]), rules.maxMb, (v) => { s.maxSizeMb = v; markDirty(); render(); })),
      field('Jumlah file', selectEl([1, 2, 3, 5, 10].map((n) => [n, n === 1 ? '1 file' : `Sampai ${n} file`]), rules.maxFiles, (v) => { s.maxFiles = Number(v); markDirty(); render(); })),
      el('p', { class: 'muted small', text: 'Hanya anggota tim yang sudah masuk yang bisa membuka file. File dari pengunjung yang tidak mengirim form dihapus otomatis setelah 24 jam.' }),
      backend.name === 'cloud' && cloudInfo && cloudInfo.files === false
        ? el('p', { class: 'bad small', text: 'Penyimpanan file (R2) belum aktif di Worker, jadi upload akan gagal. Lihat README bagian "Upload file".' }) : null,
    ].filter(Boolean)); // Node.append(null) would print "null"
  }
  parts.push(opts, imageSection(q));
  parts.push(el('div', { class: 'rp-section rp-footer' },
    el('span', { class: 'rp-id', title: 'Dipakai untuk {{id}} dan kolom data', text: `ID ${q.id}` }),
    el('div', { class: 'row' },
      el('button', { class: 'btn-ghost small', type: 'button', onclick: () => duplicate(q) }, icon('copy', { size: 14 }), 'Duplikat'),
      el('button', { class: 'btn-ghost small danger', type: 'button', onclick: () => remove(q) }, icon('trash', { size: 14 }), 'Hapus'))));
  return parts;
}

function welcomeSettings() {
  const d = doc();
  const w = d.welcome ||= { enabled: true };
  if (w.enabled === undefined) w.enabled = true;
  return [
    el('div', { class: 'rp-section' }, el('h4', { text: 'Halaman pembuka' }), toggle('Tampilkan halaman pembuka', w, 'enabled'),
      el('p', { class: 'muted small', text: 'Judul, deskripsi, dan teks tombol bisa diedit langsung di kanvas.' })),
    imageSection(w, { layouts: false }),
  ];
}

function endingSettings() {
  const d = doc();
  const t = d.thankyou ||= {};
  return [el('div', { class: 'rp-section' },
    el('h4', { text: 'Halaman akhir' }),
    el('p', { class: 'muted small', text: 'Judul & deskripsi bisa diedit di kanvas. Ketik @ untuk menyebut nama responden.' }),
    field('Teks tombol (opsional)', bind(t, 'buttonText', { canvas: true, placeholder: 'mis. Kunjungi website' })),
    field('URL tombol', bind(t, 'buttonUrl', { type: 'url', placeholder: 'https://…' })),
    field('Redirect otomatis ke URL', bind(t, 'redirectUrl', { type: 'url', placeholder: 'https://wa.me/62812…' }), 'Boleh memakai {{id}} untuk menyisipkan jawaban.'),
    field('Jeda redirect (detik)', bind(t, 'redirectDelay', { type: 'number', placeholder: '2' })))];
}

// ─── Right panel: design ────────────────────────────────────────────────────
function themeObject(d = doc()) {
  const t = normalizeTheme(d.theme);
  delete t.primary; delete t.text; delete t.name;
  d.theme = t;
  return t;
}

function designPanel() {
  const t = themeObject();
  const set = (k, rerender = false) => (v) => { t[k] = v; markDirty(); if (rerender) render(); else renderCanvas(); };
  const color = (label, key) => el('label', { class: 'color-row' },
    el('span', { text: label }),
    el('span', { class: 'color-input' },
      el('input', { type: 'color', value: t[key], oninput: (e) => { set(key)(e.target.value); e.target.nextSibling.textContent = e.target.value.toUpperCase(); } }),
      el('code', { text: t[key].toUpperCase() })));
  return [
    el('div', { class: 'rp-section' }, el('h4', { text: 'Tema' }),
      el('div', { class: 'theme-grid' }, THEME_PRESETS.map((p) => {
        const active = ['background', 'question', 'answer', 'button', 'font'].every((k) => String(t[k]).toLowerCase() === String(p[k]).toLowerCase());
        return el('button', {
          type: 'button', class: `theme-card${active ? ' active' : ''}`, 'aria-label': `Tema ${p.name}`,
          onclick: () => { const { name, ...rest } = p; Object.assign(t, rest); markDirty(); render(); },
        }, el('span', { class: 'theme-swatch', style: `background:${p.background};font-family:'${p.font}',sans-serif` },
          el('span', { style: `color:${p.question}`, text: 'Pertanyaan' }),
          el('span', { style: `color:${p.answer}`, text: 'Jawaban' }),
          el('i', { style: `background:${p.button}` })),
        el('small', { text: p.name }));
      }))),
    el('div', { class: 'rp-section' }, el('h4', { text: 'Font' }),
      selectEl(Object.keys(FONTS).map((k) => [k, k]), t.font, (v) => { set('font', true)(v); })),
    el('div', { class: 'rp-section' }, el('h4', { text: 'Warna' }),
      color('Pertanyaan', 'question'), color('Jawaban', 'answer'), color('Tombol', 'button'), color('Teks tombol', 'buttonText'), color('Latar', 'background')),
    el('div', { class: 'rp-section' }, el('h4', { text: 'Logo' }),
      imageField(t, 'logoUrl', 'Logo', 'Tampil di pojok kiri atas setiap layar. PNG transparan, tinggi maksimal 36px.')),
    el('div', { class: 'rp-section' }, el('h4', { text: 'Gambar latar' }),
      imageField(t, 'backgroundImage', 'Gambar latar'),
      t.backgroundImage ? field('Kecerahan', el('input', { type: 'range', min: -80, max: 80, step: 5, value: t.brightness, oninput: (e) => set('brightness')(Number(e.target.value)) }), 'Geser kiri untuk menggelapkan, kanan untuk mencerahkan.') : null),
    el('div', { class: 'rp-section' }, el('h4', { text: 'Tata letak' }),
      field('Sudut', segmented([['none', 'Tajam'], ['small', 'Kecil'], ['large', 'Besar']], t.corners, set('corners', true))),
      field('Perataan', segmented([['left', 'Kiri'], ['center', 'Tengah']], t.align, set('align', true))),
      toggle('Sembunyikan "Dibuat dengan FormFlow"', t, 'hideBranding', { rerender: false })),
  ];
}

function renderRight() {
  const sel = state.selected;
  let body;
  if (state.side === 'design') body = designPanel();
  else if (sel === 'welcome') body = welcomeSettings();
  else if (sel === 'ending') body = endingSettings();
  else body = questionSettings(doc().questions.find((q) => q.id === sel));
  return el('aside', { class: 'bw-right' },
    el('div', { class: 'rp-tabs' },
      el('button', { type: 'button', class: state.side === 'settings' ? 'active' : '', onclick: () => { state.side = 'settings'; render(); } }, icon('settings', { size: 15 }), 'Pengaturan'),
      el('button', { type: 'button', class: state.side === 'design' ? 'active' : '', onclick: () => { state.side = 'design'; render(); } }, icon('palette', { size: 15 }), 'Desain')),
    el('div', { class: 'rp-body' }, body));
}

function renderContent() {
  ensureSelection();
  return el('div', { class: 'bw-content' }, renderSidebar(), renderCenter(), renderRight());
}

// ─── Logic tab ──────────────────────────────────────────────────────────────
function renderLogic() {
  const f = doc();
  const problems = findLogicProblems(f);
  return el('div', { class: 'bw-page' },
    el('div', { class: 'page-head page-head-row' },
      el('div', {},
        el('h1', { text: 'Logika' }),
        el('p', { text: 'Arahkan responden ke pertanyaan lain berdasarkan jawabannya. Aturan dicek dari atas ke bawah, dan aturan pertama yang cocok yang dipakai.' })),
      variantSwitch()),
    problems.length ? el('div', { class: 'callout warn' }, el('strong', { text: 'Perlu dicek' }), el('ul', {}, problems.map((p) => el('li', { text: p })))) : null,
    el('div', { class: 'logic-list' }, f.questions.map((q, idx) => logicItem(q, idx))));
}

function logicTargets(idx) {
  const f = doc();
  return [
    ...f.questions.map((q, i) => [q.id, qLabel(q, i)]).filter((_, i) => i !== idx),
    [END, 'Halaman akhir (kirim form)'],
  ];
}

function logicItem(q, idx) {
  const f = doc();
  const rules = q.logic || [];
  const nextSelect = selectEl([['', 'pertanyaan berikutnya'], ...logicTargets(idx)], q.next || '', (v) => { if (v) q.next = v; else delete q.next; markDirty(); },
    { class: 'pill-select', 'aria-label': `Selain itu, setelah "${questionTitle(q)}" lanjut ke` });
  const addRule = () => {
    (q.logic ||= []).push({ match: 'all', conditions: q.type === 'statement' ? [] : [{ field: q.id, op: 'eq', value: '' }], goto: '' });
    markDirty(); render();
  };
  const head = el('div', { class: 'logic-row' },
    typeTile(q.type, q.type === 'statement' ? undefined : questionNumber(f, q)),
    el('h3', { text: questionTitle(q) }),
    rules.length ? null : el('span', { class: 'logic-next' }, 'lanjut ke', nextSelect),
    el('button', { class: 'btn-soft small', type: 'button', onclick: addRule }, icon('plus', { size: 14 }), 'Aturan'));
  if (!rules.length) return head;
  return el('section', { class: 'logic-card' }, head,
    el('div', { class: 'rules' }, rules.map((rule, ri) => ruleBlock(q, rule, ri, idx))),
    el('div', { class: 'rule-else' }, el('span', { text: 'Selain itu, lanjut ke' }), nextSelect));
}

/** One rule, written as a sentence: Jika [field] [op] [value] dan … lompat ke [target]. */
function ruleBlock(q, rule, ri, idx) {
  const f = doc();
  const fieldOptions = [
    ...f.questions.filter((x) => x.type !== 'statement').map((x) => [x.id, qLabel(x, f.questions.indexOf(x))]),
    ...(f.hiddenFields || []).map((h) => [h, `Parameter URL: ${h}`]),
  ];
  const conds = rule.conditions || [];
  const condLine = (c, ci) => {
    const src = f.questions.find((x) => x.id === c.field);
    let value = null;
    if (!['answered', 'not_answered'].includes(c.op)) {
      if (src && (QUESTION_TYPES[src.type]?.choices || src.type === 'yes_no')) {
        const opts = src.type === 'yes_no' ? ['Ya', 'Tidak'] : (src.options || []).map((o) => o.label);
        value = selectEl([['', 'pilih…'], ...opts.map((o) => [o, o])], c.value, (v) => { c.value = v; markDirty(); }, { class: 'pill-select', 'aria-label': 'Nilai' });
      } else {
        value = el('input', { class: 'pill-input', value: c.value ?? '', placeholder: 'nilai', 'aria-label': 'Nilai', oninput: (e) => { c.value = e.target.value; markDirty(); } });
      }
    }
    return el('div', { class: 'rule-line' },
      ci === 0
        ? el('span', { class: 'rule-kw strong', text: 'Jika' })
        : selectEl([['all', 'dan'], ['any', 'atau']], rule.match || 'all', (v) => { rule.match = v; markDirty(); render(); }, { class: 'pill-select', 'aria-label': 'Gabungkan kondisi dengan' }),
      selectEl(fieldOptions, c.field, (v) => { c.field = v; c.value = ''; markDirty(); render(); }, { class: 'pill-select', 'aria-label': 'Pertanyaan' }),
      selectEl(Object.entries(OPERATORS), c.op, (v) => { c.op = v; markDirty(); render(); }, { class: 'pill-select', 'aria-label': 'Operator' }),
      value,
      conds.length > 1 ? el('button', { class: 'icon-btn sm', type: 'button', title: 'Hapus kondisi', 'aria-label': 'Hapus kondisi', onclick: () => { conds.splice(ci, 1); markDirty(); render(); } }, icon('close', { size: 14 })) : null);
  };
  return el('div', { class: 'rule' },
    el('button', { class: 'icon-btn sm danger rule-del', type: 'button', title: 'Hapus aturan', 'aria-label': `Hapus aturan ${ri + 1}`, onclick: () => { q.logic.splice(ri, 1); markDirty(); render(); } }, icon('trash', { size: 14 })),
    conds.length ? conds.map(condLine) : el('div', { class: 'rule-line' }, el('span', { class: 'rule-kw strong', text: 'Selalu' })),
    q.type === 'statement' ? null : el('button', { class: 'link-btn', type: 'button', onclick: () => { conds.push({ field: q.id, op: 'eq', value: '' }); rule.conditions = conds; markDirty(); render(); } }, icon('plus', { size: 14 }), 'Tambah kondisi'),
    el('div', { class: 'rule-line' },
      el('span', { class: 'rule-kw strong', text: 'maka lompat ke' }),
      selectEl([['', 'pilih tujuan…'], ...logicTargets(idx)], rule.goto || '', (v) => { rule.goto = v; markDirty(); render(); }, { class: 'pill-select', 'aria-label': 'Lompat ke' })));
}

// ─── Connect tab ────────────────────────────────────────────────────────────
/** Where answers go besides the Results tab: Google Sheets, email, webhook. */
function destinationsCard(ig) {
  const sheet = backend.name === 'cloud'
    ? (() => {
      const sa = cloudInfo?.serviceAccountEmail;
      return [
        el('p', { class: 'muted small', text: 'Jawaban disimpan di database Cloudflare D1, lalu disalin otomatis ke Google Sheet setiap 5 menit.' }),
        el('ol', { class: 'small steps' },
          el('li', { text: 'Buat Google Sheet kosong.' }),
          el('li', {}, 'Klik Share → tambahkan ', sa ? el('code', { text: sa }) : el('em', { text: 'email service account (lihat README)' }), ' sebagai Editor.'),
          el('li', { text: 'Tempel link Sheet-nya di bawah, lalu Terbitkan.' })),
        sa ? el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { copyText(sa, 'Email service account disalin ✓'); }, text: 'Salin email service account' }) : null,
        field('Link Google Sheet', bind(ig, 'sheetUrl', { type: 'url' }), 'Contoh: https://docs.google.com/spreadsheets/d/1AbC…/edit. Jawaban yang sudah masuk sebelum link diisi juga ikut disalin.'),
        cloudInfo && !sa ? el('p', { class: 'bad small', text: 'Worker belum punya kredensial Google (GOOGLE_SERVICE_ACCOUNT_EMAIL & GOOGLE_PRIVATE_KEY).' }) : null,
      ];
    })()
    : [
      field('Bagikan Sheet ke (email, pisahkan koma)', bind(ig, 'sheetEditors'), 'Diberi akses edit ke spreadsheet jawaban form ini saat disimpan.'),
      el('h4', { class: 'card-sub sep', text: 'Notifikasi email' }),
      field('Kirim ke (opsional)', bind(ig, 'notifyEmail', { type: 'email' }), 'Dikirim oleh Apps Script. Kuota Gmail: 100 email/hari (akun biasa), 1.500 (Workspace).'),
    ];
  return el('section', { class: 'card' },
    el('h3', { text: 'Kirim jawaban ke' }),
    el('h4', { class: 'card-sub', text: 'Google Sheets' }),
    sheet,
    el('h4', { class: 'card-sub sep', text: 'Webhook' }),
    field('URL (opsional)', bind(ig, 'webhookUrl', { type: 'url' }), 'Setiap jawaban baru di-POST (JSON) ke URL ini dari server: Make, Zapier, n8n, CRM, atau notifikasi Slack/Telegram.'));
}

function renderConnect() {
  const f = state.form;
  const tr = f.tracking ||= {};
  const ig = f.integrations ||= {};
  const validity = (key) => {
    const v = tr[key];
    if (!v) return null;
    return ID_PATTERNS[key].test(v) ? el('small', { class: 'ok', text: '✓ format valid' }) : el('small', { class: 'bad', text: '✕ format tidak valid, tidak akan dipasang' });
  };
  return el('div', { class: 'bw-page' },
    el('div', { class: 'page-head' }, el('h1', { text: 'Integrasi' }), el('p', { class: 'muted', text: 'Tracking iklan, analytics, dan ke mana jawaban dikirim.' })),
    // Two columns by job: ad tracking on the left, where answers go on the right.
    el('div', { class: 'grid2' },
      el('div', { class: 'stack' },
        el('section', { class: 'card' },
          el('h3', { text: 'Meta Pixel & Conversions API' }),
          field('Pixel ID', bind(tr, 'fbPixelId', { transform: (v) => v.trim() }), 'Angka 15–16 digit dari Events Manager.'),
          validity('fbPixelId'),
          field('Event saat form terkirim', selectEl(FB_STANDARD_EVENTS.map((e) => [e, e]), tr.fbSubmitEvent || 'Lead', (v) => { tr.fbSubmitEvent = v; markDirty(); })),
          toggle('Event FormStep per pertanyaan', tr, 'stepEvents', { hint: 'Untuk analisa funnel di Ads Manager' }),
          toggle('Conversions API (server-side)', tr, 'capi', { hint: 'Butuh backend Cloudflare atau Google Sheets' }),
          el('p', { class: 'muted small', text: 'Event otomatis: PageView, FormStart, dan event submit di atas. Event submit dikirim dari browser + server dengan event_id yang sama sehingga Meta men-deduplikasi. Access token CAPI disimpan sebagai secret FB_CAPI_TOKEN (Worker) atau Script Property (Apps Script), bukan di sini.' })),
        el('section', { class: 'card' },
          el('h3', { text: 'Google Analytics 4 & Tag Manager' }),
          field('GA4 Measurement ID', bind(tr, 'ga4Id', { transform: (v) => v.trim().toUpperCase() }), 'Format: G-XXXXXXXXXX'),
          validity('ga4Id'),
          field('GTM Container ID', bind(tr, 'gtmId', { transform: (v) => v.trim().toUpperCase() }), 'Format: GTM-XXXXXXX. Event dataLayer: form_start, form_step, form_submit.'),
          validity('gtmId'))),
      el('div', { class: 'stack' },
        el('section', { class: 'card' },
          el('h3', { text: 'Hidden fields (UTM & parameter URL)' }),
          el('p', { class: 'muted small', text: 'utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid selalu direkam otomatis. Tambahkan parameter lain (pisahkan koma), mis. ref, nama.' }),
          el('input', {
            type: 'text', value: (f.hiddenFields || []).join(', '),
            onchange: (e) => { f.hiddenFields = e.target.value.split(',').map((x) => x.trim()).filter((x) => /^[\w-]{1,40}$/.test(x)); markDirty(); render(); },
          }),
          el('p', { class: 'muted small', text: 'Sisipkan di teks dengan @ di kanvas, atau pakai sebagai kondisi di tab Logika.' })),
        destinationsCard(ig)),
      recoveryCard(f)));
}

function recoveryCard(f) {
  const rec = f.recovery ||= { partials: false, resume: false };
  const hasContact = allQuestions(f).some((q) => q.type === 'email' || q.type === 'phone');
  return el('section', { class: 'card card-span' },
    el('h3', { text: 'Pemulihan jawaban yang belum selesai' }),
    el('p', { class: 'muted small', text: 'Rata-rata 1 dari 3 orang yang mulai mengisi form berhenti di tengah (benchmark Zuko). Fitur ini membantu tim menghubungi mereka dan membiarkan responden melanjutkan.' }),
    el('div', { class: 'recovery-grid' },
      el('div', {},
        toggle('Simpan jawaban yang belum selesai', rec, 'partials', { hint: 'Mulai disimpan begitu email atau nomor telepon valid terisi. Muncul di tab Hasil → "Belum selesai".' }),
        !hasContact && rec.partials ? el('p', { class: 'bad small', text: 'Form ini belum punya pertanyaan Email atau Nomor telepon, jadi tidak ada yang bisa disimpan.' }) : null,
        rec.partials ? field('Kalimat persetujuan (tampil di bawah kolom kontak)', bind(rec, 'consentText', { type: 'textarea', placeholder: DEFAULT_CONSENT_TEXT }),
          `Diperlukan UU PDP (UU 27/2022): responden perlu tahu kontaknya disimpan sebelum form dikirim. Data dihapus otomatis saat mereka submit, atau setelah ${PARTIAL_RETENTION_DAYS} hari.`) : null,
        toggle('Lanjutkan dari pertanyaan terakhir', rec, 'resume', { hint: 'Jawaban disimpan di browser responden selama 7 hari. Matikan untuk form yang diisi di komputer bersama (mis. di kelas).' })),
      el('div', { class: 'retarget' },
        el('h4', { text: 'Retargeting di Meta Ads' }),
        el('p', { class: 'muted small', text: 'Form mengirim event FormStart (jawaban pertama), FormContact (kontak terisi), dan Lead (terkirim). Buat audiens orang yang hampir mendaftar:' }),
        el('ol', { class: 'small steps' },
          el('li', { text: 'Ads Manager → Audiens → Buat audiens → Audiens khusus → Situs web.' }),
          el('li', {}, 'Sertakan orang yang memicu ', el('code', { text: 'FormContact' }), ' dalam 14 hari terakhir.'),
          el('li', {}, 'Kecualikan orang yang memicu ', el('code', { text: 'Lead' }), ' dalam 14 hari terakhir.'),
          el('li', { text: 'Pakai audiens itu untuk iklan pengingat, mis. "Kursi tinggal sedikit".' })),
        pixelHint(f))));
}

function pixelHint(f) {
  return f.tracking?.fbPixelId ? null : el('p', { class: 'bad small', text: 'Isi Pixel ID di kartu Meta Pixel agar event di atas terkirim.' });
}

// ─── Share tab ──────────────────────────────────────────────────────────────
function renderShare() {
  const url = shareUrl();
  const origin = new URL('.', location.href).href;
  const title = (state.form.title || '').replace(/"/g, '');
  const modes = {
    inline: {
      label: 'Standar', desc: 'Form tampil di dalam halaman Anda. embed.js meneruskan event Pixel ke halaman Anda, sehingga cookie _fbp/_fbc first-party tetap terbaca.',
      code: `<div data-formflow-inline="${url}" style="height:600px"></div>\n<script src="${origin}embed.js" async></script>`,
    },
    popup: {
      label: 'Popup', desc: 'Tombol yang membuka form di jendela popup di atas halaman Anda.',
      code: `<script src="${origin}embed.js" async></script>\n<button data-formflow="${url}">Isi form</button>`,
    },
    iframe: {
      label: 'Iframe polos', desc: 'Paling sederhana, tapi Pixel berjalan di domain form, bukan domain Anda.',
      code: `<iframe src="${url}" style="width:100%;height:600px;border:0;border-radius:16px" allow="clipboard-write" title="${title}"></iframe>`,
    },
  };
  const m = modes[state.shareMode];
  return el('div', { class: 'bw-page' },
    el('div', { class: 'page-head' }, el('h1', { text: 'Bagikan' }), el('p', { class: 'muted', text: 'Bagikan link-nya langsung atau tanam form di website Anda.' })),
    state.dirty ? el('div', { class: 'callout warn', text: 'Ada perubahan yang belum diterbitkan. Klik "Terbitkan" agar link menampilkan versi terbaru.' }) : null,
    DEMO ? el('div', { class: 'callout warn', text: 'Ini pratinjau: link di bawah membuka form di tab ini dan jawabannya tersimpan di browser Anda saja. Link publik aktif setelah backend Cloudflare di-deploy.' })
      : backend.name === 'local' ? el('div', { class: 'callout warn', text: 'Mode "Browser ini saja": link hanya berfungsi di browser ini. Hubungkan backend Cloudflare atau Google Sheets di Pengaturan untuk membagikan ke publik.' }) : null,
    el('section', { class: 'card share-link' },
      el('h3', { text: 'Link form' }),
      el('div', { class: 'row' },
        el('input', { type: 'text', readonly: true, value: url, onclick: (e) => e.target.select(), 'aria-label': 'Link form' }),
        el('button', { class: 'btn', type: 'button', onclick: () => { copyText(url, 'Link disalin ✓'); } }, icon('copy', { size: 16 }), 'Salin'),
        DEMO
          ? el('button', { class: 'btn-ghost', type: 'button', onclick: async () => { if (state.dirty) await save(); openPreview(true); } }, icon('eye', { size: 16 }), 'Isi form')
          : el('a', { class: 'btn-ghost', href: url, target: '_blank', rel: 'noopener' }, icon('eye', { size: 16 }), 'Buka')),
      el('p', { class: 'muted small', text: 'Untuk iklan, tambahkan ?utm_source=…&utm_campaign=… agar sumber traffic tercatat di dashboard.' }),
      state.sheetUrl ? el('a', { class: 'small', href: state.sheetUrl, target: '_blank', rel: 'noopener', text: 'Buka Google Sheet jawaban form ini →' }) : null),
    el('h2', { class: 'section-title', text: 'Tanam di website' }),
    el('div', { class: 'embed-modes' }, Object.entries(modes).map(([k, v]) => el('button', {
      type: 'button', class: `embed-mode${state.shareMode === k ? ' active' : ''}`, onclick: () => { state.shareMode = k; render(); },
    }, el('span', { class: `embed-thumb et-${k}` }, el('i'), el('b')), el('strong', { text: v.label })))),
    el('section', { class: 'card' },
      el('div', { class: 'row between' }, el('p', { class: 'muted small', style: 'margin:0', text: m.desc }),
        el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { copyText(m.code, 'Kode disalin ✓'); } }, icon('copy', { size: 14 }), 'Salin kode')),
      el('pre', { text: m.code })));
}

// ─── A/B tab ────────────────────────────────────────────────────────────────
function renderAb() {
  const f = state.form;
  const publish = async (msg) => { markDirty(); await save(); if (!state.dirty) toast(msg); };
  return renderAbTab({
    form: f,
    canEdit: canEdit(),
    backend,
    createVariant: () => {
      f.variants = { B: structuredClone(Object.fromEntries(VARIANT_KEYS.map((k) => [k, f[k]]))) };
      f.experiment = { id: uid('x'), status: 'draft', split: 50 };
      state.variant = 'B'; state.selected = null; state.tab = 'content';
      markDirty(); render();
      toast('Varian B dibuat dari salinan form. Ubah satu hal, lalu mulai uji di tab Uji A/B.');
    },
    deleteVariant: async () => {
      if (!await confirmDialog('Hapus varian B?', 'Semua perubahan di varian B hilang. Versi asli (A) tidak berubah.', { okLabel: 'Hapus', danger: true })) return;
      delete f.variants; delete f.experiment;
      state.variant = 'A';
      markDirty(); render();
    },
    editVariant: (v) => { state.variant = v; state.selected = null; state.tab = 'content'; render(); },
    preview: (v) => openPreview(false, v),
    setSplit: (n) => { f.experiment.split = n; markDirty(); },
    start: async (split) => {
      const resume = f.experiment.status === 'paused';
      const text = resume
        ? 'Form diterbitkan sekarang dan pengunjung kembali dibagi ke A dan B.'
        : `Form diterbitkan sekarang. ${split}% pengunjung baru akan melihat varian B, sisanya versi asli. Pengunjung yang pernah datang tetap di versinya.`;
      if (!await confirmDialog(resume ? 'Lanjutkan uji A/B?' : 'Mulai uji A/B?', text, { okLabel: resume ? 'Lanjutkan' : 'Mulai uji' })) return;
      Object.assign(f.experiment, { status: 'running', split, startedAt: f.experiment.startedAt || new Date().toISOString() });
      await publish(resume ? 'Uji A/B dilanjutkan ✓' : 'Uji A/B dimulai ✓');
    },
    pause: async () => {
      if (!await confirmDialog('Jeda uji A/B?', 'Selama dijeda, semua pengunjung melihat versi asli (A). Hasil yang sudah terkumpul tetap ada.', { okLabel: 'Jeda' })) return;
      f.experiment.status = 'paused';
      await publish('Uji A/B dijeda');
    },
    end: async (_winner, snapshot) => {
      const winner = await chooseWinner(snapshot);
      if (!winner) return;
      endExperiment(f, winner, snapshot);
      state.variant = 'A';
      await publish(winner === 'B' ? 'Varian B sekarang dipakai untuk semua pengunjung ✓' : 'Uji selesai. Versi asli tetap dipakai.');
    },
  });
}

/** Asks which version to keep; resolves 'A', 'B' or null (cancel). */
function chooseWinner(snapshot) {
  const dlg = document.getElementById('confirmDialog');
  const rate = (v) => (snapshot?.[v]?.views ? `${((snapshot[v].completions / snapshot[v].views) * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%` : '–');
  document.getElementById('confirmTitle').textContent = 'Akhiri uji A/B';
  const text = document.getElementById('confirmText');
  text.textContent = `Konversi sejauh ini: A ${rate('A')}, B ${rate('B')}. Versi mana yang dipakai untuk semua pengunjung? Hasil uji tetap tersimpan di riwayat.`;
  const ok = document.getElementById('confirmOk');
  const keepA = el('button', { class: 'btn-ghost', type: 'submit', value: 'A', text: 'Pakai A (asli)' });
  ok.textContent = 'Pakai B';
  ok.value = 'B';
  ok.classList.remove('danger');
  ok.before(keepA);
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    keepA.remove();
    ok.value = 'ok';
    resolve(['A', 'B'].includes(dlg.returnValue) ? dlg.returnValue : null);
  }, { once: true }));
}

// ─── Results tab ────────────────────────────────────────────────────────────
function renderResults() {
  return el('div', { class: 'bw-page bw-page-wide' });
}

// ─── Preview dialog ─────────────────────────────────────────────────────────
let previewHandle = null;
let previewLive = false;
let previewVariant = 'A';
/**
 * live=false: Typeform-style preview, nothing is saved.
 * live=true (preview Artifact only): the published form, answers saved to this browser and shown in Results.
 */
function openPreview(live = false, variant = state.variant) {
  previewLive = live === true;
  previewVariant = variant;
  const dlg = document.getElementById('previewDialog');
  const frame = document.getElementById('previewFrame');
  const hasB = !!state.form.variants?.B;
  dlg.querySelector('.preview-bar strong').textContent = previewLive ? 'Form (jawaban disimpan)' : hasB ? `Pratinjau varian ${variant}` : 'Pratinjau';
  const start = () => {
    previewHandle?.destroy();
    // A copy, so answering the preview never touches the draft being edited.
    // The live form assigns A/B itself, like for any visitor.
    previewHandle = mountForm(frame, structuredClone(previewLive ? state.form : variantForm(state.form, variant)), previewLive
      ? { backend, embedded: true, params: new URLSearchParams('utm_source=pratinjau'), onRestart: start }
      : { preview: true, embedded: true, onRestart: start });
  };
  start();
  if (!dlg.open) dlg.showModal();
}

function setupPreview() {
  const dlg = document.getElementById('previewDialog');
  const frame = document.getElementById('previewFrame');
  document.getElementById('previewClose').append(icon('close', { size: 18 }));
  document.getElementById('previewClose').addEventListener('click', () => dlg.close());
  document.getElementById('previewRestart').addEventListener('click', () => openPreview(previewLive, previewVariant));
  document.querySelectorAll('#previewDevice button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#previewDevice button').forEach((x) => x.classList.toggle('active', x === b));
    frame.classList.toggle('mobile', b.dataset.device === 'mobile');
  }));
  dlg.addEventListener('close', () => {
    previewHandle?.destroy(); previewHandle = null;
    if (previewLive && state.tab === 'results') render(); // show the new answer
  });
}

// ─── Render / persistence ───────────────────────────────────────────────────
/** Shows only what the member's role can use (the Worker enforces the same rules). */
function applyRole() {
  const role = state.user?.role || 'owner';
  const tabs = allowedTabs(role);
  if (!tabs.includes(state.tab)) state.tab = 'results';
  document.querySelectorAll('.tb-tabs [data-tab]').forEach((b) => { b.hidden = !tabs.includes(b.dataset.tab); });
  const edit = canEdit();
  for (const id of ['save', 'saveStatus']) document.getElementById(id).hidden = !edit;
  document.querySelector('.tb-divider').hidden = !edit;
  titleInput.readOnly = !edit;
  titleInput.title = edit ? '' : 'Peran Anda hanya bisa melihat';
}

function render() {
  applyRole();
  document.querySelectorAll('.tb-tabs [data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  });
  const views = { content: renderContent, logic: renderLogic, connect: renderConnect, share: renderShare, ab: renderAb, results: renderResults };
  const scroller = panel.querySelector('.bw-page, .rp-body');
  const scroll = scroller?.scrollTop || 0;
  panel.className = `bw bw-tab-${state.tab}`;
  panel.replaceChildren(views[state.tab]());
  const again = panel.querySelector('.bw-page, .rp-body');
  if (again) again.scrollTop = scroll;
  if (state.tab === 'content') renderCanvas();
  if (state.tab === 'results') {
    mountResults(panel.querySelector('.bw-page'), {
      backend, formId: state.form.id, form: state.form, canDownload: !DEMO,
      demoNote: DEMO ? 'Kunjungan dan jawaban fiktif dari 14 hari terakhir. Isi form lewat Bagikan → Isi form, dan jawaban Anda ikut masuk ke sini.' : '',
    });
  }
  if (document.activeElement !== titleInput) titleInput.value = state.form.title || '';
  const store = document.getElementById('openSettings');
  const label = DEMO ? 'Mode demo' : { cloud: 'Cloudflare', sheets: 'Google Sheets', local: 'Browser ini' }[backend.name];
  store.replaceChildren(icon('database', { size: 14 }), el('span', { text: label }));
  store.title = DEMO ? 'Pratinjau: data tersimpan di browser ini saja' : `Data tersimpan di: ${label}. Klik untuk mengubah.`;
  if (DEMO) store.setAttribute('aria-disabled', 'true');
  updateStatus();
  loadCloudInfo();
}

async function refreshPicker() {
  try { state.forms = await backend.listForms(); } catch (err) { state.forms = []; if (err.status !== 401) toast(err.message, 'bad'); }
  const known = state.forms.some((f) => f.id === state.form.id);
  // The select always reads "Form saya"; the open form's name lives in the title field next to it.
  const mark = (id) => (id === state.form.id ? '✓ ' : '\u2003');
  picker.replaceChildren(
    el('option', { value: '__ws', hidden: true, text: 'Form saya' }),
    el('optgroup', { label: 'Form saya' },
      ...(known ? [] : [el('option', { value: state.form.id, text: `${mark(state.form.id)}${state.form.title || 'Tanpa judul'} (draf)` })]),
      ...state.forms.map((f) => el('option', { value: f.id, text: `${mark(f.id)}${f.title || f.id}` }))),
    ...(canEdit() ? [el('option', { value: '__new', text: '＋ Buat form baru' })] : []),
  );
  picker.value = '__ws';
  state.sheetUrl = state.forms.find((f) => f.id === state.form.id)?.sheetUrl || state.sheetUrl;
}

async function save() {
  if (!canEdit()) return;
  const btn = document.getElementById('save');
  btn.disabled = true; btn.textContent = 'Menerbitkan…';
  try {
    themeObject(state.form);
    if (state.form.variants?.B) themeObject(state.form.variants.B);
    const { form, sheetUrl } = await backend.saveForm(state.form);
    state.form = form;
    normalizeVariants(state.form);
    state.sheetUrl = sheetUrl || state.sheetUrl;
    state.dirty = false;
    toast(sheetUrl ? 'Terbit ✓ Google Sheet siap.' : 'Terbit ✓');
    await refreshPicker();
    setUrl(`?id=${encodeURIComponent(form.id)}`);
  } catch (err) {
    toast(`Gagal menerbitkan: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false; btn.textContent = 'Terbitkan';
    render();
  }
}

/** Loads a form into the builder; returns false (and keeps the current form) if it can't be opened. */
async function openForm(id) {
  try {
    state.form = await backend.getForm(id);
    state.selected = null; state.dirty = false; state.sheetUrl = ''; state.variant = 'A';
    normalizeVariants(state.form);
    setUrl(`?id=${encodeURIComponent(id)}`);
    await refreshPicker();
    render();
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  }
}

function newForm() {
  state.form = blankForm(); state.selected = null; state.dirty = true; state.sheetUrl = ''; state.variant = 'A';
  state.tab = 'content';
  setUrl('');
  refreshPicker().then(render);
}

function setupSettings() {
  const dlg = document.getElementById('settings');
  const form = document.getElementById('settingsForm');
  const toggleFields = () => form.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== form.backend.value; });
  document.getElementById('openSettings').addEventListener('click', () => {
    if (DEMO) { toast('Di pratinjau ini data tersimpan di browser Anda saja.'); return; }
    const cfg = getConfig();
    form.backend.value = cfg.backend;
    form.sheetsUrl.value = cfg.sheetsUrl || '';
    form.apiUrl.value = cfg.apiUrl || '/api';
    form.adminKey.value = getAdminKey();
    toggleFields();
    dlg.showModal();
  });
  form.backend.addEventListener('change', toggleFields);
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const url = form.sheetsUrl.value.trim();
    const apiUrl = form.apiUrl.value.trim() || '/api';
    if (form.backend.value === 'sheets' && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
      toast('URL Apps Script harus berbentuk https://script.google.com/macros/s/…/exec', 'bad');
      return;
    }
    if (form.backend.value === 'cloud' && !/^(\/|https:\/\/)/.test(apiUrl)) {
      toast('URL API harus diawali / atau https://', 'bad');
      return;
    }
    saveConfig({ backend: form.backend.value, sheetsUrl: url, apiUrl });
    setAdminKey(form.adminKey.value.trim());
    backend = getBackend();
    cloudInfo = null;
    toast('Pengaturan disimpan.');
    await signInIfNeeded();
    await refreshPicker();
    render();
  });
}

// ─── Accounts ───────────────────────────────────────────────────────────────
let team = null;

/** Cloudflare: a signed-in member. Local: the simulated member. Apps Script: the admin key (no accounts). */
async function signInIfNeeded() {
  if (backend.team === 'real') {
    const link = /(^|&)(join|reset)=/.test(location.hash.slice(1));
    const s = link ? null : await backend.session().catch(() => null);
    state.user = s?.user || await team.signIn();
  } else if (backend.team === 'simulated') {
    state.user = (await backend.session()).user;
  } else {
    state.user = null;
  }
  mountAccountMenu();
}

function mountAccountMenu() {
  team.mountAccount(state.user, {
    onViewAs: backend.team === 'simulated' ? async (role) => {
      await backend.viewAs(role);
      state.user = (await backend.session()).user;
      mountAccountMenu();
      await refreshPicker();
      render();
      toast(`Sekarang melihat sebagai ${ROLES[role].label}`);
    } : null,
    onSignOut: backend.team === 'real' ? async () => {
      if (state.dirty && !await confirmDialog('Keluar sekarang?', 'Ada perubahan yang belum diterbitkan. Perubahan itu akan hilang.', { okLabel: 'Keluar' })) return;
      state.dirty = false;
      await backend.logout();
      location.reload();
    } : null,
  });
}

/** The preview's example data is rebuilt when the demo gains features (bump DEMO_VERSION). */
const DEMO_VERSION = '3';
function resetOutdatedDemo() {
  try {
    if (localStorage.getItem('tf_demo_version') === DEMO_VERSION) return;
    Object.keys(localStorage).filter((k) => k.startsWith('tf_') || k.startsWith('ff_progress_') || k.startsWith('ff_ab_')).forEach((k) => localStorage.removeItem(k));
    localStorage.setItem('tf_demo_version', DEMO_VERSION);
  } catch { /* storage unavailable */ }
}

async function init() {
  document.getElementById('preview').append(icon('eye', { size: 16 }), 'Pratinjau');
  document.getElementById('addClose').append(icon('close', { size: 18 }));
  document.getElementById('addClose').addEventListener('click', () => document.getElementById('addDialog').close());
  setupSettings();
  document.querySelectorAll('.tb-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
  document.getElementById('save').addEventListener('click', save);
  setupPreview();
  document.getElementById('preview').addEventListener('click', () => openPreview(false));
  titleInput.addEventListener('input', () => {
    state.form.title = titleInput.value;
    markDirty();
    const opt = picker.querySelector(`option[value="${state.form.id}"]`);
    if (opt) opt.textContent = `✓ ${titleInput.value || 'Tanpa judul'}`;
  });
  picker.addEventListener('change', async () => {
    const v = picker.value;
    picker.value = '__ws';
    if (v === state.form.id) return;
    if (state.dirty && !await confirmDialog('Tinggalkan perubahan?', 'Ada perubahan yang belum diterbitkan di form ini. Perubahan itu akan hilang.', { okLabel: 'Tinggalkan' })) return;
    if (v === '__new') newForm(); else openForm(v);
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  });

  if (DEMO) resetOutdatedDemo();
  team = createTeamUI({ getBackend: () => backend, toast, confirmDialog, copyText });
  // A request answered 401 (session expired or ended by an admin): sign in again, keep unpublished edits.
  let reauth = null;
  window.addEventListener('formflow:signed-out', () => {
    reauth ||= team.signIn({ reason: 'Sesi Anda berakhir. Masuk lagi untuk melanjutkan. Perubahan yang belum terbit tetap ada.' })
      .then(async (user) => { state.user = user; reauth = null; mountAccountMenu(); await refreshPicker(); render(); });
  });
  await signInIfNeeded();
  const id = new URLSearchParams(location.search).get('id');
  const tab = location.hash.slice(1);
  if (['content', 'logic', 'connect', 'share', 'ab', 'results'].includes(tab)) state.tab = tab;
  state.form = blankForm();
  // A stale ?id= (deleted form, other browser) falls through to the normal start instead of a blank page.
  if (id && await openForm(id)) return;
  if (id) setUrl('');
  try { state.forms = await backend.listForms(); } catch { state.forms = []; }
  if (state.forms[0]) { await openForm(state.forms[0].id); return; }
  if (DEMO) {
    // First visit to the preview: publish the sample form and fill Results with labelled example data.
    try {
      const demo = await import('./demo.js');
      state.form = demo.demoForm(state.form);
      await backend.saveForm(state.form);
      await demo.seedExampleData(state.form);
      await signInIfNeeded(); // the example team replaces the default one
      await openForm(state.form.id);
      return;
    } catch { /* storage blocked: continue with an unsaved draft */ }
  }
  state.dirty = true;
  await refreshPicker();
  render();
}

init();
