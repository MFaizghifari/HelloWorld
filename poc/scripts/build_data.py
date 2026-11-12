#!/usr/bin/env python3
"""Turn raw Apify output into the dashboard dataset (data/dashboard.json).

Engagement = likes + comments (public metrics). Reel views are reported
separately because only video posts have them.
Engagement rate (ER) per post = engagement / account followers at scrape time.
Posts are attributed to the KPw profile they were scraped from (inputUrl), so
collab posts that appear on a KPw's grid count for that KPw.
"""
import json
import collections
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIB = timezone(timedelta(hours=7))
FORMAT = {"clips": "Reels", "carousel_container": "Carousel", "feed": "Foto"}

accounts = json.loads((ROOT / "data/accounts.json").read_text())
SHORT = {"Provinsi Jawa Barat": "Prov. Jabar", "Provinsi Jawa Tengah": "Prov. Jateng"}
for a in accounts:
    a["kpw_pendek"] = SHORT.get(a["kpw"], a["kpw_pendek"])
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
    caption = (p.get("caption") or "").strip().replace("\n", " ")
    posts.append({
        "kpw": acc["kpw_pendek"],
        "provinsi": acc["provinsi"],
        "username": acc["username"],
        "date": ts.strftime("%Y-%m-%d"),
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
daily = {prov: collections.Counter() for prov in ("Jawa Barat", "Jawa Tengah")}
for p in posts:
    daily[p["provinsi"]][p["date"]] += p["engagement"]

fmt = collections.defaultdict(lambda: {"posts": 0, "engagement": 0})
for p in posts:
    fmt[p["format"]]["posts"] += 1
    fmt[p["format"]]["engagement"] += p["engagement"]

out = {
    "generated": datetime.now(WIB).strftime("%Y-%m-%d %H:%M WIB"),
    "period": {"start": PERIOD_START.strftime("%Y-%m-%d"), "end": PERIOD_END.strftime("%Y-%m-%d")},
    "summary": summary,
    "daily": {"days": days, **{k: [v[x] for x in days] for k, v in daily.items()}},
    "formats": [{"format": k, **v, "eng_per_post": round(v["engagement"] / v["posts"], 1)} for k, v in fmt.items()],
    "posts": sorted(posts, key=lambda p: -p["engagement"]),
}
(ROOT / "data/dashboard.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(f"{len(posts)} posts, {sum(s['engagement'] for s in summary):,} engagement")
for s in summary:
    print(s["kpw"], s["posts"], s["engagement"], s["eng_per_post"], s["er_avg"])
print(out["formats"])
