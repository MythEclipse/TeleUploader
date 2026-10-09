import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * P2b — routing contract for the Hono app.
 *
 * The old `node:http` shim matched routes by a SPECIFICITY score, so
 * `/api/v1/auth/login` beat `/api/v1/*` which beat `/*`. Hono matches on
 * REGISTRATION ORDER, first match wins. These tests pin that order, because
 * getting it wrong silently reroutes live traffic — S3 requests landing on the
 * dashboard, or auth endpoints swallowed by the `/api/v1/*` wildcard.
 *
 * Every controller is mocked, so this exercises routing only: no database, no
 * Telegram, no network, and no credentials.
 */

const handlers = vi.hoisted(() => ({
	health: vi.fn(() => new Response('{"status":"ok"}', { status: 200 })),
	spaIndex: vi.fn(() => Promise.resolve(null)),
	upload: vi.fn(() => new Response('{"ok":true}', { status: 200 })),
	fileRedirect: vi.fn((_req: Request) => new Response("redirected", { status: 302 })),
	fileInfo: vi.fn(() => new Response('{"file":{}}', { status: 200 })),
	webApi: vi.fn(() => new Response('{"buckets":[]}', { status: 200 })),
	login: vi.fn(() => new Response('{"ok":true}', { status: 200 })),
	logout: vi.fn(() => new Response('{"ok":true}', { status: 200 })),
	me: vi.fn(() => new Response('{"user":null}', { status: 200 })),
	s3: vi.fn(() => new Response("<ListAllMyBucketsResult/>", { status: 200 })),
	requireAuth: vi.fn((handler: (req: Request) => Promise<Response>) => handler),
	rateLimit: vi.fn((handler: (req: Request) => Promise<Response>) => handler),
}));

vi.mock("../src/presentation/http/controllers/health-controller", () => ({
	handleHealth: handlers.health,
}));
// P4: `home-controller` (handleHome/resolveHomeHtml) is no longer mounted by
// app.ts — `GET /` is served by `spa-controller`. Mocking a module the app does
// not import is a silent no-op, which is how this suite came to assert on a
// handler that could not possibly be called. Mock what IS mounted instead.
vi.mock("../src/presentation/http/controllers/spa-controller", () => ({
	serveSpaIndex: handlers.spaIndex,
	serveSpaFile: vi.fn(() => Promise.resolve(null)),
	resolveSpaRoot: () => null,
	contentTypeFor: () => "application/octet-stream",
	resolveWithinRoot: () => null,
	resetSpaCache: vi.fn(),
}));
vi.mock("../src/presentation/http/controllers/upload-controller", () => ({
	handleUpload: handlers.upload,
}));
vi.mock("../src/presentation/http/controllers/file-controller", () => ({
	handleFileRedirect: handlers.fileRedirect,
	handleFileInfo: handlers.fileInfo,
}));
vi.mock("../src/presentation/http/controllers/web-api-controller", () => ({
	handleWebApiV1: handlers.webApi,
	handleListBucketsV1: handlers.webApi,
	handleCreateBucketV1: handlers.webApi,
	handleDeleteBucketV1: handlers.webApi,
	handleListObjectsV1: handlers.webApi,
	handleCopyObjectV1: handlers.webApi,
	handleDeleteObjectV1: handlers.webApi,
	handleDownloadObjectV1: handlers.webApi,
}));
vi.mock("../src/presentation/http/controllers/auth-controller", () => ({
	handleLogin: handlers.login,
	handleLogout: handlers.logout,
	handleMe: handlers.me,
}));
vi.mock("../src/presentation/http/controllers/s3-controller", () => ({
	handleS3Request: handlers.s3,
}));
vi.mock("../src/presentation/http/middleware/auth", () => ({
	requireAuth: handlers.requireAuth,
}));
vi.mock("../src/presentation/http/middleware/rate-limit", () => ({
	withRateLimit: handlers.rateLimit,
	cleanupRateLimitCache: vi.fn(),
}));
vi.mock("../src/presentation/http/s3-detection", () => ({
	shouldHandleS3: (req: Request) => req.headers.get("authorization")?.startsWith("AWS4-") ?? false,
	getS3RouteBucket: () => undefined,
}));

const { createApp } = await import("../src/presentation/http/app");

const req = () => createApp().request;

const SIGV4 = {
	authorization: "AWS4-HMAC-SHA256 Credential=AK/20240101/us-east-1/s3/aws4_request",
};

beforeEach(() => {
	for (const mock of Object.values(handlers)) {
		if (typeof mock === "function" && "mockClear" in mock) mock.mockClear();
	}
});

/**
 * Which handlers were wrapped by `requireAuth`.
 *
 * requireAuth is a higher-order function applied at ROUTE-REGISTRATION time, so
 * `createApp()` records every wrapped handler the moment the app is built — not
 * when a request arrives. To assert "this route is not auth-wrapped", the app
 * must be rebuilt after clearing the spy, and the recorded call compared against
 * the handler the route would have used.
 */
const authWrappedHandlers = (): unknown[] => handlers.requireAuth.mock.calls.map((call) => call[0]);

test("route wrapping is decided at registration, not per request", () => {
	handlers.requireAuth.mockClear();
	req(); // building the app records the wrapped handlers
	const wrapped = authWrappedHandlers();
	expect(wrapped).toContain(handlers.webApi);
	expect(wrapped).not.toContain(handlers.upload);
	expect(wrapped).not.toContain(handlers.fileRedirect);
	expect(wrapped).not.toContain(handlers.fileInfo);
});

describe("Hono routing order", () => {
	test("health is served without auth or rate limiting", async () => {
		const res = await req()("/health");
		expect(res.status).toBe(200);
		expect(handlers.health).toHaveBeenCalled();
		expect(handlers.rateLimit).not.toHaveBeenCalledWith(handlers.health);
	});

	test("/healthz aliases /health for the deploy probe", async () => {
		const res = await req()("/healthz");
		expect(res.status).toBe(200);
		expect(handlers.health).toHaveBeenCalled();
	});

	test("exact auth routes win over the /api/v1/* wildcard", async () => {
		await req()("/api/v1/auth/login", { method: "POST" });
		expect(handlers.login).toHaveBeenCalled();
		expect(handlers.webApi).not.toHaveBeenCalled();

		await req()("/api/v1/auth/me");
		expect(handlers.me).toHaveBeenCalled();
		expect(handlers.webApi).not.toHaveBeenCalled();
	});

	test("dashboard reads are public but writes go through requireAuth", async () => {
		handlers.requireAuth.mockClear();
		req();
		expect(authWrappedHandlers()).toContain(handlers.webApi);

		await req()("/api/v1/buckets");
		expect(handlers.webApi).toHaveBeenCalled();
	});

	test("public data plane is reachable without auth", async () => {
		handlers.requireAuth.mockClear();
		req();

		await req()("/api/upload", { method: "POST" });
		expect(handlers.upload).toHaveBeenCalled();

		await req()("/f/abc123");
		expect(handlers.fileRedirect).toHaveBeenCalled();

		await req()("/file/abc123/info");
		expect(handlers.fileInfo).toHaveBeenCalled();

		const wrapped = authWrappedHandlers();
		expect(wrapped).not.toContain(handlers.upload);
		expect(wrapped).not.toContain(handlers.fileRedirect);
		// `GET /file/:public_id/info` is the THIRD public data-plane route and it was
		// missing from this list, so auth-wrapping it — a hard-constraint-(h) regression
		// on one of exactly three routes — passed the entire unit suite undetected.
		// spa-static.test.ts:260 does not cover it either: that test only asserts the
		// body is not HTML, which a 401 JSON body satisfies.
		expect(wrapped).not.toContain(handlers.fileInfo);
	});

	test("path params reach the controller via req.params", async () => {
		await req()("/f/the-public-id");
		const passed = handlers.fileRedirect.mock.calls[0][0] as Request & {
			params?: Record<string, string>;
		};
		expect(passed).toBeDefined();
		expect(passed.params?.public_id).toBe("the-public-id");
	});

	test("file info route is distinct from the redirect route", async () => {
		await req()("/file/the-public-id/info");
		expect(handlers.fileInfo).toHaveBeenCalled();
		expect(handlers.fileRedirect).not.toHaveBeenCalled();
	});

	// P4: `GET /` no longer serves `home.html` via `home-controller`. It serves the
	// React SPA shell via `spa-controller`, and returns 404 when WEB_DIST_PATH is
	// unset (which is this suite's environment). What this test still owns, and
	// what did NOT change with the SPA swap, is the routing decision: a non-S3
	// root must not fall through to the S3 catch-all handler, and a SigV4 root
	// must.
	//
	// The old assertion `expect(handlers.home).toHaveBeenCalled()` could not fail
	// correctly here: it was already passing against a mock for a module app.ts
	// stopped importing, which is why it went red instead of telling us anything
	// useful. The assertion below names the module the app ACTUALLY mounts.
	test("unauthenticated root is NOT claimed by the S3 catch-all", async () => {
		handlers.s3.mockClear();
		const res = await req()("/");
		expect(handlers.s3).not.toHaveBeenCalled();
		// With no SPA configured this is the pre-P4 fallback: a bare 404, which is
		// what `/` served before the SPA lane and must keep serving when
		// WEB_DIST_PATH is unset (a backend-only deploy).
		expect(res.status).toBe(404);
	});

	test("the root fallback asks the SPA controller for the shell", async () => {
		// The routing DECISION for `/`: the app consults the SPA controller before
		// giving up, and only the S3 catch-all handler is skipped. Asserting the
		// call — rather than only the resulting status — is what keeps a future
		// refactor from replacing the SPA fallback with a hard 404 and reporting
		// green when WEB_DIST_PATH happens to be unset in CI.
		handlers.spaIndex.mockClear();
		await req()("/");
		expect(handlers.spaIndex).toHaveBeenCalled();
	});

	test("SigV4 root is claimed by S3, not the SPA shell", async () => {
		handlers.s3.mockClear();
		const res = await req()("/", { headers: SIGV4 });
		expect(handlers.s3).toHaveBeenCalled();
		// The S3 controller's XML body, not the SPA's HTML — proof the catch-all
		// took the request and the SPA fallback never saw it.
		expect(await res.text()).toContain("<ListAllMyBucketsResult/>");
	});

	test("SigV4 catch-all reaches S3 for arbitrary bucket/key paths", async () => {
		for (const path of ["/my-bucket", "/my-bucket/some/deep/key.txt"]) {
			handlers.s3.mockClear();
			const res = await req()(path, { headers: SIGV4 });
			expect(handlers.s3, `expected S3 to claim ${path}`).toHaveBeenCalled();
			expect(res.status).toBe(200);
		}
	});

	test("non-S3 catch-all is 404 rather than reaching S3", async () => {
		const res = await req()("/definitely/not/a/route");
		expect(res.status).toBe(404);
		expect(handlers.s3).not.toHaveBeenCalled();
	});

	test("S3 is never rate limited (a 429 would abort a Docker registry push)", async () => {
		handlers.rateLimit.mockClear();
		await req()("/my-bucket/key", { method: "PUT", headers: SIGV4 });
		const limited = handlers.rateLimit.mock.calls.map((call) => call[0]);
		expect(limited).not.toContain(handlers.s3);
	});

	test("OPTIONS preflight answers 204 without hitting a controller", async () => {
		const res = await req()("/", { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
	});

	test("PUT on the root without S3 headers is 405, matching the old table", async () => {
		const res = await req()("/", { method: "PUT" });
		expect(res.status).toBe(405);
	});
});
