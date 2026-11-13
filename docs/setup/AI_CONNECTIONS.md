# AI Connections

Atur koneksi AI melalui **Profile → AI Connections**. Bagian ini tersedia pada tampilan desktop dan mobile. Pengaturan di sidebar juga membuka bagian Profile tersebut.

Koneksi disimpan oleh backend dan dipakai oleh seluruh fitur belajar yang membutuhkan AI. Model selalu ditentukan dari koneksi aktif; tidak ada provider bawaan atau fallback otomatis ke koneksi lain.

## Menambahkan dan memilih koneksi

1. Tekan **Add connection**.
2. Isi **Connection name**, pilih **API protocol**, lalu masukkan **Base URL**.
3. Pilih cara autentikasi yang diminta API dan masukkan key jika diperlukan.
4. Isi **Model** dengan ID yang persis diterima endpoint. Kolom manual tetap tersedia walaupun endpoint tidak menyediakan daftar model.
5. Opsional: **Fetch models** mengambil daftar dari endpoint; pilih hasil pada **Available models** untuk mengisi Model. **Test connection** mencoba konfigurasi form tanpa mewajibkan penyimpanan terlebih dahulu.
6. Tekan **Save connection**, lalu **Use connection** pada koneksi yang ingin dipakai. Tanda **Active** menunjukkan pilihan aktif.

Kegagalan mengambil model atau mengetes koneksi tidak otomatis membuktikan semua operasi API gagal. Beberapa gateway hanya menyediakan endpoint generasi atau membatasi izin daftar model. Sebaliknya, menyimpan konfigurasi tidak membuktikan key/model dapat digunakan. Test dan discovery menghubungi API dan dapat memakai kuota atau batas request.

Setelah disimpan, koneksi dapat diedit, dites, diaktifkan, atau dihapus. Menghapus koneksi aktif membuat pengguna perlu memilih koneksi lain; aplikasi tidak memilih pengganti secara diam-diam.

## Memilih format API

| Pilihan UI | Base URL yang umum | Autentikasi yang umum |
| --- | --- | --- |
| OpenAI-compatible Chat Completions | `https://api.openai.com/v1` atau base URL gateway yang kompatibel | Bearer token |
| OpenAI Responses | `https://api.openai.com/v1` atau base URL Responses yang kompatibel | Bearer token |
| Anthropic Messages | `https://api.anthropic.com/v1` | Custom authentication header: `x-api-key` |
| Google Generative Language | `https://generativelanguage.googleapis.com/v1beta` | Custom authentication header: `x-goog-api-key` |

URL di atas merupakan contoh format, bukan jaminan izin akun, ketersediaan model, atau koneksi yang sudah diuji langsung. Model tidak ditetapkan oleh contoh tersebut.

Gunakan base URL API sesuai dokumentasi layanan. Adapter menambahkan jalur operasinya, seperti `/chat/completions`, `/responses`, atau `/messages`. Query nonsecret seperti versi API dapat dipertahankan pada URL jika layanan membutuhkannya. Jangan menaruh key pada query URL, username/password URL, atau fragmen.

Endpoint yang memakai bentuk body, respons, autentikasi, atau streaming di luar empat protokol tersebut memerlukan adapter tambahan. Memilih format OpenAI-compatible tidak membuat format API khusus menjadi kompatibel.

## Autentikasi dan secret

Pada **Advanced settings**, pilih salah satu:

- **Bearer token**: key dikirim melalui `Authorization: Bearer …`.
- **Custom authentication header**: isi nama header yang diminta layanan, misalnya `x-api-key` atau `x-studyos-token`, lalu masukkan nilainya pada API key.
- **No authentication**: hanya untuk endpoint yang memang tidak memerlukan autentikasi.

**Custom headers JSON** menerima objek pasangan nama dan nilai header tambahan. Sebagian header transport, cookie, dan `Authorization` tidak boleh diganti melalui field ini; gunakan pengaturan autentikasi khusus untuk `Authorization`. Header `anthropic-version` diberi nilai default oleh adapter Anthropic bila tidak disediakan.

Saat mengedit, kolom API key kosong mempertahankan key tersimpan. **Remove saved key** menghapusnya secara eksplisit. Custom headers yang dibiarkan kosong juga tetap dipertahankan; mengisi JSON baru mengganti seluruh daftar header, sedangkan **Remove saved headers** menghapusnya.

Form tidak mengisi ulang key atau nilai header tersimpan. Daftar koneksi hanya menampilkan status key, suffix, dan nama header. Key serta custom headers baru hanya ada dalam memori form selama pengisian dan dikirim ke backend saat diperlukan.

## Opsi lanjutan

| Opsi | Fungsi |
| --- | --- |
| **Stream responses** | Meminta respons streaming bila API mendukungnya. Matikan untuk gateway yang hanya mengembalikan JSON utuh. |
| **Timeout** | Batas waktu generasi AI sesuai koneksi. Test/discovery memakai batas lebih singkat; batas server/hosting juga tetap berlaku. |
| **Max output tokens** | Batas atas keluaran koneksi. Fitur belajar juga memiliki anggaran token, sehingga request dapat memakai batas yang lebih kecil. |
| **Token parameter** | Untuk Chat Completions: `auto`, `max_tokens`, `max_completion_tokens`, atau tanpa parameter. Gunakan sesuai API dan model. |
| **JSON output** | Mode prompt meminta keluaran JSON lewat instruksi. Mode native menambahkan opsi JSON protokol yang didukung endpoint. |

Native JSON tersedia melalui opsi OpenAI Chat Completions, OpenAI Responses, dan Google yang diimplementasikan adapter. Jalur Anthropic menggunakan instruksi JSON pada prompt. Dukungan JSON tetap bergantung pada endpoint/model; mode native bukan jaminan semua model menerima format tersebut.

Kegagalan API, autentikasi, atau kuota dikembalikan sebagai error dari koneksi tersebut. Aplikasi tidak mengirim request ke provider lain untuk mengatasi kegagalan. Upaya memperbaiki keluaran JSON pada fitur tertentu tetap memakai koneksi yang sama.

## Contoh gateway 9router lokal

Jalankan 9router secara terpisah, lalu tambahkan koneksi:

- **API protocol**: OpenAI-compatible Chat Completions.
- **Base URL**: base URL HTTP loopback milik 9router, misalnya `http://127.0.0.1:20127/v1`; sesuaikan port dengan layanan yang berjalan.
- **Authentication**: Bearer token, dengan proxy key 9router.
- **Model**: ID model atau combo yang benar-benar dikonfigurasi pada 9router.

Gunakan **Save connection → Use connection**. StudyOS tidak menyalakan 9router, membundel model, atau memerlukan mode provider khusus untuk gateway ini. HTTP loopback hanya dapat diakses oleh backend pada mesin yang sama; saat StudyOS dipindah ke server lain, `127.0.0.1` menunjuk server tersebut.

## Lokasi data dan akses

Default direktori data adalah `.studyos/` pada working directory server. `STUDYOS_DATA_DIR` dapat menunjuk direktori privat persisten lain. `connections.json` berisi konfigurasi terenkripsi dan `master.key` berisi kunci lokalnya. Penyimpanan ini terpisah dari `JWT_SECRET` serta MySQL.

Untuk backup atau migrasi, hentikan server dan salin kedua file sebagai satu pasangan ke lokasi privat milik proses server. Memiliki kedua file memungkinkan pemilik server membaca konfigurasi; jangan membagikan atau commit direktori data. Jika kunci hilang atau file rusak, aplikasi tidak dapat membaca koneksi lama dan tidak meresetnya secara diam-diam.

Akses koneksi dibatasi ke request localhost pada server yang sama atau administrator yang sudah login. Membuka aplikasi lewat alamat LAN, domain, atau reverse proxy tidak otomatis memberikan akses sebagai localhost. Penyimpanan merupakan konfigurasi milik satu server; tidak menyediakan koneksi terisolasi per akun atau sinkronisasi antar-instance.

Gunakan satu proses Node dan disk persisten. Filesystem function serverless yang sementara/read-only tidak cocok untuk menyimpan konfigurasi ini secara permanen. Lihat [README](../../README.md#deployment-dan-persistensi) untuk batas deployment.

## Migrasi dari konfigurasi AI lama

Variabel lama seperti `STUDYOS_LOCAL_AI_ROUTER_*`, `STUDYOS_AI_ROUTER_*`, `GOOGLE_GENERATIVE_AI_API_KEY`, dan gateway AI bawaan tidak lagi memilih atau mengaktifkan koneksi AI. Kredensial Gemini pribadi dari integrasi lama juga tidak diimpor otomatis.

1. Siapkan kembali URL endpoint, key, protokol, dan ID model dari sumber/provider asal.
2. Tambahkan koneksi melalui Profile. Gunakan protokol Google untuk Google Generative Language, atau format OpenAI-compatible untuk gateway yang mendukungnya.
3. Opsional: tes koneksi, kemudian simpan dan aktifkan.
4. Setelah memastikan konfigurasi baru digunakan, hapus atau arsipkan konfigurasi AI lama secara privat.

`STUDYOS_LOCAL_MODE` sekarang hanya menentukan jalur aplikasi lokal dibandingkan OAuth/storage cloud. Flag tersebut tidak memilih 9router atau provider AI lain. Mengganti konfigurasi koneksi tidak memigrasikan atau menghapus sesi belajar, materi, dan catatan di IndexedDB browser.

Lihat [README](../../README.md) untuk setup aplikasi dan environment non-AI.
