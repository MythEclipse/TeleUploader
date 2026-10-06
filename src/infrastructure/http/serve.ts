import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * A minimal stand-in for bun's `serve({ routes, fetch })`, expressed on
 * `node:http` and sufficient for this service.
 *
 * Every route handler here is already written against the Web standard (it
 * takes a `Request` and returns a `Response`), so the only thing missing off
 * bun is the bridge from a Node socket to that pair. Keeping the bridge in one
 * file means no handler had to change.
 *
 * Route matching mirrors bun's `routes` semantics for this app's table:
 *  - an exact path maps to one handler per HTTP method;
 *  - `:name` segments capture a path component onto `req.params`;
 *  - a trailing `/*` is a wildcard matching any suffix;
 *  - among the routes that match, the most specific wins (static beats
 *    parameter beats wildcard), so `/api/v1/auth/login` beats both
 *    `/api/v1/*` and `/*`, which also match that URL;
 *  - `fetch` handles anything no route claims.
 */

export type Handler = (req: Request, ...args: never[]) => Response | Promise<Response>;

type Routes = Record<string, Record<string, Handler>>;

export type ServeOptions = {
  port: number;
  hostname?: string;
  routes: Routes;
  fetch: (req: Request) => Response | Promise<Response>;
};

export type ServerHandle = {
  stop: () => void;
  port: number;
};

/** What `serve()` hangs off a dispatched `Request`, like bun's `req.params`. */
type RequestWithParams = Request & { params?: Record<string, string> };

const toByteStream = (incoming: IncomingMessage): ReadableStream<Uint8Array> =>
  // Node streams the request body; a Web Request wants a ReadableStream. The
  // data/end/error wiring keeps the bytes intact — and keeps a socket error
  // reaching the handler as a stream error rather than a silent truncation.
  new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      incoming.on('end', () => controller.close());
      incoming.on('error', (error: Error) => controller.error(error));
    },
  });

const buildRequest = (incoming: IncomingMessage, origin: string): Request => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    // Node delivers repeated headers as arrays; Headers.append keeps them all.
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(key, item);
    }
  }

  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  return new Request(new URL(incoming.url ?? '/', origin).href, {
    method,
    headers,
    // A stream body on a Web Request requires `duplex: 'half'`.
    body: hasBody ? toByteStream(incoming) : undefined,
    duplex: 'half',
  } as RequestInit);
};

const writeResponse = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers) {
    outgoing.setHeader(key, value);
  }

  if (!response.body) {
    outgoing.end();
    return;
  }

  // Stream rather than buffer: file downloads here can be hundreds of MB.
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', reject)
      .once('end', resolve)
      .pipe(outgoing);
  });
};

/** Split a path or pattern into segments, dropping the leading empty string. */
const segmentsOf = (value: string): string[] => value.split('/').filter(Boolean);

/**
 * Score one route pattern against a path. Returns `null` when the pattern does
 * not match, otherwise the captured `:params` plus a specificity score in which
 * a higher number must win (static beats parameter beats wildcard).
 */
const scoreRoute = (
  pattern: string,
  pathSegments: string[],
): { params: Record<string, string>; score: number } | null => {
  const patternSegments = segmentsOf(pattern);
  const wildcard = patternSegments.at(-1) === '*';
  const base = wildcard ? patternSegments.slice(0, -1) : patternSegments;

  // A wildcard absorbs any suffix; an exact pattern must consume the whole path.
  if (wildcard ? pathSegments.length < base.length : pathSegments.length !== base.length) {
    return null;
  }

  const params: Record<string, string> = {};
  let score = 0;
  for (let i = 0; i < base.length; i++) {
    const part = base[i];
    if (part.startsWith(':')) {
      params[part.slice(1)] = pathSegments[i];
      score += 1;
    } else if (part === pathSegments[i]) {
      score += 4;
    } else {
      return null;
    }
  }

  // Anything the wildcard also matches must outrank the wildcard itself.
  if (wildcard) score -= 2;

  return { params, score };
};

const matchRoute = (
  routes: Routes,
  pathname: string,
  method: string,
): { handler: Handler; params: Record<string, string> } | null => {
  const pathSegments = segmentsOf(pathname);
  let best: { handler: Handler; params: Record<string, string>; score: number } | null = null;

  for (const [pattern, methods] of Object.entries(routes)) {
    // `own` rather than a bare lookup: a path can match while the method does
    // not (e.g. HEAD on a POST-only route), and that must fall through to
    // `fetch` instead of crashing.
    const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!handler) continue;

    const scored = scoreRoute(pattern, pathSegments);
    if (!scored) continue;
    if (best && scored.score <= best.score) continue;

    best = { handler, params: scored.params, score: scored.score };
  }

  return best ? { handler: best.handler, params: best.params } : null;
};

export const serve = ({ port, hostname, routes, fetch }: ServeOptions): ServerHandle => {
  const httpServer = createServer((incoming, outgoing) => {
    const host = incoming.headers.host ?? `${hostname ?? 'localhost'}:${port}`;

    void (async () => {
      try {
        const request = buildRequest(incoming, `http://${host}`) as RequestWithParams;
        const url = new URL(request.url);
        const method = incoming.method ?? 'GET';

        const matched = matchRoute(routes, url.pathname, method);
        if (matched) {
          request.params = matched.params;
          await writeResponse(await matched.handler(request), outgoing);
          return;
        }

        await writeResponse(await fetch(request), outgoing);
      } catch (error) {
        outgoing.statusCode = 500;
        outgoing.end(error instanceof Error ? error.message : 'Internal Server Error');
      }
    })();
  });

  httpServer.listen(port, hostname);

  return {
    port,
    stop: () => {
      // Without this, keep-alive sockets hold the server open past shutdown.
      httpServer.closeAllConnections();
      httpServer.close();
    },
  };
};
