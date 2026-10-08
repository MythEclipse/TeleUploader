/**
 * P3b fix — boot-path probe for the dashboard tenant scope.
 *
 * Exercises EXACTLY the check src/index.ts performs at startup, and nothing
 * else, so it can run in a child process without booting the HTTP server or
 * calling Telegram. It exists because the previous probe could not see this
 * failure at all: with ADMIN_API_TOKEN unset, `GET /api/v1/buckets` returned 200
 * and the probe reported PASS, while a production deploy WITH auth enabled
 * answered 403 on that same route.
 *
 *   tsx test/tenant-scope-boot-probe.ts    -> exit 0 = scope resolved
 *                                             exit 1 = misconfiguration
 *
 * It must run in its OWN process. env.ts captures `config` at module load, so
 * pointing BOOTSTRAP_ADMIN_ID at a bad value from inside an already-loaded
 * process would not re-read it — that is precisely the "declaration trusted
 * downstream instead of re-checked" trap, one level up.
 */
process.env.BOT_TOKENS ||= '1:test';
process.env.STORAGE_CHANNEL_ID ||= '-1001234';
process.env.BASE_URL ||= 'http://127.0.0.1:4311';
process.env.PORT ||= '4311';

const { resolveAdminOrganizationId } = await import(
  '../src/presentation/http/controllers/organization-resolver'
);

try {
  const organizationId = await resolveAdminOrganizationId();
  console.log(
    JSON.stringify({ ok: true, organizationId, bootstrapAdminId: process.env.BOOTSTRAP_ADMIN_ID }),
  );
  process.exit(0);
} catch (error: unknown) {
  // The message is the operator-facing remedy. It is printed, not swallowed.
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
