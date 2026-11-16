# StudyOS

Aplikasi pendamping belajar berbasis AI dengan workspace **Source**, **Chat**, dan **Watch**. Frontend memakai React, TypeScript, Vite, dan Tailwind; backend memakai Express dan tRPC.

## Fitur

- Sesi belajar dengan materi dari URL, PDF, DOCX, TXT, Markdown, atau CSV.
- Pencarian sumber web dan akademik, chat berdasarkan materi, sitasi, penjelasan teks, dan terjemahan Inggris–Indonesia.
- Kuis pilihan ganda, kartu istilah/vocabulary dengan jadwal review, serta catatan rich text.
- Stopwatch/countdown, riwayat waktu belajar, dashboard, dan pengaturan tema.
- **AI Connections** di Profile untuk mengatur URL API, autentikasi, model, dan koneksi aktif.

Sesi, materi, chat, catatan, kuis, dan riwayat belajar tetap disimpan di **IndexedDB browser**. Data tersebut belum tersinkron antarperangkat; menghapus data situs dapat menghapusnya. Konfigurasi koneksi AI disimpan terpisah oleh backend: pada disk privat untuk server lokal, atau pada **Vercel Blob privat dan terenkripsi** untuk deployment Vercel.

## Mulai secara lokal

Gunakan Node.js 24 dan pnpm 10 sesuai `packageManager` di [package.json](package.json).

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

| API protocol                       | Operasi utama                                          |
| ---------------------------------- | ------------------------------------------------------ |
| OpenAI-compatible Chat Completions | `/chat/completions`                                    |
| OpenAI Responses                   | `/responses`                                           |
| Anthropic Messages                 | `/messages`                                            |
| Google Generative Language         | `/models/{model}:generateContent` dan varian streaming |

Pilih format yang benar-benar didukung endpoint, bukan hanya berdasarkan merek provider. Gateway seperti 9router dapat digunakan melalui format OpenAI-compatible jika menyediakan protokol tersebut. Integrasi ini tidak mengubah sembarang format API khusus menjadi kompatibel.

## Penyimpanan dan akses koneksi AI

Default penyimpanan server adalah direktori `.studyos/` pada working directory aplikasi:

- `connections.json`: konfigurasi koneksi terenkripsi, termasuk key dan custom headers.
- `master.key`: kunci enkripsi lokal yang dibuat server.

Direktori tersebut diabaikan Git. Untuk memindahkan atau mencadangkan koneksi, hentikan server lalu salin **kedua file sebagai satu pasangan** ke lokasi privat. Kehilangan `master.key` membuat konfigurasi terenkripsi tidak dapat dibaca. Menghapus data browser tidak menghapus koneksi server, dan memindahkan file koneksi tidak memindahkan data belajar di IndexedDB.

Pada server lokal, manajemen serta penggunaan koneksi AI tersedia dari **localhost pada server yang sama**, atau untuk **administrator yang sudah login**. Membuka aplikasi melalui alamat jaringan/proxy tidak otomatis memberikan akses localhost.

Pada Vercel, gunakan **Vercel Authentication untuk seluruh deployment**, penyimpanan Blob privat, dan mode akses khusus deployment terlindungi. Pengguna masuk dengan akun Vercel yang memiliki akses proyek, lalu mengatur koneksi melalui Profile. Semua orang yang diberi akses deployment dapat mengelola dan memakai koneksi AI bersama tersebut; koneksi belum diisolasi per akun. Lihat [panduan deployment Vercel](docs/setup/VERCEL.md).

## Konfigurasi environment opsional

AI URL, key, dan model dikonfigurasi melalui Profile. Environment AI lama tidak diimpor atau diaktifkan otomatis.

Untuk pengaturan non-AI, salin [.env.example](.env.example) menjadi `.env` jika diperlukan:

```bash
cp .env.example .env
```

Di PowerShell, gunakan `Copy-Item .env.example .env`. Restart server setelah mengubah environment.

| Variabel                                                           | Kegunaan                                                                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STUDYOS_LOCAL_MODE`                                               | Default lokal; pertahankan `true` untuk deployment Vercel tanpa layanan OAuth/storage lama. Nilai `false` mengaktifkan integrasi lama tersebut, bukan provider atau penyimpanan AI. |
| `STUDYOS_DATA_DIR`                                                 | Direktori privat dan persisten untuk koneksi AI; default `.studyos/` pada working directory.                                                                                        |
| `STUDYOS_AI_STORAGE`                                               | Pada Vercel, wajib `vercel-blob`; filesystem function tidak dipakai untuk menyimpan koneksi.                                                                                        |
| `STUDYOS_AI_MASTER_KEY`                                            | Pada mode Blob, kunci enkripsi 32 byte dalam base64, tersimpan sebagai secret server dan dipertahankan antar-deployment.                                                            |
| `BLOB_READ_WRITE_TOKEN` atau `BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN` | Autentikasi backend ke Blob store privat. Jangan gunakan kredensial ini di browser.                                                                                                 |
| `STUDYOS_CLOUD_ACCESS`                                             | Nilai `vercel-protected` mengaktifkan akses AI khusus Vercel yang seluruh deployment-nya dilindungi Vercel Authentication.                                                          |
| `STUDYOS_PUBLIC_HOSTS`                                             | Hostname tambahan yang diizinkan pada mode Vercel terlindungi, dipisahkan koma. Setiap hostname harus turut dilindungi Vercel Authentication.                                       |
| `TAVILY_API_KEY`                                                   | Pencarian Web. Pencarian Academic memakai OpenAlex.                                                                                                                                 |
| `PORT`                                                             | Port server Node; default `3000`.                                                                                                                                                   |
| `DATABASE_URL`                                                     | Koneksi MySQL untuk pengguna pada jalur login cloud. Tidak diperlukan oleh penyimpanan AI Connections.                                                                              |
| `JWT_SECRET`                                                       | Secret sesi pada integrasi login cloud lama. Enkripsi AI Connections memakai `master.key` lokal atau `STUDYOS_AI_MASTER_KEY` pada Blob, secara terpisah.                            |
| `VITE_APP_ID`, `VITE_OAUTH_PORTAL_URL`, `OAUTH_SERVER_URL`         | Identitas aplikasi, portal login browser, dan layanan OAuth server.                                                                                                                 |
| `OWNER_OPEN_ID`                                                    | OpenID pemilik yang diberi peran admin ketika pengguna disimpan.                                                                                                                    |
| `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY`                 | Konfigurasi storage cloud dan layanan pendukung lama yang masih digunakan; tidak memilih koneksi AI.                                                                                |

Variabel `VITE_*` dapat masuk bundle browser, sehingga tidak boleh berisi key atau secret. Deployment Vercel dengan mode terlindungi dan Blob tidak memerlukan database maupun layanan OAuth lama. Jika integrasi lama tersebut diaktifkan, konfigurasinya tetap diperlukan secara terpisah.

## Perintah proyek

| Perintah            | Fungsi                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`          | Server development Express dengan Vite.                                                                            |
| `pnpm check`        | Pengecekan TypeScript tanpa menghasilkan JavaScript.                                                               |
| `pnpm test`         | Menjalankan test suite.                                                                                            |
| `pnpm build`        | Build frontend ke `dist/public` dan backend ke `dist/index.js`.                                                    |
| `pnpm start`        | Menjalankan hasil build production.                                                                                |
| `pnpm build:vercel` | Build frontend untuk Vercel dan menyalin aset ke root `public/`; backend dikemas dari `api/server.ts` oleh Vercel. |
| `pnpm db:push`      | Generate dan menjalankan migrasi pada database yang ditunjuk `DATABASE_URL`.                                       |
| `pnpm format`       | Memformat file proyek dengan Prettier.                                                                             |

Test adapter yang memakai mock tidak membuktikan semua endpoint/provider nyata kompatibel. Pemeriksaan melalui **Test connection** menghubungi API yang dikonfigurasi dan dapat memakai kuota; tes tersebut tidak wajib untuk menyimpan koneksi.

## Deployment dan persistensi

Gunakan satu proses server Node dengan disk privat yang dapat ditulis dan bertahan setelah restart. Jalankan `pnpm build` lalu `pnpm start`; bila memakai container atau hosting, arahkan `STUDYOS_DATA_DIR` ke volume persisten milik proses server. Bawa `master.key` dan `connections.json` bersama saat migrasi.

Untuk Vercel, [api/server.ts](api/server.ts) menjalankan backend, sedangkan [vercel.json](vercel.json) mengarahkan API dan halaman SPA. Konfigurasi AI disimpan sebagai satu dokumen terenkripsi pada Blob privat, bukan filesystem function. Pembaruan memakai ETag untuk mencegah perubahan bersamaan antar-instance menimpa satu sama lain. Kunci enkripsi berasal dari environment server yang stabil; konfigurasi cloud yang belum lengkap menghasilkan error, tanpa berpindah diam-diam ke disk sementara.

Siapkan proyek, perlindungan seluruh deployment, Blob privat, dan environment infrastruktur sesuai [panduan Vercel](docs/setup/VERCEL.md). Setelah deployment siap, buka **Profile → AI Connections**, isi URL, protokol, key, dan model provider, lalu simpan serta aktifkan koneksi. Endpoint harus dapat dijangkau dari Vercel: `localhost` atau 9router pada laptop tidak dapat diakses langsung dari deployment.

Build Vercel membatasi upload frontend ke 3 MB; build lainnya memakai 5 MB. Konfigurasi function menetapkan `maxDuration` 90 detik. Validasi batas platform, streaming, upload, dan izin administrator pada hosting tujuan. Implementasi ini belum menyediakan isolasi koneksi per pengguna untuk layanan multi-user.

Key AI mengaktifkan fitur AI bila endpoint/model cocok dan kuotanya tersedia. Pencarian **Web** tetap memerlukan `TAVILY_API_KEY`; pencarian **Academic** memakai OpenAlex. Deploy dan konfigurasi AI tidak memindahkan data belajar lama dari browser atau domain lain.

## Struktur

```text
client/src/        Halaman, komponen, state, dan penyimpanan browser
api/               Entry backend Vercel
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
