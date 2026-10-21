/**
 * The active tenant scope, and the typed oRPC client that carries it.
 *
 * ## How the organization reaches the server
 *
 * Every procedure on the API is tenant-scoped, but NONE of them takes an
 * organization argument. The server resolves it from `?org=<slug>` on the RPC
 * REQUEST URL — `handleRpc` reads it before any procedure runs and refuses a slug
 * the caller is not a member of.
 *
 * That is a deliberate server design (a procedure cannot forget to scope itself),
 * and it means the CLIENT has to put the slug on the URL. `RPCLink`'s `url` accepts a
 * function, so the slug is appended there from a single store. One place decides the
 * tenant for every call in the app.
 *
 * ## Why a store rather than threading the slug through every call
 *
 * Threading it would mean every `queryOptions` and every `mutate` takes a slug that
 * the client ignores — noise at 20 call sites, and one omission away from a request
 * that lands in the caller's DEFAULT organization instead of the one on screen. A
 * module-level store is set once by the route guard that resolved the tenant, and
 * every subsequent call is scoped without knowing it.
 *
 * The failure mode is worth naming: if the store were stale, a read would return
 * another tenant's data. That is prevented by setting it in `beforeLoad` BEFORE any
 * prefetch, and by the server refusing a non-member slug rather than falling back.
 *
 * ## Why the type is `ContractRouterClient<typeof rootContract>`
 *
 * `AppRouter` — `ReturnType<typeof buildRouter>` — is the type of a router built by
 * `implement(contract).router(...)`, which TypeScript widens into a UNION of every
 * procedure-builder shape. `RouterClient<AppRouter>` distributes over that union, so
 * `rpc.bucket` becomes `A | B` and neither member has `listObjects`; the error reads
 * `Property 'listObjects' does not exist on type '… | …'`. Verified — that was the
 * first attempt.
 *
 * The CONTRACT is not a union: `rootContract` is a plain object of plain objects, so
 * `ContractRouterClient<typeof rootContract>` maps each procedure to
 * `(input) => Promise<Output>` exactly once. The contract is also the right source of
 * truth for a CLIENT — it carries input and output schemas and nothing about the
 * server's implementation, which is the same reason the OpenAPI generator walks it.
 */

import type { rootContract } from '@api/presentation/orpc/routers/bucket';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { Store } from '@tanstack/store';

/**
 * The organization slug every request is scoped to.
 *
 * Empty until a route resolves a tenant. A request made in that window would be
 * answered for the caller's default organization — which is why the guards set this
 * before they prefetch, and why every `queryOptions` in `./queries.ts` is `enabled`
 * only when a slug is present.
 */
export const tenantStore = new Store<string>('');

/**
 * Publishes the tenant for every subsequent request.
 *
 * @param slug - The organization slug the route resolved.
 */
export const setTenant = (slug: string): void => {
  tenantStore.setState(() => slug);
};

/** The current tenant slug. Empty before a route resolves one. */
export const currentTenant = (): string => tenantStore.state;

/**
 * Builds the RPC URL for one call, with the tenant attached.
 *
 * A function rather than a string so the slug is read at CALL time, not at module
 * evaluation — the client is constructed once, long before a route knows which
 * organization the user is looking at.
 *
 * @returns `/rpc?org=<slug>`, or `/rpc` when no tenant is set yet.
 */
const rpcUrl = (): string => {
  const slug = tenantStore.state;
  return slug ? `/rpc?org=${encodeURIComponent(slug)}` : '/rpc';
};

/**
 * The link.
 *
 * Relative, so the client follows whatever origin served the SPA. `credentials` is
 * not set: `RPCLink`'s `fetch` option only receives `redirect`, and it does not need
 * to — the SPA is same-origin with the API, so `fetch`'s default `same-origin`
 * attaches the HttpOnly session cookie.
 */
const link = new RPCLink({ url: rpcUrl });

/**
 * The typed client.
 *
 * Every call is `rpc.<namespace>.<procedure>(input)`. A procedure with no input takes
 * no argument; one with input takes exactly the shape its Zod schema declares, so a
 * renamed field fails to compile here rather than at runtime.
 */
export const rpc: ContractRouterClient<typeof rootContract> = createORPCClient(link);

/**
 * TanStack Query bindings for every procedure.
 *
 * `orpc.bucket.listObjects.queryOptions({ input: { bucket } })` yields a `queryKey` +
 * `queryFn` pair derived from the procedure path and its input, so a key and a fetcher
 * cannot drift and `invalidateQueries` can target a whole namespace. This is what
 * makes the oRPC contract the single source of truth for the cache as well as for the
 * wire.
 */
export const orpc = createTanstackQueryUtils(rpc);
