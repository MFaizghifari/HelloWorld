// Public form page: loads the form and hands it to the shared runner.
import { getBackend } from './api.js';
import { el } from './dom.js';
import { mountForm } from './runner.js';

const params = new URLSearchParams(location.search);
const host = document.getElementById('app');

function loadDraft() {
  // Builder preview opened in a new tab (older links); the in-app preview no longer needs this.
  try { return JSON.parse(localStorage.getItem('tf_preview') || 'null'); } catch { return null; }
}

async function init() {
  const backend = getBackend();
  const preview = params.has('preview');
  let form = preview ? loadDraft() : null;
  try {
    if (!form) {
      const id = params.get('id');
      if (!id) throw new Error('Link form tidak lengkap (parameter id tidak ada).');
      form = await backend.getForm(id);
    }
  } catch (err) {
    host.replaceChildren(el('div', { class: 'ff ff-runner' }, el('main', { class: 'ff-stage' },
      el('section', { class: 'ff-screen ff-ending' }, el('h1', { class: 'ff-title ff-title-xl', text: 'Ups…' }), el('p', { class: 'ff-desc', text: err.message })))));
    return;
  }
  document.title = form.title || 'Form';
  mountForm(host, form, { backend, preview, params });
}

init();
