# Telegram Bot Uploader Backend

Backend production-ready untuk upload file ke Telegram yang tersimpan di private channel.

## Setup

1. Siapkan PostgreSQL database (produksi: database `uploader` via PgBouncer pool di `100.121.180.82:6432`)
2. Setup environment: `cp .env.example .env`
3. Edit `.env` dengan nilai yang sesuai (lihat `DATABASE_URL`, `PORT=4000`)
4. Install dependencies: `bun install`
5. Build lalu jalankan migrasi: `bun run build`, kemudian `bun run db:migrate`
   (task ini menjalankan `node dist/migrate.js`, jadi butuh `dist/` dari langkah build)

## Telegram Private Channel Setup

1. Buat private channel Telegram
2. Tambah bot sebagai admin di channel
3. Dapatkan `STORAGE_CHANNEL_ID` (misalnya -1001234567890)

## Running

```bash
bun run dev                                  # Development mode (tsx watch)
bun run build && node apps/api/dist/index.js # Production mode (hasil build)
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
- `GET /f/:public_id` - Download (stateless token or legacy `public_id`)
- `GET /file/:public_id/info` - File metadata
- `GET /health` - Health check

## Stateless links (files ≤ 30 MB)

Small uploads are stored **without a database row**. The Telegram `file_id` — the
only field that cannot be recomputed at request time — travels inside the signed
URL, so serving the file needs no query at all.

```
https://upload.asepharyana.my.id/f/<base64url token>.pdf
```

The token is an HMAC-SHA256-signed binary payload carrying the part list, file
name, MIME type, size, and timestamp. The extension at the end is cosmetic:
`Content-Type` and `Content-Disposition` come from the payload, so a link whose
suffix was stripped still serves correctly. MIME is kept in the payload rather
than inferred from the extension — `.mp4` may be `video/mp4` or
`application/octet-stream`, and a wrong `Content-Type` stops the browser from
playing the file inline.

| File size | Parts | Token | URL |
|---|---|---|---|
| ≤ 19 MB | 1 | 171 chars | ~210 chars |
| 20–30 MB | 2 | 263 chars | ~302 chars |

A Telegram `file_id` is itself base64url, so the payload stores it **decoded to
binary** (25% smaller than storing the string, which would encode it twice). If a
file_id ever fails a lossless round-trip, it is stored as text instead — the
encoder never guesses, because a guessed file_id looks valid and only fails when
someone clicks the link.

Links issued by v1 (file_id stored as text) still decode; the version byte
selects the layout.

Threshold is `STATELESS_LINK_MAX_BYTES` (default 30 MB, `0` disables). It is
clamped to twice `TELEGRAM_CHUNK_SIZE_BYTES`, because each part adds a `file_id`
to the URL.

**What stateless uploads do not get:** deduplication, listing in the dashboard,
and delete. All three are queries over rows that no longer exist. Files above the
threshold keep the database path, so those features still work where they matter.

Larger files, S3 objects, and archive entries are unaffected — they still use
`public_id` lookups. A legacy `/f/<nanoid>` link keeps working: the token check
returns `null` for anything it did not sign, and the request falls through to the
database.

## FAQ

**URL permanen maksudnya apa?**
URL backend tetap permanen: `https://upload.asepharyana.my.id/f/{public_id}`
Ini berarti URL service Anda fix, bukan jaminan file Telegram abadi.

**Apakah link stateless bisa mati?**
Bisa, karena dua hal yang sama-sama di luar kendali aplikasi: file dihapus dari
channel Telegram, atau bot yang mengunggahnya dikeluarkan dari pool token. Yang
kedua bukan efek samping signature — `file_id` Telegram memang hanya bisa
di-resolve oleh bot pembuatnya, jadi link akan mati apa pun cara menandatanganinya.
Set `STATELESS_LINK_SECRET` kalau ingin link tetap hidup saat token bot dirotasi.

## Testing

Gunakan bot Telegram untuk upload, atau upload API langsung via HTTP.

## Versioning

The version is decided **locally, before the push**, by `scripts/bump-version.mjs`
running in the lefthook `pre-push` hook. Nothing in CI computes it, so you can
always see what the next version will be before it ships.

```bash
pnpm run bump   # run it by hand, or let `git push` do it
```

The bump commits as `chore: adjust package.json version (bump)` and creates the
`vX.Y.Z` tag locally. Push with `git push --follow-tags` so both reach the remote.

| Commit in the push range | Bump |
|---|---|
| `feat(scope): …` | minor |
| `fix(scope): …` | patch |
| `BREAKING CHANGE:` footer, or `type!:` subject | major |
| `chore`, `ci`, `docs`, `refactor`, `test`, `build` | patch |

Every tracked manifest carrying a `version` moves together — `package.json`,
`apps/api/package.json` and `apps/web/package.json` — because the script
enumerates them with `git ls-files` rather than naming them. A hardcoded list is
what let `apps/api` and `apps/web` sit on 1.2.9 through the whole 1.12.x line
while only the root manifest was rewritten.

The `pre-push` hook stops the push once after bumping. That is deliberate: the
push already in flight cannot contain the commit it is about to create, so it
would ship the old version. Push again and the bump commit goes with it.

## Releases and container images

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which reads the
version from `package.json`, checks that the tag agrees with it, and publishes one
container image per service to GHCR at exactly that version:

| Package | Image |
|---|---|
| `teleuploader` | `ghcr.io/asepharyana/teleuploader:<version>` |

Pull one without touching the registry UI:

```bash
docker pull ghcr.io/asepharyana/teleuploader:<version>
```

### Adding or removing an image

Do not edit `.github/workflows/release.yml` to change which images are built.
The list lives in `.github/docker-images.json`:

```json
{ "images": [
  { "package": "<service>", "context": ".", "file": "Dockerfile" }
] }
```

- `package` becomes the GHCR path component, so it must be lowercase
  `[a-z0-9._-]`. It does not have to match the repo name.
- `context` is the build context directory, `file` the Dockerfile within it.
- `build_args` is passed straight to `docker/build-push-action`, so it must be a
  newline-separated `KEY=value` string (e.g. `"A=1\nB=2"`). A JSON **object** is
  accepted by the action but handed through literally, so every `ARG` in the
  Dockerfile resolves empty and the build still succeeds.
- `"enabled": false` keeps an entry documented but skips building it. **An empty
  or fully disabled list fails the run** rather than publishing nothing.

Every enabled entry must have a `Dockerfile` **and** a `.dockerignore` in its
context, and both must be tracked by git — CI cannot see an untracked file, and a
missing `.dockerignore` silently ships `node_modules/` and `.git` inside the image.

`latest` tracks the newest stable release. Prereleases (`1.2.0-rc.1`) are
tagged but never promote `latest`. Set `"latest": false` on an entry to keep it
on versioned tags only.

### If a release fails

Check the run, then fix forward with a normal commit — do not re-tag by hand:

```bash
gh run list --workflow=release.yml --limit 5
gh run view <run-id> --log-failed
```

The most likely failure is a tag that disagrees with `package.json`, which the
validate step reports by name. That means someone tagged by hand or edited a
manifest after bumping — bump again rather than forcing the tag.

<!--
  Smoke-test markers. Automated tooling matches these comments verbatim, so keep
  the exact strings below — do not reword or reflow them.
-->
<!-- review schema smoke test -->
<!-- flat schema smoke -->
