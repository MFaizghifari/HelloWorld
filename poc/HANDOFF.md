# Handoff: PoC Dashboard Engagement Sosmed KPw BI (Jabar & Jateng)

> Untuk sesi baru: baca seluruh file ini dulu. **Tujuan berikutnya: deploy dashboard ke Vercel** supaya ada
> link publik untuk klien. Balas user dalam Bahasa Indonesia (user menulis campuran Indonesia/Inggris).
> User suka jawaban berbasis data dan menyebut sumber.

## 1. Konteks project

- **Klien:** TRPI, Bank Indonesia. **Pelaksana:** Belajarlagi (co-brand Bank Indonesia × Belajarlagi).
- **Apa ini:** proof of concept untuk memantau engagement Instagram kantor perwakilan (KPw) BI. Kalau disetujui,
  cakupannya bisa diperluas ke semua 46 KPw, ditarik rutin.
- **Cakupan PoC:** 7 akun Instagram KPw di Jawa Barat & Jawa Tengah, periode **12 Okt – 12 Nov 2026**.
- **Repo/branch:** `MFaizghifari/HelloWorld`, branch **`claude/festive-cray-25fqdn`**. Semua kerja ada di folder `poc/`.
  Commit di branch ini dan push ke sana. Jangan buat PR kecuali diminta.
- **Repo terkait:** `MFaizghifari/bi-kpw-program-radar` (privat). Daftar akun (`accounts.json`) diambil dari sana.
  Repo itu tersambung ke Vercel (https://bi-kpw-radar.vercel.app), lihat bagian 6.

## 2. Hasil PoC (sumber: `poc/data/dashboard.json`, ditarik 2026-11-12 10:02 WIB via Apify `apify/instagram-scraper`)

| KPw | Akun | Follower | Post | Engagement | Eng/post | ER rata-rata |
|---|---|---:|---:|---:|---:|---:|
| Prov. Jabar | bank_indonesia_jabar | 80.616 | 56 | 40.155 | 717,1 | 0,889% |
| Cirebon | bank_indonesia_cirebon | 33.755 | 43 | 4.974 | 115,7 | 0,343% |
| Tasikmalaya | bankindonesia_tasikmalaya | 20.138 | 52 | 3.518 | 67,7 | 0,336% |
| Prov. Jateng | bank_indonesia_jateng | 73.366 | 60 | 7.458 | 124,3 | 0,169% |
| Solo | bank_indonesia_solo | 34.725 | 32 | 2.316 | 72,4 | 0,208% |
| Purwokerto | bank_indonesia_purwokerto | 44.124 | 60 | 8.075 | 134,6 | 0,305% |
| Tegal | bank_indonesia_tegal | 28.408 | 38 | 8.494 | 223,5 | 0,787% |
| **Total** | | | **341** | **74.990** | | |

Per format: Carousel 127 post / 42.260 eng (332,8 per post), Foto 38 / 7.034 (185,1), Reels 176 / 25.696 (146,0).

**Biaya Apify:** ±US$0,80 (posts US$0,78 + profil US$0,02), sekitar US$2,3 per 1.000 post.
Proyeksi 46 KPw × 12 bulan (IG saja): ±27 ribu post ≈ US$62.

**Definisi & batasan:**
- Engagement = likes + komentar.
- ER = rata-rata (engagement ÷ follower) per post.
- Follower memakai angka saat data ditarik.
- Views Reels selalu 0 dari actor, jadi tidak dihitung.
- Reach, impressions, saves, dan shares hanya tersedia lewat API resmi (butuh akses akun).
- Post kolaborasi ditandai `collab`. Jabar berisi 1 post viral QRIS (13.284 eng) yang mengangkat angka totalnya.

## 3. Struktur file (`poc/`)

```
README.md                  ringkasan project + cara jalankan ulang
HANDOFF.md                 file ini
data/accounts.json         7 akun (provinsi, kpw, username, url)
inputs/posts.json          input Apify: resultsType posts, onlyPostsNewerThan 2026-10-12, limit 200/akun
inputs/details.json        input Apify: resultsType details (follower)
raw/posts.json, details.json   output mentah Apify (±5 MB)
scripts/apify_run.py       jalankan actor -> raw/*.json (token: proxy di cloud, APIFY_TOKEN lokal)
scripts/build_data.py      raw -> data/dashboard.json (summary, daily, formats, posts)
scripts/build_dashboard.py template + data + logo (base64) -> dashboard/index.html
dashboard/template.html    template HTML/CSS/JS dashboard
dashboard/index.html       HASIL: satu file statis berdiri sendiri (±330 KB)
brand/                     logo BI (bi.go.id) dan Belajarlagi, versi warna & putih
```

Jalankan ulang dari `poc/`:

```bash
python3 scripts/apify_run.py apify/instagram-scraper inputs/posts.json raw/posts.json
python3 scripts/apify_run.py apify/instagram-scraper inputs/details.json raw/details.json
python3 scripts/build_data.py && python3 scripts/build_dashboard.py
```

## 4. Dashboard (`poc/dashboard/index.html`)

- Hero dengan KPI, lalu bagian: Total engagement per KPw (bar), Engagement harian (line),
  Rekap per KPw (tabel), Engagement per format konten, 10 post dengan engagement tertinggi, dan Catatan metodologi.
- Teknologi: HTML statis; Chart.js 4.4.1 dari cdnjs; font Plus Jakarta Sans dari Google Fonts;
  data dan logo tertanam. **Tidak ada build step**, jadi bisa langsung di-host statis.
- Sudah dipublish sebagai artifact privat claude.ai: https://claude.ai/artifact/Kj5VidLtCEtzhJCv8a5yQk
  User tetap mau link Vercel untuk dikirim ke klien.

## 5. Environment cloud

- Environment personal **"HelloWorld"**:
  - Network secrets: token Apify (`api.apify.com`, disuntik proxy, tidak ada env var) dan
    **"Vercel token"** (`api.vercel.com`, lihat bagian 6).
  - Allowed host tambahan: `www.bi.go.id`. Package registry (npm/PyPI) bisa diakses.
- Playwright + Chromium sudah terpasang (`require('playwright')`). Jangan install ulang.
- Tidak ada connector Vercel. Composio hanya tersambung ke apify, googledrive, dan googleslides.

## 6. Tugas berikutnya: deploy ke Vercel

### Status token (blocker di sesi sebelumnya)
- Token Vercel disimpan user lewat form network secret, **tapi belum jalan**. Request ke
  `https://api.vercel.com/v2/user` tetap `403 "The request is missing an authentication token"`, walaupun sudah dicoba ulang selama lebih dari 5 menit.
- Dugaan penyebab: di `get_environment`, secret Apify punya `header_names: ["Authorization"]`, sedangkan secret
  Vercel tidak punya header sama sekali.
- **Perbaikan oleh user:** menu environment → HelloWorld → Edit → Network secrets → Vercel token →
  header `Authorization`, prefix `Bearer`, lalu simpan. Jangan pernah minta token ditempel di chat.

Cek token (proxy menimpa header-nya, nilai placeholder tidak masalah):
```bash
curl -sS https://api.vercel.com/v2/user -H "Authorization: Bearer proxy-injected" | head -c 300
```
Kalau masih 403: cek `get_environment`, lalu minta user memperbaiki secret, atau panggil `request_credential` untuk host `api.vercel.com`.

### Opsi A (utama): project Vercel terpisah
```bash
cd poc
printf '{ "outputDirectory": "dashboard", "cleanUrls": true }\n' > vercel.json
npx --yes vercel@latest deploy --prod --yes --token proxy-injected --name bi-kpw-engagement-poc
```
- Kalau ditanya scope: `curl -sS https://api.vercel.com/v2/teams -H "Authorization: Bearer proxy-injected"`, lalu tambahkan `--scope <slug>`.
- Kalau `--name` ditolak: jalankan `vercel link --yes --project bi-kpw-engagement-poc --token proxy-injected` dulu.
- Tambahkan `.vercel/` ke `.gitignore`. `vercel.json` di-commit.
- Perkiraan URL: `https://bi-kpw-engagement-poc.vercel.app`. Pastikan Deployment Protection production mati
  supaya klien bisa membuka tanpa login.

### Opsi B (cadangan, tanpa token): numpang repo radar
- `bi-kpw-program-radar` memakai Git integration Vercel: setiap push ke default branch me-redeploy
  https://bi-kpw-radar.vercel.app (`vercel.json`: `outputDirectory: "dashboard"`).
- Pasang dengan `add_repo` (access `push`), salin `poc/dashboard/index.html` ke `dashboard/engagement/index.html`,
  lalu push → https://bi-kpw-radar.vercel.app/engagement/
- **Wajib dapat izin eksplisit user** untuk push ke default branch repo itu. Peta radar jangan diubah.

### Setelah deploy
1. Buka URL dengan Playwright: pastikan judul dan chart muncul, dan tidak ada error console.
2. Commit perubahan (`poc/vercel.json`, `.gitignore`) ke `claude/festive-cray-25fqdn`, lalu push.
3. Kirim link ke user. Opsional: tambahkan link Vercel ke `poc/README.md`.

## 7. Ide lanjutan (belum dikerjakan, tunggu arahan user)
- Perluas ke 46 KPw dan platform lain (TikTok, X, YouTube).
- Jadwalkan penarikan rutin (mingguan), mirip `.github/workflows/weekly.yml` di repo radar.
- Metrik reach, impressions, dan saves lewat Meta Graph API (butuh akses akun dari BI).
