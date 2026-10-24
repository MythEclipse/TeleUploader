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
      ? 'bg-blue-600 text-white hover:bg-blue-700'
      : variant === 'secondary'
        ? 'bg-slate-700 text-white hover:bg-slate-600'
        : variant === 'danger'
          ? 'bg-red-600 text-white hover:bg-red-700'
          : 'bg-transparent text-slate-300 border border-slate-600 hover:bg-slate-700 hover:text-slate-200';
  const sizeClass = size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-4 py-2 text-sm';
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition',
        variantClass,
        sizeClass,
        className,
      )}
      {...props}
    />
  );
};

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = ({ className, ...props }: InputProps): React.JSX.Element => (
  <input
    className={cn(
      'px-3 py-1.5 bg-slate-800 border border-slate-600 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500',
      className,
    )}
    {...props}
  />
);

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = ({ className, ...props }: TextareaProps): React.JSX.Element => (
  <textarea
    className={cn(
      'px-3 py-1.5 bg-slate-800 border border-slate-600 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500',
      className,
    )}
    {...props}
  />
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
    className={cn(
      'inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium',
      variant === 'default'
        ? 'bg-slate-800 text-slate-300 border border-slate-600'
        : 'bg-slate-700 text-slate-200 border border-slate-500',
      className,
    )}
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
      orientation === 'vertical'
        ? 'h-full w-px bg-slate-700 mx-1'
        : 'w-full h-px bg-slate-700 my-1',
      className,
    )}
    {...props}
  />
);
