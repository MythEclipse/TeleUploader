import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const badge = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium leading-5 whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-muted text-muted-foreground',
        primary: 'border-transparent bg-primary-soft text-primary',
        success: 'border-transparent bg-success-soft text-success',
        warning: 'border-transparent bg-warning-soft text-warning',
        danger: 'border-transparent bg-danger-soft text-danger',
        outline: 'border-border-strong bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export const Badge = ({ variant, className, ...props }: BadgeProps): React.JSX.Element => (
  <span className={cn(badge({ variant }), className)} {...props} />
);

export { badge as badgeVariants };
