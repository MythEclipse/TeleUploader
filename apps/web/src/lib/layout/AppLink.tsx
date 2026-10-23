/**
 * An internal link that uses TanStack Router's `<Link>` so navigation between
 * app pages is a client-side transition instead of a full document reload.
 *
 * ## Why this replaced `<a href>`
 *
 * The old version rendered `<a href={href}>`, which costs a full document load
 * on every navigation and loses the router's preload / active state. Now the
 * routes exist (`index.tsx`, `login.tsx`), so `<Link to>` typechecks against
 * the generated route tree and is strictly better.
 *
 * ## Active state
 *
 * TanStack `Link` already sets `aria-current="page"` when `to` matches the
 * current route, so callers do not need to pass `aria-current` explicitly.
 * The prop is forwarded through so nothing breaks.
 */

import { Link } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The route path to navigate to, type-checked against the route tree. */
  readonly to: string;
  children: ReactNode;
}

/** Thin wrapper around TanStack's `Link` so call sites do not import the router directly. */
export const AppLink = ({ to, children, ...rest }: AppLinkProps): React.JSX.Element => (
  <Link to={to} {...rest}>
    {children}
  </Link>
);
