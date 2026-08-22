# Multi-API-Key Prompt Generator Fallback

## Tujuan

Memungkinkan pengguna menyimpan beberapa API key untuk setiap provider prompt AI dan melanjutkan proses generate secara otomatis ketika key atau provider yang sedang digunakan gagal.

## Ruang Lingkup

- Provider yang didukung tetap Gemini, DeepSeek, Groq, dan OpenAI.
- Setiap provider memiliki satu model terpilih dan daftar API key berurutan.
- Semua pengaturan disimpan dalam profil browser lokal.
- Server tidak menyimpan atau mencatat API key.
- Fallback hanya berlaku untuk generator prompt Affiliate, bukan automasi video Google Vids.

## Antarmuka

Menu API Key mempertahankan pilihan provider dan model. Bagian API key berubah menjadi daftar credential untuk provider aktif. Setiap baris menampilkan nama urutan, input key tersamarkan, status, serta aksi Tampilkan, Test, dan Hapus. Tombol Tambah API Key membuat baris baru.

Status key terdiri dari belum dites, valid, gagal, dan sedang digunakan. Daftar key menentukan urutan percobaan. Key yang berhasil digunakan ditandai sebagai aktif tanpa mengubah urutan tersimpan.

## Penyimpanan Lokal

Skema localStorage dinaikkan ke versi baru dan menyimpan:

- provider pilihan pengguna;
- model per provider;
- daftar credential per provider dengan ID lokal, API key, dan status pengujian terakhir;
- ID key terakhir yang berhasil digunakan per provider.

Loader memigrasikan skema lama yang berisi satu `apiKey` per provider menjadi daftar dengan satu credential. Data rusak atau bidang tidak dikenal kembali ke default aman. Nilai key selalu dipangkas dan key kosong tidak masuk daftar fallback.

## Urutan Fallback

Ketika generate dimulai, browser menyusun kandidat berikut:

1. Semua key provider pilihan pengguna, dengan key terakhir yang berhasil dicoba lebih dahulu lalu key lain sesuai urutan daftar.
2. Provider lain yang memiliki key, dalam urutan Gemini, DeepSeek, Groq, dan OpenAI. Provider yang sudah dicoba tidak diulang.
3. Pada setiap provider, model tersimpan untuk provider tersebut digunakan.

Browser mengirim satu kandidat per permintaan ke endpoint generator yang sudah ada. Kandidat berikutnya hanya dicoba jika permintaan gagal. Proses berhenti pada keberhasilan pertama. Jika seluruh kandidat gagal, UI menampilkan ringkasan provider yang gagal tanpa menampilkan key atau isi rahasia.

## Penanganan Kegagalan

Respons HTTP gagal, error jaringan, timeout, key tidak valid, limit, dan model yang tidak tersedia memicu kandidat berikutnya. Validasi lokal seperti produk kosong tidak memulai fallback. Tombol Test hanya menguji key pada baris yang dipilih dan memperbarui status baris tersebut.

## Keamanan

- Satu permintaan hanya membawa satu API key.
- API key tidak dimasukkan ke antrean video, log, URL, atau pesan error.
- Semua teks status memakai label provider dan nomor key, bukan potongan key.
- Tampilkan key hanya memengaruhi input baris yang dipilih.

## Pengujian

- Unit test migrasi skema lama, penyimpanan multi-key, penghapusan, dan urutan kandidat.
- Unit test fallback: key pertama gagal lalu key kedua berhasil; seluruh key provider gagal lalu provider berikutnya berhasil; seluruh kandidat gagal.
- UI test untuk tambah, test, tampilkan, hapus, status, dan penyimpanan ulang.
- Regression test memastikan satu API key lama tetap bekerja.
- Seluruh test suite proyek harus lulus.
