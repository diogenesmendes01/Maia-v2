'use client';

import * as React from 'react';
import Link from 'next/link';
import { getDisplayName } from '../../../../lib/proposal-type-registry.js';
import { formatDate } from '../../../../lib/format.js';

export default function ProposalHeader({ proposal }: { proposal: any }) {
  return (
    <header className="bg-white border-b pb-4">
      <div className="text-xs text-gray-500 mb-1">
        <Link href="/inbox" className="hover:underline">
          Inbox
        </Link>{' '}
        / {getDisplayName(proposal.type)} / {proposal.id.slice(0, 8)}
      </div>
      <h1 className="text-2xl font-bold">{proposal.descriptor}</h1>
      <div className="flex gap-4 text-sm text-gray-600 mt-2">
        <span>Type: <strong>{getDisplayName(proposal.type)}</strong></span>
        <span>Risk: <strong className="capitalize">{proposal.risk}</strong></span>
        <span>Source: <strong>{proposal.source}</strong></span>
        <span>Proposed: {formatDate(proposal.proposed_at)}</span>
        <span>By: {proposal.proposed_by}</span>
      </div>
      <div className="text-xs text-gray-500 mt-1">
        Approval class: <code className="bg-gray-100 px-1 rounded">{proposal.approval_class}</code>
      </div>
    </header>
  );
}
