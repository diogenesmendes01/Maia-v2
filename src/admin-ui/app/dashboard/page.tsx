'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';

interface MetricCardProps {
  label: string;
  value: number | string;
  hint?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
}

function MetricCard({ label, value, hint, color = 'blue' }: MetricCardProps) {
  const colorMap = {
    blue: 'border-blue-300 bg-blue-50',
    green: 'border-green-300 bg-green-50',
    yellow: 'border-yellow-300 bg-yellow-50',
    red: 'border-red-300 bg-red-50',
    gray: 'border-gray-300 bg-gray-50',
  };
  return (
    <div className={`p-4 border rounded ${colorMap[color]}`}>
      <p className="text-xs text-gray-600 uppercase font-medium">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const summaryQuery = trpc.dashboard.summary.useQuery(
    { tenantId },
    { enabled: tenantId !== '', refetchInterval: 60_000 },
  );

  if (status === 'loading') return <p>Loading session...</p>;

  if (summaryQuery.isLoading) return <p>Loading dashboard...</p>;
  if (summaryQuery.error)
    return <p className="text-red-600">Error: {summaryQuery.error.message}</p>;

  const data = summaryQuery.data;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-gray-600">
          Operational summary for tenant <code>{tenantId}</code>.
        </p>
      </header>

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Approval queue</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard
            label="Proposals pending"
            value={data.proposals.total}
            color={data.proposals.total > 0 ? 'yellow' : 'green'}
            hint="across all sources"
          />
          <MetricCard
            label="Drift alerts open"
            value={data.drift_alerts.open}
            color={data.drift_alerts.open > 0 ? 'red' : 'green'}
          />
          <MetricCard
            label="Active agents"
            value={`${data.agents.active}/${data.agents.total}`}
            color="blue"
          />
          <MetricCard
            label="Active channels"
            value={data.channels.active}
            color="blue"
          />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">
          Proposals by type
        </h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">Type</th>
              <th className="text-right p-2 border-b">Pending</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.proposals.by_type ?? {}).map(([type, count]) => (
              <tr key={type} className="border-b">
                <td className="p-2 font-mono">{type}</td>
                <td className="p-2 text-right">{String(count)}</td>
              </tr>
            ))}
            {Object.keys(data.proposals.by_type ?? {}).length === 0 && (
              <tr>
                <td colSpan={2} className="p-4 text-center text-gray-500">
                  No pending proposals.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
