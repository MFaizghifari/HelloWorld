# Handoff: Deploy dashboard PoC ke Vercel

**Tujuan sesi baru:** deploy `poc/dashboard/index.html` ke Vercel supaya ada **link publik** untuk klien
(TRPI, Bank Indonesia). Balas user dalam Bahasa Indonesia (user menulis campuran Indonesia/Inggris).

## 1. Yang sudah ada

- Repo `MFaizghifari/HelloWorld`, branch **`claude/festive-cray-25fqdn`** (commit terakhir `b40c0fc`).
- `poc/dashboard/index.html` adalah **satu file HTML statis yang berdiri sendiri** (data dan logo base64
  sudah tertanam; Chart.js 4.4.1 dari cdnjs; font Plus Jakarta Sans dari Google Fonts). Tidak ada build step.
  - Isinya: co-brand Bank Indonesia × Belajarlagi, engagement Instagram (likes + komentar) 7 akun KPw BI
    Jabar & Jateng, 12 Okt – 12 Nov 2026, **341 post, total engagement 74.990**.
- Untuk regenerate: `poc/scripts/build_data.py` → `poc/data/dashboard.json`, lalu `poc/scripts/build_dashboard.py`
  (template `poc/dashboard/template.html`) → `index.html`. Detail ada di `poc/README.md`.
- Sudah dipublish sebagai artifact privat claude.ai: https://claude.ai/artifact/Kj5VidLtCEtzhJCv8a5yQk
  (user tetap mau Vercel).

## 2. Status token Vercel (blocker)

- Token sudah disimpan user di **Network secrets** environment cloud **"HelloWorld"**
  (nama "Vercel token", host `api.vercel.com`).
- **Tapi belum jalan.** Setiap request ke `https://api.vercel.com/v2/user` tetap dibalas
  `403 {"code":"forbidden","message":"The request is missing an authentication token"}`.
  Sudah dicoba ulang selama lebih dari 5 menit, jadi ini bukan delay proxy.
- Dugaan penyebab: `get_environment` menunjukkan secret Apify punya `header_names: ["Authorization"]`,
  sedangkan secret Vercel **tidak punya header_names** sama sekali. Header kemungkinan kosong saat disimpan.
- **Perbaikan oleh user:** menu environment di judul sesi → HelloWorld → Edit → Network secrets →
  Vercel token → set header `Authorization`, prefix `Bearer`, lalu simpan. Session baru akan memakai nilai terbaru.
  Jangan pernah minta token ditempel di chat.

Cek cepat apakah token sudah jalan (proxy menimpa header-nya, nilai placeholder tidak masalah):

```bash
curl -sS https://api.vercel.com/v2/user -H "Authorization: Bearer proxy-injected" | head -c 300
```

Kalau masih 403 missingToken: panggil `get_environment` dan pastikan secret Vercel punya header
`Authorization`. Kalau belum, minta user memperbaikinya (atau pakai `request_credential` untuk host
`api.vercel.com` dengan `header_name` kosong dan prefix `Bearer`).

## 3. Langkah deploy (Opsi utama: project Vercel terpisah)

Dari root repo:

```bash
cd poc
cat > vercel.json <<'EOF'
{ "outputDirectory": "dashboard", "cleanUrls": true }
EOF
# CLI butuh nilai token; proxy menggantinya dengan token asli
npx --yes vercel@latest deploy --prod --yes --token proxy-injected --name bi-kpw-engagement-poc
```

- Kalau CLI menanyakan scope/team: cek `curl -sS https://api.vercel.com/v2/teams -H "Authorization: Bearer proxy-injected"`
  lalu tambahkan `--scope <team-slug>`.
- Kalau `--name` ditolak (deprecated), jalankan `vercel link --yes --project bi-kpw-engagement-poc --token proxy-injected`
  dulu, baru deploy.
- Jangan commit folder `.vercel/` (tambahkan ke `.gitignore`). `vercel.json` boleh di-commit.
- Perkiraan URL: `https://bi-kpw-engagement-poc.vercel.app`. Pastikan Deployment Protection **mati**
  untuk production supaya klien bisa membuka tanpa login.

## 4. Opsi cadangan (tanpa token)

Repo privat `MFaizghifari/bi-kpw-program-radar` sudah tersambung ke Vercel lewat Git integration: setiap push
ke default branch akan me-redeploy https://bi-kpw-radar.vercel.app (`vercel.json` di sana: `outputDirectory: "dashboard"`).
- Pasang repo dengan tool `add_repo` (access `push`), salin `poc/dashboard/index.html` ke
  `dashboard/engagement/index.html`, lalu push ke default branch → https://bi-kpw-radar.vercel.app/engagement/
- **Wajib dapat izin eksplisit user** sebelum push ke default branch repo itu. Peta radar yang sudah ada jangan diubah.

## 5. Setelah deploy

1. Buka URL dengan Playwright (sudah terpasang; `require('playwright')`, `chromium.launch()`), pastikan judul
   dan chart muncul serta tidak ada error console. Screenshot untuk dicek sendiri cukup dengan deviceScaleFactor 1.
2. Commit `poc/vercel.json` (dan `.gitignore`) ke branch `claude/festive-cray-25fqdn`, lalu
   `git push -u origin claude/festive-cray-25fqdn`. Jangan buat PR kecuali diminta.
3. Kirim link ke user.

## 6. Catatan environment

- Environment cloud "HelloWorld" (personal) menyimpan token Apify (`api.apify.com`, disuntik proxy) dan
  Vercel token (lihat bagian 2). Allowed host tambahan: `www.bi.go.id`. Package registry (npm) bisa diakses.
- Tidak ada connector Vercel. Composio hanya tersambung ke apify, googledrive, dan googleslides.
