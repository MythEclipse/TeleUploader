import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const field =
  'w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground placeholder:text-subtle-foreground transition-[border-color,box-shadow] duration-150 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = ({ className, ...props }: InputProps): React.JSX.Element => (
  <input className={cn(field, 'h-9', className)} {...props} />
);

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = ({ className, ...props }: TextareaProps): React.JSX.Element => (
  <textarea className={cn(field, 'min-h-20 py-2', className)} {...props} />
);

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  /** Rendered under the control, in the danger colour. Takes precedence over `hint`. */
  readonly error?: string | null;
  readonly htmlFor?: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}

/**
 * Label + control + hint, with the label wired to the control by `htmlFor`.
 *
 * The hint is deliberately not `aria-describedby`: callers pass their own
 * `id`s on the control, and a mismatched reference is worse than none. A real
 * error is surfaced by the caller on the control itself.
 */
export const Field = ({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: FieldProps): React.JSX.Element => (
  <div className={cn('flex flex-col gap-1.5', className)}>
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
      {label}
    </label>
    {children}
    {error ? (
      <p className="text-xs text-danger">{error}</p>
    ) : hint ? (
      <p className="text-xs text-subtle-foreground">{hint}</p>
    ) : null}
  </div>
);
