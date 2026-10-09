## [1.3.2](https://github.com/asepharyana/TeleUploader/compare/v1.3.1...v1.3.2) (2026-10-09)


### Bug Fixes

* **api:** require auth on /api/v1 reads, keeping share links public (item 11) ([6774375](https://github.com/asepharyana/TeleUploader/commit/6774375b609dc1adc8ac9d98bac65e59eabbeb3b))

## [1.3.1](https://github.com/asepharyana/TeleUploader/compare/v1.3.0...v1.3.1) (2026-10-09)


### Bug Fixes

* **test:** stop the offline DSN from reaching a real host, which hung CI ([99ca94e](https://github.com/asepharyana/TeleUploader/commit/99ca94e7160b3f1879bcedbba56b4a0c17c1adbb))

# [1.3.0](https://github.com/asepharyana/TeleUploader/compare/v1.2.9...v1.3.0) (2026-10-09)


### Bug Fixes

* **ci,deploy:** stop the Gitea mirror from deleting main; describe a runtime that exists ([9aec6ab](https://github.com/asepharyana/TeleUploader/commit/9aec6ab26bc3910d8f7901f6853bf63681c8aa99))
* **ci:** declare moon, so the pipeline's own gates can run at all ([0f3bd6f](https://github.com/asepharyana/TeleUploader/commit/0f3bd6fa0abcd3b468fefd65078c8eff76635e9e))
* **ci:** the gate silently skipped every new test file; restore .semrel hooks ([9923c62](https://github.com/asepharyana/TeleUploader/commit/9923c62a963fa8342fcc7e7a2365aa3b7c20be20))
* **db:** correct the false claim that deploy.sh runs migrate.js ([9c5da9a](https://github.com/asepharyana/TeleUploader/commit/9c5da9a690ae6c28c02d39229f19a14e3f4a8fd3)), closes [#0](https://github.com/asepharyana/TeleUploader/issues/0)
* **deploy:** deploy.sh would have shipped a stale bundle after the P1 move ([16709ef](https://github.com/asepharyana/TeleUploader/commit/16709ef7978df758f5ca918296cf8a6aa6949f24))
* **deploy:** P5 — close the schema/binary skew in the migration rollback ([e12b84e](https://github.com/asepharyana/TeleUploader/commit/e12b84ef99a883ca645c2dddcdf8b3284d5d33d1))
* **deploy:** P5 — deploy.sh now actually applies migrations ([cf27d19](https://github.com/asepharyana/TeleUploader/commit/cf27d1907bb73404c660dd8b31da83e0898ef628))
* **deploy:** ship and run the seeder; seed cannot be reached from the VPS ([04faa6f](https://github.com/asepharyana/TeleUploader/commit/04faa6f0827e57d664b65b202d062f1e410c6954))
* **rpc:** oRPC procedures returned contract placeholders, never the controllers ([ec457cf](https://github.com/asepharyana/TeleUploader/commit/ec457cf0294b20a8b7858300573cb6d1004c7b5a))
* **tenancy:** a missing bootstrap membership must not deny every request ([652e239](https://github.com/asepharyana/TeleUploader/commit/652e2392ca339a7b18daafe1fda33ba4d440c20e))
* **test:** one suite, two verdicts for the same missing precondition ([7b426f9](https://github.com/asepharyana/TeleUploader/commit/7b426f9c1792443ae85edce98063a2e5f585a156))
* **test:** the live-database suites passed without asserting anything ([90edac3](https://github.com/asepharyana/TeleUploader/commit/90edac3aae962154754424ae08e0923c0a2169e4))
* **web-api:** close the DELETE catch-all and restore a typecheck that could pass nothing ([3e9e2f6](https://github.com/asepharyana/TeleUploader/commit/3e9e2f6dcfe6e6da07caa95908f349a3d92a68f9))


### Features

* **db:** P2a drizzle schema for all 5 tables plus a real migration baseline ([c9aac9a](https://github.com/asepharyana/TeleUploader/commit/c9aac9a54adb171e753784293b1db29090f073c4))
* **db:** P3a tenancy schema, per-org buckets, and an ordering-safe seed ([397f5a3](https://github.com/asepharyana/TeleUploader/commit/397f5a3008dea53dc2315f97d461734e03a84546))
* **http:** P2b serve the API with Hono instead of the hand-rolled shim ([2bfb6fd](https://github.com/asepharyana/TeleUploader/commit/2bfb6fde3f8b7bed90f888f5eda97dfce6b7e784))
* **P4:** React SPA, /docs from the live router, P5c unfreeze ([a828d58](https://github.com/asepharyana/TeleUploader/commit/a828d5895b0915c1979df9e49aa9a4ed9d3325b6))
* **rpc:** P2c typed oRPC surface for bucket and object management ([688e633](https://github.com/asepharyana/TeleUploader/commit/688e633d015fd91545db634f42cfd58bd1922a04))
* **tenancy:** P3b — scope every bucket read and write to an organization ([57817fa](https://github.com/asepharyana/TeleUploader/commit/57817faeb9b2d38fec63880dc7bd59c237cfadc8))

## [1.2.9](https://github.com/asepharyana/TeleUploader/compare/v1.2.8...v1.2.9) (2026-10-06)


### Bug Fixes

* **build:** keep AbortSignal class name after esbuild renaming ([172cc73](https://github.com/asepharyana/TeleUploader/commit/172cc739ea2f1395488b27c60544a8b96a89f709))

## [1.2.8](https://github.com/asepharyana/TeleUploader/compare/v1.2.7...v1.2.8) (2026-10-06)


### Bug Fixes

* **deploy:** sudo the systemd calls in the remote deploy step ([fefab44](https://github.com/asepharyana/TeleUploader/commit/fefab4494d091a05a756c23e58f88879b6fbef0b))

## [1.2.7](https://github.com/asepharyana/TeleUploader/compare/v1.2.6...v1.2.7) (2026-10-06)

## [1.2.6](https://github.com/asepharyana/TeleUploader/compare/v1.2.5...v1.2.6) (2026-10-06)

## [1.2.5](https://github.com/asepharyana/TeleUploader/compare/v1.2.4...v1.2.5) (2026-10-06)

## [1.2.4](https://github.com/asepharyana/TeleUploader/compare/v1.2.3...v1.2.4) (2026-10-06)

## [1.2.3](https://github.com/asepharyana/TeleUploader/compare/v1.2.2...v1.2.3) (2026-09-18)

## [1.2.2](https://github.com/asepharyana/TeleUploader/compare/v1.2.1...v1.2.2) (2026-09-05)


### Bug Fixes

* **health:** resolve app version in Nix bundle at runtime ([6797dba](https://github.com/asepharyana/TeleUploader/commit/6797dbada27873b14c064e238589e61ad3ecb67c))

## [1.2.1](https://github.com/asepharyana/TeleUploader/compare/v1.2.0...v1.2.1) (2026-09-05)


### Bug Fixes

* **ci:** bump only TeleUploader flake version, not Bun overlay ([f442797](https://github.com/asepharyana/TeleUploader/commit/f442797a86e845853c28dc22432a530560434488))

# [1.2.0](https://github.com/asepharyana/TeleUploader/compare/v1.1.1...v1.2.0) (2026-09-05)


### Features

* **health:** expose app version in /health response ([0782d0f](https://github.com/asepharyana/TeleUploader/commit/0782d0f993a033bb9d84fa1f876e29486751889d))
