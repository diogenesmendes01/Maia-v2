import * as React from 'react';
import { cn } from './cn.js';

/**
 * Styled table primitives. Always wrap in <TableShell> so wide tables scroll
 * horizontally inside the card instead of breaking the page layout.
 */
export function TableShell({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'scroll-thin overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-card',
        className,
      )}
      {...rest}
    />
  );
}

export function Table({
  className,
  ...rest
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cn('w-full border-collapse text-sm', className)} {...rest} />
  );
}

export function THead({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <thead>
      <tr className="border-b border-zinc-200 bg-zinc-50/80 text-left">
        {children}
      </tr>
    </thead>
  );
}

export function Th({
  className,
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-2xs font-semibold uppercase tracking-wide text-zinc-500',
        className,
      )}
      {...rest}
    />
  );
}

export function Tr({
  className,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-zinc-100 last:border-0 hover:bg-zinc-50/70',
        className,
      )}
      {...rest}
    />
  );
}

export function Td({
  className,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 align-middle', className)} {...rest} />;
}
