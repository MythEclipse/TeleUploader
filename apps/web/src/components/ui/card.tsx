import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {}

export const Card = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('card', className)} {...props} />
);

export const CardHeader = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('card-header', className)} {...props} />
);

export const CardTitle = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('card-title', className)} {...props} />
);

export const CardDescription = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('card-description', className)} {...props} />
);

export const CardContent = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('card-content', className)} {...props} />
);

export const CardFooter = ({ className, ...props }: CardProps): React.JSX.Element => (
  <div className={cn('card-footer', className)} {...props} />
);
