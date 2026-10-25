import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Modal dialog, backed by Radix.
 *
 * Radix supplies what the hand-rolled version was missing: a focus trap, focus
 * restore on close, `Escape` handling, `aria-modal` wiring, and body scroll
 * lock. The visible surface is ours.
 */

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}

export const Dialog = ({ open, onOpenChange, children }: DialogProps): React.JSX.Element => (
  <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    {children}
  </DialogPrimitive.Root>
);

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps {
  readonly title: string;
  /** Announced under the title. Optional; omit when the body speaks for itself. */
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
  /** Extra controls rendered in the footer, right-aligned. */
  readonly footer?: ReactNode;
}

export const DialogContent = ({
  title,
  description,
  children,
  className,
  footer,
}: DialogContentProps): React.JSX.Element => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-100 bg-black/55 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
    <DialogPrimitive.Content
      className={cn(
        'fixed left-1/2 top-1/2 z-100 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-overlay',
        'data-[state=closed]:animate-zoom-out data-[state=open]:animate-zoom-in',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <DialogPrimitive.Title className="text-[0.9375rem] font-semibold text-foreground">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-0.5 text-[0.8125rem] text-muted-foreground">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
        <DialogPrimitive.Close
          className="-mr-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          aria-label="Close dialog"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </div>

      <div className="max-h-[65vh] overflow-y-auto px-5 py-4 text-sm text-muted-foreground">
        {children}
      </div>

      {footer ? (
        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-muted/60 px-5 py-3">
          {footer}
        </div>
      ) : null}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
);
