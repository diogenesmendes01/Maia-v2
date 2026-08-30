'use client';

import * as React from 'react';
import { cn } from './cn.js';

const CONTROL =
  'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 ' +
  'placeholder:text-zinc-400 shadow-xs transition-colors ' +
  'focus:border-brand-500 focus:outline-hidden focus:ring-2 focus:ring-brand-500/20 ' +
  'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(CONTROL, className)} {...rest} />;
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL, 'leading-relaxed', className)}
      {...rest}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cn(CONTROL, 'pr-8', className)} {...rest} />;
});

/**
 * Label + control + hint/error wrapper. Keeps every form on the console with
 * the same vertical rhythm and error presentation.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 flex items-baseline gap-1 text-xs font-medium text-zinc-700">
        {label}
        {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs leading-relaxed text-zinc-500">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
