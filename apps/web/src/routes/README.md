# `src/routes/` — owned by the SPA lane

This directory exists so `@tanstack/router-plugin` does not log
`ENOENT: no such file or directory, scandir '.../src/routes'` on every `vite build`
and `vite dev`. The build still exits 0 without it, but a permanent error line in
build output is exactly the kind of noise that trains people to ignore errors.

**The SPA lane owns everything in this directory.** The contract lane created the
directory only; it wrote no route files, by design.

## Required route shapes

Specified in `docs/P4-CONTRACT.md` §1. TanStack Router is file-based and these are
**single files, not folders** (per the migration plan, skill §3.1):

```
__root.tsx                  Document shell + <Outlet/> + error boundary. No auth logic.
index.tsx                   /                the file browser (replaces home.html's <script>)
login.tsx                   /login           token form -> POST /api/v1/auth/login
$orgSlug.tsx                /$orgSlug        org landing (thin in v1)
$orgSlug/dashboard.tsx      /$orgSlug/dashboard
$orgSlug/bucketName.tsx     /$orgSlug/$bucketName
```

Once the first real route file lands, the plugin writes `src/routeTree.gen.ts`.
**Do not hand-edit that file** — the plugin owns it. Then update `src/router.tsx` to
import it:

```ts
import { routeTree } from './routeTree.gen';
export const router = createRouter({ routeTree, defaultPreload: 'intent' });
```

## Two rules that are easy to get wrong

1. **Bucket and prefix belong in SEARCH PARAMS** (`?bucket=x&prefix=a/b/`), not
   component state. `home.html` keeps `currentPrefix` in a JS global and re-reads the
   search box on every request, so `const prefix = searchVal || currentPrefix` silently
   overrides navigation — the breadcrumb then disagrees with the rendered data.
2. **Never build an inline event handler or `dangerouslySetInnerHTML` from an object
   key.** Keys are unvalidated server input. `home.html` interpolates the raw key into
   `onclick="downloadObject('...')"` and its `escapeHtml` (textContent→innerHTML) does
   not escape quotes, so one apostrophe in a key is a confirmed stored XSS.