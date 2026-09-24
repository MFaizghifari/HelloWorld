# FormFlow

Form builder bergaya Typeform: satu pertanyaan per layar, logic jump, Facebook/Meta Pixel + Conversions API, GA4/GTM, dashboard visualisasi, dan backend **Google Sheets** (satu spreadsheet per form).

Frontend-nya statis (HTML + JS modules, tanpa build step), jadi bisa di-host gratis di GitHub Pages, Netlify, Vercel, atau Cloudflare Pages.

```
app/
  index.html       Builder (buat & edit form)
  form.html        Halaman yang diisi responden
  dashboard.html   Analytics & visualisasi
  embed.js         Script embed (inline / popup) untuk website Anda
  js/              logic.js, stats.js, tracking.js, api.js, …
apps-script/
  Code.gs          Backend Google Apps Script → Google Sheets
  appsscript.json
tests/             node --test (logic, stats, backend dengan mock Apps Script)
```

## Fitur

| Area | Isi |
|---|---|
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
| **Keamanan** | Admin key untuk builder/dashboard, pencegahan formula injection di Sheets & CSV, honeypot anti-bot, ID Pixel/GA4/GTM divalidasi ketat sebelum dipasang, semua teks form dirender via `textContent` (tanpa `innerHTML`) |

## Coba lokal (5 menit, tanpa Google)

```bash
npm start            # atau: python3 -m http.server 8080 -d app
# buka http://localhost:8080
```

Mode default **"Lokal (demo)"** menyimpan semua di browser Anda: cocok untuk mendesain form & melihat dashboard, tapi link-nya tidak bisa dibagikan ke orang lain.

## Deploy produksi dengan Google Sheets

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

## Kapasitas untuk ±10.000 submission/bulan

Perkiraan di bawah memakai asumsi eksplisit; sesuaikan dengan data Anda.

**Asumsi:** 10.000 submission/bulan, completion rate 30% → ±33.000 views/bulan. Tiap pengunjung memicu ±3 request (view, start, submit/abandon) → ±100.000 request/bulan ≈ 3.300/hari.

| Batas | Nilai resmi | Pemakaian perkiraan | Sumber |
|---|---|---|---|
| Eksekusi Apps Script bersamaan | 30 per user | Puncak (20% traffic harian dalam 1 jam) ≈ 660 req/jam ≈ 0,2 req/detik × ~1 detik/req → < 1 bersamaan | [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas) |
| URL Fetch (CAPI + webhook) | 20.000/hari (Gmail), 100.000/hari (Workspace) | ±333 submission/hari × 1 panggilan `fetchAll` berisi 1–2 request ≈ ≤ 700/hari | idem |
| Email notifikasi | 100 penerima/hari (Gmail), 1.500 (Workspace) | 333/hari **melebihi** kuota Gmail. Pakai Workspace, atau webhook ke Slack/Telegram | idem |
| Sel per spreadsheet | 10 juta sel | Responses ±22 kolom × 10.000 = 220 rb sel/bulan; Events 4 kolom × ±70.000 = 280 rb sel/bulan → ±20 bulan per form. `pruneOldEvents()` (trigger bulanan) menghapus event > 400 hari sehingga Responses saja ±2,6 jt sel/tahun | [Batas file Google Sheets](https://support.google.com/drive/answer/37603) |
| Ukuran nilai CacheService | 100 KB | Definisi form di-cache 10 menit agar setiap view/submit tidak membaca registry | [CacheService](https://developers.google.com/apps-script/reference/cache/cache) |

Deduplikasi Pixel ↔ CAPI memakai pasangan `event_name` + `event_id`: [Meta: Deduplicate Pixel and Server Events](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events).

**Kesimpulan:** Google Sheets cukup untuk skala ini. Batas pertama yang akan terasa adalah **latensi** (Apps Script biasanya butuh 1–3 detik per submit, dan lebih lama saat cold start) serta **kuota email Gmail**, bukan kapasitas. Kalau nanti butuh >50 rb submission/bulan, upload file, atau query real-time yang berat, tambahkan adapter cloud (mis. Supabase/Postgres) di `app/js/api.js`. Interface-nya sudah seragam (`getForm`, `saveForm`, `submit`, `logEvent`, `getResults`), jadi UI tidak perlu diubah.

## Tes

```bash
npm test
```

- `tests/logic.test.mjs`: logic jump, operator, validasi, piping, progress, deteksi loop
- `tests/stats.test.mjs`: funnel, completion, NPS, sumber traffic, CSV aman formula
- `tests/apps-script.test.mjs`: menjalankan `Code.gs` asli dengan mock SpreadsheetApp/UrlFetchApp: admin key, simpan form, submit, formula injection, honeypot, payload CAPI (hash SHA-256), webhook, sinkronisasi kolom setelah pertanyaan diganti

## Keterbatasan saat ini

- Backend Apps Script baru diuji dengan mock, belum dengan deployment Google sungguhan. Lakukan satu uji submit + cek *Test events* di Meta sebelum menjalankan iklan.
- Belum ada rate-limit per IP (Apps Script tidak bisa melihat IP pengirim). Perlindungan spam saat ini hanya honeypot.
- Belum ada upload file, pembayaran, atau multi-bahasa.
- Kode Admin disimpan di `localStorage` browser admin. Jangan gunakan builder di komputer bersama.
