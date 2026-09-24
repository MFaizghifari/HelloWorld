// Form builder UI.
import { getBackend } from './api.js';
import { DEFAULT_CONFIG, getConfig, saveConfig, getAdminKey, setAdminKey, serverConfig } from './config.js';
import { el } from './dom.js';
import { END, QUESTION_TYPES, OPERATORS, uid, findLogicProblems, plainTitle } from './logic.js';
import { ID_PATTERNS, FB_STANDARD_EVENTS } from './tracking.js';

const panel = document.getElementById('panel');
const picker = document.getElementById('formPicker');
let backend = getBackend();

const state = {
  form: null,
  forms: [],
  tab: 'questions',
  selected: null, // question id
  dirty: false,
  sheetUrl: '',
};

// ─── Templates ──────────────────────────────────────────────────────────────
function blankForm() {
  const q1 = uid(); const q2 = uid(); const q3 = uid(); const q4 = uid(); const q5 = uid(); const q6 = uid();
  return {
    id: uid('f'),
    title: 'Pendaftaran Kelas',
    theme: { primary: '#3967BD', background: '#FCFCFC', text: '#060B14' },
    welcome: { enabled: true, title: 'Daftar kelas gratis', description: 'Isi 1 menit saja. Tim kami akan menghubungi Anda.', buttonText: 'Mulai' },
    thankyou: { title: 'Terima kasih, {{' + q1 + '}}!', description: 'Kami akan menghubungi Anda via WhatsApp dalam 1×24 jam.', buttonText: '', buttonUrl: '', redirectUrl: '' },
    questions: [
      { id: q1, type: 'short_text', title: 'Siapa nama Anda?', required: true, settings: {}, logic: [] },
      { id: q2, type: 'email', title: 'Halo {{' + q1 + '}}, apa email Anda?', required: true, settings: {}, logic: [] },
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
    createdAt: new Date().toISOString(),
  };
}

function newQuestion(type) {
  const q = { id: uid(), type, title: '', required: false, settings: {}, logic: [] };
  if (QUESTION_TYPES[type].choices) q.options = [{ id: uid('o'), label: 'Pilihan 1' }, { id: uid('o'), label: 'Pilihan 2' }];
  if (type === 'rating') q.settings = { steps: 5 };
  if (type === 'opinion_scale') q.settings = { start: 0, steps: 11 };
  return q;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function markDirty() {
  state.dirty = true;
  document.getElementById('save').textContent = 'Simpan •';
}

function bind(obj, key, { type = 'text', rerender = false, transform } = {}) {
  const common = {
    oninput: (e) => {
      let v = type === 'checkbox' ? e.target.checked : e.target.value;
      if (type === 'number') v = v === '' ? '' : Number(v);
      if (transform) v = transform(v);
      obj[key] = v;
      markDirty();
      if (rerender) render();
    },
  };
  if (type === 'checkbox') return el('input', { type: 'checkbox', checked: !!obj[key], onchange: common.oninput });
  if (type === 'textarea') return el('textarea', { rows: 2, value: obj[key] ?? '', ...common });
  return el('input', { type, value: obj[key] ?? '', ...common });
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', { text: label }), control, hint ? el('small', { class: 'muted', text: hint }) : null);
}

function selectEl(options, value, onchange, attrs = {}) {
  return el('select', { onchange: (e) => onchange(e.target.value), ...attrs },
    options.map(([v, label]) => el('option', { value: v, selected: v === value, text: label })));
}

function qLabel(q, i) {
  return `${i + 1}. ${plainTitle(q.title) || '(tanpa judul)'}`;
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
  try { cloudInfo = await backend.info(); if (state.tab === 'tracking') render(); } catch { /* shown elsewhere */ }
}

function sheetCard(ig) {
  if (backend.name === 'cloud') {
    const sa = cloudInfo?.serviceAccountEmail;
    return el('section', { class: 'card' },
      el('h3', { text: 'Salinan ke Google Sheets' }),
      el('p', { class: 'muted small', text: 'Jawaban disimpan di database Cloudflare D1, lalu disalin otomatis ke Google Sheet setiap 5 menit.' }),
      el('ol', { class: 'small steps' },
        el('li', { text: 'Buat Google Sheet kosong.' }),
        el('li', {}, 'Klik Share → tambahkan ', sa ? el('code', { text: sa }) : el('em', { text: 'email service account (lihat README)' }), ' sebagai Editor.'),
        el('li', { text: 'Tempel link Sheet-nya di bawah, lalu Simpan form.' })),
      sa ? el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { navigator.clipboard?.writeText(sa); toast('Email service account disalin ✓'); }, text: 'Salin email service account' }) : null,
      field('Link Google Sheet', bind(ig, 'sheetUrl', { type: 'url' }), 'Contoh: https://docs.google.com/spreadsheets/d/1AbC…/edit. Jawaban yang sudah masuk sebelum link diisi juga ikut disalin.'),
      cloudInfo && !sa ? el('p', { class: 'bad small', text: 'Worker belum punya kredensial Google (GOOGLE_SERVICE_ACCOUNT_EMAIL & GOOGLE_PRIVATE_KEY).' }) : null);
  }
  return el('section', { class: 'card' },
    el('h3', { text: 'Google Sheet jawaban' }),
    field('Bagikan Google Sheet ke (email, pisahkan koma)', bind(ig, 'sheetEditors'), 'Diberi akses edit ke spreadsheet jawaban form ini saat disimpan.'),
    field('Email notifikasi (opsional)', bind(ig, 'notifyEmail', { type: 'email' }), 'Dikirim oleh Apps Script. Kuota Gmail: 100 email/hari (akun biasa), 1.500 (Workspace).'));
}

// ─── Tabs ───────────────────────────────────────────────────────────────────
function renderQuestions() {
  const f = state.form;
  if (!state.selected && f.questions[0]) state.selected = f.questions[0].id;
  const q = f.questions.find((x) => x.id === state.selected);

  const list = el('aside', { class: 'qlist' },
    el('label', { class: 'field' }, el('span', { text: 'Judul form' }), bind(f, 'title')),
    el('ol', {}, f.questions.map((x, i) => el('li', {
      class: x.id === state.selected ? 'active' : '',
      onclick: () => { state.selected = x.id; render(); },
    },
    el('span', { class: 'type-badge', text: QUESTION_TYPES[x.type]?.label || x.type }),
    el('span', { class: 'qtitle', text: qLabel(x, i) }),
    (x.logic || []).length ? el('span', { class: 'logic-dot', title: 'Punya logika', text: '⤳' }) : null))),
    el('div', { class: 'add' },
      selectEl([['', '+ Tambah pertanyaan…'], ...Object.entries(QUESTION_TYPES).map(([k, v]) => [k, v.label])], '', (type) => {
        if (!type) return;
        const nq = newQuestion(type);
        const idx = f.questions.findIndex((x) => x.id === state.selected);
        f.questions.splice(idx + 1, 0, nq);
        state.selected = nq.id;
        markDirty();
        render();
        panel.querySelector('.editor input')?.focus();
      })),
  );

  const editor = q ? questionEditor(q) : el('section', { class: 'editor empty', text: 'Belum ada pertanyaan. Tambahkan dari panel kiri.' });
  return el('div', { class: 'split' }, list, editor);
}

function questionEditor(q) {
  const f = state.form;
  const idx = f.questions.indexOf(q);
  const s = q.settings || (q.settings = {});
  const move = (d) => {
    const j = idx + d;
    if (j < 0 || j >= f.questions.length) return;
    [f.questions[idx], f.questions[j]] = [f.questions[j], f.questions[idx]];
    markDirty(); render();
  };

  const typeSpecific = [];
  if (['short_text', 'long_text', 'email', 'phone', 'number'].includes(q.type)) {
    typeSpecific.push(field('Placeholder', bind(s, 'placeholder')));
  }
  if (q.type === 'number') {
    typeSpecific.push(el('div', { class: 'row' }, field('Minimum', bind(s, 'min', { type: 'number' })), field('Maksimum', bind(s, 'max', { type: 'number' }))));
  }
  if (q.type === 'short_text' || q.type === 'long_text') {
    typeSpecific.push(field('Batas karakter', bind(s, 'maxLength', { type: 'number' })));
  }
  if (q.type === 'rating') {
    typeSpecific.push(field('Jumlah bintang', selectEl([3, 4, 5, 6, 7, 8, 9, 10].map((n) => [String(n), String(n)]), String(s.steps || 5), (v) => { s.steps = Number(v); markDirty(); })));
  }
  if (q.type === 'opinion_scale') {
    typeSpecific.push(el('div', { class: 'row' },
      field('Mulai dari', selectEl([['0', '0'], ['1', '1']], String(s.start ?? 0), (v) => { s.start = Number(v); markDirty(); })),
      field('Jumlah langkah', selectEl([5, 7, 10, 11].map((n) => [String(n), String(n)]), String(s.steps || 11), (v) => { s.steps = Number(v); markDirty(); }), 'Skala 0–10 (11 langkah) otomatis dihitung NPS di dashboard.')));
    typeSpecific.push(el('div', { class: 'row' }, field('Label kiri', bind(s, 'labelLeft')), field('Label kanan', bind(s, 'labelRight'))));
  }
  if (q.type === 'statement') typeSpecific.push(field('Teks tombol', bind(s, 'buttonText')));
  if (QUESTION_TYPES[q.type]?.choices) {
    typeSpecific.push(el('div', { class: 'field' }, el('span', { text: 'Pilihan' }),
      el('div', { class: 'options' }, (q.options || []).map((o, i) => el('div', { class: 'option-row' },
        el('kbd', { text: String.fromCharCode(65 + i) }),
        bind(o, 'label'),
        el('button', { class: 'icon', type: 'button', title: 'Hapus pilihan', onclick: () => { q.options.splice(i, 1); markDirty(); render(); }, text: '✕' })))),
      el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { q.options.push({ id: uid('o'), label: `Pilihan ${q.options.length + 1}` }); markDirty(); render(); }, text: '+ Tambah pilihan' }),
      el('small', { class: 'muted', text: 'Tip: tempel beberapa baris sekaligus di kotak di bawah untuk impor massal.' }),
      el('textarea', {
        rows: 2, placeholder: 'Satu pilihan per baris…',
        onchange: (e) => {
          const lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return;
          q.options.push(...lines.map((label) => ({ id: uid('o'), label })));
          markDirty(); render();
        },
      })));
    if (q.type === 'multiple_choice') {
      typeSpecific.push(el('div', { class: 'row' },
        el('label', { class: 'check' }, bind(s, 'multiple', { type: 'checkbox', rerender: true }), el('span', { text: 'Boleh pilih lebih dari satu' })),
        el('label', { class: 'check' }, bind(s, 'randomize', { type: 'checkbox' }), el('span', { text: 'Acak urutan' }))));
      if (s.multiple) typeSpecific.push(field('Maks. pilihan (kosong = bebas)', bind(s, 'maxSelections', { type: 'number' })));
    }
  }

  return el('section', { class: 'editor' },
    el('div', { class: 'row between' },
      el('div', { class: 'row' },
        el('span', { class: 'pill', text: `Pertanyaan ${idx + 1}` }),
        selectEl(Object.entries(QUESTION_TYPES).map(([k, v]) => [k, v.label]), q.type, (t) => {
          q.type = t;
          if (QUESTION_TYPES[t].choices && !q.options) q.options = newQuestion(t).options;
          if (QUESTION_TYPES[t].scale) q.settings = newQuestion(t).settings;
          markDirty(); render();
        }, { 'aria-label': 'Tipe pertanyaan' })),
      el('div', { class: 'row' },
        el('button', { class: 'icon', type: 'button', title: 'Naik', onclick: () => move(-1), text: '↑' }),
        el('button', { class: 'icon', type: 'button', title: 'Turun', onclick: () => move(1), text: '↓' }),
        el('button', { class: 'icon', type: 'button', title: 'Duplikat', onclick: () => {
          const copy = JSON.parse(JSON.stringify(q)); copy.id = uid(); copy.logic = [];
          f.questions.splice(idx + 1, 0, copy); state.selected = copy.id; markDirty(); render();
        }, text: '⧉' }),
        el('button', { class: 'icon danger', type: 'button', title: 'Hapus', onclick: () => {
          if (!confirm('Hapus pertanyaan ini?')) return;
          f.questions.splice(idx, 1); state.selected = f.questions[Math.max(0, idx - 1)]?.id; markDirty(); render();
        }, text: '🗑' }))),
    field('Pertanyaan', bind(q, 'title', { rerender: false, transform: (v) => { refreshListTitle(q); return v; } }),
      'Pakai {{id}} untuk menyisipkan jawaban sebelumnya. Klik chip di bawah untuk menyalin.'),
    el('div', { class: 'chips' }, f.questions.slice(0, idx).filter((x) => x.type !== 'statement').map((x) => el('button', {
      type: 'button', class: 'chip', title: 'Salin kode', onclick: () => { navigator.clipboard?.writeText(`{{${x.id}}}`); toast(`Disalin: {{${x.id}}}`); },
      text: `{{${plainTitle(x.title).slice(0, 18) || x.id}}}`,
    }))),
    field('Deskripsi (opsional)', bind(q, 'description', { type: 'textarea' })),
    field('URL gambar (opsional, https)', bind(q, 'imageUrl', { type: 'url' })),
    q.type !== 'statement' ? el('label', { class: 'check' }, bind(q, 'required', { type: 'checkbox' }), el('span', { text: 'Wajib diisi' })) : null,
    typeSpecific,
    el('p', { class: 'muted small', text: `ID: ${q.id}` }),
  );
}

function refreshListTitle(q) {
  // Update the sidebar title live without re-rendering the editor (keeps focus).
  setTimeout(() => {
    const i = state.form.questions.indexOf(q);
    const li = panel.querySelectorAll('.qlist li')[i];
    if (li) li.querySelector('.qtitle').textContent = qLabel(q, i);
  });
}

function renderLogic() {
  const f = state.form;
  const problems = findLogicProblems(f);
  const fieldOptions = [
    ...f.questions.filter((q) => q.type !== 'statement').map((q, i) => [q.id, qLabel(q, f.questions.indexOf(q))]),
    ...(f.hiddenFields || []).map((h) => [h, `hidden: ${h}`]),
  ];
  const targetsFor = (idx) => [
    ...f.questions.map((q, i) => [q.id, qLabel(q, i)]).filter((_, i) => i !== idx),
    [END, '🏁 Selesai (kirim form)'],
  ];

  return el('div', { class: 'stack' },
    el('div', { class: 'callout' },
      el('strong', { text: 'Cara kerja logika: ' }),
      'Setelah pertanyaan dijawab, aturan dicek dari atas ke bawah. Aturan pertama yang cocok menentukan lompatan. ',
      'Jika tidak ada yang cocok → ke "Default berikutnya", atau pertanyaan selanjutnya secara urut.'),
    problems.length ? el('div', { class: 'callout warn' }, el('strong', { text: 'Perlu dicek:' }), el('ul', {}, problems.map((p) => el('li', { text: p })))) : null,
    f.questions.map((q, idx) => el('section', { class: 'card' },
      el('div', { class: 'row between' },
        el('h3', { text: qLabel(q, idx) }),
        el('span', { class: 'type-badge', text: QUESTION_TYPES[q.type]?.label })),
      (q.logic || []).map((rule, ri) => el('div', { class: 'rule' },
        el('div', { class: 'row' },
          el('strong', { text: 'JIKA' }),
          selectEl([['all', 'semua kondisi'], ['any', 'salah satu kondisi']], rule.match || 'all', (v) => { rule.match = v; markDirty(); }),
          el('button', { class: 'icon danger', type: 'button', title: 'Hapus aturan', onclick: () => { q.logic.splice(ri, 1); markDirty(); render(); }, text: '✕' })),
        (rule.conditions || []).map((c, ci) => {
          const src = f.questions.find((x) => x.id === c.field);
          const needsValue = !['answered', 'not_answered'].includes(c.op);
          let valueControl = null;
          if (needsValue) {
            if (src && (QUESTION_TYPES[src.type]?.choices || src.type === 'yes_no')) {
              const opts = src.type === 'yes_no' ? ['Ya', 'Tidak'] : (src.options || []).map((o) => o.label);
              valueControl = selectEl([['', 'pilih…'], ...opts.map((o) => [o, o])], c.value, (v) => { c.value = v; markDirty(); });
            } else {
              valueControl = bind(c, 'value');
            }
          }
          return el('div', { class: 'row cond' },
            selectEl(fieldOptions, c.field, (v) => { c.field = v; c.value = ''; markDirty(); render(); }),
            selectEl(Object.entries(OPERATORS), c.op, (v) => { c.op = v; markDirty(); render(); }),
            valueControl,
            el('button', { class: 'icon', type: 'button', title: 'Hapus kondisi', onclick: () => { rule.conditions.splice(ci, 1); markDirty(); render(); }, text: '−' }));
        }),
        el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { rule.conditions.push({ field: q.id, op: 'eq', value: '' }); markDirty(); render(); }, text: '+ kondisi' }),
        el('div', { class: 'row' }, el('strong', { text: 'MAKA lompat ke' }),
          selectEl([['', 'pilih tujuan…'], ...targetsFor(idx)], rule.goto || '', (v) => { rule.goto = v; markDirty(); render(); })))),
      el('div', { class: 'row' },
        el('button', { class: 'btn-ghost small', type: 'button', onclick: () => {
          (q.logic ||= []).push({ match: 'all', conditions: q.type === 'statement' ? [] : [{ field: q.id, op: 'eq', value: '' }], goto: '' });
          markDirty(); render();
        }, text: '+ Tambah aturan' }),
        el('span', { class: 'muted small', text: 'Default berikutnya:' }),
        selectEl([['', '→ pertanyaan berikutnya (urut)'], ...targetsFor(idx)], q.next || '', (v) => { if (v) q.next = v; else delete q.next; markDirty(); })),
    )),
  );
}

function renderDesign() {
  const f = state.form;
  const t = f.theme ||= {};
  const w = f.welcome ||= { enabled: true };
  const ty = f.thankyou ||= {};
  return el('div', { class: 'grid2' },
    el('section', { class: 'card' },
      el('h3', { text: 'Warna & tema' }),
      el('div', { class: 'row' },
        field('Warna utama', bind(t, 'primary', { type: 'color' })),
        field('Latar', bind(t, 'background', { type: 'color' })),
        field('Teks', bind(t, 'text', { type: 'color' }))),
      field('Gambar latar (URL https, opsional)', bind(t, 'backgroundImage', { type: 'url' })),
      el('label', { class: 'check' }, bind(t, 'hideBranding', { type: 'checkbox' }), el('span', { text: 'Sembunyikan "Dibuat dengan FormFlow"' }))),
    el('section', { class: 'card' },
      el('h3', { text: 'Halaman pembuka' }),
      el('label', { class: 'check' }, bind(w, 'enabled', { type: 'checkbox' }), el('span', { text: 'Tampilkan halaman pembuka' })),
      field('Judul', bind(w, 'title')),
      field('Deskripsi', bind(w, 'description', { type: 'textarea' })),
      field('Teks tombol', bind(w, 'buttonText'))),
    el('section', { class: 'card' },
      el('h3', { text: 'Halaman terima kasih' }),
      field('Judul', bind(ty, 'title'), 'Bisa pakai {{id}} untuk menyebut nama responden.'),
      field('Deskripsi', bind(ty, 'description', { type: 'textarea' })),
      el('div', { class: 'row' }, field('Teks tombol (opsional)', bind(ty, 'buttonText')), field('URL tombol', bind(ty, 'buttonUrl', { type: 'url' }))),
      field('Redirect otomatis ke URL (opsional)', bind(ty, 'redirectUrl', { type: 'url' }), 'Contoh: https://wa.me/62812xxxx?text=Halo%20saya%20{{q_xxx}}'),
      field('Jeda redirect (detik)', bind(ty, 'redirectDelay', { type: 'number' }))),
  );
}

function renderTracking() {
  const f = state.form;
  const tr = f.tracking ||= {};
  const ig = f.integrations ||= {};
  const validity = (key) => {
    const v = tr[key];
    if (!v) return null;
    return ID_PATTERNS[key].test(v) ? el('small', { class: 'ok', text: '✓ format valid' }) : el('small', { class: 'bad', text: '✕ format tidak valid — tidak akan dipasang' });
  };
  return el('div', { class: 'grid2' },
    el('section', { class: 'card' },
      el('h3', { text: 'Facebook / Meta Pixel' }),
      field('Pixel ID', bind(tr, 'fbPixelId', { transform: (v) => v.trim(), rerender: false }), 'Angka 15–16 digit dari Events Manager.'),
      validity('fbPixelId'),
      field('Event saat form terkirim', selectEl(FB_STANDARD_EVENTS.map((e) => [e, e]), tr.fbSubmitEvent || 'Lead', (v) => { tr.fbSubmitEvent = v; markDirty(); })),
      el('label', { class: 'check' }, bind(tr, 'stepEvents', { type: 'checkbox' }), el('span', { text: 'Kirim event FormStep per pertanyaan (untuk analisa funnel di Ads)' })),
      el('label', { class: 'check' }, bind(tr, 'capi', { type: 'checkbox' }), el('span', { text: 'Conversions API (server-side, butuh backend Cloudflare atau Google Sheets)' })),
      el('p', { class: 'muted small', text: 'Event otomatis: PageView (buka form), FormStart (jawaban pertama), dan event submit di atas. Event submit dikirim dari browser + server dengan event_id yang sama sehingga Meta men-deduplikasi. Access token CAPI disimpan sebagai secret FB_CAPI_TOKEN (Worker) atau Script Property (Apps Script), bukan di sini.' })),
    el('section', { class: 'card' },
      el('h3', { text: 'Google Analytics 4 & Tag Manager' }),
      field('GA4 Measurement ID', bind(tr, 'ga4Id', { transform: (v) => v.trim().toUpperCase() }), 'Format: G-XXXXXXXXXX'),
      validity('ga4Id'),
      field('GTM Container ID', bind(tr, 'gtmId', { transform: (v) => v.trim().toUpperCase() }), 'Format: GTM-XXXXXXX. Event dataLayer: form_start, form_step, form_submit.'),
      validity('gtmId')),
    el('section', { class: 'card' },
      el('h3', { text: 'Hidden fields (UTM & parameter URL)' }),
      el('p', { class: 'muted small', text: 'utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid selalu direkam otomatis. Tambahkan parameter lain di sini (pisahkan koma), mis. ref, nama.' }),
      el('input', {
        type: 'text', value: (f.hiddenFields || []).join(', '),
        onchange: (e) => { f.hiddenFields = e.target.value.split(',').map((x) => x.trim()).filter((x) => /^[\w-]{1,40}$/.test(x)); markDirty(); render(); },
      }),
      el('p', { class: 'muted small', text: 'Pakai di teks dengan {{hidden:nama}}. Bisa dipakai juga sebagai kondisi di tab Logika.' })),
    el('section', { class: 'card' },
      el('h3', { text: 'Integrasi lain' }),
      field('Webhook URL (opsional)', bind(ig, 'webhookUrl', { type: 'url' }), 'Setiap jawaban baru di-POST (JSON) ke URL ini dari server — cocok untuk Make, Zapier, n8n, CRM, atau notifikasi Slack/Telegram.')),
    sheetCard(ig),
  );
}

function renderShare() {
  const url = shareUrl();
  const origin = new URL('.', location.href).href;
  const iframe = `<iframe src="${url}" style="width:100%;height:600px;border:0;border-radius:16px" allow="clipboard-write" title="${state.form.title.replace(/"/g, '')}"></iframe>`;
  const popup = `<script src="${origin}embed.js" async></script>\n<button data-formflow="${url}">Isi form</button>`;
  const inline = `<div data-formflow-inline="${url}" style="height:600px"></div>\n<script src="${origin}embed.js" async></script>`;
  const code = (label, text, hint) => el('section', { class: 'card' },
    el('div', { class: 'row between' }, el('h3', { text: label }),
      el('button', { class: 'btn-ghost small', type: 'button', onclick: () => { navigator.clipboard?.writeText(text); toast('Disalin ✓'); }, text: 'Salin' })),
    hint ? el('p', { class: 'muted small', text: hint }) : null,
    el('pre', { text: text }));
  return el('div', { class: 'stack' },
    state.dirty ? el('div', { class: 'callout warn', text: 'Ada perubahan yang belum disimpan. Simpan dulu agar link menampilkan versi terbaru.' }) : null,
    backend.name === 'local' ? el('div', { class: 'callout warn', text: 'Mode "Browser ini saja": link hanya berfungsi di browser ini. Hubungkan backend Cloudflare atau Google Sheets di Pengaturan untuk membagikan ke publik.' }) : null,
    el('section', { class: 'card' },
      el('h3', { text: 'Link publik' }),
      el('div', { class: 'row' }, el('input', { type: 'text', readonly: true, value: url, onclick: (e) => e.target.select() }),
        el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener', text: 'Buka' })),
      el('p', { class: 'muted small', text: 'Tambahkan ?utm_source=…&utm_campaign=… di link iklan agar sumber traffic tercatat.' }),
      state.sheetUrl ? el('p', {}, el('a', { href: state.sheetUrl, target: '_blank', rel: 'noopener', text: '📊 Buka Google Sheet jawaban form ini' })) : null),
    code('Embed inline (disarankan)', inline, 'embed.js meneruskan event Pixel dari form ke halaman Anda, sehingga cookie _fbp/_fbc first-party tetap terbaca (iframe biasa sering diblokir third-party cookie di Safari/Chrome).'),
    code('Embed popup (tombol)', popup),
    code('Embed iframe polos', iframe, 'Paling sederhana, tapi Pixel berjalan di domain form, bukan domain Anda.'),
  );
}

// ─── Render / persistence ───────────────────────────────────────────────────
function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const scroll = panel.scrollTop;
  const views = { questions: renderQuestions, logic: renderLogic, design: renderDesign, tracking: renderTracking, share: renderShare };
  panel.replaceChildren(views[state.tab]());
  panel.scrollTop = scroll;
  document.getElementById('openDashboard').href = `dashboard.html?id=${encodeURIComponent(state.form.id)}`;
  const cfg = getConfig();
  document.getElementById('backendPill').textContent = { cloud: '● Cloudflare D1', sheets: '● Google Sheets', local: '● Lokal (demo)' }[backend.name];
  loadCloudInfo();
}

async function refreshPicker() {
  try { state.forms = await backend.listForms(); } catch (err) { state.forms = []; toast(err.message, 'bad'); }
  const known = state.forms.some((f) => f.id === state.form.id);
  picker.replaceChildren(
    ...(known ? [] : [el('option', { value: state.form.id, text: `${state.form.title} (belum disimpan)` })]),
    ...state.forms.map((f) => el('option', { value: f.id, selected: f.id === state.form.id, text: f.title || f.id })),
  );
  picker.value = state.form.id;
  state.sheetUrl = state.forms.find((f) => f.id === state.form.id)?.sheetUrl || state.sheetUrl;
}

async function save() {
  const btn = document.getElementById('save');
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  try {
    const { form, sheetUrl } = await backend.saveForm(state.form);
    state.form = form;
    state.sheetUrl = sheetUrl || state.sheetUrl;
    state.dirty = false;
    toast(sheetUrl ? 'Tersimpan ✓ Google Sheet siap.' : 'Tersimpan ✓');
    await refreshPicker();
    history.replaceState(null, '', `?id=${encodeURIComponent(form.id)}`);
  } catch (err) {
    toast(`Gagal menyimpan: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false; btn.textContent = state.dirty ? 'Simpan •' : 'Simpan';
    render();
  }
}

async function openForm(id) {
  try {
    state.form = await backend.getForm(id);
    state.selected = null; state.dirty = false; state.sheetUrl = '';
    history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
    await refreshPicker();
    render();
  } catch (err) { toast(err.message, 'bad'); }
}

function setupSettings() {
  const dlg = document.getElementById('settings');
  const form = document.getElementById('settingsForm');
  document.getElementById('openSettings').addEventListener('click', () => {
    const cfg = getConfig();
    form.backend.value = cfg.backend;
    form.sheetsUrl.value = cfg.sheetsUrl || '';
    form.apiUrl.value = cfg.apiUrl || '/api';
    form.adminKey.value = getAdminKey();
    toggleFields();
    dlg.showModal();
  });
  const toggleFields = () => form.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== form.backend.value; });
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

async function init() {
  setupSettings();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('preview').addEventListener('click', () => {
    localStorage.setItem('tf_preview', JSON.stringify(state.form));
    window.open('form.html?preview=1', '_blank');
  });
  document.getElementById('newForm').addEventListener('click', () => {
    if (state.dirty && !confirm('Perubahan belum disimpan. Lanjut buat form baru?')) return;
    state.form = blankForm(); state.selected = null; state.dirty = true; state.sheetUrl = '';
    state.tab = 'questions';
    refreshPicker().then(render);
  });
  picker.addEventListener('change', () => {
    if (state.dirty && !confirm('Perubahan belum disimpan. Pindah form?')) { picker.value = state.form.id; return; }
    openForm(picker.value);
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  });

  const id = new URLSearchParams(location.search).get('id');
  state.form = blankForm();
  if (id) { await openForm(id); return; }
  try { state.forms = await backend.listForms(); } catch { state.forms = []; }
  if (state.forms[0]) { await openForm(state.forms[0].id); return; }
  state.dirty = true;
  await refreshPicker();
  render();
}

init();
