#!/usr/bin/env python3
"""National-campaign amplification tracker.

1) Gemini reads @bank_indonesia (pusat) posts in the period and names the national campaigns/policy messages.
2) Gemini matches every KPw post to one of those campaigns (or none), as "materi_sama" (repost/adapted material)
   or "kegiatan_lokal" (a local activity carrying the campaign).
Writes data/campaigns.json. Lags are computed in the dashboard from post timestamps.
"""
import json, re, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from gemini import generate_json  # noqa: E402

WIB = timezone(timedelta(hours=7))
START, END = datetime(2026, 10, 12, tzinfo=WIB), datetime(2026, 11, 12, 23, 59, tzinfo=WIB)

CAMP_SCHEMA = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "id": {"type": "STRING"}, "nama": {"type": "STRING"}, "ringkas": {"type": "STRING"},
    "jenis": {"type": "STRING", "enum": ["kebijakan", "kampanye_edukasi", "program_acara"]},
    "pusat_ids": {"type": "ARRAY", "items": {"type": "STRING"}},
}, "required": ["id", "nama", "ringkas", "jenis", "pusat_ids"]}}

MATCH_SCHEMA = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "id": {"type": "STRING"}, "kampanye": {"type": "STRING"},
    "jenis": {"type": "STRING", "enum": ["materi_sama", "kegiatan_lokal", "tidak"]},
}, "required": ["id", "kampanye", "jenis"]}}


def ts(p):
    return datetime.fromisoformat(p["timestamp"].replace("Z", "+00:00")).astimezone(WIB)


def main():
    pusat = json.loads((ROOT / "data/pusat.json").read_text())
    raw = json.loads((ROOT / "raw/posts.json").read_text())
    pposts, seen = [], set()
    for p in raw:
        if (p.get("inputUrl") or "").rstrip("/").lower() == pusat["url"].rstrip("/").lower() and p["shortCode"] not in seen:
            seen.add(p["shortCode"])
            if START <= ts(p) <= END:
                pposts.append(p)
    pposts.sort(key=ts)
    print(len(pposts), "unggahan pusat")
    block = "\n\n".join(f"[id={p['shortCode']}] {ts(p):%Y-%m-%d %H:%M}\n{re.sub(r'\s+', ' ', p.get('caption') or '')[:700]}" for p in pposts)
    camps, _ = generate_json(
        "Berikut unggahan Instagram akun pusat @bank_indonesia selama 12 Okt-12 Nov 2026. Identifikasi pesan nasional "
        "yang mungkin diamplifikasi kantor perwakilan (KPw): kebijakan (mis. hasil RDG, instrumen baru), kampanye edukasi "
        "(mis. waspada penipuan, Cinta Bangga Paham Rupiah), dan program/acara nasional (mis. ISEF, Karya Kreatif Indonesia). "
        "Gabungkan unggahan pusat yang membahas pesan yang sama. Abaikan ucapan hari besar, konten hiburan, dan pengumuman "
        "lowongan. Maksimal 20 kampanye, urut dari yang paling penting. id = slug pendek huruf kecil dengan tanda hubung. "
        "nama maksimal 6 kata. ringkas 1 kalimat.\n\n" + block, CAMP_SCHEMA, 8000)
    pmap = {p["shortCode"]: p for p in pposts}
    for c in camps:
        c["pusat_ids"] = [i for i in c["pusat_ids"] if i in pmap]
    camps = [c for c in camps if c["pusat_ids"]]
    for c in camps:
        first = min((pmap[i] for i in c["pusat_ids"]), key=ts)
        c["pusat_first"] = ts(first).isoformat()
        c["pusat_posts"] = [{"id": i, "url": pmap[i]["url"], "ts": ts(pmap[i]).isoformat(),
                             "likes": max(pmap[i].get("likesCount") or 0, 0), "comments": pmap[i].get("commentsCount") or 0}
                            for i in sorted(c["pusat_ids"], key=lambda i: ts(pmap[i]))]
        c["contoh"] = re.sub(r"\s+", " ", first.get("caption") or "")[:220]
    print("kampanye:", [c["nama"] for c in camps])

    dash = json.loads((ROOT / "data/dashboard.json").read_text())["posts"]
    clist = "\n".join(f"- {c['id']}: {c['nama']}. {c['ringkas']} (contoh caption pusat: {c['contoh'][:160]})" for c in camps)
    ids = {c["id"] for c in camps}

    def run(batch):
        b = "\n".join(f"[id={p['id']}] {p['date']} KPw {p['kpw']}: {p['ringkasan']} | {p['caption_full'][:350]}" for p in batch)
        res, _ = generate_json(
            "Cocokkan setiap unggahan KPw Bank Indonesia dengan kampanye nasional di bawah.\n"
            "- materi_sama: unggahan membagikan atau mengadaptasi materi/pesan kampanye pusat itu.\n"
            "- kegiatan_lokal: KPw menggelar atau melaporkan kegiatan di daerahnya yang merupakan bagian dari kampanye itu.\n"
            "- tidak: tidak terkait kampanye mana pun (isi kampanye dengan \"none\").\n"
            "Hanya cocokkan bila jelas membahas kampanye yang sama, bukan sekadar topik yang mirip.\n\n"
            f"Kampanye:\n{clist}\n\nUnggahan:\n{b}", MATCH_SCHEMA)
        return res

    matches = {}
    for _ in range(3):
        todo = [p for p in dash if p["id"] not in matches]
        if not todo:
            break
        with ThreadPoolExecutor(6) as ex:
            for res in ex.map(run, [todo[i:i + 25] for i in range(0, len(todo), 25)]):
                for r in res:
                    matches[r["id"]] = r
    for c in camps:
        c["kpw_posts"] = [{"id": pid, "jenis": m["jenis"]} for pid, m in matches.items()
                          if m["kampanye"] == c["id"] and m["jenis"] != "tidak"]
    camps = [c for c in camps if c["kpw_posts"] or len(c["pusat_ids"]) > 1]
    (ROOT / "data/campaigns.json").write_text(json.dumps({"pusat": pusat, "pusat_posts": len(pposts), "campaigns": camps}, ensure_ascii=False, indent=1))
    for c in camps:
        print(f"{c['nama']}: pusat {len(c['pusat_ids'])}, KPw {len(c['kpw_posts'])}")


if __name__ == "__main__":
    main()
