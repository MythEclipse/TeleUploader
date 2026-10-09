import { traverseContractProcedures } from '@orpc/server';
import { z } from 'zod';
import { config } from '../../env';
import { rootContract } from './routers/bucket';

/**
 * OpenAPI generation from the live oRPC router (P4).
 *
 * WHY THIS EXISTS, and why it does not use `@orpc/openapi`
 *
 * The recon lens that proposed `OpenAPIGenerator` was wrong on the dependency:
 * `@orpc/openapi` is not in the installed set, and `OpenAPIGenerator` appears in
 * ZERO files under `node_modules/.pnpm/@orpc+*`. Verified, not assumed:
 *
 *   $ node -e "require.resolve('@orpc/openapi')"   ->  MODULE_NOT_FOUND
 *   $ grep -rl OpenAPIGenerator node_modules/.pnpm/@orpc+.../@orpc/ | wc -l
 *   0
 *
 * Adding it is not this lane's call anyway — `apps/api/package.json` is owned by
 * the orchestrator, and no `pnpm install` may run. So the generator is derived
 * from the INSTALLED oRPC primitives instead: `traverseContractProcedures` for
 * the procedure tree, the contract's own `~orpc.meta` for method/path/summary,
 * and zod v4's native `toJSONSchema` for real input schemas.
 *
 * WHAT IS AND IS NOT GENERATED
 *
 * Generated from the router (7 procedures): method, path, summary, and a real
 * JSON Schema for each input, including `.describe()` text and constraint
 * keywords (`minLength`, `pattern`, `maximum`). This is the part that used to be
 * a hand-written literal and could drift from the router.
 *
 * NOT generated, and deliberately so: the public data plane (`/api/upload`,
 * `/f/{public_id}`), the S3 wire protocol, and the auth endpoints. oRPC does not
 * own those — see presentation/http/app.ts for why pushing S3 through oRPC would
 * put ~2,900 lines of byte-compatibility at risk. A generator-only spec would
 * DELETE their documentation, which regresses the constraint that the S3 surface
 * must stay documented accurately for aws-cli, rclone and the Docker registry
 * client. Those paths are supplied by the caller (see `buildOpenApiSpec`).
 */

/** `~orpc` is oRPC's internal contract envelope; nothing public exposes it. */
interface OrpcEnvelope {
  meta?: RouteMeta;
  inputSchema?: StandardSchemaEnvelope;
}

interface RouteMeta {
  method?: string;
  path?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
}

/**
 * oRPC stores the input schema as a Standard Schema envelope.
 *
 * Verified by execution, not by reading the .d.ts: `~orpc.inputSchema` is
 * `{ def, type }` where `type` is the literal string `'object'` and `def` is
 * zod's internal `{ type: 'object', shape }`. The leaves of `shape` ARE genuine
 * zod schemas (each carries `_zod` and `def`). Rebuilding `z.object(shape)` is
 * therefore lossless for input validation.
 */
interface StandardSchemaEnvelope {
  def?: { type?: string; shape?: Record<string, unknown> };
  type?: string;
}

type JsonSchema = Record<string, unknown>;

/** Procedures whose body carries no schema. */
const NO_INPUT = Symbol('no-input');

/**
 * Read a contract procedure's `~orpc` envelope.
 *
 * Traversal hands back contract objects whose metadata is nested one level down
 * under `~orpc`; the top level exposes only the `~orpc` key itself.
 */
const envelopeOf = (contract: unknown): OrpcEnvelope => {
  const holder = contract as Record<string, unknown>;
  const envelope = holder['~orpc'] as OrpcEnvelope | undefined;
  return envelope ?? (holder as OrpcEnvelope);
};

/**
 * Rebuild a JSON Schema from a procedure's declared input.
 *
 * @returns The schema, or `NO_INPUT` when the procedure takes no input.
 */
const inputJsonSchemaOf = (envelope: OrpcEnvelope): JsonSchema | typeof NO_INPUT => {
  const shape = envelope.inputSchema?.def?.shape;
  if (!shape || Object.keys(shape).length === 0) return NO_INPUT;
  try {
    const rebuilt = z.object(shape as never);
    return z.toJSONSchema(rebuilt as never, {
      io: 'input',
      target: 'draft-7',
      // Without this, zod throws on anything it cannot represent. Emitting
      // `{}` keeps one exotic field from taking down the whole spec.
      unrepresentable: 'any',
    }) as JsonSchema;
  } catch {
    return NO_INPUT;
  }
};

/** `{bucket}` -> `{ name: 'bucket', in: 'path', required: true, schema }`. */
const pathParametersOf = (path: string, body: JsonSchema | typeof NO_INPUT): unknown[] => {
  const properties = (body === NO_INPUT ? undefined : body.properties) as
    | Record<string, JsonSchema>
    | undefined;
  return [...path.matchAll(/\{(\w+)\}/g)].map((match) => {
    const name = match[1];
    return {
      name,
      in: 'path',
      required: true,
      ...(properties?.[name] ? { schema: properties[name] } : { schema: { type: 'string' } }),
    };
  });
};

/**
 * Does this HTTP method carry a request body?
 *
 * @param method - The OpenAPI method key, which is always lower-case.
 */
const methodTakesBody = (method: string): boolean =>
  method === 'post' || method === 'put' || method === 'patch';

/**
 * Build the OpenAPI `paths` fragment for every procedure on the router.
 *
 * Runs against `rootContract` — the CONTRACT, not the built router. Verified:
 * traversing the built router yields procedures with `~orpc` metadata of
 * `undefined`, because the builder resolves the contract into handlers. The
 * contract is where `os.meta()` actually lands.
 *
 * @param contract - The oRPC contract to walk. Defaults to this app's root.
 * @returns Path items keyed by OpenAPI path template.
 */
export const buildRouterPaths = (
  contract: unknown = rootContract,
): Record<string, Record<string, unknown>> => {
  const paths: Record<string, Record<string, unknown>> = {};

  traverseContractProcedures({ router: contract as never, path: [] }, ({ contract: procedure }) => {
    const envelope = envelopeOf(procedure);
    const meta = envelope.meta;
    if (!meta?.method || !meta.path) return;

    const method = meta.method.toLowerCase();
    const body = inputJsonSchemaOf(envelope);
    const parameters = pathParametersOf(meta.path, body);

    const operation: Record<string, unknown> = {
      summary: meta.summary ?? '',
      operationId: `${meta.path.replace(/[/{}]/g, '_').replace(/^_|_$/g, '')}_${method}`,
      tags: meta.tags ?? ['bucket'],
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.deprecated ? { deprecated: true } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        '200': {
          description: 'Successful response.',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        '400': { description: 'Invalid request.', content: { 'application/json': {} } },
        '401': { description: 'Unauthorized.', content: { 'application/json': {} } },
        '500': { description: 'Internal error.', content: { 'application/json': {} } },
      },
    };

    if (methodTakesBody(method) && body !== NO_INPUT) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: body } },
      };
    }

    // Lazily create the path item. Written as two statements rather than
    // `paths[meta.path] ??= {}` so the mutation is not hidden inside an
    // expression that reads like a pure lookup.
    let existing = paths[meta.path];
    if (!existing) {
      existing = {};
      paths[meta.path] = existing;
    }
    existing[method] = operation;
  });

  return paths;
};

/**
 * Security schemes. Without these, Swagger UI renders no **Authorize** button
 * and any generated client sends no credentials — while `/rpc/*` and every
 * `/api/v1/*` write sit behind `requireAuth`.
 */
export const securitySchemes = (): Record<string, unknown> => ({
  sessionCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: config.sessionCookieName,
    description: 'Session cookie set by POST /api/v1/auth/login.',
  },
  bearerToken: {
    type: 'http',
    scheme: 'bearer',
    description: 'Admin API token as a bearer credential.',
  },
});
