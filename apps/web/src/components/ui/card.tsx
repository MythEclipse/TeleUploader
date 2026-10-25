import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const card = cva('rounded-xl border bg-surface', {
  variants: {
    variant: {
      default: 'border-border shadow-card',
      raised: 'border-border shadow-raised',
      flat: 'border-border',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface CardProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof card> {}

export const Card = ({ variant, className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn(card({ variant }), className)} {...props} />
);

export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4',
      className,
    )}
    {...props}
  />
);

export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn('text-[0.9375rem] font-semibold text-foreground', className)} {...props} />
);

export const CardDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('mt-0.5 text-[0.8125rem] text-muted-foreground', className)} {...props} />
);

export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 py-4', className)} {...props} />
);

export const CardFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex items-center justify-end gap-2 border-t border-border bg-surface-muted/60 px-5 py-3',
      className,
    )}
    {...props}
  />
);
