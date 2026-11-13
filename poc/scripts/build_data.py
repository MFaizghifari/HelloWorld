#!/usr/bin/env python3
"""Turn raw Apify output into the dashboard dataset (data/dashboard.json).

Engagement = likes + comments (public metrics). Reel views are reported
separately because only video posts have them.
Engagement rate (ER) per post = engagement / account followers at scrape time.
Posts are attributed to the KPw profile they were scraped from (inputUrl), so
collab posts that appear on a KPw's grid count for that KPw.
"""
import json
import sys
import collections
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIB = timezone(timedelta(hours=7))
FORMAT = {"clips": "Reels", "carousel_container": "Carousel", "feed": "Foto"}

accounts = json.loads((ROOT / "data/accounts.json").read_text())
SHORT = {"Provinsi Jawa Barat": "Prov. Jabar", "Provinsi Jawa Tengah": "Prov. Jateng", "Provinsi Jawa Timur": "Prov. Jatim",
         "Provinsi DKI Jakarta": "Prov. DKI Jakarta", "Provinsi Banten": "Prov. Banten", "Provinsi DI Yogyakarta": "Prov. DIY"}
PROVINCES = ["DKI Jakarta", "Banten", "Jawa Barat", "Jawa Tengah", "DI Yogyakarta", "Jawa Timur"]
for a in accounts:
    a["kpw_pendek"] = SHORT.get(a["kpw"], a["kpw_pendek"])
sys.path.insert(0, str(ROOT / "scripts"))
from taxonomy import TOPICS  # noqa: E402
tpath = ROOT / "data/topics.json"
TOPIC_DATA = json.loads(tpath.read_text()) if tpath.exists() else {}
def load_opt(name):
    f = ROOT / "data" / name
    return json.loads(f.read_text()) if f.exists() else None


def slim_comments(c):
    """Keep every label for counting, but only ship text for comments worth reading."""
    if not c:
        return None
    keep_text = {"pertanyaan", "keluhan", "saran_permintaan", "apresiasi"}
    return {"total_comments_reported": c["total_comments_reported"], "issues": c["issues"],
            "items": [{"id": i["id"], "post": i["post"], "u": i["username"], "k": i["kategori"], "s": i["sentimen"],
                       "isu": i["isu"], "r": i["perlu_respons"], "likes": i["likes"],
                       "t": i["text"][:240] if i["kategori"] in keep_text else ""} for i in c["items"]]}


ipath = ROOT / "data/insights.json"
INSIGHTS = json.loads(ipath.read_text()) if ipath.exists() else None
posts_raw = json.loads((ROOT / "raw/posts.json").read_text())
details = {d["username"]: d for d in json.loads((ROOT / "raw/details.json").read_text())}
by_url = {a["url"].rstrip("/").lower(): a for a in accounts}

PERIOD_START = datetime(2026, 10, 12, tzinfo=WIB)
PERIOD_END = datetime(2026, 11, 12, 23, 59, tzinfo=WIB)

seen = set()
posts = []
for p in posts_raw:
    acc = by_url.get((p.get("inputUrl") or "").rstrip("/").lower())
    if not acc:
        continue
    key = (acc["username"], p["id"])
    if key in seen:
        continue
    seen.add(key)
    ts = datetime.fromisoformat(p["timestamp"].replace("Z", "+00:00")).astimezone(WIB)
    if not (PERIOD_START <= ts <= PERIOD_END):
        continue
    likes = max(p.get("likesCount") or 0, 0)
    comments = max(p.get("commentsCount") or 0, 0)
    followers = details[acc["username"]]["followersCount"]
    eng = likes + comments
    caption = " ".join((p.get("caption") or "").split())
    t = TOPIC_DATA.get(p["shortCode"], {})
    posts.append({
        "id": p["shortCode"],
        "topik": t.get("topik_utama"),
        "topik_lain": t.get("topik_lain", []),
        "cakupan": t.get("cakupan"),
        "ringkasan": t.get("ringkasan", ""),
        "kata_kunci": t.get("kata_kunci", []),
        "caption_full": caption[:600],
        "kpw": acc["kpw_pendek"],
        "provinsi": acc["provinsi"],
        "username": acc["username"],
        "date": ts.strftime("%Y-%m-%d"),
        "ts": ts.isoformat(),
        "format": FORMAT.get(p.get("productType"), p.get("type")),
        "likes": likes,
        "comments": comments,
        "views": p.get("videoViewCount") or 0,
        "engagement": eng,
        "er": round(eng / followers * 100, 3) if followers else 0,
        "collab": p.get("ownerUsername") != acc["username"],
        "url": p.get("url"),
        "caption": caption[:140],
    })

summary = []
for a in accounts:
    ps = [p for p in posts if p["username"] == a["username"]]
    d = details[a["username"]]
    eng = sum(p["engagement"] for p in ps)
    summary.append({
        "kpw": a["kpw_pendek"],
        "kpw_full": a["kpw"],
        "provinsi": a["provinsi"],
        "username": a["username"],
        "followers": d["followersCount"],
        "posts": len(ps),
        "collab_posts": sum(p["collab"] for p in ps),
        "likes": sum(p["likes"] for p in ps),
        "comments": sum(p["comments"] for p in ps),
        "views": sum(p["views"] for p in ps),
        "engagement": eng,
        "eng_per_post": round(eng / len(ps), 1) if ps else 0,
        "er_avg": round(sum(p["er"] for p in ps) / len(ps), 3) if ps else 0,
    })

days = []
d = PERIOD_START.date()
while d <= PERIOD_END.date():
    days.append(d.strftime("%Y-%m-%d"))
    d += timedelta(days=1)
PROVINCES = [x for x in PROVINCES if any(a["provinsi"] == x for a in accounts)]
daily = {prov: collections.Counter() for prov in PROVINCES}
for p in posts:
    daily[p["provinsi"]][p["date"]] += p["engagement"]

fmt = collections.defaultdict(lambda: {"posts": 0, "engagement": 0})
for p in posts:
    fmt[p["format"]]["posts"] += 1
    fmt[p["format"]]["engagement"] += p["engagement"]

out = {
    # time the Apify pull ran (apify_run.py writes it); fall back to build time
    "generated": (ROOT / "data/pulled_at.txt").read_text().strip() if (ROOT / "data/pulled_at.txt").exists() else datetime.now(WIB).strftime("%Y-%m-%d %H:%M WIB"),
    "period": {"start": PERIOD_START.strftime("%Y-%m-%d"), "end": PERIOD_END.strftime("%Y-%m-%d")},
    "summary": summary,
    "daily": {"days": days, **{k: [v[x] for x in days] for k, v in daily.items()}},
    "formats": [{"format": k, **v, "eng_per_post": round(v["engagement"] / v["posts"], 1)} for k, v in fmt.items()],
    "posts": sorted(posts, key=lambda p: -p["engagement"]),
    "provinces": PROVINCES,
    "topics": [{"id": t["id"], "label": t["label"], "desc": t["desc"]} for t in TOPICS],
    "comments": slim_comments(load_opt("comments.json")),
    "campaigns": load_opt("campaigns.json"),
    "insights": INSIGHTS,
}
(ROOT / "data/dashboard.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(f"{len(posts)} posts, {sum(s['engagement'] for s in summary):,} engagement")
for s in summary:
    print(s["kpw"], s["posts"], s["engagement"], s["eng_per_post"], s["er_avg"])
print(out["formats"])
