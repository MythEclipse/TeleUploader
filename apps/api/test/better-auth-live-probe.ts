/**
 * Live probe: does better-auth actually construct and serve its routes?
 *
 * Run against the scratch database:
 *
 *   DATABASE_URL=… npx tsx test/better-auth-live-probe.ts
 *
 * Like `identity-live-probe.ts`, this is a PROBE rather than a `*.test.ts` file
 * because it opens a real connection and constructs the real better-auth
 * instance. The unit suite mocks the database, so nothing in it can catch a
 * wrong column name, a missing table, or a `betterAuth({...})` option the
 * library rejects — all of which fail at construction or on the first request.
 *
 * What it asserts, in order:
 *
 *   1. the better-auth instance constructs with the pinned options;
 *   2. its router answers `/get-session` with `null` for an anonymous caller
 *      (proving routes are mounted and the adapter resolves its tables);
 *   3. the app's `/api/v1/auth/get-session` reaches the same router through
 *      Hono's registration order;
 *   4. a forged session cookie is rejected as unsigned-out, NOT a 500;
 *   5. the sign-in route builds a Google authorize URL carrying the EXACT
 *      redirect URI registered in the console — the value that decides whether
 *      Google answers `redirect_uri_mismatch`;
 *   6. the tables better-auth touched really exist in the database.
 */
process.env.BOT_TOKENS ||= "123456:ABC-DEF";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";
process.env.BASE_URL ||= "https://upload.asepharyana.my.id";
process.env.PORT ||= "4399";
process.env.GOOGLE_CLIENT_ID ||= "probe-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "probe-client-secret-value";
process.env.GOOGLE_REDIRECT_URI ||= "https://upload.asepharyana.my.id/api/v1/auth/google/callback";
process.env.BETTER_AUTH_SECRET ||= "probe-secret-that-is-long-enough-to-pass";

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ""): void => {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures.push(label);
	console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n1. construction");
const { auth } = await import("../src/infrastructure/auth/better-auth");
check("betterAuth instance constructs", typeof auth === "object" && auth !== null);
check("it exposes a handler", typeof auth.handler === "function");

console.log("\n2. the router answers directly");
const anon = await auth.handler(
	new Request("https://upload.asepharyana.my.id/api/v1/auth/get-session")
);
check("GET /api/v1/auth/get-session responds", anon.status === 200, `got ${anon.status}`);
const anonBody = (await anon.json()) as unknown;
check("an anonymous caller has no session", anonBody === null, JSON.stringify(anonBody));

console.log("\n3. the app mounts the same router");
const { createApp } = await import("../src/presentation/http/app");
const app = createApp();
const viaApp = await app.request("/api/v1/auth/get-session");
check("the app answers that path", viaApp.status === 200, `got ${viaApp.status}`);
check(
	"the app's answer is not better-auth's 503 fallback",
	viaApp.status !== 503,
	`got ${viaApp.status}`
);

console.log("\n4. a forged cookie is rejected, not crashed on");
const forged = await app.request("/api/v1/auth/get-session", {
	headers: { cookie: "better-auth.session_token=forged-value-not-signed" },
});
check("a forged session cookie does not 500", forged.status < 500, `got ${forged.status}`);
const forgedBody = (await forged.json()) as unknown;
check(
	"a forged session cookie resolves to no session",
	forgedBody === null ||
		(typeof forgedBody === "object" && forgedBody !== null && !("user" in forgedBody)),
	JSON.stringify(forgedBody)
);

console.log("\n5. the Google authorize URL carries the registered redirect URI");
const signIn = await app.request("/api/v1/auth/sign-in/social", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ provider: "google", callbackURL: "/" }),
});
check("POST /api/v1/auth/sign-in/social responds", signIn.status < 500, `got ${signIn.status}`);
const signInBody = (await signIn.json().catch(() => null)) as { url?: string } | null;
const authorizeUrl = signInBody?.url ?? "";
check(
	"it returns an authorize URL",
	authorizeUrl.startsWith("https://accounts.google.com"),
	authorizeUrl.slice(0, 60)
);
let redirectUri = "";
try {
	redirectUri = new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "";
} catch {
	redirectUri = "";
}
check(
	"the redirect_uri is the console-registered one",
	redirectUri === process.env.GOOGLE_REDIRECT_URI,
	`got "${redirectUri}"`
);
try {
	const params = new URL(authorizeUrl).searchParams;
	check("a PKCE code_challenge is present", (params.get("code_challenge") ?? "").length > 0);
	check(
		"the scopes include openid",
		(params.get("scope") ?? "").includes("openid"),
		params.get("scope") ?? ""
	);
} catch {
	check("the authorize URL parses", false);
}

console.log("\n6. the tables better-auth needs actually exist");
const { db } = await import("../src/infrastructure/persistence/drizzle/index");
const { sql } = await import("drizzle-orm");
const tables = (await db.execute(sql`
	SELECT table_name FROM information_schema.tables
	WHERE table_schema = 'public' AND table_name LIKE 'auth_%'
	ORDER BY table_name
`)) as unknown as Record<string, unknown>[];
const names = tables.map((row) => row.table_name as string);
for (const expected of [
	"auth_account",
	"auth_rate_limit",
	"auth_session",
	"auth_user",
	"auth_verification",
]) {
	check(`table ${expected} exists`, names.includes(expected), names.join(","));
}

console.log("");
if (failures.length > 0) {
	console.log(`${failures.length} FAILED:`);
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}
console.log("all better-auth probes passed");
process.exit(0);
