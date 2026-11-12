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
