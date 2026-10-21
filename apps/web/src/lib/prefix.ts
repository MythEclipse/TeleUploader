/**
 * Prefix normalisation for the object browser.
 *
 * ## Why this is its own module
 *
 * Two callers need the same rule and neither may own the other: the route's
 * `validateSearch` normalises an untrusted URL value, and the filter box normalises
 * what the user is typing. A second copy of "add a trailing slash if missing" is
 * how a breadcrumb ends up showing `a/b` while the listing filters on `a/b` — the
 * server matches prefixes literally, so the missing slash lists nothing.
 */

/**
 * Normalises a raw value into a directory prefix.
 *
 * Non-strings and the empty string become `''`. Anything else gains a trailing `/`
 * if it lacks one.
 *
 * @param value - The untrusted search-param value or raw input text.
 * @returns `''` or a string ending in `/`.
 */
export const asPrefix = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.endsWith('/') ? value : `${value}/`;
};

/**
 * Normalises a raw search-param value into a bucket name.
 *
 * Bucket names are `[a-z0-9.-]` server-side, so the only thing to guard against here
 * is a non-string arriving from the URL.
 *
 * @param value - The untrusted search-param value.
 * @returns The bucket name, or `''` when unset.
 */
export const asBucketName = (value: unknown): string => (typeof value === 'string' ? value : '');
