// Injected at the top of every esbuild bundle via --banner:js.
//
// esbuild's ESM output replaces `require` with a stub that throws
// "Dynamic require of X is not supported". Any CommonJS dependency reached
// through it fails to import under Node. Bun tolerated this; Node does not.
// Re-creating `require` here makes those imports resolve normally.
import { createRequire as __createRequire } from 'node:module';

const require = __createRequire(import.meta.url);
