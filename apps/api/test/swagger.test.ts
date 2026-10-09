import { describe, expect, it } from "vitest";
import { handleSwaggerHtml, handleSwaggerJson } from "../src/presentation/http/swagger";

// P2b REGRESSION GUARD, now pointing the other way (P4).
//
// These tests import the handlers DIRECTLY, so they cannot see whether the routes
// are actually registered — which is exactly how they kept passing while
// `/docs` and `/swagger.json` returned 404 in production. Porting the route table
// to Hono (presentation/http/app.ts) dropped both entries and nothing asserted on
// the app itself.
//
// So the first describe below asks the APP, never the handler. P4 re-registered
// both routes in app.ts and flipped these from `404` to `200` — with the same
// trip-wire intact in the other direction: a future port that drops either
// registration fails HERE instead of hiding behind a green suite.
//
// Note the earlier comment on these two tests named oRPC's `OpenAPIHandler` as
// the mechanism. That handler does not exist in the installed packages; P4
// re-registered the existing hand-written handlers. The assertion does not care
// which mechanism wins, which is the point of asking the app.
describe("Swagger endpoints are mounted on the app", () => {
	it("/swagger.json is registered on the Hono app and serves a real document", async () => {
		const { createApp } = await import("../src/presentation/http/app");
		const res = await createApp().request("/swagger.json");

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		// A 200 with an HTML error page, or with an empty object, would satisfy a
		// status-code-only assertion — which is the shape of the dropped-/docs
		// defect this file exists to prevent. Assert the DOCUMENT.
		const body = (await res.json()) as {
			openapi: string;
			info: { title: string; version: string };
			paths: Record<string, unknown>;
		};
		expect(body.openapi).toBe("3.0.0");
		expect(body.info.title).toBe("FileDrop API");
		expect(body.info.version.length).toBeGreaterThan(0);

		// The public data plane must be documented. These three are the routes that
		// a router-generated spec silently drops, because oRPC does not own them.
		expect(body.paths).toHaveProperty("/health");
		expect(body.paths).toHaveProperty("/api/upload");
		expect(body.paths).toHaveProperty("/f/{public_id}");
	});

	it("/docs is registered on the Hono app and serves Swagger UI wired to /swagger.json", async () => {
		const { createApp } = await import("../src/presentation/http/app");
		const res = await createApp().request("/docs");

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");

		// Swagger UI with no spec URL renders an empty page and a 200 status. The
		// page must name the JSON document it will fetch.
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("swagger-ui");
		expect(html).toContain("/swagger.json");
	});

	it("the mounted document is byte-identical to the handler it wraps", async () => {
		// If a future change mounts a DIFFERENT handler than the one covered by the
		// handler-level describes below, those tests would keep passing against a
		// document nobody serves. This closes that gap.
		const { createApp } = await import("../src/presentation/http/app");
		const mounted = await (await createApp().request("/swagger.json")).json();
		const direct = await (await handleSwaggerJson()).json();
		expect(mounted).toEqual(direct);
	});
});

describe("Swagger Documentation Endpoints", () => {
	it("returns OpenAPI specification JSON", async () => {
		const res = await handleSwaggerJson();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as {
			openapi: string;
			info: { title: string };
			paths: Record<string, { get?: object; post?: object }>;
		};
		expect(body.openapi).toBe("3.0.0");
		expect(body.info.title).toBe("FileDrop API");
		expect(body.paths).toHaveProperty("/health");
		expect(body.paths).toHaveProperty("/api/upload");
		expect(body.paths).toHaveProperty("/f/{public_id}");
		expect(body.paths).toHaveProperty("/file/{public_id}/info");

		const uploadPath = body.paths["/api/upload"] as any;
		const downloadPath = body.paths["/f/{public_id}"] as any;

		expect(uploadPath.post.requestBody.content).toHaveProperty("multipart/form-data");
		expect(uploadPath.post.requestBody.content).toHaveProperty("application/json");

		// Verify 429 response documented
		const uploadResponses = uploadPath.post.responses;
		expect(uploadResponses).toHaveProperty("429");

		// Verify download is 302 redirect to Telegram CDN
		const downloadResponses = downloadPath.get.responses;
		expect(downloadResponses).toHaveProperty("302");
		expect(downloadResponses["302"].description).toContain("Redirect");
	});

	it("documents auth, web API, and S3 endpoints with the app version", async () => {
		const res = await handleSwaggerJson();
		const body = (await res.json()) as {
			info: { version: string };
			paths: Record<string, object>;
		};

		expect(body.paths).toHaveProperty("/api/v1/auth/login");
		expect(body.paths).toHaveProperty("/api/v1/auth/logout");
		expect(body.paths).toHaveProperty("/api/v1/auth/me");
		expect(body.paths).toHaveProperty("/api/v1/{path}");
		expect(body.paths).toHaveProperty("/{bucket}");
		expect(body.paths).toHaveProperty("/{bucket}/{key}");
		expect(typeof body.info.version).toBe("string");
		expect(body.info.version.length).toBeGreaterThan(0);
	});

	it("documents the WRITABLE methods on the wildcard surfaces", () => {
		// Hard constraint: the S3 wire protocol must stay byte-compatible for
		// aws-cli, rclone, s3cmd and the Docker registry client. A spec that
		// documents only `get` on `/{bucket}` makes any generated SDK unable to
		// issue a PUT — a CreateBucket that silently never appears. app.ts
		// registers GET/PUT/HEAD/DELETE on the S3 catch-all and GET/POST/DELETE/PUT
		// on `/api/v1/*`, so the document has to match that, not just the reads.
		//
		// This assertion exists because the spec once declared ONLY `get` on both,
		// which was not caught by any test — every existing assertion checked path
		// PRESENCE, never which methods each path declares.
		return handleSwaggerJson().then(async (res) => {
			const body = (await res.json()) as {
				paths: Record<string, Record<string, unknown>>;
			};
			const methodsOf = (path: string): string[] =>
				Object.keys(body.paths[path])
					.filter((key) => key !== "parameters")
					.sort();

			expect(methodsOf("/{bucket}")).toEqual(
				expect.arrayContaining(["get", "put", "delete", "head"])
			);
			expect(methodsOf("/{bucket}/{key}")).toEqual(
				expect.arrayContaining(["get", "put", "delete", "head"])
			);
			expect(methodsOf("/api/v1/{path}")).toEqual(
				expect.arrayContaining(["get", "post", "put", "delete"])
			);
		});
	});

	it("declares securitySchemes so Swagger UI renders an Authorize button", () => {
		// Without a securityScheme, the UI renders no way to send the session
		// cookie or the admin bearer token, and every generated client sends no
		// credentials — while `/rpc/*` is behind requireAuth. The spec would look
		// complete and be unusable against the authenticated surface.
		return handleSwaggerJson().then(async (res) => {
			const body = (await res.json()) as {
				components: { securitySchemes: Record<string, { type: string; in?: string }> };
			};
			expect(body.components.securitySchemes).toBeDefined();
			const names = Object.keys(body.components.securitySchemes);
			expect(names).toEqual(expect.arrayContaining(["sessionCookie", "bearerToken"]));
			expect(body.components.securitySchemes.sessionCookie.type).toBe("apiKey");
			expect(body.components.securitySchemes.sessionCookie.in).toBe("cookie");
			expect(body.components.securitySchemes.bearerToken.type).toBe("http");
		});
	});

	it("returns Swagger UI HTML page", async () => {
		const res = await handleSwaggerHtml();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");

		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("swagger-ui");
		expect(html).toContain("/swagger.json");
		expect(html).toContain("swagger-ui-bundle.js");
	});

	it("should not expose CORS * header", async () => {
		const res = await handleSwaggerJson();
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});
