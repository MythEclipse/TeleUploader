import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export interface TableProps extends HTMLAttributes<HTMLTableElement> {}

export const Table = ({ className, ...props }: TableProps): React.JSX.Element => (
  <table className={cn('table', className)} {...props} />
);

export const TableHeader = ({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element => (
  <thead className={cn('table-header', className)} {...props} />
);

export const TableBody = ({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element => (
  <tbody className={cn('table-body', className)} {...props} />
);

export const TableFooter = ({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element => (
  <tfoot className={cn('table-footer', className)} {...props} />
);

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {}

export const TableRow = ({ className, ...props }: TableRowProps): React.JSX.Element => (
  <tr className={cn('table-row', className)} {...props} />
);

export interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {}

export const TableHead = ({ className, ...props }: TableHeadProps): React.JSX.Element => (
  <th className={cn('table-head', className)} {...props} />
);

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {}

export const TableCell = ({ className, ...props }: TableCellProps): React.JSX.Element => (
  <td className={cn('table-cell', className)} {...props} />
);

export interface TableCaptionProps extends HTMLAttributes<HTMLTableElement> {}

export const TableCaption = ({ className, ...props }: TableCaptionProps): React.JSX.Element => (
  <caption className={cn('table-caption', className)} {...props} />
);
