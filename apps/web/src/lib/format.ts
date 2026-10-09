/**
 * Display formatters, ported 1:1 from `home.html`'s `formatSize`/`formatDate`.
 *
 * Kept separate from `./endpoints` because they are pure and shared by every
 * route; and kept honest about `home.html`'s behaviour rather than "improved":
 * `formatSize` returns `'0 B'` for zero, negative and non-finite input, which is
 * what the server can hand back for a soft-deleted or partially-written row.
 */

/** Human-readable byte size. `home.html:328` returns `'0 B'` for anything <= 0. */
export const formatSize = (bytes: number): string => {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let index = 0;
  let scaled = size;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
};

/**
 * Short date, `Mon D, YYYY` in the viewer's locale. Empty string for a missing
 * or unparseable timestamp, matching `home.html:329`.
 */
export const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * The segment of `key` below `prefix`, for the object table's name column.
 *
 * Returns `key` itself when `prefix` is empty or is not actually a prefix of
 * `key`, so a row never renders a blank name if the two ever disagree.
 */
export const displayKey = (key: string, prefix: string): string => {
  if (!prefix || !key.startsWith(prefix)) return key;
  const rest = key.slice(prefix.length);
  return rest.length > 0 ? rest : key;
};

/**
 * A prefix rendered as a directory name — always ending in `/`.
 *
 * `home.html:301` appended `/` defensively for the same reason: the server's
 * `prefixes[]` already carries the trailing slash, but the empty-prefix case
 * would otherwise render a nameless row.
 */
export const displayPrefix = (prefix: string, currentPrefix: string): string => {
  const rest = displayKey(prefix, currentPrefix);
  return rest.endsWith('/') ? rest : `${rest}/`;
};
