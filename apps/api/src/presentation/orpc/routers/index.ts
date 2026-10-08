import { implement } from '@orpc/server';
import type { AppRouterContext } from '../context';
import { type BucketBase, type BucketHandlers, buildBucketRouter, rootContract } from './bucket';

/**
 * Root oRPC router (P2c).
 *
 * Scope is deliberately narrow: bucket and object MANAGEMENT only. The S3 wire
 * protocol and the public data plane (`POST /api/upload`, `GET /f/:public_id`)
 * stay as hand-written controllers — see presentation/http/app.ts for why
 * pushing XML through oRPC would be a mistake.
 *
 * Contract-first: `$context<AppRouterContext>()` is applied once, at the root,
 * rather than per namespace. The package-level `os.router` is typed against an
 * EMPTY context, so routing through it would erase the context every procedure
 * handler depends on.
 */
export const buildRouter = (handlers: BucketHandlers) => {
  const base: BucketBase = implement(rootContract).$context<AppRouterContext>();
  return base.router({
    bucket: buildBucketRouter(base, handlers),
  });
};

/**
 * A fully-built router instance.
 *
 * `AppRouter` is what the web app imports as a TYPE to derive its typed client
 * (`AppRouterClient`). That import must be `import type` — it carries no server
 * code across the boundary, per the skill's non-negotiable rule #1.
 */
export type AppRouter = ReturnType<typeof buildRouter>;

/** Context every procedure receives. Re-exported for router consumers. */
export type { AppRouterContext };
