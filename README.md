# Telegram Bot Uploader Backend

Backend production-ready untuk upload file ke Telegram yang tersimpan di private channel.

## Setup

1. Siapkan PostgreSQL database (produksi: database `uploader` via PgBouncer pool di `100.121.180.82:6432`)
2. Setup environment: `cp .env.example .env`
3. Edit `.env` dengan nilai yang sesuai (lihat `DATABASE_URL`, `PORT=4000`)
4. Create table: `bun run db:migrate`
5. Install dependencies: `bun install`

## Telegram Private Channel Setup

1. Buat private channel Telegram
2. Tambah bot sebagai admin di channel
3. Dapatkan `STORAGE_CHANNEL_ID` (misalnya -1001234567890)

## Running

```bash
bun run dev      # Development mode
bun run start    # Production mode
```

## Deployment (Produksi — systemd, tanpa Nix)

> Infra lama berbasis Docker + Traefik sudah dihapus dari orangevps (2026-08-02).
> Nix juga sudah dihapus dari VPS (`/nix` tidak ada lagi) sehingga seluruh
> jalur deploy kini pindah ke pnpm + systemd.

- **Host**: orangevps
- **Service**: systemd unit `teleuploader` (env via BWS `bws-exec`)
- **Build**: `pnpm run build` (esbuild → `dist/index.js`) — `deploy.sh`
  mengirim `dist/` ke `/opt/teleuploader/dist`, `systemctl restart teleuploader`,
  lalu cek `GET /health` pada port yang didengarkan PID service
- **CI**: `.github/workflows/deploy.yml` (GitHub Actions / Gitea Actions)
- **Port**: `4000` (`PORT` env)
- **Domain**: `https://upload.asepharyana.my.id`
- **Reverse proxy**: Caddy (bukan Traefik/Docker)
- **Database**: `postgresql://asephs:***@100.121.180.82:6432/uploader` (PgBouncer pool di imrnes, **bukan** 5432/localhost)
- `deploy.sh` adalah satu-satunya jalur deploy; `Dockerfile` & `docker-compose.yml` bersifat **legacy** — jangan dipakai untuk deploy produksi.

## API Endpoints

- `POST /api/upload` - Upload file
- `GET /f/:public_id` - Download redirect
- `GET /file/:public_id/info` - File metadata
- `GET /health` - Health check

## FAQ

**URL permanen maksudnya apa?**
URL backend tetap permanen: `https://upload.asepharyana.my.id/f/{public_id}`
Ini berarti URL service Anda fix, bukan jaminan file Telegram abadi.

## Testing

Gunakan bot Telegram untuk upload, atau upload API langsung via HTTP.

## Versioning

This repository uses auto semantic versioning via [semantic-release](https://github.com/semantic-release/semantic-release):

- `fix(...)` commits → patch bump (v1.1.1 → v1.1.2)
- `feat(...)` commits → minor bump (v1.2.0)
- breaking changes → major bump (v2.0.0)
- `chore/ci/docs/refactor/test` commits → no release

On every release, `prepare.mjs` syncs the version across `package.json`
(and `flake.nix` only if that file ever comes back), and the
`Build & Deploy` workflow picks the new `dist/` up over plain SSH — no Nix
store path involved.
