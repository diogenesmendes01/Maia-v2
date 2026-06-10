import * as React from 'react';
import { cn } from './cn.js';

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 ring-zinc-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
};

export function Badge({
  tone = 'neutral',
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset',
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}

/**
 * Canonical tone mapping for the lifecycle statuses that recur across the
 * platform (profile versions, proposals, skills, agents, drift…). One place
 * to keep status colors consistent on every screen.
 */
const STATUS_TONE: Record<string, BadgeTone> = {
  // generic lifecycle
  active: 'success',
  proposed: 'warning',
  pending: 'warning',
  pending_review: 'warning',
  approved: 'success',
  rejected: 'danger',
  frozen: 'info',
  rolled_back: 'neutral',
  deprecated: 'neutral',
  suspended: 'danger',
  draft: 'neutral',
  // drift severities
  baixo: 'info',
  medio: 'warning',
  alto: 'danger',
  critico: 'danger',
  low: 'info',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
  // misc
  open: 'warning',
  resolved: 'success',
  failed: 'danger',
  ok: 'success',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status}</Badge>;
}
