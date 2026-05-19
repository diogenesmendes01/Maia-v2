'use client';

import * as React from 'react';
import type { ProposalTypeId } from '../../../trpc/types.js';
import { getDisplayName } from '../../../lib/proposal-type-registry.js';

interface Props {
  counters?: Record<ProposalTypeId, number>;
}

export default function BadgeCounters({ counters }: Props) {
  if (!counters) return null;
  const total = Object.values(counters).reduce((a, b) => a + b, 0);
  return (
    <div className="flex gap-2 flex-wrap items-center">
      <span className="text-sm font-medium text-gray-600">
        {total} pending across {Object.keys(counters).length} types:
      </span>
      {(Object.entries(counters) as Array<[ProposalTypeId, number]>).map(([type, count]) => (
        <span
          key={type}
          className={`px-3 py-1 rounded text-sm ${
            count === 0 ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-blue-800 font-medium'
          }`}
        >
          {getDisplayName(type)}: {count}
        </span>
      ))}
    </div>
  );
}
