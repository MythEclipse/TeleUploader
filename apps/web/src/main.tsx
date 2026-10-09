/**
 * SPA entry point.
 *
 * This file MUST exist: `vite.config.ts` and `index.html` both reference it, so a
 * `pnpm run build` fails outright without it. It is deliberately minimal — the
 * SPA lane owns everything it mounts.
 *
 * Two constraints from docs/P4-CONTRACT.md that apply to whatever replaces this:
 *
 *  1. Auth state is a THREE-state probe, not a boolean. `GET /api/v1/auth/me`
 *     returns 200 (admin), 401 (read-only) or 404 (auth DISABLED — which means
 *     `requireAuth` is a pass-through, so writes succeed and the admin UI must
 *     render). Collapsing that to `isAuthenticated` either locks out every
 *     non-admin or exposes the admin UI with no backend enforcement.
 *  2. Object keys are server data with NO validation server-side
 *     (`formData.get('key')` is taken verbatim). Render them as React children
 *     only — never interpolate a key into an inline handler and never use
 *     `dangerouslySetInnerHTML`. `home.html` did exactly that and it is a
 *     confirmed stored XSS: its `escapeHtml` uses textContent→innerHTML, which
 *     does not escape quotes, and a single apostrophe in a key terminates the
 *     inline `onclick="downloadObject('...')"` string literal.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found — index.html is missing the mount node');

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);