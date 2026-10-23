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
| Fix RPC URL absolut | oRPC butuh base URL absolut; string relatif tidak valid untuk `new URL()`. |
| Rombakan topbar | Tambah link ke public home (`/`) dan Files, aktif state dari router. |
| Rombakan dashboard | Tambah per-bucket list + CTA "Open bucket". |
| Rombakan error boundary | Tambah link ke home/dashboard, pesan error lebih informatif. |

## Resources

- `apps/web/src/lib/rpc.ts`
- `apps/web/src/routes/_authenticated/$orgSlug/dashboard.tsx`
- `apps/web/src/lib/layout/AppShell.tsx`
- `apps/web/src/routes/__root.tsx`

---

*Update this file after significant discoveries so important evidence remains available.*
