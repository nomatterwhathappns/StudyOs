# Konfigurasi Google Gemini

StudyOS mendukung key Gemini tingkat server dan personal key milik pengguna yang sudah login. Request ke Google dibuat oleh backend. Key pribadi yang dimasukkan melalui form pengaturan dikirim ke server untuk disimpan terenkripsi; nilainya tidak disimpan di browser storage atau dikembalikan oleh API status.

## 1. Nonaktifkan mode 9router

Pengaturan AI mengunci pilihan model ke 9router ketika gateway tersebut aktif. Untuk memilih Gemini, atur environment server sebagai berikut:

```env
STUDYOS_LOCAL_MODE=false
STUDYOS_AI_ROUTER_ENABLED=false
```

Jika sebelumnya memakai [.env.local.example](../../.env.local.example), ubah nilai `STUDYOS_LOCAL_MODE` dalam `.env` yang sudah disalin. Pada hosting, gunakan pengaturan environment platform.

## 2. Pilih cara menyimpan key

### Key tingkat server

Tambahkan key dari Google AI Studio pada `.env` di folder yang sama dengan `package.json`, atau pada environment server hosting:

```env
GOOGLE_GENERATIVE_AI_API_KEY=replace-with-your-google-ai-studio-key
```

Adapter [Google Gemini](../../server/googleGemini.ts) menggunakan key server ketika request tidak mempunyai personal key. Key tingkat server digunakan oleh operasi nonstreaming seperti Explain dan pembuatan kuis.

**Batas jalur chat saat ini:** handler [chat streaming](../../server/studyChatStream.ts) belum mengambil key dari `GOOGLE_GENERATIVE_AI_API_KEY` ketika pengguna tidak mempunyai personal key. Dalam keadaan tersebut, chat mencoba fallback gateway bawaan. Key server saja belum cukup untuk memastikan chat memakai Gemini; periksa label provider pada jawaban.

### Personal key melalui AI settings

Cara ini memerlukan:

- Login yang berfungsi melalui konfigurasi `VITE_APP_ID`, `VITE_OAUTH_PORTAL_URL`, dan `OAUTH_SERVER_URL`.
- Database MySQL pada `DATABASE_URL`, dengan migrasi tabel pengguna serta `aiProviderCredentials` sudah diterapkan.
- `JWT_SECRET` yang dikonfigurasi pada server untuk sesi dan enkripsi kredensial.

Setelah login, buka **AI settings**, pilih model Google Gemini, lalu isi **Gemini API key** dan tekan **Save key**. Key bisa diganti atau dihapus dari pengaturan yang sama. Simpan juga pilihan model dengan **Save settings**.

Personal key disimpan dengan enkripsi AES-256-GCM. Pertahankan nilai `JWT_SECRET`: menggantinya membuat kredensial yang dienkripsi dengan nilai lama tidak dapat dibaca, sehingga pengguna perlu menyimpan ulang key. Jika personal key tersedia, backend memprioritaskannya terhadap key tingkat server.

## 3. Jalankan atau restart aplikasi

Untuk development setelah dependensi terpasang:

```bash
pnpm dev
```

Jika server sudah berjalan, hentikan lalu jalankan kembali setelah perubahan `.env`. Pada hosting, restart atau redeploy sesuai mekanisme platform agar environment baru diterapkan.

## Model dan pemeriksaan hasil

Model Google sebenarnya ditentukan oleh adapter backend, bukan oleh nama repo atau variabel model 9router. Saat panduan ini ditulis, [adapter Gemini](../../server/googleGemini.ts) menetapkan `gemini-3.6-flash`, sedangkan ID pilihan internal aplikasi masih `gemini-3-flash-preview`.

Ketersediaan model, izin key, dan kuota bergantung pada akun/provider. Label provider di bawah jawaban menunjukkan jalur yang benar-benar digunakan, termasuk ketika terjadi fallback. Panduan ini menjelaskan implementasi kode; panduan ini tidak menyatakan koneksi ke Google atau model tersebut sudah diuji langsung.

Jangan commit `.env`, menaruh key pada variabel `VITE_*`, menyisipkannya ke kode frontend, atau menyalinnya ke log. Jika key terpapar, cabut key tersebut melalui Google AI Studio dan ganti dengan key baru.

Lihat [README](../../README.md) untuk setup proyek dan konfigurasi layanan lainnya.
