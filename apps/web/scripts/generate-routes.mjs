/**
 * Regenerates `src/routeTree.gen.ts` without starting a server.
 *
 * The plugin normally generates the tree during Vite's `configResolved`, which needs a
 * dev server or a build. `tsc --noEmit` on its own does NOT generate it, so a fresh
 * clone (or a restructured `routes/` directory) fails with
 * `Cannot find module './routeTree.gen'`.
 *
 * This script runs the generator directly, which is what `pnpm run typecheck` needs
 * before it can see the new route files. It is a thin wrapper, not a reimplementation:
 * the same `Generator` the plugin uses, with the same config the plugin reads.
 *
 * Run with `node scripts/generate-routes.mjs` from `apps/web`.
 */

import { Generator, getConfig } from '@tanstack/router-generator';

const root = process.cwd();
const config = getConfig(
  {
    target: 'react',
    autoCodeSplitting: false,
  },
  root,
);

const generator = new Generator({ config, root });
await generator.run();

console.log(`route tree written to ${config.generatedRouteTree}`);
