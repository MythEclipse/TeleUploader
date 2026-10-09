import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the dashboard SPA (P4).
 *
 * Two settings here are load-bearing for the DEPLOY, not just for the dev server:
 *
 * `base: '/'` — the SPA is served from the API's site root (`GET /`), not from a
 * sub-path. Without it Vite emits relative asset URLs, which resolve against
 * whatever the current route is, so a deep link like `/my-bucket/a/b.txt` would
 * request `/my-bucket/assets/index-<hash>.js` and 404.
 *
 * `build.outDir: 'dist'` with `index.html` at its root — `deploy.sh --check`
 * gates on the literal sentinel path `apps/web/dist/index.html`. Emitting
 * `outDir/index.html` (any sub-path) turns that check into a false green, which
 * is the `schema.sql` defect class: a listed artifact that is never really there.
 */
export default defineConfig({
  base: '/',
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: false }), react()],
  build: {
    outDir: 'dist',
    // Content hashes are what make the long-lived-cache headers safe. The api
    // serves /assets/* statically (see docs/P4-CONTRACT.md §5.3); do not disable
    // hashing to "make filenames predictable".
    sourcemap: false,
  },
});