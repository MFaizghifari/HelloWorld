// Standalone results page (dashboard.html). The same view is also a tab in the builder.
import { getBackend } from './api.js';
import { el } from './dom.js';
import { mountResults } from './results.js';

const backend = getBackend();
const host = document.getElementById('dash');
const picker = document.getElementById('formPicker');

function show(id) {
  document.querySelectorAll('.tb-tabs [data-to]').forEach((a) => {
    a.href = `index.html?id=${encodeURIComponent(id)}${a.dataset.to === 'content' ? '' : `#${a.dataset.to}`}`;
  });
  try { history.replaceState(null, '', `?id=${encodeURIComponent(id)}`); } catch { /* sandboxed */ }
  mountResults(host, { backend, formId: id });
}

async function init() {
  let forms = [];
  try { forms = await backend.listForms(); } catch (err) { host.replaceChildren(el('p', { class: 'empty-state', text: err.message })); }
  const id = new URLSearchParams(location.search).get('id') || forms[0]?.id;
  picker.replaceChildren(...forms.map((f) => el('option', { value: f.id, selected: f.id === id, text: f.title || f.id })));
  if (!id) { host.replaceChildren(el('div', { class: 'empty-state', text: 'Belum ada form. Buat dulu di builder.' })); return; }
  picker.addEventListener('change', () => show(picker.value));
  show(id);
}

init();
