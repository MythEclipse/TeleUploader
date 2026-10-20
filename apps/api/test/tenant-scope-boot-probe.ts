/**
 * Boot-path probe for the shared admin token's organization.
 *
 * Exercises EXACTLY the check `src/index.ts` performs at startup, and nothing
 * else, so it can run in a child process without booting the HTTP server or
 * calling Telegram.
 *
 *   tsx test/tenant-scope-boot-probe.ts    -> exit 0 = bootstrap org resolved
 *                                             exit 1 = no membership
 *
 * ── WHAT CHANGED, AND WHY THIS STILL EXISTS ────────────────────────────────
 *
 * This used to probe `resolveAdminOrganizationId()`, which was the SOLE tenant
 * resolver — it took no request and ignored the session, so boot could not proceed
 * without it and `src/index.ts` called `process.exit(1)` on failure.
 *
 * Multi-user replaced that with per-caller resolution: a signed-in person's scope
 * comes from their own membership. The bootstrap lookup now matters only to the
 * shared `ADMIN_API_TOKEN` path, so it no longer aborts boot — it warns.
 *
 * The probe is kept because that path still exists and an operator pointing
 * `BOOTSTRAP_ADMIN_ID` at nothing deserves a way to ask, in isolation, whether the
 * shared credential can reach a tenant. It exits non-zero on failure so it composes
 * in a shell; `src/index.ts` simply does not treat that as fatal any more.
 *
 * It must run in its OWN process. `env.ts` captures `config` at module load, so
 * pointing `BOOTSTRAP_ADMIN_ID` at a value from inside an already-loaded process
 * would not re-read it — the "declaration trusted downstream instead of
 * re-checked" trap, one level up.
 */
process.env.BOT_TOKENS ||= "1:test";
process.env.STORAGE_CHANNEL_ID ||= "-1001234";
process.env.BASE_URL ||= "http://127.0.0.1:4311";
process.env.PORT ||= "4311";

const { bootstrapOrganizationId } = await import("../src/presentation/http/middleware/auth");

try {
	const organizationId = await bootstrapOrganizationId();
	console.log(
		JSON.stringify({ ok: true, organizationId, bootstrapAdminId: process.env.BOOTSTRAP_ADMIN_ID })
	);
	process.exit(0);
} catch (error: unknown) {
	// The message is the operator-facing remedy. It is printed, not swallowed.
	console.log(
		JSON.stringify({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		})
	);
	process.exit(1);
}
