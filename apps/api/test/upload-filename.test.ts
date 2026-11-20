import { describe, expect, it } from "vitest";
import { neutralUploadFileName } from "../src/infrastructure/telegram/bot-pool";

/**
 * These pin the rule that fixed GIF corruption: the name handed to Telegram must
 * never be the user's real extension for a document.
 *
 * Telegram re-encodes by extension. `.gif` becomes H.264 MP4 even through
 * sendDocument — verified on production with the reported file: 220154 bytes of
 * GIF89a in, 34395 bytes of MP4 out. Uploading the identical bytes as `blob.bin`
 * came back byte-identical (sha256 34402f1a…), which is what identified the
 * extension, not the send method, as the trigger.
 */
describe("neutralUploadFileName", () => {
	it("uses an opaque name for documents, so bytes survive unchanged", () => {
		// The regression test. If this ever returns a name derived from the input
		// file, GIFs start coming back as MP4 again.
		expect(neutralUploadFileName("document")).toBe("upload.bin");
	});

	it("never derives the name from anything user-controlled", () => {
		// The function takes only a type, so there is no path for a user's
		// `.gif`/`.webp`/`.mp4` to reach Telegram. Asserted structurally: the
		// output is a fixed set, never a passthrough.
		const types = [
			"document",
			"photo",
			"video",
			"animation",
			"audio",
			"voice",
			"sticker",
			"video_note",
		];
		const outputs = types.map(neutralUploadFileName);
		for (const out of outputs) {
			expect(out).toMatch(/^upload\.(bin|jpg|mp4|mp3|ogg|webp)$/);
		}
	});

	it("keeps a container extension for methods that require one", () => {
		// sendPhoto/sendVideo/sendAnimation/sendSticker REJECT a mismatched
		// container, so those must not become `.bin`. They re-encode by design;
		// only `document` promises the original bytes.
		expect(neutralUploadFileName("photo")).toBe("upload.jpg");
		expect(neutralUploadFileName("video")).toBe("upload.mp4");
		expect(neutralUploadFileName("animation")).toBe("upload.mp4");
		expect(neutralUploadFileName("sticker")).toBe("upload.webp");
		expect(neutralUploadFileName("audio")).toBe("upload.mp3");
		expect(neutralUploadFileName("voice")).toBe("upload.ogg");
	});

	it("falls back to opaque bytes for an unknown type", () => {
		expect(neutralUploadFileName("something-new")).toBe("upload.bin");
		expect(neutralUploadFileName("")).toBe("upload.bin");
	});
});
