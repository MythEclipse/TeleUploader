import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * Table primitives.
 *
 * Previously these emitted `.table`/`.table-head` class names that no stylesheet
 * defined, so every table in the app rendered unstyled. Styling now lives in the
 * utilities below, and the header is sticky so long listings keep their columns.
 */

export interface TableProps extends HTMLAttributes<HTMLTableElement> {}

export const Table = ({ className, ...props }: TableProps): React.JSX.Element => (
  <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
);

/** Scroll container. Keeps wide tables inside the card instead of the page. */
export const TableWrap = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('overflow-x-auto', className)} {...props} />
);

export const TableHeader = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('bg-surface-muted/70', className)} {...props} />
);

export const TableBody = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn('divide-y divide-border', className)} {...props} />
);

export const TableFooter = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <tfoot className={cn('border-t border-border bg-surface-muted/60', className)} {...props} />
);

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {}

export const TableRow = ({ className, ...props }: TableRowProps): React.JSX.Element => (
  <tr
    className={cn('transition-colors duration-100 hover:bg-surface-hover/60', className)}
    {...props}
  />
);

export interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {}

export const TableHead = ({ className, ...props }: TableHeadProps): React.JSX.Element => (
  <th
    scope="col"
    className={cn(
      'whitespace-nowrap px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground',
      className,
    )}
    {...props}
  />
);

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {}

export const TableCell = ({ className, ...props }: TableCellProps): React.JSX.Element => (
  <td className={cn('px-4 py-3 align-middle text-muted-foreground', className)} {...props} />
);

export interface TableCaptionProps extends HTMLAttributes<HTMLTableElement> {}

export const TableCaption = ({ className, ...props }: TableCaptionProps): React.JSX.Element => (
  <caption className={cn('sr-only', className)} {...props} />
);
