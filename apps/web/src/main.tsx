/**
 * SPA entry point.
 *
 * This file MUST exist: `vite.config.ts` and `index.html` both reference it, so a
 * `pnpm run build` fails outright without it.
 *
 * ## The provider order is not arbitrary
 *
 * `QueryClientProvider` wraps `RouterProvider` because the router's context carries
 * the same `queryClient` object — the guards call `ensureQueryData` on it before a
 * component exists, and the components then read what the guard put there. Wrapping
 * the other way round would leave the guards with a client React does not know
 * about, so nothing would re-render when it updated.
 *
 * ## Two constraints on everything mounted below
 *
 *  1. Auth state is a THREE-state probe, not a boolean. `GET /api/v1/auth/me`
 *     answers 200 (identified), 401 (configured, no credential), or fails for a
 *     deployment fault. Collapsing that to `isAuthenticated` either locks out a
 *     signed-in user or shows write controls on a deployment that rejects them.
 *     The states live in `lib/auth.ts` and every consumer reads them from there.
 *  2. Object keys are server data with NO validation server-side
 *     (`formData.get('key')` is taken verbatim). Render them as React children only
 *     — never interpolate a key into an inline handler and never use
 *     `dangerouslySetInnerHTML`. `home.html` did exactly that and it was a confirmed
 *     stored XSS: its `escapeHtml` used textContent→innerHTML, which does not escape
 *     quotes, and one apostrophe in a key terminated the inline
 *     `onclick="downloadObject('...')"` literal.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { queryClient } from './lib/query';
import { router } from './router';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found — index.html is missing the mount node');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
