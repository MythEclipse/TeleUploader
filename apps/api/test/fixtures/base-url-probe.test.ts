/**
 * A FIXTURE, run as its own vitest process by base-url-targeting.test.ts.
 *
 * It asserts nothing about the BASE_URL value: it writes whatever the setup file
 * resolved to a temp file, and the parent decides whether that is correct. Keeping
 * the decision in the parent lets one fixture serve both the "operator supplied a
 * real target" case and the "nothing usable supplied" case.
 *
 * The value goes to a FILE, not stdout: vitest captures console output from test
 * files and the parent would never see it.
 */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

it("reports the BASE_URL the setup file resolved", () => {
	const target = process.env.BASE_URL_PROBE_OUT;
	if (!target) throw new Error("BASE_URL_PROBE_OUT is not set; the parent must supply it");
	writeFileSync(target, process.env.BASE_URL ?? "<unset>");
	expect(true).toBe(true);
});
