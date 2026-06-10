import * as React from 'react';
import { cn } from './cn.js';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const ACCENT: Record<Tone, string> = {
  neutral: 'bg-zinc-400',
  brand: 'bg-brand-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
};

/** KPI card used on the dashboard and overview tabs. */
export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const inner = (
    <div className="relative overflow-hidden rounded-xl border border-zinc-200 bg-white px-5 py-4 shadow-card transition-shadow hover:shadow-md">
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 w-1', ACCENT[tone])}
      />
      <p className="text-2xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-zinc-900">
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
  return href ? <a href={href}>{inner}</a> : inner;
}
