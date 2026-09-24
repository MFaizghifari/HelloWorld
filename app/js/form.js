// Respondent experience: one question per screen, keyboard-first, logic jumps.
import { getBackend } from './api.js';
import { el } from './dom.js';
import {
  END, firstQuestionId, nextQuestionId, validateAnswer, interpolate, progress, scaleRange, uid,
} from './logic.js';
import { createTracker, newEventId, fbIdentifiers } from './tracking.js';

const params = new URLSearchParams(location.search);
const isPreview = params.has('preview');
const stage = document.getElementById('stage');
const bar = document.getElementById('progress');
const nav = document.getElementById('nav');
const AUTO_HIDDEN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

const state = {
  form: null,
  backend: getBackend(),
  tracker: null,
  sessionId: uid('s'),
  answers: {},
  hidden: {},
  history: [], // question ids already answered, in order (for back navigation)
  currentId: null,
  started: false,
  finished: false,
  startedAt: Date.now(),
  submitting: false,
};

function applyTheme(theme = {}) {
  const root = document.documentElement.style;
  if (theme.primary) root.setProperty('--primary', theme.primary);
  if (theme.background) root.setProperty('--bg', theme.background);
  if (theme.text) root.setProperty('--text', theme.text);
  if (theme.backgroundImage && /^https:\/\//.test(theme.backgroundImage)) {
    document.body.style.backgroundImage = `url("${theme.backgroundImage.replace(/"/g, '')}")`;
    document.body.classList.add('has-bg-image');
  }
}

function captureHidden(form) {
  const keys = new Set([...AUTO_HIDDEN, ...(form.hiddenFields || [])]);
  for (const k of keys) {
    const v = params.get(k);
    if (v) state.hidden[k] = v.slice(0, 500);
  }
}

function questionById(id) {
  return state.form.questions.find((q) => q.id === id);
}

function setProgress() {
  if (!state.currentId || state.currentId === END) { bar.style.width = state.finished ? '100%' : '0%'; return; }
  const p = progress(state.form, state.history, state.currentId, state.answers);
  bar.style.width = `${Math.round(p * 100)}%`;
}

function transition(render) {
  stage.classList.add('leaving');
  setTimeout(() => {
    stage.replaceChildren(render());
    stage.classList.remove('leaving');
    const focusable = stage.querySelector('[data-autofocus]');
    if (focusable && window.matchMedia('(hover: hover)').matches) focusable.focus({ preventScroll: true });
    setProgress();
  }, 180);
}

// ─── Screens ────────────────────────────────────────────────────────────────
function renderWelcome() {
  const w = state.form.welcome || {};
  return el('section', { class: 'screen welcome' },
    el('h1', { text: interpolate(w.title || state.form.title, {}, state.hidden) }),
    w.description ? el('p', { class: 'desc', text: interpolate(w.description, {}, state.hidden) }) : null,
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', 'data-autofocus': true, onclick: () => go(firstQuestionId(state.form)), text: w.buttonText || 'Mulai' }),
      el('span', { class: 'hint', text: 'tekan Enter ↵' })),
  );
}

function renderThankYou() {
  const t = state.form.thankyou || {};
  return el('section', { class: 'screen thankyou' },
    el('div', { class: 'check', 'aria-hidden': 'true', text: '✓' }),
    el('h1', { text: interpolate(t.title || 'Terima kasih!', state.answers, state.hidden) }),
    t.description ? el('p', { class: 'desc', text: interpolate(t.description, state.answers, state.hidden) }) : null,
    t.buttonText && t.buttonUrl && /^https?:\/\//.test(t.buttonUrl)
      ? el('a', { class: 'btn', href: t.buttonUrl, target: '_top', rel: 'noopener', text: t.buttonText })
      : null,
  );
}

function renderError(msg) {
  return el('section', { class: 'screen' }, el('h1', { text: 'Ups…' }), el('p', { class: 'desc', text: msg }));
}

function renderQuestion(q) {
  const index = state.history.length;
  const value = state.answers[q.id];
  const errorBox = el('div', { class: 'error', role: 'alert' });
  const body = el('div', { class: 'input-area' });
  const setError = (m) => { errorBox.textContent = m || ''; errorBox.classList.toggle('show', !!m); };

  const submitThis = (v) => {
    const val = v !== undefined ? v : readValue(q, body);
    const err = validateAnswer(q, val);
    if (err) { setError(err); body.classList.add('shake'); setTimeout(() => body.classList.remove('shake'), 400); return; }
    commit(q, val);
  };
  body.submitThis = submitThis;

  buildInput(q, body, value, submitThis);

  const isLast = nextQuestionId(state.form, q.id, { ...state.answers, [q.id]: value }) === END;
  const okLabel = q.type === 'statement' ? (q.settings?.buttonText || 'Lanjut') : (isLast ? 'Kirim' : 'OK');

  const screen = el('section', { class: 'screen question', 'data-type': q.type },
    el('div', { class: 'q-head' },
      el('span', { class: 'q-num', text: `${index + 1} →` }),
      el('h2', { id: `t_${q.id}` },
        interpolate(q.title, state.answers, state.hidden),
        q.required ? el('span', { class: 'req', 'aria-label': 'wajib', text: ' *' }) : null)),
    q.description ? el('p', { class: 'desc', text: interpolate(q.description, state.answers, state.hidden) }) : null,
    q.imageUrl && /^https:\/\//.test(q.imageUrl) ? el('img', { class: 'q-img', src: q.imageUrl, alt: '' }) : null,
    body,
    errorBox,
    ['multiple_choice', 'yes_no', 'rating', 'opinion_scale', 'dropdown'].includes(q.type) && !q.settings?.multiple
      ? null
      : el('div', { class: 'actions' },
        el('button', { class: 'btn', type: 'button', onclick: () => submitThis(), text: state.submitting ? 'Mengirim…' : okLabel }),
        q.type === 'long_text'
          ? el('span', { class: 'hint', text: 'Shift + Enter untuk baris baru' })
          : el('span', { class: 'hint', text: 'tekan Enter ↵' })),
  );
  // Honeypot for bots: hidden from humans and assistive tech.
  if (isLast) screen.append(el('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }));
  state.tracker?.step(q, index);
  return screen;
}

function buildInput(q, body, value, submitThis) {
  const s = q.settings || {};
  const onEnter = (e) => {
    if (e.key === 'Enter' && !(q.type === 'long_text' && e.shiftKey)) { e.preventDefault(); submitThis(); }
  };
  const textInput = (type, extra = {}) => el('input', {
    class: 'text', type, value: value ?? '', placeholder: s.placeholder || 'Ketik jawaban di sini…',
    'data-autofocus': true, onkeydown: onEnter, 'aria-labelledby': `t_${q.id}`, ...extra,
  });

  switch (q.type) {
    case 'short_text': body.append(textInput('text', { maxlength: s.maxLength || 500 })); break;
    case 'email': body.append(textInput('email', { autocomplete: 'email', inputmode: 'email', placeholder: s.placeholder || 'nama@email.com' })); break;
    case 'phone': body.append(textInput('tel', { autocomplete: 'tel', inputmode: 'tel', placeholder: s.placeholder || '08xx xxxx xxxx' })); break;
    case 'number': body.append(textInput('number', { inputmode: 'decimal', min: s.min, max: s.max })); break;
    case 'date': body.append(textInput('date')); break;
    case 'long_text': {
      const ta = el('textarea', {
        class: 'text', rows: 3, placeholder: s.placeholder || 'Ketik jawaban di sini…', 'data-autofocus': true,
        maxlength: s.maxLength || 5000, onkeydown: onEnter, 'aria-labelledby': `t_${q.id}`,
      });
      ta.value = value ?? '';
      body.append(ta);
      break;
    }
    case 'dropdown': {
      const sel = el('select', { class: 'text', 'data-autofocus': true, 'aria-labelledby': `t_${q.id}`, onchange: (e) => e.target.value && submitThis(e.target.value) },
        el('option', { value: '', text: 'Pilih…' }),
        (q.options || []).map((o) => el('option', { value: o.label, selected: value === o.label, text: o.label })));
      body.append(sel);
      break;
    }
    case 'multiple_choice':
    case 'yes_no': {
      const options = q.type === 'yes_no' ? [{ id: 'y', label: 'Ya' }, { id: 'n', label: 'Tidak' }] : (q.options || []);
      const multiple = q.type === 'multiple_choice' && !!s.multiple;
      const selected = new Set(Array.isArray(value) ? value : value ? [value] : []);
      const list = el('div', { class: 'choices', role: multiple ? 'group' : 'radiogroup', 'aria-labelledby': `t_${q.id}` });
      const order = s.randomize ? [...options].sort(() => Math.random() - 0.5) : options;
      order.forEach((o, i) => {
        const key = String.fromCharCode(65 + i);
        const btn = el('button', {
          type: 'button', class: `choice${selected.has(o.label) ? ' selected' : ''}`, 'data-key': key,
          role: multiple ? 'checkbox' : 'radio', 'aria-checked': String(selected.has(o.label)),
          'data-autofocus': i === 0 ? true : undefined,
          onclick: () => {
            if (multiple) {
              if (selected.has(o.label)) selected.delete(o.label); else selected.add(o.label);
              btn.classList.toggle('selected'); btn.setAttribute('aria-checked', String(selected.has(o.label)));
              body.dataset.value = JSON.stringify([...selected]);
            } else {
              list.querySelectorAll('.choice').forEach((c) => { c.classList.remove('selected'); c.setAttribute('aria-checked', 'false'); });
              btn.classList.add('selected', 'blink');
              setTimeout(() => submitThis(o.label), 350);
            }
          },
        }, el('kbd', { text: key }), el('span', { text: o.label }));
        list.append(btn);
      });
      body.dataset.value = JSON.stringify([...selected]);
      body.append(list);
      break;
    }
    case 'rating':
    case 'opinion_scale': {
      const { min, max } = scaleRange(q);
      const wrap = el('div', { class: `scale ${q.type}`, role: 'radiogroup', 'aria-labelledby': `t_${q.id}` });
      for (let n = min; n <= max; n++) {
        wrap.append(el('button', {
          type: 'button', class: `scale-item${Number(value) === n ? ' selected' : ''}`, role: 'radio',
          'aria-checked': String(Number(value) === n), 'aria-label': String(n), 'data-autofocus': n === min ? true : undefined,
          onclick: (e) => {
            wrap.querySelectorAll('.scale-item').forEach((b, i) => b.classList.toggle('selected', q.type === 'rating' ? i <= n - min : i === n - min));
            e.currentTarget.classList.add('blink');
            setTimeout(() => submitThis(n), 300);
          },
          text: q.type === 'rating' ? '★' : String(n),
        }));
      }
      body.append(wrap);
      if (s.labelLeft || s.labelRight) {
        body.append(el('div', { class: 'scale-labels' }, el('span', { text: s.labelLeft || '' }), el('span', { text: s.labelRight || '' })));
      }
      break;
    }
    case 'statement':
    default:
      break;
  }
}

function readValue(q, body) {
  if (q.type === 'statement') return undefined;
  if (q.type === 'multiple_choice') return JSON.parse(body.dataset.value || '[]');
  const input = body.querySelector('input, textarea, select');
  if (!input) return state.answers[q.id];
  const v = input.value.trim();
  if (q.type === 'number') return v === '' ? '' : Number(v);
  return v;
}

// ─── Flow ───────────────────────────────────────────────────────────────────
function go(id) {
  state.currentId = id;
  nav.hidden = id === END;
  transition(() => renderQuestion(questionById(id)));
}

function commit(q, val) {
  if (q.type !== 'statement') {
    if (val === undefined || val === '' || (Array.isArray(val) && !val.length)) delete state.answers[q.id];
    else state.answers[q.id] = val;
  }
  if (!state.started) {
    state.started = true;
    state.tracker?.start();
    if (!isPreview) state.backend.logEvent(state.form.id, { type: 'start', sessionId: state.sessionId, path: [q.id] });
  }
  state.history.push(q.id);
  const next = nextQuestionId(state.form, q.id, state.answers);
  if (next === END) finish();
  else go(next);
}

function back() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  go(prev);
}

async function finish() {
  if (state.submitting) return;
  const hp = stage.querySelector('.hp');
  state.submitting = true;
  const eventId = newEventId('lead');
  // Only keep answers on the path actually taken (logic may have skipped some).
  const onPath = new Set(state.history);
  const answers = Object.fromEntries(Object.entries(state.answers).filter(([k]) => onPath.has(k)));
  const payload = {
    answers,
    hidden: state.hidden,
    hp: hp ? hp.value : '',
    meta: {
      sessionId: state.sessionId,
      eventId,
      path: state.history,
      durationSec: Math.round((Date.now() - state.startedAt) / 1000),
      pageUrl: location.href.split('#')[0].slice(0, 1000),
      referrer: document.referrer.slice(0, 500),
      userAgent: navigator.userAgent,
      ...fbIdentifiers(),
    },
  };
  try {
    if (!isPreview) await state.backend.submit(state.form.id, payload);
    state.finished = true;
    state.tracker?.submit(eventId);
    nav.hidden = true;
    state.currentId = END;
    transition(renderThankYou);
    const url = state.form.thankyou?.redirectUrl;
    if (url && /^https?:\/\//.test(url)) {
      const target = new URL(interpolate(url, state.answers, state.hidden));
      setTimeout(() => { window.top.location.href = target.href; }, (Number(state.form.thankyou.redirectDelay) || 2) * 1000);
    }
  } catch (err) {
    state.submitting = false;
    state.history.pop();
    const box = stage.querySelector('.error');
    if (box) { box.textContent = `Gagal mengirim: ${err.message}. Coba lagi.`; box.classList.add('show'); }
  }
}

function onKey(e) {
  if (state.currentId === END || !state.currentId) {
    if (e.key === 'Enter' && stage.querySelector('.welcome')) { e.preventDefault(); go(firstQuestionId(state.form)); }
    return;
  }
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (!typing && /^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) {
    const btn = stage.querySelector(`.choice[data-key="${e.key.toUpperCase()}"]`);
    if (btn) { e.preventDefault(); btn.click(); }
  }
  if (!typing && e.key === 'Enter') {
    const body = stage.querySelector('.input-area');
    if (body?.submitThis) { e.preventDefault(); body.submitThis(); }
  }
}

function sendAbandon() {
  if (isPreview || state.finished || !state.started) return;
  const path = [...state.history];
  if (state.currentId && state.currentId !== END) path.push(state.currentId);
  // Mobile users often switch tabs and come back; only resend when they progressed.
  if (path.length <= (state.abandonSentLen || 0)) return;
  state.abandonSentLen = path.length;
  state.backend.logEvent(state.form.id, { type: 'abandon', sessionId: state.sessionId, path }, { beacon: true });
}

async function loadForm() {
  if (isPreview) {
    const draft = JSON.parse(localStorage.getItem('tf_preview') || 'null');
    if (draft) return draft;
  }
  const id = params.get('id');
  if (!id) throw new Error('Link form tidak lengkap (parameter id tidak ada).');
  return state.backend.getForm(id);
}

async function init() {
  try {
    state.form = await loadForm();
  } catch (err) {
    stage.replaceChildren(renderError(err.message));
    return;
  }
  const f = state.form;
  document.title = f.title || 'Form';
  applyTheme(f.theme);
  captureHidden(f);
  if (f.theme?.hideBranding) document.getElementById('brand').hidden = true;
  if (isPreview) document.body.classList.add('preview');
  else {
    state.tracker = createTracker(f.tracking, { formId: f.id, formTitle: f.title });
    state.tracker.pageView();
    state.backend.logEvent(f.id, { type: 'view', sessionId: state.sessionId, path: [] });
  }
  document.addEventListener('keydown', onKey);
  document.getElementById('prev').addEventListener('click', back);
  document.getElementById('next').addEventListener('click', () => stage.querySelector('.input-area')?.submitThis?.());
  window.addEventListener('pagehide', sendAbandon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendAbandon(); });

  if (!f.questions?.length) { stage.replaceChildren(renderError('Form ini belum punya pertanyaan.')); return; }
  if (f.welcome?.enabled !== false) {
    stage.replaceChildren(renderWelcome());
    stage.querySelector('[data-autofocus]')?.focus();
  } else {
    go(firstQuestionId(f));
  }
}

init();
