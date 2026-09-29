// "Uji A/B" tab: create variant B, split traffic, read the result.
// The verdict follows a fixed-horizon test (see ab.js): a winner is named only
// after both variants reach the planned sample and the test ran a full week.
import { el } from './dom.js';
import { icon } from './icons.js';
import { compareVariants, sampleSizePerVariant, MIN_DAYS, DEFAULT_MDE } from './ab.js';
import { plainTitle, VARIANT_KEYS } from './logic.js';

const SVG = 'http://www.w3.org/2000/svg';
const COLORS = { A: '#8A93A6', B: '#3967BD' };
const fmt = new Intl.NumberFormat('id-ID');
const pct = (x, d = 1) => `${(x * 100).toLocaleString('id-ID', { maximumFractionDigits: d, minimumFractionDigits: d })}%`;
const pts = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toLocaleString('id-ID', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} poin`;
const day = (iso) => new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** What B changes, in words: "judul pembuka, 2 pertanyaan, tema". */
export function variantDiff(form) {
  const b = form.variants?.B;
  if (!b) return [];
  const out = [];
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  if (!same(form.welcome, b.welcome)) out.push('halaman pembuka');
  const aq = Object.fromEntries((form.questions || []).map((q) => [q.id, q]));
  const bq = b.questions || [];
  const changed = bq.filter((q) => !aq[q.id] || !same(aq[q.id], q)).length;
  const removed = (form.questions || []).filter((q) => !bq.some((x) => x.id === q.id)).length;
  if (changed) out.push(`${changed} pertanyaan diubah/ditambah`);
  if (removed) out.push(`${removed} pertanyaan dihapus`);
  if (bq.length === (form.questions || []).length && !changed && !removed && bq.some((q, i) => q.id !== form.questions[i].id)) out.push('urutan pertanyaan');
  if (!same(form.thankyou, b.thankyou)) out.push('halaman akhir');
  if (!same(form.theme, b.theme)) out.push('desain');
  return out;
}

function totals(rows) {
  const t = { A: { views: 0, starts: 0, completions: 0 }, B: { views: 0, starts: 0, completions: 0 } };
  for (const r of rows) if (t[r.variant]) for (const k of ['views', 'starts', 'completions']) t[r.variant][k] += Number(r[k] || 0);
  return t;
}

/** Cumulative conversion per variant over the days of the test. */
function trendChart(rows) {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  if (days.length < 2) return el('p', { class: 'muted small', text: 'Grafik muncul setelah uji berjalan 2 hari.' });
  const W = 800; const H = 200; const P = { l: 40, r: 12, t: 12, b: 24 };
  const series = {};
  for (const v of ['A', 'B']) {
    let views = 0; let comp = 0;
    series[v] = days.map((d) => {
      const r = rows.find((x) => x.day === d && x.variant === v);
      views += Number(r?.views || 0); comp += Number(r?.completions || 0);
      return views ? comp / views : null;
    });
  }
  const vals = [...series.A, ...series.B].filter((x) => x !== null);
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 0.02) * 10) / 10);
  const hi = Math.min(1, Math.ceil((Math.max(...vals) + 0.02) * 10) / 10);
  const step = hi - lo > 0.6 ? 0.2 : 0.1; // round ticks: 40%, 50%, 60% …
  const x = (i) => P.l + (i / (days.length - 1)) * (W - P.l - P.r);
  const y = (v) => H - P.b - ((v - lo) / (hi - lo || 1)) * (H - P.t - P.b);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Konversi kumulatif per hari. Hari terakhir: A ${pct(series.A.at(-1) || 0)}, B ${pct(series.B.at(-1) || 0)}.` });
  for (let v = lo, i = 0; v <= hi + 1e-9; v += step, i++) {
    root.append(svg('line', { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: i ? 'rgba(6,11,20,.06)' : 'rgba(6,11,20,.14)' }));
    const t = svg('text', { x: P.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'rgba(6,11,20,.58)' });
    t.textContent = `${Math.round(v * 100)}%`;
    root.append(t);
  }
  [0, days.length - 1].forEach((i) => {
    const t = svg('text', { x: x(i), y: H - 6, 'text-anchor': i ? 'end' : 'start', 'font-size': 11, fill: 'rgba(6,11,20,.58)' });
    t.textContent = day(`${days[i]}T00:00:00Z`);
    root.append(t);
  });
  for (const v of ['A', 'B']) {
    const p = series[v].map((val, i) => (val === null ? null : `${x(i).toFixed(1)},${y(val).toFixed(1)}`)).filter(Boolean);
    if (!p.length) continue;
    root.append(svg('path', { d: `M${p.join(' L')}`, fill: 'none', stroke: COLORS[v], 'stroke-width': v === 'B' ? 2.5 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = p.at(-1).split(',');
    root.append(svg('circle', { cx: last[0], cy: last[1], r: 4, fill: COLORS[v], stroke: '#fff', 'stroke-width': 2 }));
  }
  return el('div', { class: 'ab-trend' }, root);
}

/**
 * @param ctx {
 *   form, canEdit, backend,
 *   createVariant(), deleteVariant(), editVariant(v), preview(v),
 *   start(split), pause(), end(winner, snapshot), setSplit(n)
 * }
 */
export function renderAbTab(ctx) {
  const { form, canEdit } = ctx;
  const x = form.experiment;
  const b = form.variants?.B;
  const head = (status) => el('div', { class: 'page-head ab-head' },
    el('div', {}, el('h1', {}, 'Uji A/B', status ? el('span', { class: `ab-status ab-${x?.status || 'draft'}`, text: status }) : null),
      el('p', { class: 'muted', text: 'Bandingkan dua versi form di link yang sama. Tiap pengunjung melihat satu versi secara acak dan tetap di versi itu.' })));
  const history = (form.experiments || []).length ? el('section', { class: 'card ab-history' },
    el('h3', { text: 'Uji sebelumnya' }),
    el('ul', {}, [...form.experiments].reverse().map((e) => {
      const t = e.totals;
      const line = t ? ` · A ${pct(t.A.views ? t.A.completions / t.A.views : 0)} vs B ${pct(t.B.views ? t.B.completions / t.B.views : 0)}` : '';
      return el('li', {}, el('strong', { text: e.winner === 'B' ? 'B dipakai' : 'A dipertahankan' }),
        el('span', { class: 'muted', text: ` · ${day(e.startedAt || e.endedAt)} – ${day(e.endedAt)}${line}${e.change ? ` · ${e.change}` : ''}` }));
    }))) : null;

  // ─── No variant yet ───────────────────────────────────────────────────────
  if (!b) {
    return el('div', { class: 'bw-page ab' }, head(''),
      el('section', { class: 'card ab-empty' },
        el('div', { class: 'ab-empty-art', 'aria-hidden': 'true' }, el('span', { text: 'A' }), icon('split', { size: 22 }), el('span', { text: 'B' })),
        el('h2', { text: 'Uji satu perubahan dulu' }),
        el('ul', { class: 'ab-ideas' },
          el('li', {}, el('strong', { text: 'Judul halaman pembuka.' }), ' Kalimat pertama yang dibaca orang dari iklan.'),
          el('li', {}, el('strong', { text: 'Posisi pertanyaan kontak.' }), ' Kolom email dan telepon termasuk titik berhenti paling sering (benchmark Zuko).'),
          el('li', {}, el('strong', { text: 'Jumlah pertanyaan.' }), ' Hapus pertanyaan yang jawabannya tidak dipakai tim.')),
        canEdit
          ? el('button', { class: 'btn', type: 'button', onclick: ctx.createVariant }, icon('plus', { size: 16 }), 'Buat varian B')
          : el('p', { class: 'muted small', text: 'Editor atau admin bisa membuat varian.' }),
        el('p', { class: 'muted small', text: 'Varian B dimulai sebagai salinan form ini. Ubah satu hal saja, supaya jelas apa yang membuat bedanya.' })),
      history);
  }

  const diff = variantDiff(form);
  const variantCard = (v) => {
    const f = v === 'B' ? { ...form, ...b } : form;
    return el('section', { class: `card ab-variant ab-variant-${v}` },
      el('div', { class: 'ab-variant-head' }, el('span', { class: `ab-letter ab-letter-${v}`, text: v }), el('strong', { text: v === 'A' ? 'Asli' : 'Varian' }),
        v === 'B' && diff.length ? el('span', { class: 'muted small', text: `beda: ${diff.join(', ')}` }) : v === 'B' ? el('span', { class: 'muted small', text: 'belum ada perubahan' }) : null),
      el('p', { class: 'ab-variant-title', text: plainTitle(f.welcome?.enabled === false ? f.questions?.[0]?.title : (f.welcome?.title || f.title)) || '(tanpa judul)' }),
      el('p', { class: 'muted small', text: `${(f.questions || []).filter((q) => q.type !== 'statement').length} pertanyaan` }),
      el('div', { class: 'row' },
        canEdit ? el('button', { class: 'btn-ghost small', type: 'button', onclick: () => ctx.editVariant(v) }, 'Edit') : null,
        el('button', { class: 'btn-ghost small', type: 'button', onclick: () => ctx.preview(v) }, icon('eye', { size: 14 }), 'Pratinjau')));
  };

  // ─── Variant exists, test not started ─────────────────────────────────────
  if (!x || x.status === 'draft') {
    const split = Number(x?.split ?? 50);
    const out = el('span', { text: `${split}%` });
    const estimate = el('p', { class: 'ab-estimate muted', text: 'Menghitung perkiraan dari 14 hari terakhir…' });
    const range = el('input', {
      type: 'range', min: 10, max: 90, step: 5, value: split, disabled: !canEdit, 'aria-label': 'Persentase pengunjung yang melihat varian B',
      oninput: (e) => { out.textContent = `${e.target.value}%`; }, onchange: (e) => ctx.setSplit(Number(e.target.value)),
    });
    ctx.backend.getResults(form.id, 14).then(async (res) => {
      const { computeStats } = await import('./stats.js');
      const s = res.stats || computeStats(form, res.responses || [], res.events || [], { days: 14 });
      const perDay = s.views / 14;
      const n = sampleSizePerVariant(s.views >= 100 ? s.completionRate : 0.3, DEFAULT_MDE);
      const share = Math.min(split, 100 - split) / 100;
      const daysNeeded = perDay ? Math.max(MIN_DAYS, Math.ceil(n / (perDay * share))) : null;
      estimate.textContent = s.views >= 100
        ? `Konversi 14 hari terakhir ${pct(s.completionRate)} dari ±${fmt.format(Math.round(perDay))} pengunjung/hari. Untuk melihat selisih 5 poin, tiap varian butuh ±${fmt.format(n)} pengunjung: sekitar ${fmt.format(daysNeeded)} hari dengan pembagian ini.`
        : `Belum cukup data untuk memperkirakan. Dengan konversi sekitar 30%, tiap varian butuh ±${fmt.format(n)} pengunjung untuk melihat selisih 5 poin.`;
    }).catch(() => { estimate.textContent = ''; });
    return el('div', { class: 'bw-page ab' }, head('Belum dimulai'),
      el('div', { class: 'ab-pair' }, variantCard('A'), variantCard('B')),
      el('section', { class: 'card ab-setup' },
        el('h3', { text: 'Pembagian pengunjung' }),
        el('div', { class: 'ab-split' }, el('span', { text: 'A' }), range, el('span', { text: 'B' }), el('strong', { class: 'ab-split-out' }, out, ' ke B')),
        estimate,
        canEdit ? el('div', { class: 'row' },
          el('button', { class: 'btn', type: 'button', onclick: () => ctx.start(Number(range.value)) }, 'Mulai uji'),
          el('button', { class: 'btn-ghost danger', type: 'button', onclick: ctx.deleteVariant }, icon('trash', { size: 14 }), 'Hapus varian B')) : null),
      history);
  }

  // ─── Running or paused ────────────────────────────────────────────────────
  const days = Math.max(1, Math.ceil((Date.now() - new Date(x.startedAt || Date.now()).getTime()) / 86400000));
  const body = el('div', { class: 'stack' }, el('p', { class: 'muted', text: 'Memuat hasil…' }));
  const controls = canEdit ? el('div', { class: 'row' },
    x.status === 'running'
      ? el('button', { class: 'btn-ghost', type: 'button', onclick: ctx.pause }, 'Jeda')
      : el('button', { class: 'btn-ghost', type: 'button', onclick: () => ctx.start(x.split) }, 'Lanjutkan'),
    el('button', { class: 'btn', type: 'button', onclick: () => ctx.end(null, lastTotals) }, 'Akhiri uji')) : null;
  let lastTotals = null;

  ctx.backend.getExperiment(form.id, x.id, { startedAt: x.startedAt }).then((rows) => {
    const t = totals(rows);
    lastTotals = t;
    const c = compareVariants(t.A, t.B, { days });
    const lead = c.diff >= 0 ? 'B' : 'A';
    const headline = c.verdict === 'winner'
      ? el('h2', { class: 'res-headline' }, `Varian ${c.winner} menang: `, el('span', { class: 'hl', text: pts(Math.abs(c.diff)) }), ' konversi.')
      : c.verdict === 'no-difference'
        ? el('h2', { class: 'res-headline', text: 'Tidak ada beda yang berarti antara A dan B.' })
        : t.A.views + t.B.views === 0
          ? el('h2', { class: 'res-headline', text: 'Menunggu pengunjung pertama.' })
          : el('h2', { class: 'res-headline' }, `Varian ${lead} unggul `, el('span', { class: 'hl', text: pts(Math.abs(c.diff)).replace(/^[+−]/, '') }), ', tapi belum pasti.');
    const remainingDays = (() => {
      const perDay = (t.A.views + t.B.views) / days;
      const share = Math.min(x.split ?? 50, 100 - (x.split ?? 50)) / 100;
      const needMore = Math.max(0, c.needed - Math.min(t.A.views, t.B.views));
      return perDay ? Math.max(MIN_DAYS - days, Math.ceil(needMore / (perDay * share))) : null;
    })();
    const when = remainingDays === null ? ''
      : remainingDays > 60 ? ': lebih dari 2 bulan lagi pada traffic sekarang. Uji perubahan yang lebih besar, atau jalankan saat traffic iklan lebih tinggi'
        : `: sekitar ${fmt.format(Math.max(0, remainingDays))} hari lagi`;
    const lede = c.verdict === 'collecting'
      ? `Peluang B lebih baik dari A: ${pct(c.probBBetter, 0)}. Hasil baru bisa dipegang setelah tiap varian mencapai ±${fmt.format(c.needed)} pengunjung dan uji berjalan minimal ${MIN_DAYS} hari${when}.`
      : c.verdict === 'winner'
        ? `p = ${c.pValue < 0.001 ? '< 0,001' : c.pValue.toLocaleString('id-ID', { maximumFractionDigits: 3 })}, selisih 95% CI ${pts(c.ci[0])} s.d. ${pts(c.ci[1])}. Akhiri uji dan pakai varian ${c.winner} untuk semua pengunjung.`
        : `Kedua varian sudah mencapai sampel yang direncanakan. Selisihnya (${pts(c.diff)}) masih bisa kebetulan. Pertahankan A, atau uji perubahan yang lebih besar.`;

    const side = (v) => {
      const s = t[v];
      const rate = s.views ? s.completions / s.views : 0;
      return el('div', { class: `ab-side ab-side-${v}${c.verdict !== 'no-difference' && lead === v && s.views ? ' lead' : ''}` },
        el('div', { class: 'ab-side-head' }, el('span', { class: `ab-letter ab-letter-${v}`, text: v }), el('span', { text: v === 'A' ? 'Asli' : 'Varian' })),
        el('div', { class: 'ab-rate', text: pct(rate) }),
        el('div', { class: 'muted small', text: `${fmt.format(s.completions)} terkirim dari ${fmt.format(s.views)} pengunjung` }),
        el('div', { class: 'ab-bar' }, el('i', { style: `width:${Math.min(100, rate * 100)}%;background:${COLORS[v]}` })));
    };
    const progress = el('div', { class: 'ab-progress' },
      el('div', { class: 'row between' },
        el('span', { class: 'small', text: `Sampel: ${fmt.format(Math.min(t.A.views, t.B.views))} dari ${fmt.format(c.needed)} pengunjung per varian` }),
        el('span', { class: 'small muted', text: `hari ke-${fmt.format(days)}${days >= MIN_DAYS ? ' ✓' : ` dari minimal ${MIN_DAYS}`}` })),
      el('div', { class: 'ab-meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(c.progress * 100) }, el('i', { style: `width:${Math.round(c.progress * 100)}%` })));

    body.replaceChildren(
      el('section', { class: 'res-hero' }, headline, el('p', { class: 'res-lede', text: lede })),
      el('section', { class: 'card ab-duel' },
        el('div', { class: 'ab-sides' }, side('A'), el('div', { class: 'ab-vs', text: 'vs' }), side('B')),
        el('p', { class: 'ab-diff' }, el('strong', { text: `Selisih ${pts(c.diff)}` }), el('span', { class: 'muted', text: ` · 95% CI ${pts(c.ci[0])} s.d. ${pts(c.ci[1])}` })),
        progress),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h3', { text: 'Konversi kumulatif' }),
          el('div', { class: 'legend' }, ['A', 'B'].map((v) => el('span', {}, el('span', { class: 'key', style: `background:${COLORS[v]}` }), `Varian ${v}`)))),
        trendChart(rows)),
      el('section', { class: 'card' },
        el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, ['Varian', 'Pengunjung', 'Mulai mengisi', 'Terkirim', 'Konversi', 'Selesai dari yang mulai'].map((h, i) => el('th', { class: i ? 'num' : null, text: h })))),
          el('tbody', {}, ['A', 'B'].map((v) => {
            const s = t[v];
            return el('tr', {},
              el('td', {}, el('span', { class: `ab-letter ab-letter-${v} sm`, text: v }), v === 'A' ? ' Asli' : ' Varian'),
              el('td', { class: 'num', text: fmt.format(s.views) }), el('td', { class: 'num', text: fmt.format(s.starts) }),
              el('td', { class: 'num', text: fmt.format(s.completions) }),
              el('td', { class: 'num', text: s.views ? pct(s.completions / s.views) : '–' }),
              el('td', { class: 'num', text: s.starts ? pct(Math.min(1, s.completions / s.starts)) : '–' }));
          }))))),
      el('p', { class: 'muted small', text: `Konversi = terkirim ÷ pengunjung. Target: selisih ${Math.round(DEFAULT_MDE * 100)} poin, α 5%, daya uji 80%. Jangan ubah varian atau pembagian saat uji berjalan, karena hasilnya jadi sulit dibaca.` }));
  }).catch((err) => body.replaceChildren(el('p', { class: 'empty-state', text: `Hasil uji tidak bisa dimuat: ${err.message}` })));

  return el('div', { class: 'bw-page ab' },
    el('div', { class: 'ab-top' }, head(x.status === 'running' ? `Berjalan · hari ke-${days}` : 'Dijeda'), controls),
    el('p', { class: 'ab-meta muted small' }, `Mulai ${day(x.startedAt || Date.now())} · ${x.split ?? 50}% pengunjung ke B · `,
      el('button', { class: 'link-btn', type: 'button', onclick: () => ctx.preview('A'), text: 'Lihat A' }), ' · ',
      el('button', { class: 'link-btn', type: 'button', onclick: () => ctx.preview('B'), text: 'Lihat B' }),
      diff.length ? ` · B beda di ${diff.join(', ')}` : ''),
    body,
    history);
}

/** Ends the test: B's screens replace A's (winner B) or are dropped (winner A); a summary is kept. */
export function endExperiment(form, winner, snapshot) {
  const x = form.experiment;
  const entry = { id: x.id, startedAt: x.startedAt, endedAt: new Date().toISOString(), split: x.split, winner, change: variantDiff(form).join(', ') };
  if (snapshot) entry.totals = { A: { views: snapshot.A.views, completions: snapshot.A.completions }, B: { views: snapshot.B.views, completions: snapshot.B.completions } };
  if (winner === 'B') for (const k of VARIANT_KEYS) if (form.variants.B[k] !== undefined) form[k] = structuredClone(form.variants.B[k]);
  form.experiments = [...(form.experiments || []), entry].slice(-20);
  delete form.variants;
  delete form.experiment;
  return entry;
}
