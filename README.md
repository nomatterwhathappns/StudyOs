# StudyOS

Aplikasi pendamping belajar berbasis AI dengan workspace **Source**, **Chat**, dan **Watch**. Frontend memakai React, TypeScript, Vite, dan Tailwind; backend memakai Express dan tRPC.

## Fitur

- Sesi belajar dengan materi dari URL, PDF, DOCX, TXT, Markdown, atau CSV.
- Pencarian sumber web dan akademik, chat berdasarkan materi, sitasi, penjelasan teks, dan terjemahan Inggris–Indonesia.
- Kuis pilihan ganda, kartu istilah/vocabulary dengan jadwal review, serta catatan rich text.
- Stopwatch/countdown, riwayat waktu belajar, dashboard, dan pengaturan tema.
- **AI Connections** di Profile untuk mengatur URL API, autentikasi, model, dan koneksi aktif.
- Login username/password untuk **satu akun pemilik**, tanpa database SQL tambahan pada deployment Vercel.

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

## Login pemilik

Deployment Vercel memakai login **akun pemilik StudyOS**, terpisah dari akun GitHub atau Vercel. Setup pertama memerlukan private setup key dari environment proyek; pemilik memilih username dan password langsung pada form web. Jangan kirim password atau setup key melalui chat atau GitHub.

Setelah login, buka Profile untuk mengatur AI Connections. **Sign out** membatalkan request aktif, mengunci halaman, dan membersihkan state memori tanpa menghapus data belajar di IndexedDB. Sesi login berlaku hingga 24 jam dan dapat dicabut saat sign out.

Username, hash password, sesi, dan batas percobaan login disimpan dalam satu record terenkripsi pada Blob privat yang sudah digunakan proyek. Tidak ada pendaftaran umum atau koneksi AI terpisah per pengguna. Lihat [panduan login pemilik](docs/setup/OWNER_LOGIN.md) untuk setup pertama, environment, dan batas pemulihan akun.

Mode lokal tetap dapat dipakai tanpa login untuk kompatibilitas. Aktifkan owner auth secara eksplisit bila memerlukan gate username/password pada localhost.

## Format API yang didukung

| API protocol                       | Operasi utama                                          |
| ---------------------------------- | ------------------------------------------------------ |
| OpenAI-compatible Chat Completions | `/chat/completions`                                    |
| OpenAI Responses                   | `/responses`                                           |
| Anthropic Messages                 | `/messages`                                            |
| Google Generative Language         | `/models/{model}:generateContent` dan varian streaming |

Pilih format yang benar-benar didukung endpoint, bukan hanya berdasarkan merek provider. Gateway seperti 9router dapat digunakan melalui format OpenAI-compatible jika menyediakan protokol tersebut. Integrasi ini tidak mengubah sembarang format API khusus menjadi kompatibel.

## Penyimpanan dan akses koneksi AI

Default penyimpanan AI pada server lokal adalah direktori `.studyos/` di working directory aplikasi:

- `connections.json`: konfigurasi koneksi AI terenkripsi, termasuk key dan custom headers.
- `master.key`: kunci enkripsi AI lokal yang dibuat server.

Jika owner auth lokal diaktifkan, record akun memakai `owner-auth.json` dan kunci lokal `owner-auth.key` yang terpisah. Direktori data diabaikan Git. Cadangkan setiap dokumen bersama kunci yang cocok di lokasi privat; jangan menghapus atau mengganti kunci untuk mencoba memulihkan login.

Pada Vercel, koneksi AI tetap berada pada Blob privat `studyos/ai-connections-v1.json`. Owner auth memakai **dokumen lain**, `studyos/owner-auth-v1.json`, dengan kunci turunan dari `STUDYOS_AI_MASTER_KEY` yang sudah ada. Menambahkan login tidak memindahkan atau mereset koneksi AI pemilik. Pertahankan Blob store dan master key yang sama saat redeploy.

Saat owner auth aktif, seluruh API bisnis, streaming chat, upload, dan pengelolaan koneksi memerlukan sesi pemilik yang valid. Pada localhost tanpa owner auth, batas akses lokal/admin lama tetap berlaku. Membuka alamat jaringan atau menyetel hostname tidak memberikan sesi pemilik.

Data belajar di IndexedDB tetap terpisah dari konfigurasi AI dan akun login. Data browser lama tidak otomatis muncul pada perangkat atau domain lain. Lihat [AI Connections](docs/setup/AI_CONNECTIONS.md) dan [deployment Vercel](docs/setup/VERCEL.md).

## Konfigurasi environment

AI URL, key, dan model dikonfigurasi melalui Profile. Environment AI provider lama tidak diimpor atau diaktifkan otomatis. File `.env` tidak wajib untuk mode aplikasi lokal tanpa owner auth.

Salin [.env.example](.env.example) menjadi `.env` bila diperlukan; pada Vercel gunakan environment proyek untuk target Production.

```bash
cp .env.example .env
```

Di PowerShell, gunakan `Copy-Item .env.example .env`. Restart atau redeploy setelah mengubah environment.

| Variabel                                                                                                  | Kegunaan                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `STUDYOS_LOCAL_MODE`                                                                                      | Default lokal; tetap `true` pada Vercel tanpa integrasi OAuth/storage lama. Tidak memilih provider AI atau menonaktifkan owner auth. |
| `STUDYOS_OWNER_AUTH`                                                                                      | `enabled` untuk login satu pemilik; wajib pada jalur Vercel. Default lokal tanpa flag ini tetap tanpa login.                         |
| `STUDYOS_OWNER_SESSION_SECRET`                                                                            | Secret server acak minimal 32 karakter untuk menyegel cookie sesi. Berbeda dari password pengguna dan master key AI.                 |
| `STUDYOS_OWNER_SETUP_ENABLED`                                                                             | `true` selama setup akun pertama; dapat dinonaktifkan setelah akun dibuat.                                                           |
| `STUDYOS_OWNER_SETUP_KEY`                                                                                 | Secret setup acak berentropi tinggi, setidaknya 256 bit, yang dimasukkan pemilik pada form setup pertama.                            |
| `STUDYOS_DATA_DIR`                                                                                        | Direktori privat persisten untuk file lokal AI dan owner auth; default `.studyos/`.                                                  |
| `STUDYOS_AI_STORAGE`                                                                                      | Pada Vercel, `vercel-blob`; filesystem function tidak menyimpan koneksi permanen.                                                    |
| `STUDYOS_AI_MASTER_KEY`                                                                                   | Kunci Blob 32 byte dalam base64. Pertahankan agar dokumen AI dan owner auth dapat dibaca setelah redeploy.                           |
| `BLOB_READ_WRITE_TOKEN` atau `BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN`                                        | Akses backend ke Blob store privat.                                                                                                  |
| `STUDYOS_PUBLIC_HOSTS`                                                                                    | Hostname production/alias resmi yang persis diizinkan, dipisahkan koma; bukan pengganti login.                                       |
| `TAVILY_API_KEY`                                                                                          | Pencarian Web. Pencarian Academic memakai OpenAlex.                                                                                  |
| `PORT`                                                                                                    | Port server Node; default `3000`.                                                                                                    |
| `DATABASE_URL`, `JWT_SECRET`, `VITE_APP_ID`, `VITE_OAUTH_PORTAL_URL`, `OAUTH_SERVER_URL`, `OWNER_OPEN_ID` | Hanya untuk integrasi akun/OAuth lama. Owner login dan AI Connections tidak memerlukan database SQL atau OAuth lama tersebut.        |
| `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY`                                                        | Storage cloud/layanan pendukung lama yang masih digunakan; tidak memilih provider AI atau akun pemilik.                              |

Variabel `VITE_*` dapat masuk bundle browser. Jangan menaruh password, key provider, setup key, session secret, atau master key di sana. Username dan password pemilik dipilih lewat form web, bukan ditulis pada environment atau source code.

## Perintah proyek

| Perintah            | Fungsi                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`          | Server development Express dengan Vite.                                                                             |
| `pnpm check`        | Pengecekan TypeScript tanpa menghasilkan JavaScript.                                                                |
| `pnpm test`         | Menjalankan test suite.                                                                                             |
| `pnpm build`        | Build frontend ke `dist/public` dan backend ke `dist/index.js`.                                                     |
| `pnpm start`        | Menjalankan hasil build production.                                                                                 |
| `pnpm build:vercel` | Build frontend untuk Vercel dan menyalin aset ke root `public/`; backend dikemas dari `api/server.mjs` oleh Vercel. |
| `pnpm db:push`      | Generate dan menjalankan migrasi pada database yang ditunjuk `DATABASE_URL`.                                        |
| `pnpm format`       | Memformat file proyek dengan Prettier.                                                                              |

Test adapter yang memakai mock tidak membuktikan semua endpoint/provider nyata kompatibel. Pemeriksaan melalui **Test connection** menghubungi API yang dikonfigurasi dan dapat memakai kuota; tes tersebut tidak wajib untuk menyimpan koneksi.

## Deployment dan persistensi

Untuk server Node dengan disk persisten, jalankan `pnpm build` lalu `pnpm start`. Arahkan `STUDYOS_DATA_DIR` ke volume privat yang tetap tersedia setelah restart. Cadangkan file akun dan koneksi bersama kunci masing-masing.

Pada Vercel, [api/server.mjs](api/server.mjs) menjalankan backend dan [vercel.json](vercel.json) mengarahkan API serta halaman SPA. Blob privat mempertahankan koneksi AI dan record owner auth sebagai dua dokumen terenkripsi terpisah. Pembaruan memakai ETag/CAS agar request bersamaan tidak menimpa perubahan atau membuat ulang akun yang sudah ada. Secret yang hilang atau storage yang tidak dapat dibaca menghasilkan error; data lama tidak direset.

Ikuti [panduan Vercel](docs/setup/VERCEL.md): pertahankan perlindungan Vercel untuk seluruh deployment selama migrasi dan pemeriksaan. Setelah owner auth versi terbaru diverifikasi, hanya domain production yang dituju boleh membuka halaman login aplikasi melalui Standard Protection. URL deployment lama yang belum mempunyai owner login harus tetap dilindungi Vercel Authentication; jangan mematikan perlindungan proyek secara global.

Endpoint AI harus dapat dijangkau dari backend Vercel. `localhost` atau 9router pada laptop tidak dapat diakses langsung dari deployment. Setelah login pemilik, masukkan URL, protokol, key, dan model melalui Profile lalu aktifkan koneksi.

Build Vercel membatasi upload frontend ke 3 MB; build lainnya memakai 5 MB. Konfigurasi function menetapkan `maxDuration` 300 detik. Keberhasilan build tidak menggantikan pemeriksaan login, penolakan API anonim, streaming, upload, serta provider nyata pada deployment tujuan.

Login ini hanya untuk satu pemilik. Sistem belum menyediakan pendaftaran umum, reset password lewat email, atau isolasi data/koneksi banyak pengguna. Data belajar tetap berada pada browser dan domain masing-masing.

## Struktur

```text
client/src/        Halaman, komponen, state, dan penyimpanan browser
api/               Entry backend Vercel
server/ai/        Penyimpanan koneksi, pemeriksaan akses, dan adapter API AI
server/owner-auth/ Setup, login, sesi, dan penyimpanan satu akun pemilik
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
