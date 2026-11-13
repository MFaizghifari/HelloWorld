#!/usr/bin/env python3
"""Public-comment analysis: classify the latest comments Apify returns per post (up to ~12/post).

Writes data/comments.json:
  items:   per comment {id, post, username(kpw), kategori, sentimen, isu, perlu_respons, text}
  issues:  recurring issues across KPw (Gemini clusters; counts computed here from member ids)
Cached per comment id in data/comments_cache.json.
"""
import json, re, sys, collections
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from gemini import generate_json  # noqa: E402

KATEGORI = ["pertanyaan", "keluhan", "saran_permintaan", "apresiasi", "partisipasi_kuis", "spam_promosi", "lainnya"]
SENTIMEN = ["positif", "netral", "negatif"]

PROMPT = """Kamu analis social listening Bank Indonesia. Klasifikasikan komentar publik di unggahan Instagram kantor perwakilan (KPw) BI.

Kategori (pilih satu):
- pertanyaan: menanyakan informasi (jadwal penukaran uang, cara daftar, syarat, lokasi, dll).
- keluhan: mengeluhkan layanan, kebijakan, harga, penipuan yang dialami, atau masalah lain.
- saran_permintaan: usul atau permintaan (minta diadakan di daerahnya, minta info lanjutan).
- apresiasi: pujian, dukungan, terima kasih.
- partisipasi_kuis: menjawab kuis/giveaway, menandai teman, "ikut", "done".
- spam_promosi: promosi pihak lain, judi online, investasi bodong, akun bot, teks tidak relevan.
- lainnya: emoji saja, sapaan, atau tidak masuk kategori lain.

Juga isi:
- sentimen: positif / netral / negatif terhadap BI atau topik unggahan.
- isu: 2-6 kata yang menyebut pokok persoalannya (mis. "jadwal penukaran uang baru", "QRIS ditolak merchant"). Kosongkan untuk apresiasi umum, kuis, spam, dan lainnya.
- perlu_respons: true bila komentar sebaiknya dijawab admin (pertanyaan nyata, keluhan, laporan penipuan).

Komentar:
{items}"""

SCHEMA = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "id": {"type": "STRING"},
    "kategori": {"type": "STRING", "enum": KATEGORI},
    "sentimen": {"type": "STRING", "enum": SENTIMEN},
    "isu": {"type": "STRING"},
    "perlu_respons": {"type": "BOOLEAN"},
}, "required": ["id", "kategori", "sentimen", "isu", "perlu_respons"]}}

CLUSTER_SCHEMA = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "isu": {"type": "STRING"}, "penjelasan": {"type": "STRING"},
    "ids": {"type": "ARRAY", "items": {"type": "STRING"}},
}, "required": ["isu", "penjelasan", "ids"]}}


def main():
    accounts = {a["url"].rstrip("/").lower(): a for a in json.loads((ROOT / "data/accounts.json").read_text())}
    dash = {p["id"]: p for p in json.loads((ROOT / "data/dashboard.json").read_text())["posts"]}
    raw = json.loads((ROOT / "raw/posts.json").read_text())
    comments, seen = [], set()
    for p in raw:
        acc = accounts.get((p.get("inputUrl") or "").rstrip("/").lower())
        if not acc or p["shortCode"] not in dash:
            continue
        for c in p.get("latestComments") or []:
            text = re.sub(r"\s+", " ", c.get("text") or "").strip()
            if not text or c["id"] in seen or c.get("ownerUsername") == acc["username"]:
                continue
            seen.add(c["id"])
            comments.append({"id": c["id"], "post": p["shortCode"], "username": acc["username"],
                             "text": text[:400], "likes": c.get("likesCount") or 0, "ts": c.get("timestamp")})
    cpath = ROOT / "data/comments_cache.json"
    cache = json.loads(cpath.read_text()) if cpath.exists() else {}
    todo = [c for c in comments if c["id"] not in cache]
    print(f"{len(comments)} komentar, {len(todo)} perlu diklasifikasi")

    def run(batch):
        block = "\n".join(f"[id={c['id']}] (unggahan: {dash[c['post']]['ringkasan'][:120]}) {c['text']}" for c in batch)
        res, _ = generate_json(PROMPT.format(items=block), SCHEMA)
        return res

    for _ in range(3):
        todo = [c for c in comments if c["id"] not in cache]
        if not todo:
            break
        with ThreadPoolExecutor(6) as ex:
            for res in ex.map(run, [todo[i:i + 40] for i in range(0, len(todo), 40)]):
                for r in res:
                    cache[r.pop("id")] = r
        cpath.write_text(json.dumps(cache, ensure_ascii=False))

    items = [{**c, **cache[c["id"]]} for c in comments if c["id"] in cache]
    print(collections.Counter(i["kategori"] for i in items).most_common())

    # recurring issues: cluster the substantive comments
    subs = [i for i in items if i["isu"] and i["kategori"] in ("pertanyaan", "keluhan", "saran_permintaan")]
    issues = []
    if subs:
        block = "\n".join(f"[id={i['id']}] {i['kategori']}: {i['isu']} | {i['text'][:160]}" for i in subs)
        res, _ = generate_json(
            "Kelompokkan komentar publik berikut (pertanyaan/keluhan/saran di Instagram KPw Bank Indonesia) menjadi "
            "maksimal 10 isu yang berulang. Setiap isu: nama singkat (2-6 kata, Bahasa Indonesia), penjelasan 1 kalimat "
            "tentang apa yang ditanyakan/dikeluhkan publik, dan daftar id komentar anggotanya. Satu komentar hanya masuk "
            "satu isu. Komentar yang tidak cocok dengan isu mana pun boleh ditinggalkan.\n\n" + block, CLUSTER_SCHEMA)
        valid = {i["id"] for i in subs}
        for r in res:
            ids = [x for x in dict.fromkeys(r["ids"]) if x in valid]
            if ids:
                issues.append({"isu": r["isu"], "penjelasan": r["penjelasan"], "ids": ids})
        issues.sort(key=lambda x: -len(x["ids"]))
    out = {"total_comments_reported": sum(dash[p]["comments"] for p in dash), "items": items, "issues": issues}
    (ROOT / "data/comments.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("isu:", [(x["isu"], len(x["ids"])) for x in issues])


if __name__ == "__main__":
    main()
