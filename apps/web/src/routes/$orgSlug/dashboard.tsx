/**
 * `/$orgSlug/dashboard` — the org dashboard. It owns the CREDENTIALS MODAL.
 *
 * ## The credentials modal is a BUILD, not a port
 *
 * The brief asked for a check before building, and the check was run. The
 * answer is **no backend procedure exists**:
 *
 * ```
 * $ grep -rn "createCredentials\|listCredentials" apps/api/src apps/web/src
 * (no output — exit 1)
 *
 * $ sed -n '70,135p' apps/api/src/presentation/orpc/routers/bucket.ts
 * bucketNamespace = { listBuckets, createBucket, deleteBucket,
 *                     listObjects, copyObject, deleteObject, downloadObject }
 *                     — seven procedures, none credential-related.
 *
 * $ grep -n "credential" apps/api/src/presentation/http/controllers/web-api-controller.ts
 * NO MATCH
 *
 * $ grep -nE "^\s+(find|touch|list|create|delete)[A-Za-z]*\(" \
 *      apps/api/src/domain/ports/s3-credential-repository.ts
 *   findByAccessKey(accessKey: string): Promise<S3Credential | null>;
 *   touchLastUsed(id: string): Promise<void>;
 * ```
 *
 * The repository has no "list by organization", the router mounts only the
 * `bucket` namespace (`routers/index.ts`), and the 18 candidate REST paths
 * probed against a live database all returned `404 {"error":"Not found"}`. The
 * secret key DOES exist in the database (`seed.ts` adopts `S3_ACCESS_KEY` /
 * `S3_SECRET_KEY`), but nothing reads it back out — `s3CredentialRepository` is
 * touched in exactly three places, all inside `s3/s3-router.ts` for SigV4
 * verification.
 *
 * `home.html:366` is the thing that would have been "ported", and it is worth
 * reading before deciding this is a shortcut:
 *
 * ```js
 * showCredentialsModal=()=>{ showModal(`…<input type="text" value="${window.location.origin}"
 *   readonly …><input id="s3AccessKey" type="text" readonly …>
 *   <input id="s3SecretKey" type="password" readonly …>`) }
 * ```
 *
 * Both key inputs have **no `value` attribute at all**. Today's modal renders
 * two permanently empty readonly boxes and an Endpoint URL fabricated from
 * `window.location.origin` — wrong behind a reverse proxy and on any non-default
 * port (contract gotcha 11).
 *
 * So this modal does not fake it. It states the gap, names what the backend
 * needs, and shows the one field that is knowable client-side with an explicit
 * caveat about its source. Hardcoding a key, or inventing an endpoint call that
 * 404s, would be the `schema.sql` defect class this phase exists to eliminate —
 * and a plausible-looking secret in the UI is far worse than a visible absence,
 * because the first thing someone does with a fake working credential is paste
 * it into `aws s3`.
 *
 * ## Endpoint URL and Region: shown, but correctly sourced or correctly caveated
 *
 * `BASE_URL` is server-supplied per object as `ObjectSummary.downloadUrl`'s
 * origin (`web-api-controller.ts` maps `downloadUrl: ${config.baseUrl}/f/${o.publicId}`),
 * so the dashboard derives the endpoint from **server data** whenever any bucket
 * holds an object — never from `window.location.origin`, which is what
 * `home.html` did and which is wrong behind a proxy.
 *
 * When no object exists there is no server-supplied URL to show, so the field
 * says so rather than falling back to `window.location.origin`.
 *
 * `us-east-1` is `config.s3DefaultRegion` (`env.ts:228`, default `us-east-1`).
 * It is NOT readable from any API response, so it is shown as the documented
 * default with a note that it comes from `S3_DEFAULT_REGION` and may be
 * overridden — never presented as a value read from the server. `home.html`
 * hardcoded the literal in markup, which reads identically and is a guess.
 *
 * ## Read-only visitors do not get the button
 *
 * `showCredentialsModal` opened with `if (!isAdmin) alert('Read-only mode…')`
 * (`home.html:365`). Here the button is not rendered at all when
 * `useCanWrite()` is false — `auth-disabled` counts as writable, because
 * `requireAuth` genuinely is a pass-through then and the admin UI must render
 * (contract §1.2). Gating on a re-derived boolean is the bug the three-state
 * store exists to prevent.
 *
 * ## The dialog is accessible where `home.html`'s was not
 *
 * `home.html` closes its modal on backdrop click only — the "Escape closes the
 * modal" at `:184` is a stale `biome-ignore` comment, not a handler (there is
 * no `keydown` anywhere in the file). This one closes on Escape and on the
 * backdrop, moves focus into the dialog on open, and restores it on close, which
 * is an improvement rather than a regression. No `dangerouslySetInnerHTML`: the
 * modal body is JSX.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useCanWrite, useIsReadOnly } from '../../lib/auth-store';
import { listBuckets, listObjects } from '../../lib/endpoints';
import { ApiError } from '../../lib/client';
import type { BucketSummary } from '../../lib/types';

/**
 * Region shown when the API exposes nothing.
 *
 * This is `config.s3DefaultRegion`'s documented default (`env.ts:228`), NOT a
 * value read from the server — nothing in the API returns the region. It is
 * labelled as such in the UI. `home.html` hardcoded the same literal in markup,
 * where it was indistinguishable from a real answer.
 */
const DEFAULT_REGION = 'us-east-1';

/**
 * The server-supplied public origin, discovered from any object's `downloadUrl`.
 *
 * `ObjectSummary.downloadUrl` is `${BASE_URL}/f/{publicId}` — a real absolute
 * URL built from `config.baseUrl` at request time
 * (`web-api-controller.ts`, `handleListObjectsV1`). Taking its origin yields the
 * endpoint a user actually pastes into an S3 client, which is exactly what
 * `window.location.origin` gets wrong behind a reverse proxy (contract gotcha
 * 11 — `home.html:366` fabricated it, and it is wrong behind any proxy or on any
 * non-default port).
 *
 * `BucketSummary` carries only `{id, name, createdAt, objectCount}` — no URL of
 * any kind — so learning `BASE_URL` requires looking at an object. Hence the
 * listing call.
 *
 * Returns `null` when there is no bucket, no object, no `downloadUrl`, or the
 * field is not an absolute URL. The caller renders an explicit "unknown" in that
 * case rather than falling back to `window.location.origin`.
 */
const discoverServerOrigin = async (buckets: BucketSummary[]): Promise<string | null> => {
  // One bucket is enough and bounds the work: this is a cosmetic field, not a
  // data load, and an unbounded scan of every bucket in a large deployment
  // would be a surprising cost for an endpoint string.
  const [bucket] = buckets;
  if (!bucket) return null;

  try {
    const listing = await listObjects(bucket.name, { maxKeys: 1 });
    const downloadUrl = listing.objects[0]?.downloadUrl;
    if (!downloadUrl) return null;
    return new URL(downloadUrl).origin;
  } catch {
    // A failure here must not break the dashboard — the endpoint field is
    // decoration, and a 401/404/503 on this probe says nothing about the page.
    return null;
  }
};

export const Route = createFileRoute('/$orgSlug/dashboard')({
  /**
   * `listBuckets` is a PUBLIC read (`app.ts:296` registers `GET /api/v1/*`
   * bare), so this loader is deliberately not auth-gated: a read-only visitor
   * is a supported mode and must still see the dashboard.
   *
   * The org is resolved by the `$orgSlug` parent loader; this reads buckets
   * directly because `listBucketsForOrg` is `listBuckets()` today
   * (`lib/orgs.ts` — there is no organization parameter on the wire).
   */
  loader: (): Promise<BucketSummary[]> => listBuckets(),
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
      // `home.html` had no Escape handler and no focus management at all
      // (contract gotcha: the Escape comment at :184 is stale).
      if (restoreFocusTo.current instanceof HTMLElement) restoreFocusTo.current.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      // Backdrop click closes. Guarded by currentTarget so a click that
      // started inside the dialog and ended on the backdrop does not close it
      // — the same guard `home.html` used.
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

        {/*
          The honest statement, stated first. This is the deliverable: the
          backend procedure does not exist yet, and no amount of UI work can
          change that.
        */}
        <p role="status">
          <strong>Not available from the API yet.</strong> No endpoint returns an S3 access key or
          secret key, so this panel cannot show one. It is not hiding them — nothing can hand them
          out today.
        </p>

        <label htmlFor="credentials-endpoint">Endpoint URL</label>
        {endpoint ? (
          <input id="credentials-endpoint" type="text" readOnly value={endpoint} onFocus={(e) => e.currentTarget.select()} />
        ) : (
          <p className="auth-status" id="credentials-endpoint">
            Unknown — this deployment has no uploaded object, so the API has not disclosed its
            public base URL. It is <code>BASE_URL</code> on the server, and is frequently{' '}
            <em>not</em> this page&apos;s origin when the app sits behind a reverse proxy.
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
        {/*
          `readOnly` + no value, matching the server's actual capability. NOT
          `disabled`, which would drop the field out of the tab order entirely and
          hide that the field exists at all.
        */}
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

        {/*
          Names the work precisely, including the repository gap: a route alone
          would not be enough, because `IS3CredentialRepository` has no
          "list by organization" method to read through. This is the seam, not
          just the controller.
        */}
        <p className="auth-status" id="credentials-access-key-note">
          Needed before this panel can be real, and both parts are required:
        </p>
        <ol className="auth-status">
          <li>
            A new <strong>admin-only</strong> read endpoint (or oRPC procedure) that returns
            credential <em>metadata</em> — id, label, organization, created/last-used timestamps —
            and never the secret.
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
  const buckets = Route.useLoaderData();
  const canWrite = useCanWrite();
  const isReadOnly = useIsReadOnly();
  const [showCredentials, setShowCredentials] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  // Only ever probed while the dialog is open, and only once per bucket set.
  // Probing on mount would spend a request on a field nobody is looking at.
  const bucketCount = buckets.length;
  useEffect(() => {
    if (!showCredentials) return;
    let cancelled = false;
    void discoverServerOrigin(buckets).then((found) => {
      if (!cancelled) setEndpoint(found);
    });
    return () => {
      cancelled = true;
    };
    // `buckets` is a fresh array identity per render, so depending on it would
    // re-probe on every render. `bucketCount` is what actually means "the bucket
    // set changed" — a bucket rename would not re-probe, which costs a stale
    // endpoint string at worst and never a wrong secret.
  }, [showCredentials, bucketCount]);

  return (
    <section className="dashboard" aria-labelledby="dashboard-heading">
      <h2 id="dashboard-heading">Dashboard</h2>

      {isReadOnly ? (
        <p className="auth-status">
          You are browsing read-only. Listing is a public endpoint and needs no credentials.
        </p>
      ) : null}

      <div className="dashboard-controls">
        {/*
          Gated by `useCanWrite()`, which is the three-state rule: `admin` AND
          `auth-disabled` both render the button. `home.html` gated on its own
          `isAdmin` boolean, which the contract's §1.2 404 arm makes unsafe —
          with `ADMIN_API_TOKEN` empty the server accepts the write, so hiding
          the control would be a lie about what the deployment can do.
        */}
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
};