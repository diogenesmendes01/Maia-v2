'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { formatDate } from '../../lib/format.js';

export default function TracesPage() {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const tracesQuery = trpc.traces.listTraces.useQuery(
    { tenantId, limit: 50 },
    { enabled: tenantId !== '' },
  );

  if (!tenantId) return <p>Loading session...</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Audit &amp; Trace Explorer</h1>
        <p className="text-sm text-gray-600">
          Browse runtime traces. Full bodies redacted; request snapshot grant for unredacted view.
        </p>
      </header>

      {tracesQuery.isLoading ? (
        <p>Loading traces...</p>
      ) : tracesQuery.data?.items.length === 0 ? (
        <div className="border-2 border-dashed border-gray-300 p-8 text-center text-gray-500 rounded">
          No traces yet. Runtime trace store (P10b) not yet populated.
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-50">
              <th className="p-2 text-left">Trace ID</th>
              <th className="p-2 text-left">Agent</th>
              <th className="p-2 text-left">Conversation</th>
              <th className="p-2 text-left">Started</th>
              <th className="p-2 text-left">Duration</th>
              <th className="p-2 text-left">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {tracesQuery.data?.items.map((t) => (
              <tr key={t.id} className="border-b hover:bg-gray-50">
                <td className="p-2">
                  <Link href={`/traces/${t.id}`} className="text-blue-700 hover:underline font-mono text-xs">
                    {t.id.slice(0, 8)}
                  </Link>
                </td>
                <td className="p-2">{t.agent_id}</td>
                <td className="p-2 font-mono text-xs">{t.conversa_id ?? '-'}</td>
                <td className="p-2">{formatDate(t.started_at)}</td>
                <td className="p-2">{t.duration_ms ? `${t.duration_ms}ms` : '-'}</td>
                <td className="p-2 capitalize">{t.outcome ?? 'pending'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
