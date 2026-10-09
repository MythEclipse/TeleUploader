import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const repoRoot = new URL('../../../', import.meta.url);
const deployScript = readFileSync(new URL('../../../deploy.sh', import.meta.url), 'utf8');

test('deploy script is provider-neutral', () => {
  expect(deployScript).not.toContain('GITLAB_PROJECT');
  expect(deployScript).not.toContain('fetch_ci_var');
  expect(deployScript).not.toContain('glab');
  expect(deployScript).not.toContain('GitLab CI');
  expect(deployScript).toContain('Gitea Actions secrets');
});

test('deploy check mode does not require an SSH key file', async () => {
  const proc = spawn('bash', ['deploy.sh', '--check'], {
    cwd: repoRoot.pathname,
    env: {
      ...process.env,
      VPS_HOST: '203.0.113.10',
      VPS_USER: 'deploy',
      VPS_SSH_KEY: '/tmp/nonexistent-teleuploader-key',
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Promise<string>((resolve, reject) => {
      let out = '';
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
      proc.stdout.on('end', () => resolve(out));
      proc.stdout.on('error', reject);
    }),
    new Promise<string>((resolve, reject) => {
      let out = '';
      proc.stderr.on('data', (d: Buffer) => (out += d.toString()));
      proc.stderr.on('end', () => resolve(out));
      proc.stderr.on('error', reject);
    }),
    new Promise<number | null>((resolve) => proc.on('close', resolve)),
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain('App name:');
  expect(stdout).toContain('VPS_HOST:');
  expect(stdout).toContain('VPS_USER:');
  expect(stdout).toContain('VPS_SSH_KEY:');
  expect(stderr).toBe('');
});

const workflowFile = readFileSync(
  new URL('../../../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);

test('deploy workflow builds with pnpm and ships over systemd (no Nix)', () => {
  // P5c UNFREEZE: the migration freeze (P0–P5b) is lifted, so a merge to main deploys.
  // This assertion used to be `not.toMatch(/^\s{2}push:\s*$/m)` — the freeze guard. It is
  // deliberately INVERTED rather than deleted, so a silent re-freeze fails here too.
  //
  // It matches the BLOCK form (`push:` alone on a line at 2-space indent), not an inline
  // `push: branches: [main]`. That is deliberate and was called out in the contract: an
  // inline form would have satisfied neither the old freeze guard nor this one, letting
  // the freeze be lifted while still asserting it was in place.
  expect(workflowFile).toMatch(/^\s{2}push:\s*$/m);
  // ...and the trigger must actually be scoped to main, not every branch.
  expect(workflowFile).toMatch(/^\s{2}push:\n\s{4}branches: \[main\]$/m);

  // workflow_dispatch must ALSO remain: .semrel/dispatch.mjs POSTs to the deploy
  // dispatch endpoint, and dropping it would break the release→deploy path.
  expect(workflowFile).toContain('workflow_dispatch');
  expect(workflowFile).toContain('uses: actions/checkout@v7');
  expect(workflowFile).toContain('uses: pnpm/action-setup@v4');
  expect(workflowFile).toContain('pnpm install --frozen-lockfile');
  expect(workflowFile).toContain('pnpm run lint');
  expect(workflowFile).toContain('VPS_HOST');
  expect(workflowFile).toContain('VPS_USER');
  expect(workflowFile).toContain('./deploy.sh --no-build');
  // Nix was removed from the VPS, so `nix copy` failed with
  // `error: cannot connect` on every run — never reintroduce it here.
  expect(workflowFile).not.toContain('nix copy');
  expect(workflowFile).not.toContain('nix-installer-action');
  expect(workflowFile).not.toContain('magic-nix-cache');
  expect(workflowFile).not.toContain('nix-env');
  expect(workflowFile).not.toContain('oven-sh/setup-bun');
});

test('the SPA is built in CI, between the API build and the deploy', () => {
  // WHERE THIS MUST LIVE. deploy.yml runs `./deploy.sh --no-build`, so deploy.sh's
  // `if $DO_BUILD` block never executes in CI. A SPA build added inside deploy.sh
  // would therefore be dead code on the only path that reaches production.
  expect(workflowFile).toContain('pnpm --filter @teleuploader/web run build');

  // And it must run BEFORE the deploy, because `./deploy.sh --no-build` asserts
  // apps/web/dist/index.html exists and refuses to ship a stale SPA. Building it
  // after the deploy step would fail every deploy outright.
  //
  // Both offsets are taken from the executable `run:` lines, NOT from `indexOf` on the
  // bare command strings: the file's own comments quote both commands, and a bare
  // indexOf would measure the comment's position instead of the step's. That is the
  // same "a mention satisfies the assertion" defect class this file exists for.
  const buildAt = workflowFile.indexOf('run: pnpm --filter @teleuploader/web run build');
  const deployAt = workflowFile.indexOf('run: VPS_SSH_KEY="$HOME/.ssh/deploy_key" ./deploy.sh');
  expect(buildAt, 'deploy.yml has no runnable SPA build step').toBeGreaterThan(-1);
  expect(deployAt, 'deploy.yml never invokes deploy.sh').toBeGreaterThan(-1);
  expect(buildAt, 'the SPA must be built BEFORE deploy.sh runs').toBeLessThan(deployAt);

  // pnpm, not the Bun toolchain the repo's CLAUDE.md mandates — the assertion above
  // already forbids a Bun setup action; forbid a Bun install here too.
  expect(workflowFile).not.toContain('bun install');
});

test('deploy script drives the systemd unit and probes health', () => {
  expect(deployScript).toContain('APP_NAME="teleuploader"');
  expect(deployScript).toContain('systemctl restart');
  expect(deployScript).toContain('is-active');
  expect(deployScript).toContain('HEALTH_PATH');
  expect(deployScript).toContain('/health');
  expect(deployScript).toContain('pnpm install --frozen-lockfile');
  // Plain systemd only: no Nix, no Docker, no Bun left in the deploy path.
  expect(deployScript).not.toContain('nix copy');
  expect(deployScript).not.toContain('docker compose');
  expect(deployScript).not.toContain('bun install');
});

// ── P5: deploy must actually apply migrations ─────────────────────────────────
//
// Every test below exists because of one specific, previously-true defect: deploy.sh
// shipped dist/migrate.js and NEVER RAN IT. The comments in migrate.ts
// ("THIS RUNNER IS CURRENTLY ORPHANED") documented the gap, but nothing failed when
// it stayed open — a green gate with no code path applying migrations. Asserting on
// the PRESENCE of the string "migrate.js" is what let it survive: the file was
// mentioned in the --check list, the post-build assertion, and the scp, so any
// content check for it passed while the invocation was absent.
//
// These assertions therefore check ORDER and CONTEXT, not mere presence: an
// invocation that exists but runs before the install, or after the restart, is the
// same defect wearing a different hat.

test('deploy applies migrations (P5) — the invocation exists at all', () => {
  // The actual command, not the filename. This is the assertion whose absence let the
  // defect survive: nothing before P5 ran the binary.
  expect(deployScript).toMatch(/migrate\.js/);
  expect(deployScript).toContain('say "applying database migrations"');

  // The invocation as an EXECUTABLE shell command, anchored to a line start so a
  // mention in a comment cannot satisfy it. This is stronger than the log-string
  // ordering assertions below, which pass with no migration invoked at all — the
  // reviewer finding that motivated these rewrites.
  expect(deployScript).toMatch(
    /^\s*as_root bws-exec "\$MIGRATION_APP" -- "\$NODE_BIN" "\$DIST_DIR\/migrate\.js"\s*$/m,
  );

  // Under `node`, never bun or Docker — the unit runs /usr/bin/node, and the drizzle
  // CLI is unusable in prod (PgBouncer transaction pooling drops the session-scoped
  // advisory lock mid-migration). `node` is also required by the existing
  // "no bun install" assertion above.
  expect(deployScript).toContain('$NODE_BIN');
  expect(deployScript).not.toMatch(/bun\s+\S*migrate/);
  // Assert the CLI is not INVOKED. Written as a regex on a shell-command shape rather
  // than a bare substring, because deploy.sh's own comment explains why the CLI is
  // wrong and a plain toContain() would match that comment.
  expect(deployScript).not.toMatch(/^\s*(?:as_root\s+)?npx\s+drizzle-kit\b/m);
  expect(deployScript).not.toMatch(/^\s*(?:as_root\s+)?bunx\s+drizzle-kit\b/m);
});

/**
 * Extract one shell function VERBATIM from deploy.sh.
 *
 * Anchored on `^name() {` .. the first `^}` at column 0, which is that function's
 * closing brace. Deliberately not a looser range: `RESTORE=0` appears twice in
 * deploy.sh, and a naive range silently captures the entire deploy body instead.
 */
const extractFunction = (script: string, name: string): string => {
  const lines = script.split('\n');
  const start = lines.indexOf(`${name}() {`);
  if (start === -1) {
    throw new Error(`could not find ${name}() in deploy.sh — the function was renamed?`);
  }
  // The closing brace is the first `}` at column 0 AFTER the opening one, so the
  // search is offset rather than indexOf('}'), which would match an inner brace.
  const end = lines.indexOf('}', start);
  if (end === -1) {
    throw new Error(`could not find the closing brace of ${name}() in deploy.sh`);
  }
  return lines.slice(start, end + 1).join('\n');
};

/**
 * Materialise a shell script in `dir` that runs the requested deploy.sh functions
 * against a stubbed environment, and execute it synchronously.
 *
 * The stubs stand in for the VPS: `as_root` drops privileges, `systemctl` prints
 * instead of restarting a unit, and `say`/`boom` reproduce deploy.sh's own log lines.
 * The function bodies themselves are deploy.sh's, copied textually — so these tests
 * exercise the shipped script rather than a reimplementation of it.
 *
 * ORDER MATTERS: `setup` runs before the function definitions (it sets MIGRATED and
 * friends) and `trailer` after them (it invokes them). Bash would fail with
 * "command not found" on an invocation placed before its definition.
 */
const runDeployFunctions = (
  dir: string,
  fnNames: string[],
  setup: string[] = [],
  trailer: string[] = [],
): { stdout: string; stderr: string; code: number } => {
  const runner = join(dir, 'run.sh');
  writeFileSync(
    runner,
    [
      'set -Eeuo pipefail',
      'say()  { echo "[deploy] $*"; }',
      'boom() { echo "[deploy] ERROR: $*" >&2; exit 1; }',
      'as_root() { "$@"; }',
      'systemctl() { echo "[stub] systemctl $*"; }',
      `DIST_DIR="${dir}/dist"`,
      `PREV="${dir}/dist.previous"`,
      'UNIT=teleuploader',
      ...setup,
      ...fnNames.map((n) => extractFunction(deployScript, n)),
      ...trailer,
    ].join('\n'),
  );
  chmodSync(runner, 0o755);
  const proc = spawnSync('bash', [runner], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    code: proc.status ?? 0,
  };
};

/**
 * Create a previous-release dist/ tree.
 *
 * `withDrizzle` / `withWeb` are the FIRST-deploy cases: release N-1 shipped no
 * migrations folder (P5) and no SPA directory (P4). Those are the cases where a
 * rollback guard written as `if [ -d "$PREV/<dir>" ]` silently does nothing.
 */
const seedPreviousRelease = (dir: string, withDrizzle: boolean, withWeb = true): void => {
  mkdirSync(join(dir, 'dist.previous'), { recursive: true });
  writeFileSync(join(dir, 'dist.previous', 'index.js'), 'OLD index');
  writeFileSync(join(dir, 'dist.previous', 'migrate.js'), 'OLD migrate');
  if (withDrizzle) {
    mkdirSync(join(dir, 'dist.previous', 'drizzle', 'meta'), { recursive: true });
    writeFileSync(join(dir, 'dist.previous', 'drizzle', 'meta', '_journal.json'), '{"old":true}');
  }
  if (withWeb) {
    mkdirSync(join(dir, 'dist.previous', 'web', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'dist.previous', 'web', 'index.html'), 'OLD SPA');
    writeFileSync(join(dir, 'dist.previous', 'web', 'assets', 'index-old.js'), 'OLD asset');
  }
};

/** Create the current dist/ tree: the newly installed release, journal and SPA included. */
const seedCurrentRelease = (dir: string, withDrizzle = true, withWeb = true): void => {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), 'NEW index');
  writeFileSync(join(dir, 'dist', 'migrate.js'), 'NEW migrate');
  if (withDrizzle) {
    mkdirSync(join(dir, 'dist', 'drizzle', 'meta'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'drizzle', 'meta', '_journal.json'), '{"new":true}');
  }
  if (withWeb) {
    mkdirSync(join(dir, 'dist', 'web', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'web', 'index.html'), 'NEW SPA');
    writeFileSync(join(dir, 'dist', 'web', 'assets', 'index-new.js'), 'NEW asset');
  }
};

test('migrations run AFTER the bundle is installed and BEFORE the restart', () => {
  // Ordering is asserted against the COMMANDS, not log strings. Each pattern below is
  // anchored to a line start, so it matches the command that actually runs; a `say`
  // line containing the same words could not satisfy it. A test that compares
  // indexOf() of two log strings passes even if both `say` calls remain but the
  // install, migration and restart commands are deleted outright.
  const installJs = /^\s*as_root mv -f "\$DIST_DIR\/\$base\.new" "\$DIST_DIR\/\$base"\s*$/m;
  const installDrizzle = /^\s*as_root mv -f "\$DIST_DIR\/drizzle\.new" "\$DIST_DIR\/drizzle"\s*$/m;
  const migrate =
    /^\s*as_root bws-exec "\$MIGRATION_APP" -- "\$NODE_BIN" "\$DIST_DIR\/migrate\.js"\s*$/m;
  const restart = /^\s*as_root systemctl restart "\$UNIT"\s*$/m;

  for (const [label, re] of Object.entries({
    installJs,
    installDrizzle,
    migrate,
    restart,
  })) {
    const at = deployScript.search(re);
    expect(at, `deploy.sh has no executable command matching: ${label}`).toBeGreaterThan(-1);
  }

  // ORDER IS LOAD-BEARING, in both directions:
  //   install → migrate: the migrator resolves its journal relative to the installed
  //                   dist/migrate.js, so the drizzle/ folder must already be in place.
  //   migrate → restart: the P3b binary selects on columns introduced by 0001-0003
  //                   (buckets.organization_id, organizations, members,
  //                   s3_credentials). A restart without them crash-loops the unit.
  expect(deployScript.search(installJs)).toBeLessThan(deployScript.search(migrate));
  expect(deployScript.search(installDrizzle)).toBeLessThan(deployScript.search(migrate));
  expect(deployScript.search(migrate)).toBeLessThan(deployScript.search(restart));
});

test('a post-migration failure HARD STOPS instead of reverting the binary', () => {
  // DEFECT B. Rolling the binary back after the migration has run lands the previous
  // release on a schema it cannot read: 0002 sets buckets.organization_id NOT NULL with
  // no default, so the pre-P3a `INSERT INTO buckets (id, name)` fails with
  // "null value in column organization_id violates not-null constraint"
  // (reproduced against a real database), and 0002 also drops the global
  // buckets_name_key — a multi-tenancy invariant no dump-free revert can restore.
  //
  // This test EXECUTES the real on_error() with MIGRATED=1 and asserts it does not
  // touch dist/. A toContain assertion could not tell a reverting handler from one
  // that merely mentions the words.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-hardstop-'));
  try {
    seedPreviousRelease(dir, true);
    seedCurrentRelease(dir, true);

    const { stdout, stderr } = runDeployFunctions(
      dir,
      ['on_error'],
      [
        'MIGRATED=1',
        'RESTORE=1',
        // restore() must never be reached on this path. If on_error calls it anyway the
        // sentinel fires and the assertion on stdout fails.
        'restore() { echo "VIOLATION: restore() called after migrations"; }',
      ],
      ['on_error 1 999'],
    );

    // The failure is announced loudly and specifically, not swallowed.
    expect(stderr).toContain('HARD STOP');
    expect(stderr).toMatch(/migrations were attempted/i);
    // ...and the handler explains WHY it refused to roll back.
    expect(stderr).toMatch(/NOT rolling the binary back/);
    expect(stdout).not.toContain('VIOLATION');

    // The binary genuinely was left alone — this is the whole defect.
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe('NEW index');
    expect(readFileSync(join(dir, 'dist', 'migrate.js'), 'utf8')).toBe('NEW migrate');
    // The new migrations folder stays put, matching the installed binary.
    expect(existsSync(join(dir, 'dist', 'drizzle', 'meta', '_journal.json'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PRE-migration failure still reverts the bundle automatically', () => {
  // The counterpart to the hard stop above: the revert must survive where it is safe.
  // With MIGRATED=0 nothing has touched the database, so the previous release provably
  // matches the previous schema and restoring it is a genuine recovery.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-prerestore-'));
  try {
    seedPreviousRelease(dir, true);
    seedCurrentRelease(dir, true);

    const { stdout, stderr } = runDeployFunctions(
      dir,
      ['restore', 'on_error'],
      ['MIGRATED=0', 'RESTORE=1'],
      ['on_error 1 999'],
    );

    expect(stdout).toContain('restoring previous dist');
    expect(stderr).not.toContain('HARD STOP');
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe('OLD index');
    expect(readFileSync(join(dir, 'dist', 'migrate.js'), 'utf8')).toBe('OLD migrate');
    expect(readFileSync(join(dir, 'dist', 'drizzle', 'meta', '_journal.json'), 'utf8')).toBe(
      '{"old":true}',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore() removes a stale drizzle/ the previous release never had (DEFECT A)', () => {
  // DEFECT A, verified by EXECUTION. restore() used to guard the revert on
  // `[ -d "$PREV/drizzle" ]`. On the FIRST deploy that ships drizzle/, release N-1 has
  // no such folder, so the branch was skipped, nothing removed $DIST_DIR/drizzle, and
  // the old binary was restored while KEEPING the new migrations folder — the exact
  // schema/binary skew P5 exists to close, introduced by the rollback itself.
  //
  // A string assertion cannot distinguish "removes it" from "does nothing"; this runs
  // the real restore() against a simulated first-P5-deploy filesystem.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-defecta-'));
  try {
    seedPreviousRelease(dir, false); // no drizzle/ — release N-1, before P5
    seedCurrentRelease(dir, true); // the new release, journal installed

    const { stdout } = runDeployFunctions(dir, ['restore'], [], ['restore']);

    // The binaries revert...
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe('OLD index');
    expect(readFileSync(join(dir, 'dist', 'migrate.js'), 'utf8')).toBe('OLD migrate');
    // ...and the migrations folder the previous release never had is GONE.
    expect(existsSync(join(dir, 'dist', 'drizzle'))).toBe(false);
    expect(stdout).toContain('removed drizzle/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore() still reverts drizzle/ when the previous release HAD one', () => {
  // The mirror image of DEFECT A, so the fix cannot regress the ordinary case: a
  // release-to-release rollback must restore the previous migrations folder.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-hasprev-'));
  try {
    seedPreviousRelease(dir, true);
    seedCurrentRelease(dir, true);

    const { stdout } = runDeployFunctions(dir, ['restore'], [], ['restore']);

    expect(stdout).toContain('restored previous drizzle/');
    expect(stdout).not.toContain('removed drizzle/');
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe('OLD index');
    expect(readFileSync(join(dir, 'dist', 'drizzle', 'meta', '_journal.json'), 'utf8')).toBe(
      '{"old":true}',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore() removes a web/ SPA the previous release never had (DEFECT A, web arm)', () => {
  // The SAME defect as DEFECT-A above, one directory over. The first deploy that ships
  // `web/` is exactly the case that fires it: release N-1 has no SPA directory, so a
  // guard written as `if [ -d "$PREV/web" ]` would skip the branch and leave the NEW
  // SPA serving next to the OLD binary.
  //
  // Before P5c this was asserted for drizzle/ ONLY — `web/` appeared in neither of the
  // two executable rollback tests, so a SPA restore that was wrong in EVERY shape
  // (missing branch, guard-only branch, no removal branch) passed the suite green.
  // Verified by EXECUTION against a simulated first-P4-deploy filesystem, because a
  // string assertion cannot distinguish "removes it" from "does nothing".
  const dir = mkdtempSync(join(tmpdir(), 'deploy-webrestore-'));
  try {
    seedPreviousRelease(dir, true, false); // no web/ — release N-1, before P4
    seedCurrentRelease(dir, true, true); // the new release, SPA installed

    const { stdout } = runDeployFunctions(dir, ['restore'], [], ['restore']);

    // The binaries revert...
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe('OLD index');
    expect(readFileSync(join(dir, 'dist', 'migrate.js'), 'utf8')).toBe('OLD migrate');
    // ...and the SPA the previous release never had is GONE. Without this branch the
    // previous release is left exactly as it was, which is the whole point of rollback.
    expect(existsSync(join(dir, 'dist', 'web'))).toBe(false);
    expect(stdout).toContain('removed web/');
    expect(stdout).toContain('previous release shipped no SPA directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore() still reverts web/ when the previous release HAD one', () => {
  // The mirror image, so the fix above cannot regress the ordinary case: a
  // release-to-release rollback must restore the previous SPA's hashed assets too,
  // not just index.html. An incomplete restore would leave the NEW index.html pointing
  // at asset hashes that no longer exist on disk — a broken page, not a rollback.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-webhasprev-'));
  try {
    seedPreviousRelease(dir, true, true);
    seedCurrentRelease(dir, true, true);

    const { stdout } = runDeployFunctions(dir, ['restore'], [], ['restore']);

    expect(stdout).toContain('restored previous web/ SPA');
    expect(stdout).not.toContain('removed web/');
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe('OLD index');
    expect(readFileSync(join(dir, 'dist', 'web', 'index.html'), 'utf8')).toBe('OLD SPA');
    expect(readFileSync(join(dir, 'dist', 'web', 'assets', 'index-old.js'), 'utf8')).toBe(
      'OLD asset',
    );
    // The new release's asset must NOT survive: this is the flatten-into-$STAGE-root
    // failure the subdirectory staging exists to prevent.
    expect(existsSync(join(dir, 'dist', 'web', 'assets', 'index-new.js'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the drizzle migrations folder is shipped, installed and rolled back', () => {
  // Shipping only *.js meant every one of resolveMigrationsFolder()'s six candidates
  // missed in the deployed layout — verified by running the real built dist/migrate.js
  // from a directory containing only itself: exit 1, "drizzle migrations folder not
  // found". The folder is DATA; esbuild does not bundle it.
  expect(deployScript).toMatch(/scp -r[^\n]*apps\/api\/drizzle/);

  // The install and restore loops previously globbed "*.js" only, so a staged
  // drizzle/ was skipped on install AND not reverted on rollback — leaving the new
  // binary paired with the previous release's migrations. Both loops must handle it.
  expect(deployScript).toContain('say "installed drizzle/ migrations"');
  // BOTH restore outcomes must be reachable: revert a previous folder, or remove one
  // the previous release never had. The second branch is DEFECT A — its absence is
  // what left the new journal beside the old binary on the first P5 deploy.
  expect(deployScript).toContain('say "restored previous drizzle/ migrations"');
  expect(deployScript).toContain(
    'removed drizzle/ (previous release shipped no migrations folder)',
  );

  // Both the *-check list and the remote preflight must cover the journal, so a
  // missing folder fails BEFORE the new bundle is on disk rather than after.
  expect(deployScript).toContain('apps/api/drizzle/meta/_journal.json');
  expect(deployScript).toContain('staged drizzle/meta/_journal.json not found');
});

test('the SPA is shipped as a named subdirectory, installed and rolled back', () => {
  // Stage as `$STAGE/web`, NEVER flattened into the stage root. The install loop globs
  // `"$STAGE"/*.js`; Vite's hashed `index-<hash>.js` chunks dumped into the root would be
  // swept into $DIST_DIR's top level and — because restore() copies files that exist in
  // $PREV and never prunes — would survive rollback permanently. Measured on a real
  // restore() run: dist/index.js was correctly OLD while dist/index-a1b2c3.js was still
  // the NEW release's asset.
  expect(deployScript).toMatch(
    /scp -r[^\n]*apps\/web\/dist "\$\{SSH_DEST\}:\$\{STAGE_REMOTE\}\/web"/,
  );
  // The destination must be the LITERAL name `web`, asserted with a regex rather than a
  // bare string so biome's noTemplateCurlyInString does not read the shell expansion
  // `${STAGE_REMOTE}/web` as a stray template placeholder (same reason the
  // MIGRATION_APP assertion above is written without its `${...}` text). A refactor
  // that drops the named destination and lets scp infer the name from the source would
  // fail here instead of silently staging the contents.
  expect(deployScript).toMatch(/\$\{STAGE_REMOTE\}\/web"/);

  // Installed as a whole directory, mirroring drizzle, and BEFORE the restart.
  expect(deployScript).toContain('say "installed web/ SPA"');
  const installWeb = deployScript.search(
    /^\s*as_root mv -f "\$DIST_DIR\/web\.new" "\$DIST_DIR\/web"\s*$/m,
  );
  const migrateAt = deployScript.search(
    /^\s*as_root bws-exec "\$MIGRATION_APP" -- "\$NODE_BIN" "\$DIST_DIR\/migrate\.js"\s*$/m,
  );
  const restartAt = deployScript.search(/^\s*as_root systemctl restart "\$UNIT"\s*$/m);
  expect(installWeb, 'deploy.sh has no executable web/ install command').toBeGreaterThan(-1);
  expect(installWeb, 'the SPA must be installed BEFORE the restart').toBeLessThan(restartAt);
  expect(installWeb, 'the SPA must be installed BEFORE migrations').toBeLessThan(migrateAt);

  // BOTH restore outcomes must be reachable, exactly as for drizzle/. The removal branch
  // is the one that matters on the first P4 deploy.
  expect(deployScript).toContain('say "restored previous web/ SPA"');
  expect(deployScript).toContain('removed web/ (previous release shipped no SPA directory)');
});

test('the SPA sentinel is a FILE, never a bare directory', () => {
  // `[ -e dir ]` is TRUE for an EMPTY directory, so listing a bare `apps/web/dist` in
  // the --check list would report green after a failed or never-run `vite build`, and
  // scp would ship an empty folder — which serves a WHITE SCREEN at `/` with a 200 HTML
  // response. Same defect class as the old `schema.sql` entry.
  //
  // Scope the search to the `for f in ...` LIST ITSELF. Slicing from the "Files to
  // deploy" heading to the end of the file also captures the scp source path further
  // down, which is legitimately a bare `apps/web/dist` — the two are different things
  // and conflating them fails the assertion for the wrong reason.
  const checkList = /for f in ([^\n]*); do\n/.exec(deployScript);
  expect(checkList, 'could not find the --check file list in deploy.sh').not.toBeNull();
  expect(checkList?.[1]).toContain('apps/web/dist/index.html');
  // No entry in the list may name the bare directory.
  for (const entry of (checkList?.[1] ?? '').split(/\s+/).filter(Boolean)) {
    expect(entry, `--check must name a sentinel FILE, not the bare directory: ${entry}`).not.toBe(
      /^apps\/web\/dist$/,
    );
  }

  // And the remote preflight must cover it, so a missing SPA fails BEFORE the new
  // bundle is on disk.
  expect(deployScript).toContain('staged web/index.html not found');

  // The staleness guard must cover the SPA sources too: without apps/web/src in the
  // `find` list, the API bundle's freshness says nothing about the SPA's and a stale
  // SPA ships silently on every CI deploy.
  expect(deployScript).toMatch(/find apps\/api\/src apps\/api\/drizzle apps\/web\/src/);
});

// THE LINK THIS FILE WAS MISSING. It asserts migration invocation, migration
// ORDERING, hard-stop semantics and SPA rollback — the entire install→migrate→seed
// →restart chain — and stopped exactly one link short: nothing anywhere asserted
// that the SPA it installs is ever REACHABLE.
//
// `grep -rn WEB_DIST_PATH apps/api/test/` returned only COMMENTS (live-probe.ts,
// hono-routing.test.ts, s3-routing.test.ts) and never an executable assertion. So
// a deploy that ships apps/web/dist/index.html, installs it at $DIST_DIR/web,
// restarts, and answers 404 at `/` passes this entire file — the mirror image of
// the `toContain('migrate.js')` assertion that let the original P5 defect survive:
// asserting a string is present when what matters is a wire-level behaviour.
test('tells the running process where the installed SPA is', () => {
  const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');

  // (1) .env.example must document the variable, so the setting is discoverable and
  // a deploy cannot omit it by ignorance.
  expect(envExample).toContain('WEB_DIST_PATH');

  // (2) deploy.sh must EXPORT it, in the same block that installs web/ — the unit
  // inherits the environment from there. Without the export, spa-controller's
  // resolveDistDir() returns null and every SPA route falls through to 404 while
  // every other assertion in this file stays green.
  expect(deployScript).toMatch(/export\s+WEB_DIST_PATH=/);

  // (3) It must point at the directory deploy.sh actually installs. `$DIST_DIR/web`
  // is the destination asserted above (`$DIST_DIR/web.new` → `$DIST_DIR/web`), so
  // any other value would point the unit at a path that does not exist and
  // resolveSpaRoot() would log its "no index.html is there" warning and 404.
  expect(deployScript).toMatch(/WEB_DIST_PATH=["']?\$\{?DIST_DIR\}?\/web/);

  // (4) The export must come AFTER the install, or the unit restarts into a state
  // where it is told to serve a directory that is not there yet.
  const installWeb = deployScript.search(
    /^\s*as_root mv -f "\$DIST_DIR\/web\.new" "\$DIST_DIR\/web"\s*$/m,
  );
  const exportWebDist = deployScript.search(/export\s+WEB_DIST_PATH=/);
  expect(installWeb, 'deploy.sh has no executable web/ install command').toBeGreaterThan(-1);
  expect(exportWebDist, 'deploy.sh never exports WEB_DIST_PATH').toBeGreaterThan(-1);
  expect(exportWebDist, 'WEB_DIST_PATH must be exported AFTER web/ is installed').toBeGreaterThan(
    installWeb,
  );
});

// The deploy-health probe proved the API was alive and nothing about the dashboard:
// it stopped at /health. A unit that migrated, seeded, restarted, served /health
// perfectly and answered 404 at `/` — the exact P4 shipping failure — was reported
// as a successful deploy.
test('the deploy health probe proves the SPA answers 200 HTML at the site root', () => {
  // A second probe, run only when the port was resolved, hitting the site root.
  expect(deployScript).toMatch(/site root probe/);

  // It must assert BOTH status and content-type. A status-only check would accept
  // the 200 that the S3 catch-all returns for an S3-shaped path, or any other
  // 200 the API might serve; what proves the DASHBOARD answered is HTML.
  expect(deployScript).toMatch(/text\/html/);
});

test('MIGRATED is set BEFORE the migration runs, not after it succeeds', () => {
  // The flag that separates the two rollback windows has to flip at the attempt, not
  // at the success: a migration that fails halfway HAS changed the schema, which is
  // exactly when reverting the binary is most dangerous and least safe.
  //
  // Asserted as an ordering between two real statements, so deleting the assignment
  // (leaving on_error permanently in the hard-stop branch, or permanently rolling back)
  // breaks this test.
  const markAt = deployScript.search(/^\s*MIGRATED=1\s*$/m);
  const migrateAt = deployScript.search(
    /^\s*as_root bws-exec "\$MIGRATION_APP" -- "\$NODE_BIN" "\$DIST_DIR\/migrate\.js"\s*$/m,
  );
  expect(markAt, 'deploy.sh never sets MIGRATED=1').toBeGreaterThan(-1);
  expect(migrateAt).toBeGreaterThan(-1);
  expect(markAt).toBeLessThan(migrateAt);

  // It must be initialised to 0 near the top, or `set -u` would abort on first read.
  expect(deployScript).toMatch(/^MIGRATED=0$/m);
  // And on_error must consult it — otherwise the flag is dead code.
  expect(extractFunction(deployScript, 'on_error')).toMatch(/MIGRATED/);
});

test('the migration gets its environment (migrate.js imports env.ts)', () => {
  // migrate.ts imports config from src/env.ts, which THROWS without DATABASE_URL,
  // BOT_TOKENS, STORAGE_CHANNEL_ID, BASE_URL and PORT. Verified: running dist/migrate.js
  // with only DATABASE_URL set exits non-zero before reaching the database.
  //
  // Those variables are injected at RUNTIME by bws-exec (the unit's ExecStart), so a
  // bare `node migrate.js` over SSH has none of them. The invocation must therefore go
  // through bws-exec, or it fails on the VPS for a reason unrelated to migrations.
  expect(deployScript).toContain('bws-exec');
  expect(deployScript).toMatch(
    /bws-exec "\$MIGRATION_APP" -- "\$NODE_BIN" "\$DIST_DIR\/migrate\.js"/,
  );
  // Preflight it too, so a box without bws-exec fails before anything is installed.
  expect(deployScript).toContain('bws-exec not found');
  // MIGRATION_APP must default to the same app name the unit's ExecStart uses. Asserted
  // without the `${...}` default-expansion text so biome's noTemplateCurlyInString does
  // not read this literal shell expansion as a stray template placeholder.
  expect(deployScript).toMatch(/MIGRATION_APP="\$\{MIGRATION_APP:-\$\{APP_NAME\}\}"/);
});

test('--check asserts only files deploy.sh really ships', () => {
  // apps/api/schema.sql used to be listed in the --check output but was never shipped
  // and has not run at boot since P2a removed the boot-time auto-migration — so the
  // entry asserted a deployment step that did not exist, and check mode reported 5/5
  // green over a partly fictional file list.
  const checkBlock = deployScript.slice(deployScript.indexOf('Files to deploy'));
  expect(checkBlock).not.toContain('apps/api/schema.sql');
  expect(checkBlock).toContain('apps/api/drizzle/meta/_journal.json');
});

test('the migration verification harness is WIRED, not just present', () => {
  const harness = readFileSync(
    new URL('../../../scripts/verify-migrations.ts', import.meta.url),
    'utf8',
  );
  // The harness applies real DDL, so both gates must be present and independent:
  // an explicit opt-in flag AND a scratch-shaped database name.
  expect(harness).toContain('--allow-writes');
  expect(harness).toContain('--allow-non-scratch');
  expect(harness).toContain('Refusing to write to database');
  // It must exercise the runner that actually ships, not a reimplementation.
  expect(harness).toContain('dist');
  expect(harness).toContain('migrate.js');

  // This test previously stopped here — and that was the whole problem. Asserting the
  // file contains certain strings proves the file exists; it does not prove anything
  // ever RUNS it. scripts/verify-migrations.ts was referenced by nothing except this
  // test, so a harness that had silently rotted (broken psql path, wrong cwd, a
  // migration that no longer applies) would still show green forever.
  //
  // So assert the wiring itself: a package.json script that invokes the file, and a CI
  // job that runs that script against a real PostgreSQL.
  const apiPackageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  expect(apiPackageJson.scripts['verify:migrations']).toContain('verify-migrations.ts');

  const ciFile = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  expect(ciFile).toContain('verify:migrations');
  // A real database, or the harness cannot apply DDL at all.
  expect(ciFile).toMatch(/image:\s*postgres:/);
  expect(ciFile).toContain('--allow-writes');
  // And the build must precede it: the harness executes apps/api/dist/migrate.js.
  expect(ciFile.indexOf('pnpm run build')).toBeLessThan(
    ciFile.indexOf('verify:migrations --allow-writes'),
  );
});

test('the deploy seeds between migrate and restart, not after', () => {
  // WHY THIS EXISTS — the gap this pins was found by running the pieces, not by
  // reading them. scripts/verify-migrations.ts runs migrate AND seed, so the CI job
  // proved a sequence the deploy never performed: deploy.sh invoked migrate.js and
  // stopped. Nothing in CI could see that, because the harness was doing more than
  // production did.
  //
  // The consequence was silent and total. makeSecretResolver()
  // (apps/api/src/presentation/http/controllers/s3/s3-router.ts:101-112) resolves
  // S3 credentials from s3_credentials and has NO environment fallback — verified:
  // `grep s3AccessKey src/presentation/s3/auth.ts` matches only a comment. seed.ts is
  // the only thing that adopts the existing S3_ACCESS_KEY / S3_SECRET_KEY pair into
  // the bootstrap organization. So a deploy that migrates but never seeds leaves a
  // healthy-looking dashboard and a 403 for every S3 client: aws-cli, rclone, and
  // the Docker registry push path.
  //
  // Asserted as real statement ordering, so deleting the seed invocation — or moving
  // it after the restart — breaks this test. A toContain on the string 'seed.js'
  // would not: it proves the name is in the file, not that anything ran.
  const migrateAt = deployScript.search(
    /^\s*as_root bws-exec "\$MIGRATION_APP" -- "\$NODE_BIN" "\$DIST_DIR\/migrate\.js"\s*$/m,
  );
  const seedAt = deployScript.search(
    /^\s*as_root bws-exec "\$MIGRATION_APP" -- "\$NODE_BIN" "\$DIST_DIR\/seed\.js"\s*$/m,
  );
  const restartAt = deployScript.search(/^\s*as_root systemctl restart "\$UNIT"\s*$/m);

  expect(migrateAt, 'deploy.sh never invokes the migration runner').toBeGreaterThan(-1);
  expect(
    seedAt,
    'deploy.sh never invokes the seeder — S3 has no environment fallback',
  ).toBeGreaterThan(-1);
  expect(restartAt, 'deploy.sh never restarts the unit').toBeGreaterThan(-1);

  expect(seedAt, 'the seed must run AFTER the migrations it depends on').toBeGreaterThan(migrateAt);
  expect(
    seedAt,
    'the seed must run BEFORE the restart, or the unit serves without it',
  ).toBeLessThan(restartAt);

  // The bundle has to be shipped, pre-flighted and asserted, like migrate.js. A
  // missing seed.js on the VPS would otherwise fail at the last possible moment.
  expect(deployScript).toMatch(/scp[^\n]*apps\/api\/dist\/seed\.js/);
  expect(deployScript).toContain('apps/api/dist/seed.js');
  expect(deployScript).toMatch(/\[ -f apps\/api\/dist\/seed\.js \] \|\| die/);

  // And it must be a real bundle, not a tsx invocation: deploy.sh ships dist/ only,
  // never src/, so `tsx src/.../seed.ts` cannot run there. Verified: the VPS receives
  // exactly index.js, migrate.js, seed.js and drizzle/.
  const apiPackageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string>; devDependencies?: Record<string, string> };
  expect(apiPackageJson.scripts['db:seed']).toBe('node dist/seed.js');
  expect(apiPackageJson.scripts['db:seed']).not.toMatch(/\btsx\b/);
  expect(apiPackageJson.scripts.build).toContain('dist/seed.js');
});
