# domain2lmdb

Proyek Bun dan TypeScript untuk mengambil blocklist Komdigi via DNS AXFR dan mengubahnya menjadi LMDB yang bisa dibaca dnsdist. WSL dipakai untuk pengembangan. Jalankan fetch dan konversi produksi di server fetcher Linux yang diizinkan mengakses AXFR Komdigi. Pengujian dari WSL dapat memakai tunnel SSH melalui fetcher yang mengizinkan penerusan TCP.

## Menjalankan

- Siapkan Bun, `dig` (paket `dnsutils` di Debian/Ubuntu), Node.js 22.9 atau lebih baru, Python 3, dan toolchain C++ (`build-essential` di Debian/Ubuntu).
- Jalankan `bun install --frozen-lockfile` di direktori proyek. Skrip `postinstall` mengompilasi binding LMDB format v1 dengan patch lokal.
- Salin `.env.example` ke `.env`, lalu isi `RPZ_PRIMARY`, `RPZ_SECONDARY`, dan `RPZ_ZONE` sesuai konfigurasi server fetcher. Gunakan alamat IP atau hostname untuk kedua server, dan nama DNS dengan atau tanpa titik akhir untuk zona.
- Atur `RPZ_PRIMARY_PORT` dan `RPZ_SECONDARY_PORT` bila memakai port khusus. Port default masing-masing adalah `53`.
- Jalankan `bun run convert.ts` dari direktori proyek tanpa argumen. Hasilnya adalah `blocklist.lmdb` di direktori kerja.

## Jadwal harian di server fetcher

Dari direktori proyek di server fetcher Linux, dengan dependensi dan `.env` produksi sudah siap, jalankan `bun run start` sebagai akun pengguna biasa. Perintah ini mengaktifkan timer systemd pengguna. Timer menjalankan `bun run convert.ts` di latar belakang setiap pukul 00.00 WIB (`Asia/Jakarta`). Pengambilan pertama berjalan saat jadwal tiba. Jadwal yang terlewat saat server mati dilewati.

Agar timer tetap tersedia saat keluar dari SSH dan setelah reboot, aktifkan linger sekali dengan `loginctl enable-linger "$USER"`. Jika akun tidak memiliki izin, minta administrator menjalankan perintah tersebut untuk akun fetcher.

- Lihat jadwal berikutnya dengan `systemctl --user list-timers domain2lmdb.timer`.
- Lihat log dengan `journalctl --user -u domain2lmdb.service -n 50`.
- Matikan jadwal dengan `systemctl --user disable --now domain2lmdb.timer`.

## Pengujian dari WSL lewat SSH tunnel

Buka tunnel di satu terminal WSL. Ganti `user@fetcher` dengan alamat SSH fetcher dan sesuaikan alamat RPZ bila berbeda dari contoh.

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:1053:139.255.196.202:53 \
  -L 127.0.0.1:1054:182.23.79.202:53 \
  user@fetcher
```

Di terminal WSL lain, isi `.env` di direktori proyek dengan endpoint lokal berikut. Gunakan zona RPZ yang sama dengan konfigurasi fetcher.

```dotenv
RPZ_PRIMARY=127.0.0.1
RPZ_PRIMARY_PORT=1053
RPZ_SECONDARY=127.0.0.1
RPZ_SECONDARY_PORT=1054
RPZ_ZONE=trustpositifkominfo
```

Setelah dependensi proyek terpasang di WSL, jalankan `bun run convert.ts` dengan tunnel tetap terbuka. AXFR keluar dari fetcher dan hasil `blocklist.lmdb` ditulis di direktori kerja WSL.

## Kontrak fetch dan konversi

- Lakukan AXFR lewat TCP dengan `dig`. Coba server utama dahulu dan coba server cadangan jika perintah gagal, transfer tidak lengkap, atau hasilnya tidak valid. Lakukan satu percobaan per server dengan batas proses empat menit per percobaan.
- Validasi status `NOERROR`, SOA pembuka dan penutup yang cocok dengan zona, serta jumlah record terhadap laporan akhir `dig`. Transfer yang tidak menghasilkan entri domain ditolak.
- Ambil nama pemilik record `IN CNAME` di bawah zona RPZ dan buang akhiran zona. Untuk pemilik yang diawali `*.`, simpan nama dasarnya sebagai key DNS wire yang dapat dipakai untuk lookup suffix dnsdist. Abaikan CNAME di luar zona dan di apex zona. Lewati CNAME dengan nama hasil ekstraksi yang tidak valid dan laporkan jumlah record yang dilewati.
- Validasi hostname ASCII dengan batas 63 byte per label dan 253 byte per nama. Awal dan akhir label harus huruf atau angka. Nama internasional harus sudah dalam bentuk Punycode. Ubah nama ke huruf kecil, deduplikasi, dan teruskan daftar di memori ke converter.
- Tulis file LMDB format v1 dalam mode file tunggal (`MDB_NOSUBDIR`) dengan database bernama `domains`. Simpan key DNS wire huruf kecil dan value satu byte ASCII `1` (`0x31`), keduanya sebagai byte mentah.
- Ganti `blocklist.lmdb` dengan rename dari lokasi sementara di filesystem yang sama setelah transfer tervalidasi, penulisan dan penyalinan selesai, serta database ditutup. Pertahankan output sebelumnya bila salah satu tahap itu gagal.

## Ruang lingkup

Proyek ini menangani pengambilan, konversi, dan jadwal harian. Distribusi dan aktivasi dnsdist dikelola di luar proyek.

## Verifikasi

Buka `blocklist.lmdb` dengan database bernama `domains` dan gunakan lookup DNS wire bawaan dnsdist. Untuk entri contoh `example.com`, key yang diharapkan adalah `07 65 78 61 6d 70 6c 65 03 63 6f 6d 00` dan value-nya `0x31`.
