import { gzipSync } from 'node:zlib';

/** Compression algorithm for chunked file storage. */
export type CompressionAlgorithm = 'gzip' | null;

/**
 * Optionally compress a chunk with gzip.
 *
 * Compression is skipped if:
 * - The `compress` flag is false.
 * - The chunk is smaller than `compressionMinSizeBytes`.
 * - The compressed result is larger than the original.
 *
 * @param chunk - The raw chunk buffer.
 * @param compress - Whether compression is enabled.
 * @param compressionMinSizeBytes - Minimum chunk size to attempt compression.
 * @returns The (possibly compressed) bytes and the algorithm used.
 */
export const maybeCompressChunk = (
  chunk: Buffer,
  compress: boolean,
  compressionMinSizeBytes: number,
): { bytes: Buffer; compressionAlgorithm: CompressionAlgorithm } => {
  if (!compress || chunk.byteLength < compressionMinSizeBytes) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  const gzipped = gzipSync(chunk);
  if (gzipped.byteLength >= chunk.byteLength) {
    return { bytes: chunk, compressionAlgorithm: null };
  }

  // CRITICAL: the caller must receive a Buffer, never a bare Uint8Array.
  // Telegraf (telegram.sendDocument) only recognises Buffer/Blob/stream
  // sources as file uploads — a plain Uint8Array yields an empty multipart
  // body and Telegram rejects with "400: there is no document in the request".
  // Buffer.from(...) pins that guarantee regardless of the zlib return type.
  return { bytes: Buffer.from(gzipped), compressionAlgorithm: 'gzip' };
};
