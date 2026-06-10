import * as React from 'react';
import { cn } from './cn.js';

/** Wizard progress indicator: numbered steps with labels. */
export function Stepper({
  steps,
  current,
}: {
  steps: string[];
  current: number; // 0-based
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {steps.map((label, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <li key={label} className="flex items-center gap-2">
            {idx > 0 && <span aria-hidden className="h-px w-6 bg-zinc-200" />}
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full text-2xs font-semibold',
                done && 'bg-brand-600 text-white',
                active && 'bg-brand-50 text-brand-700 ring-2 ring-brand-500',
                !done && !active && 'bg-zinc-100 text-zinc-500',
              )}
            >
              {done ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                idx + 1
              )}
            </span>
            <span
              className={cn(
                'text-xs font-medium',
                active ? 'text-zinc-900' : 'text-zinc-500',
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
