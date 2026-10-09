import type { Context, Handler } from "hono";
import { Hono } from "hono";
import { handleRpc } from "../orpc";
import { handleLogin, handleLogout, handleMe } from "./controllers/auth-controller";
import { handleFileInfo, handleFileRedirect } from "./controllers/file-controller";
import { handleHealth } from "./controllers/health-controller";
import { handleS3Request } from "./controllers/s3-controller";
import { serveSpaFile, serveSpaIndex } from "./controllers/spa-controller";
import { handleUpload } from "./controllers/upload-controller";
import { handleWebApiV1 } from "./controllers/web-api-controller";
import { requireAuth } from "./middleware/auth";
import { withRateLimit } from "./middleware/rate-limit";
import { getS3RouteBucket, shouldHandleS3 } from "./s3-detection";
import { handleSwaggerHtml, handleSwaggerJson } from "./swagger";

/**
 * Hono application for the TeleUploader API (P2b).
 *
 * Replaces `infrastructure/http/serve.ts` — a hand-written `node:http` shim that
 * emulated Bun's `serve({ routes, fetch })`. Nothing about the handlers changed:
 * every controller already takes a Web `Request` and returns a `Response`, so this
 * is a change of mount order, not a rewrite.
 *
 * ROUTE ORDER IS LOAD-BEARING
 *
 * The old shim scored routes for specificity (static > :param > wildcard), so
 * `/api/v1/auth/login` beat both `/api/v1/*` and `/*`. Hono matches on
 * REGISTRATION ORDER, first match wins. Registering the dashboard routes after
 * the S3 catch-all would hand every S3 request to the dashboard; registering
 * `/api/v1/*` before `/api/v1/auth/login` would swallow the auth endpoints. The
 * order below is therefore: health, auth, public data plane, dashboard API, site
 * root, and the S3 catch-all LAST so it only sees what nothing else claims.
 *
 * S3 stays OUTSIDE oRPC. oRPC owns JSON serialization and its own error shapes;
 * S3 needs raw XML bodies, path-style `/{bucket}/{key}` addressing, and SigV4
 * headers passed through untouched. Routing S3 through oRPC would put ~2,900
 * lines at risk that must stay byte-compatible for aws-cli, rclone, and the
 * Docker registry client.
 */

/** A controller in the shape every handler in this codebase already has. */
type RawHandler = (req: Request) => Response | Promise<Response>;

/**
 * Adapt a `Request -> Response` handler to a Hono handler.
 *
 * Controllers read only `req.url`, `req.headers` and `req.params`. Hono keeps
 * path params on its own context, so `c.req.param()` is copied onto the raw
 * Request to preserve the contract the old shim provided — file-controller reads
 * `req.params?.public_id` and would otherwise always 404.
 */
const adapt =
	(handler: RawHandler): Handler =>
	async (c: Context) => {
		const req = c.req.raw as Request & { params?: Record<string, string> };
		req.params = { ...req.params, ...c.req.param() };
		return handler(req);
	};

/**
 * Rate-limited handler.
 *
 * NEVER applied to the S3 surface, and that is deliberate: the limiter counts
 * per extracted client IP, while aws-cli, rclone and the Docker registry client
 * each issue a burst of requests per single object. Throttling them breaks
 * machine clients while doing nothing to stop a determined caller, who rotates
 * IPs. Only `POST /api/v1/auth/login` and `POST /api/upload` are wrapped.
 */
const limited = (handler: RawHandler): Handler =>
	adapt(withRateLimit(handler as (req: Request) => Promise<Response>));

/** Handler behind the admin-token auth check. */
const authenticated = (handler: RawHandler): Handler =>
	adapt(requireAuth(handler as (req: Request) => Promise<Response>));

/**
 * `/rpc/*` behind the same admin auth as the REST writes.
 *
 * `handleRpc` takes a Hono context (oRPC needs the raw Request through it), so
 * it cannot go through `authenticated`, which adapts to a raw handler. This
 * applies the identical `requireAuth` check — unauthenticated callers get the
 * same 401 body from the same middleware, rather than a bespoke second check
 * that could drift from it.
 */
const rpcAuthenticated: Handler = async (c: Context) => {
	const req = c.req.raw as Request & { params?: Record<string, string> };
	req.params = { ...req.params, ...c.req.param() };
	const guarded = requireAuth(async () => handleRpc(c));
	return guarded(req);
};

/**
 * Generic CORS preflight for non-S3 API requests. S3 preflights are answered by
 * the S3 controller with its own XML CORS headers.
 */
const apiOptionsResponse = (): Response =>
	new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, PUT, HEAD, DELETE, POST, PATCH, OPTIONS",
			"Access-Control-Allow-Headers":
				"Authorization, Content-Type, X-Amz-Date, X-Amz-Content-Sha256",
		},
	});

/**
 * Dispatch an S3 request, bypassing rate limiting (Docker registry pushes).
 *
 * `handleS3Request` resolves the caller's organization from the SigV4 access
 * key itself, so nothing threads a tenant in from here — the key the request
 * authenticated with IS the scope.
 */
const handleS3Direct = (req: Request): Promise<Response> =>
	handleS3Request(req, getS3RouteBucket(req));

const isS3 = (req: Request): boolean => shouldHandleS3(req, Object.fromEntries(req.headers));

/**
 * Dispatch to S3 when the request is SigV4-authenticated, else return `fallback`.
 *
 * The fallback receives the Hono context so a handler can read the raw Request
 * (the SPA asset route needs the pathname off it).
 */
const s3Or =
	(fallback: (c: Context) => Response | Promise<Response>): Handler =>
	(c: Context) =>
		isS3(c.req.raw) ? handleS3Direct(c.req.raw) : fallback(c);

const notFound = () => new Response("Not Found", { status: 404 });

/**
 * Serve a real file from the SPA directory, or `null` to mean "not handled".
 *
 * Returning `null` rather than a 404 is load-bearing: a hashed asset that does
 * not exist must NOT receive the SPA shell. Serving index.html for a missing
 * `.js` file turns a clear 404 into a MIME error in the browser console that
 * looks like a build problem.
 */
const spaAsset = async (req: Request): Promise<Response> =>
	(await serveSpaFile(new URL(req.url).pathname)) ?? notFound();

/**
 * The SPA client-side-route fallback: index.html for a deep link.
 *
 * `notFound()` is deliberately NOT extended here. The S3 catch-all below is the
 * only thing standing between aws-cli and this handler, and every path that
 * reaches here has already been tested against `shouldHandleS3` by `s3Or`.
 * Widening the bare `notFound` would hand the shell to any unclaimed path that
 * skipped that check.
 */
const spaIndex = async (): Promise<Response | null> => serveSpaIndex();

/**
 * Path segments that are S3 infrastructure rather than S3 addressing.
 *
 * `GET /v2/` is the Docker registry v2 ping. It is one segment and would otherwise
 * look like a dashboard route, so it is named here rather than shape-guessed.
 */
const S3_INFRASTRUCTURE_SEGMENTS: ReadonlySet<string> = new Set(["v2"]);

/**
 * Is this a BROWSER asking for a document, rather than a machine asking for a path?
 *
 * ## Why the request, not the path, is the discriminator
 *
 * A dashboard deep link and an S3 path-style address are the SAME shape.
 * `/acme/logs` and `/my-bucket/photo.png` are both `/{a}/{b}`, and the contract's
 * own planned route tree makes that collision permanent: `/$orgSlug/dashboard` and
 * `/$orgSlug/$bucketName` (docs/P4-CONTRACT.md §1) are two-segment paths too. No
 * amount of path analysis separates them, and any heuristic that tried would break
 * whichever side it guessed wrong — including `GET /{bucket}`, which is one segment
 * and therefore indistinguishable from `/login`.
 *
 * What DOES separate them is who is asking. The SPA shell is only ever needed for a
 * browser DOCUMENT NAVIGATION — a click, a pasted deep link, a refresh. Every
 * client that must never receive HTML sends something else entirely:
 *
 * | client                                   | Sec-Fetch-Mode | Accept       |
 * |------------------------------------------|----------------|--------------|
 * | browser address bar / anchor href        | `navigate`     | `text/html`  |
 * | aws-cli, rclone, s3cmd, Docker registry | absent         | not html     |
 * | curl, a CDN, a scanner sweep             | absent         | wildcard     |
 *
 * Browsers set `Sec-Fetch-*` automatically and forbid scripts from forging it;
 * machine clients send neither header. So the shell is served ONLY on an explicit
 * navigation signal.
 *
 * ONE TESTING TRAP, worth writing down because it cost a real false alarm. Node's
 * undici `fetch` treats `Sec-Fetch-Mode` as a FORBIDDEN header and silently
 * OVERWRITES it with "cors" — verified: a server behind `fetch` saw
 * `{"sec-fetch-mode":"cors"}` for a request that sent `navigate`, and the same
 * request through `node:http` arrived as `navigate`. So a live-probe written with
 * `fetch` will silently exercise the non-browser path and see 404 where a browser
 * sees 200. Hono's own `app.request()` (what the unit suite uses) passes the
 * header through untouched, so unit tests are unaffected; drive a raw socket or
 * `node:http` when probing this over the wire.
 */
const isBrowserDocumentNavigation = (req: Request): boolean => {
	const mode = req.headers.get("sec-fetch-mode");
	if (mode) return mode === "navigate";
	// No Sec-Fetch-* at all: fall back to the Accept header. A wildcard accept
	// (curl, scanners, most HTTP libraries) is NOT a document request; only an
	// explicit text/html accept is.
	return (req.headers.get("accept") ?? "").includes("text/html");
};

/**
 * May this unclaimed path receive the SPA shell, or must it keep the pre-P4 404?
 *
 * THE REASON THIS EXISTS. Before it, the S3 catch-all fell back to the shell for
 * EVERY unsigned GET, so `GET /{bucket}` and `GET /{bucket}/{key}` answered
 * `200 text/html` where the old `node:http` shim answered a bare `404 text/plain`.
 * That breaks hard constraint (i) for every client that touches a path before (or
 * without) signing: the Docker registry v2 ping, an rclone/s3cmd config validation,
 * a CDN or scanner sweep. A `200` makes "does this bucket exist?" unanswerable from
 * the status alone, and feeds HTML to a client parsing an S3 XML body.
 *
 * The rule is one line, and it is the conservative one: **anything that is not an
 * explicit browser navigation keeps the pre-P4 404.** That restores the exact
 * wire behaviour of the service this replaced for every machine client, on every
 * shape, with no path analysis that could guess wrong.
 *
 * A file that actually EXISTS in the SPA dist is served before this is consulted, so
 * the day someone adds `apps/web/public/favicon.ico` or `robots.txt` — which Vite
 * copies into the dist ROOT — it is served as the file it is, with its own MIME
 * type, instead of silently becoming index.html content.
 *
 * WHEN `src/routes/index.tsx` AND `login.tsx` LAND: an explicit route allowlist read
 * from the generated route tree can declare client routes so a non-browser fetch of
 * one still gets the shell. The navigation gate stays either way — the
 * `/$orgSlug/$bucketName` shape genuinely collides with `/{bucket}/{key}`, so a
 * route allowlist alone cannot settle it.
 */
const mayServeSpaShell = (req: Request, reqPath: string): boolean => {
	if (!isBrowserDocumentNavigation(req)) return false;
	// Even a browser gets the honest answer for S3's own infrastructure path: a
	// registry client ping that lands on the dashboard shell is the exact failure
	// this function exists to prevent, and no human navigates to /v2/ expecting a
	// file browser.
	const segments = reqPath.split("/").filter(Boolean);
	if (segments.length === 1 && S3_INFRASTRUCTURE_SEGMENTS.has(segments[0].toLowerCase())) {
		return false;
	}
	return true;
};

export const createApp = (): Hono => {
	const app = new Hono();

	// ── Health (public, unthrottled — the deploy probe hits this) ───────────
	app.get("/health", adapt(handleHealth));
	app.get("/healthz", adapt(handleHealth));

	// ── Dashboard auth ───────────────────────────────────────────────────────
	app.post("/api/v1/auth/login", limited(handleLogin));
	app.post("/api/v1/auth/logout", adapt(handleLogout));
	app.get("/api/v1/auth/me", adapt(handleMe));

	// ── API documentation (P4) ───────────────────────────────────────────────
	// PUBLIC and unthrottled: the docs must stay reachable when a rate limit is
	// exhausted, and test/swagger.test.ts asserts no CORS `*` header is emitted.
	//
	// Registered ABOVE the `/*` wildcard — and that is precisely why each one MUST
	// be s3Or()-wrapped, not why they are automatically safe. Hono matches on
	// registration order, first match wins, so being registered first means these
	// routes CLAIM `/docs` before the S3 catch-all ever sees it. Unwrapped, a
	// SigV4-authenticated `GET /docs` answered HTML and `GET /swagger.json`
	// answered the OpenAPI document: S3 clients addressing a bucket literally named
	// `docs` got a dashboard instead of XML. s3Or defers to S3 whenever the request
	// carries SigV4 headers, a presigned signature, or a vhost bucket, so the S3
	// surface keeps every path it can address.
	//
	// `handleSwaggerHtml`/`handleSwaggerJson` read nothing off the Request, so they
	// are called with no arguments — which is why `adapt()` was pure ceremony here.
	app.get(
		"/docs",
		s3Or(() => handleSwaggerHtml())
	);
	app.get(
		"/swagger.json",
		s3Or(() => handleSwaggerJson())
	);

	// ── Public data plane — unauthenticated by decision ─────────────────────
	app.post("/api/upload", limited(handleUpload));
	app.get("/f/:public_id", adapt(handleFileRedirect));
	app.get("/file/:public_id/info", adapt(handleFileInfo));

	// ── oRPC management surface, mounted BEFORE the REST routes (P2c) ───────
	// `/rpc` is a distinct prefix, so there is no overlap with `/api/v1/*`; the
	// position here is simply ahead of the wildcard routes. It serves the same
	// controllers, so both surfaces behave identically until P4 retires the REST
	// one along with home.html.
	//
	// P3: `/rpc/*` now sits behind the same admin auth as the REST writes. It
	// previously had NO auth wrapper at all, so an unauthenticated caller could
	// create and DELETE buckets through this prefix even though `POST`/`DELETE`
	// `/api/v1/*` were protected. Scoping it to an organization without wrapping
	// it would have replaced "anyone" with "any tenant" — still not a boundary.
	app.all("/rpc/*", rpcAuthenticated);

	// ── Dashboard JSON API. Admin auth on every verb. ───────────────────────
	//
	// Item 11. GET used to be registered bare, on the reasoning that "reads are
	// public, writes are protected". Measured against live production, that
	// exposed more than the reads: an anonymous caller could list buckets
	// (`gitea`, 170 objects), walk every object key, and then READ THE CONTENT —
	// each listing entry carries a `downloadUrl` (/f/<public_id>) and those return
	// 200 without a session. A share link is meant to grant one object; a public
	// listing turns that into "everything", quietly subsuming the share-link
	// decision.
	//
	// GET is therefore wrapped too. `/f/:public_id` and `/file/:public_id/info`
	// above stay unwrapped on purpose: they are the share-link surface, and links
	// already handed out must keep working. Hiding the LISTING while leaving the
	// share links public is the point — possession of a link is the credential.
	//
	// The `/api/v1/auth/*` routes above are registered ahead of this wildcard and
	// remain reachable unauthenticated: `auth/me` is the frontend's "am I an
	// admin?" probe and answers 401 by design.
	app.get("/api/v1/*", authenticated(handleWebApiV1));
	app.post("/api/v1/*", authenticated(handleWebApiV1));
	app.delete("/api/v1/*", authenticated(handleWebApiV1));
	app.put("/api/v1/*", authenticated(handleWebApiV1));

	// ── Site root: S3 ListBuckets when SigV4-authenticated, else the SPA ────
	// `spaIndex()` returns null when WEB_DIST_PATH is unset or has no index.html,
	// in which case this is exactly the pre-P4 behaviour.
	app.get(
		"/",
		s3Or(async () => (await spaIndex()) ?? notFound())
	);
	app.put(
		"/",
		s3Or(() => new Response("Not Allowed", { status: 405 }))
	);
	// NOTE: no 'HEAD' element here, and none on the catch-all below. Hono
	// re-dispatches every HEAD as GET before router.match, so ANY route registered
	// with method "HEAD" is unreachable dead code. HEAD is served by the app.get
	// routes — and a SigV4 HEAD still reaches the S3 controller because
	// handleS3Request reads req.method off the raw Request (method is still "HEAD"),
	// not off the matched route. Hard constraint (i) is unaffected either way.
	app.on(["DELETE", "POST"], "/", s3Or(notFound));
	app.options("/", s3Or(apiOptionsResponse));

	// ── SPA static assets (P4) ───────────────────────────────────────────────
	// MUST be s3Or()-wrapped and MUST stay immediately above the S3 catch-all.
	// The catch-all claims every unmatched path, so an unwrapped static handler
	// here would steal `GET /{bucket}/{key}` from aws-cli, rclone and the Docker
	// registry client. s3Or defers to S3 whenever the request carries SigV4
	// headers or a vhost bucket, so an S3 path can never reach this handler.
	//
	// A missing asset returns null (→ the S3 fallback's 404), never index.html.
	app.get(
		"/assets/*",
		s3Or((c) => spaAsset(c.req.raw))
	);

	// ── S3 catch-all — registered LAST so it only sees unclaimed paths ──────
	// On GET, a non-S3 path that no other route claimed is classified before the
	// SPA is consulted. This is the ONE place the SPA fallback and the S3 404
	// interleave, and it is safe only because `s3Or` has already proved the request
	// is not S3.
	//
	// Three outcomes, in order:
	//   1. a REAL file in the SPA dist  → served with its own content-type
	//   2. an S3-shaped path             → the pre-P4 bare 404 (never HTML)
	//   3. anything else                → the SPA shell, for client-side deep links
	app.get(
		"/*",
		s3Or(async (c) => {
			const pathname = new URL(c.req.raw.url).pathname;
			// (1) A real file wins over both. `serveSpaFile` returns null when there is
			// no SPA, no such file, or a path that escapes the root — so this preserves
			// the missing-hashed-asset 404 rather than turning it into a MIME error.
			const file = await serveSpaFile(pathname);
			if (file) return file;
			// (2) Anything that is not an explicit browser navigation keeps the
			// pre-P4 bare 404, whatever shape its path has.
			if (!mayServeSpaShell(c.req.raw, pathname)) return notFound();
			// (3) A client-side deep link.
			return (await spaIndex()) ?? notFound();
		})
	);
	app.put("/*", s3Or(notFound));
	app.patch("/*", s3Or(notFound));
	app.delete("/*", s3Or(notFound));
	app.post("/*", s3Or(notFound));
	app.options("/*", s3Or(apiOptionsResponse));

	return app;
};
