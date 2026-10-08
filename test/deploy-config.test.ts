import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const repoRoot = new URL('../', import.meta.url);
const deployScript = readFileSync(new URL('../deploy.sh', import.meta.url), 'utf8');

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
  new URL('../.github/workflows/deploy.yml', import.meta.url),
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
