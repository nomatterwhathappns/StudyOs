> **Arsip historis.** Audit ini dibuat sebelum konfigurasi deployment terbaru. Repo sekarang sudah memiliki `server.ts`, `vercel.json`, dan perintah `build:vercel`; pernyataan lama tentang ketiadaan berkas tersebut tidak lagi berlaku. Temuan serta batas platform di bawah perlu dinilai sesuai waktunya. Lihat [README](../../README.md) untuk panduan saat ini.

# Hosting Audit Notes — Beta Sederhana StudyOS

Tanggal audit: 2026-09-07.

## Temuan kode saat ini

- `package.json` menjalankan server dengan `tsx watch server/_core/index.ts` di development dan membundle `server/_core/index.ts` ke `dist/index.js` untuk production.
- `server/_core/index.ts` membuat Express app, membuat HTTP server, memasang tRPC pada `/api/trpc`, memasang OAuth dan storage proxy ketika local mode nonaktif, memasang streaming Chat pada `/api/study/chat-stream`, lalu memanggil `server.listen()` pada port yang tersedia.
- Streaming Chat memakai Server-Sent Events (`text/event-stream`) dan memakai timeout provider hingga sekitar 45 detik untuk local router; request tetap perlu diuji di runtime hosting.
- Vite membangun frontend ke `dist/public`; static serving saat ini dilakukan oleh Express melalui `express.static()` dan fallback `app.get('*')` di server production. Tidak ada `vercel.json` yang sudah ada.
- Upload body Express dikonfigurasi sampai 50 MB, tetapi Vercel Functions memiliki batas body request 4.5 MB menurut dokumentasi resmi Vercel; jalur upload dokumen perlu diubah atau diuji khusus bila memakai Vercel.

## Temuan dokumentasi Vercel

1. Vercel mendukung Express dan dapat menjadikannya satu Vercel Function; Express perlu diekspor sebagai app atau memakai pola server yang didukung. Static assets untuk Express di Vercel harus berada di `public/**`; `express.static()` tidak digunakan untuk menyajikan static assets menurut dokumentasi Express on Vercel.
2. Node.js runtime Vercel mendukung Node APIs dan streaming, tetapi function tetap memiliki batas durasi. Dokumentasi Functions menyebut Hobby default dan maksimum 300 detik dengan Fluid Compute; durasi streamed response termasuk dalam durasi function.
3. Vercel Functions memiliki batas body request 4.5 MB. Ini lebih kecil dari konfigurasi Express StudyOS 50 MB dan berpengaruh pada upload PDF/DOCX.
4. Deployment Express penuh ke Vercel mungkin tetap realistis, tetapi perlu adapter/entrypoint yang mengekspor app, routing static asset yang sesuai, konfigurasi durasi streaming, dan strategi upload file langsung ke object storage.

## Status keputusan

Belum ada perubahan kode, belum ada push GitHub, dan belum ada deployment baru. Audit alternatif hosting gratis masih diperlukan sebelum rekomendasi final.

## Sources

- https://vercel.com/docs/frameworks/backend/express
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/runtimes/node-js
- https://vercel.com/docs/functions/configuring-functions/duration

## Alternatif hosting gratis

### Render Free

Render secara resmi mendukung web service Node.js/Express dan menjalankan app pada port `0.0.0.0` dari `PORT`. Free web services tidur setelah 15 menit tanpa traffic dan perlu sekitar satu menit untuk bangun. Filesystem bersifat ephemeral; file lokal dan SQLite tidak boleh dijadikan penyimpanan permanen. Free Postgres memiliki batas 1 GB dan kedaluwarsa setelah 30 hari, sehingga bukan pilihan database produksi. Free web service cocok untuk preview/beta kecil tetapi cold start perlu diterima.

### Cloudflare Workers/Pages

Cloudflare Workers Free memiliki batas 100.000 request per hari, 10 ms CPU per request, 128 MB memory, dan 50 subrequest per invocation. HTTP request dapat streaming selama koneksi tetap terbuka, tetapi StudyOS memakai Express, Node-specific packages, PDF/DOCX parsing, dan backend server yang tidak dapat dipindahkan langsung tanpa adapter Workers. Cloudflare Pages/Workers bukan jalur minim-perubahan untuk repository saat ini.

## Kesimpulan sementara

Vercel sekarang lebih layak daripada dugaan awal karena Vercel mendukung Express sebagai satu Function dan Node.js runtime penuh. Namun repository StudyOS tetap perlu penyesuaian: entrypoint Express harus diekspor/dideteksi Vercel, static assets tidak boleh bergantung pada `express.static()` menurut docs Vercel, streaming perlu diuji dengan `maxDuration`, dan upload body 50 MB harus disesuaikan karena Vercel Functions membatasi request body 4.5 MB. Render Free paling sedikit mengubah server Node/Express, tetapi cold start dan filesystem ephemeral harus diterima; file tetap memakai storage S3 yang sudah disiapkan. Cloudflare Workers paling tidak cocok untuk beta minim perubahan.

## Sources tambahan

- https://render.com/docs/free
- https://render.com/docs/web-services
- https://render.com/docs/faq
- https://developers.cloudflare.com/workers/platform/limits/

## Hasil production build

`pnpm build` berhasil. Backend bundle menghasilkan `dist/index.js` sekitar 114.5 KB; total `dist` sekitar 16 MB. Frontend build menghasilkan beberapa chunk besar, termasuk entry sekitar 2.38 MB dan beberapa chunk syntax/diagram ratusan KB. Build memberi warning chunk di atas 500 KB, tetapi tidak gagal. Ini bukan blocker beta pertama, namun menjadi catatan optimasi performa.
