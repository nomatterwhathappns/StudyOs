# Deployment Vercel

StudyOS menjalankan frontend statis dan backend Express/tRPC pada satu proyek Vercel. Koneksi AI disimpan terenkripsi di **Blob store privat**, dengan **Vercel Authentication** sebagai pembatas akses ke seluruh deployment. Setelah infrastruktur siap, URL, key, dan model provider diisi melalui **Profile → AI Connections**.

## Konfigurasi proyek

1. Hubungkan repository StudyOs ke proyek Vercel yang dimiliki akun Anda.
2. Gunakan Node.js **24.x**, build command `pnpm build:vercel`, dan output directory `public`. Instalasi mengikuti `pnpm-lock.yaml` serta versi pnpm pada `packageManager`.
3. Pada **Settings → Deployment Protection**, aktifkan **Vercel Authentication untuk All Deployments**, termasuk production. Perlindungan seluruh deployment tersedia pada paket Hobby. Jangan mengaktifkan akses cloud AI hanya dengan perlindungan preview atau menganggap domain production otomatis terlindungi.
4. Buat **Blob store dengan akses private**, lalu hubungkan ke proyek. Pastikan aksesnya private saat membuat store.
5. Tambahkan environment server pada tabel berikut ke target **Production**, lalu deploy ulang jika nilainya berubah.

| Environment             | Nilai atau sumber                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `STUDYOS_LOCAL_MODE`    | `true`; tetap memakai data belajar di browser dan tidak memerlukan integrasi OAuth/database lama.                          |
| `STUDYOS_AI_STORAGE`    | `vercel-blob`                                                                                                              |
| `STUDYOS_AI_MASTER_KEY` | Tepat 32 byte acak kriptografis yang dienkode base64. Simpan sebagai secret server.                                        |
| `STUDYOS_CLOUD_ACCESS`  | `vercel-protected`                                                                                                         |
| `BLOB_READ_WRITE_TOKEN` | Token server dari koneksi Blob store privat; alternatifnya gunakan `BLOB_STORE_ID` dengan `VERCEL_OIDC_TOKEN` dari Vercel. |
| `STUDYOS_PUBLIC_HOSTS`  | Opsional: hostname tambahan yang persis diizinkan, dipisahkan koma. Jangan isi skema URL, path, atau wildcard.             |
| `TAVILY_API_KEY`        | Opsional untuk **Source → Search → Web**. Tidak diperlukan untuk mengatur koneksi AI.                                      |

Vercel menyediakan `VERCEL=1` dan hostname deployment melalui system environment. Backend memakai hostname deployment, branch, dan production yang dipercaya dari environment tersebut. Hostname tambahan pada `STUDYOS_PUBLIC_HOSTS` juga wajib dilindungi Vercel Authentication; izin hostname aplikasi bukan pengganti perlindungan deployment.

Jangan memasukkan secret dalam variabel `VITE_*`, source code, log, screenshot, atau commit Git. Key provider berbeda dari `STUDYOS_AI_MASTER_KEY` dan kredensial Blob: provider key diisi melalui Profile, sedangkan dua secret infrastruktur tersebut tetap hanya berada pada server.

Berikan kredensial Blob dan master key ke target **Production** saja. Preview tanpa konfigurasi cloud tidak dapat mengelola atau memakai koneksi AI. Jika AI perlu diuji pada preview, gunakan Blob store dan master key terpisah; jangan menghubungkan preview ke dokumen konfigurasi production yang sama.

## Memakai web setelah deploy

1. Buka URL production dan masuk dengan akun Vercel yang diberi akses proyek.
2. Buka **Profile → AI Connections → Add connection**.
3. Pilih protokol yang didukung layanan, lalu isi URL API, autentikasi/key, dan ID model.
4. Gunakan **Test connection** untuk memeriksa endpoint, lalu **Save connection → Use connection**. Test dapat memakai kuota API.
5. Coba chat atau fitur belajar AI menggunakan koneksi aktif.

Semua orang yang diberi akses deployment dapat mengelola serta memakai koneksi AI bersama. Jangan membagikan akses deployment atau kredensial bypass kepada orang yang tidak boleh memakai key tersebut. Implementasi ini bukan layanan publik dengan akun serta koneksi AI terpisah untuk masing-masing pengguna.

Endpoint API harus dapat dijangkau dari backend Vercel. `localhost`, `127.0.0.1`, dan alamat LAN merujuk jaringan server, sehingga tidak dapat dipakai untuk menghubungi 9router pada laptop. Untuk gateway laptop, sediakan endpoint HTTPS yang dapat dijangkau dan dilindungi autentikasi; pilihan lain adalah API cloud provider langsung. Format API, ID model, hak akses akun, dan kuota tetap harus sesuai.

**Source → Search → Web** memerlukan key Tavily tersendiri; pencarian Academic memakai OpenAlex. Chat dan fitur AI memakai koneksi aktif dari Profile. Menyiapkan satu key AI tidak mengonfigurasi semua layanan eksternal.

## Penyimpanan dan backup

Blob `studyos/ai-connections-v1.json` berisi koneksi terenkripsi, custom headers, dan pilihan koneksi aktif. Backend membaca data terbaru serta memperbarui dengan ETag untuk mendeteksi konflik antar-instance. Backend tidak menulis konfigurasi ke filesystem function dan tidak membuat kunci enkripsi baru pada setiap restart.

Cadangkan **dokumen terenkripsi dan master key yang cocok** sebagai satu pasangan di lokasi privat. Jangan mengganti atau menghapus `STUDYOS_AI_MASTER_KEY` saat redeploy: kunci baru tidak dapat membuka dokumen lama. Memulihkan koneksi perlu Blob store yang dapat diakses, dokumen yang utuh, dan master key asal. Aplikasi menolak data yang rusak atau tidak dapat didekripsi; data lama tidak direset secara diam-diam.

Setup lokal dengan `.studyos/connections.json` dan `.studyos/master.key` tidak otomatis diimpor ke Blob. Siapkan kembali koneksi melalui Profile pada deployment, atau lakukan migrasi terkontrol dengan mempertahankan pasangan dokumen dan kunci. Jangan menyalin master key lokal ke repository.

Sesi, materi, catatan, chat, kuis, dan riwayat belajar tetap disimpan di **IndexedDB browser**. Data pada localhost atau domain lain tidak otomatis muncul pada URL Vercel. Menghapus data situs dapat menghapus data belajar meskipun koneksi AI cloud tetap tersimpan.

## Pemeriksaan deployment

Build menjalankan pengecekan TypeScript, lalu mengemas `server/vercel.ts` ke `dist/serverless.js`. Entrypoint `api/server.mjs` memuat hasil kompilasi tersebut. Pada production, `pnpm verify:vercel` memeriksa baca/tulis Blob privat dan penolakan ETag yang sudah kedaluwarsa memakai objek uji terpisah yang langsung dihapus; koneksi pemilik tidak diubah.

Environment opsional `STUDYOS_VERIFY_DEPLOYMENT` dapat menunjuk URL HTTPS production proyek yang sudah tersedia untuk pemeriksaan HTTP terautentikasi saat build. Pemeriksaan memakai identitas OIDC production proyek sendiri, tanpa membuat tautan share atau mengubah Deployment Protection. Jika aturan Trusted Sources belum mengizinkannya, jangan melonggarkan perlindungan; kosongkan variabel ini dan periksa lewat sesi login pemilik.

- Status deployment harus **Ready**; commit yang berhasil disimpan di GitHub belum membuktikan deploy berhasil.
- Akses tanpa login ke halaman maupun `/api/` harus ditahan oleh perlindungan Vercel.
- Setelah login, halaman utama, `/sessions`, dan `/studych` harus dapat dibuka langsung serta setelah refresh.
- Daftar koneksi harus dapat dibuka, disimpan, dan dibaca kembali setelah request atau instance berikutnya. Key dan nilai custom headers tidak dikirim kembali ke browser.
- Tes provider nyata melalui **Test connection** dan permintaan AI setelah mengaktifkan koneksi; build dan tes dengan mock tidak membuktikan akun provider memiliki kuota atau model yang diperlukan.

Konfigurasi function membatasi durasi ke 300 detik. Batas timeout koneksi yang lebih besar tetap tunduk pada batas function. Upload frontend pada build Vercel dibatasi 3 MB. Periksa log runtime Vercel jika API mengembalikan error; jangan menyalin secret ke log diagnosis.
