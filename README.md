# Telegram Bot Uploader Backend

Backend production-ready untuk upload file ke Telegram yang tersimpan di private channel.

## Setup

1. Install PostgreSQL database
2. Buat database: `createdb telegram_uploader`
3. Setup environment: `cp .env.example .env`
4. Edit `.env` dengan nilai yang sesuai
5. Create table: `bun run db:migrate`
6. Install dependencies: `bun install`

## Telegram Private Channel Setup

1. Buat private channel Telegram
2. Tambah bot sebagai admin di channel
3. Dapatkan `STORAGE_CHANNEL_ID` (misalnya -1001234567890)

## Running

```bash
bun run dev      # Development mode
bun run start    # Production mode
```

## API Endpoints

- `POST /api/upload` - Upload file
- `GET /f/:public_id` - Download redirect
- `GET /file/:public_id/info` - File metadata
- `GET /health` - Health check

## FAQ

**URL permanen maksudnya apa?**
URL backend tetap permanen: `https://tele.asepharyana.tech/f/{public_id}`
Ini berarti URL service Anda fix, bukan jaminan file Telegram abadi.

## Testing

Gunakan bot Telegram untuk upload, atau upload API langsung via HTTP.
