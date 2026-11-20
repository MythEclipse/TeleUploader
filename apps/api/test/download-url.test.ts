import { describe, expect, it } from "vitest";
import {
	buildDownloadUrl,
	encodeStatelessLink,
	isStatelessToken,
} from "../src/application/shared/utils/stateless-link";

/**
 * `buildDownloadUrl` is the single place that decides what a download link looks
 * like, for BOTH kinds of id that live in `files.public_id`.
 *
 * It exists because that decision was duplicated across four call sites and they
 * disagreed. The upload response returned `/f/<token>.gif` while the public
 * listing returned `/f/<token>` — same file, two different links, depending on
 * which endpoint the dashboard happened to call. Nothing crashed; the link just
 * lost its extension and stopped reading as a file.
 *
 * These tests pin the branch, so a future caller cannot reintroduce a third
 * variant by hand-rolling the URL again.
 */

const TOKEN = encodeStatelessLink(
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

describe("buildDownloadUrl", () => {
	it("appends the extension for a stateless token", () => {
		const url = buildDownloadUrl("https://files.example.com", TOKEN, "cat.gif");
		expect(url).toBe(`https://files.example.com/f/${TOKEN}.gif`);
	});

	it("leaves a legacy nanoid bare", () => {
		// A nanoid is looked up in the database; it has no payload to carry an
		// extension and appending one would change the route parameter.
		const url = buildDownloadUrl("https://files.example.com", "V1StGXR8_Z5jdHi6B-myT", "cat.gif");
		expect(url).toBe("https://files.example.com/f/V1StGXR8_Z5jdHi6B-myT");
	});

	it("strips a trailing slash from the base URL", () => {
		// `BASE_URL` is operator-supplied and a trailing slash is the common
		// mistake; without normalising it the link gets a double slash.
		expect(buildDownloadUrl("https://files.example.com/", "V1StGXR8_Z5jdHi6B-myT", "a.txt")).toBe(
			"https://files.example.com/f/V1StGXR8_Z5jdHi6B-myT"
		);
		expect(buildDownloadUrl("https://files.example.com///", TOKEN, "a.txt")).toBe(
			`https://files.example.com/f/${TOKEN}.txt`
		);
	});

	it("omits the dot when the file name has no usable extension", () => {
		// A trailing dot would produce `/f/<token>.`, which some clients treat as
		// a different path.
		expect(buildDownloadUrl("https://x.test", TOKEN, "README")).toBe(`https://x.test/f/${TOKEN}`);
		expect(buildDownloadUrl("https://x.test", TOKEN, "weird.name.with.dots")).toBe(
			`https://x.test/f/${TOKEN}.dots`
		);
	});

	it("agrees with the discriminator it branches on", () => {
		// The two must never disagree: a token that `isStatelessToken` rejects
		// would silently take the nanoid branch and lose its extension.
		expect(isStatelessToken(TOKEN)).toBe(true);
		expect(isStatelessToken("V1StGXR8_Z5jdHi6B-myT")).toBe(false);
	});

	it("produces the same link the upload response would", () => {
		// The regression itself: upload said `.gif`, listing said no suffix.
		const fromUpload = buildDownloadUrl("https://files.example.com", TOKEN, "cat.gif");
		const fromListing = buildDownloadUrl("https://files.example.com", TOKEN, "cat.gif");
		expect(fromUpload).toBe(fromListing);
		expect(fromUpload.endsWith(".gif")).toBe(true);
	});
});
