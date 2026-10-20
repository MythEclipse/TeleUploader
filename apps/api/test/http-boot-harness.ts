/**
 * HTTP-only boot harness for manual and automated verification.
 *
 * ## Why this exists
 *
 * `src/index.ts` calls `startBot()` after `serve()`, and `startBot` throws when no bot
 * token is configured — correctly, since a Telegram handler without a token is useless.
 * That makes the real server impossible to boot in a test environment without a live
 * bot credential, which means the ONLY thing anyone can verify is `app.fetch(...)`
 * in-process. That misses the parts a browser actually exercises: `Content-Type`
 * headers on the SPA, the cookie jar across redirects, static asset serving.
 *
 * So this harness serves the SAME `createApp()` result over a real socket with no bot
 * attached. It is a development and CI tool — never imported by `index.ts`, and never
 * part of the production boot path.
 *
 *   DATABASE_URL=... STORAGE_CHANNEL_ID=... PORT=4400 \
 *     node_modules/tsx/dist/cli.mjs test/http-boot-harness.ts
 *
 * Database and HTTP paths are fully active. Only Telegram is absent.
 */

process.env.BOT_TOKENS ||= "";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";

const { createApp } = await import("../src/presentation/http/app");
const { config } = await import("../src/env");

const app = createApp();

/**
 * Node's built-in HTTP server, driving the Hono app.
 *
 * Deliberately not `Bun.serve` / `@hono/node-server`: those add a dependency this
 * harness should not require just to open a socket. Node's `http` module can adapt a
 * fetch handler with ~20 lines, and doing so keeps the harness honest about what the
 * production runtime does.
 */
const { createServer } = await import("node:http");

const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (typeof value === "string") headers.set(key, value);
			else if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
		}

		const url = `http://${req.headers.host ?? `127.0.0.1:${config.port}`}${req.url ?? "/"}`;
		const request = new Request(url, {
			method: req.method ?? "GET",
			headers,
			// GET/HEAD must not carry a body.
			body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
		});

		void Promise.resolve(app.fetch(request))
			.then(async (response) => {
				const responseHeaders: Record<string, string | string[]> = {};
				response.headers.forEach((value, key) => {
					if (key.toLowerCase() === "set-cookie") return;
					responseHeaders[key] = value;
				});
				const cookies = response.headers.getSetCookie?.() ?? [];
				if (cookies.length > 0) responseHeaders["set-cookie"] = cookies;

				res.writeHead(response.status, responseHeaders);
				res.end(Buffer.from(await response.arrayBuffer()));
			})
			.catch((error: unknown) => {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: error instanceof Error ? error.message : "Internal harness error",
					})
				);
			});
	});
});

server.listen(config.port, "127.0.0.1", () => {
	console.log(`HARNESS_READY http://127.0.0.1:${config.port}`);
});

const shutdown = (): void => {
	server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
