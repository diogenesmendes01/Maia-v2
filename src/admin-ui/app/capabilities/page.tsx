'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';

type Tab = 'domains' | 'skills' | 'gaps' | 'proposals';

export default function CapabilitiesPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const [agentId, setAgentId] = React.useState('');
  const [tab, setTab] = React.useState<Tab>('proposals');

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const domainsQuery = trpc.capabilities.listDomains.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'domains' },
  );
  const skillsQuery = trpc.capabilities.listSkills.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'skills' },
  );
  const gapsQuery = trpc.capabilities.listGaps.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'gaps' },
  );
  const proposalsQuery = trpc.capabilities.listProposals.useQuery(
    { tenantId, agentId, status: 'submitted' },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'proposals' },
  );

  if (status === 'loading') return <p>Loading session...</p>;

  const TabButton = ({ id, label }: { id: Tab; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={`px-3 py-1 text-sm rounded ${
        tab === id
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Capabilities</h1>
        <p className="text-sm text-gray-600">
          Domain → skill catalog, gaps the agent has surfaced, and pending
          capability proposals (P5 — dialogical capability acquisition).
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
        <div className="flex gap-2 ml-4">
          <TabButton id="proposals" label="Proposals" />
          <TabButton id="gaps" label="Gaps" />
          <TabButton id="skills" label="Skills" />
          <TabButton id="domains" label="Domains" />
        </div>
      </div>

      {!agentId ? (
        <p className="text-gray-500 text-sm">Pick an agent to see capabilities.</p>
      ) : tab === 'proposals' ? (
        <SimpleTable
          query={proposalsQuery}
          columns={[
            { key: 'title', label: 'Title' },
            { key: 'capability_type', label: 'Type' },
            { key: 'status', label: 'Status' },
            { key: 'submitted_at', label: 'Submitted', date: true },
          ]}
          emptyLabel="No pending capability proposals."
        />
      ) : tab === 'gaps' ? (
        <SimpleTable
          query={gapsQuery}
          columns={[
            { key: 'capability_description', label: 'Capability' },
            { key: 'current_level', label: 'Level' },
            { key: 'tipo', label: 'Type' },
            { key: 'last_observed', label: 'Last observed', date: true },
          ]}
          emptyLabel="No capability gaps recorded."
        />
      ) : tab === 'skills' ? (
        <SimpleTable
          query={skillsQuery}
          columns={[
            { key: 'domain', label: 'Domain' },
            { key: 'skill_name', label: 'Skill' },
            { key: 'confidence', label: 'Confidence' },
            { key: 'evidence_count', label: 'Evidences' },
          ]}
          emptyLabel="No skills cataloged yet."
        />
      ) : (
        <SimpleTable
          query={domainsQuery}
          columns={[
            { key: 'domain', label: 'Domain' },
            { key: 'confidence', label: 'Confidence' },
            { key: 'evidence_count', label: 'Evidences' },
            { key: 'updated_at', label: 'Updated', date: true },
          ]}
          emptyLabel="No domains cataloged yet."
        />
      )}
    </div>
  );
}

interface Col {
  key: string;
  label: string;
  date?: boolean;
}

type QueryShape = {
  data?: { items: unknown[] };
  isLoading: boolean;
  error: { message: string } | null;
};

function SimpleTable({
  query,
  columns,
  emptyLabel,
}: {
  query: QueryShape;
  columns: Col[];
  emptyLabel: string;
}) {
  if (query.isLoading) return <p>Loading...</p>;
  if (query.error) return <p className="text-red-600">Error: {query.error.message}</p>;
  const items = (query.data?.items ?? []) as Array<Record<string, unknown>>;
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="bg-gray-100">
          {columns.map((c) => (
            <th key={c.key} className="text-left p-2 border-b">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((row, i) => (
          <tr key={(row.id as string) ?? i} className="border-b hover:bg-gray-50">
            {columns.map((c) => {
              const v = row[c.key];
              return (
                <td key={c.key} className="p-2">
                  {v == null
                    ? '—'
                    : c.date && (typeof v === 'string' || v instanceof Date)
                      ? new Date(v as string | Date).toLocaleString()
                      : String(v)}
                </td>
              );
            })}
          </tr>
        ))}
        {items.length === 0 && (
          <tr>
            <td colSpan={columns.length} className="p-4 text-center text-gray-500">
              {emptyLabel}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
