#!/usr/bin/env node
/**
 * One-shot P1b import rewriter.
 *
 * The kana restructure moved files between layer folders, which invalidates every
 * relative import that pointed at them. Rather than hand-editing ~84 import lines
 * across 69 files, this resolves each old specifier to its new absolute location
 * under apps/api/src, then recomputes the correct relative path from the importing
 * file. Depth is computed per-file, so it stays correct as folders moved.
 *
 * Runs once and is deleted after P1b. Kept in-tree so the transformation is
 * auditable in the P1b commit.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, relative, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const API_SRC = resolve('apps/api/src');

/** Old module path (relative to src/) -> new module path (relative to src/). */
const MOVES = new Map(
  Object.entries({
    // presentation/: interfaces/ renamed, bot/ -> telegram/
    'interfaces/http': 'presentation/http',
    'interfaces/s3': 'presentation/s3',
    'interfaces/bot': 'presentation/telegram',
    // infrastructure/observability/
    'shared/logger/index': 'infrastructure/observability/logger',
    'shared/metrics/index': 'infrastructure/observability/metrics',
    // application/shared/utils/ — pure modules
    'shared/utils/file': 'application/shared/utils/file',
    'shared/utils/crypto': 'application/shared/utils/crypto',
    'shared/utils/validation': 'application/shared/utils/validation',
    'shared/utils/temp-stream': 'application/shared/utils/temp-stream',
    'shared/utils/zip': 'application/shared/utils/zip',
    'shared/utils/compress': 'application/shared/utils/compress',
    'shared/utils/file-sink': 'application/shared/utils/file-sink',
    // infrastructure/ — these two import `env`
    'shared/utils/ip': 'infrastructure/ip',
    'shared/utils/s3-detection': 'infrastructure/s3-detection',
    // presentation/http/ + application/shared/validation/
    'shared/http/filename': 'presentation/http/filename',
    'shared/validation/schemas': 'application/shared/validation/schemas',
  }),
);

const files = execSync(
  "find apps/api/src apps/api/test -name '*.ts' -not -path '*/node_modules/*'",
  { encoding: 'utf8' },
)
  .trim()
  .split('\n');

let changedFiles = 0;
let rewritten = 0;
const unresolved = [];

/** Strip a trailing /index so we compare against module keys. */
const normalize = (p) => p.replace(/\/index$/, '');

/**
 * Given an import specifier and the importing file, decide if it targets a moved
 * module and return the correct replacement.
 */
function resolveImport(spec, importerAbs) {
  // Only relative specifiers can point at moved in-repo modules.
  if (!spec.startsWith('.')) return null;

  const importerDir = dirname(importerAbs);
  const targetAbs = resolve(importerDir, spec);

  // Normalize to a src-relative module path when the target is inside the api tree.
  const relToSrc = relative(API_SRC, targetAbs);
  if (relToSrc.startsWith('..')) return null;

  // A specifier may or may not include the trailing `/index`.
  const candidates = [normalize(relToSrc), relToSrc];
  for (const cand of candidates) {
    if (MOVES.has(cand)) {
      const destAbs = join(API_SRC, MOVES.get(cand));
      // Confirm the destination actually exists before rewriting to it.
      const asFile = `${destAbs}.ts`;
      const asIndex = join(destAbs, 'index.ts');
      if (!existsSync(asFile) && !existsSync(asIndex)) {
        unresolved.push({ spec, importerAbs, cand, reason: 'destination missing' });
        return null;
      }
      let newRel = relative(importerDir, destAbs);
      if (!newRel.startsWith('.')) newRel = `./${newRel}`;
      return newRel;
    }
  }
  return null;
}

for (const file of files) {
  const abs = resolve(file);
  const src = readFileSync(abs, 'utf8');
  let out = src;
  let touched = 0;

  // Match: import ... from '<spec>'  |  import('<spec>')  |  vi.mock('<spec>')
  const patterns = [
    /(\bfrom\s+)'([^']+)'/g,
    /(\bimport\s*\(\s*)'([^']+)'/g,
    /(\bvi\.mock\s*\(\s*)'([^']+)'/g,
    /(\bvi\.importActual\s*\(\s*)'([^']+)'/g,
  ];

  for (const re of patterns) {
    out = out.replace(re, (match, prefix, spec) => {
      const replacement = resolveImport(spec, abs);
      if (replacement === null) return match;
      touched += 1;
      rewritten += 1;
      return `${prefix}'${replacement}'`;
    });
  }

  if (out !== src) {
    writeFileSync(abs, out);
    changedFiles += 1;
  }
}

console.log(`files scanned:     ${files.length}`);
console.log(`files changed:     ${changedFiles}`);
console.log(`imports rewritten: ${rewritten}`);
if (unresolved.length > 0) {
  console.log(`\nUNRESOLVED (${unresolved.length}):`);
  for (const u of unresolved) console.log(`  ${u.importerAbs}: '${u.spec}' -> ${u.reason} (${u.cand})`);
}