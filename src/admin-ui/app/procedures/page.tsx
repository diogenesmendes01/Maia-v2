'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';

type ProcStatus = 'draft' | 'proposed' | 'active' | 'frozen' | 'rolled_back';

export default function ProceduresPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const [agentId, setAgentId] = React.useState('');
  const [procStatus, setProcStatus] = React.useState<ProcStatus>('active');

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const defsQuery = trpc.procedures.listDefinitions.useQuery(
    { tenantId, agentId, status: procStatus, limit: 100 },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  if (status === 'loading') return <p>Loading session...</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Procedures</h1>
        <p className="text-sm text-gray-600">
          Procedure definitions per agent (
          <code>procedure_definitions</code>), filtered by lifecycle status.
        </p>
      </header>

      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium">Agent:</span>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="border rounded p-1"
        >
          <option value="">Select…</option>
          {(agentsQuery.data?.items ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
        <span className="font-medium ml-3">Status:</span>
        <select
          value={procStatus}
          onChange={(e) => setProcStatus(e.target.value as ProcStatus)}
          className="border rounded p-1"
        >
          <option value="active">active</option>
          <option value="proposed">proposed</option>
          <option value="frozen">frozen</option>
          <option value="rolled_back">rolled_back</option>
          <option value="draft">draft</option>
        </select>
      </div>

      {!agentId ? (
        <p className="text-gray-500 text-sm">Pick an agent.</p>
      ) : defsQuery.isLoading ? (
        <p>Loading procedures...</p>
      ) : defsQuery.error ? (
        <p className="text-red-600">Error: {defsQuery.error.message}</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">Name</th>
              <th className="text-left p-2 border-b">Version</th>
              <th className="text-left p-2 border-b">Status</th>
              <th className="text-left p-2 border-b">Created</th>
            </tr>
          </thead>
          <tbody>
            {(defsQuery.data?.items ?? []).map((p) => (
              <tr key={p.id} className="border-b hover:bg-gray-50">
                <td className="p-2 font-mono">{p.nome}</td>
                <td className="p-2">v{p.version_number}</td>
                <td className="p-2">{p.status}</td>
                <td className="p-2 text-gray-600">
                  {new Date(p.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {(defsQuery.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-gray-500">
                  No procedures in this status.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
