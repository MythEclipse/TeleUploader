import { describe, expect, it } from "vitest";
import { parseCompleteMultipartBody } from "../src/presentation/s3/xml";

/**
 * CompleteMultipartUpload must accept the body a real S3 client sends.
 *
 * FOUND BY RUNNING THE QUARANTINED SUITE AGAINST PRODUCTION (item 8), not by
 * reading the parser. `s3-sdk.test.ts` failed with
 *
 *     InvalidPart: One or more specified parts could not be found.
 *                   The etag or part number does not match.
 *
 * Reproduced outside vitest too, so it is a server defect and not a harness
 * artefact.
 *
 * THE DEFECT
 *
 * The AWS SDK does not put a literal `"` in `<ETag>`; it XML-escapes it. The exact
 * body captured off the wire by a middleware probe was:
 *
 *     <Part><ETag>&quot;abc123&quot;</ETag><PartNumber>1</PartNumber></Part>
 *
 * The parser's regex was
 *
 *     /<ETag>"?([^"<\s]+)"?<\/ETag>/
 *
 * The character class excludes `"`, `<` and whitespace — and `&quot;abc123&quot;`
 * contains NONE of those, so the whole entity-laden string is captured. The
 * `.replace(/^"/, "").replace(/"$/, "")` cleanup then does nothing, because there
 * are no literal quotes to remove. Verified against the real parser:
 *
 *     [ { "partNumber": 1, "etag": "&quot;abc123&quot;" },
 *       { "partNumber": 2, "etag": "&quot;def456&quot;" } ]
 *
 * Downstream, `stored.etag !== clientPart.etag` is then true for every part — the
 * stored value is the bare hex digest, the received value is the escaped literal —
 * so EVERY multipart upload fails at completion.
 *
 * WHY THIS IS WORTH A TEST RATHER THAN A ONE-LINE PATCH
 *
 * Nothing in the unit suite exercised `parseCompleteMultipartBody` with a body that
 * a real client produces. The 22 S3 SDK assertions that would have caught this were
 * all quarantined (live network), which is exactly why the defect survived the
 * migration: the only code that talks to real clients was the code never run.
 *
 * These cases pin the shapes an S3 client can emit — escaped, bare-quoted, and
 * unquoted — because the escaping is invisible when reading the source and only
 * appears on the wire.
 */
const wrap = (etag: string, partNumber: number): string =>
	`<CompleteMultipartUpload><Part><ETag>${etag}</ETag><PartNumber>${partNumber}</PartNumber></Part></CompleteMultipartUpload>`;

describe("parseCompleteMultipartBody — etag forms a real client sends", () => {
	it("decodes XML-escaped quotes, which is what the AWS SDK actually emits", () => {
		// The exact string observed on the wire.
		const body =
			'<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
			"<Part><ETag>&quot;abc123&quot;</ETag><PartNumber>1</PartNumber></Part>" +
			"<Part><ETag>&quot;def456&quot;</ETag><PartNumber>2</PartNumber></Part>" +
			"</CompleteMultipartUpload>";
		expect(parseCompleteMultipartBody(body)).toEqual([
			{ partNumber: 1, etag: "abc123" },
			{ partNumber: 2, etag: "def456" },
		]);
	});

	it("strips literal quotes", () => {
		expect(parseCompleteMultipartBody(wrap('"abc123"', 1))).toEqual([
			{ partNumber: 1, etag: "abc123" },
		]);
	});

	it("accepts a bare etag with no quoting at all", () => {
		expect(parseCompleteMultipartBody(wrap("abc123", 1))).toEqual([
			{ partNumber: 1, etag: "abc123" },
		]);
	});

	it("decodes a mixed submission, which is legal and must not be rejected", () => {
		const body =
			"<CompleteMultipartUpload>" +
			"<Part><ETag>&quot;aaa&quot;</ETag><PartNumber>1</PartNumber></Part>" +
			'<Part><ETag>"bbb"</ETag><PartNumber>2</PartNumber></Part>' +
			"<Part><ETag>ccc</ETag><PartNumber>3</PartNumber></Part>" +
			"</CompleteMultipartUpload>";
		expect(parseCompleteMultipartBody(body)).toEqual([
			{ partNumber: 1, etag: "aaa" },
			{ partNumber: 2, etag: "bbb" },
			{ partNumber: 3, etag: "ccc" },
		]);
	});

	it("leaves the part NUMBER untouched when the etag is escaped", () => {
		// Guards against a fix that decodes the whole <Part> and mangles siblings.
		const body = wrap("&quot;e5&quot;", 7);
		expect(parseCompleteMultipartBody(body)).toEqual([{ partNumber: 7, etag: "e5" }]);
	});
});
