'use client';

import * as React from 'react';
import { Input } from './field.js';
import { cn } from './cn.js';

/**
 * Editor for short string collections (priorities, principles, slugs…).
 * Replaces the old "one per line" textarea with an explicit add/remove list:
 * the operator sees each item as a discrete, removable entry — no silent
 * whitespace mistakes, no guessing the separator.
 */
export function ListEditor({
  items,
  onChange,
  placeholder,
  addLabel = 'Adicionar',
  maxItems = 20,
  tone = 'neutral',
  disabled,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  maxItems?: number;
  tone?: 'neutral' | 'danger';
  disabled?: boolean;
}) {
  const [draft, setDraft] = React.useState('');

  const add = () => {
    const value = draft.trim();
    if (!value || items.length >= maxItems) return;
    if (items.some((i) => i.trim().toLowerCase() === value.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...items, value]);
    setDraft('');
  };

  const remove = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((item, idx) => (
            <li
              key={`${item}-${idx}`}
              className={cn(
                'group flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm',
                tone === 'danger'
                  ? 'border-red-100 bg-red-50/60 text-red-900'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-800',
              )}
            >
              <span className="min-w-0 break-words">{item}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  aria-label={`Remover "${item}"`}
                  className="shrink-0 rounded-sm p-0.5 text-zinc-400 opacity-60 transition-opacity hover:bg-white hover:text-red-600 group-hover:opacity-100"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && items.length < maxItems && (
        <div className="flex gap-2">
          <Input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            onClick={add}
            disabled={draft.trim().length === 0}
            className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 shadow-xs transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            {addLabel}
          </button>
        </div>
      )}
    </div>
  );
}
