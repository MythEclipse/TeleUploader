/**
 * Unit tests for the dashboard's pure display formatters.
 *
 * Run with: `bun test apps/web/src/lib/format.test.ts`
 *
 * ## What is being defended
 *
 * `formatMime` exists because the Type column used to print `file_type`, the
 * Telegram send classification. That was fine while images went out as `photo`
 * and GIFs as `animation`. It stopped being fine when GIFs and images were
 * deliberately routed through `sendDocument` to stop Telegram re-encoding them:
 * every row then read "document", which tells the user nothing at all.
 *
 * So the column now shows the real MIME subtype, and these tests pin the two
 * properties that make it readable: it must be SHORT (a column, not a paragraph)
 * and it must never render an empty cell.
 */

import { describe, expect, test } from 'bun:test';
import { formatMime, formatSize } from './format';

describe('formatMime', () => {
  test('reduces a MIME type to a short uppercase subtype', () => {
    // The exact case that exposed the problem: a GIF served as a document.
    expect(formatMime('image/gif')).toBe('GIF');
    expect(formatMime('application/pdf')).toBe('PDF');
    expect(formatMime('video/mp4')).toBe('MP4');
  });

  test('drops a structured-syntax suffix', () => {
    // `image/svg+xml` is a valid type; printing the whole thing overflows the
    // column and reads worse than the format everyone actually calls it.
    expect(formatMime('image/svg+xml')).toBe('SVG');
  });

  test('drops a legacy x- prefix', () => {
    expect(formatMime('application/x-msdownload')).toBe('MSDOWNLOAD');
    expect(formatMime('application/x-7z-compressed')).toBe('7Z-COMPRESSED');
  });

  test('never renders an empty cell', () => {
    // A soft-deleted or partially-written row can carry no MIME type. An empty
    // table cell looks like a rendering bug; an em dash reads as "unknown".
    expect(formatMime(null)).toBe('—');
    expect(formatMime(undefined)).toBe('—');
    expect(formatMime('')).toBe('—');
  });

  test('passes through a value with no slash rather than mangling it', () => {
    // Defensive: the server should always send a real MIME type, but truncating
    // at a slash that is not there would silently return the empty string.
    expect(formatMime('unknown')).toBe('unknown');
  });
});

describe('formatSize', () => {
  test('formats bytes with a unit and sensible precision', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(220155)).toBe('215.0 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
  });

  test('returns 0 B for values the server can legitimately hand back', () => {
    // `formatSize` is deliberately honest about bad input rather than throwing:
    // a soft-deleted or partially-written row can report a non-positive size.
    expect(formatSize(-1)).toBe('0 B');
    expect(formatSize(Number.NaN)).toBe('0 B');
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
