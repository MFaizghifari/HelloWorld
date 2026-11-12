// Topic search over KPw posts.
// 1) embed the query (Gemini embedding) and rank all posts by cosine similarity
// 2) Gemini Flash judges the top candidates (utama / menyinggung / tidak) and writes a short answer
// GET /api/search?q=stabilitas+nilai+tukar
// Data precomputed by scripts/build_topics.py: api/_vectors.json, api/_posts.json. Key: env GEMINI_API_KEY.
const VEC = require('./_vectors.json');
const POSTS = require('./_posts.json');
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEN_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const CANDIDATES = 60, BATCH = 30;
const cache = new Map();

async function gemini(model, method, body) {
  const r = await fetch(`${API}${model}:${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function rank(q) {
  const e = await gemini(VEC.model, 'embedContent', {
    content: { parts: [{ text: q }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: VEC.dim,
  });
  const v = e.embedding.values;
  const n = Math.hypot(...v) || 1;
  return VEC.ids.map((id, i) => {
    const d = VEC.v[i];
    let s = 0;
    for (let k = 0; k < d.length; k++) s += d[k] * v[k];
    return { id, s: Math.round((s / n) * 1000) / 1000 };
  }).sort((a, b) => b.s - a.s);
}

const JUDGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    jawaban: { type: 'STRING' },
    hasil: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      id: { type: 'STRING' }, relevansi: { type: 'STRING', enum: ['utama', 'menyinggung', 'tidak'] },
    }, required: ['id', 'relevansi'] } },
  },
  required: ['jawaban', 'hasil'],
};

async function judge(q, cands) {
  const list = cands.map(c => {
    const p = POSTS[c.id];
    return `[id=${c.id}] KPw ${p.kpw}. Ringkasan: ${p.r} Kata kunci: ${p.k.join(', ')}. Caption: ${p.c}`;
  }).join('\n');
  const prompt = `Pengguna mencari unggahan Instagram KPw Bank Indonesia dengan topik: "${q}"

Nilai setiap kandidat:
- "utama": topik itu menjadi inti unggahan.
- "menyinggung": topik itu dibahas tapi bukan inti (misalnya satu poin di ringkasan hasil RDG).
- "tidak": tidak membahas topik itu, atau hanya kata yang mirip.

Lalu tulis "jawaban": 2 kalimat Bahasa Indonesia yang lugas tentang ISI unggahan yang relevan: pesan, program, atau kegiatan apa yang diangkat dan KPw mana yang menonjol. JANGAN menyebut jumlah atau angka unggahan (jumlah dihitung terpisah). Jangan memakai tanda pisah panjang. Jika tidak ada yang relevan, tulis bahwa tidak ditemukan unggahan yang membahas topik ini.

Kandidat:
${list}`;
  const r = await gemini(GEN_MODEL, 'generateContent', {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 6000, responseMimeType: 'application/json',
      responseSchema: JUDGE_SCHEMA, thinkingConfig: { thinkingLevel: 'minimal' } },
  });
  return JSON.parse(r.candidates[0].content.parts.map(p => p.text || '').join(''));
}

module.exports = async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (q.length < 2) return res.status(400).json({ error: 'Kata pencarian terlalu pendek' });
  const key = q.toLowerCase();
  try {
    let out = cache.get(key);
    if (!out) {
      const scored = await rank(q);
      const cands = scored.slice(0, CANDIDATES);
      let ai = null;
      try {
        const parts = [];
        for (let i = 0; i < cands.length; i += BATCH) parts.push(cands.slice(i, i + BATCH));
        const rs = await Promise.all(parts.map(p => judge(q, p)));
        ai = { jawaban: rs[0].jawaban, hasil: rs.flatMap(r => r.hasil) };
      } catch (err) { console.error('judge', err.message); }
      const rel = new Map((ai?.hasil || []).map(h => [h.id, h.relevansi]));
      out = {
        q, ai: !!ai, jawaban: ai?.jawaban || null,
        // without the AI judge, fall back to a similarity band below the best match
        results: cands.map(c => ({ ...c, rel: ai ? (rel.get(c.id) || 'tidak') : (c.s >= cands[0].s - 0.03 ? 'menyinggung' : 'tidak') }))
          .filter(c => c.rel !== 'tidak'),
      };
      if (cache.size > 300) cache.clear();
      cache.set(key, out);
    }
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
