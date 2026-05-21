'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import ProfileApproveModal from './_components/profile-approve-modal.js';

export default function IdentitiesPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const tenantId = session?.user?.tenant_id ?? '';
  const [agentId, setAgentId] = React.useState<string>('');
  const [approveTarget, setApproveTarget] = React.useState<{
    versionId: string;
    agentId: string;
    version: number;
  } | null>(null);

  const canApprove = role === 'owner' || role === 'founder';

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const versionsQuery = trpc.versions.listVersions.useQuery(
    {
      tenantId,
      sotKind: 'agent_operational_profile_versions',
      agentId: agentId || undefined,
      limit: 100,
    },
    { enabled: tenantId !== '' },
  );

  if (status === 'loading') return <p>Loading session...</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Identities</h1>
        <p className="text-sm text-gray-600">
          Operational profile versions per agent (
          <code>agent_operational_profile_versions</code>). The <em>active</em>{' '}
          row is what the agent is currently running. <em>proposed</em> rows
          can be approved here — the previous active version is automatically
          frozen in the same transaction.
        </p>
      </header>

      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Filter by agent:</span>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="border rounded p-1"
        >
          <option value="">All</option>
          {(agentsQuery.data?.items ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
      </div>

      {versionsQuery.isLoading ? (
        <p>Loading versions...</p>
      ) : versionsQuery.error ? (
        <p className="text-red-600">Error: {versionsQuery.error.message}</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">Agent</th>
              <th className="text-left p-2 border-b">Version</th>
              <th className="text-left p-2 border-b">Status</th>
              <th className="text-left p-2 border-b">ID</th>
              <th className="text-left p-2 border-b">Created</th>
              <th className="text-left p-2 border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(versionsQuery.data?.items ?? []).map((v) => (
              <tr key={v.id} className="border-b hover:bg-gray-50">
                <td className="p-2 font-mono">{v.sot_id}</td>
                <td className="p-2">v{v.version}</td>
                <td className="p-2">
                  <span
                    className={
                      v.status === 'active'
                        ? 'px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs'
                        : v.status === 'proposed'
                          ? 'px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs'
                          : v.status === 'frozen'
                            ? 'px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs'
                            : 'px-2 py-0.5 bg-gray-100 text-gray-800 rounded text-xs'
                    }
                  >
                    {v.status}
                  </span>
                </td>
                <td className="p-2 font-mono text-xs">{v.id}</td>
                <td className="p-2 text-gray-600">
                  {new Date(v.created_at).toLocaleString()}
                </td>
                <td className="p-2">
                  {v.status === 'proposed' && canApprove ? (
                    <button
                      onClick={() =>
                        setApproveTarget({
                          versionId: v.id,
                          agentId: v.sot_id,
                          version: v.version,
                        })
                      }
                      className="text-blue-600 hover:underline"
                    >
                      Approve & activate
                    </button>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
            {(versionsQuery.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-gray-500">
                  No operational profile versions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {approveTarget && (
        <ProfileApproveModal
          tenantId={tenantId}
          target={approveTarget}
          onClose={(approved) => {
            setApproveTarget(null);
            if (approved) void versionsQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
