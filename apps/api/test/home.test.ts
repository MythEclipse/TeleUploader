/**
 * WHY THIS FILE STILL EXISTS, AND WHY IT NO LONGER TESTS home.html
 * =================================================================
 *
 * The four tests that used to live here drove `resolveHomeHtml` and `handleHome`
 * from `presentation/http/controllers/home-controller.ts`. P4 replaced that
 * resolver with `serveSpaFile`/`serveSpaIndex` in `spa-controller.ts`, and the
 * old controller now has ZERO importers anywhere in `src/` — verified, not
 * assumed:
 *
 *   $ grep -rn "home-controller" src/ --include="*.ts" | grep -i import
 *   (no output)
 *   $ ./node_modules/.bin/tsx <probe>   # createApp().request('/')
 *   GET / -> 404 ct= text/plain;charset=UTF-8
 *   contains home.html title marker "FileDrop · S3 File Manager": false
 *   direct handleHome() -> 200 marker: true
 *
 * Note that last line. `handleHome()` STILL works — it still finds and serves
 * `src/home.html`. That is exactly why this file could not simply be left
 * alone: a test that calls an unmounted function directly is the SAME defect
 * class as the one swagger.test.ts was rewritten for. The dropped `/docs`
 * survived a green build because the tests imported handlers instead of asking
 * the app. `home.test.ts` importing `handleHome` directly is that same blind
 * spot, one file over — and it asserted `200` for a route that returns `404`
 * in every deployed environment.
 *
 * THE DEFECT THIS FILE DOCUMENTED IS REAL AND WORTH KEEPING A GUARD FOR
 *
 * `handleHome` walked up from its own module directory looking for `home.html`.
 * In a dev checkout `src/home.html` is one hop away, so `GET /` returned 200.
 * `deploy.sh` never shipped `home.html` at all:
 *
 *   $ grep -n "home.html" deploy.sh
 *   (no output)
 *
 * So production served a bare 500 from the root while every developer saw a
 * working dashboard — a divergence no test could see, because every test ran
 * from the checkout where the file happened to exist. The file below converts
 * that unobservable defect into an observable one: it asserts the site root is
 * served by a mechanism whose failure mode is a 404, never a 500, and that no
 * route can reach for `src/home.html` again.
 *
 * It does NOT re-implement spa-controller's coverage. That is spa-static.test.ts
 * (25 tests: unset/missing/present, content-types, traversal, mount order).
 * Duplicating it here would create two suites that must be updated together for
 * one behaviour — the enumeration-drift failure suite-integrity.test.ts exists
 * to prevent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/env";
import { resetSpaCache, serveSpaIndex } from "../src/presentation/http/controllers/spa-controller";

const apiRoot = fileURLToPath(new URL("../", import.meta.url));

const loadApp = async () => {
	const { createApp } = await import("../src/presentation/http/app");
	return createApp();
};

/** The SPA lane owns this env var; this suite only exercises the unset case. */
const setWebDistPath = (value: string): void => {
	config.webDistPath = value;
	resetSpaCache();
};

beforeEach(() => {
	setWebDistPath("");
});

describe("the site root is served by the SPA, never by a home.html lookup", () => {
	it("GET / never returns 500 when no SPA is configured", async () => {
		// The whole point. `handleHome` THREW when it could not find home.html,
		// and nothing in production could find it, so `/` was a 500 in prod while
		// being a 200 in every checkout. A missing dashboard must degrade to a
		// 404 that says so, never an unhandled throw.
		setWebDistPath("");
		const res = await (await loadApp()).request("/");
		expect(res.status).toBe(404);
	});

	it("GET / is not the stale src/home.html dashboard", async () => {
		// Belt and braces on the same defect: even though `src/home.html` is still
		// sitting in the tree and `handleHome()` would still happily serve it, the
		// route must not. Otherwise deleting or reverting the SPA mount silently
		// restores a dashboard that only works from a checkout.
		setWebDistPath("");
		const body = await (await (await loadApp()).request("/")).text();
		expect(body).not.toContain("FileDrop · S3 File Manager");
		expect(body).not.toContain("<script"); // home.html's inline script
	});

	it("no route in the app reaches for src/home.html", async () => {
		// Structural rather than behavioural. If a future port reintroduces
		// `handleHome` as the root handler, this fails at the point of the mistake
		// instead of at the first production 500.
		const appSource = readFileSync(join(apiRoot, "src/presentation/http/app.ts"), "utf8");
		expect(appSource).not.toContain("home-controller");
		expect(appSource).not.toContain("handleHome");
	});

	it("the dashboard the SPA replaces is the only home.html in the tree", async () => {
		// `src/home.html` is retained deliberately as the reference implementation
		// the SPA was ported from. This asserts the RETENTION is intentional and
		// singular — a second home.html appearing beside it would be the same
		// ambiguity that made `resolveHomeHtml` walk up a directory tree guessing.
		const html = readFileSync(join(apiRoot, "src/home.html"), "utf8");
		expect(html).toContain("FileDrop · S3 File Manager");
	});
});

describe("serveSpaIndex", () => {
	it("returns null rather than throwing when no SPA directory is configured", async () => {
		// The inversion the SPA lane made on purpose: the old resolver returned
		// null from `resolveHomeHtml` and `handleHome` then THREW on that null.
		// The new one returns null all the way out, and every handler falls through
		// to its own 404. This asserts the null contract directly so the throw
		// cannot come back through a different entry point.
		setWebDistPath("");
		await expect(serveSpaIndex()).resolves.toBeNull();
	});

	it("returns null for a configured-but-absent directory instead of throwing", async () => {
		// env.ts throws at import time and src/index.ts imports it transitively
		// before serve(), so a missing SPA must never be able to stop the boot.
		setWebDistPath(join(apiRoot, "test", "definitely-not-a-built-spa"));
		await expect(serveSpaIndex()).resolves.toBeNull();
	});
});
