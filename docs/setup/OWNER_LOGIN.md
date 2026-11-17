# Login satu pemilik

StudyOS menyediakan satu akun pemilik dengan username/password. Akun ini terpisah dari nama Profile belajar, akun GitHub, dan akun Vercel. Tidak ada pendaftaran umum atau akun pengguna lain.

Login ini tidak menambah database SQL. Pada Vercel, satu dokumen owner auth terenkripsi disimpan pada Blob privat yang sudah digunakan proyek. Password asli tidak disimpan; server membuat hash scrypt dengan salt acak.

## Konfigurasi server

Pada Vercel, siapkan environment Production berikut:

| Variabel                           | Fungsi                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `STUDYOS_OWNER_AUTH=enabled`       | Mengaktifkan gate akun pemilik. Wajib pada Vercel.                                            |
| `STUDYOS_OWNER_SESSION_SECRET`     | Secret acak server minimal 32 karakter untuk menyegel cookie sesi.                            |
| `STUDYOS_OWNER_SETUP_ENABLED=true` | Membuka setup akun pertama dengan private setup key.                                          |
| `STUDYOS_OWNER_SETUP_KEY`          | Secret setup acak kriptografis minimal 256 bit; dibutuhkan pemilik saat membuat akun pertama. |

Pertahankan `STUDYOS_AI_STORAGE=vercel-blob`, Blob privat, dan `STUDYOS_AI_MASTER_KEY` yang sudah dipakai koneksi AI. Daftar hostname pada `STUDYOS_PUBLIC_HOSTS` harus sesuai domain deployment. `STUDYOS_LOCAL_MODE=true` tetap dapat dipakai; flag tersebut tidak mematikan owner auth.

Secret disimpan pada environment server privat. Password dan username **tidak** diatur melalui environment: pemilik mengetikkannya sendiri pada form web. Jangan menyalin setup key, session secret, master key, atau password ke GitHub/chat.

## Setup akun pertama

1. Dari Vercel proyek, buka **Settings → Environment Variables**.
2. Temukan `STUDYOS_OWNER_SETUP_KEY` milik target Production dan gunakan **Reveal/Copy** sesuai hak akses pemilik.
3. Buka domain production yang dituju. Bila Vercel Authentication masih melindunginya selama migrasi, selesaikan lapisan login Vercel terlebih dahulu.
4. Pada **Set up your owner account**, isi:
   - **Private setup key**: nilai dari environment proyek.
   - **Username**: nama login yang dipilih sendiri.
   - **Password** dan **Confirm password**: password yang dipilih sendiri.
5. Tekan **Create owner account**. Aplikasi memastikan cookie sesi dapat dipakai sebelum membuka workspace.

Username memakai **3–64** karakter ASCII: huruf, angka, titik, underscore, dan tanda hubung. Pencocokan username saat login tidak membedakan huruf besar/kecil. Password memakai **14–128 karakter Unicode** yang dihitung sebagai code point; spasi dan kapitalisasi password dipertahankan.

Setup memerlukan private setup key berentropi tinggi. Pengunjung pertama tidak cukup hanya membuka form untuk mengambil alih akun. Setelah owner tersimpan, setup lain tidak dapat menggantinya, termasuk ketika setup key masih tersedia. Request setup bersamaan juga tidak boleh menimpa owner yang lebih dulu dibuat.

Setelah setup selesai, tutup tahap setup dengan menonaktifkan `STUDYOS_OWNER_SETUP_ENABLED` atau menghapus setup key dari environment aktif lalu redeploy. Jangan menghapus record akun atau mengganti master key. Username/password yang sudah dibuat tetap digunakan untuk login selanjutnya.

## Login, sesi, dan sign out

Kunjungan berikutnya menampilkan **Welcome back**. Isi username/password lalu tekan **Sign in**; private setup key tidak diperlukan lagi.

Cookie sesi disegel dengan `iron-session`, bersifat HttpOnly dan SameSite Strict, serta Secure pada HTTPS production. Pengecualian HTTP hanya untuk loopback development. Sesi memiliki batas 24 jam dan server menyimpan maksimal 10 sesi aktif; login baru dapat mengeluarkan sesi tertua. Server hanya menyimpan hash ID sesi.

Buka Profile lalu tekan **Sign out** untuk mencabut sesi saat ini. Aplikasi membatalkan request aktif, membersihkan state memori, dan mengunci workspace. Jika server belum mengonfirmasi sign out, UI tetap terkunci dan meminta percobaan ulang.

Sign out **tidak menghapus IndexedDB**. Materi, catatan, chat, dan riwayat tetap ada pada browser/domain yang sama ketika pemilik masuk lagi. Login bukan enkripsi baru untuk data browser yang sudah tersimpan; gunakan profil browser pribadi pada perangkat bersama.

Percobaan login/setup dibatasi dan dicatat secara persisten. Jika muncul pesan terlalu banyak percobaan, tunggu sesuai batas server sebelum mencoba lagi. Restart atau redeploy tidak dimaksudkan untuk menghapus batas tersebut.

## Akses API dan perlindungan deployment

Saat owner auth aktif, seluruh API bisnis, AI Connections, streaming chat, dan upload membutuhkan sesi pemilik yang valid. Endpoint status/setup/login hanya melayani tahap autentikasi dengan pemeriksaan asal request dan pembatasan yang sesuai.

Vercel Authentication dan owner login merupakan dua lapisan berbeda. Token bypass/OIDC Vercel tidak menggantikan cookie login aplikasi.

Selama migrasi, pertahankan Vercel Authentication untuk seluruh deployment. Sesudah versi terbaru diverifikasi, domain production yang dituju dapat menampilkan owner login dengan Standard Protection, tetapi **URL deployment lama tetap harus dilindungi Vercel Authentication**. Jangan menonaktifkan perlindungan proyek secara global atau membuka URL lama yang belum mempunyai gate owner. Lihat [panduan Vercel](VERCEL.md).

Sebelum melakukan rollback ke versi yang belum mempunyai owner login, aktifkan kembali **All Deployments**. Versi lama masih mengandalkan perlindungan Vercel untuk membatasi pemakaian koneksi AI; jangan memetakan domain production yang terbuka ke versi tersebut.

## Penyimpanan, backup, dan pemulihan

Pada Vercel:

- `studyos/owner-auth-v1.json` menyimpan username, hash password, hash ID sesi, dan state pembatasan percobaan dalam dokumen terenkripsi.
- Kunci owner auth diturunkan dari `STUDYOS_AI_MASTER_KEY` dengan konteks terpisah dari koneksi AI.
- `studyos/ai-connections-v1.json` yang sudah ada tetap dipakai dan tidak direset oleh setup akun.

Pada disk lokal, owner auth menggunakan `owner-auth.json` dan `owner-auth.key` dalam `STUDYOS_DATA_DIR` atau `.studyos/` default. File akun serta kuncinya terpisah dari `connections.json` dan `master.key` milik AI. File lock hanya mengatur pembaruan; bukan backup akun.

Cadangkan dokumen terenkripsi bersama kunci yang cocok secara privat. Pertahankan master key untuk menjaga akun **dan** koneksi AI. Mengubah session secret membatalkan cookie lama; perubahan tersebut tidak mengganti password atau mereset akun.

Saat ini belum tersedia reset password lewat email, endpoint reset publik, atau perubahan username/password melalui UI. Jika kredensial terlupa, pemulihan memerlukan tindakan pemilik melalui akses server/administratif yang terkontrol. Jangan menghapus dokumen AI, mengganti master key, atau mengaktifkan ulang setup dengan harapan dapat mengganti akun lama. Simpan password pada password manager milik pemilik.

## Mengaktifkan login pada localhost

Mode aplikasi lokal tanpa flag owner auth tetap berjalan tanpa login untuk kompatibilitas. Untuk menguji gate yang sama di localhost, tambahkan pada `.env`:

```env
STUDYOS_OWNER_AUTH=enabled
STUDYOS_OWNER_SESSION_SECRET=<secret-acak-privat-minimal-32-karakter>
STUDYOS_OWNER_SETUP_ENABLED=true
STUDYOS_OWNER_SETUP_KEY=<setup-key-acak-privat-minimal-256-bit>
```

Placeholder di atas harus diganti dengan nilai acak yang dibuat serta disimpan secara privat, bukan password pengguna. Restart server, buka alamat localhost, lalu buat username/password pada form dengan private setup key tersebut. Login lokal tidak perlu SQL, OAuth lama, atau akun Vercel.

Mengubah flag ini pada Vercel menjadi tidak aktif tidak membuka akses tanpa login; konfigurasi Vercel tanpa owner auth yang valid ditolak. Lihat [README](../../README.md) untuk environment dan setup proyek.
