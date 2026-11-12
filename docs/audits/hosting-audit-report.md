> **Arsip historis.** Audit ini dibuat sebelum konfigurasi deployment terbaru. Repo sekarang sudah memiliki `server.ts`, `vercel.json`, dan perintah `build:vercel`; pernyataan lama tentang ketiadaan berkas tersebut tidak lagi berlaku. Temuan serta batas platform di bawah perlu dinilai sesuai waktunya. Lihat [README](../../README.md) untuk panduan saat ini.

# Audit Hosting Gratis StudyOS — Beta Sederhana

## Kesimpulan eksekutif

Untuk beta satu teman, StudyOS **belum perlu login multi-user, migrasi seluruh data ke database, atau sistem produksi permanen**. Gateway AI 9router di VPS sudah siap. Fokus deployment sekarang adalah menjalankan aplikasi full-stack yang ada dengan environment server-side, mempertahankan browser persistence untuk data belajar, dan memastikan fitur Chat/streaming serta upload tidak melewati batas platform.

**Vercel masih realistis**, tetapi bukan deployment tanpa perubahan. Repository saat ini tidak memiliki entrypoint Vercel yang dikenali (`server.ts`, `src/server.ts`, atau `api/*`), Express app dibuat di dalam `startServer()`, static asset disajikan melalui Express, dan route streaming berada di `/api/study/chat-stream`. Vercel mendukung Express sebagai satu Function, tetapi StudyOS perlu adapter/entrypoint, strategi static asset, konfigurasi durasi streaming, serta penanganan upload.

**Render Free lebih minim perubahan untuk server Node/Express** karena memang menyediakan Web Service untuk Express dan menjalankan perintah start biasa. Namun service tidur setelah 15 menit tanpa traffic, cold start berikutnya bisa sekitar satu menit, filesystem-nya ephemeral, dan free Postgres kedaluwarsa setelah 30 hari. Untuk beta satu teman tanpa database cloud penuh, keterbatasan ini masih dapat diterima jika file tetap memakai storage eksternal yang sudah ada dan browser persistence tetap dipertahankan.

Cloudflare Workers/Pages kurang cocok sebagai jalur tercepat karena runtime Workers berbeda dari Node/Express dan repository memakai Express, tRPC adapter, PDF/DOCX parsing, serta package Node. Migrasi ke Workers akan menjadi pekerjaan arsitektur baru, bukan sekadar deployment.

## Kondisi kode yang diaudit

| Area | Temuan | Dampak deployment |
|---|---|---|
| Build | `pnpm build` berhasil; backend menghasilkan `dist/index.js` sekitar 114.5 KB dan total `dist` sekitar 16 MB | Build dasar sehat |
| Server | Express dibuat di `server/_core/index.ts`, memasang tRPC, OAuth, storage proxy, dan streaming Chat; server memanggil `listen()` setelah mencari port | Cocok untuk service Node biasa; perlu entrypoint/adaptasi untuk Vercel |
| Frontend | Vite menghasilkan `dist/public`; Express production saat ini memakai `express.static()` | Vercel Express tidak menggunakan `express.static()` untuk static asset menurut docs; perlu konfigurasi public/static |
| Streaming | Chat memakai SSE di `/api/study/chat-stream` dan timeout provider | Perlu mengatur dan menguji `maxDuration` di Vercel |
| Upload | Express menerima body hingga 50 MB | Vercel Functions membatasi body request 4.5 MB; upload besar perlu direct-to-storage atau pembatasan |
| Data belajar | Beta sederhana masih dapat memakai browser persistence | Tidak perlu migrasi database untuk uji satu teman |
| AI | URL HTTPS dan token 9router sudah server-side; combo `Studyos` telah diuji HTTP 200 | Siap dipakai dari hosting web mana pun yang dapat menyimpan secret server-side |
| Repository | Tidak ada `vercel.json` dan tidak ada entrypoint Vercel yang dikenali pada root/`api` | GitHub push belum dilakukan; audit belum mengubah source code |

## Perbandingan opsi

| Opsi | Kesesuaian dengan StudyOS sekarang | Kelebihan | Kekurangan beta |
|---|---|---|---|
| Vercel | Sedang; perlu adapter dan konfigurasi | Express dan Node runtime didukung; preview deployment dan Git integration tersedia | Entry point, static serving, streaming, dan upload perlu disesuaikan; Functions memiliki batas body 4.5 MB |
| Render Free Web Service | Tinggi untuk server Node/Express | Bisa menjalankan Express dengan build/start command; perubahan aplikasi lebih sedikit | Sleep setelah 15 menit, cold start sekitar satu menit, filesystem tidak persisten |
| Cloudflare Workers/Pages | Rendah untuk minim perubahan | Free Workers memiliki 100.000 request/hari dan streaming HTTP | Bukan runtime Node/Express biasa; perlu migrasi adapter dan meninjau package Node/PDF/DOCX |
| Manus hosting | Paling rendah perubahan teknis | Template full-stack dan secret sudah terintegrasi | Pengguna belum menetapkan biaya yang siap dibayar; keputusan biaya perlu dicek di akun sendiri |

## Rekomendasi

Untuk kondisi pengguna saat ini, saya merekomendasikan **beta sederhana dengan Render Free sebagai kandidat teknis pertama**, bukan karena Vercel tidak bisa, tetapi karena Render lebih cocok dengan bentuk aplikasi Express yang sedang berjalan. StudyOS dapat dijalankan sebagai satu Web Service dengan `pnpm build` sebagai build command dan `pnpm start` sebagai start command, selama server mendengarkan pada `0.0.0.0` dan `PORT` yang disediakan platform. File besar tidak boleh mengandalkan filesystem Render; jalur storage eksternal tetap digunakan.

Vercel tetap menjadi kandidat kedua jika pengguna lebih mengutamakan ekosistem GitHub/preview deployment. Untuk Vercel, pekerjaan minimal berikutnya adalah membuat entrypoint Express yang dapat diekspor/dideteksi Vercel, mengatur static assets, menambahkan konfigurasi durasi route streaming, membatasi atau memindahkan upload besar ke storage langsung, lalu menguji login/AI/Chat dari preview deployment. Perubahan tersebut sebaiknya dilakukan di branch/checkpoint terpisah dan belum dipush sebelum pengguna menyetujui.

## Keputusan yang disarankan sekarang

Jangan menambah database multi-user atau login baru untuk beta satu teman. Jangan mempublikasikan token 9router. Jangan push GitHub sebelum platform dipilih. Langkah teknis berikutnya sebaiknya berupa **proof-of-deployment** pada satu branch/checkpoint: pertama Render Free jika prioritasnya perubahan kode minimal; Vercel jika prioritasnya integrasi GitHub dan siap menerima pekerjaan adapter.

## Referensi

[1] [Vercel — Express on Vercel](https://vercel.com/docs/frameworks/backend/express)

[2] [Vercel — Functions Limits](https://vercel.com/docs/functions/limitations)

[3] [Vercel — Node.js Runtime](https://vercel.com/docs/functions/runtimes/node-js)

[4] [Vercel — Configuring Maximum Duration](https://vercel.com/docs/functions/configuring-functions/duration)

[5] [Render — Deploy for Free](https://render.com/docs/free)

[6] [Render — Web Services](https://render.com/docs/web-services)

[7] [Render — FAQ](https://render.com/docs/faq)

[8] [Cloudflare — Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
