'use client';

/**
 * Admin UI — Tools Catalog screen (read-only).
 *
 * Surfaces every tool the LLM can call: description, side-effect, whether it's
 * currently enabled (and which feature flag gates it when off), whether it's
 * `sensitive` (view-once outputs like balances), and its input fields. Answers
 * the operator question "what can Maia do, and how?".
 *
 * Server-only boundary (spec §1.2): this page imports NOTHING from
 * `@/tools/*`. It consumes the serialized JSON from
 * `trpc.toolsCatalog.listCatalog` only — the tool handlers (and their DB / LLM
 * imports) stay on the server. Do not add a direct registry import here.
 */

import * as React from 'react';
import { trpc } from '../../trpc/client.js';

type SideEffect = 'read' | 'write' | 'communication' | 'none';

// Read-heavy at the top (spec §1.4): read → write → communication → none.
const SIDE_EFFECT_ORDER: SideEffect[] = ['read', 'write', 'communication', 'none'];

const SIDE_EFFECT_LABEL: Record<SideEffect, string> = {
  read: 'Read',
  write: 'Write',
  communication: 'Communication',
  none: 'No side effect',
};

type CatalogTool = {
  name: string;
  description: string;
  side_effect: string;
  operation_type: string;
  sensitive: boolean;
  feature_flag: string | null;
  required_actions: string[];
  enabled: boolean;
  inputs: Array<{ name: string; type: string; optional: boolean }>;
};

export default function ToolsCatalogPage() {
  const q = trpc.toolsCatalog.listCatalog.useQuery();

  const [search, setSearch] = React.useState('');
  const [sideEffectFilter, setSideEffectFilter] = React.useState<'all' | SideEffect>('all');
  const [enabledOnly, setEnabledOnly] = React.useState(false);
  const [sensitiveOnly, setSensitiveOnly] = React.useState(false);

  const tools = (q.data ?? []) as CatalogTool[];

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tools.filter((t) => {
      if (enabledOnly && !t.enabled) return false;
      if (sensitiveOnly && !t.sensitive) return false;
      if (sideEffectFilter !== 'all' && t.side_effect !== sideEffectFilter) return false;
      if (needle !== '') {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [tools, search, sideEffectFilter, enabledOnly, sensitiveOnly]);

  // Group the filtered tools by side_effect, preserving the read-heavy order.
  const groups = React.useMemo(() => {
    const byEffect = new Map<string, CatalogTool[]>();
    for (const t of filtered) {
      const list = byEffect.get(t.side_effect) ?? [];
      list.push(t);
      byEffect.set(t.side_effect, list);
    }
    const ordered: Array<{ key: string; label: string; items: CatalogTool[] }> = [];
    for (const key of SIDE_EFFECT_ORDER) {
      const items = byEffect.get(key);
      if (items && items.length > 0) {
        ordered.push({ key, label: SIDE_EFFECT_LABEL[key], items });
        byEffect.delete(key);
      }
    }
    // Any side_effect value not in the known set (defensive) gets appended.
    for (const [key, items] of byEffect.entries()) {
      ordered.push({ key, label: key, items });
    }
    return ordered;
  }, [filtered]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Tools</h1>
        <p className="text-sm text-gray-600">
          Read-only catalog of every tool the agent can call. Tools are defined
          in code and are global (not tenant-scoped). A tool gated by a disabled
          feature flag is shown as <span className="font-medium">disabled</span>{' '}
          with the flag that turns it on.
        </p>
      </header>

      {q.isLoading ? (
        <p>Loading tools...</p>
      ) : q.error ? (
        <p className="text-red-600">Error: {q.error.message}</p>
      ) : tools.length === 0 ? (
        <p className="text-gray-500 text-sm">No tools registered.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or description…"
              aria-label="Search tools"
              className="border rounded p-2 w-64"
            />
            <label className="flex items-center gap-1">
              <span className="font-medium">Side effect:</span>
              <select
                value={sideEffectFilter}
                onChange={(e) =>
                  setSideEffectFilter(e.target.value as 'all' | SideEffect)
                }
                className="border rounded p-1"
              >
                <option value="all">All</option>
                {SIDE_EFFECT_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {SIDE_EFFECT_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={enabledOnly}
                onChange={(e) => setEnabledOnly(e.target.checked)}
              />
              Enabled only
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={sensitiveOnly}
                onChange={(e) => setSensitiveOnly(e.target.checked)}
              />
              Sensitive only
            </label>
            <span className="text-gray-500">
              {filtered.length} of {tools.length} tool(s)
            </span>
          </div>

          {filtered.length === 0 ? (
            <p className="text-gray-500 text-sm">No tools match the filters.</p>
          ) : (
            <div className="space-y-8">
              {groups.map((group) => (
                <section key={group.key} className="space-y-3">
                  <h2 className="text-lg font-semibold border-b pb-1">
                    {group.label}{' '}
                    <span className="text-sm font-normal text-gray-500">
                      ({group.items.length})
                    </span>
                  </h2>
                  <div className="space-y-3">
                    {group.items.map((t) => (
                      <ToolCard key={t.name} tool={t} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Badge({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function ToolCard({ tool }: { tool: CatalogTool }) {
  return (
    <div className="border rounded p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-semibold text-sm">{tool.name}</code>
        <Badge
          label={tool.side_effect}
          className="bg-gray-100 text-gray-700"
        />
        {tool.enabled ? (
          <Badge label="enabled" className="bg-green-100 text-green-800" />
        ) : (
          <Badge
            label={
              tool.feature_flag
                ? `disabled — ${tool.feature_flag}`
                : 'disabled'
            }
            className="bg-gray-200 text-gray-600"
          />
        )}
        {tool.sensitive && (
          <Badge label="sensitive" className="bg-amber-100 text-amber-800" />
        )}
      </div>

      <p className="text-sm text-gray-700">{tool.description}</p>

      <details className="text-sm">
        <summary className="cursor-pointer text-gray-600">
          Inputs ({tool.inputs.length})
        </summary>
        {tool.inputs.length === 0 ? (
          <p className="mt-2 pl-4 text-xs text-gray-500">No input fields.</p>
        ) : (
          <ul className="mt-2 pl-4 border-l-2 border-gray-200 space-y-1">
            {tool.inputs.map((field) => (
              <li key={field.name} className="text-xs">
                <code className="font-medium">{field.name}</code>{' '}
                <span className="text-gray-500">· {field.type}</span>
                {field.optional ? (
                  <span className="text-gray-400"> · optional</span>
                ) : (
                  <span className="text-gray-600"> · required</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
