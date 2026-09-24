// Respondent flow controller: one question per screen, keyboard-first,
// logic jumps, Typeform-style vertical transitions. Rendering lives in
// renderer.js. mountForm() is used by the public form page and by the
// builder's in-app preview, so both behave identically.
import { el } from './dom.js';
import { icon } from './icons.js';
import {
  END, firstQuestionId, nextQuestionId, validateAnswer, progress, uid, interpolate, partialsEnabled, contactFrom, DEFAULT_CONSENT_TEXT,
  experimentRunning, variantForm, fileProblem,
} from './logic.js';
import { applyTheme, welcomeScreen, questionScreen, thankYouScreen, brandLogo } from './renderer.js';
import { createTracker, newEventId, fbIdentifiers } from './tracking.js';
import { assignVariant } from './ab.js';
import { deviceOf, sourceOf } from './traffic.js';

const AUTO_HIDDEN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
const RESUME_DAYS = 7;

/**
 * The A/B variant for this visitor: kept per browser, so a returning visitor
 * sees the same version. ?ab=A or ?ab=B shows one variant for checking, and
 * such visits are left out of the test.
 */
function pickVariant(form, params) {
  const forced = params.get('ab');
  if (forced === 'A' || forced === 'B') return { variant: forced, counted: false };
  const key = `ff_ab_${form.id}_${form.experiment.id}`;
  let v = null;
  try { v = localStorage.getItem(key); } catch { /* storage unavailable: a fresh draw per visit */ }
  if (v !== 'A' && v !== 'B') {
    v = assignVariant(form.experiment.split ?? 50);
    try { localStorage.setItem(key, v); } catch { /* ignore */ }
  }
  return { variant: v, counted: true };
}

/** Where the visitor came from; the builder, embed.js (_ref) or this site itself are not a source. */
function referrerOf(params) {
  if (params.has('_ref')) return params.get('_ref');
  try { return new URL(document.referrer).origin === location.origin ? '' : document.referrer; } catch { return ''; }
}

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
  const test = !preview && experimentRunning(form) ? pickVariant(form, params) : null;
  const tag = test?.counted ? `${form.experiment.id}:${test.variant}` : '';
  if (test?.variant === 'B') form = variantForm(form, 'B');
  // Sent with every event and the submission, for the per-device / per-source / A-B breakdowns.
  const dims = preview ? {} : {
    device: deviceOf(navigator.userAgent, { touchPoints: navigator.maxTouchPoints }),
    source: sourceOf(Object.fromEntries(params), referrerOf(params)),
    variant: tag,
  };
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
    contactCaptured: false,
    destroyed: false,
  };

  // ─── Abandonment recovery ─────────────────────────────────────────────────
  const recovery = form.recovery || {};
  const savePartials = !preview && partialsEnabled(form);
  const consentText = partialsEnabled(form) ? (recovery.consentText || DEFAULT_CONSENT_TEXT) : '';
  const resumeOn = !preview && !!recovery.resume;
  const resumeKey = `ff_progress_${form.id}`;

  const answersOnPath = () => {
    const onPath = new Set(state.history);
    return Object.fromEntries(Object.entries(state.answers).filter(([k]) => onPath.has(k)));
  };

  function saveProgress() {
    if (!resumeOn || state.finished) return;
    try {
      localStorage.setItem(resumeKey, JSON.stringify({
        savedAt: Date.now(), sessionId: state.sessionId, answers: state.answers, history: state.history, currentId: state.currentId, hidden: state.hidden,
      }));
    } catch { /* storage unavailable: resume simply won't be offered */ }
  }

  function clearProgress() {
    try { localStorage.removeItem(resumeKey); } catch { /* ignore */ }
  }

  /** Saved progress on this device, if it still matches the form. */
  function loadProgress() {
    if (!resumeOn) return null;
    try {
      const p = JSON.parse(localStorage.getItem(resumeKey) || 'null');
      const ids = new Set(form.questions.map((q) => q.id));
      if (!p || Date.now() - p.savedAt > RESUME_DAYS * 86400000 || !p.history?.length) return null;
      if (!ids.has(p.currentId) || !p.history.every((id) => ids.has(id)) || !/^s_[a-z0-9]+$/.test(p.sessionId || '')) return null;
      return p;
    } catch { return null; }
  }

  /** First time a valid email or phone appears: Pixel event + (if enabled) store the unfinished answers. */
  function onContactMaybe() {
    if (state.contactCaptured || !contactFrom(form, state.answers)) return;
    state.contactCaptured = true;
    state.tracker?.contact();
    if (savePartials) {
      backend.logEvent(form.id, { type: 'partial', sessionId: state.sessionId, path: [...state.history], answers: answersOnPath(), hidden: state.hidden, ...dims });
    }
  }

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
    saveProgress();
    const q = questionById(id);
    const value = state.answers[q.id];
    const isLast = nextQuestionId(form, q.id, { ...state.answers, [q.id]: value }) === END;
    const screen = questionScreen(form, q, {
      mode: 'live', answers: state.answers, hidden: state.hidden, value, isLast, consent: consentText,
      onSubmit: (val, api) => commit(q, val, api),
      upload: (file, onProgress) => uploadFile(q, file, onProgress),
      fileLink: (f) => backend?.fileLink?.(f) || '',
    });
    // Honeypot for bots: hidden from humans and assistive tech.
    if (isLast) screen.el.querySelector('.ff-content').append(el('input', { class: 'ff-hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }));
    show(screen, dir);
    state.tracker?.step(q, state.history.length);
  }

  /** Respondent file upload; in preview nothing leaves the browser. */
  async function uploadFile(q, file, onProgress) {
    if (!preview) return backend.uploadFile(form.id, { question: q, sessionId: state.sessionId, file, onProgress });
    const problem = fileProblem(q, file);
    if (problem) throw new Error(problem);
    for (const p of [0.4, 1]) { onProgress?.(p); await new Promise((r) => setTimeout(r, 150)); }
    return { ref: `preview:${uid('f')}`, name: file.name, type: file.type, size: file.size };
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
      if (!preview) backend.logEvent(form.id, { type: 'start', sessionId: state.sessionId, path: [q.id], ...dims });
    }
    state.history.push(q.id);
    onContactMaybe();
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
        ...dims,
      },
    };
    try {
      if (!preview) await backend.submit(form.id, payload);
      state.finished = true;
      clearProgress();
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
    const extra = savePartials && state.contactCaptured ? { answers: answersOnPath(), hidden: state.hidden } : {};
    backend.logEvent(form.id, { type: 'abandon', sessionId: state.sessionId, path, ...extra, ...dims }, { beacon: true });
  }
  const onVisibility = () => { if (document.visibilityState === 'hidden') sendAbandon(); };

  function resumeScreen(saved) {
    const cont = () => {
      Object.assign(state, {
        answers: saved.answers || {}, history: [...saved.history], hidden: { ...saved.hidden, ...state.hidden }, started: true,
        contactCaptured: !!contactFrom(form, saved.answers || {}),
      });
      go(saved.currentId);
    };
    const restart = () => {
      clearProgress();
      state.sessionId = uid('s'); // a fresh visit, counted as a new session
      if (!preview) backend.logEvent(form.id, { type: 'view', sessionId: state.sessionId, path: [], ...dims });
      startFresh();
    };
    const name = contactFrom(form, saved.answers || {})?.name;
    const n = saved.history.length;
    return {
      el: el('section', { class: 'ff-screen ff-welcome ff-resume' },
        el('h1', { class: 'ff-title ff-title-xl', text: name ? `Selamat datang kembali, ${name}!` : 'Selamat datang kembali!' }),
        el('p', { class: 'ff-desc', text: `Anda sudah menjawab ${n} pertanyaan. Mau lanjut dari yang terakhir?` }),
        el('div', { class: 'ff-actions' },
          el('button', { class: 'ff-btn', type: 'button', onclick: cont }, el('span', { text: 'Lanjutkan' })),
          el('button', { class: 'ff-btn ff-btn-ghost', type: 'button', onclick: restart }, el('span', { text: 'Mulai dari awal' })))),
      focus: () => {},
      onKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); cont(); return true; } return false; },
    };
  }

  function startFresh() {
    if (form.welcome?.enabled !== false) {
      show(welcomeScreen(form, { mode: 'live', answers: {}, hidden: state.hidden, start: () => go(firstQuestionId(form)) }));
    } else {
      go(firstQuestionId(form));
    }
  }

  // ─── Start ────────────────────────────────────────────────────────────────
  applyTheme(root, form.theme);
  const logo = brandLogo(form.theme);
  if (logo) root.append(logo);
  const saved = form.questions?.length ? loadProgress() : null;
  // Resuming continues the same session, so the funnel counts this visitor once.
  if (saved) state.sessionId = saved.sessionId;
  for (const k of new Set([...AUTO_HIDDEN, ...(form.hiddenFields || [])])) {
    const v = params.get(k);
    if (v) state.hidden[k] = v.slice(0, 500);
  }
  if (form.theme?.hideBranding) brand.hidden = true;
  if (!preview) {
    state.tracker = createTracker(form.tracking, { formId: form.id, formTitle: form.title, variant: tag });
    state.tracker.pageView();
    backend.logEvent(form.id, { type: 'view', sessionId: state.sessionId, path: [], ...dims });
  }
  document.addEventListener('keydown', onKey);
  prevBtn.addEventListener('click', back);
  // Down arrow = "OK" with whatever is entered now (validation still applies, optional questions can be skipped).
  nextBtn.addEventListener('click', () => state.screen?.submit?.());
  window.addEventListener('pagehide', sendAbandon);
  document.addEventListener('visibilitychange', onVisibility);

  if (!form.questions?.length) {
    stage.replaceChildren(el('section', { class: 'ff-screen ff-ending' }, el('h1', { class: 'ff-title ff-title-xl', text: 'Belum ada pertanyaan' }), el('p', { class: 'ff-desc', text: 'Tambahkan pertanyaan dulu di builder.' })));
  } else if (saved) {
    show(resumeScreen(saved));
  } else {
    startFresh();
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
