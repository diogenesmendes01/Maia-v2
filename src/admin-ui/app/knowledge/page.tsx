'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Field, Select } from '../../components/ui/field.js';
import { Tabs } from '../../components/ui/tabs.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../components/ui/table.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../components/ui/states.js';
import { IconBrain } from '../../components/ui/icons.js';

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

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  const memoryItems = memoryQuery.data?.items ?? [];
  const factItems = factsQuery.data?.items ?? [];
  const ruleItems = rulesQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Conhecimento"
        description="O que o agente aprendeu: memória pendente de revisão, fatos declarativos e regras de comportamento."
      />

      <div className="mb-4 max-w-xs">
        <Field label="Agente">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Selecione…</option>
            {(agentsQuery.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.nome} ({a.id})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Tabs
        className="mb-4"
        tabs={[
          { id: 'memory_review', label: 'Memória (revisão pendente)' },
          { id: 'facts', label: 'Fatos' },
          { id: 'rules', label: 'Regras de comportamento' },
        ]}
        value={tab}
        onChange={(id) => setTab(id as Tab)}
      />

      {!agentId ? (
        <EmptyState
          icon={<IconBrain size={28} />}
          title="Selecione um agente"
          description="Escolha um agente acima para visualizar o que ele aprendeu."
        />
      ) : tab === 'memory_review' ? (
        memoryQuery.isLoading ? (
          <LoadingState />
        ) : memoryQuery.error ? (
          <ErrorState
            message={memoryQuery.error.message}
            onRetry={() => void memoryQuery.refetch()}
          />
        ) : memoryItems.length === 0 ? (
          <EmptyState
            icon={<IconBrain size={28} />}
            title="Nenhuma entrada de memória pendente de revisão"
          />
        ) : (
          <TableShell>
            <Table>
              <THead>
                <Th>Conteúdo</Th>
                <Th>Tipo</Th>
                <Th>Escopo</Th>
                <Th>Sensibilidade</Th>
              </THead>
              <tbody>
                {memoryItems.map((m) => (
                  <Tr key={m.id}>
                    <Td className="max-w-md truncate" title={m.content}>
                      {m.content}
                    </Td>
                    <Td>{m.memory_type}</Td>
                    <Td>{m.scope_type}</Td>
                    <Td>{m.sensitivity}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableShell>
        )
      ) : tab === 'facts' ? (
        factsQuery.isLoading ? (
          <LoadingState />
        ) : factsQuery.error ? (
          <ErrorState
            message={factsQuery.error.message}
            onRetry={() => void factsQuery.refetch()}
          />
        ) : factItems.length === 0 ? (
          <EmptyState
            icon={<IconBrain size={28} />}
            title="Nenhum fato neste escopo"
          />
        ) : (
          <TableShell>
            <Table>
              <THead>
                <Th>Escopo</Th>
                <Th>Chave</Th>
                <Th>Fonte</Th>
                <Th>Confiança</Th>
              </THead>
              <tbody>
                {factItems.map((f) => (
                  <Tr key={f.id}>
                    <Td>{f.escopo}</Td>
                    <Td className="font-mono text-xs text-zinc-700">{f.chave}</Td>
                    <Td>{f.fonte}</Td>
                    <Td className="tabular-nums">{String(f.confianca)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableShell>
        )
      ) : rulesQuery.isLoading ? (
        <LoadingState />
      ) : rulesQuery.error ? (
        <ErrorState
          message={rulesQuery.error.message}
          onRetry={() => void rulesQuery.refetch()}
        />
      ) : ruleItems.length === 0 ? (
        <EmptyState
          icon={<IconBrain size={28} />}
          title="Nenhuma regra ativa"
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <Th>Tipo</Th>
              <Th>Contexto</Th>
              <Th>Confiança</Th>
              <Th>Acertos/Erros</Th>
            </THead>
            <tbody>
              {ruleItems.map((r) => (
                <Tr key={r.id}>
                  <Td>{r.tipo}</Td>
                  <Td className="max-w-md truncate" title={r.contexto}>
                    {r.contexto}
                  </Td>
                  <Td className="tabular-nums">{String(r.confianca)}</Td>
                  <Td className="tabular-nums">
                    {r.acertos}/{r.erros}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableShell>
      )}
    </div>
  );
}
