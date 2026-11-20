import { describe, expect, it } from "vitest";
import { encodeStatelessLink } from "../src/application/shared/utils/stateless-link";
import { files } from "../src/infrastructure/persistence/drizzle/schema";

/**
 * The stateless token is stored in `files.public_id`, so the column must be wide
 * enough to hold one.
 *
 * This is a schema-vs-code contract, and it failed in production: `public_id` was
 * `varchar(21)` (nanoid-sized), every token insert raised "value too long for
 * type character varying(21)", and because that write is wrapped in a catch (a
 * bookkeeping failure must not fail a good upload), the row vanished silently.
 * Uploads worked, links resolved, and the dashboard listing stayed empty.
 *
 * A unit test on the encoder alone would not have caught it — the encoder is
 * fine. What has to be asserted is that the LARGEST token the encoder can produce
 * still fits the column.
 */

/** Reads the declared length of a varchar column from the Drizzle schema. */
const publicIdMaxLength = (): number => {
	const column = files.publicId as unknown as { length?: number; dataType?: string };
	// Drizzle keeps the size on the column config; assert the shape we rely on so
	// a refactor that moves it fails here rather than silently skipping the check.
	expect(column.dataType).toBe("string");
	expect(typeof column.length).toBe("number");
	return column.length as number;
};

describe("files.public_id can hold a stateless token", () => {
	it("is declared wide enough for the worst-case token", () => {
		// Worst case at the default 30 MB threshold: two parts, a 90-character
		// file_id each, a long file name, and a long MIME type. This is the
		// largest payload the encoder is allowed to produce.
		const fileId = "B".repeat(90);
		const token = encodeStatelessLink(
			{
				parts: [
					{ telegramFileId: fileId, sizeBytes: 19 * 1024 * 1024, compressionAlgorithm: "gzip" },
					{ telegramFileId: fileId, sizeBytes: 11 * 1024 * 1024, compressionAlgorithm: null },
				],
				sizeBytes: 30 * 1024 * 1024,
				fileName: "laporan-keuangan-tahunan-2026-final-revisi.pdf",
				mimeType: "application/pdf",
				createdAt: 1_700_000_000,
			},
			"secret"
		);

		expect(token.length).toBeGreaterThan(100);
		expect(token.length).toBeLessThanOrEqual(publicIdMaxLength());
	});

	it("is wide enough for a realistic single-part token", () => {
		const token = encodeStatelessLink(
			{
				parts: [
					{
						telegramFileId: "BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF9mb3JfZTJlX3Rlc3Rpbmc",
						sizeBytes: 220154,
						compressionAlgorithm: null,
					},
				],
				sizeBytes: 220154,
				fileName: "1512766810037162104.gif",
				mimeType: "image/gif",
				createdAt: 1_700_000_000,
			},
			"secret"
		);
		expect(token.length).toBeLessThanOrEqual(publicIdMaxLength());
	});

	it("still fits a legacy 21-character nanoid", () => {
		// The column has to serve both kinds of id; widening must not be read as
		// permission to start generating long ids elsewhere.
		expect(21).toBeLessThanOrEqual(publicIdMaxLength());
	});

	it("documents the failure that made this necessary", () => {
		// Pins the actual numbers so the comment in the schema cannot drift from
		// reality: the old limit was 21 and tokens exceed it by a wide margin.
		const token = encodeStatelessLink(
			{
				parts: [{ telegramFileId: "x".repeat(60), sizeBytes: 10, compressionAlgorithm: null }],
				sizeBytes: 10,
				fileName: "a.gif",
				mimeType: "image/gif",
				createdAt: 1_700_000_000,
			},
			"s"
		);
		expect(token.length).toBeGreaterThan(21);
	});
});
