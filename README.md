# VidsGoo

VidsGoo adalah dashboard lokal dan ekstensi Chrome untuk mengantrekan prompt, menjalankan pembuatan video di Google Vids, mengunduh hasilnya, dan menampilkannya dalam satu galeri.

> [!IMPORTANT]
> Proyek ini tidak berafiliasi dengan atau didukung oleh Google. Gunakan hanya pada akun dan konten yang Anda berhak kelola, serta patuhi persyaratan layanan Google.

## Fitur

- Prompt tunggal atau batch dengan pemisah `=== PROMPT BARU ===`.
- Pilihan rasio lanskap (16:9), potret (9:16), dan persegi (1:1).
- Antrean task dengan status Submitting, Rendering, Downloading, Completed, dan Failed.
- Dukungan beberapa agen ekstensi Chrome dengan heartbeat, cooldown, retry, dan auto-recovery.
- Trusted click melalui Chrome DevTools Protocol untuk kontrol Google Vids yang menolak klik DOM sintetis.
- Download terverifikasi: task baru dianggap selesai setelah Chrome mengonfirmasi file unduhan.
- Galeri lokal untuk MP4/WebM dari server dan folder `Downloads/Google_Vids`.
- Validasi origin, token konfirmasi penghapusan, allowlist URL, dan sanitasi data dashboard.

## Persyaratan

- Node.js 18 atau lebih baru.
- Google Chrome atau browser Chromium yang mendukung ekstensi Manifest V3.
- Akun Google yang memiliki akses ke Google Vids dan fitur pembuatan video AI.

## Instalasi

```bash
git clone https://github.com/effands/vidsgoo.git
cd vidsgoo
npm install
```

Muat ekstensi Chrome:

1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode**.
3. Pilih **Load unpacked** lalu arahkan ke folder `extension`.
4. Pin ekstensi **Google Vids AI Generator & Downloader** bila diperlukan.

## Menjalankan

```bash
npm start
```

Buka [http://127.0.0.1:7890](http://127.0.0.1:7890), lalu:

1. Pastikan ekstensi aktif dan tab Google Vids tersedia.
2. Masukkan URL dokumen Google Vids, prompt, serta rasio video.
3. Untuk batch, pisahkan setiap prompt dengan baris `=== PROMPT BARU ===`.
4. Tambahkan task dan pantau progres pada dashboard.
5. Hasil yang selesai diunduh akan muncul di galeri.

Di Windows, `start_server.bat` dapat digunakan untuk memasang dependency yang belum tersedia, menghentikan instance server lama pada port 7890, lalu membuka dashboard.

## Cara kerja

```text
Dashboard -> Server antrean -> Ekstensi Chrome -> Google Vids
    ^                 |                |
    |                 +-- progres -----+
    +---------- galeri hasil unduhan --+
```

Ekstensi mengambil satu task dari server lokal. Content script menemukan kontrol Google Vids dan background worker mengirim klik mouse tepercaya hanya pada URL `https://docs.google.com/videos/`. Setelah render menghasilkan URL video baru, Chrome mengunduh file dan melaporkan status Completed ketika unduhan benar-benar selesai.

Chrome dapat menampilkan indikator bahwa DevTools sedang mengontrol tab selama trusted click berlangsung. Debugger dilepas kembali setelah klik selesai atau task gagal.

## Pengujian

```bash
npm test
```

Suite mencakup parsing batch, validasi file/path galeri, lifecycle server, keamanan dashboard, allowlist ekstensi, trusted click, dan verifikasi download.

## Struktur proyek

- `server.js` — server Express, antrean, lifecycle task, dan API galeri.
- `public/index.html` — dashboard lokal.
- `extension/` — ekstensi Chrome Manifest V3.
- `lib/job-utils.js` — parsing prompt dan validasi file/path.
- `test/` — test otomatis berbasis Node.js test runner.
- `index.js` — mode otomasi Playwright eksperimental/legacy.

## Batasan

- Selector antarmuka Google Vids dapat berubah sewaktu-waktu.
- VidsGoo tidak melewati login, izin akun, kuota, atau pembatasan layanan Google.
- Biarkan server lokal berjalan selama agen ekstensi memproses antrean.
- Folder profil browser (`user_data`) dan hasil unduhan tidak dilacak Git untuk mencegah data sesi atau file besar ikut terpublikasi.

## Rilis

Lihat halaman [Releases](https://github.com/effands/vidsgoo/releases) untuk catatan versi dan video demo.
