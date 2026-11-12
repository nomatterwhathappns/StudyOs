# StudyOS

Aplikasi pendamping belajar berbasis AI dengan workspace **Source**, **Chat**, dan **Watch**. Frontend memakai React, TypeScript, Vite, dan Tailwind; backend memakai Express dan tRPC.

## Fitur

- Sesi belajar dengan materi dari URL, PDF, DOCX, TXT, Markdown, atau CSV.
- Pencarian sumber web dan akademik, chat berdasarkan materi, sitasi, penjelasan teks, dan terjemahan Inggris–Indonesia.
- Kuis pilihan ganda, kartu istilah/vocabulary dengan jadwal review, serta catatan rich text.
- Stopwatch/countdown, riwayat waktu belajar, dashboard, dan pengaturan tema.

Sesi, materi, chat, catatan, kuis, dan riwayat belajar disimpan di **IndexedDB browser**. Data tersebut belum tersinkron antarperangkat; menghapus data situs dapat menghapusnya. Database MySQL dipakai untuk pengguna dan kredensial AI pribadi.

## Menjalankan secara lokal

Gunakan Node.js 22.12+ atau 24 dan pnpm 10 sesuai `packageManager` di [package.json](package.json).

```bash
pnpm install --frozen-lockfile
cp .env.local.example .env
```

Di PowerShell, gunakan `Copy-Item .env.local.example .env` sebagai pengganti `cp`.

Isi `.env` dengan URL, proxy key, dan model dari **9router yang sudah berjalan terpisah**. Contoh konfigurasi ada di [.env.local.example](.env.local.example); sesuaikan port dengan layanan 9router yang digunakan. Key Tavily hanya diperlukan untuk pencarian Web.

```bash
pnpm dev
```

Buka alamat yang dicetak terminal, biasanya `http://localhost:3000`. Jika port tersebut terpakai, server mencoba port berikutnya. Restart server setelah mengubah `.env`.

`STUDYOS_LOCAL_MODE=true` memakai gateway 9router lokal dan menonaktifkan registrasi route OAuth serta storage proxy cloud. Impor dokumen lokal menyimpan teks hasil ekstraksi di browser. Mode ini tetap memerlukan gateway/provider AI yang berfungsi; model AI tidak dibundel di repo.

## Konfigurasi environment

Simpan secret pada `.env` lokal atau environment server hosting. Variabel berawalan `VITE_` dapat masuk bundle browser, sehingga tidak boleh berisi secret.

| Variabel | Kegunaan |
| --- | --- |
| `STUDYOS_LOCAL_MODE` | `true` untuk mode 9router lokal. |
| `STUDYOS_LOCAL_AI_ROUTER_URL` | Endpoint HTTP loopback 9router, diakhiri `/v1`. |
| `STUDYOS_LOCAL_AI_ROUTER_API_KEY` | Proxy key gateway lokal. |
| `STUDYOS_LOCAL_AI_ROUTER_MODEL` | Model atau combo yang tersedia di gateway lokal. |
| `STUDYOS_AI_ROUTER_ENABLED` | `true` untuk mengaktifkan gateway 9router publik saat mode lokal nonaktif. |
| `STUDYOS_AI_ROUTER_URL`, `STUDYOS_AI_ROUTER_TOKEN`, `STUDYOS_AI_ROUTER_MODEL` | URL HTTPS publik, token gateway, dan model untuk 9router online. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Key Google Gemini tingkat server. Panduan dan catatan personal key ada di [setup Gemini](docs/setup/GOOGLE_GEMINI_SETUP.md). |
| `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY` | Gateway AI bawaan dan storage cloud. |
| `TAVILY_API_KEY` | Pencarian Web. Pencarian Academic memakai OpenAlex. |
| `DATABASE_URL` | Koneksi MySQL untuk pengguna dan kredensial AI pribadi. |
| `JWT_SECRET` | Penandatanganan sesi dan enkripsi kredensial AI pribadi; pertahankan nilainya agar kredensial lama tetap dapat dibaca. |
| `VITE_APP_ID`, `VITE_OAUTH_PORTAL_URL`, `OAUTH_SERVER_URL` | Identitas aplikasi, portal login browser, dan layanan OAuth server. |
| `OWNER_OPEN_ID` | OpenID pengguna yang diberi peran admin ketika disimpan. |
| `PORT` | Port server lokal/Node; default `3000`. |

Fitur login, penyimpanan file cloud, dan personal Gemini key membutuhkan konfigurasi layanan terkait. Operasi belajar/AI utama saat ini belum mewajibkan login; tinjau kontrol akses dan batas request sebelum membuka layanan untuk publik luas.

## Perintah proyek

| Perintah | Fungsi |
| --- | --- |
| `pnpm dev` | Server development Express dengan Vite. |
| `pnpm check` | Pengecekan TypeScript tanpa menghasilkan JavaScript. |
| `pnpm test` | Test suite; pemeriksaan layanan nyata dilewati kecuali diaktifkan secara eksplisit. |
| `pnpm build` | Build frontend ke `dist/public` dan backend ke `dist/index.js`. |
| `pnpm start` | Menjalankan hasil build production. |
| `pnpm build:vercel` | Build adapter Vercel dan menyalin aset ke root `public/`. |
| `pnpm db:push` | Generate dan menjalankan migrasi pada database yang ditunjuk `DATABASE_URL`. |
| `pnpm format` | Memformat file proyek dengan Prettier. |

Untuk test tanpa berkas integrasi layanan eksternal:

```bash
pnpm test --exclude '**/*.secret.test.ts'
```

Pemeriksaan layanan nyata memerlukan kredensial terkait dan flag opt-in: `RUN_PUBLIC_AI_ROUTER_SECRET_TEST=true`, `RUN_GOOGLE_GEMINI_SECRET_TEST=true`, atau `RUN_TAVILY_SECRET_TEST=true`. Pemeriksaan tersebut menghubungi provider dan dapat memakai kuota.

## Deployment

Untuk server Node biasa, jalankan `pnpm build` lalu `pnpm start`. Konfigurasikan environment server sesuai fitur yang digunakan.

Adapter Vercel sudah tersedia melalui [server.ts](server.ts) dan [vercel.json](vercel.json). Build memakai `pnpm build:vercel`; konfigurasi function menetapkan `maxDuration` 90 detik. Batas upload frontend untuk build Vercel adalah 3 MB agar payload JSON/base64 tetap di bawah batas request platform; build lainnya memakai 5 MB. Perubahan batas platform perlu dicek pada dokumentasi hosting yang berlaku.

Validasi streaming, kredensial provider, dan upload pada deployment tujuan. Keberadaan adapter belum membuktikan bahwa suatu deployment atau provider sedang aktif.

## Struktur

```text
client/src/       Halaman, komponen, state, dan penyimpanan browser
server/          API, adapter AI, impor dokumen, autentikasi, dan storage
shared/          Konstanta dan error yang dipakai bersama
drizzle/         Skema dan riwayat migrasi MySQL
docs/setup/      Panduan konfigurasi
docs/diagnostics/ Catatan diagnosis terdahulu
docs/audits/     Arsip audit hosting dan tampilan
docs/history/   Riwayat checklist pengerjaan
.debug-logs/     Log development yang dibuat saat runtime dan diabaikan Git
```

Dokumen audit dan diagnosis menyimpan temuan pada saat ditulis. Gunakan README ini dan kode terbaru sebagai acuan kondisi sekarang; sebagian arsip masih membahas keadaan sebelum adapter Vercel atau personal Gemini key tersedia.
