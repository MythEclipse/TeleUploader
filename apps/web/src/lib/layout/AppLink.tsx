/**
 * An internal link that uses TanStack Router's `<Link>` so navigation between
 * app pages is a client-side transition instead of a full document reload.
 */

import { Link } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  readonly to: string;
  children: ReactNode;
}

export const AppLink = ({ to, children, ...rest }: AppLinkProps): React.JSX.Element => (
  <Link to={to} {...rest}>
    {children}
  </Link>
);
