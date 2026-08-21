# VidsGoo v1.0.0

Rilis publik pertama VidsGoo: otomasi batch Google Vids melalui dashboard lokal dan ekstensi Chrome.

## Sorotan

- Antrean prompt tunggal dan batch untuk Google Vids.
- Dukungan rasio 16:9, 9:16, dan 1:1.
- Multi-agent Chrome dengan heartbeat, cooldown, retry, dan auto-recovery.
- Trusted click berbasis Chrome DevTools Protocol pada tab Google Vids yang diizinkan.
- Lifecycle lengkap dari submitting hingga download terverifikasi.
- Galeri MP4/WebM lokal dengan pemutaran dan penghapusan aman.
- Perlindungan same-origin, token konfirmasi hapus, validasi path/file, dan rendering payload tanpa HTML injection.
- Test otomatis untuk server, dashboard, parser, galeri, dan ekstensi.

## Instalasi singkat

1. Unduh source code rilis dan jalankan `npm install`.
2. Muat folder `extension` melalui halaman `chrome://extensions` dengan Developer mode aktif.
3. Jalankan `npm start` dan buka `http://127.0.0.1:7890`.

## Catatan

- Memerlukan akses Google Vids dan fitur video AI pada akun pengguna.
- Proyek ini tidak berafiliasi dengan Google.
- Video demo tersedia sebagai aset pada rilis ini.
