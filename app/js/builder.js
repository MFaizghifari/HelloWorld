// Form builder UI (Typeform-style create page): question list on the left,
// a live WYSIWYG canvas in the middle, settings/design on the right.
import { getBackend } from './api.js';
import { DEFAULT_CONFIG, getConfig, saveConfig, getAdminKey, setAdminKey, serverConfig } from './config.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import {
  END, QUESTION_TYPES, OPERATORS, uid, findLogicProblems, plainTitle, nextQuestionId, partialsEnabled, DEFAULT_CONSENT_TEXT, PARTIAL_RETENTION_DAYS,
} from './logic.js';
import {
  applyTheme, normalizeTheme, THEME_PRESETS, FONTS, PHONE_COUNTRIES, questionNumber, welcomeScreen, questionScreen, thankYouScreen,
} from './renderer.js';
import { ID_PATTERNS, FB_STANDARD_EVENTS } from './tracking.js';
import { mountForm } from './runner.js';
import { mountResults } from './results.js';

const panel = document.getElementById('panel');
const picker = document.getElementById('formPicker');
const titleInput = document.getElementById('formTitle');
let backend = getBackend();

// Set by the preview Artifact: runs on browser storage with example data, no external backend.
const DEMO = !!serverConfig().demo;

const state = {
  form: null,
  forms: [],
  tab: 'content', // content | logic | connect | share | results
  selected: null, // 'welcome' | 'ending' | question id
  side: 'settings', // settings | design
  device: 'desktop', // desktop | mobile
  dirty: false,
  sheetUrl: '',
  shareMode: 'inline',
};

// ─── Question type catalogue (colours follow Typeform's category grouping) ──
const TYPE_META = {
  email: { cat: 'contact', color: '#FCE7F3', ink: '#9D174D' },
  phone: { cat: 'contact', color: '#FCE7F3', ink: '#9D174D' },
  short_text: { cat: 'text', color: '#DBEAFE', ink: '#1E40AF' },
  long_text: { cat: 'text', color: '#DBEAFE', ink: '#1E40AF' },
  statement: { cat: 'text', color: '#E5E7EB', ink: '#374151' },
  multiple_choice: { cat: 'choice', color: '#EDE9FE', ink: '#5B21B6' },
  dropdown: { cat: 'choice', color: '#EDE9FE', ink: '#5B21B6' },
  yes_no: { cat: 'choice', color: '#EDE9FE', ink: '#5B21B6' },
  rating: { cat: 'rating', color: '#FEF3C7', ink: '#92400E' },
  opinion_scale: { cat: 'rating', color: '#FEF3C7', ink: '#92400E' },
  number: { cat: 'other', color: '#D1FAE5', ink: '#065F46' },
  date: { cat: 'other', color: '#D1FAE5', ink: '#065F46' },
};
const CATEGORIES = [
  ['contact', 'Info kontak'], ['choice', 'Pilihan'], ['text', 'Teks'], ['rating', 'Rating & skala'], ['other', 'Lainnya'],
];
const TYPE_HELP = {
  email: 'Validasi format email', phone: 'Dengan kode negara', short_text: 'Jawaban satu baris', long_text: 'Jawaban panjang',
  statement: 'Teks informasi tanpa input', multiple_choice: 'Satu atau beberapa pilihan', dropdown: 'Daftar panjang yang bisa dicari',
  yes_no: 'Dua pilihan cepat', rating: 'Bintang 3–10', opinion_scale: 'Skala angka, NPS', number: 'Angka dengan batas', date: 'Hari / bulan / tahun',
};

function typeTile(type, label) {
  const m = TYPE_META[type] || { color: '#E5E7EB', ink: '#374151' };
  return el('span', { class: 'type-tile', style: `background:${m.color};color:${m.ink}` }, icon(type, { size: 14 }), label !== undefined ? el('span', { text: String(label) }) : null);
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
  if (backend.name !== 'cloud' || cloudInfo || !getAdminKey()) return;
  try { cloudInfo = await backend.info(); if (state.tab === 'connect') render(); } catch { /* shown elsewhere */ }
}

// ─── Content tab: sidebar ───────────────────────────────────────────────────
function ensureSelection() {
  const f = state.form;
  const valid = state.selected === 'welcome' || state.selected === 'ending' || f.questions.some((q) => q.id === state.selected);
  if (!valid) state.selected = f.questions[0]?.id || 'welcome';
}

let dragId = null;
function sidebarItem(q, i) {
  const f = state.form;
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
  const f = state.form;
  const w = f.welcome || {};
  const special = (id, iconName, label, sub, off) => el('li', {
    class: `bw-item bw-special${state.selected === id ? ' active' : ''}${off ? ' off' : ''}`, tabindex: 0,
    onclick: () => select(id), onkeydown: (e) => { if (e.key === 'Enter') select(id); },
  }, el('span', { class: 'type-tile', style: 'background:#E5E7EB;color:#374151' }, icon(iconName, { size: 14 })),
  el('span', { class: 'bw-item-title' }, el('span', { text: label }), sub ? el('small', { text: sub }) : null));

  return el('aside', { class: 'bw-left' },
    el('button', { class: 'btn add-btn', type: 'button', onclick: openAddDialog }, icon('plus', { size: 16 }), 'Tambah konten'),
    el('div', { class: 'bw-scroll' },
      el('ul', { class: 'bw-list' }, special('welcome', 'welcome', 'Halaman pembuka', w.enabled === false ? 'nonaktif' : plainTitle(w.title || f.title), w.enabled === false)),
      el('div', { class: 'bw-list-title', text: `Pertanyaan (${f.questions.length})` }),
      el('ol', { class: 'bw-list' }, f.questions.map(sidebarItem)),
      f.questions.length ? null : el('p', { class: 'muted small bw-empty', text: 'Belum ada pertanyaan. Klik "Tambah konten".' }),
      el('div', { class: 'bw-list-title', text: 'Halaman akhir' }),
      el('ul', { class: 'bw-list' }, special('ending', 'ending', 'Terima kasih', plainTitle(f.thankyou?.title || 'Terima kasih!')))));
}

function refreshSidebarText() {
  const f = state.form;
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
  const f = state.form;
  const copy = structuredClone(q);
  copy.id = uid();
  copy.logic = [];
  (copy.options || []).forEach((o) => { o.id = uid('o'); });
  f.questions.splice(f.questions.indexOf(q) + 1, 0, copy);
  state.selected = copy.id;
  markDirty(); render();
}

async function remove(q) {
  const f = state.form;
  if (!await confirmDialog('Hapus pertanyaan?', `"${questionTitle(q)}" dan aturan logikanya akan dihapus dari form.`, { okLabel: 'Hapus', danger: true })) return;
  const i = f.questions.indexOf(q);
  f.questions.splice(i, 1);
  state.selected = f.questions[Math.max(0, i - 1)]?.id || 'welcome';
  markDirty(); render();
}

// ─── Add-content dialog ─────────────────────────────────────────────────────
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
        type: 'button', class: 'add-item', onclick: () => { addQuestion(t); dlg.close(); },
      }, typeTile(t), el('span', { class: 'add-item-text' }, el('strong', { text: QUESTION_TYPES[t].label }), el('small', { text: TYPE_HELP[t] })))));
    }).filter(Boolean));
  };
  search.value = '';
  search.oninput = draw;
  search.onkeydown = (e) => { if (e.key === 'Enter') grid.querySelector('.add-item')?.click(); };
  draw();
  dlg.showModal();
  search.focus();
}

function addQuestion(type) {
  const f = state.form;
  const q = newQuestion(type);
  const idx = f.questions.findIndex((x) => x.id === state.selected);
  f.questions.splice(idx === -1 ? f.questions.length : idx + 1, 0, q);
  state.selected = q.id;
  markDirty(); render();
  setTimeout(() => panel.querySelector('.bw-frame .ff-title .ff-editable')?.focus(), 50);
}

// ─── Canvas ─────────────────────────────────────────────────────────────────
function recallOptions(q) {
  const f = state.form;
  const upto = q ? f.questions.indexOf(q) : f.questions.length;
  return [
    ...f.questions.slice(0, upto).filter((x) => x.type !== 'statement').map((x) => ({ token: x.id, label: plainTitle(x.title) || x.id, kind: QUESTION_TYPES[x.type].label })),
    ...(f.hiddenFields || []).map((h) => ({ token: `hidden:${h}`, label: h, kind: 'Parameter URL' })),
  ];
}

function renderCanvas() {
  const host = panel.querySelector('.bw-frame');
  if (!host) return;
  const f = state.form;
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
  host.replaceChildren(root);
}

function renderCenter() {
  const w = state.form.welcome || {};
  return el('section', { class: 'bw-center' },
    el('div', { class: 'bw-canvas-bar' },
      segmented([['desktop', 'Desktop'], ['mobile', 'Ponsel']], state.device, (v) => { state.device = v; render(); }),
      state.selected === 'welcome' && w.enabled === false ? el('span', { class: 'muted small', text: 'Halaman pembuka nonaktif — responden langsung ke pertanyaan 1.' }) : el('span', { class: 'muted small', text: 'Klik teks di kanvas untuk mengedit langsung · ketik @ untuk menyisipkan jawaban' }),
      el('button', { class: `btn-ghost small${state.side === 'design' ? ' active' : ''}`, type: 'button', onclick: () => { state.side = state.side === 'design' ? 'settings' : 'design'; render(); } }, icon('palette', { size: 16 }), 'Desain')),
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

function imageSection(obj, { layouts = true } = {}) {
  const layout = obj.layout || 'stack';
  return el('div', { class: 'rp-section' },
    el('h4', { text: 'Gambar' }),
    field('URL gambar (https)', bind(obj, 'imageUrl', { type: 'url', canvas: true, placeholder: 'https://…' })),
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
    opts.append(field('Tambah banyak pilihan sekaligus', el('textarea', {
      rows: 3, placeholder: 'Satu pilihan per baris, lalu klik di luar kotak',
      onchange: (e) => {
        const lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return;
        (q.options ||= []).push(...lines.map((label) => ({ id: uid('o'), label })));
        markDirty(); render();
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
  parts.push(opts, imageSection(q));
  parts.push(el('div', { class: 'rp-section rp-footer' },
    el('small', { class: 'muted', text: `ID: ${q.id}` }),
    el('div', { class: 'row' },
      el('button', { class: 'btn-ghost small', type: 'button', onclick: () => duplicate(q) }, icon('copy', { size: 14 }), 'Duplikat'),
      el('button', { class: 'btn-ghost small danger', type: 'button', onclick: () => remove(q) }, icon('trash', { size: 14 }), 'Hapus'))));
  return parts;
}

function welcomeSettings() {
  const w = state.form.welcome ||= { enabled: true };
  if (w.enabled === undefined) w.enabled = true;
  return [
    el('div', { class: 'rp-section' }, el('h4', { text: 'Halaman pembuka' }), toggle('Tampilkan halaman pembuka', w, 'enabled'),
      el('p', { class: 'muted small', text: 'Judul, deskripsi, dan teks tombol bisa diedit langsung di kanvas.' })),
    imageSection(w, { layouts: false }),
  ];
}

function endingSettings() {
  const t = state.form.thankyou ||= {};
  return [el('div', { class: 'rp-section' },
    el('h4', { text: 'Halaman akhir' }),
    el('p', { class: 'muted small', text: 'Judul & deskripsi bisa diedit di kanvas. Ketik @ untuk menyebut nama responden.' }),
    field('Teks tombol (opsional)', bind(t, 'buttonText', { canvas: true, placeholder: 'mis. Kunjungi website' })),
    field('URL tombol', bind(t, 'buttonUrl', { type: 'url', placeholder: 'https://…' })),
    field('Redirect otomatis ke URL', bind(t, 'redirectUrl', { type: 'url', placeholder: 'https://wa.me/62812…' }), 'Boleh memakai {{id}} untuk menyisipkan jawaban.'),
    field('Jeda redirect (detik)', bind(t, 'redirectDelay', { type: 'number', placeholder: '2' })))];
}

// ─── Right panel: design ────────────────────────────────────────────────────
function themeObject() {
  const t = normalizeTheme(state.form.theme);
  delete t.primary; delete t.text; delete t.name;
  state.form.theme = t;
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
    el('div', { class: 'rp-section' }, el('h4', { text: 'Gambar latar' }),
      field('URL gambar (https)', bind(t, 'backgroundImage', { type: 'url', canvas: true, placeholder: 'https://…' })),
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
  else body = questionSettings(state.form.questions.find((q) => q.id === sel));
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
  const f = state.form;
  const problems = findLogicProblems(f);
  const fieldOptions = [
    ...f.questions.filter((q) => q.type !== 'statement').map((q) => [q.id, qLabel(q, f.questions.indexOf(q))]),
    ...(f.hiddenFields || []).map((h) => [h, `Parameter URL: ${h}`]),
  ];
  const targetsFor = (idx) => [
    ...f.questions.map((q, i) => [q.id, qLabel(q, i)]).filter((_, i) => i !== idx),
    [END, 'Halaman akhir (kirim form)'],
  ];

  return el('div', { class: 'bw-page' },
    el('div', { class: 'page-head' },
      el('h1', { text: 'Logika' }),
      el('p', { class: 'muted', text: 'Arahkan responden ke pertanyaan berbeda berdasarkan jawabannya. Aturan dicek dari atas ke bawah; aturan pertama yang cocok menentukan lompatan. Jika tidak ada yang cocok, responden lanjut ke "Selalu lompat ke" atau pertanyaan berikutnya.' })),
    problems.length ? el('div', { class: 'callout warn' }, el('strong', { text: 'Perlu dicek' }), el('ul', {}, problems.map((p) => el('li', { text: p })))) : null,
    f.questions.map((q, idx) => el('section', { class: `logic-card${(q.logic || []).length ? ' has-rules' : ''}` },
      el('div', { class: 'logic-head' }, typeTile(q.type, q.type === 'statement' ? undefined : questionNumber(f, q)), el('h3', { text: questionTitle(q) })),
      (q.logic || []).map((rule, ri) => el('div', { class: 'rule' },
        el('div', { class: 'rule-row' },
          el('span', { class: 'rule-kw', text: 'Jika' }),
          selectEl([['all', 'semua kondisi terpenuhi'], ['any', 'salah satu kondisi terpenuhi']], rule.match || 'all', (v) => { rule.match = v; markDirty(); }),
          el('button', { class: 'icon-btn sm danger push', type: 'button', title: 'Hapus aturan', 'aria-label': 'Hapus aturan', onclick: () => { q.logic.splice(ri, 1); markDirty(); render(); } }, icon('trash', { size: 14 }))),
        (rule.conditions || []).map((c, ci) => {
          const src = f.questions.find((x) => x.id === c.field);
          const needsValue = !['answered', 'not_answered'].includes(c.op);
          let valueControl = null;
          if (needsValue) {
            if (src && (QUESTION_TYPES[src.type]?.choices || src.type === 'yes_no')) {
              const opts = src.type === 'yes_no' ? ['Ya', 'Tidak'] : (src.options || []).map((o) => o.label);
              valueControl = selectEl([['', 'pilih…'], ...opts.map((o) => [o, o])], c.value, (v) => { c.value = v; markDirty(); });
            } else {
              valueControl = bind(c, 'value', { placeholder: 'nilai' });
            }
          }
          return el('div', { class: 'rule-row cond' },
            selectEl(fieldOptions, c.field, (v) => { c.field = v; c.value = ''; markDirty(); render(); }),
            selectEl(Object.entries(OPERATORS), c.op, (v) => { c.op = v; markDirty(); render(); }),
            valueControl,
            el('button', { class: 'icon-btn sm', type: 'button', title: 'Hapus kondisi', 'aria-label': 'Hapus kondisi', onclick: () => { rule.conditions.splice(ci, 1); markDirty(); render(); } }, icon('close', { size: 14 })));
        }),
        el('button', { class: 'link-btn', type: 'button', onclick: () => { rule.conditions.push({ field: q.id, op: 'eq', value: '' }); markDirty(); render(); } }, icon('plus', { size: 14 }), 'kondisi'),
        el('div', { class: 'rule-row' }, el('span', { class: 'rule-kw', text: 'Lompat ke' }),
          selectEl([['', 'pilih tujuan…'], ...targetsFor(idx)], rule.goto || '', (v) => { rule.goto = v; markDirty(); render(); })))),
      el('div', { class: 'rule-row logic-foot' },
        el('button', { class: 'btn-ghost small', type: 'button', onclick: () => {
          (q.logic ||= []).push({ match: 'all', conditions: q.type === 'statement' ? [] : [{ field: q.id, op: 'eq', value: '' }], goto: '' });
          markDirty(); render();
        } }, icon('plus', { size: 14 }), 'Tambah aturan'),
        el('span', { class: 'muted small push', text: 'Selalu lompat ke' }),
        selectEl([['', 'pertanyaan berikutnya'], ...targetsFor(idx)], q.next || '', (v) => { if (v) q.next = v; else delete q.next; markDirty(); })))));
}

// ─── Connect tab ────────────────────────────────────────────────────────────
function sheetCard(ig) {
  if (backend.name === 'cloud') {
    const sa = cloudInfo?.serviceAccountEmail;
    return el('section', { class: 'card' },
      el('h3', { text: 'Salinan ke Google Sheets' }),
      el('p', { class: 'muted small', text: 'Jawaban disimpan di database Cloudflare D1, lalu disalin otomatis ke Google Sheet setiap 5 menit.' }),
      el('ol', { class: 'small steps' },
        el('li', { text: 'Buat Google Sheet kosong.' }),
        el('li', {}, 'Klik Share → tambahkan ', sa ? el('code', { text: sa }) : el('em', { text: 'email service account (lihat README)' }), ' sebagai Editor.'),
        el('li', { text: 'Tempel link Sheet-nya di bawah, lalu Terbitkan.' })),
      sa ? el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { copyText(sa, 'Email service account disalin ✓'); }, text: 'Salin email service account' }) : null,
      field('Link Google Sheet', bind(ig, 'sheetUrl', { type: 'url' }), 'Contoh: https://docs.google.com/spreadsheets/d/1AbC…/edit. Jawaban yang sudah masuk sebelum link diisi juga ikut disalin.'),
      cloudInfo && !sa ? el('p', { class: 'bad small', text: 'Worker belum punya kredensial Google (GOOGLE_SERVICE_ACCOUNT_EMAIL & GOOGLE_PRIVATE_KEY).' }) : null);
  }
  return el('section', { class: 'card' },
    el('h3', { text: 'Google Sheet jawaban' }),
    field('Bagikan Google Sheet ke (email, pisahkan koma)', bind(ig, 'sheetEditors'), 'Diberi akses edit ke spreadsheet jawaban form ini saat disimpan.'),
    field('Email notifikasi (opsional)', bind(ig, 'notifyEmail', { type: 'email' }), 'Dikirim oleh Apps Script. Kuota Gmail: 100 email/hari (akun biasa), 1.500 (Workspace).'));
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
    el('div', { class: 'grid2' },
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
        validity('gtmId')),
      el('section', { class: 'card' },
        el('h3', { text: 'Hidden fields (UTM & parameter URL)' }),
        el('p', { class: 'muted small', text: 'utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid selalu direkam otomatis. Tambahkan parameter lain (pisahkan koma), mis. ref, nama.' }),
        el('input', {
          type: 'text', value: (f.hiddenFields || []).join(', '),
          onchange: (e) => { f.hiddenFields = e.target.value.split(',').map((x) => x.trim()).filter((x) => /^[\w-]{1,40}$/.test(x)); markDirty(); render(); },
        }),
        el('p', { class: 'muted small', text: 'Sisipkan di teks dengan @ di kanvas, atau pakai sebagai kondisi di tab Logika.' })),
      el('section', { class: 'card' },
        el('h3', { text: 'Webhook' }),
        field('Webhook URL (opsional)', bind(ig, 'webhookUrl', { type: 'url' }), 'Setiap jawaban baru di-POST (JSON) ke URL ini dari server: Make, Zapier, n8n, CRM, atau notifikasi Slack/Telegram.')),
      sheetCard(ig),
      recoveryCard(f)));
}

function recoveryCard(f) {
  const rec = f.recovery ||= { partials: false, resume: false };
  const hasContact = f.questions.some((q) => q.type === 'email' || q.type === 'phone');
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

// ─── Results tab ────────────────────────────────────────────────────────────
function renderResults() {
  return el('div', { class: 'bw-page bw-page-wide' });
}

// ─── Preview dialog ─────────────────────────────────────────────────────────
let previewHandle = null;
let previewLive = false;
/**
 * live=false: Typeform-style preview, nothing is saved.
 * live=true (preview Artifact only): the published form, answers saved to this browser and shown in Results.
 */
function openPreview(live = false) {
  previewLive = live === true;
  const dlg = document.getElementById('previewDialog');
  const frame = document.getElementById('previewFrame');
  dlg.querySelector('.preview-bar strong').textContent = previewLive ? 'Form (jawaban disimpan)' : 'Pratinjau';
  const start = () => {
    previewHandle?.destroy();
    // A copy, so answering the preview never touches the draft being edited.
    previewHandle = mountForm(frame, structuredClone(state.form), previewLive
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
  document.getElementById('previewRestart').addEventListener('click', () => openPreview(previewLive));
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
function render() {
  document.querySelectorAll('.tb-tabs [data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  });
  const views = { content: renderContent, logic: renderLogic, connect: renderConnect, share: renderShare, results: renderResults };
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
      demoNote: DEMO ? 'Data contoh: kunjungan dan jawaban fiktif dari 14 hari terakhir, supaya grafik terlihat. Isi form lewat tab Bagikan → "Isi form", dan jawaban Anda ikut masuk ke sini.' : '',
    });
  }
  if (document.activeElement !== titleInput) titleInput.value = state.form.title || '';
  document.getElementById('backendPill').textContent = DEMO ? 'Pratinjau' : { cloud: 'Cloudflare D1', sheets: 'Google Sheets', local: 'Lokal (demo)' }[backend.name];
  updateStatus();
  loadCloudInfo();
}

async function refreshPicker() {
  try { state.forms = await backend.listForms(); } catch (err) { state.forms = []; toast(err.message, 'bad'); }
  const known = state.forms.some((f) => f.id === state.form.id);
  picker.replaceChildren(
    el('optgroup', { label: 'Form saya' },
      ...(known ? [] : [el('option', { value: state.form.id, text: `${state.form.title || 'Tanpa judul'} (draf)` })]),
      ...state.forms.map((f) => el('option', { value: f.id, selected: f.id === state.form.id, text: f.title || f.id }))),
    el('option', { value: '__new', text: '＋ Buat form baru' }),
  );
  picker.value = state.form.id;
  state.sheetUrl = state.forms.find((f) => f.id === state.form.id)?.sheetUrl || state.sheetUrl;
}

async function save() {
  const btn = document.getElementById('save');
  btn.disabled = true; btn.textContent = 'Menerbitkan…';
  try {
    themeObject();
    const { form, sheetUrl } = await backend.saveForm(state.form);
    state.form = form;
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
    state.selected = null; state.dirty = false; state.sheetUrl = '';
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
  state.form = blankForm(); state.selected = null; state.dirty = true; state.sheetUrl = '';
  state.tab = 'content';
  setUrl('');
  refreshPicker().then(render);
}

function setupSettings() {
  const dlg = document.getElementById('settings');
  const form = document.getElementById('settingsForm');
  const toggleFields = () => form.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== form.backend.value; });
  document.getElementById('openSettings').addEventListener('click', () => {
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
    await refreshPicker();
    render();
  });
}

/** The preview's example data is rebuilt when the demo gains features (bump DEMO_VERSION). */
const DEMO_VERSION = '2';
function resetOutdatedDemo() {
  try {
    if (localStorage.getItem('tf_demo_version') === DEMO_VERSION) return;
    Object.keys(localStorage).filter((k) => k.startsWith('tf_') || k.startsWith('ff_progress_')).forEach((k) => localStorage.removeItem(k));
    localStorage.setItem('tf_demo_version', DEMO_VERSION);
  } catch { /* storage unavailable */ }
}

async function init() {
  document.getElementById('openSettings').append(icon('settings', { size: 18 }));
  document.getElementById('preview').append(icon('eye', { size: 16 }), 'Pratinjau');
  document.getElementById('addClose').append(icon('close', { size: 18 }));
  document.getElementById('addClose').addEventListener('click', () => document.getElementById('addDialog').close());
  setupSettings();
  document.querySelectorAll('.tb-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
  document.getElementById('save').addEventListener('click', save);
  setupPreview();
  document.getElementById('preview').addEventListener('click', () => openPreview(false));
  if (DEMO) document.getElementById('openSettings').hidden = true;
  titleInput.addEventListener('input', () => {
    state.form.title = titleInput.value;
    markDirty();
    const opt = picker.querySelector(`option[value="${state.form.id}"]`);
    if (opt) opt.textContent = titleInput.value || 'Tanpa judul';
  });
  picker.addEventListener('change', async () => {
    const v = picker.value;
    picker.value = state.form.id;
    if (state.dirty && !await confirmDialog('Tinggalkan perubahan?', 'Ada perubahan yang belum diterbitkan di form ini. Perubahan itu akan hilang.', { okLabel: 'Tinggalkan' })) return;
    if (v === '__new') newForm(); else openForm(v);
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  });

  if (DEMO) resetOutdatedDemo();
  const id = new URLSearchParams(location.search).get('id');
  const tab = location.hash.slice(1);
  if (['content', 'logic', 'connect', 'share', 'results'].includes(tab)) state.tab = tab;
  state.form = blankForm();
  // A stale ?id= (deleted form, other browser) falls through to the normal start instead of a blank page.
  if (id && await openForm(id)) return;
  if (id) setUrl('');
  try { state.forms = await backend.listForms(); } catch { state.forms = []; }
  if (state.forms[0]) { await openForm(state.forms[0].id); return; }
  if (DEMO) {
    // First visit to the preview: publish the sample form and fill Results with labelled example data.
    try {
      await backend.saveForm(state.form);
      (await import('./demo.js')).seedExampleData(state.form);
      await openForm(state.form.id);
      return;
    } catch { /* storage blocked: continue with an unsaved draft */ }
  }
  state.dirty = true;
  await refreshPicker();
  render();
}

init();
