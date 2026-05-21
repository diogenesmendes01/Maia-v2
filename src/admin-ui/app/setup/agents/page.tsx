'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import AgentWizard from './_components/agent-wizard.js';

export default function AgentsSetupPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';

  const [tenantId, setTenantId] = React.useState(sessionTenant);
  React.useEffect(() => {
    if (sessionTenant && !tenantId) setTenantId(sessionTenant);
  }, [sessionTenant, tenantId]);

  const [showWizard, setShowWizard] = React.useState(false);

  const allowed = role === 'founder' || role === 'owner';

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });

  const listQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: allowed && tenantId !== '' },
  );

  if (status === 'loading') return <p>Loading session...</p>;

  if (!allowed) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Agents</h1>
        <p className="text-sm text-red-700">
          Agent management requires the <code>founder</code> or <code>owner</code>{' '}
          role. Your current role is <code>{role || '(none)'}</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-sm text-gray-600">
            Provision new agents inside a tenant. A seed operational-profile
            version is created in <code>proposed</code> state — it activates
            only after dual approval through the Proposal Inbox.
          </p>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          disabled={!tenantId}
        >
          New agent
        </button>
      </header>

      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Tenant:</span>
        {role === 'founder' ? (
          <select
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            className="border rounded p-1"
          >
            <option value="">Select…</option>
            {(tenantsQuery.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} ({t.nome})
              </option>
            ))}
          </select>
        ) : (
          <code className="px-2 py-0.5 bg-gray-100 rounded">{sessionTenant}</code>
        )}
      </div>

      {listQuery.isLoading ? (
        <p>Loading agents...</p>
      ) : listQuery.error ? (
        <p className="text-red-600">Error: {listQuery.error.message}</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">ID</th>
              <th className="text-left p-2 border-b">Nome</th>
              <th className="text-left p-2 border-b">Status</th>
              <th className="text-left p-2 border-b">Created</th>
            </tr>
          </thead>
          <tbody>
            {(listQuery.data?.items ?? []).map((a) => (
              <tr key={a.id} className="border-b hover:bg-gray-50">
                <td className="p-2 font-mono">{a.id}</td>
                <td className="p-2">{a.nome}</td>
                <td className="p-2">
                  <span
                    className={
                      a.status === 'active'
                        ? 'px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs'
                        : 'px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs'
                    }
                  >
                    {a.status}
                  </span>
                </td>
                <td className="p-2 text-gray-600">
                  {new Date(a.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {(listQuery.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-gray-500">
                  No agents in this tenant yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {showWizard && tenantId && (
        <AgentWizard
          tenantId={tenantId}
          onClose={(created) => {
            setShowWizard(false);
            if (created) void listQuery.refetch();
          }}
        />
      )}
    </div>
  );
}
