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
  // MIGRATION FREEZE (P0–P5b): the push trigger is removed so no phase merge can
  // deploy straight to production. `workflow_dispatch` must remain the only trigger —
  // without it .semrel/dispatch.mjs has nothing to dispatch and the deploy path is
  // unreachable. Restore the push trigger in P5c.
  expect(workflowFile).not.toMatch(/^\s{2}push:\s*$/m);
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

/** Create a previous-release dist/ tree. `withDrizzle` is the first-P5-deploy case. */
const seedPreviousRelease = (dir: string, withDrizzle: boolean): void => {
  mkdirSync(join(dir, 'dist.previous'), { recursive: true });
  writeFileSync(join(dir, 'dist.previous', 'index.js'), 'OLD index');
  writeFileSync(join(dir, 'dist.previous', 'migrate.js'), 'OLD migrate');
  if (withDrizzle) {
    mkdirSync(join(dir, 'dist.previous', 'drizzle', 'meta'), { recursive: true });
    writeFileSync(join(dir, 'dist.previous', 'drizzle', 'meta', '_journal.json'), '{"old":true}');
  }
};

/** Create the current dist/ tree: the newly installed release, journal included. */
const seedCurrentRelease = (dir: string, withDrizzle = true): void => {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), 'NEW index');
  writeFileSync(join(dir, 'dist', 'migrate.js'), 'NEW migrate');
  if (withDrizzle) {
    mkdirSync(join(dir, 'dist', 'drizzle', 'meta'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'drizzle', 'meta', '_journal.json'), '{"new":true}');
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
