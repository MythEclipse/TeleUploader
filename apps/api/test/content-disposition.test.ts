import { describe, expect, it } from "vitest";
import { contentDisposition, sanitizeFilenameHeader } from "../src/presentation/http/filename";

/**
 * `Content-Disposition` for a user-controlled file name.
 *
 * FETCH `Response` HEADERS ARE BYTESTRINGS — every character must be ≤ 0xFF.
 * The header used to be built as `inline; filename="${name}"` at four call
 * sites, so a non-Latin-1 name made `new Response(...)` itself throw:
 *
 *   TypeError: Cannot convert argument to a ByteString because the character
 *   at index 18 has a value of 25991 which is greater than 255.
 *
 * The throw happened inside the handler, so the client got a 500 and the file
 * was undownloadable purely because of what it was called. Verified against the
 * real app before the fix: `GET /f/<token>` answered 500 for `文件.txt`,
 * `файл.txt` and `cat😀.png`.
 *
 * These assertions are on the BYTES, not just the shape, because "looks
 * reasonable" is exactly what the old code did.
 */

/** Fails if the value would make `new Response()` throw. */
const assertByteString = (value: string): void => {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		expect(code, `character at index ${i} is ${code}, which is > 0xFF`).toBeLessThanOrEqual(0xff);
	}
};

/** Parses the `filename*` parameter back to the original name. */
const decodeExtended = (header: string): string | null => {
	const match = header.match(/filename\*=UTF-8''([^;]+)$/);
	return match?.[1] ? decodeURIComponent(match[1]) : null;
};

describe("contentDisposition", () => {
	it("emits a header that a Response constructor accepts for any name", () => {
		// The regression test. Each of these threw before the fix; the throw is
		// what turned a download into a 500.
		const names = [
			"notes.txt",
			"café.txt",
			"文件.txt",
			"файл.txt",
			"cat😀.png",
			"Ω≈ç√∫˜µ≤≥÷.bin",
			"עברית.pdf",
			"العربية.zip",
		];
		for (const name of names) {
			const header = contentDisposition("attachment", name);
			assertByteString(header);
			// Constructing the actual Response is the real proof: the ByteString
			// conversion is what used to throw.
			expect(() => new Response("", { headers: { "Content-Disposition": header } })).not.toThrow();
		}
	});

	it("keeps ASCII names byte-identical to the old format", () => {
		// No gratuitous change for the 99% case: a plain name must still produce
		// exactly the header every client has always received, with no
		// `filename*` noise.
		expect(contentDisposition("attachment", "report.pdf")).toBe(
			'attachment; filename="report.pdf"'
		);
		expect(contentDisposition("inline", "photo.png")).toBe('inline; filename="photo.png"');
	});

	it("carries the real non-ASCII name in filename* so the download is named correctly", () => {
		// The fallback alone would save every CJK file as `_.txt`. `filename*` is
		// what preserves the actual name for clients that understand it.
		for (const name of ["文件.txt", "файл.txt", "café.txt", "cat😀.png"]) {
			expect(decodeExtended(contentDisposition("attachment", name)), name).toBe(name);
		}
	});

	it("keeps the extension in the ASCII fallback, so the file is still openable", () => {
		// A client that ignores `filename*` gets the fallback. It must at least be
		// a name the OS can open, which means the extension has to survive.
		expect(contentDisposition("attachment", "文件.txt")).toContain('filename="_.txt"');
		expect(contentDisposition("attachment", "cat😀.png")).toContain('filename="cat_.png"');
	});

	it("strips characters that would break out of the quoted parameter", () => {
		// Header injection and quote-breaking. `\r\n` in a header value is a
		// response-splitting attempt; a bare quote would terminate the parameter.
		const header = contentDisposition("attachment", 'ev"il\r\nX-Injected: 1.txt');
		assertByteString(header);
		// The injection vector is the CRLF, not the text after it. Removing them
		// collapses the attempt into one harmless name — the residual text is a
		// legal file name, which is why it is not stripped.
		expect(header).not.toContain("\r");
		expect(header).not.toContain("\n");
		// Exactly one pair of quotes delimits the parameter; the injected quote
		// did not survive to open a second one.
		expect(header.match(/"/g)?.length).toBe(2);
		// The whole value stays on one line, so no second header can be split off.
		expect(header.split(/[\r\n]/).length).toBe(1);
	});

	it("never emits an empty filename", () => {
		// A blank or fully-sanitized-away name would produce `filename=""`, which
		// some clients treat as "no name" and save as a random temp file.
		for (const name of ["", "   ", '"', "\r\n", "\u0000"]) {
			const header = contentDisposition("attachment", name);
			expect(header).not.toContain('filename=""');
			expect(header).toContain("download");
			assertByteString(header);
		}
	});

	it("encodes a non-BMP character as its UTF-8 bytes, not lone surrogates", () => {
		// `encodeURIComponent` throws on a lone surrogate, and an emoji is two
		// UTF-16 code units. The bytes are what matters: F0 9F 98 80 for 😀.
		const header = contentDisposition("attachment", "😀.png");
		expect(header).toContain("%F0%9F%98%80");
		expect(decodeExtended(header)).toBe("😀.png");
	});
});

describe("sanitizeFilenameHeader", () => {
	it("removes quotes, backslashes and control characters", () => {
		expect(sanitizeFilenameHeader('a"b\\c')).toBe("abc");
		expect(sanitizeFilenameHeader("a\r\nb")).toBe("ab");
		expect(sanitizeFilenameHeader("a\u0000b")).toBe("ab");
	});

	it("leaves an ordinary name untouched", () => {
		expect(sanitizeFilenameHeader("my-report (final).pdf")).toBe("my-report (final).pdf");
	});
});
