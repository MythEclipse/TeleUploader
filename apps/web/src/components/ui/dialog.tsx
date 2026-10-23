import { cn } from '../../lib/utils';

export interface DialogProps extends React.HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const Dialog = ({
  open,
  onOpenChange,
  className,
  children,
  ...props
}: DialogProps): React.JSX.Element | null => {
  if (!open) return null;
  return (
    <div className={cn('dialog-overlay', className)} {...props}>
      <div
        className="dialog-content"
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onOpenChange(false);
          else event.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
};

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  children: React.ReactNode;
}

export const DialogContent = ({
  title,
  children,
  className,
  ...props
}: DialogContentProps): React.JSX.Element => (
  <div className={cn('dialog-content-inner', className)} {...props}>
    <h3>{title}</h3>
    {children}
  </div>
);

export const DialogTrigger = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <>{children}</>
);

export const DialogClose = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <button type="button">{children}</button>
);
