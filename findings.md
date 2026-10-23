# Findings & Decisions

## Requirements

- Fix error "Failed to construct 'URL': Invalid URL" setelah login di `/superaseph/dashboard`.
- Rombakan FE: "yg sekarang jelek".
- Pikirkan bisnis proses yang bagus.
- Gunakan impecable (kualitas tinggi, rapi, tidak boros).

## Research Findings

- Root cause `Invalid URL`: `apps/web/src/lib/rpc.ts` `rpcUrl()` mengembalikan string relatif `/rpc?org=<slug>`; oRPC `StandardRPCLinkCodec.encode` menjalankan `new URL(baseUrl)` tanpa base → gagal pada string relatif.
- Fix yang sudah di-deploy: `rpcUrl()` sekarang `new URL(path, window.location.origin).toString()`.
- Struktur route: `/` (public), `/login`, `/_authenticated`, `/_authenticated/$orgSlug`, `/_authenticated/$orgSlug/dashboard`, `/_authenticated/$orgSlug/$bucketName`.
- Route collision: browser nav vs S3 path-style dibedakan via `Sec-Fetch-Mode` + Accept.

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Fix RPC URL absolut | oRPC butuh base URL absolut; string relatif tidak valid untuk `new URL()`. Sudah di-deploy via `069f750`. |
| Rombakan CSS | >25 class yang dirujuk route belum ada di `index.css` → render tanpa gaya. Ditambahkan semua class: `panel`, `file-list-panel`, `panel-header`, `table-responsive`, `pagination-bar`, `public-hero`, `hero-content`, `hero-description`, `hero-cta-link`, `public-home`, `name-col`, `size-col`, `type-col`, `date-col`, `actions-col`, `size-cell`, `type-cell`, `date-cell`, `file-icon`, `file-name-text`, `file-row`, `secondary`, `hero`, `hero-number`. |
| SPA navigation via `Link` | `AppLink` sekarang wrapper di atas TanStack `Link` (`to`) agar navigasi internal adalah client-side transition, bukan full document reload (`<a href>`). |
| Dashboard hero | Dua blok `empty-state` diganti section `hero` dengan angka Total storage / Objects / Buckets yang memukau, diikuti tabel per-bucket. |
| Public home | Pakai `panel`, `table-responsive`, `pagination-bar`, baris berkelas (`file-row`, `name-col`…), dan `secondary` button untuk paginasi. |

## Resources

- `apps/web/src/lib/rpc.ts`
- `apps/web/src/routes/_authenticated/$orgSlug/dashboard.tsx`
- `apps/web/src/lib/layout/AppShell.tsx`
- `apps/web/src/lib/layout/AppLink.tsx`
- `apps/web/src/lib/layout/AuthControls.tsx`
- `apps/web/src/lib/layout/NotFound.tsx`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/index.tsx`
- `apps/web/src/index.css`

---

*Update this file after significant discoveries so important evidence remains available.*
