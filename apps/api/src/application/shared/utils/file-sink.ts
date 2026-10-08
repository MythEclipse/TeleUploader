import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Node replacements for two bun-only file APIs.
 *
 * `createFileSink` stands in for `Bun.file(path).writer()` (bun's `FileSink`):
 * a fire-and-forget `write(chunk)` plus an awaited `end()`. `writeBodyToFile`
 * stands in for `await Bun.write(path, response)`.
 */

/** An ordered, append-only sink for streaming chunks to disk. */
export interface FileSink {
  /** Queue `chunk` for writing. Backpressure is absorbed by the stream buffer. */
  write: (chunk: Uint8Array) => void;
  /** Flush everything queued, close the file, and reject on any write error. */
  end: () => Promise<void>;
}

/**
 * Open `path` for writing and return a sink that appends chunks in order.
 *
 * The write path is an `fs.WriteStream`, so callers keep bun's synchronous
 * `write()` shape — only `end()` is awaited, and it is the point at which the
 * bytes are guaranteed to be on disk. That guarantee matters: every caller
 * hands the resulting path straight to a reader.
 *
 * @param path - Absolute path of the file to create (truncated if present).
 * @returns A {@link FileSink} that must be `end()`ed, even on the error path.
 */
export const createFileSink = (path: string): FileSink => {
  const stream = createWriteStream(path);
  let failure: Error | null = null;
  let ended = false;

  stream.on('error', (error: Error) => {
    failure ??= error;
  });

  const end = async (): Promise<void> => {
    if (ended) return;
    ended = true;

    if (failure || stream.destroyed) {
      stream.destroy();
      if (failure) throw failure;
      return;
    }

    stream.end();
    await once(stream, 'close');
    if (failure) throw failure;
  };

  return {
    write(chunk) {
      if (failure || ended) return;
      stream.write(chunk);
    },
    end,
  };
};

/**
 * Write a `Response`'s body to `path`, streaming rather than buffering.
 *
 * @param response - The response whose body is consumed (null body → empty file).
 * @param path - Destination path.
 */
export const writeBodyToFile = async (response: Response, path: string): Promise<void> => {
  if (!response.body) {
    await writeFile(path, Buffer.alloc(0));
    return;
  }

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(path),
  );
};
