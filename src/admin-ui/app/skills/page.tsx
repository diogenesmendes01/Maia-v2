'use client';

/**
 * Admin UI — gestão de Skills (Registry P9a).
 *
 * Lista/inspeciona a tabela `skills` para o agente selecionado, filtrável por
 * status, com um detalhe que renderiza o contrato declarativo completo e a
 * lista de versões. Founders trocam de tenant via seletor; os demais papéis
 * ficam presos ao próprio tenant (o resolveTenantId do router também impõe
 * isso no servidor).
 *
 * A tabela consome uma projeção RESUMIDA (sem JSONB grande) de skills.list; o
 * detalhe busca o contrato completo por linha via skills.getById.
 *
 * Mutações de ciclo de vida (propose / activate / deprecate / rollback) são
 * todas restritas a `founder` (spec §2 "solo operator").
 *
 * Fronteira de servidor: esta página não importa nada de módulos de backend —
 * apenas o JSON serializado das queries `trpc.skills.*`.
 */

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { SkillForm } from './_components/skill-form.js';
import { SkillDetailModal, type SkillSummary } from './_components/skill-detail.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Button } from '../../components/ui/button.js';
import { StatusBadge } from '../../components/ui/badge.js';
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
  Alert,
} from '../../components/ui/states.js';
import { IconZap, IconPlus } from '../../components/ui/icons.js';

type SkillStatus = 'active' | 'proposed' | 'deprecated' | 'rolled_back';

const STATUS_TABS: SkillStatus[] = ['active', 'proposed', 'deprecated', 'rolled_back'];

const STATUS_LABEL: Record<SkillStatus, string> = {
  active: 'Ativas',
  proposed: 'Propostas',
  deprecated: 'Descontinuadas',
  rolled_back: 'Revertidas',
};

function fmtDate(v: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('pt-BR');
}

export default function SkillsPage() {
  const { data: session, status: sessionStatus } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';
  // Todas as mutações de skill são restritas a founder (spec §2 "solo operator").
  const isFounder = role === 'founder';

  // Founders inspecionam outros tenants via seletor; os demais papéis ficam
  // presos ao próprio tenant. Espelha as páginas de setup.
  const [tenantId, setTenantId] = React.useState(sessionTenant);
  React.useEffect(() => {
    if (sessionTenant && !tenantId) setTenantId(sessionTenant);
  }, [sessionTenant, tenantId]);

  const [agentId, setAgentId] = React.useState('');
  const [tab, setTab] = React.useState<SkillStatus>('active');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);

  const utils = trpc.useUtils();

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });

  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId },
    { enabled: tenantId !== '' },
  );

  const listQuery = trpc.skills.list.useQuery(
    { tenantId, agentId, status: tab },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  if (sessionStatus === 'loading') {
    return <LoadingState label="Carregando sessão…" />;
  }

  const skills = (listQuery.data?.items ?? []) as SkillSummary[];
  // A lista é limitada a 200; sinaliza o truncamento explicitamente em vez de
  // deixar >200 skills sumirem em silêncio.
  const listTruncated = listQuery.data?.hasMore === true;

  // Reseta agente + seleção quando o founder troca de tenant — agentes e
  // skills são escopados por tenant, então um agentId/selectedId antigo
  // estaria errado.
  const onTenantChange = (next: string) => {
    setTenantId(next);
    setAgentId('');
    setSelectedId(null);
  };

  return (
    <div>
      <PageHeader
        title="Skills"
        description="Skill Registry (P9a) do agente selecionado: contratos declarativos versionados, escopados por tenant/agente. Ações de ciclo de vida (propor / ativar / descontinuar / reverter) são restritas a founder."
        actions={
          isFounder && (
            <Button
              onClick={() => setShowForm(true)}
              disabled={!agentId}
              title={agentId ? 'Propor uma nova skill' : 'Escolha um agente primeiro'}
            >
              <IconPlus size={15} />
              Nova skill
            </Button>
          )
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        {role === 'founder' ? (
          <Field label="Tenant" className="w-56">
            <Select
              value={tenantId}
              onChange={(e) => onTenantChange(e.target.value)}
            >
              <option value="">Selecione…</option>
              {(tenantsQuery.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} ({t.nome})
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Tenant" className="w-56">
            <span className="flex h-9 items-center rounded-lg bg-zinc-100 px-3 font-mono text-sm text-zinc-700">
              {sessionTenant}
            </span>
          </Field>
        )}
        <Field label="Agente" className="w-56">
          <Select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setSelectedId(null);
            }}
            disabled={!tenantId}
          >
            <option value="">Selecione…</option>
            {(agentsQuery.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Tabs
        className="mb-5"
        value={tab}
        onChange={(id) => setTab(id as SkillStatus)}
        tabs={STATUS_TABS.map((s) => ({ id: s, label: STATUS_LABEL[s] }))}
      />

      {!agentId ? (
        <EmptyState
          icon={<IconZap size={36} />}
          title="Escolha um agente"
          description="Selecione um tenant e um agente para ver as skills dele."
        />
      ) : listQuery.isLoading ? (
        <LoadingState label="Carregando skills…" />
      ) : listQuery.error ? (
        <ErrorState
          message={listQuery.error.message}
          onRetry={() => void listQuery.refetch()}
        />
      ) : skills.length === 0 ? (
        <EmptyState
          icon={<IconZap size={36} />}
          title={`Nenhuma skill em "${STATUS_LABEL[tab]}" para este agente`}
        />
      ) : (
        <div className="space-y-3">
          {listTruncated && (
            <Alert tone="warning" title="Lista truncada">
              Mostrando as primeiras {skills.length} skills. Há mais do que isso
              para o filtro atual — refine por agente ou status para ver o
              restante.
            </Alert>
          )}
          <TableShell>
            <Table>
              <THead>
                <Th>Descritor</Th>
                <Th>Categoria</Th>
                <Th>Modo de execução</Th>
                <Th>Versão</Th>
                <Th>Status</Th>
                <Th>Ativada em</Th>
              </THead>
              <tbody>
                {skills.map((s) => (
                  <Tr
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className="cursor-pointer"
                  >
                    <Td>
                      <code className="font-mono text-xs">{s.skill_descriptor}</code>
                    </Td>
                    <Td>{s.category}</Td>
                    <Td>{s.execution_mode}</Td>
                    <Td className="tabular-nums">v{s.version}</Td>
                    <Td>
                      <StatusBadge status={s.status} />
                    </Td>
                    <Td className="text-xs text-zinc-500">{fmtDate(s.activated_at)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableShell>
        </div>
      )}

      {selectedId && (
        <SkillDetailModal
          id={selectedId}
          tenantId={tenantId}
          agentId={agentId}
          isFounder={isFounder}
          onClose={() => setSelectedId(null)}
          onMutated={() => {
            void utils.skills.list.invalidate();
            void utils.skills.getById.invalidate();
            void utils.skills.listVersions.invalidate();
          }}
        />
      )}

      {showForm && isFounder && agentId && (
        <SkillForm
          tenantId={tenantId}
          agentId={agentId}
          onClose={() => setShowForm(false)}
          onProposed={() => {
            void utils.skills.list.invalidate();
          }}
        />
      )}
    </div>
  );
}
