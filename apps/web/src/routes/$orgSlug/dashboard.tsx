/**
 * `/$orgSlug/dashboard` — the organization dashboard.
 *
 * ## What changed with multi-user auth
 *
 * The loader used to call `listBuckets()` with no argument, because there was no
 * organization parameter on the wire and exactly one org existed. Buckets are now
 * per-organization, so the loader takes the slug from `params` and threads it into
 * every read. An unscoped read would answer for the caller's DEFAULT organization,
 * which is not necessarily the one in the URL — that mismatch is how a dashboard ends
 * up counting another workspace's objects.
 *
 * ## The credentials modal is honest because the capability still does not exist
 *
 * No route returns an S3 access key or secret. `s3CredentialRepository` is read only by
 * the SigV4 verifier; `IS3CredentialRepository` declares just `findByAccessKey` and
 * `touchLastUsed`, with no list-by-organization to read through. So this panel states
 * the gap and names the work, rather than rendering two permanently empty inputs the
 * way `home.html:366` did.
 *
 * That reasoning is unchanged by multi-user auth — with more users it is *more* true,
 * since a shared key pair across tenants would be strictly worse than none.
 *
 * ## Endpoint URL and region: correctly sourced, or correctly caveated
 *
 * `BASE_URL` is server-supplied per object as `ObjectSummary.downloadUrl`'s origin, so
 * the endpoint is derived from **server data** whenever any bucket holds an object —
 * never from `window.location.origin`, which is wrong behind a proxy.
 *
 * `us-east-1` is `config.s3DefaultRegion`'s documented default. Nothing in the API
 * returns the region, so it is labelled as a default rather than presented as an answer.
 *
 * ## Read-only visitors do not get the button
 *
 * `showCredentialsModal` in `home.html` opened with `if (!isAdmin) alert(…)`. Here the
 * button is not rendered when `useCanWrite()` is false.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useCanWrite, useIsReadOnly } from '../../lib/auth-store';
import { listBuckets, listObjects } from '../../lib/endpoints';
import type { BucketSummary } from '../../lib/types';

/**
 * Region shown when the API exposes nothing.
 *
 * This is `config.s3DefaultRegion`'s documented default, NOT a value read from the
 * server — nothing in the API returns the region. It is labelled as such in the UI.
 */
const DEFAULT_REGION = 'us-east-1';

/**
 * The server-supplied public origin, discovered from any object's `downloadUrl`.
 *
 * `ObjectSummary.downloadUrl` is `${BASE_URL}/f/{publicId}` — a real absolute URL built
 * from `config.baseUrl` at request time. Taking its origin yields the endpoint a user
 * actually pastes into an S3 client, which is exactly what `window.location.origin` gets
 * wrong behind a reverse proxy.
 *
 * `BucketSummary` carries only `{id, name, createdAt, objectCount}` — no URL of any kind
 * — so learning `BASE_URL` requires looking at an object.
 *
 * @param buckets - Buckets in this organization.
 * @param orgSlug - Organization slug the probe must be scoped to.
 * @returns The origin, or `null` when nothing exposes one.
 */
const discoverServerOrigin = async (
  buckets: BucketSummary[],
  orgSlug: string,
): Promise<string | null> => {
  // One bucket is enough and bounds the work: this is a cosmetic field, not a data load.
  const [bucket] = buckets;
  if (!bucket) return null;

  try {
    const listing = await listObjects(bucket.name, { maxKeys: 1 }, orgSlug);
    const downloadUrl = listing.objects[0]?.downloadUrl;
    if (!downloadUrl) return null;
    return new URL(downloadUrl).origin;
  } catch {
    // A failure here must not break the dashboard — the endpoint field is decoration.
    return null;
  }
};

export const Route = createFileRoute('/$orgSlug/dashboard')({
  /**
   * Buckets for THIS organization.
   *
   * The slug comes from `params` and is forwarded as `?org=`. The server refuses a slug
   * the caller is not a member of, so this cannot read another tenant even if the URL
   * were hand-crafted. The parent loader also 404s a non-membership before this runs.
   */
  loader: ({ params }: { params: { orgSlug: string } }): Promise<BucketSummary[]> =>
    listBuckets(params.orgSlug),
  component: OrgDashboard,
});

interface CredentialsDialogProps {
  /** Absolute origin from `BASE_URL`, or `null` when no object exposes one. */
  endpoint: string | null;
  onClose: () => void;
}

const CredentialsDialog = ({ endpoint, onClose }: CredentialsDialogProps): React.JSX.Element => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    restoreFocusTo.current = document.activeElement;
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (restoreFocusTo.current instanceof HTMLElement) restoreFocusTo.current.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      // Backdrop click closes. Guarded by currentTarget so a click that started inside
      // the dialog and ended on the backdrop does not close it.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a modal container is focusable and labelled by role=dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="credentials-heading"
        tabIndex={-1}
        className="modal"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="credentials-heading">S3 credentials</h3>

        <p role="status">
          <strong>Not available from the API yet.</strong> No endpoint returns an S3 access key or
          secret key, so this panel cannot show one. It is not hiding them — nothing can hand them
          out today.
        </p>

        <label htmlFor="credentials-endpoint">Endpoint URL</label>
        {endpoint ? (
          <input
            id="credentials-endpoint"
            type="text"
            readOnly
            value={endpoint}
            onFocus={(e) => e.currentTarget.select()}
          />
        ) : (
          <p className="auth-status" id="credentials-endpoint">
            Unknown — this workspace has no uploaded object, so the API has not disclosed its public
            base URL. It is <code>BASE_URL</code> on the server, and is frequently <em>not</em> this
            page&apos;s origin when the app sits behind a reverse proxy.
          </p>
        )}

        <label htmlFor="credentials-region">Region</label>
        <input
          id="credentials-region"
          type="text"
          readOnly
          value={DEFAULT_REGION}
          onFocus={(e) => e.currentTarget.select()}
        />
        <p className="auth-status">
          The default from the server&apos;s <code>S3_DEFAULT_REGION</code>. No API response carries
          the region, so a deployment that overrides it will differ from this value.
        </p>

        <label htmlFor="credentials-access-key">Access Key</label>
        {/* `readOnly` + no value, matching the server's actual capability. NOT `disabled`,
            which would drop the field out of the tab order entirely and hide that the
            field exists at all. */}
        <input
          id="credentials-access-key"
          type="text"
          readOnly
          placeholder="not returned by any endpoint"
          aria-describedby="credentials-access-key-note"
          onFocus={(e) => e.currentTarget.select()}
        />

        <label htmlFor="credentials-secret-key">Secret Key</label>
        <input
          id="credentials-secret-key"
          type="password"
          readOnly
          placeholder="not returned by any endpoint"
          aria-describedby="credentials-secret-key-note"
          onFocus={(e) => e.currentTarget.select()}
        />

        <p className="auth-status" id="credentials-secret-key-note">
          A working key pair is present in the database — the seeder adopts{' '}
          <code>S3_ACCESS_KEY</code>/<code>S3_SECRET_KEY</code> so existing aws-cli, rclone and
          Docker clients keep working — but no route or oRPC procedure reads it back out.
        </p>

        <p className="auth-status" id="credentials-access-key-note">
          Needed before this panel can be real, and all parts are required:
        </p>
        <ol className="auth-status">
          <li>
            Per-user (or per-organization) credentials, not the single seeded pair. One shared pair
            across tenants would let any account act as any other through the S3 surface, which is a
            worse failure than having no UI for it.
          </li>
          <li>
            An <strong>admin-only</strong> read endpoint (or oRPC procedure) that returns credential{' '}
            <em>metadata</em> — id, label, organization, created/last-used timestamps — and never
            the secret.
          </li>
          <li>
            A repository method to list by organization; <code>IS3CredentialRepository</code> today
            declares only <code>findByAccessKey</code> and <code>touchLastUsed</code>.
          </li>
          <li>
            A mint procedure (<code>createCredentials</code>) that shows the secret exactly once at
            creation, the way every S3 console does — retrievable only by re-minting.
          </li>
        </ol>
        <p className="auth-status">
          Adding a route that returns a secret is a new security surface and needs its own review
          before it ships.
        </p>

        <div className="buttons">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

function OrgDashboard(): React.JSX.Element {
  const params = Route.useParams();
  const buckets = Route.useLoaderData();
  const canWrite = useCanWrite();
  const isReadOnly = useIsReadOnly();
  const [showCredentials, setShowCredentials] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  // Only probed while the dialog is open, and only once per bucket set. Probing on mount
  // would spend a request on a field nobody is looking at.
  const bucketCount = buckets.length;
  const orgSlug = params.orgSlug;
  useEffect(() => {
    if (!showCredentials) return;
    let cancelled = false;
    void discoverServerOrigin(buckets, orgSlug).then((found) => {
      if (!cancelled) setEndpoint(found);
    });
    return () => {
      cancelled = true;
    };
    // `buckets` is a fresh array identity per render, so depending on it would re-probe on
    // every render. `bucketCount` is what actually means "the bucket set changed".
  }, [showCredentials, bucketCount, orgSlug]);

  return (
    <section className="dashboard" aria-labelledby="dashboard-heading">
      <h2 id="dashboard-heading">Dashboard</h2>

      {isReadOnly ? (
        <p className="auth-status">
          You are browsing read-only. <a href="/login">Sign in</a> to create buckets and upload.
        </p>
      ) : null}

      <div className="dashboard-controls">
        {canWrite ? (
          <button type="button" className="ghost" onClick={() => setShowCredentials(true)}>
            S3 credentials
          </button>
        ) : null}
      </div>

      <h3>Buckets</h3>

      {buckets.length === 0 ? <p className="auth-status">No buckets yet.</p> : null}

      {buckets.length > 0 ? (
        <ul className="bucket-list">
          {buckets.map((bucket) => (
            <li key={bucket.id}>
              <span>{bucket.name}</span>{' '}
              <span className="auth-status">
                {bucket.objectCount} {bucket.objectCount === 1 ? 'object' : 'objects'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {showCredentials ? (
        <CredentialsDialog endpoint={endpoint} onClose={() => setShowCredentials(false)} />
      ) : null}
    </section>
  );
}
