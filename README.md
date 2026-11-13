# StudyOS

Aplikasi pendamping belajar berbasis AI dengan workspace **Source**, **Chat**, dan **Watch**. Frontend memakai React, TypeScript, Vite, dan Tailwind; backend memakai Express dan tRPC.

## Fitur

- Sesi belajar dengan materi dari URL, PDF, DOCX, TXT, Markdown, atau CSV.
- Pencarian sumber web dan akademik, chat berdasarkan materi, sitasi, penjelasan teks, dan terjemahan Inggris–Indonesia.
- Kuis pilihan ganda, kartu istilah/vocabulary dengan jadwal review, serta catatan rich text.
- Stopwatch/countdown, riwayat waktu belajar, dashboard, dan pengaturan tema.
- **AI Connections** di Profile untuk mengatur URL API, autentikasi, model, dan koneksi aktif.

Sesi, materi, chat, catatan, kuis, dan riwayat belajar tetap disimpan di **IndexedDB browser**. Data tersebut belum tersinkron antarperangkat; menghapus data situs dapat menghapusnya. Konfigurasi koneksi AI disimpan terpisah pada disk server, bukan di IndexedDB.

## Mulai secara lokal

Gunakan Node.js 22.12+ atau 24 dan pnpm 10 sesuai `packageManager` di [package.json](package.json).

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Buka alamat yang dicetak terminal, biasanya `http://localhost:3000`. Jika port tersebut terpakai, server mencoba port berikutnya. Mode aplikasi lokal aktif secara default dan tidak memerlukan file `.env` atau database untuk menyiapkan koneksi AI.

1. Buka **Profile → AI Connections → Add connection**.
2. Pilih **API protocol**, isi **Base URL**, autentikasi, dan **Model** sesuai API/provider.
3. Masukkan ID model secara manual. **Fetch models** dan **Test connection** tersedia sebagai pemeriksaan opsional.
4. Tekan **Save connection**, kemudian **Use connection**. Koneksi aktif ditandai **Active**.

Chat, Explain, terjemahan, kuis, dan pembuatan istilah memakai koneksi aktif tersebut. StudyOS tidak memilih provider bawaan atau berpindah ke provider lain secara otomatis ketika koneksi gagal. Lihat [panduan AI Connections](docs/setup/AI_CONNECTIONS.md) untuk autentikasi, opsi lanjutan, contoh gateway lokal, dan migrasi konfigurasi lama.

## Format API yang didukung

| API protocol | Operasi utama |
| --- | --- |
| OpenAI-compatible Chat Completions | `/chat/completions` |
| OpenAI Responses | `/responses` |
| Anthropic Messages | `/messages` |
| Google Generative Language | `/models/{model}:generateContent` dan varian streaming |

Pilih format yang benar-benar didukung endpoint, bukan hanya berdasarkan merek provider. Gateway seperti 9router dapat digunakan melalui format OpenAI-compatible jika menyediakan protokol tersebut. Integrasi ini tidak mengubah sembarang format API khusus menjadi kompatibel.

## Penyimpanan dan akses koneksi AI

Default penyimpanan server adalah direktori `.studyos/` pada working directory aplikasi:

- `connections.json`: konfigurasi koneksi terenkripsi, termasuk key dan custom headers.
- `master.key`: kunci enkripsi lokal yang dibuat server.

Direktori tersebut diabaikan Git. Untuk memindahkan atau mencadangkan koneksi, hentikan server lalu salin **kedua file sebagai satu pasangan** ke lokasi privat. Kehilangan `master.key` membuat konfigurasi terenkripsi tidak dapat dibaca. Menghapus data browser tidak menghapus koneksi server, dan memindahkan file koneksi tidak memindahkan data belajar di IndexedDB.

Manajemen serta penggunaan koneksi AI tersedia dari **localhost pada server yang sama**, atau untuk **administrator yang sudah login**. Membuka aplikasi melalui alamat jaringan/proxy tidak otomatis memberikan akses localhost. Koneksi merupakan konfigurasi bersama milik pemilik satu server, bukan penyimpanan akun AI terpisah untuk banyak pengguna.

## Konfigurasi environment opsional

AI URL, key, dan model dikonfigurasi melalui Profile. Environment AI lama tidak diimpor atau diaktifkan otomatis.

Untuk pengaturan non-AI, salin [.env.example](.env.example) menjadi `.env` jika diperlukan:

```bash
cp .env.example .env
```

Di PowerShell, gunakan `Copy-Item .env.example .env`. Restart server setelah mengubah environment.

| Variabel | Kegunaan |
| --- | --- |
| `STUDYOS_LOCAL_MODE` | Default lokal; nilai `false` mengaktifkan jalur OAuth dan storage cloud yang tersedia. Flag ini tidak memilih provider AI. |
| `STUDYOS_DATA_DIR` | Direktori privat dan persisten untuk koneksi AI; default `.studyos/` pada working directory. |
| `TAVILY_API_KEY` | Pencarian Web. Pencarian Academic memakai OpenAlex. |
| `PORT` | Port server Node; default `3000`. |
| `DATABASE_URL` | Koneksi MySQL untuk pengguna pada jalur login cloud. Tidak diperlukan oleh penyimpanan AI Connections. |
| `JWT_SECRET` | Secret sesi login cloud. Enkripsi AI Connections memakai `master.key` yang terpisah. |
| `VITE_APP_ID`, `VITE_OAUTH_PORTAL_URL`, `OAUTH_SERVER_URL` | Identitas aplikasi, portal login browser, dan layanan OAuth server. |
| `OWNER_OPEN_ID` | OpenID pemilik yang diberi peran admin ketika pengguna disimpan. |
| `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY` | Konfigurasi storage cloud dan layanan pendukung lama yang masih digunakan; tidak memilih koneksi AI. |

Variabel `VITE_*` dapat masuk bundle browser, sehingga tidak boleh berisi key atau secret. Layanan login dan storage cloud tetap memerlukan konfigurasi tersendiri; pengaturan AI Connections tidak menggantikannya.

## Perintah proyek

| Perintah | Fungsi |
| --- | --- |
| `pnpm dev` | Server development Express dengan Vite. |
| `pnpm check` | Pengecekan TypeScript tanpa menghasilkan JavaScript. |
| `pnpm test` | Menjalankan test suite. |
| `pnpm build` | Build frontend ke `dist/public` dan backend ke `dist/index.js`. |
| `pnpm start` | Menjalankan hasil build production. |
| `pnpm build:vercel` | Build adapter Vercel dan menyalin aset ke root `public/`. |
| `pnpm db:push` | Generate dan menjalankan migrasi pada database yang ditunjuk `DATABASE_URL`. |
| `pnpm format` | Memformat file proyek dengan Prettier. |

Test adapter yang memakai mock tidak membuktikan semua endpoint/provider nyata kompatibel. Pemeriksaan melalui **Test connection** menghubungi API yang dikonfigurasi dan dapat memakai kuota; tes tersebut tidak wajib untuk menyimpan koneksi.

## Deployment dan persistensi

Gunakan satu proses server Node dengan disk privat yang dapat ditulis dan bertahan setelah restart. Jalankan `pnpm build` lalu `pnpm start`; bila memakai container atau hosting, arahkan `STUDYOS_DATA_DIR` ke volume persisten milik proses server. Bawa `master.key` dan `connections.json` bersama saat migrasi.

Adapter Vercel masih tersedia melalui [server.ts](server.ts) dan [vercel.json](vercel.json), tetapi penyimpanan file lokal AI Connections memerlukan persistensi yang tidak dijamin oleh filesystem function yang sementara atau read-only. Jangan mengandalkan file lokal function sebagai penyimpanan koneksi permanen atau bersama antar-instance. Deployment serverless memerlukan rancangan storage persisten yang sesuai sebelum dipakai untuk konfigurasi ini.

Build Vercel membatasi upload frontend ke 3 MB; build lainnya memakai 5 MB. Konfigurasi function menetapkan `maxDuration` 90 detik. Validasi batas platform, streaming, upload, dan izin administrator pada hosting tujuan. Implementasi ini belum menyediakan isolasi koneksi per pengguna untuk layanan multi-user.

## Struktur

```text
client/src/        Halaman, komponen, state, dan penyimpanan browser
server/ai/        Penyimpanan koneksi, pemeriksaan akses, dan adapter API AI
server/           API belajar, impor dokumen, autentikasi, dan storage
shared/           Kontrak koneksi, konstanta, dan error bersama
drizzle/          Skema dan riwayat migrasi MySQL
docs/setup/       Panduan konfigurasi saat ini
docs/diagnostics/ Catatan diagnosis terdahulu
docs/audits/      Arsip audit hosting dan tampilan
docs/history/     Riwayat checklist pengerjaan
.studyos/         Konfigurasi AI terenkripsi dan kunci lokal; diabaikan Git
.debug-logs/      Log development; diabaikan Git
```

Dokumen audit dan diagnosis mempertahankan temuan pada saat ditulis. Sebagiannya membahas integrasi provider lama yang sudah diganti; gunakan README dan panduan AI Connections sebagai acuan konfigurasi saat ini.
