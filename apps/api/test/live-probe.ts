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
//
// NOTE (P3b fix): this file was ALSO hiding a real outage. With auth disabled it
// reported PASS for `GET /api/v1/buckets`, while a production deploy WITH auth
// enabled denied every dashboard request because the bootstrap admin had no
// membership — 403 on that public GET, 401 on every oRPC procedure. The probe
// was structurally unable to see it. The misconfiguration probe at the bottom of
// this file now covers that case directly.
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
  // P4: `/` is no longer `handleHome` reading `src/home.html`. It is the SPA
  // shell from `spa-controller`, which returns null when WEB_DIST_PATH is unset
  // and the route falls through to a bare 404.
  //
  // This used to pin `expect: 404` UNCONDITIONALLY, on the reasoning that "404 is
  // the honest answer for an unconfigured SPA and is identical in both
  // environments". That reasoning was the defect: the probe passed for the wrong
  // reason by construction. A deployed unit that DOES configure WEB_DIST_PATH and
  // still served 404 at `/` — the exact P4 shipping failure — was indistinguishable
  // from a correct backend-only deploy, so the probe could never fail.
  //
  // It now branches on the environment, which is the one thing that differs
  // between the two deployments. With WEB_DIST_PATH set the shell must be served;
  // without it, the pre-P4 404 is correct. Either way the probe can fail, and
  // `grep -rn WEB_DIST_PATH deploy.sh` is asserted executable in
  // deploy-config.test.ts, so the "never configured" arm has a trip-wire too.
  {
    label: `site root (SPA ${process.env.WEB_DIST_PATH ? 'configured' : 'not configured'})`,
    method: 'GET',
    path: '/',
    expect: process.env.WEB_DIST_PATH ? 200 : 404,
  },
  { label: 'CORS preflight', method: 'OPTIONS', path: '/', expect: 204 },
  { label: 'root PUT without S3 (405)', method: 'PUT', path: '/', expect: 405 },
  { label: 'unknown path (404)', method: 'GET', path: '/definitely/not/a/route', expect: 404 },
  // P2b REGRESSION, now flipped. Porting the route table to Hono dropped /docs
  // and /swagger.json, which routes/index.ts had served. swagger.test.ts kept
  // passing because it imported the handlers directly and never went through the
  // app. P4 re-registered both in app.ts and flipped these to 200.
  //
  // The trip-wire is still live in the other direction: these are checked over
  // REAL HTTP on a real socket with the real handlers, so the next port that
  // drops a registration fails here.
  //
  // (The old comment named oRPC's OpenAPIHandler as the mechanism. It does not
  // exist in the installed packages — `Object.keys(require('@orpc/server/fetch'))`
  // is BodyLimitPlugin, CompositeFetchHandlerPlugin, CompressionPlugin,
  // FetchHandler, RPCHandler. The hand-written handlers were re-registered.)
  { label: 'swagger docs (restored in P4)', method: 'GET', path: '/docs', expect: 200 },
  { label: 'swagger json (restored in P4)', method: 'GET', path: '/swagger.json', expect: 200 },
  { label: 'SPA asset with no SPA configured', method: 'GET', path: '/assets/x.js', expect: 404 },
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

// ── oRPC surface (P2c) ─────────────────────────────────────────────────────
// Exercised over real HTTP so the contract, the Zod inputs, the handler binding
// and the RPCHandler wiring are all covered together.
const rpc = async (procedure: string, input?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  return { res, body: await res.json().catch(() => undefined) };
};

console.log('\n  oRPC (/rpc):');

{
  // oRPC wraps the handler's return in `{ json: ... }`.
  const { res, body } = await rpc('bucket/listBuckets');
  const payload = (body as { json?: { buckets?: unknown[] } })?.json;
  // Assert the ARRAY IS NON-EMPTY and matches the REST surface. The previous
  // assertion was `Array.isArray(payload?.buckets)`, which the CONTRACT PLACEHOLDER
  // satisfied with `[]` — so it passed while every oRPC procedure silently returned
  // placeholder data instead of calling the controllers. Found by adversarial
  // review, not by this suite.
  const ok = res.status === 200 && Array.isArray(payload?.buckets) && payload.buckets.length > 0;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${'rpc bucket/listBuckets (real data)'.padEnd(34)} -> ${res.status} body=${JSON.stringify(body ?? null).slice(0, 90)}`,
  );
}

{
  // Zod rejects before the controller: an uppercase name is not a valid bucket.
  const { res } = await rpc('bucket/createBucket', { name: 'NOT_VALID' });
  const ok = res.status >= 400;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${'rpc rejects invalid bucket name'.padEnd(34)} -> ${res.status}`,
  );
}

{
  const { res } = await rpc('bucket/doesNotExist');
  const ok = res.status >= 400;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${'rpc unknown procedure'.padEnd(34)} -> ${res.status}`);
}

{
  // An unclaimed path under /rpc must NOT be answered by the RPC handler.
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc/not-a-procedure/at/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const ok = res.status === 404;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${'rpc unmatched path falls through'.padEnd(34)} -> ${res.status}`,
  );
}

// ── Dashboard tenant scope (P3b fix) ────────────────────────────────────────
//
// The two probes above CANNOT see this failure, and that is why the original
// defect survived: with ADMIN_API_TOKEN unset, `GET /api/v1/buckets` answered
// 200 here while a deploy with auth enabled answered 403 on that same
// route, because the bootstrap admin had no `members` row. BOOTSTRAP_ADMIN_ID
// is set by nothing in the repo, so it defaulted to 'bootstrap-admin' — a row
// only `pnpm db:seed` creates, and deploy.sh runs neither migrate nor seed.
//
// So assert both branches directly, each in its OWN child process. A separate
// process is required, not stylistic: env.ts captures `config` at module load,
// so a bad BOOTSTRAP_ADMIN_ID set inside this already-loaded process would not
// be re-read and the probe would pass for the wrong reason.
console.log('\n  dashboard tenant scope:');

{
  const { spawnSync } = await import('node:child_process');
  const probe = (bootstrapAdminId: string) => {
    const result = spawnSync('npx', ['tsx', 'test/tenant-scope-boot-probe.ts'], {
      env: {
        ...process.env,
        BOOTSTRAP_ADMIN_ID: bootstrapAdminId,
      },
      encoding: 'utf8',
    });
    return { code: result.status, stdout: result.stdout ?? '' };
  };

  // A user id that cannot exist is what a deploy that never ran db:seed looks
  // like. It MUST fail loudly and early — not resolve, and above all not 403.
  {
    const { code, stdout } = probe('probe-definitely-not-a-member');
    let reported = false;
    try {
      reported =
        (JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { ok?: boolean }).ok === false;
    } catch {
      reported = false;
    }
    const ok = code === 1 && reported;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${'missing membership fails at boot'.padEnd(34)} -> exit ${code} (expected 1)`,
    );
  }

  // The positive control: the probe must be capable of PASSING, or the check
  // above proves nothing — a probe that always exits 1 would satisfy it too.
  if (process.env.DATABASE_URL) {
    const { code } = probe(process.env.BOOTSTRAP_ADMIN_ID ?? 'bootstrap-admin');
    const ok = code === 0;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${'configured membership resolves'.padEnd(34)} -> exit ${code} (expected 0)`,
    );
  } else {
    console.log(
      `  SKIP  ${'configured membership resolves'.padEnd(34)}         -> no DATABASE_URL`,
    );
  }
}

server.close();

console.log(failures === 0 ? '\nLIVE PROBE PASSED' : `\nLIVE PROBE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
