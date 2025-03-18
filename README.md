# Njin

Sistem untuk aplikasi Point of Sale. Dibangun menggunakan **Bun** untuk performa cepat dan efisiensi.

## 📦 Persyaratan

Sebelum memulai, pastikan Anda sudah menginstal:

- [Bun](https://bun.sh/) (versi terbaru)
- PostgreSQL (sebagai database utama)

## 🚀 Memulai Proyek

### 1. Clone Repository

```bash
git clone <repo-url>
cd njin
```

### 2. Konfigurasi Environment

Ubah nama file `.env.example` menjadi `.env` dan sesuaikan pengaturan seperti URL database, port, dll.

Contoh isi `.env`:

```
PORT=8080
NODE_ENV=development

DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_NAME=njin
DB_PASS=11Agustus!
```

### 3. Install Dependencies

```bash
bun install
```

### 4. Menjalankan Server di Mode Development

```bash
bun run dev
```

### 5. Build untuk Production

```bash
bun run build
```

### 6. Menjalankan di Mode Production

```bash
./njin start
```

## 🔧 Menjalankan Command Kustom

Untuk menjalankan perintah kustom yang telah dibuat:

```bash
bun run command <command>
```

Contoh:

```bash
bun run command seed
```

## 🤝 Kontribusi

Jika ingin berkontribusi, silakan fork repository ini dan ajukan pull request.

## 📄 Lisensi

Proyek ini menggunakan lisensi **[MIT](./LICENSE)**.
