// Results view ("Hasil"). Reads top to bottom as a story: one headline
// sentence, the respondent flow (where people go and where they leak), the
// key numbers, then the detail. mountResults() renders into any container, so
// it runs both as a tab inside the builder and on dashboard.html.
import { el } from './dom.js';
import { computeStats, toCSV, partialsCSV } from './stats.js';
import { plainTitle, whatsappLink, partialsEnabled } from './logic.js';
import { icon } from './icons.js';
import { typeTile } from './types.js';

const SERIES = { views: '#D9A300', completions: '#3967BD' }; // validated pair (CVD ΔE 32.6)
const FLOW = { open: '#B7C2D6', question: '#3967BD', done: '#2A4F9A', ribbon: 'rgba(57,103,189,.10)', leak: 'rgba(245,184,0,.62)' };
const SVG = 'http://www.w3.org/2000/svg';
const fmt = new Intl.NumberFormat('id-ID');
const pct = (x) => `${(x * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`;

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// ─── Headline ───────────────────────────────────────────────────────────────
/** One sentence that says what happened, then what to look at. */
function hero(s, form, partials, days, onPartials) {
  if (!s.views && !s.completions) {
    return el('section', { class: 'res-hero' },
      el('h2', { class: 'res-headline', text: 'Belum ada pengunjung pada rentang ini.' }),
      el('p', { class: 'res-lede', text: 'Bagikan link form dari tab Bagikan. Kunjungan dan jawaban akan muncul di sini.' }));
  }
  const headline = s.views
    ? el('h2', { class: 'res-headline' }, el('span', { class: 'hl', text: pct(Math.min(1, s.completionRate)) }), ' pengunjung mengirim form.')
    : el('h2', { class: 'res-headline', text: `${fmt.format(s.completions)} orang mengirim form.` });
  const worst = [...s.funnel].sort((a, b) => b.droppedHere - a.droppedHere)[0];
  const qNum = worst ? form.questions.filter((q) => q.type !== 'statement').findIndex((q) => q.id === worst.id) + 1 : 0;
  const lede = el('p', { class: 'res-lede' },
    s.views ? [el('strong', { text: fmt.format(s.completions) }), ` dari ${fmt.format(s.views)} pengunjung dalam ${days} hari terakhir. `] : `Dalam ${days} hari terakhir. `,
    worst && worst.droppedHere
      ? ['Paling banyak berhenti di pertanyaan ', el('strong', { text: `${qNum}, “${worst.title}”` }), `: ${fmt.format(worst.droppedHere)} orang (${pct(worst.dropRate)}). `]
      : null,
    partialsEnabled(form) && partials.length
      ? el('a', { href: '#res-partials', onclick: (e) => { e.preventDefault(); onPartials(); } }, `${fmt.format(partials.length)} kontak yang belum mengirim bisa dihubungi →`)
      : null);
  return el('section', { class: 'res-hero' }, headline, lede);
}

// ─── Signature: respondent flow ─────────────────────────────────────────────
/**
 * Columns = people who reached each step (opened → each question → submitted);
 * ribbons between columns show the flow, and the ribbon leaving the question
 * where most people quit is marked in yellow.
 */
function flowChart(s, form) {
  const byId = Object.fromEntries(form.questions.map((q) => [q.id, q]));
  const steps = [
    { key: 'open', title: 'Membuka form', count: s.views },
    ...s.funnel.map((f, i) => ({ key: f.id, title: f.title, count: f.reached, dropped: f.droppedHere, dropRate: f.dropRate, q: byId[f.id], n: i + 1 })),
    { key: 'done', title: 'Mengirim form', count: s.completions },
  ];
  // A question reached by clearly fewer people than continued from the one
  // before it was skipped by logic for some of them: a branch, not a leak.
  steps.forEach((st, i) => {
    const prev = steps[i - 1];
    if (!st.q || !prev?.q) return;
    const continued = prev.count - (prev.dropped || 0);
    st.branch = st.count < continued - Math.max(1, continued * 0.05);
  });
  const base = Math.max(1, ...steps.map((x) => x.count));
  const leak = steps.filter((x) => x.dropped).sort((a, b) => b.dropped - a.dropped)[0];
  const wrap = el('div', { class: 'river' });
  const scroll = el('div', { class: 'river-scroll' }, wrap);
  const summary = `Alur responden: ${steps.map((x) => `${x.title} ${x.count}`).join(', ')}.`;

  const draw = () => {
    const avail = scroll.clientWidth;
    if (!avail) return;
    const colW = Math.max(92, avail / steps.length);
    const width = colW * steps.length;
    const H = 176;
    const top = 36; // headroom for the callout
    const barW = Math.min(44, colW * 0.4);
    const yOf = (c) => top + (H - top) * (1 - c / base);
    const chart = svg('svg', { width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': summary });
    let callout = null;
    steps.forEach((st, i) => {
      const cx = colW * i + colW / 2;
      const x0 = cx - barW / 2;
      const x1 = cx + barW / 2;
      const y = yOf(st.count);
      const next = steps[i + 1];
      if (next) {
        const nx = colW * (i + 1) + colW / 2 - barW / 2;
        const ny = yOf(next.count);
        const mid = (x1 + nx) / 2;
        const hot = leak && leak.key === st.key;
        chart.append(svg('path', { d: `M${x1},${y} C${mid},${y} ${mid},${ny} ${nx},${ny} L${nx},${H} L${x1},${H} Z`, fill: hot ? FLOW.leak : FLOW.ribbon }));
        if (hot) {
          callout = el('span', { class: 'river-callout' }, icon('arrowRight', { size: 12 }), `${fmt.format(st.dropped)} berhenti (${pct(st.dropRate)})`);
          callout.style.left = `${mid}px`;
          callout.style.top = `${Math.min(y, ny)}px`;
        }
      }
      const h = H - y;
      const r = Math.min(4, h, barW / 2);
      const fill = st.key === 'open' ? FLOW.open : st.key === 'done' ? FLOW.done : FLOW.question;
      chart.append(svg('path', { d: `M${x0},${H} L${x0},${y + r} Q${x0},${y} ${x0 + r},${y} L${x1 - r},${y} Q${x1},${y} ${x1},${y + r} L${x1},${H} Z`, fill }));
    });
    chart.append(svg('line', { x1: 0, x2: width, y1: H - 0.5, y2: H - 0.5, stroke: 'rgba(6,11,20,.14)' }));

    const cols = el('div', { class: 'river-cols', style: `grid-template-columns: repeat(${steps.length}, ${colW}px)` }, steps.map((st) => {
      const share = s.views ? pct(st.count / s.views) : '–';
      const tile = st.q ? typeTile(st.q.type, st.q.type === 'statement' ? undefined : st.n)
        : el('span', { class: 'type-tile neutral' }, icon(st.key === 'open' ? 'eye' : 'check', { size: 14 }));
      const detail = (st.dropped ? `, ${fmt.format(st.dropped)} berhenti di sini (${pct(st.dropRate)})` : '')
        + (st.branch ? '. Hanya ditanyakan ke sebagian responden karena logika' : '');
      return el('div', {
        class: `river-col${leak && leak.key === st.key ? ' hot' : ''}`, tabindex: 0, role: 'group',
        'aria-label': `${st.title}: ${fmt.format(st.count)} orang, ${share} dari pengunjung${detail}`,
        title: `${st.title}\n${fmt.format(st.count)} orang (${share} dari pengunjung)${detail}`,
      }, tile, el('span', { class: 'rc-title', text: st.title }), el('span', { class: 'rc-count', text: fmt.format(st.count) }),
      el('span', { class: 'rc-pct' }, share, st.branch ? el('span', { class: 'rc-branch', text: 'cabang' }) : null));
    }));
    wrap.style.width = `${width}px`;
    wrap.replaceChildren(chart, ...(callout ? [callout] : []), cols);
  };

  let frame = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); });
  ro.observe(scroll);
  return scroll;
}

function flowCard(s, form) {
  const table = funnelTable(s.funnel);
  table.hidden = true;
  const toggle = el('button', {
    class: 'link-btn', type: 'button', 'aria-expanded': 'false',
    onclick: () => { table.hidden = !table.hidden; toggle.textContent = table.hidden ? 'Lihat sebagai tabel' : 'Sembunyikan tabel'; toggle.setAttribute('aria-expanded', String(!table.hidden)); },
  }, 'Lihat sebagai tabel');
  const key = (color, label) => el('span', {}, el('i', { style: `background:${color}` }), label);
  return el('section', { class: 'card river-card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'Alur responden' }), el('span', { class: 'muted', text: 'Tiap kolom: orang yang sampai di langkah itu' })),
    s.views || s.completions ? flowChart(s, form) : el('p', { class: 'empty-state', text: 'Alur akan muncul setelah ada pengunjung.' }),
    el('div', { class: 'river-foot' },
      el('div', { class: 'river-legend' }, key(FLOW.open, 'Pengunjung'), key(FLOW.question, 'Sampai di pertanyaan'), key(FLOW.done, 'Terkirim'), key(FLOW.leak, 'Kebocoran terbesar')),
      toggle),
    table);
}

// ─── Charts ─────────────────────────────────────────────────────────────────
function kpi(label, value, sub) {
  return el('div', { class: 'kpi' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), sub ? el('div', { class: 'sub', text: sub }) : null);
}

/** Two-series daily line chart with crosshair tooltip (one shared y-axis: both are counts). */
function lineChart(daily) {
  const W = 800; const H = 240; const P = { l: 36, r: 8, t: 10, b: 26 };
  const max = Math.max(4, ...daily.map((d) => Math.max(d.views, d.completions)));
  const niceMax = Math.ceil(max / 4) * 4;
  const x = (i) => P.l + (daily.length === 1 ? 0 : (i / (daily.length - 1)) * (W - P.l - P.r));
  const y = (v) => H - P.b - (v / niceMax) * (H - P.t - P.b);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%', role: 'img', 'aria-label': 'Pengunjung dan pengiriman per hari' });
  for (let i = 0; i <= 4; i++) {
    const v = (niceMax / 4) * i;
    root.append(svg('line', { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: i ? 'rgba(6,11,20,.06)' : 'rgba(6,11,20,.14)' }));
    const t = svg('text', { x: P.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'rgba(6,11,20,.46)' });
    t.textContent = fmt.format(v); root.append(t);
  }
  const step = Math.ceil(daily.length / 7);
  daily.forEach((d, i) => {
    const last = daily.length - 1;
    if (i !== last && (i % step || last - i < step / 2)) return;
    const t = svg('text', { x: x(i), y: H - 6, 'text-anchor': i === last ? 'end' : 'middle', 'font-size': 11, fill: 'rgba(6,11,20,.46)' });
    t.textContent = new Date(`${d.date}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    root.append(t);
  });
  for (const key of ['views', 'completions']) {
    const pts = daily.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`);
    if (key === 'completions') {
      root.append(svg('path', { d: `M${pts[0]} L${pts.join(' L')} L${x(daily.length - 1)},${y(0)} L${x(0)},${y(0)} Z`, fill: 'rgba(57,103,189,.08)' }));
    }
    root.append(svg('path', { d: `M${pts.join(' L')}`, fill: 'none', stroke: SERIES[key], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = daily[daily.length - 1];
    root.append(svg('circle', { cx: x(daily.length - 1), cy: y(last[key]), r: 3.5, fill: SERIES[key], stroke: '#fff', 'stroke-width': 2 }));
  }
  const hair = svg('line', { y1: P.t, y2: H - P.b, stroke: 'rgba(6,11,20,.3)', 'stroke-width': 1, visibility: 'hidden' });
  const dots = ['views', 'completions'].map((k) => svg('circle', { r: 4.5, fill: SERIES[k], stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }));
  root.append(hair, ...dots);

  const tip = el('div', { class: 'tip', hidden: true });
  const box = el('div', { class: 'chart-box', tabindex: 0, 'aria-label': 'Grafik harian. Gunakan panah kiri dan kanan untuk melihat per hari.' }, root, tip);
  const show = (i) => {
    const d = daily[i];
    hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('visibility', 'visible');
    ['views', 'completions'].forEach((k, j) => { dots[j].setAttribute('cx', x(i)); dots[j].setAttribute('cy', y(d[k])); dots[j].setAttribute('visibility', 'visible'); });
    tip.replaceChildren(
      el('div', { class: 'tip-date', text: new Date(`${d.date}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) }),
      ...['views', 'completions'].map((k) => el('div', { class: 'tip-row' },
        el('span', { class: 'key', style: `background:${SERIES[k]}` }),
        el('strong', { text: fmt.format(d[k]) }), el('span', { class: 'muted', text: k === 'views' ? 'pengunjung' : 'terkirim' }))));
    tip.hidden = false;
    const rect = box.getBoundingClientRect();
    const px = (x(i) / W) * rect.width;
    tip.style.left = `${px > rect.width - 170 ? px - 162 : px + 12}px`;
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
  return box;
}

function trendCard(daily) {
  const legend = el('div', { class: 'legend' },
    ['views', 'completions'].map((k) => el('span', {}, el('span', { class: 'key', style: `background:${SERIES[k]}` }), k === 'views' ? 'Pengunjung' : 'Terkirim')));
  return el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', { text: 'Per hari' }), legend), lineChart(daily));
}

/** Horizontal bars in HTML: value labels always visible, so no tooltip needed. */
function bars(entries, { color = '#3967BD', percentOf } = {}) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return el('div', { class: 'hbars' }, entries.map(([label, v]) => el('div', { class: 'hbar', title: `${label}: ${fmt.format(v)}` },
    el('span', { class: 'hbar-label', text: String(label) }),
    el('span', { class: 'hbar-track' }, v ? el('span', { class: 'hbar-fill', style: `width:${(v / max) * 100}%;background:${color}` }) : null),
    el('span', { class: 'hbar-value' }, el('strong', { text: fmt.format(v) }), percentOf ? ` · ${pct(v / percentOf)}` : null))));
}

function funnelTable(funnel) {
  const top = Math.max(1, ...funnel.map((f) => f.reached));
  return el('div', { class: 'table-wrap', style: 'margin-top:14px' }, el('table', { class: 'data' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Pertanyaan' }), el('th', { text: 'Sampai sini' }), el('th', { text: 'Berhenti di sini' }))),
    el('tbody', {}, funnel.map((f) => el('tr', {},
      el('td', { text: f.title }),
      el('td', {}, el('div', { class: 'bar-cell' }, el('span', { class: 'bar', style: `width:${Math.max(2, (f.reached / top) * 80)}px` }), el('span', { text: fmt.format(f.reached) }))),
      el('td', { class: 'num', text: f.droppedHere ? `${fmt.format(f.droppedHere)} (${pct(f.dropRate)})` : '–' }))))));
}

/** Score distribution as columns; 0–10 scales are coloured by NPS group. */
function scaleHistogram(q, counts, question) {
  const keys = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const max = Math.max(1, ...keys.map((k) => counts[k]));
  const nps = q.nps !== undefined;
  const color = (k) => (!nps ? '#3967BD' : k >= 9 ? '#3967BD' : k >= 7 ? '#9DB2DD' : '#B9C1CE');
  const cols = `grid-template-columns: repeat(${keys.length}, minmax(0, 1fr))`;
  const label = (k) => (question?.type === 'rating' ? `${k}★` : String(k));
  return el('div', {},
    el('div', { class: 'nps-hist', style: cols, role: 'img', 'aria-label': keys.map((k) => `${label(k)}: ${counts[k]}`).join(', ') }, keys.map((k) => el('div', { class: 'col', title: `${label(k)}: ${fmt.format(counts[k])} jawaban` },
      el('span', { class: 'n', text: counts[k] ? fmt.format(counts[k]) : '' }),
      el('span', { class: 'bar', style: `height:${(counts[k] / max) * 86}%;background:${color(k)}` })))),
    el('div', { class: 'nps-axis', style: cols }, keys.map((k) => el('span', { text: label(k) }))),
    nps ? el('div', { class: 'nps-key' },
      el('span', {}, el('i', { style: 'background:#B9C1CE' }), 'Detraktor 0–6'),
      el('span', {}, el('i', { style: 'background:#9DB2DD' }), 'Pasif 7–8'),
      el('span', {}, el('i', { style: 'background:#3967BD' }), 'Promotor 9–10')) : null);
}

function questionCard(q, form) {
  const question = form.questions.find((x) => x.id === q.id);
  const n = form.questions.filter((x) => x.type !== 'statement').findIndex((x) => x.id === q.id) + 1;
  const head = el('div', { class: 'card-head' },
    el('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap;min-width:0' }, question ? typeTile(question.type, n) : null, el('h3', { text: q.title })),
    el('span', { class: 'muted', style: 'white-space:nowrap', text: `${fmt.format(q.answered)} jawaban` }));
  let body;
  if (!q.answered) body = el('p', { class: 'muted', style: 'margin:0', text: 'Belum ada jawaban.' });
  else if (q.kind === 'choice') {
    body = bars(Object.entries(q.counts).sort((a, b) => b[1] - a[1]), { percentOf: q.answered });
  } else if (q.kind === 'numeric') {
    const fmt1 = (v) => (v === null ? '–' : v.toLocaleString('id-ID', { maximumFractionDigits: 2 }));
    const stat = (label, value) => el('div', { class: 'q-stat' }, el('div', { class: 'muted', text: label }), el('strong', { text: value }));
    body = el('div', {},
      el('div', { class: 'q-stats' },
        q.nps !== undefined ? stat('NPS', q.nps === null ? '–' : String(q.nps)) : null,
        stat('Rata-rata', fmt1(q.avg)),
        stat('Median', fmt1(q.median)),
        q.counts ? null : stat('Rentang', `${fmt1(q.min)}–${fmt1(q.max)}`)),
      q.counts ? scaleHistogram(q, q.counts, question) : null,
      q.nps !== undefined ? el('p', { class: 'muted small', style: 'margin:10px 0 0', text: 'NPS = % promotor dikurangi % detraktor, dari −100 sampai 100.' }) : null);
  } else {
    body = el('ul', { class: 'recent' }, q.recent.map((t) => el('li', { text: t.length > 160 ? `${t.slice(0, 160)}…` : t })));
  }
  return el('section', { class: 'card' }, head, body);
}

const NOWRAP_TYPES = new Set(['phone', 'email', 'date', 'number']);

function responsesTable(form, rows) {
  const qs = form.questions.filter((q) => q.type !== 'statement');
  if (!rows.length) return el('p', { class: 'empty-state', text: 'Belum ada jawaban pada rentang ini.' });
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Waktu' }), qs.map((q) => el('th', { text: plainTitle(q.title) })), el('th', { text: 'Sumber' }))),
    el('tbody', {}, rows.map((r) => el('tr', {},
      el('td', { class: 'nowrap', text: new Date(r.submittedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) }),
      qs.map((q) => {
        const v = r.answers?.[q.id];
        // Phone numbers and emails are unreadable once they wrap mid-value.
        return el('td', { class: NOWRAP_TYPES.has(q.type) ? 'nowrap' : null, text: Array.isArray(v) ? v.join(', ') : String(v ?? '') });
      }),
      el('td', { text: r.hidden?.utm_source || '(langsung)' }))))));
}

function downloadCSV(name, csv) {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${name}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${Math.max(1, min)} menit lalu`;
  if (min < 1440) return `${Math.round(min / 60)} jam lalu`;
  return `${Math.round(min / 1440)} hari lalu`;
}

/** Contacts who started but did not submit: the list the team follows up. */
function partialsSection(form, partials, { canDownload }) {
  const title = (p) => plainTitle(form.questions.find((q) => q.id === p.lastQuestion)?.title) || p.lastQuestionTitle || '–';
  const head = el('div', { class: 'card-head' },
    el('h3', { text: `Belum selesai · ${fmt.format(partials.length)} kontak` }),
    canDownload && partials.length
      ? el('button', { class: 'btn-ghost small', type: 'button', onclick: () => downloadCSV(`${form.title || 'form'} - belum selesai`, partialsCSV(form, partials)) }, 'Ekspor CSV')
      : null);
  const note = el('p', { class: 'muted small', style: 'margin:-6px 0 14px', text: 'Sudah mengisi email atau nomor telepon, tapi belum mengirim. Hilang dari daftar begitu mereka mengirim, dan dihapus setelah 30 hari.' });
  if (!partialsEnabled(form)) {
    return el('section', { class: 'card', id: 'res-partials' }, head, el('p', { class: 'muted small', style: 'margin:0', text: 'Belum aktif untuk form ini. Nyalakan di tab Integrasi, bagian "Pemulihan jawaban yang belum selesai".' }));
  }
  if (!partials.length) return el('section', { class: 'card', id: 'res-partials' }, head, note, el('p', { class: 'empty-state', text: 'Tidak ada kontak yang berhenti di tengah pada rentang ini.' }));
  return el('section', { class: 'card', id: 'res-partials' }, head, note,
    el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ['Terakhir aktif', 'Nama', 'Kontak', 'Berhenti di', 'Sumber', ''].map((t) => el('th', { text: t })))),
      el('tbody', {}, partials.map((p) => {
        const c = p.contact || {};
        const wa = whatsappLink(c.phone, `Halo ${c.name || ''}, kami lihat Anda belum selesai mengisi "${form.title}". Ada yang bisa kami bantu?`.replace('Halo ,', 'Halo,'));
        return el('tr', {},
          el('td', { style: 'white-space:nowrap', title: new Date(p.updatedAt).toLocaleString('id-ID'), text: ago(p.updatedAt) }),
          el('td', { style: 'font-weight:500', text: c.name || '–' }),
          el('td', {}, el('div', { class: 'contact-cell' }, c.phone ? el('span', { text: c.phone }) : null, c.email ? el('span', { class: 'muted', text: c.email }) : null)),
          el('td', {}, title(p), el('div', { class: 'muted small', text: `${p.answeredCount ?? Object.keys(p.answers || {}).length} pertanyaan dijawab` })),
          el('td', { text: p.hidden?.utm_source || '(langsung)' }),
          el('td', {}, wa ? el('a', { class: 'btn-wa', href: wa, target: '_blank', rel: 'noopener' }, icon('whatsapp', { size: 14 }), 'Chat WA') : null));
      })))));
}

// ─── Mount ──────────────────────────────────────────────────────────────────
/**
 * @param {HTMLElement} host
 * @param {object} opts  { backend, formId, form?, demoNote?, canDownload? }
 *   form        use this definition instead of fetching (e.g. the builder's draft)
 *   demoNote    text for the example-data note
 *   canDownload false hides CSV export (sandboxed previews block downloads)
 */
export function mountResults(host, { backend, formId, form: givenForm = null, demoNote = '', canDownload = true }) {
  let current = { form: null, responses: [], events: [], partials: [] };
  const range = el('select', { 'aria-label': 'Rentang waktu', class: 'res-range' },
    [['7', '7 hari terakhir'], ['30', '30 hari terakhir'], ['90', '90 hari terakhir'], ['365', '1 tahun terakhir']].map(([v, t]) => el('option', { value: v, selected: v === '30', text: t })));
  const sheetLink = el('a', { class: 'btn-ghost small', target: '_blank', rel: 'noopener', hidden: true, text: 'Google Sheet' });
  const csvBtn = el('button', { class: 'btn-ghost small', type: 'button', hidden: !canDownload, text: 'Ekspor CSV' });
  const refresh = el('button', { class: 'icon-btn sm', type: 'button', title: 'Muat ulang', 'aria-label': 'Muat ulang' }, icon('refresh', { size: 16 }));
  const status = el('p', { class: 'res-status' });
  const body = el('div', { class: 'stack res-body' });
  host.replaceChildren(el('div', { class: 'res' },
    el('div', { class: 'res-bar' },
      el('div', { class: 'res-bar-left' }, el('h1', { class: 'res-title' }), status),
      el('div', { class: 'res-tools' }, range, refresh, sheetLink, csvBtn)),
    demoNote ? el('p', { class: 'res-note' }, el('span', { class: 'tag', text: 'Data contoh' }), demoNote) : null,
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
    const since = Date.now() - days * 86400000;
    const partials = (current.partials || []).filter((p) => new Date(p.updatedAt).getTime() >= since);
    const medDur = s.medianDurationSec === null || s.medianDurationSec === undefined ? null : Math.round(s.medianDurationSec);
    const scrollToPartials = () => host.querySelector('#res-partials')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    host.querySelector('.res-title').textContent = form.title || 'Hasil';
    status.textContent = `${days} hari terakhir · ${{ cloud: 'Cloudflare D1', sheets: 'Google Sheets', local: 'tersimpan di browser ini' }[backend.name]}`;
    body.replaceChildren(
      // replaceChildren() would render a literal "null", so spread an empty list instead.
      ...(current.sheetStatus ? [el('p', { class: `small ${current.sheetStatus.startsWith('ERROR') ? 'bad' : 'muted'}`, style: 'margin:0', text: `Sinkron Google Sheet: ${current.sheetStatus}` })] : []),
      hero(s, form, partials, days, scrollToPartials),
      flowCard(s, form),
      el('div', { class: 'kpi-strip' },
        kpi('Pengunjung', fmt.format(s.views), 'sesi unik'),
        kpi('Mulai mengisi', fmt.format(s.starts), s.views ? `${pct(s.startRate)} dari pengunjung` : ''),
        kpi('Terkirim', fmt.format(s.completions), `sekitar ${fmt.format(Math.round(s.completions / days))} per hari`),
        kpi('Selesai dari yang mulai', pct(s.completionOfStarts), `${fmt.format(s.completions)} dari ${fmt.format(s.starts)}`),
        kpi('Median waktu isi', medDur ? `${Math.floor(medDur / 60)}m ${medDur % 60}d` : '–', 'dari yang terkirim'),
        partialsEnabled(form) ? kpi('Kontak belum kirim', fmt.format(partials.length), 'bisa dihubungi') : null),
      el('div', { class: 'grid2 res-duo' },
        trendCard(s.daily),
        el('section', { class: 'card' },
          el('div', { class: 'card-head' }, el('h3', { text: 'Sumber pengunjung' }), el('span', { class: 'muted', text: 'dari utm_source' })),
          Object.keys(s.sources).length
            ? bars(Object.entries(s.sources).sort((a, b) => b[1] - a[1]).slice(0, 8), { percentOf: s.completions })
            : el('p', { class: 'muted', style: 'margin:0', text: 'Belum ada data.' }))),
      partialsSection(form, partials, { canDownload }),
      el('h2', { class: 'section-title', text: 'Jawaban per pertanyaan' }),
      el('div', { class: 'grid2' }, s.perQuestion.map((q) => questionCard(q, form))),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', { text: 'Jawaban terbaru' }), el('span', { class: 'muted', text: `${fmt.format(latest.length)} dari ${fmt.format(totalInRange)}` })),
        responsesTable(form, latest)),
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
      body.replaceChildren(el('div', { class: 'empty-state' }, el('p', { text: `Data tidak bisa dimuat: ${err.message}` }),
        backend.name !== 'local' ? el('p', { class: 'small', text: 'Periksa admin key di Pengaturan, lalu muat ulang.' }) : null));
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
    downloadCSV(current.form.title || 'form', toCSV(current.form, rows));
  });
  load();
  return { reload: load };
}
