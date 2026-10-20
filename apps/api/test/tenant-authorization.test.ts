import { describe, expect, it, vi } from "vitest";

/**
 * Tenant authorization: a caller must only reach organizations they belong to.
 *
 * ── WHY THIS FILE REPLACES `tenant-scope-misconfiguration.test.ts` ──────────
 *
 * The old suite asserted one behaviour: that `resolveAdminOrganizationId()` THREW
 * `MissingOrganizationMembershipError` instead of returning `null`, so a deployment
 * with no membership failed loudly at boot rather than answering 403 on everything.
 * That was the right fix for a SINGLE hardcoded admin, and multi-user dissolves its
 * premise: there is no longer one configured identity whose membership gates the
 * whole dashboard. Every caller resolves their own scope from their own session.
 *
 * So the invariant worth pinning is different and stricter: a caller CANNOT reach a
 * tenant they are not a member of, and the absence of a membership is never treated
 * as "all access". That is the property that, if it regressed, would leak one
 * person's files to another — the single worst failure mode this service has.
 *
 * These tests exercise `resolveCallerOrganization` directly rather than through
 * HTTP, because the decision is what matters and a full request would only add a
 * layer between the assertion and the behaviour.
 */
process.env.BOT_TOKENS ||= "1:test";
process.env.STORAGE_CHANNEL_ID ||= "-1001234";
process.env.BASE_URL ||= "http://127.0.0.1:4311";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/none";
process.env.PORT ||= "4311";
process.env.NODE_ENV = "test";

/** Organizations the fake user belongs to, keyed by slug. */
const memberships = new Map<
	string,
	{ id: string; name: string; role: "owner" | "admin" | "member" }
>();

const mockState = {
	/** Set to simulate a user with no memberships at all. */
	membershipsEmpty: false,
};

vi.mock("../src/infrastructure/di", () => ({
	identityRepository: {
		// Signatures are `text` for user_id and `uuid` for organization_id in the real
		// schema; the fake only has to honour the same lookup semantics.
		listOrganizationsForUser: async () =>
			mockState.membershipsEmpty
				? []
				: [...memberships.entries()].map(([slug, org]) => ({
						id: org.id,
						slug,
						name: org.name,
						role: org.role,
					})),
		findOrganizationBySlug: async (_userId: string, slug: string) => {
			const org = memberships.get(slug);
			if (!org) return null;
			return { id: org.id, slug, name: org.name, role: org.role };
		},
	},
	organizationRepository: {
		// The bootstrap membership the shared token resolves through.
		findOrganizationIdByUserId: async () => "bootstrap-org-id",
	},
}));

const { TenantAccessError, resetBootstrapOrganizationCache, resolveCallerOrganization } =
	await import("../src/presentation/http/middleware/auth");

/** A caller representing a signed-in person. */
const person = (userId = "user-1") => ({
	session: {
		userId,
		username: "person@example.com",
		expiresAt: new Date(Date.now() + 60_000),
		method: "cookie" as const,
	},
	userId,
	email: "person@example.com",
	name: "A Person",
	isSharedAdminToken: false,
});

/** A caller representing the shared `ADMIN_API_TOKEN`. */
const sharedToken = () => ({
	session: {
		userId: "bootstrap-admin",
		username: "admin",
		expiresAt: null,
		method: "bearer" as const,
	},
	userId: null,
	email: null,
	name: null,
	isSharedAdminToken: true,
});

/** Resets the fixtures between tests. */
const reset = (): void => {
	memberships.clear();
	mockState.membershipsEmpty = false;
	resetBootstrapOrganizationCache();
};

describe("resolveCallerOrganization", () => {
	it("resolves the caller's own organization when no slug is requested", async () => {
		reset();
		memberships.set("alice", { id: "org-alice", name: "Alice", role: "owner" });

		const resolved = await resolveCallerOrganization(person("alice-id"), null);

		expect(resolved.organizationId).toBe("org-alice");
		expect(resolved.role).toBe("owner");
	});

	it("resolves a slug the caller IS a member of", async () => {
		reset();
		memberships.set("shared-team", { id: "org-shared", name: "Shared", role: "member" });

		const resolved = await resolveCallerOrganization(person(), "shared-team");

		expect(resolved.organizationId).toBe("org-shared");
		expect(resolved.role).toBe("member");
	});

	it("REFUSES a slug the caller is not a member of, instead of falling back", async () => {
		reset();
		// The caller owns a personal org, but not the one being requested. A silent
		// fallback here would render someone else's link against the wrong tenant and
		// report success — so the refusal is the assertion that matters most.
		memberships.set("alice", { id: "org-alice", name: "Alice", role: "owner" });

		await expect(resolveCallerOrganization(person("alice-id"), "bob")).rejects.toBeInstanceOf(
			TenantAccessError
		);
	});

	it("refuses with 403, not 401 or 500, for a foreign slug", async () => {
		reset();
		memberships.set("alice", { id: "org-alice", name: "Alice", role: "owner" });

		const error = await resolveCallerOrganization(person("alice-id"), "bob").catch(
			(raised: unknown) => raised
		);

		// 403 says "authenticated, but not allowed". 401 would tell the SPA to
		// re-authenticate, which cannot help; 500 would hide an authorization decision
		// inside a server error.
		expect(error).toBeInstanceOf(TenantAccessError);
		expect((error as InstanceType<typeof TenantAccessError>).status).toBe(403);
	});

	it("refuses when the caller has no organization at all", async () => {
		reset();
		mockState.membershipsEmpty = true;

		const error = await resolveCallerOrganization(person("nobody"), null).catch(
			(raised: unknown) => raised
		);

		expect(error).toBeInstanceOf(TenantAccessError);
		// 403 rather than a silent empty scope: an account with no workspace is a
		// provisioning problem the user can fix by signing in again, not permission to
		// read everything.
		expect((error as InstanceType<typeof TenantAccessError>).status).toBe(403);
	});

	it("resolves the bootstrap organization for the shared admin token", async () => {
		reset();

		const resolved = await resolveCallerOrganization(sharedToken(), null);

		// The bearer path is the ONE case that does not consult `members`: the shared
		// credential has no user row, so it keeps the pre-existing single-tenant
		// behaviour instead of being denied.
		expect(resolved.organizationId).toBe("bootstrap-org-id");
		expect(resolved.role).toBe("owner");
	});

	it("does not let the shared token's null user id read as a real user", async () => {
		reset();
		const caller = sharedToken();

		// `userId === null` is the discriminator. Anything that treated it as a string
		// would resolve memberships for a user that does not exist.
		expect(caller.userId).toBeNull();
		const resolved = await resolveCallerOrganization(caller, "some-foreign-slug");
		// A slug is IGNORED for the shared token: it has exactly one organization and
		// no memberships to check a slug against.
		expect(resolved.organizationId).toBe("bootstrap-org-id");
	});

	it("keeps two different callers on different organizations", async () => {
		reset();
		// The cross-tenant leak this whole file exists to prevent, expressed directly:
		// two people, two workspaces, resolved independently.
		memberships.set("alice", { id: "org-alice", name: "Alice", role: "owner" });

		const aliceScope = await resolveCallerOrganization(person("alice-id"), "alice");

		reset();
		memberships.set("bob", { id: "org-bob", name: "Bob", role: "owner" });
		const bobScope = await resolveCallerOrganization(person("bob-id"), "bob");

		expect(aliceScope.organizationId).toBe("org-alice");
		expect(bobScope.organizationId).toBe("org-bob");
		expect(aliceScope.organizationId).not.toBe(bobScope.organizationId);
	});
});

describe("TenantAccessError", () => {
	it("carries a status so the HTTP layer never string-matches a message", () => {
		// The previous design mapped errors to statuses by comparing message strings,
		// which is how a misconfiguration became indistinguishable from a real denial.
		expect(new TenantAccessError("nope", 403).status).toBe(403);
		expect(new TenantAccessError("down", 503).status).toBe(503);
		expect(new TenantAccessError("nope", 403).name).toBe("TenantAccessError");
	});
});
