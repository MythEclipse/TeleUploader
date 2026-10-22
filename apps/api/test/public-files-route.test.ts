import { describe, expect, it } from "vitest";

const setEnv = (key: string, value: string) => {
	process.env[key] = value;
};

setEnv("BOT_TOKENS", "123456:ABC-DEF");
setEnv("STORAGE_CHANNEL_ID", "-1001234567890");
setEnv("BASE_URL", "https://example.com");
const { OFFLINE_DATABASE_URL } = await import("./helpers/setup-env");
setEnv("DATABASE_URL", OFFLINE_DATABASE_URL);
setEnv("PORT", "4000");
setEnv("NODE_ENV", "test");
setEnv("ADMIN_API_TOKEN", "test-token");

const { createApp } = await import("../src/presentation/http/app");
const req = () => createApp().request;

describe("GET /api/v1/files/public", () => {
	it("is reachable unauthenticated without 401", async () => {
		const res = await req()("/api/v1/files/public");
		// Should not be 401 Unauthorized
		expect(res.status).not.toBe(401);
	});
});
