import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

test('migrations run AFTER the bundle is installed and BEFORE the restart', () => {
  const migrateAt = deployScript.indexOf('say "applying database migrations"');
  const installAt = deployScript.indexOf('say "installed drizzle/ migrations"');
  const restartAt = deployScript.indexOf('say "restarting $UNIT"');

  expect(migrateAt).toBeGreaterThan(-1);
  expect(installAt).toBeGreaterThan(-1);
  expect(restartAt).toBeGreaterThan(-1);

  // ORDER IS LOAD-BEARING, in both directions:
  //   install → migrate: the migrator resolves its journal relative to the installed
  //                   dist/migrate.js, so the drizzle/ folder must already be in place.
  //   migrate → restart: the P3b binary selects on columns introduced by 0001-0003
  //                   (buckets.organization_id, organizations, members,
  //                   s3_credentials). A restart without them crash-loops the unit.
  expect(installAt).toBeLessThan(migrateAt);
  expect(migrateAt).toBeLessThan(restartAt);
});

test('migrations run while rollback is still armed', () => {
  // RESTORE=1 is set before the install loop and cleared after the health probe. The
  // migration must land INSIDE that window so a migration failure rolls the binary
  // AND its drizzle/ folder back together, instead of leaving the previous binary
  // running against a half-migrated schema.
  const armedAt = deployScript.indexOf('RESTORE=1');
  const migrateAt = deployScript.indexOf('say "applying database migrations"');
  // Disarm by SEARCHING FORWARD from the migration. A bare indexOf('RESTORE=0') would
  // match the `RESTORE=0` initialiser near the top of the script and compare against
  // the wrong line entirely — which is exactly the kind of check that passes while
  // asserting nothing.
  const clearedAt = deployScript.indexOf('RESTORE=0', migrateAt);

  expect(armedAt).toBeGreaterThan(-1);
  expect(migrateAt).toBeGreaterThan(armedAt);
  expect(clearedAt).toBeGreaterThan(migrateAt);
  // And the disarm must still be inside the armed window (i.e. RESTORE=1 came first).
  expect(armedAt).toBeLessThan(clearedAt);
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
  expect(deployScript).toContain('say "restored previous drizzle/ migrations"');

  // Both the *-check list and the remote preflight must cover the journal, so a
  // missing folder fails BEFORE the new bundle is on disk rather than after.
  expect(deployScript).toContain('apps/api/drizzle/meta/_journal.json');
  expect(deployScript).toContain('staged drizzle/meta/_journal.json not found');
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

test('the migration verification harness exists and refuses to write by default', () => {
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
});
