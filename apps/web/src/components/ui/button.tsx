import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Button surface. `primary` is the one affirmative action on a page; everything
 * else is `secondary` (bordered) or `ghost` (no chrome until hover).
 *
 * Colours come from semantic tokens, so both themes are correct by construction.
 */
const button = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-card hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring',
        secondary:
          'border border-border-strong bg-surface text-foreground shadow-card hover:bg-surface-hover',
        ghost: 'bg-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground',
        danger:
          'bg-danger text-danger-foreground shadow-card hover:bg-danger-hover focus-visible:ring-2 focus-visible:ring-danger/40',
        dangerGhost:
          'bg-transparent text-danger hover:bg-danger-soft focus-visible:ring-2 focus-visible:ring-danger/40',
        link: 'h-auto bg-transparent p-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-2.5 text-[0.8125rem] [&_svg]:size-3.5',
        md: 'h-9 px-3.5 text-sm [&_svg]:size-4',
        lg: 'h-11 px-5 text-[0.9375rem] [&_svg]:size-4',
        icon: 'size-9 [&_svg]:size-4',
        iconSm: 'size-8 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /**
   * Rendered before the label.
   *
   * Decorative: an icon-only button needs an `aria-label`, because the glyph
   * carries no accessible name of its own.
   */
  readonly icon?: ReactNode;
}

export const Button = ({
  variant,
  size,
  icon,
  className,
  type = 'button',
  children,
  ...props
}: ButtonProps): React.JSX.Element => (
  <button type={type} className={cn(button({ variant, size }), className)} {...props}>
    {icon}
    {children}
  </button>
);

export { button as buttonVariants };
