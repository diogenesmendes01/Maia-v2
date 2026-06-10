'use client';

import * as React from 'react';
import { cn } from './cn.js';

export interface TabDef {
  id: string;
  label: React.ReactNode;
  badge?: React.ReactNode;
}

/**
 * Horizontal tab strip (controlled). Used for in-page section switching —
 * e.g. the agent detail screen.
 */
export function Tabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'scroll-thin flex gap-1 overflow-x-auto border-b border-zinc-200',
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800',
            )}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}
