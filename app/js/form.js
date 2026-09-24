// Respondent flow controller: one question per screen, keyboard-first,
// logic jumps, Typeform-style vertical transitions. Rendering lives in renderer.js.
import { getBackend } from './api.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import { END, firstQuestionId, nextQuestionId, validateAnswer, progress, uid, interpolate } from './logic.js';
import { applyTheme, welcomeScreen, questionScreen, thankYouScreen } from './renderer.js';
import { createTracker, newEventId, fbIdentifiers } from './tracking.js';

const params = new URLSearchParams(location.search);
const isPreview = params.has('preview');
const root = document.body;
const stage = document.getElementById('stage');
const bar = document.getElementById('progress');
const nav = document.getElementById('nav');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const AUTO_HIDDEN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

const state = {
  form: null,
  backend: getBackend(),
  tracker: null,
  sessionId: uid('s'),
  answers: {},
  hidden: {},
  history: [], // answered question ids, in order (for back navigation)
  currentId: null,
  screen: null, // { el, focus, onKey }
  started: false,
  finished: false,
  startedAt: Date.now(),
  submitting: false,
};

prevBtn.append(icon('chevronUp', { size: 20 }));
nextBtn.append(icon('chevronDown', { size: 20 }));

function captureHidden(form) {
  const keys = new Set([...AUTO_HIDDEN, ...(form.hiddenFields || [])]);
  for (const k of keys) {
    const v = params.get(k);
    if (v) state.hidden[k] = v.slice(0, 500);
  }
}

const questionById = (id) => state.form.questions.find((q) => q.id === id);

function setProgress() {
  let p = 0;
  if (state.finished) p = 1;
  else if (state.currentId && state.currentId !== END) p = progress(state.form, state.history, state.currentId, state.answers);
  bar.style.width = `${Math.round(p * 100)}%`;
  prevBtn.disabled = !state.history.length;
}

/** Swap screens with a vertical slide: "up" when moving forward, "down" when going back. */
function show(screen, dir = 'up') {
  const old = stage.querySelector('.ff-screen:not(.ff-leaving)');
  if (old) {
    old.classList.add('ff-leaving', `ff-leave-${dir}`);
    old.setAttribute('aria-hidden', 'true');
    old.inert = true;
    setTimeout(() => old.remove(), 320);
  }
  screen.el.classList.add(`ff-enter-${dir}`);
  stage.append(screen.el);
  state.screen = screen;
  setProgress();
  // Don't pop the keyboard open on touch devices; Typeform only autofocuses on desktop.
  if (matchMedia('(hover: hover)').matches) setTimeout(() => screen.focus(), old ? 330 : 50);
  window.scrollTo({ top: 0 });
}

// ─── Screens ────────────────────────────────────────────────────────────────
function renderWelcome() {
  show(welcomeScreen(state.form, { mode: 'live', answers: {}, hidden: state.hidden, start: () => go(firstQuestionId(state.form)) }));
}

function go(id, dir = 'up') {
  state.currentId = id;
  nav.hidden = false;
  const q = questionById(id);
  const value = state.answers[q.id];
  const isLast = nextQuestionId(state.form, q.id, { ...state.answers, [q.id]: value }) === END;
  const screen = questionScreen(state.form, q, {
    mode: 'live', answers: state.answers, hidden: state.hidden, value, isLast,
    onSubmit: (val, api) => commit(q, val, api),
  });
  if (isLast) screen.el.querySelector('.ff-content').append(el('input', { class: 'ff-hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }));
  show(screen, dir);
  state.tracker?.step(q, state.history.length);
}

function commit(q, val, api) {
  if (state.submitting) return;
  const err = validateAnswer(q, val);
  if (err) { api.showError(err); return; }
  api.clearError();
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
  if (next === END) finish(api);
  else go(next, 'up');
}

function back() {
  if (!state.history.length || state.submitting) return;
  go(state.history.pop(), 'down');
}

async function finish(api) {
  const hp = stage.querySelector('.ff-hp');
  state.submitting = true;
  const btn = stage.querySelector('.ff-screen:not(.ff-leaving) .ff-btn span');
  if (btn) btn.textContent = 'Mengirim…';
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
    show(thankYouScreen(state.form, { mode: 'live', answers: state.answers, hidden: state.hidden }));
    const url = state.form.thankyou?.redirectUrl;
    if (url && /^https?:\/\//.test(url)) {
      const target = new URL(interpolate(url, state.answers, state.hidden));
      setTimeout(() => { window.top.location.href = target.href; }, (Number(state.form.thankyou.redirectDelay) || 2) * 1000);
    }
  } catch (err) {
    state.submitting = false;
    state.history.pop();
    if (btn) btn.textContent = 'Kirim';
    api.showError(`Gagal mengirim: ${err.message} Coba lagi.`);
  }
}

function onKey(e) {
  if (!state.screen || e.defaultPrevented) return;
  state.screen.onKey?.(e);
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

function showError(msg) {
  stage.replaceChildren(el('section', { class: 'ff-screen ff-ending' }, el('h1', { class: 'ff-title ff-title-xl', text: 'Ups…' }), el('p', { class: 'ff-desc', text: msg })));
}

async function init() {
  try {
    state.form = await loadForm();
  } catch (err) {
    showError(err.message);
    return;
  }
  const f = state.form;
  document.title = f.title || 'Form';
  applyTheme(root, f.theme);
  captureHidden(f);
  if (f.theme?.hideBranding) document.getElementById('brand').hidden = true;
  if (isPreview) document.body.append(el('div', { class: 'ff-preview-badge', text: 'PRATINJAU · jawaban tidak disimpan' }));
  else {
    state.tracker = createTracker(f.tracking, { formId: f.id, formTitle: f.title });
    state.tracker.pageView();
    state.backend.logEvent(f.id, { type: 'view', sessionId: state.sessionId, path: [] });
  }
  document.addEventListener('keydown', onKey);
  prevBtn.addEventListener('click', back);
  // Down arrow = "OK" with whatever is entered now (validation still applies, optional questions can be skipped).
  nextBtn.addEventListener('click', () => state.screen?.submit?.());
  window.addEventListener('pagehide', sendAbandon);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendAbandon(); });

  if (!f.questions?.length) { showError('Form ini belum punya pertanyaan.'); return; }
  if (f.welcome?.enabled !== false) renderWelcome();
  else go(firstQuestionId(f));
}

init();
