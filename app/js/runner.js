// Respondent flow controller: one question per screen, keyboard-first,
// logic jumps, Typeform-style vertical transitions. Rendering lives in
// renderer.js. mountForm() is used by the public form page and by the
// builder's in-app preview, so both behave identically.
import { el } from './dom.js';
import { icon } from './icons.js';
import { END, firstQuestionId, nextQuestionId, validateAnswer, progress, uid, interpolate } from './logic.js';
import { applyTheme, welcomeScreen, questionScreen, thankYouScreen } from './renderer.js';
import { createTracker, newEventId, fbIdentifiers } from './tracking.js';

const AUTO_HIDDEN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

/**
 * @param {HTMLElement} host   element the form fills
 * @param {object} form        form definition
 * @param {object} opts
 *   backend     api.js backend (needed unless preview)
 *   preview     true = no tracking, nothing saved (builder preview)
 *   embedded    true = chrome is positioned inside host instead of the viewport
 *   params      URLSearchParams with UTM/hidden fields
 *   onRestart   shows a "restart" action on the ending screen (preview only)
 */
export function mountForm(host, form, { backend = null, preview = false, embedded = false, params = new URLSearchParams(), onRestart } = {}) {
  const root = el('div', { class: `ff ff-runner${embedded ? ' ff-embedded' : ''}` });
  const bar = el('div', { class: 'ff-progress-bar' });
  const stage = el('main', { class: 'ff-stage', 'aria-live': 'polite' });
  const prevBtn = el('button', { type: 'button', 'aria-label': 'Pertanyaan sebelumnya' }, icon('chevronUp', { size: 20 }));
  const nextBtn = el('button', { type: 'button', 'aria-label': 'Pertanyaan berikutnya' }, icon('chevronDown', { size: 20 }));
  const nav = el('div', { class: 'ff-nav', hidden: true }, prevBtn, nextBtn);
  const brand = el('span', { class: 'ff-brand' }, 'Dibuat dengan ', el('strong', { text: 'FormFlow' }));
  root.append(el('div', { class: 'ff-progress', 'aria-hidden': 'true' }, bar), stage, el('div', { class: 'ff-bottom' }, brand, nav));
  if (preview) root.append(el('div', { class: 'ff-preview-badge', text: 'PRATINJAU · jawaban tidak disimpan' }));
  host.replaceChildren(root);

  const state = {
    tracker: null,
    sessionId: uid('s'),
    answers: {},
    hidden: {},
    history: [], // answered question ids, in order (for back navigation)
    currentId: null,
    screen: null, // { el, focus, onKey, submit }
    started: false,
    finished: false,
    startedAt: Date.now(),
    submitting: false,
    abandonSentLen: 0,
    destroyed: false,
  };

  const questionById = (id) => form.questions.find((q) => q.id === id);

  function setProgress() {
    let p = 0;
    if (state.finished) p = 1;
    else if (state.currentId && state.currentId !== END) p = progress(form, state.history, state.currentId, state.answers);
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
    if (matchMedia('(hover: hover)').matches) setTimeout(() => { if (!state.destroyed) screen.focus(); }, old ? 330 : 50);
    (embedded ? stage : window).scrollTo({ top: 0 });
  }

  function go(id, dir = 'up') {
    state.currentId = id;
    nav.hidden = false;
    const q = questionById(id);
    const value = state.answers[q.id];
    const isLast = nextQuestionId(form, q.id, { ...state.answers, [q.id]: value }) === END;
    const screen = questionScreen(form, q, {
      mode: 'live', answers: state.answers, hidden: state.hidden, value, isLast,
      onSubmit: (val, api) => commit(q, val, api),
    });
    // Honeypot for bots: hidden from humans and assistive tech.
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
      if (!preview) backend.logEvent(form.id, { type: 'start', sessionId: state.sessionId, path: [q.id] });
    }
    state.history.push(q.id);
    const next = nextQuestionId(form, q.id, state.answers);
    if (next === END) finish(api);
    else go(next, 'up');
  }

  function back() {
    if (!state.history.length || state.submitting) return;
    go(state.history.pop(), 'down');
  }

  function showEnding() {
    const screen = thankYouScreen(form, { mode: 'live', answers: state.answers, hidden: state.hidden });
    if (onRestart) {
      screen.el.append(el('div', { class: 'ff-actions' },
        el('button', { class: 'ff-btn', type: 'button', onclick: onRestart }, el('span', { text: 'Ulangi pratinjau' }))));
    }
    show(screen);
  }

  async function finish(api) {
    const hp = stage.querySelector('.ff-hp');
    state.submitting = true;
    const label = stage.querySelector('.ff-screen:not(.ff-leaving) .ff-btn span');
    if (label) label.textContent = 'Mengirim…';
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
      if (!preview) await backend.submit(form.id, payload);
      state.finished = true;
      state.tracker?.submit(eventId);
      nav.hidden = true;
      state.currentId = END;
      showEnding();
      const url = form.thankyou?.redirectUrl;
      if (!preview && url && /^https?:\/\//.test(url)) {
        const target = new URL(interpolate(url, state.answers, state.hidden));
        setTimeout(() => { window.top.location.href = target.href; }, (Number(form.thankyou.redirectDelay) || 2) * 1000);
      }
    } catch (err) {
      state.submitting = false;
      state.history.pop();
      if (label) label.textContent = 'Kirim';
      api.showError(`Gagal mengirim: ${err.message} Coba lagi.`);
    }
  }

  function onKey(e) {
    if (state.destroyed || !state.screen || e.defaultPrevented) return;
    // In the builder the preview is a dialog; ignore keys aimed at the rest of the page.
    if (embedded && !root.isConnected) return;
    state.screen.onKey?.(e);
  }

  function sendAbandon() {
    if (preview || state.finished || !state.started) return;
    const path = [...state.history];
    if (state.currentId && state.currentId !== END) path.push(state.currentId);
    // Mobile users often switch tabs and come back; only resend when they progressed.
    if (path.length <= state.abandonSentLen) return;
    state.abandonSentLen = path.length;
    backend.logEvent(form.id, { type: 'abandon', sessionId: state.sessionId, path }, { beacon: true });
  }
  const onVisibility = () => { if (document.visibilityState === 'hidden') sendAbandon(); };

  // ─── Start ────────────────────────────────────────────────────────────────
  applyTheme(root, form.theme);
  for (const k of new Set([...AUTO_HIDDEN, ...(form.hiddenFields || [])])) {
    const v = params.get(k);
    if (v) state.hidden[k] = v.slice(0, 500);
  }
  if (form.theme?.hideBranding) brand.hidden = true;
  if (!preview) {
    state.tracker = createTracker(form.tracking, { formId: form.id, formTitle: form.title });
    state.tracker.pageView();
    backend.logEvent(form.id, { type: 'view', sessionId: state.sessionId, path: [] });
  }
  document.addEventListener('keydown', onKey);
  prevBtn.addEventListener('click', back);
  // Down arrow = "OK" with whatever is entered now (validation still applies, optional questions can be skipped).
  nextBtn.addEventListener('click', () => state.screen?.submit?.());
  window.addEventListener('pagehide', sendAbandon);
  document.addEventListener('visibilitychange', onVisibility);

  if (!form.questions?.length) {
    stage.replaceChildren(el('section', { class: 'ff-screen ff-ending' }, el('h1', { class: 'ff-title ff-title-xl', text: 'Belum ada pertanyaan' }), el('p', { class: 'ff-desc', text: 'Tambahkan pertanyaan dulu di builder.' })));
  } else if (form.welcome?.enabled !== false) {
    show(welcomeScreen(form, { mode: 'live', answers: {}, hidden: state.hidden, start: () => go(firstQuestionId(form)) }));
  } else {
    go(firstQuestionId(form));
  }

  return {
    root,
    destroy() {
      state.destroyed = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', sendAbandon);
      document.removeEventListener('visibilitychange', onVisibility);
      root.remove();
    },
  };
}
