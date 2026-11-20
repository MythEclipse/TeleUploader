import { describe, expect, it } from "vitest";
import {
	checkFileSize,
	computeHash,
	extractFileName,
	extractMimeType,
	getFileType,
} from "../src/infrastructure/file";

describe("File Utilities", () => {
	describe("getFileType", () => {
		it("should classify video mime types as video", () => {
			expect(getFileType("video/mp4", "")).toBe("video");
			expect(getFileType("video/quicktime", "")).toBe("video");
		});

		it("should classify audio mime types as audio", () => {
			expect(getFileType("audio/mpeg", "")).toBe("audio");
			expect(getFileType("audio/ogg", "")).toBe("audio");
		});

		it("should classify image mime types based on caption", () => {
			expect(getFileType("image/jpeg", "my photo")).toBe("photo");
			expect(getFileType("image/png", "cool image.png")).toBe("document");
			// A caption may still REQUEST an animation — that is the documented
			// escape hatch and it stays. What must never happen is the FILE NAME
			// being passed as a caption, because a `.gif` extension then matched
			// this rule and turned every GIF into an MP4 re-encode.
			expect(getFileType("image/gif", "funny gif")).toBe("animation");
			expect(getFileType("image/png", "funny gif")).toBe("animation");
		});

		it("classifies a GIF as a document when no caption is given", () => {
			// THE REGRESSION TEST for the corruption bug. A GIF uploaded through
			// /api/upload has no caption, so the MIME type must decide — and
			// `image/gif` is not `image/jpeg`, so it is not a photo either.
			//
			// `document` maps to sendDocument, which stores the bytes verbatim.
			// `animation` maps to sendAnimation, which re-encodes GIF to MP4.
			expect(getFileType("image/gif")).toBe("document");
			// Same reasoning for the neighbouring types: nothing here may be
			// inferred from a name that the caller does not control the shape of.
			expect(getFileType("image/png")).toBe("document");
			expect(getFileType("image/webp")).toBe("sticker");
			expect(getFileType("video/mp4")).toBe("video");
		});

		it("should classify voice and animation based on caption", () => {
			expect(getFileType("application/octet-stream", "this is a voice note")).toBe("voice");
			expect(getFileType("application/octet-stream", "cool animation")).toBe("animation");
		});

		it("should classify sticker and video_note", () => {
			expect(getFileType("image/webp", "")).toBe("sticker");
			expect(getFileType("image/webp", "some caption")).toBe("sticker");
			expect(getFileType("video/mp4", "this is a video_note")).toBe("video_note");
			expect(getFileType("application/octet-stream", "video_note file")).toBe("video_note");
		});

		it("should default to mime first segment or document", () => {
			expect(getFileType("application/pdf", "")).toBe("application");
			expect(getFileType(null, "")).toBe("document");
			expect(getFileType("unknown/type", "")).toBe("document");
		});
	});

	describe("checkFileSize", () => {
		it("should allow files under the size limit", () => {
			expect(checkFileSize(5 * 1024 * 1024, "photo")).toBe(true); // Photo limit is 10MB
			expect(checkFileSize(1 * 1024 * 1024 * 1024, "video")).toBe(true); // Video limit is 2GB
			expect(checkFileSize(2 * 1024 * 1024 * 1024, "document")).toBe(true); // Document limit is 2GB
		});

		it("should block files exceeding the size limit", () => {
			expect(checkFileSize(15 * 1024 * 1024, "photo")).toBe(false); // Photo limit is 10MB
			expect(checkFileSize(3 * 1024 * 1024 * 1024, "video")).toBe(false); // Video limit is 2GB
			expect(checkFileSize(3 * 1024 * 1024 * 1024, "document")).toBe(false);
		});

		it("should fall back to document limit if fileType is unknown", () => {
			expect(checkFileSize(1 * 1024 * 1024 * 1024, "unknown")).toBe(true); // Document limit is 2GB
			expect(checkFileSize(3 * 1024 * 1024 * 1024, "unknown")).toBe(false);
		});
	});

	describe("extractFileName", () => {
		it("should extract file name from headers if present", () => {
			const req = { headers: { "x-file-name": "custom.txt" } };
			expect(extractFileName({}, req)).toBe("custom.txt");
		});

		it("should extract file name from various message attachment types", () => {
			expect(extractFileName({ document: { fileName: "doc.pdf" } }, null)).toBe("doc.pdf");
			expect(
				extractFileName({ photo: [{ fileName: "low.jpg" }, { fileName: "high.jpg" }] }, null)
			).toBe("high.jpg");
			expect(extractFileName({ audio: { fileName: "song.mp3" } }, null)).toBe("song.mp3");
			expect(extractFileName({ voice: { fileName: "voice.ogg" } }, null)).toBe("voice.ogg");
			expect(extractFileName({ animation: { fileName: "anim.gif" } }, null)).toBe("anim.gif");
		});

		it("should return default filename if not found", () => {
			expect(extractFileName({}, null)).toBe("file");
		});
	});

	describe("extractMimeType", () => {
		it("should extract mime type from headers if present", () => {
			const req = { headers: { "x-mime-type": "text/plain" } };
			expect(extractMimeType({}, req)).toBe("text/plain");
		});

		it("should extract mime type from various message attachment types", () => {
			expect(extractMimeType({ document: { mimeType: "application/pdf" } }, null)).toBe(
				"application/pdf"
			);
			expect(
				extractMimeType({ photo: [{ mimeType: "image/jpeg" }, { mimeType: "image/png" }] }, null)
			).toBe("image/png");
			expect(extractMimeType({ audio: { mimeType: "audio/mpeg" } }, null)).toBe("audio/mpeg");
			expect(extractMimeType({ voice: { mimeType: "audio/ogg" } }, null)).toBe("audio/ogg");
			expect(extractMimeType({ animation: { mimeType: "video/mp4" } }, null)).toBe("video/mp4");
		});

		it("should return default mime type if not found", () => {
			expect(extractMimeType({}, null)).toBe("application/octet-stream");
		});
	});

	describe("computeHash", () => {
		it("should compute SHA-256 hash of a buffer", () => {
			const buffer = Buffer.from("hello world");
			const hash = computeHash(buffer);
			// sha256 of 'hello world' is b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
			expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
		});
	});
});
