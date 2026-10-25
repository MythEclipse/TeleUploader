/**
 * 404 body, shared by the routes whose loaders return `null` for a missing
 * bucket/org rather than throwing.
 */

import { ArrowLeft, FileQuestion } from 'lucide-react';
import { AppLink } from './AppLink';

const NotFound = ({
  title = 'Not found',
  detail,
}: {
  title?: string;
  detail?: string;
}): React.JSX.Element => (
  <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
    <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-border bg-surface-muted text-subtle-foreground">
      <FileQuestion className="size-5" aria-hidden="true" />
    </div>
    <h2 className="text-base font-semibold text-foreground">{title}</h2>
    {detail ? (
      <p className="mt-1.5 max-w-sm text-[0.8125rem] leading-relaxed text-muted-foreground">
        {detail}
      </p>
    ) : null}
    <AppLink
      to="/"
      className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-surface-hover"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to files
    </AppLink>
  </div>
);

export default NotFound;
