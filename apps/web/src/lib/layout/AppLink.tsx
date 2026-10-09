/**
 * An internal link that typechecks before its target route exists.
 *
 * ## Why this exists
 *
 * TanStack's `<Link to>` is typed against the generated route tree, which is a
 * strict union of the routes that actually exist on disk. The shared shell
 * links to `/` and `/login`, but both of those files are owned by other lanes
 * (contract §7.1) and neither has landed. So:
 *
 * ```
 * src/lib/layout/AppShell.tsx(34,13): error TS2322:
 *   Type '"/"' is not assignable to type '"." | ".."'.
 * ```
 *
 * With only `__root.tsx` present, the valid targets are the two relative
 * segments and nothing else. Note what that means: **`tsc` fails, and
 * `vite build` still exits 0.** A green build with a red typecheck is the exact
 * shape of failure this phase is trying to eliminate, so the typecheck gate is
 * the one that has to hold.
 *
 * ## The trade, stated plainly
 *
 * `<a href>` costs a full document load on navigation; `<Link>` costs a
 * client-side transition. The shell deliberately takes the full load, because
 * the alternative is a build that cannot typecheck until three other lanes
 * finish.
 *
 * ## Removing this
 *
 * The moment `src/routes/index.tsx` and `src/routes/login.tsx` both exist,
 * `to: '/'` and `to: '/login'` typecheck, and this component should become a
 * thin re-export of TanStack's `Link`. Delete this file in the same commit.
 * The two call sites (`AppShell`, `NotFound`) need no change.
 *
 * It is NOT a general-purpose escape hatch. A new link to a route that *does*
 * exist should use `Link` directly — do not reach for `AppLink` out of habit.
 */

import type { AnchorHTMLAttributes, ReactNode } from 'react';

export interface AppLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children: ReactNode;
}

export const AppLink = ({ href, children, ...rest }: AppLinkProps): React.JSX.Element => (
  <a href={href} {...rest}>
    {children}
  </a>
);
