import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'ghost' | 'danger';
  size?: 'default' | 'sm';
}

export const Button = ({
  variant = 'default',
  size = 'default',
  className,
  type = 'button',
  ...props
}: ButtonProps): React.JSX.Element => {
  const variantClass =
    variant === 'default'
      ? 'btn-primary'
      : variant === 'secondary'
        ? 'btn-secondary'
        : variant === 'danger'
          ? 'btn-primary danger'
          : 'btn-ghost';
  const sizeClass = size === 'sm' ? 'btn-sm' : '';
  return (
    <button
      type={type}
      className={`${variantClass} ${sizeClass} ${className ?? ''}`.trim()}
      {...props}
    />
  );
};

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = ({ className, ...props }: InputProps): React.JSX.Element => (
  <input className={cn('input', className)} {...props} />
);

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = ({ className, ...props }: TextareaProps): React.JSX.Element => (
  <textarea className={cn('input', className)} {...props} />
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary';
}

export const Badge = ({
  variant = 'default',
  className,
  ...props
}: BadgeProps): React.JSX.Element => (
  <span
    className={cn('badge', variant === 'secondary' && 'badge-secondary', className)}
    {...props}
  />
);

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
}

export const Separator = ({
  orientation = 'horizontal',
  className,
  ...props
}: SeparatorProps): React.JSX.Element => (
  <div
    className={cn(
      'separator',
      orientation === 'vertical' ? 'separator-vertical' : 'separator-horizontal',
      className,
    )}
    {...props}
  />
);
