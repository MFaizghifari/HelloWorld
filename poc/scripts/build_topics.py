#!/usr/bin/env python3
"""AI layer: classify every post into BI topics + embed captions for semantic search.

Reads raw/posts.json, writes:
  data/topics.json    per-post topics/summary (cached by shortCode; rerun only classifies new posts)
  data/insights.json  per-KPw topic narrative written by Gemini
  api/_vectors.json   normalized embeddings used by api/search.js

Needs GEMINI_API_KEY (env or poc/.env.local). Stdlib only.
"""
import json, os, re, sys, time, math, urllib.request, urllib.error, collections
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from taxonomy import TOPICS, TOPIC_IDS  # noqa: E402

GEN_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
EMB_MODEL = "gemini-embedding-001"
EMB_DIM = 256
API = "https://generativelanguage.googleapis.com/v1beta/models/"


def load_key():
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    sys.exit("GEMINI_API_KEY tidak ditemukan")


KEY = load_key()


def call(model, method, body, tries=5):
    url = f"{API}{model}:{method}"
    data = json.dumps(body).encode()
    for i in range(tries):
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", "x-goog-api-key": KEY})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code in (429, 500, 503) and i < tries - 1:
                time.sleep(2 ** i * 3)
                continue
            raise RuntimeError(f"{e.code} {msg}")
        except (urllib.error.URLError, TimeoutError):
            if i < tries - 1:
                time.sleep(2 ** i * 3)
                continue
            raise


def generate_json(prompt, schema, max_tokens=16000):
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.1, "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json", "responseSchema": schema,
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }
    r = call(GEN_MODEL, "generateContent", body)
    text = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"])
    return json.loads(text), r.get("usageMetadata", {})


TOPIC_GUIDE = "\n".join(f"- {t['id']}: {t['label']}. {t['desc']}" for t in TOPICS)

CLASSIFY_PROMPT = """Kamu analis komunikasi Bank Indonesia. Klasifikasikan setiap unggahan Instagram kantor perwakilan (KPw) BI berikut.

Daftar topik (pakai id persis):
{guide}

Aturan:
- topik_utama: SATU topik yang paling menjadi inti pesan unggahan.
- topik_lain: 0-2 topik lain yang dibahas secara substantif (bukan sekadar disebut di hashtag atau kalimat penutup).
- Jika unggahan hasil RDG menyebut nilai tukar hanya sebagai bagian dari ringkasan kebijakan, topik_utama = kebijakan_moneter dan stabilitas_nilai_tukar boleh masuk topik_lain hanya bila dibahas lebih dari satu kalimat.
- cakupan: "nasional" bila isinya materi/kebijakan BI Pusat yang dibagikan ulang (RDG, kampanye nasional), "lokal" bila kegiatan atau isu di wilayah KPw itu.
- ringkasan: maksimal 20 kata, Bahasa Indonesia, faktual, sebut kegiatan/program dan lokasi bila ada.
- kata_kunci: 3-6 istilah penting dari unggahan (nama program, istilah kebijakan, lokasi, mitra).

Unggahan:
{posts}"""

CLASSIFY_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "id": {"type": "STRING"},
            "topik_utama": {"type": "STRING", "enum": TOPIC_IDS},
            "topik_lain": {"type": "ARRAY", "items": {"type": "STRING", "enum": TOPIC_IDS}},
            "cakupan": {"type": "STRING", "enum": ["lokal", "nasional"]},
            "ringkasan": {"type": "STRING"},
            "kata_kunci": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["id", "topik_utama", "topik_lain", "cakupan", "ringkasan", "kata_kunci"],
    },
}


def load_posts():
    accounts = json.loads((ROOT / "data/accounts.json").read_text())
    by_url = {a["url"].rstrip("/").lower(): a for a in accounts}
    raw = json.loads((ROOT / "raw/posts.json").read_text())
    out, seen = [], set()
    for p in raw:
        acc = by_url.get((p.get("inputUrl") or "").rstrip("/").lower())
        if not acc or p["shortCode"] in seen:
            continue
        seen.add(p["shortCode"])
        out.append({"id": p["shortCode"], "username": acc["username"], "kpw": acc["kpw"],
                    "caption": re.sub(r"\s+", " ", p.get("caption") or "").strip(),
                    "alt": (p.get("alt") or "")[:300]})
    return out


def classify(posts, cache, depth=0):
    todo = [p for p in posts if p["id"] not in cache]
    print(f"klasifikasi: {len(todo)} post baru, {len(posts) - len(todo)} dari cache")
    batches = [todo[i:i + 15] for i in range(0, len(todo), 15)]
    usage = collections.Counter()

    def run(batch):
        block = "\n\n".join(f"[id={p['id']}] KPw {p['kpw']} (@{p['username']})\n{p['caption'][:2500]}"
                            + (f"\n(alt gambar: {p['alt']})" if p["alt"] else "") for p in batch)
        res, u = generate_json(CLASSIFY_PROMPT.format(guide=TOPIC_GUIDE, posts=block), CLASSIFY_SCHEMA)
        return res, u

    with ThreadPoolExecutor(6) as ex:
        for res, u in ex.map(run, batches):
            usage.update({k: v for k, v in u.items() if isinstance(v, int)})
            for r in res:
                r["topik_lain"] = [t for t in dict.fromkeys(r["topik_lain"]) if t != r["topik_utama"]][:2]
                cache[r.pop("id")] = r
    print("token:", dict(usage))
    missing = [p["id"] for p in posts if p["id"] not in cache]
    if missing and depth < 3:
        print("ulang untuk", len(missing), "post yang terlewat")
        return classify(posts, cache, depth + 1)
    return cache


INSIGHT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "umum": {"type": "ARRAY", "items": {"type": "STRING"}},
        "kpw": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "username": {"type": "STRING"}, "narasi": {"type": "STRING"}}, "required": ["username", "narasi"]}},
    },
    "required": ["umum", "kpw"],
}


def insights(posts, topics):
    label = {t["id"]: t["label"] for t in TOPICS}
    eng = {}
    for p in json.loads((ROOT / "data/dashboard.json").read_text())["posts"]:
        eng[p["url"].rstrip("/").split("/")[-1]] = p["engagement"]
    lines = []
    for user in dict.fromkeys(p["username"] for p in posts):
        ps = [p for p in posts if p["username"] == user and p["id"] in eng]
        cnt = collections.Counter(topics[p["id"]]["topik_utama"] for p in ps)
        e = collections.Counter()
        for p in ps:
            e[topics[p["id"]]["topik_utama"]] += eng[p["id"]]
        lok = sum(topics[p["id"]]["cakupan"] == "lokal" for p in ps)
        lines.append(f"## @{user} (KPw {ps[0]['kpw']}), {len(ps)} post, {lok} konten lokal\n"
                     + "; ".join(f"{label[t]}: {n} post / {e[t]} engagement" for t, n in cnt.most_common())
                     + "\nContoh: " + " | ".join(topics[p["id"]]["ringkasan"] for p in sorted(ps, key=lambda x: -eng[x["id"]])[:8]))
    tot_n, tot_e = collections.Counter(), collections.Counter()
    for p in posts:
        if p["id"] in eng:
            t = topics[p["id"]]["topik_utama"]
            tot_n[t] += 1
            tot_e[t] += eng[p["id"]]
    totals = "; ".join(f"{label[t]}: {n} post, {tot_e[t]} engagement ({round(tot_e[t] / n)} per post)" for t, n in tot_n.most_common())
    prompt = (f"Berikut rekap topik unggahan Instagram {len(lines)} KPw Bank Indonesia di Pulau Jawa, 12 Okt-12 Nov 2026. "
              "Engagement = likes + komentar. Semua angka berdasarkan topik utama tiap post.\n\n"
              f"TOTAL SEMUA KPw (pakai angka ini apa adanya, jangan menjumlah ulang): {totals}\n\n" + "\n\n".join(lines) +
              "\n\nSebut kantor sebagai 'KPw <nama>' (bukan kantor cabang)." +
              "\n\nTulis dalam Bahasa Indonesia yang lugas, tanpa kata berlebihan, tanpa tanda pisah panjang:\n"
              "- umum: 4 temuan lintas KPw (masing-masing 1 kalimat, sebut angka), misalnya topik yang paling sering vs paling tinggi engagement-nya, "
              "dan KPw mana yang paling banyak mengangkat isu lokal.\n"
              "- kpw: untuk setiap akun, narasi 2 kalimat: fokus topik utamanya (dengan jumlah post) dan satu ciri khas/contoh program.")
    res, _ = generate_json(prompt, INSIGHT_SCHEMA, 8000)
    return res


def embed(posts, topics):
    label = {t["id"]: t["label"] for t in TOPICS}
    texts = []
    for p in posts:
        t = topics[p["id"]]
        texts.append(f"KPw {p['kpw']}. Topik: {label[t['topik_utama']]}"
                     + "".join(f", {label[x]}" for x in t["topik_lain"])
                     + f". {t['ringkasan']} Kata kunci: {', '.join(t['kata_kunci'])}.\n{p['caption'][:1800]}")
    vecs = []
    for i in range(0, len(texts), 100):
        body = {"requests": [{"model": f"models/{EMB_MODEL}", "content": {"parts": [{"text": x}]},
                              "taskType": "RETRIEVAL_DOCUMENT", "outputDimensionality": EMB_DIM} for x in texts[i:i + 100]]}
        r = call(EMB_MODEL, "batchEmbedContents", body)
        for e in r["embeddings"]:
            v = e["values"]
            n = math.sqrt(sum(x * x for x in v)) or 1
            vecs.append([round(x / n, 4) for x in v])
    return vecs


def main():
    posts = load_posts()
    tpath = ROOT / "data/topics.json"
    cache = json.loads(tpath.read_text()) if tpath.exists() else {}
    cache = classify(posts, cache)
    tpath.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
    c = collections.Counter(cache[p["id"]]["topik_utama"] for p in posts)
    print("topik utama:", c.most_common())

    if "--no-insight" not in sys.argv:
        ins = insights(posts, cache)
        (ROOT / "data/insights.json").write_text(json.dumps(ins, ensure_ascii=False, indent=1))
        print("insight:", ins["umum"])

    (ROOT / "api").mkdir(exist_ok=True)
    (ROOT / "api/_posts.json").write_text(json.dumps({p["id"]: {
        "kpw": p["kpw"], "r": cache[p["id"]]["ringkasan"], "k": cache[p["id"]]["kata_kunci"],
        "c": p["caption"][:500]} for p in posts}, ensure_ascii=False, separators=(",", ":")))

    if "--no-embed" not in sys.argv:
        vecs = embed(posts, cache)
        (ROOT / "api").mkdir(exist_ok=True)
        (ROOT / "api/_vectors.json").write_text(json.dumps(
            {"model": EMB_MODEL, "dim": EMB_DIM, "ids": [p["id"] for p in posts], "v": vecs}, separators=(",", ":")))
        print("embedding:", len(vecs), "x", EMB_DIM)


if __name__ == "__main__":
    main()
