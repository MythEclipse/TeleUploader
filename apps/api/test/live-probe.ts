/**
 * P2b — live route probe.
 *
 * The unit suite (hono-routing.test.ts) proves routing with mocked controllers.
 * This boots the REAL Hono app on a real socket with the REAL controllers, so the
 * Hono swap can be compared against live HTTP behaviour — same paths, same status
 * codes as the old `node:http` shim served.
 *
 * It does not boot src/index.ts, because that calls Telegram getMe and exits
 * non-zero without valid credentials, before the HTTP server is reachable.
 *
 * Requires DATABASE_URL pointing at a scratch database. It is NOT a .test.ts
 * file, so Vitest never collects it, and it is deliberately not in test:unit: it
 * opens a socket. Run by hand:
 *
 *   DATABASE_URL=postgresql://... npx tsx test/live-probe.ts
 */
process.env.BOT_TOKENS = process.env.BOT_TOKENS ?? '1:test';
process.env.STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ?? '-1001234';
process.env.BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4311';
process.env.PORT = process.env.PORT ?? '4311';
// ADMIN_API_TOKEN left unset on purpose: with auth disabled, requireAuth passes
// writes straight through and /auth/me answers 404. Those are pre-existing
// behaviours, and pinning them here proves the Hono swap preserved them. Set
// ADMIN_API_TOKEN to probe the authenticated path instead.
delete process.env.ADMIN_API_TOKEN;

const { serve } = await import('@hono/node-server');
const { createApp } = await import('../src/presentation/http/app');

const PORT = 4311;
const server = serve({ fetch: createApp().fetch, port: PORT });

await new Promise((resolve) => setTimeout(resolve, 400));

/** Each probe mirrors a route the old shim served. */
const PROBES: { label: string; method: string; path: string; expect: number }[] = [
  { label: 'health (deploy probe)', method: 'GET', path: '/health', expect: 200 },
  { label: 'healthz alias', method: 'GET', path: '/healthz', expect: 200 },
  { label: 'public download redirect', method: 'GET', path: '/f/bogus-id', expect: 404 },
  { label: 'public file info', method: 'GET', path: '/file/bogus-id/info', expect: 404 },
  { label: 'dashboard list (public GET)', method: 'GET', path: '/api/v1/buckets', expect: 200 },
  // ADMIN_API_TOKEN is unset for this probe, so auth is DISABLED: /auth/me answers
  // 404 and writes pass through requireAuth untouched. Both are pre-existing
  // behaviours, pinned here to prove the Hono swap preserved them.
  { label: 'auth/me (auth disabled -> 404)', method: 'GET', path: '/api/v1/auth/me', expect: 404 },
  {
    label: 'write w/o token (auth disabled)',
    method: 'DELETE',
    path: '/api/v1/buckets/x',
    expect: 404,
  },
  { label: 'upload without body (4xx)', method: 'POST', path: '/api/upload', expect: 400 },
  // 200 in dev because src/home.html sits next to the source. In production this
  // is the known 500, because deploy.sh never ships home.html — the bug the P4
  // React SPA fixes. Pinned as 200 here so the probe passes from a checkout.
  { label: 'site root (dev home.html)', method: 'GET', path: '/', expect: 200 },
  { label: 'CORS preflight', method: 'OPTIONS', path: '/', expect: 204 },
  { label: 'root PUT without S3 (405)', method: 'PUT', path: '/', expect: 405 },
  { label: 'unknown path (404)', method: 'GET', path: '/definitely/not/a/route', expect: 404 },
];

let failures = 0;
for (const probe of PROBES) {
  const res = await fetch(`http://127.0.0.1:${PORT}${probe.path}`, { method: probe.method });
  const ok = res.status === probe.expect;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${probe.label.padEnd(34)} ${probe.method} ${probe.path} -> ${res.status} (expected ${probe.expect})`,
  );
}

// A SigV4-shaped request must reach the S3 controller rather than the dashboard.
// The controller answers with an XML error (bad credentials), which is proof it
// was reached: the dashboard would answer with HTML.
const s3Res = await fetch(`http://127.0.0.1:${PORT}/`, {
  headers: {
    authorization: 'AWS4-HMAC-SHA256 Credential=AK/20240101/us-east-1/s3/aws4_request',
  },
});
const s3ContentType = s3Res.headers.get('content-type') ?? '';
const s3ReachedController = s3ContentType.includes('xml');
if (!s3ReachedController) failures += 1;
console.log(
  `  ${s3ReachedController ? 'PASS' : 'FAIL'}  ${'SigV4 root reaches S3, not home'.padEnd(34)} GET / -> ${s3Res.status} ct=${s3ContentType}`,
);

server.close();

console.log(failures === 0 ? '\nLIVE PROBE PASSED' : `\nLIVE PROBE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
