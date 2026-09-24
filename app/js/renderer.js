// Typeform-style screen renderer, shared by the live form (mode "live") and
// the builder canvas (mode "edit"), so the builder preview is pixel-identical
// to what respondents see.
import { el } from './dom.js';
import { icon } from './icons.js';
import { interpolate, plainTitle, scaleRange } from './logic.js';

// ─── Theme ──────────────────────────────────────────────────────────────────
export const FONTS = {
  Satoshi: 'https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,700&display=swap',
  Inter: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;700&display=swap',
  Karla: 'https://fonts.googleapis.com/css2?family=Karla:wght@300;400;500;700&display=swap',
  'DM Sans': 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;700&display=swap',
  Poppins: 'https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;700&display=swap',
  Montserrat: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;700&display=swap',
  Lora: 'https://fonts.googleapis.com/css2?family=Lora:wght@400;500;700&display=swap',
  'Playfair Display': 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;700&display=swap',
};

export const THEME_PRESETS = [
  { name: 'Belajarlagi', font: 'Satoshi', background: '#FCFCFC', question: '#060B14', answer: '#3967BD', button: '#3967BD', buttonText: '#FFFFFF' },
  { name: 'Klasik', font: 'Karla', background: '#FFFFFF', question: '#191919', answer: '#0445AF', button: '#0445AF', buttonText: '#FFFFFF' },
  { name: 'Malam', font: 'Inter', background: '#0E1520', question: '#FCFCFC', answer: '#F5B800', button: '#F5B800', buttonText: '#060B14' },
  { name: 'Senja', font: 'Lora', background: '#FFF4E8', question: '#4A1D0A', answer: '#C2410C', button: '#C2410C', buttonText: '#FFFFFF' },
  { name: 'Hutan', font: 'DM Sans', background: '#EEF5EE', question: '#0F2E1D', answer: '#1F7A4D', button: '#1F7A4D', buttonText: '#FFFFFF' },
  { name: 'Lavender', font: 'Poppins', background: '#F4F0FF', question: '#2A1454', answer: '#6D28D9', button: '#6D28D9', buttonText: '#FFFFFF' },
  { name: 'Monokrom', font: 'Montserrat', background: '#F2F2F2', question: '#111111', answer: '#111111', button: '#111111', buttonText: '#FFFFFF' },
  { name: 'Editorial', font: 'Playfair Display', background: '#FBF8F3', question: '#1D1B16', answer: '#8A5A2B', button: '#1D1B16', buttonText: '#FBF8F3' },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Fills defaults and migrates the v1 theme shape ({primary, background, text}). */
export function normalizeTheme(t = {}) {
  const base = THEME_PRESETS[0];
  const pick = (v, fallback) => (HEX.test(v || '') ? v : fallback);
  const answer = pick(t.answer, pick(t.primary, base.answer));
  return {
    ...t,
    font: FONTS[t.font] ? t.font : base.font,
    background: pick(t.background, base.background),
    question: pick(t.question, pick(t.text, base.question)),
    answer,
    button: pick(t.button, pick(t.primary, base.button)),
    buttonText: pick(t.buttonText, base.buttonText),
    corners: ['none', 'small', 'large'].includes(t.corners) ? t.corners : 'small',
    align: t.align === 'center' ? 'center' : 'left',
    brightness: Math.max(-80, Math.min(80, Number(t.brightness) || 0)),
  };
}

const loadedFonts = new Set();
function loadFont(name) {
  if (loadedFonts.has(name) || !FONTS[name]) return;
  loadedFonts.add(name);
  if ([...document.styleSheets].some((s) => s.href === FONTS[name])) return;
  document.head.append(el('link', { rel: 'stylesheet', href: FONTS[name] }));
}

export function applyTheme(root, theme) {
  const t = normalizeTheme(theme);
  loadFont(t.font);
  const s = root.style;
  s.setProperty('--ff-bg', t.background);
  s.setProperty('--ff-q', t.question);
  s.setProperty('--ff-a', t.answer);
  s.setProperty('--ff-btn', t.button);
  s.setProperty('--ff-btn-text', t.buttonText);
  s.setProperty('--ff-font', `'${t.font}', 'DM Sans', system-ui, sans-serif`); // DM Sans: fallback where Fontshare is blocked
  s.setProperty('--ff-radius', { none: '0px', small: '6px', large: '16px' }[t.corners]);
  // Brightness: negative darkens the background image, positive lightens it.
  const b = t.brightness / 100;
  s.setProperty('--ff-overlay', b < 0 ? `rgba(0,0,0,${-b})` : `rgba(255,255,255,${b})`);
  if (t.backgroundImage && /^https:\/\//.test(t.backgroundImage)) {
    s.setProperty('--ff-bg-image', `url("${t.backgroundImage.replace(/["\\]/g, '')}")`);
    root.classList.add('ff-has-image');
  } else {
    s.removeProperty('--ff-bg-image');
    root.classList.remove('ff-has-image');
  }
  root.classList.toggle('ff-center', t.align === 'center');
  return t;
}

/** The form owner's logo (theme.logoUrl), pinned to the top-left like Typeform. */
export function brandLogo(theme = {}) {
  const url = theme.logoUrl;
  if (!url || !/^https:\/\//.test(url)) return null;
  return el('img', { class: 'ff-logo', src: url.replace(/["\\]/g, ''), alt: '' });
}

// ─── Helpers ────────────────────────────────────────────────────────────────
export function questionNumber(form, q) {
  const list = (form.questions || []).filter((x) => x.type !== 'statement');
  return list.indexOf(q) + 1;
}

export function estimateMinutes(form) {
  const n = (form.questions || []).filter((q) => q.type !== 'statement').length;
  return Math.max(1, Math.round((n * 10) / 60)); // ~10 s per question
}

export const PHONE_COUNTRIES = [
  ['ID', '🇮🇩', '+62'], ['MY', '🇲🇾', '+60'], ['SG', '🇸🇬', '+65'], ['US', '🇺🇸', '+1'], ['GB', '🇬🇧', '+44'],
  ['AU', '🇦🇺', '+61'], ['JP', '🇯🇵', '+81'], ['SA', '🇸🇦', '+966'], ['AE', '🇦🇪', '+971'], ['NL', '🇳🇱', '+31'],
];

function hint(text, keys) {
  return el('span', { class: 'ff-hint' }, text, ' ', el('strong', { text: keys }));
}

function okButton(label, onClick, { withIcon = true } = {}) {
  return el('button', { class: 'ff-btn', type: 'button', onclick: onClick }, el('span', { text: label }), withIcon ? icon('check', { size: 18 }) : null);
}

// ─── Rich text (answer recall chips in edit mode) ───────────────────────────
const TOKEN = /\{\{\s*([\w:-]+)\s*\}\}/g;

function serialize(node) {
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.dataset?.token) out += `{{${n.dataset.token}}}`;
    else if (n.nodeName === 'BR') out += '\n';
    else if (n.nodeName === 'DIV' || n.nodeName === 'P') out += (out && !out.endsWith('\n') ? '\n' : '') + serialize(n);
    else out += serialize(n);
  });
  return out.replace(/\u00A0/g, ' ');
}

function chip(token, label) {
  return el('span', { class: 'ff-chip', contenteditable: 'false', 'data-token': token, text: label || token });
}

let openMenu = null;
function closeRecallMenu() { openMenu?.remove(); openMenu = null; }

/**
 * contenteditable field that keeps {{token}} recall references as chips.
 * Typing "@" opens a menu of earlier answers (like Typeform's recall).
 */
export function editableText(text, { tag = 'div', className = '', placeholder = '', multiline = false, recall = [], onChange }) {
  const labels = Object.fromEntries(recall.map((r) => [r.token, r.label]));
  const node = el(tag, { class: `ff-editable ${className}`, contenteditable: 'true', spellcheck: 'false', 'data-placeholder': placeholder });
  let last = 0;
  String(text || '').replace(TOKEN, (m, key, idx) => {
    if (idx > last) node.append(document.createTextNode(String(text).slice(last, idx)));
    node.append(chip(key, labels[key] || key));
    last = idx + m.length;
    return m;
  });
  if (last < String(text || '').length) node.append(document.createTextNode(String(text).slice(last)));

  const emit = () => {
    const v = serialize(node);
    onChange?.(multiline ? v : v.replace(/\n/g, ' '));
  };
  const insertChip = (r) => {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const { startContainer: c, startOffset: o } = range;
    if (c.nodeType === 3 && c.nodeValue[o - 1] === '@') { range.setStart(c, o - 1); range.deleteContents(); }
    const ch = chip(r.token, r.label);
    range.insertNode(ch);
    const space = document.createTextNode('\u00A0');
    ch.after(space);
    range.setStartAfter(space); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    closeRecallMenu();
    emit();
  };
  const showMenu = () => {
    closeRecallMenu();
    if (!recall.length) return;
    const sel = getSelection();
    const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : node.getBoundingClientRect();
    let active = 0;
    const items = recall.map((r, i) => el('button', {
      type: 'button', class: `ff-recall-item${i === 0 ? ' active' : ''}`,
      onmousedown: (e) => { e.preventDefault(); insertChip(r); },
    }, el('span', { class: 'ff-recall-kind', text: r.kind || 'Jawaban' }), el('span', { text: r.label })));
    openMenu = el('div', { class: 'ff-recall-menu', role: 'listbox' }, el('div', { class: 'ff-recall-head', text: 'Sisipkan jawaban sebelumnya' }), items);
    openMenu.style.left = `${Math.min(rect.left, innerWidth - 280) + scrollX}px`;
    openMenu.style.top = `${rect.bottom + 6 + scrollY}px`;
    openMenu.navigate = (d) => { items[active].classList.remove('active'); active = (active + d + items.length) % items.length; items[active].classList.add('active'); items[active].scrollIntoView({ block: 'nearest' }); };
    openMenu.pick = () => insertChip(recall[active]);
    document.body.append(openMenu);
  };

  node.addEventListener('input', (e) => {
    if (e.data === '@') showMenu(); else if (openMenu && e.inputType !== 'insertText') closeRecallMenu();
    emit();
  });
  node.addEventListener('keydown', (e) => {
    if (openMenu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); openMenu.navigate(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); openMenu.navigate(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); openMenu.pick(); return; }
      if (e.key === 'Escape') { closeRecallMenu(); return; }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (multiline && e.shiftKey) document.execCommand('insertLineBreak');
      else node.blur();
    }
  });
  node.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, multiline ? t : t.replace(/\s*\n\s*/g, ' '));
  });
  node.addEventListener('blur', () => setTimeout(closeRecallMenu, 150));
  return node;
}

// ─── Inputs (live mode) ─────────────────────────────────────────────────────
// Each builder returns { el, getValue(), focus(), onKey(e) → handled? }.

function textInput(q, ctx, kind) {
  const s = q.settings || {};
  const placeholders = { email: 'nama@contoh.com', number: 'Ketik angka…', short_text: 'Ketik jawaban di sini…' };
  const input = el('input', {
    class: 'ff-text', type: kind === 'email' ? 'email' : 'text', value: ctx.value ?? '',
    placeholder: s.placeholder || placeholders[kind] || placeholders.short_text,
    inputmode: kind === 'number' ? 'decimal' : kind === 'email' ? 'email' : undefined,
    autocomplete: kind === 'email' ? 'email' : 'off', maxlength: s.maxLength || (kind === 'short_text' ? 500 : undefined),
    'aria-labelledby': `t_${q.id}`, readonly: ctx.mode === 'edit' ? true : undefined, tabindex: ctx.mode === 'edit' ? -1 : undefined,
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); ctx.submit(); } },
  });
  return {
    el: input,
    focus: () => input.focus({ preventScroll: true }),
    getValue: () => {
      const v = input.value.trim();
      if (kind !== 'number' || v === '') return v;
      const n = Number(v.replace(',', '.'));
      return Number.isFinite(n) ? n : v;
    },
  };
}

function longText(q, ctx) {
  const s = q.settings || {};
  const ta = el('textarea', {
    class: 'ff-text ff-textarea', rows: 1, placeholder: s.placeholder || 'Ketik jawaban di sini…', maxlength: s.maxLength || 5000,
    'aria-labelledby': `t_${q.id}`, readonly: ctx.mode === 'edit' ? true : undefined, tabindex: ctx.mode === 'edit' ? -1 : undefined,
  });
  ta.value = ctx.value ?? '';
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ctx.submit(); } });
  requestAnimationFrame(grow);
  return {
    el: el('div', {}, ta, el('div', { class: 'ff-subhint' }, el('strong', { text: 'Shift ⇧ + Enter ↵' }), ' untuk baris baru')),
    focus: () => ta.focus({ preventScroll: true }),
    getValue: () => ta.value.trim(),
  };
}

function phoneInput(q, ctx) {
  const s = q.settings || {};
  const current = String(ctx.value || '');
  const match = PHONE_COUNTRIES.find(([, , code]) => current.startsWith(`${code} `));
  const country = el('select', { class: 'ff-country', 'aria-label': 'Kode negara', disabled: ctx.mode === 'edit' ? true : undefined },
    PHONE_COUNTRIES.map(([iso, flag, code]) => el('option', { value: code, selected: match ? match[2] === code : iso === (s.defaultCountry || 'ID'), text: `${flag} ${code}` })));
  const input = el('input', {
    class: 'ff-text', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', placeholder: s.placeholder || '812 3456 7890',
    value: match ? current.slice(match[2].length + 1) : current, 'aria-labelledby': `t_${q.id}`,
    readonly: ctx.mode === 'edit' ? true : undefined, tabindex: ctx.mode === 'edit' ? -1 : undefined,
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); ctx.submit(); } },
  });
  return {
    el: el('div', { class: 'ff-phone' }, country, input),
    focus: () => input.focus({ preventScroll: true }),
    getValue: () => {
      const v = input.value.trim();
      if (!v) return '';
      if (v.startsWith('+')) return v;
      return `${country.value} ${v.replace(/^0+/, '')}`; // 0812… → +62 812…
    },
  };
}

function dateInput(q, ctx) {
  const [y, m, d] = String(ctx.value || '').split('-');
  const edit = ctx.mode === 'edit';
  const part = (label, value, len, ph) => {
    const input = el('input', {
      class: 'ff-text ff-date-part', inputmode: 'numeric', maxlength: len, placeholder: ph, value: value || '',
      'aria-label': label, readonly: edit ? true : undefined, tabindex: edit ? -1 : undefined,
    });
    return { input, wrap: el('label', { class: 'ff-date-field' }, el('span', { class: 'ff-date-label', text: label }), input) };
  };
  const dd = part('Hari', d, 2, 'DD');
  const mm = part('Bulan', m, 2, 'MM');
  const yy = part('Tahun', y, 4, 'YYYY');
  const parts = [dd, mm, yy];
  parts.forEach((p, i) => {
    p.input.addEventListener('input', () => {
      p.input.value = p.input.value.replace(/\D/g, '');
      if (p.input.value.length === Number(p.input.maxLength) && parts[i + 1]) parts[i + 1].input.focus();
    });
    p.input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !p.input.value && parts[i - 1]) parts[i - 1].input.focus();
      if (e.key === 'Enter') { e.preventDefault(); ctx.submit(); }
    });
  });
  return {
    el: el('div', { class: 'ff-date' }, dd.wrap, el('span', { class: 'ff-date-sep', text: '/' }), mm.wrap, el('span', { class: 'ff-date-sep', text: '/' }), yy.wrap),
    focus: () => dd.input.focus({ preventScroll: true }),
    getValue: () => {
      const [a, b, c] = parts.map((p) => p.input.value.trim());
      if (!a && !b && !c) return '';
      return `${c.padStart(4, '0')}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    },
  };
}

function choiceInput(q, ctx) {
  const s = q.settings || {};
  const edit = ctx.mode === 'edit';
  const yesNo = q.type === 'yes_no';
  const options = yesNo ? [{ id: 'y', label: 'Ya' }, { id: 'n', label: 'Tidak' }] : (q.options || []);
  const multiple = q.type === 'multiple_choice' && !!s.multiple;
  const selected = new Set(Array.isArray(ctx.value) ? ctx.value : ctx.value ? [ctx.value] : []);
  const order = s.randomize && !edit ? [...options].sort(() => Math.random() - 0.5) : options;
  const list = el('div', { class: `ff-choices${s.horizontal ? ' ff-choices-row' : ''}`, role: multiple ? 'group' : 'radiogroup', 'aria-labelledby': `t_${q.id}` });
  const buttons = [];
  let okWrap = null;
  const refreshOk = () => { if (okWrap) okWrap.hidden = !selected.size; };

  order.forEach((o, i) => {
    const key = yesNo ? (i === 0 ? 'Y' : 'N') : String.fromCharCode(65 + i);
    const label = edit && !yesNo
      ? editableText(o.label, { tag: 'span', className: 'ff-choice-label', placeholder: `Pilihan ${i + 1}`, onChange: (v) => { o.label = v; ctx.onEdit?.(); } })
      : el('span', { class: 'ff-choice-label', text: o.label });
    const btn = el(edit ? 'div' : 'button', {
      type: edit ? undefined : 'button', class: `ff-choice${selected.has(o.label) ? ' selected' : ''}`, 'data-key': key,
      role: edit ? undefined : multiple ? 'checkbox' : 'radio', 'aria-checked': edit ? undefined : String(selected.has(o.label)),
    },
    el('span', { class: 'ff-key' }, el('span', { class: 'ff-key-word', text: 'Tekan' }), el('span', { text: key })),
    label,
    el('span', { class: 'ff-choice-check' }, icon('check', { size: 16 })),
    edit && !yesNo ? el('button', {
      type: 'button', class: 'ff-choice-del', title: 'Hapus pilihan',
      onclick: () => { q.options.splice(q.options.indexOf(o), 1); ctx.onEdit?.({ rerender: true }); },
    }, icon('close', { size: 14 })) : null);
    if (!edit) {
      btn.addEventListener('click', () => {
        if (multiple) {
          if (selected.has(o.label)) selected.delete(o.label);
          else {
            if (s.maxSelections && selected.size >= Number(s.maxSelections)) return;
            selected.add(o.label);
          }
          btn.classList.toggle('selected', selected.has(o.label));
          btn.setAttribute('aria-checked', String(selected.has(o.label)));
          refreshOk();
        } else {
          buttons.forEach((b) => { b.classList.remove('selected'); b.setAttribute('aria-checked', 'false'); });
          btn.classList.add('selected', 'ff-blink');
          btn.setAttribute('aria-checked', 'true');
          selected.clear(); selected.add(o.label);
          setTimeout(() => ctx.submit(o.label), 450);
        }
      });
    }
    buttons.push(btn);
    list.append(btn);
  });

  if (edit && !yesNo) {
    list.append(el('button', {
      type: 'button', class: 'ff-choice ff-choice-add',
      onclick: () => { q.options.push({ id: `o_${Date.now().toString(36)}`, label: '' }); ctx.onEdit?.({ rerender: true, focusLast: true }); },
    }, el('span', { class: 'ff-key' }, icon('plus', { size: 12 })), el('span', { class: 'ff-choice-label', text: 'Tambah pilihan' })));
  }

  const parts = [];
  if (multiple) parts.push(el('div', { class: 'ff-subhint ff-above', text: s.maxSelections ? `Pilih maksimal ${s.maxSelections}` : 'Pilih sebanyak yang Anda mau' }));
  parts.push(list);
  return {
    el: el('div', {}, parts),
    // Single choice advances by itself; OK appears for multi-select or when revisiting.
    needsOk: multiple ? 'selection' : selected.size ? 'selection' : 'never',
    bindOk: (wrap) => { okWrap = wrap; refreshOk(); },
    focus: () => {},
    getValue: () => (multiple ? [...selected] : [...selected][0] ?? ''),
    onKey: (e) => {
      const b = buttons.find((x) => x.dataset.key === e.key.toUpperCase());
      if (b) { b.click(); return true; }
      return false;
    },
  };
}

function dropdownInput(q, ctx) {
  const edit = ctx.mode === 'edit';
  const options = (q.options || []).map((o) => o.label);
  const input = el('input', {
    class: 'ff-text', type: 'text', placeholder: 'Ketik atau pilih opsi', value: ctx.value || '', autocomplete: 'off',
    role: 'combobox', 'aria-expanded': 'false', 'aria-labelledby': `t_${q.id}`,
    readonly: edit ? true : undefined, tabindex: edit ? -1 : undefined,
  });
  const list = el('ul', { class: 'ff-dd-list', role: 'listbox', hidden: true });
  let active = -1;
  let items = [];
  const render = () => {
    const term = input.value.trim().toLowerCase();
    const matches = options.filter((o) => o.toLowerCase().includes(term));
    items = matches.map((o, i) => el('li', {
      role: 'option', class: `ff-dd-item${o === ctx.value ? ' selected' : ''}`, 'aria-selected': String(i === active),
      onmousedown: (e) => { e.preventDefault(); choose(o); },
    }, el('span', { text: o }), o === ctx.value ? icon('check', { size: 16 }) : null));
    list.replaceChildren(...(items.length ? items : [el('li', { class: 'ff-dd-empty', text: 'Tidak ada opsi yang cocok' })]));
    active = Math.min(active, items.length - 1);
    items.forEach((it, i) => it.classList.toggle('active', i === active));
  };
  const open = (v) => { list.hidden = !v; input.setAttribute('aria-expanded', String(v)); if (v) render(); };
  const choose = (o) => { input.value = o; ctx.value = o; open(false); setTimeout(() => ctx.submit(o), 250); };
  const toggle = el('button', { type: 'button', class: 'ff-dd-toggle', 'aria-label': 'Buka opsi', tabindex: -1, onclick: () => { open(list.hidden); input.focus(); } }, icon('chevronDown', { size: 22 }));
  if (!edit) {
    input.addEventListener('focus', () => open(true));
    input.addEventListener('blur', () => setTimeout(() => open(false), 120));
    input.addEventListener('input', () => { active = 0; open(true); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(true); active = Math.min(items.length - 1, active + 1); render(); items[active]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); items[active]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const exact = options.find((o) => o.toLowerCase() === input.value.trim().toLowerCase());
        const pick = items[active] ? items[active].textContent : exact;
        if (pick) choose(pick); else ctx.submit();
      } else if (e.key === 'Escape') open(false);
    });
  }
  const field = el('div', { class: 'ff-dd-field' }, input, toggle);
  const parts = [el('div', { class: 'ff-dd' }, field, list)];
  if (edit) {
    // Builder: the choices are edited as a list below the (disabled) dropdown.
    const editor = choiceInput({ ...q, type: 'multiple_choice', settings: {} }, ctx);
    editor.el.classList.add('ff-dd-editor');
    parts.push(editor.el);
  }
  return {
    el: el('div', {}, parts),
    focus: () => input.focus({ preventScroll: true }),
    getValue: () => {
      const v = input.value.trim();
      return options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? v;
    },
  };
}

function scaleInput(q, ctx) {
  const s = q.settings || {};
  const { min, max } = scaleRange(q);
  const rating = q.type === 'rating';
  const current = ctx.value === '' || ctx.value === undefined ? null : Number(ctx.value);
  const row = el('div', { class: `ff-scale ${rating ? 'ff-rating' : 'ff-opinion'}`, role: 'radiogroup', 'aria-labelledby': `t_${q.id}` });
  const buttons = [];
  const paint = (upTo, cls) => buttons.forEach((b, i) => {
    const n = min + i;
    b.classList.toggle(cls, rating ? n <= upTo : n === upTo);
  });
  for (let n = min; n <= max; n++) {
    const b = el('button', {
      type: 'button', class: `ff-scale-item${current === n ? ' selected' : ''}`, role: 'radio', 'aria-checked': String(current === n),
      'aria-label': String(n), tabindex: ctx.mode === 'edit' ? -1 : undefined,
    }, rating ? icon('star', { size: 40, className: 'ff-star' }) : null, el('span', { class: 'ff-scale-num', text: String(n) }));
    if (ctx.mode !== 'edit') {
      b.addEventListener('mouseenter', () => paint(n, 'hover'));
      b.addEventListener('click', () => {
        paint(n, 'selected');
        b.classList.add('ff-blink');
        setTimeout(() => ctx.submit(n), 400);
      });
    }
    buttons.push(b);
    row.append(b);
  }
  row.addEventListener('mouseleave', () => paint(-Infinity, 'hover'));
  if (rating && current !== null) paint(current, 'selected');
  const labels = (s.labelLeft || s.labelCenter || s.labelRight)
    ? el('div', { class: 'ff-scale-labels' }, el('span', { text: s.labelLeft || '' }), el('span', { text: s.labelCenter || '' }), el('span', { text: s.labelRight || '' }))
    : null;
  let pending = '';
  let timer = null;
  return {
    el: el('div', { class: 'ff-scale-wrap' }, row, labels),
    needsOk: current !== null ? 'selection' : 'never',
    bindOk: () => {},
    focus: () => {},
    getValue: () => { const sel = row.querySelectorAll('.selected'); return sel.length ? (rating ? min + sel.length - 1 : Number(sel[0].textContent)) : ''; },
    onKey: (e) => {
      if (!/^\d$/.test(e.key)) return false;
      clearTimeout(timer);
      const press = (n) => buttons[n - min]?.click();
      // On 0–10 scales "1" may be the start of "10": wait briefly for a second digit.
      if (max >= 10 && pending === '1') { pending = ''; press(Number(`1${e.key}`)); return true; }
      if (max >= 10 && e.key === '1') { pending = '1'; timer = setTimeout(() => { pending = ''; press(1); }, 600); return true; }
      press(Number(e.key));
      return true;
    },
  };
}

function buildInput(q, ctx) {
  switch (q.type) {
    case 'short_text': case 'email': case 'number': return textInput(q, ctx, q.type);
    case 'long_text': return longText(q, ctx);
    case 'phone': return phoneInput(q, ctx);
    case 'date': return dateInput(q, ctx);
    case 'multiple_choice': case 'yes_no': return choiceInput(q, ctx);
    case 'dropdown': return dropdownInput(q, ctx);
    case 'rating': case 'opinion_scale': return scaleInput(q, ctx);
    default: return { el: null, getValue: () => undefined, focus: () => {} };
  }
}

// ─── Screens ────────────────────────────────────────────────────────────────
function text(ctx, value, opts) {
  if (ctx.mode === 'edit') return editableText(value, { ...opts, recall: ctx.recall || [], onChange: opts.onChange });
  const t = interpolate(value, ctx.answers || {}, ctx.hidden || {});
  return t ? el(opts.tag || 'div', { class: opts.className, text: t }) : null;
}

export function welcomeScreen(form, ctx) {
  const w = form.welcome || (form.welcome = { enabled: true });
  const edit = ctx.mode === 'edit';
  const set = (k) => (v) => { w[k] = v; ctx.onEdit(); };
  const btnLabel = w.buttonText || 'Mulai';
  return {
    el: el('section', { class: 'ff-screen ff-welcome' },
      w.imageUrl && /^https:\/\//.test(w.imageUrl) ? el('img', { class: 'ff-welcome-img', src: w.imageUrl, alt: '' }) : null,
      text(ctx, w.title || form.title, { tag: 'h1', className: 'ff-title ff-title-xl', placeholder: 'Judul halaman pembuka', onChange: set('title') }),
      text(ctx, w.description, { tag: 'p', className: 'ff-desc', placeholder: 'Deskripsi (opsional)', multiline: true, onChange: set('description') }),
      el('div', { class: 'ff-actions' },
        edit
          ? el('div', { class: 'ff-btn' }, editableText(btnLabel, { tag: 'span', placeholder: 'Mulai', onChange: set('buttonText') }))
          : okButton(btnLabel, () => ctx.start(), { withIcon: false }),
        hint('tekan', 'Enter ↵')),
      el('div', { class: 'ff-time' }, icon('clock', { size: 15 }),
        `${(form.questions || []).filter((q) => q.type !== 'statement').length} pertanyaan · sekitar ${estimateMinutes(form)} menit`)),
    focus: () => {},
    onKey: (e) => { if (e.key === 'Enter' && !edit) { e.preventDefault(); ctx.start(); return true; } return false; },
  };
}

export function thankYouScreen(form, ctx) {
  const t = form.thankyou || (form.thankyou = {});
  const edit = ctx.mode === 'edit';
  const set = (k) => (v) => { t[k] = v; ctx.onEdit(); };
  return {
    el: el('section', { class: 'ff-screen ff-ending' },
      el('div', { class: 'ff-done', 'aria-hidden': 'true' }, icon('check', { size: 28 })),
      text(ctx, t.title || 'Terima kasih!', { tag: 'h1', className: 'ff-title ff-title-xl', placeholder: 'Judul halaman akhir', onChange: set('title') }),
      text(ctx, t.description, { tag: 'p', className: 'ff-desc', placeholder: 'Deskripsi (opsional)', multiline: true, onChange: set('description') }),
      t.buttonText && (edit || /^https?:\/\//.test(t.buttonUrl || ''))
        ? el('div', { class: 'ff-actions' }, edit
          ? el('div', { class: 'ff-btn', text: t.buttonText })
          : el('a', { class: 'ff-btn', href: t.buttonUrl, target: '_top', rel: 'noopener', text: t.buttonText }))
        : null),
    focus: () => {},
    onKey: () => false,
  };
}

/**
 * ctx (live): { mode: 'live', answers, hidden, value, isLast, consent?, onSubmit(value) }
 * ctx (edit): { mode: 'edit', recall: [{token,label,kind}], onEdit(opts?) } — edits mutate the form in place
 */
export function questionScreen(form, q, ctx) {
  const edit = ctx.mode === 'edit';
  const s = q.settings || {};
  const errorBox = el('div', { class: 'ff-error', role: 'alert', hidden: true });
  const layout = q.imageUrl && /^https:\/\//.test(q.imageUrl) ? (q.layout || 'stack') : 'none';
  let input;
  const api = {
    showError(msg) {
      errorBox.replaceChildren(icon('warning', { size: 16 }), el('span', { text: msg }));
      errorBox.hidden = false;
      screen.classList.remove('ff-shake'); void screen.offsetWidth; screen.classList.add('ff-shake');
    },
    clearError() { errorBox.hidden = true; },
  };
  ctx.submit = (v) => { if (!edit) ctx.onSubmit(v !== undefined ? v : input.getValue(), api); };
  input = q.type === 'statement' ? { el: null, getValue: () => undefined, focus: () => {} } : buildInput(q, ctx);

  const num = q.type === 'statement'
    ? el('span', { class: 'ff-num ff-num-quote' }, icon('quote', { size: 20 }))
    : el('span', { class: 'ff-num' }, el('span', { text: String(questionNumber(form, q)) }), icon('arrowRight', { size: 14 }));

  const okLabel = q.type === 'statement' ? (s.buttonText || 'Lanjut') : ctx.isLast ? 'Kirim' : 'OK';
  const okNode = edit
    ? el('div', { class: 'ff-btn' }, el('span', { text: okLabel }), q.type === 'statement' || ctx.isLast ? null : icon('check', { size: 18 }))
    : okButton(okLabel, () => ctx.submit(), { withIcon: q.type !== 'statement' && !ctx.isLast });
  const actions = el('div', { class: 'ff-actions' }, okNode, hint('tekan', 'Enter ↵'));
  if (!edit) {
    if (input.needsOk === 'never') actions.hidden = true;
    input.bindOk?.(actions);
  }

  const content = el('div', { class: 'ff-content' },
    el('div', { class: 'ff-head' }, num,
      el('h2', { class: 'ff-title', id: `t_${q.id}` },
        text(ctx, q.title, { tag: 'span', className: 'ff-title-text', placeholder: 'Tulis pertanyaan di sini…', onChange: (v) => { q.title = v; ctx.onEdit(); } }),
        q.required && q.type !== 'statement' ? el('span', { class: 'ff-req', text: '*' }) : null)),
    edit ? el('div', { class: 'ff-edit-hint' }, 'Ketik ', el('kbd', { text: '@' }), ' untuk menyisipkan jawaban sebelumnya') : null,
    text(ctx, q.description, { tag: 'p', className: 'ff-desc', placeholder: 'Deskripsi (opsional)', multiline: true, onChange: (v) => { q.description = v; ctx.onEdit(); } }),
    layout === 'stack' ? el('img', { class: 'ff-q-img', src: q.imageUrl, alt: '' }) : null,
    input.el ? el('div', { class: 'ff-input' }, input.el) : null,
    // Shown when the form keeps unfinished answers (UU PDP: say why contact data is kept).
    ctx.consent && (q.type === 'email' || q.type === 'phone')
      ? el('p', { class: 'ff-consent' }, icon('lock', { size: 14 }), el('span', { text: ctx.consent }))
      : null,
    errorBox,
    actions);

  const screen = el('section', { class: `ff-screen ff-question ff-layout-${layout}`, 'data-type': q.type },
    layout === 'split-left' || layout === 'split-right' ? el('div', { class: 'ff-media', style: `background-image:url("${q.imageUrl.replace(/["\\]/g, '')}")` }) : null,
    content);
  return {
    el: screen,
    focus: () => input.focus?.(),
    onKey: (e) => {
      if (edit) return false;
      const tag = document.activeElement?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (!typing && input.onKey && !e.metaKey && !e.ctrlKey && !e.altKey && input.onKey(e)) return true;
      if (!typing && e.key === 'Enter') {
        if (input.needsOk === 'never' && !input.getValue()) return false;
        e.preventDefault(); ctx.submit(); return true;
      }
      return false;
    },
    api,
    submit: () => ctx.submit(),
  };
}

export { plainTitle };
