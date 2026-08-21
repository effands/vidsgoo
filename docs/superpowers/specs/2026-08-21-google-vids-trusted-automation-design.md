# Google Vids Trusted Automation Design

## Tujuan

Mengotomatisasi alur Google Vids secara end-to-end: menerima prompt multiline atau batch, mengisi prompt, memulai render dengan input browser yang dipercaya, menunggu video baru, mengunduh MP4, lalu menampilkannya sebagai video playable di galeri dashboard.

## Masalah yang Dibuktikan

Content script dapat menemukan panel dan mengisi prompt, tetapi Google Vids mengabaikan klik DOM sintetis pada tombol generate. Klik melalui kontrol browser berhasil. Karena itu selector tambahan tidak akan menyelesaikan akar masalah; extension perlu mengirim input melalui Chrome DevTools Protocol.

## Arsitektur

### Dashboard dan server

- Satu prompt dapat terdiri dari banyak baris.
- Batch dipisahkan hanya oleh baris `=== PROMPT BARU ===`.
- Server mengelola tahap `Pending`, `Assigned`, `Submitting`, `Rendering`, `Downloading`, `Completed`, dan `Failed`.
- Server mencatat task ID, agent ID, prompt ringkas, rasio, timestamp tahap, nama file, ukuran, elapsed time, serta error.
- Galeri membaca MP4/WebM tervalidasi dari folder server dan `Downloads/Google_Vids`.
- Penghapusan satu atau semua file memakai source ID dan basename tervalidasi.

### Content script

- Menemukan panel Video AI, prompt box, rasio, tombol expand, tombol generate, dan elemen video hasil.
- Mengisi prompt dan mengirim koordinat pusat elemen target kepada background worker.
- Mencatat kumpulan URL video sebelum generate dan hanya menerima URL baru sebagai hasil task.
- Tidak lagi mengirim `fetch` langsung ke server lokal; seluruh komunikasi server melewati background worker.

### Background worker

- Memiliki permission `debugger`.
- Attach hanya ke tab Google Vids yang sedang menjalankan task.
- Mengirim `Input.dispatchMouseEvent` untuk mouse moved, pressed, dan released pada koordinat tombol.
- Selalu detach setelah klik selesai atau ketika task gagal.
- Menolak penggunaan debugger untuk URL selain `https://docs.google.com/videos/`.
- Mengunduh URL video baru dengan `chrome.downloads.download`.
- Menunggu status download `complete` sebelum melaporkan task Completed.

## Aliran Task

1. Extension mengambil task dari server dan mengunci dirinya sebagai busy.
2. Background memilih atau membuka tab Google Vids dan memastikan content script tersedia.
3. Content script membuka panel, mengisi prompt, memilih rasio, dan meminta trusted click pada tombol expand bila diperlukan.
4. Setelah tombol generate terlihat, content script meminta trusted click pada tombol tersebut.
5. Background melaporkan tahap Rendering.
6. Content script menunggu URL video baru maksimal empat menit.
7. Background memulai download dan melaporkan tahap Downloading.
8. Setelah download complete, server menandai task Completed dan galeri menemukan file valid.

## Error Handling

- Attach debugger gagal: task Failed dengan pesan Chrome yang jelas.
- Tab ditutup atau navigasi keluar dari Google Vids: debugger dilepas dan task Failed.
- Elemen tidak ditemukan: agent masuk cooldown dan task dapat dicoba oleh agent lain.
- Render timeout: task Failed tanpa mengunduh video lama.
- Download interrupted/timeout: task Failed dan file parsial tidak ditampilkan oleh galeri.
- Semua jalur `finally` melepas debugger agar tab tidak terus berada dalam status debug.

## Keamanan

- Debugger hanya dipakai pada tab Google Vids yang cocok dengan allowlist URL.
- Tidak membaca cookie, password, history, atau data akun.
- Tidak menjalankan perintah DevTools selain input mouse yang diperlukan untuk task.
- Tidak menghapus hasil tanpa aksi pengguna dan konfirmasi dashboard.

## Pengujian

- Unit test parser prompt multiline dan delimiter batch.
- Unit test validasi signature video serta resolusi path penghapusan.
- Static lifecycle test memastikan permission debugger, attach/detach, trusted click, download completion, dan failure endpoint ada.
- End-to-end test dengan prompt `embun pagi di sungai`:
  - status mencapai Rendering;
  - video baru muncul;
  - MP4 berukuran lebih dari nol tersimpan di `Downloads/Google_Vids`;
  - endpoint galeri mengembalikan video;
  - HTTP range request video berhasil;
  - elemen video dashboard dapat membaca metadata dan diputar.

## Kriteria Selesai

Task hanya berstatus Completed setelah file MP4 valid selesai diunduh dan tersedia melalui galeri. Tidak ada task yang diklaim selesai hanya karena prompt terisi atau tombol ditemukan.
