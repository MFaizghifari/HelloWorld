# Belajarlagi Form

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
| **Tipe pertanyaan** | Teks singkat, paragraf, email, telepon, angka, pilihan ganda (single/multi, acak urutan), dropdown, ya/tidak, rating bintang, skala opini (0–10 → NPS otomatis), tanggal, **unggah file**, pernyataan |
| **Logic** | Aturan "JIKA … MAKA lompat ke" per pertanyaan, kondisi AND/OR, 10 operator (sama dengan, mengandung, >, <, diisi, …), kondisi bisa pakai hidden field (mis. `utm_source`), default next, deteksi loop/target yang sudah dihapus |
| **Personalisasi** | Answer piping `{{id_pertanyaan}}` dan `{{hidden:utm_source}}` di judul, deskripsi, halaman terima kasih, dan URL redirect |
| **Pengalaman responden** | Keyboard-first (Enter, huruf A/B/C), progress bar yang mengikuti jalur logic, navigasi ↑↓, mobile-friendly, validasi per tipe, redirect setelah submit (mis. ke WhatsApp) |
| **Facebook Pixel** | PageView, `FormStart`, `FormStep` (opsional, per pertanyaan), event submit standar (`Lead`, `CompleteRegistration`, …) dengan `eventID` |
| **Conversions API** | Dikirim dari Apps Script dengan `event_id` yang sama → dideduplikasi oleh Meta. Email & telepon di-hash SHA-256 (telepon `08…` dinormalisasi ke `628…`), plus `fbp`, `fbc`, user agent |
| **Analytics lain** | GA4 (`form_start`, `form_step`, `generate_lead`), GTM dataLayer, UTM/fbclid/gclid otomatis tercatat |
| **Dashboard** | Views, mulai, submission, completion rate, median waktu isi, tren harian, funnel drop-off per pertanyaan, **konversi per perangkat dan per sumber** (segmen yang jelas lebih rendah ditandai), distribusi jawaban, NPS, file yang diunggah, tabel jawaban, ekspor CSV |
| **Akun tim & peran** | Login email + kata sandi, 4 peran (Pemilik, Admin, Editor, Pembaca) yang ditegakkan di server, undangan & reset lewat link sekali pakai, log aktivitas |
| **Upload file & gambar** | Pertanyaan "Unggah file" (gambar / PDF / dokumen, batas ukuran & jumlah), gambar form (pertanyaan, pembuka, logo, latar) bisa diunggah langsung dari builder |
| **Uji A/B** | Varian B dari salinan form, pembagian pengunjung acak dan konsisten per browser, perbandingan konversi dengan uji statistik dan perkiraan sampel |
| **Google Sheets** | Satu spreadsheet per form (tab `Responses` + `Events`), bisa otomatis dibagikan ke email tim, kolom tetap sinkron walau pertanyaan diganti judul/urutan |
| **Integrasi** | Webhook (Make/Zapier/n8n/CRM), email notifikasi |
| **Pemulihan jawaban** | Simpan jawaban yang belum selesai setelah kontak terisi, lanjutkan dari pertanyaan terakhir, event Pixel `FormContact` untuk retargeting, daftar "Belum selesai" dengan tombol WA |
| **Keamanan** | Akun tim dengan peran (Cloudflare) atau admin key (Apps Script), pencegahan formula injection di Sheets & CSV, honeypot anti-bot, ID Pixel/GA4/GTM divalidasi ketat sebelum dipasang, jenis file dicek dari isinya, file hanya bisa dibuka anggota tim, semua teks form dirender via `textContent` (tanpa `innerHTML`) |

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

Saat pertama dibuka, builder meminta **admin key** (`dev` di contoh ini) untuk membuat akun Pemilik. Setelah itu semua orang masuk dengan email dan kata sandi. R2 (upload file) disimulasikan lokal oleh `wrangler dev`.

Mode default **"Lokal (demo)"** menyimpan semua di browser Anda: cocok untuk mendesain form & melihat dashboard, tapi link-nya tidak bisa dibagikan ke orang lain.

## Deploy produksi: Cloudflare Workers + D1 (disarankan)

Butuh akun Cloudflare (gratis) dan Node.js 20+.

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create belajarlagiform --location apac   # salin database_id ke wrangler.toml
npx wrangler r2 bucket create belajarlagiform-files      # penyimpanan file upload & gambar form
npm run db:migrate                                # buat tabel di D1
openssl rand -base64 32 | npx wrangler secret put ADMIN_KEY   # kunci acak 32 byte: membuat akun Pemilik (dan pemulihan akun)
npm run deploy                                    # → https://form.belajarlagi.id (lihat "Domain form.belajarlagi.id")
```

Buka `https://form.belajarlagi.id`. Builder meminta admin key sekali untuk membuat **akun Pemilik**, lalu Anda bisa mengundang tim (lihat [Akun tim dan peran](#akun-tim-dan-peran)). Backend "Cloudflare D1" sudah terpilih otomatis.

**Deployment yang sudah berjalan:** jalankan `npm run db:migrate` (membuat tabel `users`, `auth_sessions`, `invites`, `audit_log`, `uploads`, `segments` dari `migrations/0003_team_files_segments.sql`), buat bucket R2 di atas, lalu `npm run deploy`. Setelah itu builder meminta login; admin key lama tetap berlaku untuk API/otomasi. Migrasi `0004_form_slugs.sql` menambah kolom `slug` untuk link form dengan nama sendiri.

**Secret opsional** (`npx wrangler secret put NAMA`):

| Secret | Fungsi |
|---|---|
| `FB_CAPI_TOKEN` | Access token Meta Conversions API. Di Worker, IP pengunjung ikut dikirim (`client_ip_address`) sehingga kualitas pencocokan lebih baik dibanding Apps Script |
| `FB_TEST_EVENT_CODE` | Supaya event muncul di Events Manager → *Test events* |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` | Untuk salinan ke Google Sheets (lihat di bawah) |
| `FILES_SECRET` | Opsional. Kunci tanda tangan link file sementara di dashboard. Jika kosong, diturunkan dari `ADMIN_KEY` |

### Salinan ke Google Sheets

1. Google Cloud Console → buat project → aktifkan **Google Sheets API** → buat **Service Account** → Keys → *Add key* → JSON.
2. Simpan `client_email` dan `private_key` dari file JSON itu sebagai secret `GOOGLE_SERVICE_ACCOUNT_EMAIL` dan `GOOGLE_PRIVATE_KEY`.
3. Per form: buat Google Sheet kosong, **Share** ke email service account sebagai Editor, lalu tempel link-nya di builder → tab *Integrasi* → kartu *Kirim jawaban ke* → *Link Google Sheet*.

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

## Akun tim dan peran

Di backend Cloudflare, setiap anggota tim masuk dengan email dan kata sandinya sendiri. Admin key hanya dipakai sekali untuk membuat akun Pemilik, lalu untuk otomasi API dan pemulihan akun.

| | Pemilik | Admin | Editor | Pembaca |
|---|:-:|:-:|:-:|:-:|
| Lihat hasil, jawaban, file, ekspor CSV | ✓ | ✓ | ✓ | ✓ |
| Buat, edit, terbitkan, hapus form (termasuk Pixel, integrasi, uji A/B, unggah gambar) | ✓ | ✓ | ✓ | – |
| Undang anggota, ubah peran, keluarkan anggota, lihat aktivitas | ✓ | ✓ | – | – |
| Pindahkan kepemilikan | ✓ | – | – | – |

- **Peran ditegakkan di server.** Tombol yang disembunyikan di builder hanya kenyamanan; Worker menolak aksi di luar peran dengan HTTP 403, juga untuk sesi yang sudah terbuka saat perannya diturunkan.
- **Undangan dan reset kata sandi memakai link sekali pakai** (undangan 7 hari, reset 24 jam). Belajarlagi Form tidak mengirim email, jadi admin menyalin link atau mengirimnya lewat tombol WhatsApp. Pemilik yang lupa kata sandi membuat link reset sendiri dengan admin key dari halaman masuk.
- **Link ikut hak pembuatnya.** Saat link dipakai, server memeriksa ulang bahwa pembuatnya masih anggota dan masih boleh memberi peran itu (atau mengelola anggota itu). Link yang dibuat oleh atau untuk seseorang langsung batal saat perannya diubah, ia dikeluarkan, atau kepemilikan dipindahkan; link reset batal saat pemiliknya mengganti kata sandi. Semua link yang masih terbuka, termasuk link reset, terlihat di menu Tim dan bisa dibatalkan.
- **GTM hanya untuk Admin dan Pemilik.** Container GTM bisa menjalankan skrip apa pun di domain builder, tempat sesi login tersimpan. Editor tetap bisa mengatur Pixel dan GA4 (ID-nya divalidasi ketat), tapi perubahan GTM Container ID ditolak server (HTTP 403). Untuk isolasi penuh, sajikan form responden di domain terpisah dari builder (mis. `isi.belajarlagi.id` dan `admin.belajarlagi.id`).
- **Admin key:** buat dengan `openssl rand -base64 32` (256 bit). Tebakan admin key ikut rate limit login (10/menit per IP).
- **Kata sandi:** minimal 8 karakter tanpa aturan komposisi, sesuai [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html). Disimpan sebagai PBKDF2-HMAC-SHA256 100.000 iterasi dengan salt acak. OWASP menyarankan 600.000 iterasi ([Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)), tapi Workers membatasi iterasi PBKDF2 (workerd menolak dengan `iteration counts above … are not supported`, dan batas produksi yang umum dilaporkan adalah 100.000); jumlah iterasi ikut disimpan per hash sehingga bisa dinaikkan nanti (hash lama diperbarui saat login). Di workerd lokal, satu verifikasi ±43 ms CPU, jadi gunakan **Workers Paid** (batas CPU paket gratis 10 ms).
- **Perlindungan login:** 5 kali salah → akun dikunci 15 menit (penghitung dinaikkan secara atomik di D1, jadi tebakan paralel tetap terhitung); rate limit 10 percobaan/menit per IP dan per email; pesan error dan pola query sama untuk email tak terdaftar dan kata sandi salah.
- **Sesi:** token acak 32 byte, berlaku 30 hari, hanya hash SHA-256 yang disimpan di D1. Mengganti kata sandi atau reset mengakhiri sesi di perangkat lain; mengeluarkan anggota langsung mengakhiri semua sesinya.
- **Log aktivitas** (menu Tim): siapa menerbitkan/menghapus form, memulai/mengakhiri uji A/B, mengundang, mengubah peran, atau mengeluarkan anggota. Disimpan 13 bulan.
- **Apps Script** tidak punya akun tim: aksesnya tetap satu admin key, dan akses Sheet diatur lewat berbagi Google Drive. **Mode lokal/pratinjau** mensimulasikan tim di browser (ada pilihan "Lihat sebagai" untuk mencoba tiap peran).

## Upload file

Tipe pertanyaan **Unggah file**: pilih jenis (gambar, PDF, dokumen, atau semuanya), ukuran maksimal per file (2–25 MB), dan jumlah file (1–10). Responden bisa memilih atau menyeret file, melihat progres, dan menghapus sebelum mengirim. Gambar untuk form (pertanyaan, halaman pembuka, logo, latar) juga bisa diunggah langsung dari panel kanan builder.

| | Cloudflare | Apps Script | Lokal (demo) |
|---|---|---|---|
| File responden | R2, privat | Folder Google Drive per form, dibagikan (lihat) ke email "Bagikan Sheet ke" | IndexedDB browser |
| Gambar form | R2, publik di `/m/…` dengan cache 1 tahun | Drive, dibagikan "siapa saja yang punya link" | Disisipkan di form (diperkecil ke 1600 px) |
| Di Google Sheet / CSV / webhook | `nama.pdf (https://…/f/…)` | `nama.pdf (link Drive)` | nama file |

Keamanan dan privasi:
- **Jenis file dicek dari isinya** (byte awal file), bukan dari nama atau header browser. HTML atau SVG yang diganti namanya menjadi `.png` ditolak (HTTP 415), sehingga file unggahan tidak bisa menjalankan skrip di domain Anda. File dikirim dengan `X-Content-Type-Options: nosniff` dan CSP `sandbox`.
- **File hanya untuk tim.** Dashboard memakai link bertanda tangan yang berlaku 1 jam. Link permanen di Sheet, CSV, dan webhook hanya terbuka untuk anggota tim yang sedang masuk; pengunjung lain mendapat halaman "masuk dulu" (HTTP 401).
- **File milik kunjungan itu sendiri.** Saat submit, server hanya menerima file yang diunggah oleh sesi yang sama untuk pertanyaan yang sama, dan memakai nama/jenis/ukuran versi server.
- **Tidak ada file yatim.** File dari pengunjung yang tidak mengirim form dihapus otomatis setelah 24 jam (cron Worker; di Apps Script lewat `pruneOldEvents()`, pasang sebagai trigger harian). File tidak ikut disimpan di data "Belum selesai". Menghapus form menghapus semua filenya. Ini sejalan dengan prinsip pembatasan penyimpanan di UU PDP (UU 27/2022), karena foto KTM atau CV adalah data pribadi.
- **Batas:** 60 upload/menit per IPv4 atau per jaringan IPv6 /64 (satu rumah atau ponsel biasanya mendapat satu /64, jadi berganti alamat di dalamnya tidak melewati batas), maksimal 3× jumlah file per pertanyaan per kunjungan.
- **Kuota file yang belum dikirim.** Siapa pun bisa mengunggah sebelum submit, jadi total file yang belum menempel ke jawaban dibatasi 2 GB per form dan 8 GB total (atur lewat variabel `PENDING_FORM_BYTES` / `PENDING_TOTAL_BYTES`). Jika penuh, upload baru ditolak (HTTP 507) sampai pembersihan 24 jam berjalan; file yang sudah terkirim tidak terpengaruh. Di Apps Script, batasnya 1 GB unggahan per form per hari (Script Property `UPLOAD_DAILY_MB`). Catatan: Apps Script memindahkan file ke Trash Drive, yang tetap memakai kuota sampai dikosongkan otomatis setelah 30 hari.
- **Hanya gambar yang dibuka di tab.** PDF dan dokumen selalu diunduh (`Content-Disposition: attachment`), karena penampil PDF browser bisa menjalankan skrip.

**Biaya R2:** gratis sampai 10 GB penyimpanan, 1 jt operasi tulis dan 10 jt operasi baca per bulan, dan tanpa biaya egress. Setelahnya US$0,015/GB-bulan ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Contoh: jika 20% dari 30.000 isian/bulan mengunggah foto 2 MB, bertambah ±12 GB/bulan, atau sekitar US$0,2 per bulan untuk tiap 12 GB di atas kuota gratis.

## Uji A/B

Tab **Uji A/B** → **Buat varian B**: varian B dimulai sebagai salinan halaman pembuka, pertanyaan, halaman akhir, dan desain. Ubah satu hal di tab Konten (pilih **B** di atas kanvas). Pixel, integrasi, hidden field, dan link tetap satu untuk kedua varian, jadi hasil, Google Sheet, dan webhook tidak terpecah.

- **Pembagian:** pengunjung baru diacak sesuai persentase (default 50/50) dan tetap di varian yang sama saat kembali (disimpan di browser). Link dengan `?ab=A` atau `?ab=B` menampilkan satu varian untuk dicek tanpa ikut dihitung.
- **Yang dibandingkan:** konversi (terkirim ÷ pengunjung), mulai mengisi, dan selesai dari yang mulai, plus grafik konversi kumulatif per hari.
- **Kapan ada pemenang:** uji memakai sampel yang ditetapkan di awal. Tiap varian butuh jumlah pengunjung untuk mendeteksi selisih 5 poin (α 5%, daya uji 80%), misalnya ±1.565 per varian bila konversi dasar 50% ([kalkulator Evan Miller](https://www.evanmiller.org/ab-testing/sample-size.html)). Pemenang baru disebut setelah kedua varian mencapainya **dan** uji berjalan minimal 7 hari (satu siklus mingguan), dengan uji dua proporsi p < 0,05. Sebelum itu dashboard menampilkan "peluang B lebih baik" dan perkiraan sisa waktu, karena menghentikan uji di momen pertama yang "signifikan" menaikkan salah positif ([Evan Miller, How Not To Run an A/B Test](https://www.evanmiller.org/how-not-to-run-an-ab-test.html)).
- **Skala:** di 30.000 isian/bulan (±100.000 pengunjung/bulan pada konversi 30%), uji 50/50 mengumpulkan ±1.600 pengunjung per varian per hari, jadi batas 7 hari yang biasanya menentukan.
- **Meta Ads:** selama uji berjalan, event Pixel dan Conversions API membawa parameter `ab_variant` (mis. `x_ab12cd:B`), sehingga konversi per varian bisa dilihat di Ads Manager lewat custom conversion.
- **Mengakhiri:** pilih **Pakai B** (isi varian B menggantikan versi asli) atau **Pakai A**. Ringkasan uji disimpan di riwayat.

## Konversi per perangkat dan per sumber

Setiap kunjungan dicatat dengan perangkat dan sumbernya, lalu tab Hasil menampilkan konversi per segmen dengan garis rata-rata. Segmen yang konversinya jelas lebih rendah dari pengunjung lain (uji dua proporsi, p < 0,05, minimal 30 pengunjung) diberi tanda "di bawah rata-rata" dan disebut di kalimat pembuka Hasil.

- **Perangkat:** ponsel, tablet, atau desktop dari user agent (iPad dengan iPadOS 13+ dikenali lewat layar sentuh).
- **Sumber:** `utm_source` (ejaan umum disatukan, mis. `ig` → instagram), lalu `fbclid` (dilaporkan sebagai "meta", karena Meta menambahkannya untuk Facebook maupun Instagram), `gclid`, `ttclid`, lalu situs perujuk, lalu "(langsung)". `embed.js` meneruskan asal pengunjung halaman Anda (`_ref`), sehingga form yang ditanam tidak mencatat situs Anda sendiri sebagai sumber.
- Di Cloudflare, segmen dihitung di tabel `segments` (seperti tabel agregat lain), jadi dashboard tetap tidak memindai data mentah.

## Link form dengan nama sendiri

Tiap form bisa diberi nama link di tab **Bagikan**, misalnya:

| Sebelum | Sesudah |
|---|---|
| `form.belajarlagi.id/form.html?id=f_m3k9x2abcd` | `form.belajarlagi.id/beasiswa-2026` |

- Huruf kecil, angka, dan tanda hubung; 3–50 karakter. Judul form otomatis diusulkan (`Beasiswa S2 — Jakarta 2026` → `beasiswa-s2-jakarta-2026`).
- Satu nama hanya untuk satu form (server menolak duplikat dengan HTTP 409). Nama yang dipakai sistem (`api`, `dashboard`, `form`, `css`, dll.) ditolak.
- Mengganti nama membuat link lama berhenti berfungsi (404), jadi tentukan sebelum form disebar. Link `form.html?id=…` tetap berlaku selamanya.
- Parameter iklan tetap terbaca: `form.belajarlagi.id/beasiswa-2026?utm_source=instagram` tercatat sebagai sumber "instagram".
- Hanya di backend Cloudflare. Di Apps Script dan mode lokal, link tetap memakai ID form.

### Domain form.belajarlagi.id

Semua link yang dibagikan memakai `https://form.belajarlagi.id/<nama-link>`. Ini sudah diatur di `worker/wrangler.toml`:

```toml
routes = [{ pattern = "form.belajarlagi.id", custom_domain = true }]   # di bagian atas file

[vars]
PUBLIC_URL = "https://form.belajarlagi.id"
```

Saat `npm run deploy`, Cloudflare membuat record DNS dan sertifikat HTTPS untuk `form.belajarlagi.id` secara otomatis, tanpa biaya tambahan ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). Syaratnya:

1. **Domain `belajarlagi.id` dikelola di akun Cloudflare yang sama** (nameserver domain mengarah ke Cloudflare; paket Free cukup). Cek di dashboard → Websites. Jika domain masih di DNS lain, pindahkan nameserver-nya dulu, atau untuk sementara hapus baris `routes` dan `PUBLIC_URL`, maka aplikasi jalan di `belajarlagiform.<akun>.workers.dev`.
2. **Belum ada record DNS `form`** di zona itu. Cloudflare menolak custom domain jika sudah ada record dengan nama yang sama; hapus dulu jika pernah dibuat.

Setelah itu:
- Halaman yang dibuka lewat `*.workers.dev` dialihkan (301) ke `form.belajarlagi.id` dengan path dan parameter UTM tetap utuh, jadi tim selalu login di satu domain (cookie file dan sesi tidak terpecah). API tetap menjawab di kedua alamat.
- **Meta Pixel:** verifikasi domain di Business Manager dilakukan per domain utama (eTLD+1). Jika `belajarlagi.id` sudah terverifikasi, `form.belajarlagi.id` ikut tercakup, dan cookie `_fbp` tetap first-party di domain Belajarlagi ([Meta: Verifikasi domain](https://www.facebook.com/business/help/286768115176155)).
- Di pratinjau dan mode lokal, kolom nama link sudah menampilkan `form.belajarlagi.id/` sebagai contoh alamat akhirnya.

## Embed di website

Tab **Bagikan** menghasilkan 3 snippet. Disarankan memakai `embed.js`:

```html
<div data-belajarlagiform-inline="https://…/form.html?id=f_xxx" style="height:600px"></div>
<script src="https://…/embed.js" async></script>
```

Kenapa tidak iframe polos saja? Safari (ITP) dan Chrome membatasi cookie pihak ketiga di iframe, sehingga Pixel di dalam iframe sering kehilangan `_fbp`/`_fbc`. `embed.js`:
- meneruskan UTM/fbclid dari URL halaman Anda ke form,
- mengirim cookie `_fbp`/`_fbc` first-party ke form (untuk matching CAPI),
- jika halaman Anda sudah punya Pixel, event form ditembakkan dari Pixel halaman Anda dan Pixel di iframe dimatikan (tidak dobel hitung),
- memancarkan event DOM `belajarlagiform:Lead`, `belajarlagiform:FormStart`, dst. untuk kebutuhan custom.

## Kapasitas: 30.000 isian/bulan

**Asumsi:** completion rate 30% → ±100.000 pengunjung/bulan. Tiap pengunjung memicu ±3 request API (view, start, submit/abandon) ditambah 1 request `belajarlagiform-config.js`.

### Cloudflare Workers + D1

| Ukuran | Kebutuhan 30 rb/bulan | Batas paket gratis | Workers Paid (US$5/bulan) |
|---|---|---|---|
| Request Worker | ±400 rb/bulan ≈ 13 rb/hari | 100 rb/hari | 10 jt/bulan termasuk |
| Baris ditulis D1 | ±1,5 jt/bulan ≈ 50 rb/hari¹ | 100 rb/hari | 50 jt/bulan termasuk |
| Baris dibaca D1 | dashboard membaca tabel agregat, kecil | 5 jt/hari | 25 miliar/bulan termasuk |
| Penyimpanan D1 | ±1–2 KB per isian → ±50 MB/tahun | 5 GB | 5 GB termasuk, lalu berbayar |

¹ Diukur, bukan ditebak: dengan form 8 pertanyaan, **±35 baris ditulis per pengunjung yang submit** (termasuk index) dan **±6,5 per pengunjung yang tidak submit**. 30.000 × 35 + 70.000 × 6,5 ≈ 1,5 jt. Rincian per perangkat/sumber/varian menambah 2–3 upsert per tahap (lihat, mulai, kirim), sehingga perkiraannya naik menjadi ±43 dan ±10 baris, atau ±2 jt baris/bulan. Angka tambahan ini dihitung dari jumlah query, belum diukur ulang di D1.

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
- `tests/apps-script.test.mjs`: `Code.gs` asli dengan mock SpreadsheetApp/UrlFetchApp/DriveApp (termasuk upload ke Drive dan kolom perangkat/sumber/varian)
- `tests/team.test.mjs`: setup Pemilik, login (pesan error seragam, kunci 15 menit, termasuk 5 tebakan paralel), rate limit admin key, peran ditegakkan server, undangan & reset sekali pakai dan batal saat peran pembuatnya berubah, GTM hanya Admin, ganti kata sandi, log aktivitas
- `tests/files.test.mjs`: deteksi jenis dari isi file, batas ukuran (termasuk body tanpa Content-Length), file harus milik sesi yang sama, link bertanda tangan / cookie tim, pembersihan 24 jam, kuota file belum terkirim, rate limit per /64 IPv6, PDF selalu diunduh, gambar builder
- `tests/ab-traffic.test.mjs`: ukuran sampel (1.565 per varian di 50% ± 5 poin, sama dengan kalkulator Evan Miller), vonis uji A/B, pembagian acak, klasifikasi perangkat & sumber, varian form
- `tests/worker.test.mjs`: Worker asli di atas SQLite sungguhan (`node:sqlite`) dengan migrasi D1:
  - admin key, validasi, submit idempoten, payload CAPI (IP + hash SHA-256)
  - **300 sesi simulasi** (bounce, berhenti di tengah, beacon abandon berulang, logic jump, multi-pilihan, perangkat, sumber, dan uji A/B dengan pertanyaan yang hanya ada di varian B): statistik dari tabel agregat D1 **identik** dengan statistik yang dihitung ulang dari data mentah
  - ekspor berhalaman tanpa duplikat, sinkron Google Sheets (JWT asli, RAW, retry setelah 403, posisi kolom stabil)
  - jawaban belum selesai: hanya jika fitur aktif dan kontak valid, dibersihkan dari pertanyaan/parameter asing, diperbarui per sesi, dihapus saat submit (beacon terlambat tidak menghidupkannya lagi), dihapus setelah 30 hari

Selain itu, alur builder → form → dashboard → ekspor CSV dan alur pemulihan (isi kontak → tutup tab → muncul di "Belum selesai" → kembali → lanjutkan → submit → hilang dari daftar) sudah diuji end-to-end dengan Playwright, baik di mode lokal maupun di runtime Cloudflare lokal (`wrangler dev` + D1). Untuk fitur tim, upload, dan A/B, skenario end-to-end di `wrangler dev` (D1 + R2 lokal): buat akun Pemilik → undang Pembaca → responden di iPhone dari Instagram mengunggah KTM → file terbuka lewat link dashboard dan link permanen (Pemilik & Pembaca 200, anonim 401) → unggah logo → mulai uji A/B dan 8 pengunjung terbagi ke A/B → Pembaca hanya melihat Bagikan/Uji A/B/Hasil dan `deleteForm` ditolak 403.

## Keterbatasan saat ini

- Belum diuji di akun Cloudflare, Google Cloud, dan Meta sungguhan. Yang sudah diuji: runtime workerd/D1 lokal, SQLite, dan mock HTTP. Sebelum menjalankan iklan: deploy, isi satu form, cek *Test events* di Meta, dan pastikan baris muncul di Google Sheet dalam 5 menit.
- Email notifikasi hanya ada di backend Apps Script. Di Cloudflare, pakai webhook (Slack, Telegram, Make, n8n).
- Belum ada pembayaran atau multi-bahasa. Uji A/B hanya dua varian (A dan B).
- Belajarlagi Form tidak mengirim email: undangan tim dan reset kata sandi berupa link yang dikirim sendiri.
- Akun tim hanya ada di backend Cloudflare. Di Apps Script, admin key disimpan di `localStorage` browser admin; jangan gunakan builder di komputer bersama.
- Upload ke Google Drive (Apps Script) baru diuji dengan mock, belum di akun Google sungguhan.
- Di host selain Worker (mis. GitHub Pages), browser mencatat 404 untuk `belajarlagiform-config.js`. Ini tidak berbahaya.
- Parameter `?api=` di link hanya berlaku di halaman form responden, bukan di builder, supaya link buatan orang lain tidak bisa mengarahkan admin key atau token login ke server lain.
- Sumber traffic ditampilkan 25 teratas; sisanya digabung menjadi "(lainnya)" agar dashboard tetap ringan meski `utm_source` diisi sembarang.
