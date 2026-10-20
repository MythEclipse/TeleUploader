/**
 * A missing tenant membership must be a LOUD misconfiguration, never a silent denial.
 *
 * ## The defect this pins
 *
 * The predecessor of this file guarded the same contract against
 * `organization-resolver.ts`, which multi-user auth deleted. That module resolved ONE
 * admin organization at boot and was replaced by per-caller resolution, but the contract
 * it protected did not go away — it moved to `bootstrapOrganizationId` in
 * `middleware/auth.ts`:
 *
 *   - `resolveAdminOrganizationId` returned `null` when the bootstrap admin had no
 *     `members` row, and both callers turned that null into a denial: 403 on
 *     `GET /api/v1/buckets` (a route documented PUBLIC) and 401 on every oRPC
 *     procedure.
 *   - `BOOTSTRAP_ADMIN_ID` is set by nothing — not `.env.example`, not `deploy.sh`, not
 *     CI — so it defaults to `bootstrap-admin`, a row that exists only after
 *     `pnpm db:seed`. A deploy that migrates but never seeds therefore served denials
 *     for everything, and that was the DEFAULT state of a real deploy.
 *
 * The resolver now THROWS `TenantAccessError` (503) instead of returning null, so a
 * misconfigured deployment says so instead of pretending the caller is unauthorized.
 * Deleting the old file without replacing this assertion would have silently dropped the
 * only test that pins it.
 *
 * ## Why the error message is asserted, not just the type
 *
 * An operator hitting this sees one string. `"No organization membership … Run
 * `pnpm db:seed`"` names the remedy; a bare "forbidden" sends them to support. That is
 * the load-bearing part, so it is asserted directly.
 */
import { describe, expect, it, vi } from "vitest";

process.env.BOT_TOKENS ||= "1:test";
process.env.STORAGE_CHANNEL_ID ||= "-1001234";
process.env.BASE_URL ||= "http://127.0.0.1:4311";
process.env.PORT ||= "4311";
process.env.ADMIN_API_TOKEN ||= "misconfig-probe-token";

const { TenantAccessError, resetBootstrapOrganizationCache } = await import(
	"../src/presentation/http/middleware/auth"
);

describe("TenantAccessError", () => {
	it("carries a status so the HTTP layer never string-matches a message", () => {
		const error = new TenantAccessError("boom", 503);

		expect(error.status).toBe(503);
		// A distinct `name` matters because `web-api-controller` and the oRPC handler switch
		// on the class, and a rename to the default "Error" would make every 503 a 500.
		expect(error.name).toBe("TenantAccessError");
		expect(error).toBeInstanceOf(Error);
	});
});

describe("bootstrapOrganizationId when the bootstrap admin has no membership", () => {
	/**
	 * The exact state a `migrate`-but-never-`seed` deploy is in.
	 *
	 * `organizationRepository` is mocked to answer null — that IS the condition under
	 * test. Everything else (the cache, the error type, the message) is the real module.
	 */
	it("throws a 503 naming the remedy instead of returning null", async () => {
		vi.resetModules();
		resetBootstrapOrganizationCache();

		vi.doMock("../src/infrastructure/di", () => ({
			organizationRepository: {
				findOrganizationIdByUserId: async () => null,
			},
		}));

		try {
			const fresh = await import("../src/presentation/http/middleware/auth");

			// `rejects`, not a resolved null: a null here is what became "deny everything".
			await expect(fresh.bootstrapOrganizationId()).rejects.toBeInstanceOf(fresh.TenantAccessError);
		} finally {
			vi.doUnmock("../src/infrastructure/di");
			vi.resetModules();
			resetBootstrapOrganizationCache();
		}
	});

	it("names db:seed and the configured admin id in the failure message", async () => {
		vi.resetModules();
		resetBootstrapOrganizationCache();

		vi.doMock("../src/infrastructure/di", () => ({
			organizationRepository: {
				findOrganizationIdByUserId: async () => null,
			},
		}));

		try {
			const fresh = await import("../src/presentation/http/middleware/auth");
			const { config } = await import("../src/env");

			const error = await fresh.bootstrapOrganizationId().catch((e: unknown) => e);

			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			// The remedy, not just the failure.
			expect(message).toContain("db:seed");
			// And WHO is misconfigured, so the operator knows which row to create.
			expect(message).toContain(config.bootstrapAdminId);
		} finally {
			vi.doUnmock("../src/infrastructure/di");
			vi.resetModules();
			resetBootstrapOrganizationCache();
		}
	});
});

describe("bootstrapOrganizationId when the membership exists", () => {
	it("resolves the organization id and caches it", async () => {
		vi.resetModules();
		resetBootstrapOrganizationCache();

		let lookups = 0;
		vi.doMock("../src/infrastructure/di", () => ({
			organizationRepository: {
				findOrganizationIdByUserId: async () => {
					lookups += 1;
					return "org-from-membership";
				},
			},
		}));

		try {
			const fresh = await import("../src/presentation/http/middleware/auth");

			expect(await fresh.bootstrapOrganizationId()).toBe("org-from-membership");
			// Second call must hit the memo, not the database — this runs per request on the
			// shared-token path.
			expect(await fresh.bootstrapOrganizationId()).toBe("org-from-membership");
			expect(lookups).toBe(1);
		} finally {
			vi.doUnmock("../src/infrastructure/di");
			vi.resetModules();
			resetBootstrapOrganizationCache();
		}
	});

	it("does not cache a FAILURE, so creating the membership needs no restart", async () => {
		vi.resetModules();
		resetBootstrapOrganizationCache();

		let attempt = 0;
		vi.doMock("../src/infrastructure/di", () => ({
			organizationRepository: {
				findOrganizationIdByUserId: async () => {
					attempt += 1;
					return attempt === 1 ? null : "org-after-seed";
				},
			},
		}));

		try {
			const fresh = await import("../src/presentation/http/middleware/auth");

			await expect(fresh.bootstrapOrganizationId()).rejects.toBeInstanceOf(fresh.TenantAccessError);
			// The operator ran `db:seed` in another shell; the next request must succeed rather
			// than keep serving the cached 503 until a restart.
			expect(await fresh.bootstrapOrganizationId()).toBe("org-after-seed");
		} finally {
			vi.doUnmock("../src/infrastructure/di");
			vi.resetModules();
			resetBootstrapOrganizationCache();
		}
	});
});
