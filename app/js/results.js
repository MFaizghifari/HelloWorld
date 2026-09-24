// Results view ("Hasil"): KPIs, daily trend, drop-off funnel, per-question
// charts, latest responses. mountResults() renders into any container, so it
// runs both as a tab inside the builder and on dashboard.html.
import { el } from './dom.js';
import { computeStats, toCSV } from './stats.js';
import { plainTitle } from './logic.js';

const SERIES = { views: '#D9A300', completions: '#3967BD' }; // validated pair (CVD ΔE 32.6)
const SVG = 'http://www.w3.org/2000/svg';
const fmt = new Intl.NumberFormat('id-ID');
const pct = (x) => `${(x * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`;

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// ─── Charts ─────────────────────────────────────────────────────────────────
function kpi(label, value, sub) {
  return el('div', { class: 'kpi' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), sub ? el('div', { class: 'sub', text: sub }) : null);
}

/** Two-series daily line chart with crosshair tooltip (one shared y-axis: both are counts). */
function lineChart(daily) {
  const W = 800; const H = 260; const P = { l: 40, r: 12, t: 12, b: 28 };
  const max = Math.max(4, ...daily.map((d) => Math.max(d.views, d.completions)));
  const niceMax = Math.ceil(max / 4) * 4;
  const x = (i) => P.l + (daily.length === 1 ? 0 : (i / (daily.length - 1)) * (W - P.l - P.r));
  const y = (v) => H - P.b - (v / niceMax) * (H - P.t - P.b);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%', role: 'img', 'aria-label': 'Tren harian views dan submission' });

  for (let i = 0; i <= 4; i++) {
    const v = (niceMax / 4) * i;
    root.append(svg('line', { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: 'rgba(0,0,0,.07)' }));
    const t = svg('text', { x: P.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'rgba(6,11,20,.55)' });
    t.textContent = fmt.format(v); root.append(t);
  }
  const step = Math.ceil(daily.length / 8);
  daily.forEach((d, i) => {
    const last = daily.length - 1;
    if (i !== last && (i % step || last - i < step / 2)) return;
    const t = svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'rgba(6,11,20,.55)' });
    t.textContent = d.date.slice(5).replace('-', '/'); root.append(t);
  });
  for (const key of ['views', 'completions']) {
    const dPath = daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');
    root.append(svg('path', { d: dPath, fill: 'none', stroke: SERIES[key], 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  }
  const hair = svg('line', { y1: P.t, y2: H - P.b, stroke: 'rgba(6,11,20,.35)', 'stroke-width': 1, visibility: 'hidden' });
  const dots = ['views', 'completions'].map((k) => svg('circle', { r: 4, fill: SERIES[k], stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }));
  root.append(hair, ...dots);

  const tip = el('div', { class: 'tip', hidden: true });
  const box = el('div', { class: 'chart-box', tabindex: 0 }, root, tip);
  const show = (i) => {
    const d = daily[i];
    hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('visibility', 'visible');
    ['views', 'completions'].forEach((k, j) => { dots[j].setAttribute('cx', x(i)); dots[j].setAttribute('cy', y(d[k])); dots[j].setAttribute('visibility', 'visible'); });
    tip.replaceChildren(
      el('div', { class: 'tip-date', text: new Date(`${d.date}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }) }),
      ...['views', 'completions'].map((k) => el('div', { class: 'tip-row' },
        el('span', { class: 'key', style: `background:${SERIES[k]}` }),
        el('strong', { text: fmt.format(d[k]) }), el('span', { class: 'muted', text: k === 'views' ? ' views' : ' submission' }))));
    tip.hidden = false;
    const rect = box.getBoundingClientRect();
    const px = (x(i) / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - 150, Math.max(0, px + 12))}px`;
  };
  const hide = () => { tip.hidden = true; hair.setAttribute('visibility', 'hidden'); dots.forEach((c) => c.setAttribute('visibility', 'hidden')); };
  box.addEventListener('pointermove', (e) => {
    const rect = box.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((vx - P.l) / (W - P.l - P.r)) * (daily.length - 1));
    show(Math.max(0, Math.min(daily.length - 1, i)));
  });
  box.addEventListener('pointerleave', hide);
  let kIdx = daily.length - 1;
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') kIdx = Math.max(0, kIdx - 1);
    else if (e.key === 'ArrowRight') kIdx = Math.min(daily.length - 1, kIdx + 1);
    else return;
    e.preventDefault(); show(kIdx);
  });
  box.addEventListener('blur', hide);

  const legend = el('div', { class: 'legend' },
    ['views', 'completions'].map((k) => el('span', {}, el('span', { class: 'key', style: `background:${SERIES[k]}` }), k === 'views' ? 'Views' : 'Submission')));
  return el('div', {}, legend, box);
}

/** Horizontal bars in HTML: value labels always visible, so no tooltip needed. */
function bars(entries, { total, color = '#3967BD', percentOf } = {}) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return el('div', { class: 'hbars' }, entries.map(([label, v]) => el('div', { class: 'hbar', title: `${label}: ${fmt.format(v)}` },
    el('span', { class: 'hbar-label', text: String(label) }),
    el('span', { class: 'hbar-track' }, v ? el('span', { class: 'hbar-fill', style: `width:${(v / max) * 100}%;background:${color}` }) : null),
    el('span', { class: 'hbar-value', text: percentOf ? `${fmt.format(v)} · ${pct(percentOf ? v / percentOf : 0)}` : fmt.format(v) }))),
  total !== undefined ? el('div', { class: 'muted small', text: `n = ${fmt.format(total)}` }) : null);
}

function funnelTable(funnel) {
  const top = Math.max(1, ...funnel.map((f) => f.reached));
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Pertanyaan' }), el('th', { text: 'Sampai sini' }), el('th', { text: 'Berhenti' }))),
    el('tbody', {}, funnel.map((f) => el('tr', {},
      el('td', { text: f.title }),
      el('td', {}, el('div', { class: 'bar-cell' }, el('span', { class: 'bar', style: `width:${Math.max(2, (f.reached / top) * 80)}px` }), el('span', { text: fmt.format(f.reached) }))),
      el('td', { class: 'num', text: f.droppedHere ? `${fmt.format(f.droppedHere)} (${pct(f.dropRate)})` : '–' }))))));
}

function questionCard(q) {
  const head = el('div', { class: 'row between' }, el('h3', { text: q.title, style: 'margin:0' }), el('span', { class: 'muted small', text: `${fmt.format(q.answered)} jawaban` }));
  let body;
  if (q.kind === 'choice') {
    body = bars(Object.entries(q.counts).sort((a, b) => b[1] - a[1]), { percentOf: q.answered });
  } else if (q.kind === 'numeric') {
    const fmt1 = (v) => (v === null ? '–' : v.toLocaleString('id-ID', { maximumFractionDigits: 2 }));
    body = el('div', {},
      el('div', { class: 'row', style: 'gap:24px;margin-bottom:10px' },
        q.nps !== undefined ? el('div', {}, el('div', { class: 'muted small', text: 'NPS' }), el('strong', { style: 'font-size:1.6rem', text: q.nps === null ? '–' : String(q.nps) })) : null,
        el('div', {}, el('div', { class: 'muted small', text: 'Rata-rata' }), el('strong', { style: 'font-size:1.6rem', text: fmt1(q.avg) })),
        el('div', {}, el('div', { class: 'muted small', text: 'Median' }), el('strong', { style: 'font-size:1.6rem', text: fmt1(q.median) })),
        q.counts ? null : el('div', {}, el('div', { class: 'muted small', text: 'Min – Maks' }), el('strong', { style: 'font-size:1.6rem', text: `${fmt1(q.min)} – ${fmt1(q.max)}` }))),
      q.counts ? bars(Object.entries(q.counts), {}) : null);
  } else {
    body = q.recent.length
      ? el('ol', { class: 'recent' }, q.recent.map((t) => el('li', { text: t.length > 160 ? `${t.slice(0, 160)}…` : t })))
      : el('p', { class: 'muted', text: 'Belum ada jawaban.' });
  }
  return el('section', { class: 'card' }, head, el('div', { style: 'margin-top:12px' }, body));
}

function responsesTable(form, rows) {
  const qs = form.questions.filter((q) => q.type !== 'statement');
  if (!rows.length) return el('p', { class: 'empty-state', text: 'Belum ada jawaban pada rentang ini.' });
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Waktu' }), qs.map((q) => el('th', { text: plainTitle(q.title) })), el('th', { text: 'utm_source' }))),
    el('tbody', {}, rows.map((r) => el('tr', {},
      el('td', { text: new Date(r.submittedAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) }),
      qs.map((q) => { const v = r.answers?.[q.id]; return el('td', { text: Array.isArray(v) ? v.join(', ') : String(v ?? '') }); }),
      el('td', { text: r.hidden?.utm_source || '' }))))));
}

// ─── Mount ──────────────────────────────────────────────────────────────────
/**
 * @param {HTMLElement} host
 * @param {object} opts  { backend, formId, form?, demoNote?, canDownload? }
 *   form        use this definition instead of fetching (e.g. the builder's draft)
 *   demoNote    text for a banner marking example data
 *   canDownload false hides CSV export (sandboxed previews block downloads)
 */
export function mountResults(host, { backend, formId, form: givenForm = null, demoNote = '', canDownload = true }) {
  let current = { form: null, responses: [], events: [] };
  const range = el('select', { 'aria-label': 'Rentang waktu', class: 'res-range' },
    [['7', '7 hari terakhir'], ['30', '30 hari terakhir'], ['90', '90 hari terakhir'], ['365', '1 tahun']].map(([v, t]) => el('option', { value: v, selected: v === '30', text: t })));
  const sheetLink = el('a', { class: 'btn-ghost small', target: '_blank', rel: 'noopener', hidden: true, text: 'Buka Google Sheet' });
  const csvBtn = el('button', { class: 'btn-ghost small', type: 'button', hidden: !canDownload, text: 'Ekspor CSV' });
  const refresh = el('button', { class: 'btn-ghost small', type: 'button', 'aria-label': 'Muat ulang' }, '↻ Muat ulang');
  const status = el('p', { class: 'muted small res-status' });
  const body = el('div', { class: 'stack res-body' });
  host.replaceChildren(el('div', { class: 'res' },
    el('div', { class: 'res-bar' }, el('div', { class: 'res-bar-left' }, el('h1', { class: 'res-title' }), status), el('div', { class: 'row' }, range, refresh, sheetLink, csvBtn)),
    demoNote ? el('div', { class: 'callout demo-note', text: demoNote }) : null,
    body));

  function render() {
    const { form, responses, events } = current;
    if (!form) return;
    const days = Number(range.value);
    let s;
    let latest; // newest first
    let totalInRange;
    if (current.stats) {
      // Cloudflare: aggregated server-side; only the latest 100 raw rows are shipped.
      s = current.stats;
      latest = responses;
      totalInRange = s.completions;
    } else {
      const since = Date.now() - days * 86400000;
      const inRange = (iso) => new Date(iso).getTime() >= since;
      const resp = responses.filter((r) => inRange(r.submittedAt));
      s = computeStats(form, resp, events.filter((e) => inRange(e.ts)), { days });
      latest = resp.slice(-100).reverse();
      totalInRange = resp.length;
    }
    const worst = [...s.funnel].sort((a, b) => b.droppedHere - a.droppedHere)[0];
    const medDur = s.medianDurationSec === null || s.medianDurationSec === undefined ? null : Math.round(s.medianDurationSec);

    host.querySelector('.res-title').textContent = form.title || 'Hasil';
    status.textContent = `Data ${days} hari terakhir · ${{ cloud: 'Cloudflare D1', sheets: 'Google Sheets', local: 'disimpan di browser ini' }[backend.name]}`;
    body.replaceChildren(
      // replaceChildren() would render a literal "null", so spread an empty list instead.
      ...(current.sheetStatus ? [el('p', { class: `small ${current.sheetStatus.startsWith('ERROR') ? 'bad' : 'muted'}`, text: `Sinkron Google Sheet: ${current.sheetStatus}` })] : []),
      el('div', { class: 'kpis' },
        kpi('Views', fmt.format(s.views), 'sesi unik yang membuka form'),
        kpi('Mulai mengisi', fmt.format(s.starts), `${pct(s.startRate)} dari views`),
        kpi('Submission', fmt.format(s.completions), `rata-rata ${fmt.format(Math.round(s.completions / days))}/hari`),
        kpi('Completion rate', pct(s.completionRate), `${pct(s.completionOfStarts)} dari yang mulai`),
        kpi('Median waktu isi', medDur ? `${Math.floor(medDur / 60)}m ${medDur % 60}d` : '–', 'dari submission')),
      el('section', { class: 'card' }, el('h3', { text: 'Tren harian' }), lineChart(s.daily)),
      el('div', { class: 'grid2' },
        el('section', { class: 'card' },
          el('h3', { text: 'Funnel per pertanyaan' }),
          worst && worst.droppedHere
            ? el('p', { class: 'callout warn small' }, 'Drop-off terbesar: ', el('strong', { text: `"${worst.title}"` }), `, ${fmt.format(worst.droppedHere)} orang berhenti di sini (${pct(worst.dropRate)}).`)
            : null,
          funnelTable(s.funnel)),
        el('section', { class: 'card' },
          el('h3', { text: 'Sumber traffic (utm_source)' }),
          Object.keys(s.sources).length
            ? bars(Object.entries(s.sources).sort((a, b) => b[1] - a[1]).slice(0, 10), { percentOf: s.completions })
            : el('p', { class: 'muted', text: 'Belum ada data.' }))),
      el('h2', { class: 'section-title', text: 'Jawaban per pertanyaan' }),
      el('div', { class: 'grid2' }, s.perQuestion.map(questionCard)),
      el('section', { class: 'card' }, el('h3', { text: `Jawaban terbaru (${fmt.format(latest.length)} dari ${fmt.format(totalInRange)})` }), responsesTable(form, latest)),
    );
  }

  async function load() {
    body.style.opacity = '.5';
    try {
      // Apps Script ships raw rows, so fetch ≥30 days once and re-slice locally.
      const days = backend.name === 'cloud' ? Number(range.value) : Math.max(Number(range.value), 30);
      const [form, results] = await Promise.all([givenForm || backend.getForm(formId), backend.getResults(formId, days)]);
      current = { form, ...results };
      sheetLink.hidden = !results.sheetUrl;
      sheetLink.href = results.sheetUrl || '#';
      render();
    } catch (err) {
      body.replaceChildren(el('div', { class: 'empty-state' }, el('p', { text: `Gagal memuat data: ${err.message}` }),
        backend.name !== 'local' ? el('p', { class: 'small', text: 'Pastikan admin key sudah diisi di Pengaturan.' }) : null));
    } finally {
      body.style.opacity = '';
    }
  }

  range.addEventListener('change', () => {
    // Cloud aggregates per range server-side; Sheets only needs a refetch beyond 30 days.
    if (backend.name === 'cloud' || (backend.name === 'sheets' && Number(range.value) > 30)) load(); else render();
  });
  refresh.addEventListener('click', load);
  csvBtn.addEventListener('click', async () => {
    if (!current.form) return;
    let rows = current.responses;
    if (backend.exportAll) {
      // The view only holds the latest 100; page through everything for the export.
      csvBtn.disabled = true;
      try {
        rows = await backend.exportAll(current.form.id, (n) => { csvBtn.textContent = `Mengambil ${fmt.format(n)}…`; });
      } catch (err) { status.textContent = `Ekspor gagal: ${err.message}`; return; } finally { csvBtn.disabled = false; csvBtn.textContent = 'Ekspor CSV'; }
    }
    const blob = new Blob([`\uFEFF${toCSV(current.form, rows)}`], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${current.form.title || 'form'}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  });
  load();
  return { reload: load };
}
