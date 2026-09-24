# FormFlow

Form builder bergaya Typeform: satu pertanyaan per layar, logic jump, Facebook/Meta Pixel + Conversions API, GA4/GTM, dashboard visualisasi, dengan dua pilihan backend:

| Backend | Cocok untuk | Data utama | Google Sheets |
|---|---|---|---|
| **Cloudflare Workers + D1** (disarankan) | ≥10 rb isian/bulan, iklan, blast WhatsApp | Database D1 (SQLite) | Salinan otomatis tiap 5 menit |
| Google Apps Script | Sampai ±10 rb isian/bulan, traffic stabil | Google Sheets | Langsung |

Frontend-nya statis (HTML + JS modules, tanpa build step). Di mode Cloudflare, builder, form, dan dashboard di-host oleh Worker yang sama.

```
app/                 Frontend (builder, form, dashboard, embed.js)
worker/              Backend Cloudflare Workers + D1
  src/index.js         API /api, sinkron Google Sheets (cron), Conversions API
  migrations/          Skema D1
  wrangler.toml
apps-script/         Backend alternatif Google Apps Script → Google Sheets
tests/               node --test (logic, stats, Apps Script mock, Worker di atas SQLite asli)
```

## Fitur

| Area | Isi |
|---|---|
| **Builder** | Tata letak ala Typeform: daftar pertanyaan (drag untuk urutan ulang) di kiri, kanvas WYSIWYG di tengah (klik teks untuk mengedit, ketik `@` untuk menyisipkan jawaban sebelumnya, tambah/hapus pilihan langsung), panel Pengaturan/Desain di kanan, modal "Tambah konten" berkategori, pratinjau desktop/ponsel |
| **Tampilan responden** | Satu pertanyaan per layar dengan transisi geser vertikal, nomor + panah, kotak pilihan dengan badge huruf (A/B/C, Y/N), tombol OK ✓ + "tekan Enter ↵", dropdown yang bisa dicari, bintang rating, tanggal DD/MM/YYYY, telepon dengan kode negara, navigasi ↑↓ di pojok kanan bawah |
| **Desain** | 8 tema siap pakai, 8 font, warna pertanyaan/jawaban/tombol/latar, gambar latar + kecerahan, sudut tajam/kecil/besar, rata kiri/tengah, gambar per pertanyaan (bawah teks / kiri / kanan) |
| **Tipe pertanyaan** | Teks singkat, paragraf, email, telepon, angka, pilihan ganda (single/multi, acak urutan), dropdown, ya/tidak, rating bintang, skala opini (0–10 → NPS otomatis), tanggal, pernyataan |
| **Logic** | Aturan "JIKA … MAKA lompat ke" per pertanyaan, kondisi AND/OR, 10 operator (sama dengan, mengandung, >, <, diisi, …), kondisi bisa pakai hidden field (mis. `utm_source`), default next, deteksi loop/target yang sudah dihapus |
| **Personalisasi** | Answer piping `{{id_pertanyaan}}` dan `{{hidden:utm_source}}` di judul, deskripsi, halaman terima kasih, dan URL redirect |
| **Pengalaman responden** | Keyboard-first (Enter, huruf A/B/C), progress bar yang mengikuti jalur logic, navigasi ↑↓, mobile-friendly, validasi per tipe, redirect setelah submit (mis. ke WhatsApp) |
| **Facebook Pixel** | PageView, `FormStart`, `FormStep` (opsional, per pertanyaan), event submit standar (`Lead`, `CompleteRegistration`, …) dengan `eventID` |
| **Conversions API** | Dikirim dari Apps Script dengan `event_id` yang sama → dideduplikasi oleh Meta. Email & telepon di-hash SHA-256 (telepon `08…` dinormalisasi ke `628…`), plus `fbp`, `fbc`, user agent |
| **Analytics lain** | GA4 (`form_start`, `form_step`, `generate_lead`), GTM dataLayer, UTM/fbclid/gclid otomatis tercatat |
| **Dashboard** | Views, mulai, submission, completion rate, median waktu isi, tren harian, funnel drop-off per pertanyaan, sumber traffic, distribusi jawaban, NPS, tabel jawaban, ekspor CSV |
| **Google Sheets** | Satu spreadsheet per form (tab `Responses` + `Events`), bisa otomatis dibagikan ke email tim, kolom tetap sinkron walau pertanyaan diganti judul/urutan |
| **Integrasi** | Webhook (Make/Zapier/n8n/CRM), email notifikasi |
| **Pemulihan jawaban** | Simpan jawaban yang belum selesai setelah kontak terisi, lanjutkan dari pertanyaan terakhir, event Pixel `FormContact` untuk retargeting, daftar "Belum selesai" dengan tombol WA |
| **Keamanan** | Admin key untuk builder/dashboard, pencegahan formula injection di Sheets & CSV, honeypot anti-bot, ID Pixel/GA4/GTM divalidasi ketat sebelum dipasang, semua teks form dirender via `textContent` (tanpa `innerHTML`) |

## Coba lokal (5 menit, tanpa Google)

```bash
npm start            # atau: python3 -m http.server 8080 -d app
# buka http://localhost:8080
```

Atau jalankan lengkap dengan backend Cloudflare lokal (workerd + D1 di mesin Anda):

```bash
cd worker && npm install
echo 'ADMIN_KEY="dev"' > .dev.vars
npm run db:migrate:local && npm run dev   # buka http://localhost:8787
```

Mode default **"Lokal (demo)"** menyimpan semua di browser Anda: cocok untuk mendesain form & melihat dashboard, tapi link-nya tidak bisa dibagikan ke orang lain.

## Deploy produksi: Cloudflare Workers + D1 (disarankan)

Butuh akun Cloudflare (gratis) dan Node.js 20+.

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create formflow --location apac   # salin database_id ke wrangler.toml
npm run db:migrate                                # buat tabel di D1
npx wrangler secret put ADMIN_KEY                 # kunci untuk builder & dashboard
npm run deploy                                    # → https://formflow.<akun>.workers.dev
```

Buka URL itu, klik **Pengaturan**, lalu isi admin key. Backend "Cloudflare D1" sudah terpilih otomatis. Custom domain (mis. `form.belajarlagi.id`) bisa ditambahkan di dashboard Cloudflare → Workers → Settings → Domains.

**Secret opsional** (`npx wrangler secret put NAMA`):

| Secret | Fungsi |
|---|---|
| `FB_CAPI_TOKEN` | Access token Meta Conversions API. Di Worker, IP pengunjung ikut dikirim (`client_ip_address`) sehingga kualitas pencocokan lebih baik dibanding Apps Script |
| `FB_TEST_EVENT_CODE` | Supaya event muncul di Events Manager → *Test events* |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` | Untuk salinan ke Google Sheets (lihat di bawah) |

### Salinan ke Google Sheets

1. Google Cloud Console → buat project → aktifkan **Google Sheets API** → buat **Service Account** → Keys → *Add key* → JSON.
2. Simpan `client_email` dan `private_key` dari file JSON itu sebagai secret `GOOGLE_SERVICE_ACCOUNT_EMAIL` dan `GOOGLE_PRIVATE_KEY`.
3. Per form: buat Google Sheet kosong, **Share** ke email service account sebagai Editor, lalu tempel link-nya di builder → *Tracking & Integrasi* → *Salinan ke Google Sheets*.

Cron Worker berjalan tiap 5 menit dan mengirim sampai 500 baris per form per putaran lewat `values:append`. Nilai ditulis dengan `valueInputOption=RAW`, jadi jawaban seperti `=IMPORTXML(...)` tidak pernah dieksekusi sebagai rumus. Kalau gagal (mis. Sheet belum di-share), baris tetap di D1, dicoba lagi di putaran berikutnya, dan status error-nya tampil di dashboard. D1 tetap jadi sumber data utama. Kalau Sheet sudah terlalu besar, cukup ganti link ke Sheet baru, dan jawaban berikutnya akan masuk ke sana.

### Arsitektur

```
Form (browser) ──POST /api──▶ Worker ──▶ D1: responses (mentah)
                                  │         daily / funnel / answer_counts (agregat)
                                  ├─ waitUntil ─▶ Meta Conversions API, webhook
Dashboard ──getResults──▶ Worker ──▶ baca tabel agregat (bukan ribuan baris mentah)
Cron */5 menit ──▶ Worker ──▶ Google Sheets (values:append, RAW)
```

- **Dashboard tidak memindai data mentah.** Setiap event memperbarui penghitung harian (views, starts, completions, funnel per pertanyaan, distribusi jawaban). Waktu muat dashboard hampir tidak bertambah seiring jumlah isian. Pada uji lokal: 40–54 ms. Ekspor CSV mengambil data mentah per halaman 2.000 baris.
- **Tidak ada hitungan ganda.** Satu submit per sesi (unique index), dan event funnel hanya menghitung pertanyaan yang baru dicapai. Browser mengulang submit otomatis (1 s, 2 s, 4 s) ketika jaringan putus atau server sibuk tanpa membuat baris duplikat.
- **Respons tidak menunggu pihak ketiga.** Conversions API dan webhook dijalankan setelah respons terkirim (`ctx.waitUntil`).
- **Rate limit per IP:** 300 request/menit untuk submit dan 300 untuk event. Sengaja longgar karena satu kelas workshop atau kantor sering memakai satu IP. Pada batas 100/menit, uji beban dengan 200 orang dari satu IP membuat 410 dari 600 request ditolak.
- **Zona waktu dashboard:** `TZ_OFFSET_MINUTES` di `wrangler.toml` (default 420 = WIB).

## Deploy alternatif: Google Apps Script (Sheets langsung)

1. **Buat project Apps Script**: buka <https://script.google.com> → New project. Salin isi `apps-script/Code.gs`. Di *Project Settings* centang "Show appsscript.json", lalu salin `apps-script/appsscript.json`.
2. **Jalankan `setup()`** sekali dari editor (izinkan akses). Log akan menampilkan `ADMIN_KEY` dan link spreadsheet registry.
3. **Deploy** → New deployment → *Web app* → Execute as: **Me**, Who has access: **Anyone** → salin URL `…/exec`.
4. **Host folder `app/`** (mis. GitHub Pages: Settings → Pages → folder). Opsional: isi `sheetsUrl` di `app/js/config.js`.
5. Buka builder → **Pengaturan** → pilih Google Sheets, tempel URL Web App & `ADMIN_KEY` → Simpan form. Spreadsheet jawaban dibuat otomatis, link-nya ada di tab **Bagikan** dan tombol **Buka Google Sheet** di dashboard.

Script Properties opsional:

| Property | Fungsi |
|---|---|
| `FB_CAPI_TOKEN` | Access token Conversions API (Events Manager → Settings → Generate access token) |
| `FB_TEST_EVENT_CODE` | Supaya event CAPI muncul di tab *Test events* saat uji coba |
| `FB_GRAPH_VERSION` | Default `v23.0` |
| `DRIVE_FOLDER_ID` | Folder Drive tempat spreadsheet form dibuat |

> Setiap kali `Code.gs` diubah, buat **versi deployment baru** (Manage deployments → Edit → New version) agar URL yang sama memakai kode terbaru.

## Pemulihan jawaban yang belum selesai

Menurut benchmark Zuko, rata-rata **1 dari 3 orang yang mulai mengisi form berhenti di tengah** (66% starter → selesai), dan kolom **email (6,4%) dan telepon (6,3%)** termasuk yang paling sering jadi titik berhenti ([Zuko](https://www.zuko.io/blog/8-surprising-insights-from-zukos-benchmarking-data)). Ada tiga fitur untuk menyelamatkan mereka, dan semuanya diatur di tab **Integrasi → Pemulihan jawaban yang belum selesai**:

| Fitur | Cara kerja |
|---|---|
| **Simpan jawaban yang belum selesai** (aktif untuk form baru) | Begitu email atau nomor telepon yang valid terisi, jawaban sejauh itu disimpan di server, lalu diperbarui saat responden meninggalkan halaman. Muncul di tab **Hasil → Belum selesai** (nama, kontak, pertanyaan tempat berhenti, sumber, tombol **Chat WA**, ekspor CSV). Disimpan di tabel D1 `partials`, di tab *Belum selesai* Google Sheet (Apps Script), atau di browser (mode lokal) |
| **Lanjutkan dari pertanyaan terakhir** (nonaktif default) | Progres disimpan di browser responden selama 7 hari. Saat kembali, muncul layar "Selamat datang kembali, Faiz! Lanjutkan?". Sesi yang sama dilanjutkan, jadi funnel tetap menghitung 1 pengunjung. Jangan diaktifkan untuk form yang diisi di komputer bersama |
| **Event Pixel `FormContact`** | Terkirim saat kontak pertama kali terisi, sebagai dasar audiens retargeting *FormContact tanpa Lead*. Langkah pembuatan audiensnya ada di tab Integrasi |

**Privasi (UU PDP, UU 27/2022):** kalimat persetujuan tampil di bawah kolom email/telepon dan bisa diedit. Data belum selesai **dihapus begitu orang yang sama submit** (jawaban lengkap menggantikannya) dan **dihapus otomatis setelah 30 hari**: di Cloudflare lewat cron, di Apps Script lewat `pruneOldEvents()`. Server hanya menyimpan pertanyaan milik form itu dengan format valid, dan hanya jika form mengaktifkan fiturnya. Pengaturan dari browser tidak bisa memaksanya.

**Biaya tambahan:** satu request per pengunjung yang mengisi kontak (event `partial`). Event `abandon` yang sudah ada ikut membawa jawaban, jadi tidak ada request tambahan untuk itu. Tiap event menulis 1 baris `partials` (upsert per sesi).

**Deployment yang sudah berjalan:** jalankan `npm run db:migrate` di folder `worker/` untuk membuat tabel `partials` (`migrations/0002_partials.sql`), lalu `npm run deploy`.

## Embed di website

Tab **Bagikan** menghasilkan 3 snippet. Disarankan memakai `embed.js`:

```html
<div data-formflow-inline="https://…/form.html?id=f_xxx" style="height:600px"></div>
<script src="https://…/embed.js" async></script>
```

Kenapa tidak iframe polos saja? Safari (ITP) dan Chrome membatasi cookie pihak ketiga di iframe, sehingga Pixel di dalam iframe sering kehilangan `_fbp`/`_fbc`. `embed.js`:
- meneruskan UTM/fbclid dari URL halaman Anda ke form,
- mengirim cookie `_fbp`/`_fbc` first-party ke form (untuk matching CAPI),
- jika halaman Anda sudah punya Pixel, event form ditembakkan dari Pixel halaman Anda dan Pixel di iframe dimatikan (tidak dobel hitung),
- memancarkan event DOM `formflow:Lead`, `formflow:FormStart`, dst. untuk kebutuhan custom.

## Kapasitas: 30.000 isian/bulan

**Asumsi:** completion rate 30% → ±100.000 pengunjung/bulan. Tiap pengunjung memicu ±3 request API (view, start, submit/abandon) ditambah 1 request `formflow-config.js`.

### Cloudflare Workers + D1

| Ukuran | Kebutuhan 30 rb/bulan | Batas paket gratis | Workers Paid (US$5/bulan) |
|---|---|---|---|
| Request Worker | ±400 rb/bulan ≈ 13 rb/hari | 100 rb/hari | 10 jt/bulan termasuk |
| Baris ditulis D1 | ±1,5 jt/bulan ≈ 50 rb/hari¹ | 100 rb/hari | 50 jt/bulan termasuk |
| Baris dibaca D1 | dashboard membaca tabel agregat, kecil | 5 jt/hari | 25 miliar/bulan termasuk |
| Penyimpanan D1 | ±1–2 KB per isian → ±50 MB/tahun | 5 GB | 5 GB termasuk, lalu berbayar |

¹ Diukur, bukan ditebak: dengan form 8 pertanyaan, **±35 baris ditulis per pengunjung yang submit** (termasuk index) dan **±6,5 per pengunjung yang tidak submit**. 30.000 × 35 + 70.000 × 6,5 ≈ 1,5 jt.

**Rekomendasi: pakai Workers Paid (US$5/bulan).** Paket gratis memang muat untuk rata-rata harian, tetapi sisanya hanya ±2×. Hari kampanye dengan traffic 3× rata-rata (±150 rb baris ditulis) akan melewati batas harian 100 rb, dan saat itu penulisan ke D1 ditolak sampai kuota reset. Paket berbayar menghilangkan risiko itu dan masih menyisakan ±30× ruang.

**Uji beban lokal** (`wrangler dev` + workerd + D1 lokal, satu mesin sandbox; ini batas bawah, bukan angka produksi):

| Skenario | Request | Sukses | Submit p50 / p95 | Konsistensi data |
|---|---|---|---|---|
| 500 orang masuk dalam 10 detik | 1.500 | 100% | 719 / 1.586 ms | views = starts = submit = 500 |
| 1.000 orang dalam 10 detik | 3.000 | 78% (proxy dev lokal jenuh di ±100 req/detik) | – | submit = baris = funnel = 789, tanpa hitungan ganda |

Sebagai pembanding, blast WhatsApp ke 5.000 orang yang semuanya membuka dalam 10 menit menghasilkan ±25 request/detik. D1 memproses query satu per satu per database. Menurut [dokumentasi limit D1](https://developers.cloudflare.com/d1/platform/limits/), query 1 ms berarti ±1.000 query/detik. Satu submit di sini ±10 query, jadi perkiraannya ±100 submit/detik per database.

Sumber harga dan limit: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). Angka di atas ditulis per September 2026 berdasarkan dokumentasi tersebut, jadi cek ulang sebelum memutuskan paket.

### Google Apps Script (untuk perbandingan)

Di 30 rb/bulan, Apps Script mulai bermasalah. Sheet per form penuh (10 jt sel) dalam ±6–7 bulan karena tab Events. Lonjakan blast bisa melewati batas 30 eksekusi bersamaan ([kuota Apps Script](https://developers.google.com/apps-script/guides/services/quotas)). Dashboard juga harus membaca ±1,5 jt sel mentah per 30 hari. Pakai Apps Script hanya untuk traffic kecil dan stabil.

Deduplikasi Pixel ↔ CAPI memakai pasangan `event_name` + `event_id`: [Meta: Deduplicate Pixel and Server Events](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events).

## Tes

```bash
npm test
```

- `tests/logic.test.mjs`: logic jump, operator, validasi, piping, progress, deteksi loop
- `tests/stats.test.mjs`: funnel, completion, NPS, sumber traffic, CSV aman formula
- `tests/apps-script.test.mjs`: `Code.gs` asli dengan mock SpreadsheetApp/UrlFetchApp
- `tests/worker.test.mjs`: Worker asli di atas SQLite sungguhan (`node:sqlite`) dengan migrasi D1:
  - admin key, validasi, submit idempoten, payload CAPI (IP + hash SHA-256)
  - **300 sesi simulasi** (bounce, berhenti di tengah, beacon abandon berulang, logic jump, multi-pilihan): statistik dari tabel agregat D1 **identik** dengan statistik yang dihitung ulang dari data mentah
  - ekspor berhalaman tanpa duplikat, sinkron Google Sheets (JWT asli, RAW, retry setelah 403, posisi kolom stabil)
  - jawaban belum selesai: hanya jika fitur aktif dan kontak valid, dibersihkan dari pertanyaan/parameter asing, diperbarui per sesi, dihapus saat submit (beacon terlambat tidak menghidupkannya lagi), dihapus setelah 30 hari

Selain itu, alur builder → form → dashboard → ekspor CSV dan alur pemulihan (isi kontak → tutup tab → muncul di "Belum selesai" → kembali → lanjutkan → submit → hilang dari daftar) sudah diuji end-to-end dengan Playwright, baik di mode lokal maupun di runtime Cloudflare lokal (`wrangler dev` + D1).

## Keterbatasan saat ini

- Belum diuji di akun Cloudflare, Google Cloud, dan Meta sungguhan. Yang sudah diuji: runtime workerd/D1 lokal, SQLite, dan mock HTTP. Sebelum menjalankan iklan: deploy, isi satu form, cek *Test events* di Meta, dan pastikan baris muncul di Google Sheet dalam 5 menit.
- Email notifikasi hanya ada di backend Apps Script. Di Cloudflare, pakai webhook (Slack, Telegram, Make, n8n).
- Belum ada upload file, pembayaran, atau multi-bahasa.
- Admin key disimpan di `localStorage` browser admin. Jangan gunakan builder di komputer bersama.
- Di host selain Worker (mis. GitHub Pages), browser mencatat 404 untuk `formflow-config.js`. Ini tidak berbahaya.
