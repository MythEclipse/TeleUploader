# Task Plan: Rombakan FE TeleUploader — error Invalid URL + alur dashboard

## Goal

Merombak frontend TeleUploader agar error "Failed to construct 'URL': Invalid URL" setelah login tidak terjadi, dan alur bisnis frontend (public home → login → org → bucket → file) masuk akal dengan UI yang rapi dan usable.

## Next Step

Commit + push + monitor CI + check prod.

## Current Phase

Phase 5

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand user intent
- [x] Identify constraints and requirements
- [x] Document findings in findings.md
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Define technical approach
- [x] Create project structure if needed
- [x] Document decisions with rationale
- **Status:** complete

### Phase 3: Implementation
- [x] Execute the plan step by step
- [x] Write code to files before executing
- [x] Test incrementally
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Verify all requirements met
- [x] Document test results in progress.md
- [ ] Fix any issues found
- **Status:** in_progress

### Phase 5: Delivery
- [ ] Review all output files
- [ ] Ensure deliverables are complete
- [ ] Deliver to user
- **Status:** pending

## Key Questions

1. Apakah user ingin dashboard menampilkan daftar bucket langsung? — Rencana: ya, tambah "Open bucket" per bucket.
2. Apakah user ingin topbar menambah link Home/Public files? — Rencana: ya.
3. Apakah user ingin error boundary lebih informatif? — Rencana: ya, tambah link ke home/dashboard.

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Fix `rpc.ts` pakai `new URL(path, window.location.origin)` | oRPC butuh base URL absolut; string relatif tidak valid untuk `new URL()`. |
| Rombakan topbar | Tambah link ke public home (`/`) dan Files, aktif state dari router. |
| Rombakan dashboard | Tambah per-bucket list + CTA open bucket. |
| Rombakan error boundary | Tambah link ke home/dashboard, pesan error lebih informatif. |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| `Failed to construct 'URL': Invalid URL` | 1 | Di-fix di `apps/web/src/lib/rpc.ts` dengan URL absolut via `window.location.origin`. |
| `biome check` organize imports | 1 | Di-fix dengan `biome check --write src`. |

## Notes

- Error `Failed to construct 'URL': Invalid URL` sudah di-fix dan di-deploy (commit `069f750`).
- Task saat ini: rombakan FE karena "yg sekarang jelek", pikirkan bisnis proses yang bagus, dan gunakan impecable.
