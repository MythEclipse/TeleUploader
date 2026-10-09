import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Read the expected version from the manifest so a version bump can never
// desync this assertion again.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
};

// Mock database layer
const mockExecute = vi.fn(() => Promise.resolve());

vi.mock("../src/infrastructure/persistence/drizzle/index", () => ({
	db: {
		execute: mockExecute,
	},
}));

describe("Health Route Handler", () => {
	let handleHealth: typeof import("../src/presentation/http/controllers/health-controller").handleHealth;

	beforeEach(async () => {
		mockExecute.mockClear();
		const healthRoute = await import("../src/presentation/http/controllers/health-controller");
		handleHealth = healthRoute.handleHealth;
	});

	it("should return status 200 and ok when DB is healthy", async () => {
		const req = new Request("http://localhost:4000/health");
		const res = await handleHealth(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok", version: pkg.version });
		expect(mockExecute).toHaveBeenCalled();
	});

	it("should return status 500 and error details when DB health check fails", async () => {
		mockExecute.mockImplementationOnce(() => Promise.reject(new Error("DB Connection Failed")));
		const req = new Request("http://localhost:4000/health");
		const res = await handleHealth(req);

		expect(res.status).toBe(500);
		const body = (await res.json()) as { status: string; error: string };
		expect(body.status).toBe("error");
		expect(body.error).toBe("DB Connection Failed");
	});
});
