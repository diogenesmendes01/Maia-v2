'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import VersionsTable from './_components/versions-table.js';

export default function VersionsPage() {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const versionsQuery = trpc.versions.listVersions.useQuery(
    { tenantId, limit: 50 },
    { enabled: tenantId !== '' },
  );

  if (!tenantId) return <p>Loading session...</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Version History &amp; Rollback</h1>
        <p className="text-sm text-gray-600">
          Browse all source-of-truth versions; rollback when needed.
        </p>
      </header>
      {versionsQuery.isLoading ? (
        <p>Loading versions...</p>
      ) : (
        <VersionsTable versions={versionsQuery.data?.items ?? []} />
      )}
    </div>
  );
}
