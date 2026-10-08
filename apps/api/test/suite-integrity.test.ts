import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * Guards the test suite's own integrity.
 *
 * FINDING THAT PROMPTED THIS FILE
 *
 * `test:unit` used to enumerate 30 test files by name in package.json. The
 * vitest config already globbed `test/**\/*.test.ts` and excluded the five
 * quarantined files, but passing filenames on the CLI OVERRIDES the include
 * glob — so the enumeration was the only thing deciding what ran. A canary file
 * added to `test/` was silently ignored: 30 files / 248 tests, unchanged.
 *
 * That is the same failure mode as the rest of this session's findings — a
 * declaration (a list of names) drifting from reality (the files on disk) with
 * nothing to notice. This file makes that drift loud.
 *
 * It also asserts that the `.semrel/*.mjs` hooks referenced by `.releaserc.json`
 * exist. `dispatch.mjs` is what triggers the deploy after a release. They were
 * deleted by commit d2839ab, a commit about an unrelated topic, which would
 * have silently disabled the release→deploy path in P5c. A missing file there
 * fails semantic-release at release time, i.e. in production, not in CI.
 */

const testDir = fileURLToPath(new URL('.', import.meta.url));
const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const pkg = JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** Files vitest collects for a config, via that config's own include/exclude. */
const collectedFor = (configName: string): string[] => {
  const out = execFileSync('npx', ['vitest', 'list', '--config', configName, '--filesOnly'], {
    cwd: apiRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts'))
    .map((line) => `./${line.replace(/^\.\//, '')}`)
    .sort();
};

test('test:unit runs every test file, not a hand-maintained list', () => {
  const script = pkg.scripts['test:unit'] ?? '';
  // A filename argument on the CLI replaces the config's include glob. Any
  // `.test.ts` token in the command is the bug this file exists to prevent.
  const fileArgs = script.split(/\s+/).filter((token) => token.endsWith('.test.ts'));
  expect(
    fileArgs,
    'test:unit must not enumerate test files by name — a new test file is silently never run. ' +
      'Let the vitest config glob instead.',
  ).toEqual([]);
  expect(script).toContain('--config vitest.config.ts');
});

test('test:quarantine runs every quarantined file, not a hand-maintained list', () => {
  const script = pkg.scripts['test:quarantine'] ?? '';
  const fileArgs = script.split(/\s+/).filter((token) => token.endsWith('.test.ts'));
  expect(fileArgs, 'test:quarantine must not enumerate test files by name.').toEqual([]);
  expect(script).toContain('--config vitest.quarantine.config.ts');
});

test('unit and quarantine suites partition the whole test directory', () => {
  const onDisk = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `./test/${name}`)
    .sort();

  const unit = collectedFor('vitest.config.ts');
  const quarantine = collectedFor('vitest.quarantine.config.ts');
  const covered = [...new Set([...unit, ...quarantine])].sort();

  // The property that matters: nothing on disk escapes both configs. Before the
  // fix, a file missing from the hardcoded list was collected by NEITHER suite.
  expect(covered).toEqual(onDisk);

  // And the two suites must not overlap, or a quarantined (live-network) file
  // would run on every PR.
  const overlap = unit.filter((file) => quarantine.includes(file));
  expect(overlap, 'a file is in both the unit and quarantine suites').toEqual([]);
});

test('the quarantined suites are the live-network ones', () => {
  const quarantine = collectedFor('vitest.quarantine.config.ts');
  // These hit the live deployment or need real credentials. If one ever moves
  // into the unit suite, every PR would talk to production.
  for (const file of [
    './test/production-e2e.test.ts',
    './test/s3-sdk.test.ts',
    './test/telegram.test.ts',
  ]) {
    expect(quarantine, `${file} must stay quarantined`).toContain(file);
  }
});

test('the semantic-release hooks referenced by .releaserc.json exist', () => {
  const releaserc = readFileSync(join(repoRoot, '.releaserc.json'), 'utf8');

  // Extract the ./.semrel/*.mjs paths the config actually invokes, rather than
  // hardcoding the list — so a new hook is covered the day it is added.
  const referenced = [...releaserc.matchAll(/\.\/\.semrel\/[\w.-]+\.mjs/g)].map((m) => m[0]);

  expect(
    referenced.length,
    'expected .releaserc.json to reference at least one ./.semrel hook',
  ).toBeGreaterThan(0);

  for (const relative of [...new Set(referenced)]) {
    expect(
      existsSync(join(repoRoot, relative)),
      `${relative} is executed by .releaserc.json but does not exist. semantic-release runs ` +
        'these on a release, so a missing file breaks the release→deploy path in production, not in CI.',
    ).toBe(true);
  }
});

test('deploy stays frozen: no workflow pushes to main', () => {
  // P0–P5b freeze. Every phase merge must not reach production; P5c restores it.
  // This deliberately duplicates deploy-config.test.ts: if that file is deleted
  // during the P5 cleanup, the freeze guard survives in a suite the glob cannot
  // skip.
  for (const wf of ['deploy.yml', 'release.yml']) {
    const file = readFileSync(join(repoRoot, '.github/workflows', wf), 'utf8');
    expect(file, `${wf} must stay workflow_dispatch-only until P5c`).not.toMatch(
      /^\s{2}push:\s*$/m,
    );
  }
});
