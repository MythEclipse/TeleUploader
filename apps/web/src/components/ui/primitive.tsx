import { cn } from '../../lib/utils';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0–100. Clamped; out-of-range input is treated as the nearest bound. */
  readonly value?: number;
  readonly tone?: 'primary' | 'success' | 'danger';
}

const toneClass = {
  primary: 'bg-primary',
  success: 'bg-success',
  danger: 'bg-danger',
} as const;

/**
 * Determinate progress bar.
 *
 * Exposes `role="progressbar"` with its value so the bar is announced; the
 * previous version styled a bare div, which assistive tech skipped entirely.
 */
export const Progress = ({
  value,
  tone = 'primary',
  className,
  ...props
}: ProgressProps): React.JSX.Element => {
  const clamped = Math.min(100, Math.max(0, value ?? 0));

  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-hover', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300 ease-out',
          toneClass[tone],
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
};
