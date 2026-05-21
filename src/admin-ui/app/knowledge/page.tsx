'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';

type Tab = 'memory_review' | 'facts' | 'rules';

export default function KnowledgePage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const [agentId, setAgentId] = React.useState('');
  const [tab, setTab] = React.useState<Tab>('memory_review');

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const memoryQuery = trpc.knowledge.listMemoryNeedsReview.useQuery(
    { tenantId, agentId, limit: 100 },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'memory_review' },
  );
  const factsQuery = trpc.knowledge.listFacts.useQuery(
    { tenantId, agentId, scopes: ['agent'] },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'facts' },
  );
  const rulesQuery = trpc.knowledge.listRules.useQuery(
    { tenantId, agentId, tipo: 'behavior_pattern' },
    { enabled: tenantId !== '' && agentId !== '' && tab === 'rules' },
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
        <h1 className="text-2xl font-bold">Knowledge</h1>
        <p className="text-sm text-gray-600">
          What the agent has learned: pending memory review, declarative facts,
          and behavioral rules.
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
        <div className="flex gap-2 ml-3">
          <TabButton id="memory_review" label="Memory (needs review)" />
          <TabButton id="facts" label="Facts" />
          <TabButton id="rules" label="Behavior rules" />
        </div>
      </div>

      {!agentId ? (
        <p className="text-gray-500 text-sm">Pick an agent.</p>
      ) : tab === 'memory_review' ? (
        memoryQuery.isLoading ? (
          <p>Loading...</p>
        ) : memoryQuery.error ? (
          <p className="text-red-600">Error: {memoryQuery.error.message}</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="text-left p-2 border-b">Content</th>
                <th className="text-left p-2 border-b">Type</th>
                <th className="text-left p-2 border-b">Scope</th>
                <th className="text-left p-2 border-b">Sensitivity</th>
              </tr>
            </thead>
            <tbody>
              {(memoryQuery.data?.items ?? []).map((m) => (
                <tr key={m.id} className="border-b hover:bg-gray-50">
                  <td className="p-2 max-w-md truncate" title={m.content}>
                    {m.content}
                  </td>
                  <td className="p-2">{m.memory_type}</td>
                  <td className="p-2">{m.scope_type}</td>
                  <td className="p-2">{m.sensitivity}</td>
                </tr>
              ))}
              {(memoryQuery.data?.items ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="p-4 text-center text-gray-500">
                    No memory entries pending review.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )
      ) : tab === 'facts' ? (
        factsQuery.isLoading ? (
          <p>Loading...</p>
        ) : factsQuery.error ? (
          <p className="text-red-600">Error: {factsQuery.error.message}</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="text-left p-2 border-b">Scope</th>
                <th className="text-left p-2 border-b">Key</th>
                <th className="text-left p-2 border-b">Source</th>
                <th className="text-left p-2 border-b">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {(factsQuery.data?.items ?? []).map((f) => (
                <tr key={f.id} className="border-b hover:bg-gray-50">
                  <td className="p-2">{f.escopo}</td>
                  <td className="p-2 font-mono">{f.chave}</td>
                  <td className="p-2">{f.fonte}</td>
                  <td className="p-2">{String(f.confianca)}</td>
                </tr>
              ))}
              {(factsQuery.data?.items ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="p-4 text-center text-gray-500">
                    No facts in this scope.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )
      ) : rulesQuery.isLoading ? (
        <p>Loading...</p>
      ) : rulesQuery.error ? (
        <p className="text-red-600">Error: {rulesQuery.error.message}</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="text-left p-2 border-b">Tipo</th>
              <th className="text-left p-2 border-b">Context</th>
              <th className="text-left p-2 border-b">Confidence</th>
              <th className="text-left p-2 border-b">Hits/Errs</th>
            </tr>
          </thead>
          <tbody>
            {(rulesQuery.data?.items ?? []).map((r) => (
              <tr key={r.id} className="border-b hover:bg-gray-50">
                <td className="p-2">{r.tipo}</td>
                <td className="p-2 max-w-md truncate">{r.contexto}</td>
                <td className="p-2">{String(r.confianca)}</td>
                <td className="p-2">
                  {r.acertos}/{r.erros}
                </td>
              </tr>
            ))}
            {(rulesQuery.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-gray-500">
                  No active rules.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
