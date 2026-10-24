import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {}

export const Card = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div
    className={cn('bg-slate-800 border border-slate-700 rounded-lg overflow-hidden', className)}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('p-4 border-b border-slate-700 bg-slate-900/50', className)} {...props} />
);

export const CardTitle = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('text-lg font-semibold text-slate-200', className)} {...props} />
);

export const CardDescription = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('text-sm text-slate-400', className)} {...props} />
);

export const CardContent = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('p-4', className)} {...props} />
);

export const CardFooter = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div
    className={cn(
      'p-4 border-t border-slate-700 bg-slate-900/50 flex justify-end gap-2',
      className,
    )}
    {...props}
  />
);
