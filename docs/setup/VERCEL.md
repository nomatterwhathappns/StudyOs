# Deployment Vercel

StudyOS menjalankan frontend statis dan backend Express/tRPC dalam satu proyek Vercel. Akses aplikasi memakai **satu akun pemilik dengan username/password**. Konfigurasi AI serta record akun disimpan pada Blob privat yang terenkripsi; tidak diperlukan database SQL atau layanan akun baru.

Panduan ini menjelaskan konfigurasi dan pemeriksaan yang diperlukan. Keberadaan kode atau build yang berhasil tidak membuktikan suatu deployment sudah lolos semua pemeriksaan di bawah.

## Pertahankan data dan perlindungan yang sudah ada

Jika proyek sudah mempunyai AI Connections, pertahankan **Blob store, dokumen `studyos/ai-connections-v1.json`, dan `STUDYOS_AI_MASTER_KEY` yang sama**. Login pemilik menambah dokumen `studyos/owner-auth-v1.json`; migrasi tidak perlu mereset atau menyalin ulang koneksi AI.

Selama menyiapkan dan menguji login, pertahankan **Vercel Authentication untuk All Deployments**, termasuk production. URL deployment lama masih dapat menjalankan kode sebelum owner auth; melepas perlindungannya dapat membuka akses ke konfigurasi lama.

Setelah login owner versi terbaru dan penolakan API anonim sudah diverifikasi, gunakan **Standard Protection** sesuai pengaturan proyek: `all_except_custom_domains`. Hanya domain production terbaru yang dituju boleh menampilkan halaman login aplikasi tanpa meminta akun Vercel. Verifikasi perilaku domainnya sesudah perubahan; jangan mengasumsikan semua alias atau deployment lama aman.

Jangan menonaktifkan Vercel Authentication secara global, mengubahnya menjadi perlindungan preview saja, atau membagikan URL/bypass deployment lama. **URL deployment unik lama harus tetap terlindungi Vercel Authentication.**

## Konfigurasi proyek dan environment Production

1. Hubungkan repo ke proyek Vercel milik pemilik.
2. Gunakan Node.js **24.x**, build command `pnpm build:vercel`, dan output directory `public`.
3. Gunakan Blob store dengan akses **private** yang terhubung ke proyek.
4. Simpan environment server berikut pada target **Production**, lalu deploy ulang.

| Environment                    | Nilai atau sumber                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `STUDYOS_LOCAL_MODE`           | `true`; tidak membutuhkan integrasi OAuth/database lama. Tidak menonaktifkan owner auth.                                              |
| `STUDYOS_OWNER_AUTH`           | `enabled`. Vercel menolak konfigurasi tanpa owner auth; jangan memakai `disabled` sebagai bypass.                                     |
| `STUDYOS_OWNER_SESSION_SECRET` | Secret server acak minimal 32 karakter, hanya untuk cookie sesi. Simpan privat/Sensitive.                                             |
| `STUDYOS_OWNER_SETUP_ENABLED`  | `true` selama setup akun pertama.                                                                                                     |
| `STUDYOS_OWNER_SETUP_KEY`      | Secret setup acak kriptografis setidaknya 256 bit. Pemilik perlu dapat mengambilnya secara privat dari dashboard untuk setup pertama. |
| `STUDYOS_AI_STORAGE`           | `vercel-blob`.                                                                                                                        |
| `STUDYOS_AI_MASTER_KEY`        | Tepat 32 byte acak dalam base64. Pertahankan nilai yang sudah digunakan bila AI Connections sudah ada.                                |
| `BLOB_READ_WRITE_TOKEN`        | Token server Blob privat; alternatifnya `BLOB_STORE_ID` dengan `VERCEL_OIDC_TOKEN` yang disediakan Vercel.                            |
| `STUDYOS_PUBLIC_HOSTS`         | Hostname production/alias resmi yang persis diizinkan, dipisahkan koma; tanpa skema, path, atau wildcard.                             |
| `TAVILY_API_KEY`               | Opsional untuk **Source → Search → Web**.                                                                                             |

Vercel menyediakan `VERCEL=1`. Backend juga memakai hostname deployment/production dari environment platform, ditambah hostname yang diizinkan melalui `STUDYOS_PUBLIC_HOSTS`. Daftar hostname hanya membatasi tujuan request; hostname atau header dari pengunjung tidak menggantikan sesi pemilik.

Jangan menaruh secret dalam `VITE_*`, source code, GitHub, chat, screenshot, atau log. Username/password pemilik tidak ditulis pada environment: pemilik memilihnya langsung pada form web. Key provider dimasukkan kemudian melalui Profile dan berbeda dari master key, session secret, setup key, serta kredensial Blob.

Pisahkan production dari preview. Jangan memberikan preview dokumen owner auth, session secret, setup key, master key, atau Blob state production. Jika preview membutuhkan pengujian lengkap, gunakan konfigurasi privat terpisah dan tetap lindungi deployment-nya.

## Membuat akun pemilik pertama

1. Buka dashboard Vercel proyek → **Settings → Environment Variables**.
2. Cari `STUDYOS_OWNER_SETUP_KEY` untuk Production, lalu gunakan **Reveal/Copy** yang tersedia bagi pemilik proyek. Jangan mengirim nilainya melalui chat.
3. Buka domain production yang memang dituju. Selama migrasi masih dilindungi All Deployments, selesaikan login Vercel terlebih dahulu.
4. Pada **Set up your owner account**, masukkan **Private setup key**, username, password, dan konfirmasi password.
5. Tekan **Create owner account**. Setelah sesi terbentuk, aplikasi membuka workspace.

Username memakai 3–64 huruf ASCII, angka, titik, underscore, atau tanda hubung. Password memakai 14–128 karakter Unicode dan mempertahankan spasi. Pemilik memilih dan mengetik keduanya sendiri pada form; sistem menyimpan hash password, bukan password asli.

Setup hanya dapat membuat satu akun saat record belum mempunyai owner. Bahkan dengan setup key yang benar, setup tidak dapat mengganti akun yang sudah ada. Sesudah akun dibuat, nonaktifkan `STUDYOS_OWNER_SETUP_ENABLED` atau hapus akses setup key dari konfigurasi aktif lalu redeploy; login akun yang sudah tersimpan tetap digunakan. Lihat [panduan owner login](OWNER_LOGIN.md).

## Memakai aplikasi

Masuk dengan username/password StudyOS pada domain production. Akun ini terpisah dari akun Vercel dan GitHub. Jika domain production terbaru sudah memakai konfigurasi Standard Protection yang benar, Vercel Authentication tidak perlu dilalui pada domain itu; URL deployment lama tetap meminta autentikasi Vercel.

Buka **Profile → AI Connections** untuk melihat koneksi yang sudah ada atau menambah koneksi. Isi protokol, URL API, autentikasi/key, dan ID model, lalu **Save connection → Use connection**. Test provider bersifat opsional dan dapat memakai kuota.

Semua API bisnis, chat streaming, upload, dan operasi AI memerlukan sesi pemilik. Token bypass Vercel/OIDC atau izin proyek Vercel hanya melewati perimeter platform; token tersebut tidak menggantikan login owner aplikasi.

Endpoint AI harus dapat dijangkau dari Vercel. `localhost`, `127.0.0.1`, dan alamat LAN tidak menghubungkan deployment ke 9router pada laptop. Gunakan endpoint HTTPS terautentikasi yang dapat dijangkau, atau API cloud provider yang kompatibel.

Pencarian Web memerlukan `TAVILY_API_KEY` tersendiri; pencarian Academic memakai OpenAlex. Data belajar tetap berada di browser dan domain masing-masing.

## Penyimpanan dan backup

Dua objek Blob privat digunakan secara terpisah:

- `studyos/ai-connections-v1.json`: konfigurasi AI, custom headers, dan pilihan koneksi aktif.
- `studyos/owner-auth-v1.json`: username, hash password scrypt, ID sesi yang di-hash, dan batas percobaan login/setup, seluruhnya dalam record terenkripsi.

Owner auth menurunkan kunci terpisah dari `STUDYOS_AI_MASTER_KEY` melalui HKDF. Dokumen AI yang sudah ada tidak diganti. ETag/CAS mencegah perubahan bersamaan menimpa akun atau state sesi. Tidak ada database SQL tambahan; tetap ada satu record akun/sesi persisten pada Blob.

Cadangkan kedua dokumen dan master key yang cocok di lokasi privat. Pertahankan session secret sebagai konfigurasi server privat bila sesi perlu tetap valid. Mengganti session secret membatalkan cookie sesi lama; mengganti master key tanpa migrasi dapat membuat **kedua dokumen tidak terbaca**. Aplikasi tidak mereset dokumen yang rusak atau tidak dapat didekripsi.

Setup disk lokal tidak otomatis diimpor ke Blob. Migrasi data harus dilakukan terkontrol dengan dokumen dan kunci yang tepat. Jangan menghapus state akun atau AI untuk mencoba memperbaiki login. Belum tersedia reset password lewat email atau endpoint reset publik; pemulihan memerlukan akses server/administratif pemilik.

Sesi, materi, chat, catatan, kuis, dan riwayat belajar tetap berada di IndexedDB browser. Sign out mengunci aplikasi dan membersihkan state memori, tetapi tidak menghapus atau mengenkripsi ulang data belajar browser.

## Pemeriksaan deployment

- Status deployment harus **Ready**.
- Tanpa sesi owner, domain production terbaru harus menampilkan setup/login, bukan workspace.
- Request bisnis anonim ke tRPC, streaming chat, serta upload harus ditolak meskipun perimeter Vercel dapat dilewati.
- Setelah pemilik menyelesaikan setup/login, halaman utama, `/sessions`, dan `/studych` dapat dibuka langsung dan setelah refresh.
- Sign out mencabut sesi aktif; request bisnis dengan cookie lama harus ditolak.
- Setup kedua tidak dapat mengganti akun yang sudah ada.
- Koneksi AI lama tetap terbaca dan terpilih setelah migrasi; key dan nilai custom headers tidak dikembalikan ke browser.
- Domain production yang dituju menampilkan gate owner, sedangkan URL unik deployment lama tetap dilindungi Vercel Authentication.
- Provider nyata diuji oleh pemilik melalui **Test connection** dan fitur AI; tes dengan mock tidak membuktikan kuota atau izin model.

Build menjalankan TypeScript dan menghasilkan `dist/serverless.js` yang dimuat `api/server.mjs`. `pnpm verify:vercel` memeriksa infrastruktur/build sesuai mode aktif, termasuk penolakan akses bisnis anonim pada owner mode. Pemeriksaan infrastruktur tidak membuat username/password pemilik atau menggantikan pengujian login browser dengan kredensial yang dipilih pemilik.

Konfigurasi function membatasi durasi ke 300 detik; upload frontend Vercel dibatasi 3 MB. Ekstraksi PDF memakai `unpdf` yang dimuat saat diperlukan. Pemeriksaan runtime atau provider tetap dilakukan tanpa mencetak secret ke log.
