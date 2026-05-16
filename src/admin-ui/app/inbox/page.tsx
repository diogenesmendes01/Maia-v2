'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import InboxTable from './_components/inbox-table.js';
import InboxFilters from './_components/inbox-filters.js';
import BadgeCounters from './_components/badge-counters.js';
import BulkRejectModal from './_components/bulk-reject-modal.js';
import type { ProposalRow } from '../../trpc/types.js';

export default function InboxPage() {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const [filters, setFilters] = React.useState<{
    types?: ProposalRow['type'][];
    risks?: ProposalRow['risk'][];
    sources?: string[];
  }>({});

  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [showBulkReject, setShowBulkReject] = React.useState(false);

  const proposalsQuery = trpc.inbox.listProposals.useQuery(
    {
      tenantId,
      ...filters,
      status: 'proposed',
      limit: 50,
    },
    { enabled: tenantId !== '' },
  );

  const countersQuery = trpc.inbox.counters.useQuery(
    { tenantId },
    { enabled: tenantId !== '', refetchInterval: 30_000 },
  );

  if (!tenantId) {
    return <p>Loading session...</p>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Proposal Inbox</h1>
        <p className="text-sm text-gray-600">
          Review and approve pending proposals from across all governance sources.
        </p>
      </header>

      <BadgeCounters counters={countersQuery.data} />
      <InboxFilters filters={filters} onFilterChange={setFilters} />

      {selectedIds.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-300 p-3 rounded flex justify-between items-center">
          <span>{selectedIds.length} proposals selected</span>
          <button
            onClick={() => setShowBulkReject(true)}
            className="bg-red-600 text-white px-4 py-1 rounded hover:bg-red-700"
          >
            Bulk reject
          </button>
        </div>
      )}

      {proposalsQuery.isLoading ? (
        <p>Loading proposals...</p>
      ) : proposalsQuery.error ? (
        <p className="text-red-600">Error: {proposalsQuery.error.message}</p>
      ) : (
        <InboxTable
          proposals={proposalsQuery.data?.items ?? []}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
        />
      )}

      {showBulkReject && (
        <BulkRejectModal
          tenantId={tenantId}
          ids={selectedIds}
          onClose={() => {
            setShowBulkReject(false);
            setSelectedIds([]);
            void proposalsQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
