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

test('deploy workflow builds with nix and deploys to VPS on main', () => {
  expect(workflowFile).toContain('branches: [main]');
  expect(workflowFile).toContain('uses: actions/checkout@v7');
  expect(workflowFile).toContain('uses: oven-sh/setup-bun@v2');
  expect(workflowFile).toContain('bun install --frozen-lockfile');
  expect(workflowFile).toContain('bunx biome check src test');
  expect(workflowFile).toContain('VPS_HOST');
  expect(workflowFile).toContain('VPS_USER');
  expect(workflowFile).toContain('nix copy');
  expect(workflowFile).toContain('systemctl restart teleuploader');
});
