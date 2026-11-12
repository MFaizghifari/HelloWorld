# PoC: Engagement Sosmed KPw BI (Jawa Barat & Jawa Tengah)

Proof of concept dashboard engagement Instagram 7 KPw Bank Indonesia
(Prov. Jabar, Cirebon, Tasikmalaya, Prov. Jateng, Solo, Purwokerto, Tegal),
periode 12 Okt – 12 Nov 2026. Co-brand Bank Indonesia × Belajarlagi.

Buka `dashboard/index.html` di browser (satu file, data dan logo sudah tertanam).

## Alur

```
data/accounts.json        7 akun, diambil dari bi-kpw-program-radar/accounts.json
inputs/*.json             input actor Apify
scripts/apify_run.py      jalankan actor -> raw/*.json
scripts/build_data.py     raw -> data/dashboard.json (engagement, ER, harian, format)
scripts/build_dashboard.py  template + data + logo -> dashboard/index.html
```

Jalankan ulang:

```bash
export APIFY_TOKEN=...   # tidak perlu di cloud session (token disuntik proxy)
python3 scripts/apify_run.py apify/instagram-scraper inputs/posts.json raw/posts.json
python3 scripts/apify_run.py apify/instagram-scraper inputs/details.json raw/details.json
python3 scripts/build_data.py && python3 scripts/build_dashboard.py
```

## Hasil penarikan PoC

| Item | Nilai |
|---|---|
| Unggahan | 341 |
| Biaya Apify | US$0,78 (posts) + US$0,02 (profil) ≈ **US$0,80** |
| Tarif efektif | ±US$2,3 per 1.000 unggahan |
| Proyeksi 46 KPw × 12 bulan (IG saja) | ±27 ribu unggahan ≈ US$62 |

## Definisi & batasan

- Engagement = likes + komentar. ER = rata-rata (engagement ÷ follower) per unggahan.
- Follower = angka saat penarikan data.
- Views Reels tidak dikembalikan oleh actor saat ini (semua 0), jadi tidak dihitung.
- Reach, impressions, saves, shares hanya tersedia lewat API resmi (akses akun).
- Logo BI diambil dari bi.go.id; logo Belajarlagi dari aset brand Belajarlagi.

**Link publik (Vercel):** https://bi-kpw-engagement-poc.vercel.app

## Analisis topik & pencarian (AI layer, Gemini)

- `scripts/taxonomy.py` berisi 12 topik yang mengikuti bidang tugas BI. Ubah di sini, hapus `data/topics.json`, lalu jalankan ulang.
- `scripts/build_topics.py` (perlu `GEMINI_API_KEY` di env atau `poc/.env.local`):
  - klasifikasi setiap post (topik utama, topik yang ikut dibahas, lokal/nasional, ringkasan) → `data/topics.json` (di-cache per post)
  - ringkasan AI per KPw → `data/insights.json`
  - embedding caption → `api/_vectors.json`, `api/_posts.json`
- `api/search.js` (Vercel Function, env `GEMINI_API_KEY`): embedding query → 60 kandidat → Gemini menilai utama/menyinggung → jawaban singkat. Kalau API tidak terjangkau, dashboard beralih ke pencarian kata kunci.
- Biaya: ±US$0,30 sekali proses untuk 341 post; ±US$0,01–0,02 per pencarian baru (di-cache di CDN 1 hari).

Urutan build lengkap: `build_data.py` → `build_topics.py` → `build_data.py` → `build_dashboard.py`, lalu `vercel deploy --prod` dari `poc/`.
