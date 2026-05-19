'use client';

import * as React from 'react';
import type { ProposalRow } from '../../../trpc/types.js';

interface Filters {
  types?: ProposalRow['type'][];
  risks?: ProposalRow['risk'][];
  sources?: string[];
}

interface Props {
  filters: Filters;
  onFilterChange: (f: Filters) => void;
}

const ALL_TYPES: ProposalRow['type'][] = [
  'policy_rule',
  'soul_bias',
  'skill',
  'capability_proposal',
  'knowledge_proposal',
];
const ALL_RISKS: ProposalRow['risk'][] = ['low', 'medium', 'high', 'critical'];

export default function InboxFilters({ filters, onFilterChange }: Props) {
  const toggleType = (t: ProposalRow['type']) => {
    const cur = filters.types ?? [];
    onFilterChange({
      ...filters,
      types: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    });
  };
  const toggleRisk = (r: ProposalRow['risk']) => {
    const cur = filters.risks ?? [];
    onFilterChange({
      ...filters,
      risks: cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r],
    });
  };
  const clearFilters = () => onFilterChange({});

  return (
    <div className="bg-gray-100 p-3 rounded space-y-2">
      <div className="flex gap-2 items-center flex-wrap">
        <span className="text-sm font-medium">Type:</span>
        {ALL_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => toggleType(t)}
            className={`text-xs px-2 py-1 rounded ${
              filters.types?.includes(t) ? 'bg-blue-600 text-white' : 'bg-white border'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <span className="text-sm font-medium">Risk:</span>
        {ALL_RISKS.map((r) => (
          <button
            key={r}
            onClick={() => toggleRisk(r)}
            className={`text-xs px-2 py-1 rounded ${
              filters.risks?.includes(r) ? 'bg-blue-600 text-white' : 'bg-white border'
            }`}
          >
            {r}
          </button>
        ))}
        <button
          onClick={clearFilters}
          className="ml-auto text-xs text-gray-600 underline hover:text-gray-900"
        >
          Clear filters
        </button>
      </div>
    </div>
  );
}
