import * as React from 'react';
import { cn } from './cn.js';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-brand-600',
        className,
      )}
    />
  );
}

/** Full-width loading placeholder used while a query resolves. */
export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-200 bg-white py-14 text-sm text-zinc-500">
      <Spinner />
      {label}
    </div>
  );
}

/** Standard error presentation for failed queries/mutations. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
      <p className="font-medium">Algo deu errado</p>
      <p className="mt-1 break-words text-xs leading-relaxed">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 text-xs font-medium underline hover:no-underline"
        >
          Tentar novamente
        </button>
      )}
    </div>
  );
}

/** Empty collection placeholder with optional call to action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-14 text-center">
      {icon && <div className="mb-1 text-zinc-300">{icon}</div>}
      <p className="text-sm font-medium text-zinc-700">{title}</p>
      {description && (
        <p className="max-w-md text-xs leading-relaxed text-zinc-500">
          {description}
        </p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Inline alert for contextual notices inside forms and cards. */
export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    danger: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  } as const;
  return (
    <div className={cn('rounded-lg border px-4 py-3 text-xs leading-relaxed', tones[tone])}>
      {title && <p className="mb-0.5 text-sm font-medium">{title}</p>}
      {children}
    </div>
  );
}
