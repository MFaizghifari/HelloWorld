// Pure form logic: validation, logic jumps, answer piping, progress.
// No DOM access here so it can be unit-tested with `node --test`.

export const END = '__end';

export const QUESTION_TYPES = {
  short_text: { label: 'Teks singkat', input: true },
  long_text: { label: 'Paragraf', input: true },
  email: { label: 'Email', input: true },
  phone: { label: 'Nomor telepon', input: true },
  number: { label: 'Angka', input: true },
  multiple_choice: { label: 'Pilihan ganda', input: true, choices: true },
  dropdown: { label: 'Dropdown', input: true, choices: true },
  yes_no: { label: 'Ya / Tidak', input: true },
  rating: { label: 'Rating (bintang)', input: true, scale: true },
  opinion_scale: { label: 'Skala opini', input: true, scale: true },
  date: { label: 'Tanggal', input: true },
  file_upload: { label: 'Unggah file', input: true },
  statement: { label: 'Pernyataan (tanpa input)', input: false },
};

// ─── File uploads ───────────────────────────────────────────────────────────
// Allowed content per question setting. The server checks the file's first
// bytes against these types, so a renamed .html never passes as a .png.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const IMAGE_EXT = '.jpg,.jpeg,.png,.webp,.gif,.heic,.heif'; // some systems report HEIC with an empty type
const DOC_TYPES = [
  'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv', 'text/plain',
];
export const FILE_KINDS = {
  image: { label: 'Gambar', hint: 'JPG, PNG, WebP, HEIC', accept: `${IMAGE_TYPES.join(',')},${IMAGE_EXT}`, types: IMAGE_TYPES },
  pdf: { label: 'PDF', hint: 'PDF', accept: 'application/pdf,.pdf', types: ['application/pdf'] },
  document: { label: 'Dokumen', hint: 'PDF, Word, Excel, PowerPoint', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt', types: DOC_TYPES },
  any: { label: 'Gambar & dokumen', hint: 'Gambar, PDF, Word, Excel', accept: `${IMAGE_TYPES.join(',')},${IMAGE_EXT},.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt`, types: [...IMAGE_TYPES, ...DOC_TYPES] },
};
export const FILE_LIMITS = { defaultMb: 10, maxMb: 25, maxFiles: 10 };

/** Upload rules of a file_upload question, with defaults and hard caps applied. */
export function fileRules(question) {
  const s = question?.settings || {};
  const kind = FILE_KINDS[s.fileKind] ? s.fileKind : 'any';
  const maxMb = Math.min(FILE_LIMITS.maxMb, Math.max(1, Number(s.maxSizeMb) || FILE_LIMITS.defaultMb));
  const maxFiles = Math.min(FILE_LIMITS.maxFiles, Math.max(1, Math.round(Number(s.maxFiles) || 1)));
  return { kind, maxMb, maxBytes: maxMb * 1024 * 1024, maxFiles, types: FILE_KINDS[kind].types, accept: FILE_KINDS[kind].accept };
}

/** Why a picked file cannot be sent (checked again on the server by content), or null. */
export function fileProblem(question, file) {
  const rules = fileRules(question);
  const ext = (String(file.name).toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
  if (!rules.types.includes(file.type) && !(ext && rules.accept.split(',').includes(ext))) return `${file.name}: jenis file tidak diterima (${FILE_KINDS[rules.kind].hint}).`;
  if (file.size > rules.maxBytes) return `${file.name}: lebih dari ${rules.maxMb} MB.`;
  if (!file.size) return `${file.name}: file kosong.`;
  return null;
}

/** A file answer: [{ ref, name, type, size, url? }]. */
export function isFileList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((f) => f && typeof f === 'object' && typeof f.ref === 'string' && typeof f.name === 'string');
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
}

/** Plain-text form of any answer: file names (with links when known), list items, or the value. */
export function answerText(v) {
  if (isFileList(v)) return v.map((f) => (f.url ? `${f.name} (${f.url})` : f.name)).join(', ');
  if (Array.isArray(v)) return v.join(', ');
  return v === undefined || v === null ? '' : String(v);
}

// ─── A/B variants ───────────────────────────────────────────────────────────
// Variant B is a full copy of the screens (welcome, questions, ending, theme)
// stored in form.variants.B. Everything else (title, Pixel, integrations,
// hidden fields) is shared, so both variants feed one set of results.
export const VARIANT_KEYS = ['welcome', 'questions', 'thankyou', 'theme'];

/** The form as variant `v` shows it. */
export function variantForm(form, v) {
  const b = v === 'B' ? form?.variants?.B : null;
  if (!b) return form;
  const out = { ...form };
  for (const k of VARIANT_KEYS) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

/** Questions of A followed by questions that only exist in B (for results, sheets, CSV). */
export function allQuestions(form) {
  const seen = new Set();
  const out = [];
  for (const q of [...(form?.questions || []), ...(form?.variants?.B?.questions || [])]) {
    if (!seen.has(q.id)) { seen.add(q.id); out.push(q); }
  }
  return out;
}

export function withAllQuestions(form) {
  return form?.variants?.B ? { ...form, questions: allQuestions(form) } : form;
}

export function experimentRunning(form) {
  const x = form?.experiment;
  return !!(x && x.status === 'running' && form.variants?.B && /^x_[a-z0-9]{4,20}$/.test(x.id || ''));
}

/** Validated "x_id:A" tag for events of the running experiment, or '' when the pair is stale or forged. */
export function variantTag(form, experimentId, variant) {
  const x = form?.experiment;
  if (!x || x.id !== experimentId || !form.variants?.B || (variant !== 'A' && variant !== 'B')) return '';
  return `${x.id}:${variant}`;
}

export const OPERATORS = {
  eq: 'sama dengan',
  neq: 'tidak sama dengan',
  contains: 'mengandung',
  not_contains: 'tidak mengandung',
  gt: 'lebih dari',
  gte: 'lebih dari / sama dengan',
  lt: 'kurang dari',
  lte: 'kurang dari / sama dengan',
  answered: 'diisi',
  not_answered: 'tidak diisi',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Accepts +62 / 62 / 0 prefixes and common separators; 8–15 digits total (E.164 max is 15).
const PHONE_RE = /^\+?[0-9][0-9\s\-().]{6,18}$/;

export function isEmpty(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === '';
}

/** Returns an error message (string) or null when valid. */
export function validateAnswer(question, value) {
  const s = question.settings || {};
  if (question.type === 'statement') return null;
  if (isEmpty(value)) return question.required ? 'Pertanyaan ini wajib diisi.' : null;

  switch (question.type) {
    case 'email':
      return EMAIL_RE.test(String(value).trim()) ? null : 'Format email tidak valid.';
    case 'phone': {
      const digits = String(value).replace(/\D/g, '');
      if (!PHONE_RE.test(String(value).trim()) || digits.length < 8 || digits.length > 15) {
        return 'Nomor telepon tidak valid.';
      }
      return null;
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return 'Masukkan angka yang valid.';
      if (s.min !== undefined && s.min !== '' && n < Number(s.min)) return `Minimal ${s.min}.`;
      if (s.max !== undefined && s.max !== '' && n > Number(s.max)) return `Maksimal ${s.max}.`;
      return null;
    }
    case 'short_text':
    case 'long_text': {
      const max = Number(s.maxLength) || (question.type === 'short_text' ? 500 : 5000);
      return String(value).length > max ? `Maksimal ${max} karakter.` : null;
    }
    case 'multiple_choice':
    case 'dropdown': {
      const labels = (question.options || []).map((o) => o.label);
      const values = Array.isArray(value) ? value : [value];
      if (!s.allowOther && values.some((v) => !labels.includes(v))) return 'Pilihan tidak valid.';
      if (s.multiple && s.maxSelections && values.length > Number(s.maxSelections)) {
        return `Pilih maksimal ${s.maxSelections}.`;
      }
      return null;
    }
    case 'rating':
    case 'opinion_scale': {
      const n = Number(value);
      const { min, max } = scaleRange(question);
      return Number.isInteger(n) && n >= min && n <= max ? null : 'Nilai di luar skala.';
    }
    case 'yes_no':
      return value === 'Ya' || value === 'Tidak' ? null : 'Pilih Ya atau Tidak.';
    case 'file_upload': {
      const rules = fileRules(question);
      if (!isFileList(value)) return 'File tidak valid.';
      if (value.length > rules.maxFiles) return `Maksimal ${rules.maxFiles} file.`;
      for (const f of value) {
        if (Number(f.size) > rules.maxBytes) return `${f.name}: lebih dari ${rules.maxMb} MB.`;
        if (f.type && !rules.types.includes(f.type)) return `${f.name}: jenis file tidak diterima.`;
      }
      return null;
    }
    case 'date': {
      const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return 'Tanggal tidak valid.';
      // Reject impossible dates such as 31/02 (Date would silently roll them over).
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 1900
        ? null : 'Tanggal tidak valid.';
    }
    default:
      return null;
  }
}

export function scaleRange(question) {
  const s = question.settings || {};
  if (question.type === 'rating') return { min: 1, max: Number(s.steps) || 5 };
  const min = s.start === undefined || s.start === '' ? 0 : Number(s.start);
  return { min, max: min + (Number(s.steps) || 11) - 1 };
}

function toNumber(v) {
  if (Array.isArray(v)) return NaN;
  return v === '' || v === null || v === undefined ? NaN : Number(v);
}

function norm(v) {
  return String(v ?? '').trim().toLowerCase();
}

export function evaluateCondition(cond, answers) {
  const actual = answers[cond.field];
  const expected = cond.value;
  switch (cond.op) {
    case 'answered':
      return !isEmpty(actual);
    case 'not_answered':
      return isEmpty(actual);
    case 'eq':
      return Array.isArray(actual)
        ? actual.some((a) => norm(a) === norm(expected))
        : norm(actual) === norm(expected);
    case 'neq':
      return Array.isArray(actual)
        ? !actual.some((a) => norm(a) === norm(expected))
        : norm(actual) !== norm(expected);
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((a) => norm(a).includes(norm(expected)))
        : norm(actual).includes(norm(expected));
    case 'not_contains':
      return !evaluateCondition({ ...cond, op: 'contains' }, answers);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (cond.op === 'gt') return a > b;
      if (cond.op === 'gte') return a >= b;
      if (cond.op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

export function evaluateRule(rule, answers) {
  const conds = rule.conditions || [];
  if (conds.length === 0) return true; // "always" rule
  return rule.match === 'any'
    ? conds.some((c) => evaluateCondition(c, answers))
    : conds.every((c) => evaluateCondition(c, answers));
}

/**
 * Decide which question comes after `currentId`.
 * Order: first matching logic rule → question's default `next` → sequential order.
 * Returns a question id or END.
 */
export function nextQuestionId(form, currentId, answers) {
  const qs = form.questions || [];
  const idx = qs.findIndex((q) => q.id === currentId);
  if (idx === -1) return END;
  const q = qs[idx];
  for (const rule of q.logic || []) {
    if (rule.goto && evaluateRule(rule, answers)) return resolveTarget(form, rule.goto);
  }
  if (q.next) return resolveTarget(form, q.next);
  return idx + 1 < qs.length ? qs[idx + 1].id : END;
}

function resolveTarget(form, target) {
  if (target === END) return END;
  return (form.questions || []).some((q) => q.id === target) ? target : END;
}

export function firstQuestionId(form) {
  return form.questions && form.questions.length ? form.questions[0].id : END;
}

/**
 * Walks the form with current answers to estimate how many questions remain.
 * Unanswered questions stop logic evaluation from being meaningful, so the
 * walk follows the default path for them. Guards against cycles.
 */
export function estimatePath(form, fromId, answers) {
  const path = [];
  const seen = new Set();
  let id = fromId;
  while (id && id !== END && !seen.has(id)) {
    seen.add(id);
    path.push(id);
    id = nextQuestionId(form, id, answers);
  }
  return path;
}

export function progress(form, history, currentId, answers) {
  const remaining = estimatePath(form, currentId, answers).length;
  const done = history.length;
  const total = done + remaining;
  return total === 0 ? 1 : done / total;
}

/** Replace {{questionId}} or {{hidden:name}} with answers (answer piping). */
export function interpolate(text, answers, hidden = {}) {
  return String(text || '').replace(/\{\{\s*([\w:-]+)\s*\}\}/g, (_, key) => {
    if (key.startsWith('hidden:')) return hidden[key.slice(7)] ?? '';
    const v = answers[key];
    if (isFileList(v)) return v.map((f) => f.name).join(', ');
    if (Array.isArray(v)) return v.join(', ');
    return v ?? '';
  });
}

/** Detects logic that can loop forever (A → B → A with always-true rules). */
export function findLogicProblems(form) {
  const problems = [];
  const ids = new Set((form.questions || []).map((q) => q.id));
  for (const q of form.questions || []) {
    for (const [i, rule] of (q.logic || []).entries()) {
      if (rule.goto && rule.goto !== END && !ids.has(rule.goto)) {
        problems.push(`"${q.title || q.id}": aturan #${i + 1} menuju pertanyaan yang sudah dihapus.`);
      }
      const qIdx = form.questions.indexOf(q);
      const tIdx = form.questions.findIndex((x) => x.id === rule.goto);
      if (tIdx !== -1 && tIdx <= qIdx) {
        problems.push(`"${q.title || q.id}": aturan #${i + 1} melompat mundur — pastikan tidak membuat loop.`);
      }
      for (const c of rule.conditions || []) {
        if (!ids.has(c.field) && !(form.hiddenFields || []).includes(c.field)) {
          problems.push(`"${q.title || q.id}": aturan #${i + 1} memakai field yang tidak ada.`);
        }
      }
    }
  }
  return problems;
}

// ─── Partial responses (abandonment recovery) ───────────────────────────────
export const DEFAULT_CONSENT_TEXT = 'Dengan mengisi kontak ini, Anda setuju dihubungi terkait form ini walaupun belum selesai mengisi.';
export const PARTIAL_RETENTION_DAYS = 30;

/** Whether this form keeps unfinished answers once contact details are known. */
export function partialsEnabled(form) {
  return !!form?.recovery?.partials;
}

/**
 * Contact details found in the answers: the first valid email and phone
 * answers, plus the first short-text answer as a probable name.
 * Returns null when neither an email nor a phone number is present.
 */
export function contactFrom(form, answers = {}) {
  let email = '';
  let phone = '';
  let name = '';
  for (const q of form?.questions || []) {
    const v = answers[q.id];
    if (isEmpty(v)) continue;
    if (q.type === 'email' && !email && !validateAnswer({ ...q, required: false }, v)) email = String(v).trim();
    if (q.type === 'phone' && !phone && !validateAnswer({ ...q, required: false }, v)) phone = String(v).trim();
    if (q.type === 'short_text' && !name) name = String(v).trim().slice(0, 100);
  }
  return email || phone ? { email, phone, name } : null;
}

/**
 * Answers safe to store for an unfinished response: only real questions of
 * this form, values that pass format validation, lengths capped.
 */
export function cleanPartialAnswers(form, answers = {}) {
  const out = {};
  for (const q of form?.questions || []) {
    const v = answers[q.id];
    // Files of unfinished responses are not kept (data minimisation; they are cleaned up after a day).
    if (q.type === 'statement' || q.type === 'file_upload' || isEmpty(v) || validateAnswer({ ...q, required: false }, v)) continue;
    out[q.id] = Array.isArray(v) ? v.slice(0, 50).map((x) => String(x).slice(0, 500)) : typeof v === 'number' ? v : String(v).slice(0, 5000);
  }
  return out;
}

/** wa.me link for an answer like "+62 812-3456-7890" or "0812…" (Indonesian default). */
export function whatsappLink(phone, text = '') {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  if (d.length < 8) return '';
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** Title for places where piping can't be resolved (lists, charts, sheet headers). */
export function plainTitle(text) {
  return String(text || '').replace(/\{\{\s*[\w:-]+\s*\}\}/g, '…').replace(/\s+/g, ' ').trim();
}

export function uid(prefix = 'q') {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36).slice(-4)}${rnd}`;
}

// ─── Custom form links ──────────────────────────────────────────────────────
// A form can have its own short path, e.g. https://belajarlagiform.<akun>.workers.dev/beasiswa-2026.
// One path segment of lower-case letters, digits and dashes, so it never collides
// with a static file (those have a dot) or with the routes below.
export const SLUG_MAX = 50;
export const RESERVED_SLUGS = ['api', 'f', 'm', 'css', 'js', 'img', 'assets', 'static', 'index', 'form', 'dashboard', 'embed', 'admin', 'login', 'masuk', 'logout', 'tim', 'team', 'settings', 'favicon', 'robots', 'sitemap', 'well-known'];

export function cleanSlug(raw) {
  return String(raw || '').toLowerCase().trim()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
}

/** Why a slug cannot be used, or null. Expects an already-cleaned slug. */
export function slugProblem(slug) {
  const s = String(slug || '');
  if (s.length < 3) return 'Link minimal 3 karakter.';
  if (s.length > SLUG_MAX) return `Link maksimal ${SLUG_MAX} karakter.`;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)) return 'Pakai huruf kecil, angka, dan tanda hubung saja.';
  if (RESERVED_SLUGS.includes(s)) return `"${s}" dipakai sistem. Pilih nama lain.`;
  return null;
}
