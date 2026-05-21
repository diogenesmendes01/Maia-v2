'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import ChannelPolicyModal from './_components/channel-policy-modal.js';

export default function ChannelsSetupPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';
  const allowed = role === 'founder' || role === 'owner';

  const [tenantId, setTenantId] = React.useState(sessionTenant);
  React.useEffect(() => {
    if (sessionTenant && !tenantId) setTenantId(sessionTenant);
  }, [sessionTenant, tenantId]);

  const [agentId, setAgentId] = React.useState('');
  const [policyTarget, setPolicyTarget] = React.useState<{
    channelId: string;
    channelLabel: string;
  } | null>(null);

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: allowed && tenantId !== '' },
  );

  const channelsQuery = trpc.channelPolicies.listChannels.useQuery(
    { tenantId, agentId },
    { enabled: allowed && tenantId !== '' && agentId !== '' },
  );

  if (status === 'loading') return <p>Loading session...</p>;

  if (!allowed) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Channels</h1>
        <p className="text-sm text-red-700">
          Channel policy editing requires the <code>founder</code> or{' '}
          <code>owner</code> role. Your current role is{' '}
          <code>{role || '(none)'}</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Channels</h1>
        <p className="text-sm text-gray-600">
          Configure the policy (default role + switch behavior) per channel.
          Every change is audited.
        </p>
      </header>

      <div className="flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="font-medium">Tenant:</span>
          {role === 'founder' ? (
            <select
              value={tenantId}
              onChange={(e) => {
                setTenantId(e.target.value);
                setAgentId('');
              }}
              className="border rounded p-1"
            >
              <option value="">Select…</option>
              {(tenantsQuery.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}
                </option>
              ))}
            </select>
          ) : (
            <code className="px-2 py-0.5 bg-gray-100 rounded">{sessionTenant}</code>
          )}
        </label>

        <label className="flex items-center gap-2">
          <span className="font-medium">Agent:</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="border rounded p-1"
            disabled={!tenantId}
          >
            <option value="">Select…</option>
            {(agentsQuery.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!agentId ? (
        <p className="text-gray-500 text-sm">
          Pick a tenant + agent to see their channels.
        </p>
      ) : channelsQuery.isLoading ? (
        <p>Loading channels...</p>
      ) : channelsQuery.error ? (
        <p className="text-red-600">Error: {channelsQuery.error.message}</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">Type</th>
              <th className="text-left p-2 border-b">External ID</th>
              <th className="text-left p-2 border-b">Display name</th>
              <th className="text-left p-2 border-b">Channel ID</th>
              <th className="text-left p-2 border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(channelsQuery.data?.items ?? []).map((c) => (
              <tr key={c.id} className="border-b hover:bg-gray-50">
                <td className="p-2">{c.channel_type}</td>
                <td className="p-2 font-mono text-xs">{c.external_id}</td>
                <td className="p-2">{c.display_name ?? '—'}</td>
                <td className="p-2 font-mono text-xs">{c.id}</td>
                <td className="p-2">
                  <button
                    onClick={() =>
                      setPolicyTarget({
                        channelId: c.id,
                        channelLabel: `${c.channel_type}/${c.external_id}`,
                      })
                    }
                    className="text-blue-600 hover:underline"
                  >
                    Edit policy
                  </button>
                </td>
              </tr>
            ))}
            {(channelsQuery.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-gray-500">
                  No channels yet for this agent.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {policyTarget && tenantId && agentId && (
        <ChannelPolicyModal
          tenantId={tenantId}
          agentId={agentId}
          channelId={policyTarget.channelId}
          channelLabel={policyTarget.channelLabel}
          onClose={() => {
            setPolicyTarget(null);
          }}
        />
      )}
    </div>
  );
}
