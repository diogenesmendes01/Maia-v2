'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import { Tabs } from '../../../components/ui/tabs.js';
import { Badge, StatusBadge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Field, Textarea } from '../../../components/ui/field.js';
import { Modal } from '../../../components/ui/modal.js';
import {
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../components/ui/states.js';
import {
  TableShell,
  Table,
  THead,
  Th,
  Tr,
  Td,
} from '../../../components/ui/table.js';
import { IconArrowLeft, IconBot } from '../../../components/ui/icons.js';
import {
  DEFAULT_PROFILE,
  IdentitySection,
  BehaviorSection,
  profileBodyToForm,
  formToProfileBodyInput,
  validateIdentity,
  validateBehavior,
  type ProfileFormValue,
} from '../_components/profile-form.js';
// Diff exaustivo compartilhado com o Inbox (spec perfil-inbox v4 §1.2 — um
// único diff nas duas superfícies; deriva do walker de profile-risk.ts).
import { DiffOperationalProfile } from '../../proposals/[id]/_components/diff-operational-profile.js';
import ActivityTab from './_components/activity-tab.js';
import PlaygroundTab from './_components/playground-tab.js';
import ObjectivesTab from './_components/objectives-tab.js';
import GoLiveChecklist from './_components/go-live-checklist.js';
import CapabilitiesModal from './_components/capabilities-modal.js';

type TabId =
  | 'overview'
  | 'profile'
  | 'versions'
  | 'activity'
  | 'playground'
  | 'objectives';

const TAB_IDS: readonly TabId[] = [
  'overview',
  'profile',
  'versions',
  'activity',
  'playground',
  'objectives',
];

function isTabId(v: string | null): v is TabId {
  return v !== null && (TAB_IDS as readonly string[]).includes(v);
}

export default function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const search = useSearchParams();
  const agentId = decodeURIComponent(params.agentId);
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const tenantId = session?.user?.tenant_id ?? '';
  const canManage = role === 'founder' || role === 'owner';
  const justCreated = search.get('created') === '1';

  // ?tab=versions etc. — permite que Identidades e a fila Aprovações
  // aterrissem direto na aba certa (a aprovação de perfil vive aqui).
  const requestedTab = search.get('tab');
  const [tab, setTab] = React.useState<TabId>(
    isTabId(requestedTab) ? requestedTab : 'overview',
  );

  const agentQuery = trpc.agents.getById.useQuery(
    { tenantId, id: agentId },
    { enabled: tenantId !== '' },
  );
  const profileQuery = trpc.agents.getProfileVersions.useQuery(
    { tenantId, id: agentId },
    { enabled: tenantId !== '' },
  );
  const capabilitiesQuery = trpc.agents.getCapabilities.useQuery(
    { tenantId, id: agentId },
    { enabled: tenantId !== '' },
  );

  if (status === 'loading' || agentQuery.isLoading)
    return <LoadingState label="Carregando agente…" />;
  if (agentQuery.error)
    return (
      <ErrorState
        message={agentQuery.error.message}
        onRetry={() => void agentQuery.refetch()}
      />
    );

  const agent = agentQuery.data;
  if (!agent) return null;
  const active = profileQuery.data?.active ?? null;
  const proposed = profileQuery.data?.proposed ?? [];

  return (
    <div>
      <Link
        href="/agents"
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
      >
        <IconArrowLeft size={14} />
        Voltar para Agentes
      </Link>

      <header className="mb-5 flex flex-wrap items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <IconBot size={24} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-900">
              {agent.nome}
            </h1>
            <StatusBadge status={agent.status} />
          </div>
          <p className="font-mono text-xs text-zinc-500">
            {agent.id} · tenant {agent.tenant_id}
          </p>
        </div>
        {active && (
          <div className="ml-auto text-right">
            <p className="text-2xs font-medium uppercase tracking-wide text-zinc-400">
              Perfil em operação
            </p>
            <p className="text-sm font-semibold text-zinc-800">v{active.version}</p>
          </div>
        )}
      </header>

      {justCreated && (
        <div className="mb-4">
          <Alert tone="success" title="Agente criado">
            O perfil v1 está como <strong>proposto</strong>. Aprove-o na aba{' '}
            <strong>Versões</strong> para colocar o agente em operação.
          </Alert>
        </div>
      )}

      {proposed.length > 0 && !justCreated && (
        <div className="mb-4">
          <Alert tone="warning" title="Aprovação pendente">
            {proposed.length === 1
              ? 'Há 1 versão de perfil proposta aguardando aprovação.'
              : `Há ${proposed.length} versões de perfil propostas aguardando aprovação.`}{' '}
            Veja a aba <strong>Versões</strong>.
          </Alert>
        </div>
      )}

      <Tabs
        className="mb-6"
        value={tab}
        onChange={(id) => setTab(id as TabId)}
        tabs={[
          { id: 'overview', label: 'Visão geral' },
          { id: 'profile', label: 'Perfil' },
          {
            id: 'versions',
            label: 'Versões',
            badge:
              proposed.length > 0 ? (
                <Badge tone="warning">{proposed.length}</Badge>
              ) : undefined,
          },
          { id: 'activity', label: 'Atividade' },
          { id: 'objectives', label: 'Objetivos' },
          { id: 'playground', label: 'Testar' },
        ]}
      />

      {tab === 'overview' && (
        <div className="space-y-4">
          <GoLiveChecklist
            tenantId={tenantId}
            agentId={agent.id}
            hasActiveProfile={active !== null}
            onGoToVersions={() => setTab('versions')}
          />
          <OverviewTab
            tenantId={tenantId}
            agentId={agent.id}
            activeBody={active?.profile_body ?? null}
            activeVersion={active?.version ?? null}
            onEdit={() => setTab('profile')}
            canManage={canManage}
            capabilities={capabilitiesQuery.data ?? null}
            onCapabilitiesChanged={() => void capabilitiesQuery.refetch()}
          />
        </div>
      )}
      {tab === 'profile' && (
        <ProfileTab
          tenantId={tenantId}
          agentId={agent.id}
          activeBody={active?.profile_body ?? null}
          canManage={canManage}
          onProposed={() => {
            void profileQuery.refetch();
            setTab('versions');
          }}
        />
      )}
      {tab === 'versions' && (
        <VersionsTab
          tenantId={tenantId}
          agentId={agent.id}
          canApprove={canManage}
          activeBody={active?.profile_body ?? null}
          proposedBodies={Object.fromEntries(
            proposed.map((p) => [p.id, p.profile_body]),
          )}
          onChanged={() => void profileQuery.refetch()}
        />
      )}
      {tab === 'activity' && <ActivityTab tenantId={tenantId} agentId={agent.id} />}
      {tab === 'objectives' && (
        <ObjectivesTab tenantId={tenantId} agentId={agent.id} canManage={canManage} />
      )}
      {tab === 'playground' && (
        <PlaygroundTab
          tenantId={tenantId}
          agentId={agent.id}
          hasActiveProfile={active !== null}
          proposedVersions={proposed.map((p) => ({ id: p.id, version: p.version }))}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReadonlyList({ items, tone }: { items: string[]; tone?: 'danger' }) {
  if (items.length === 0) return <span className="text-xs text-zinc-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((p) => (
        <Badge key={p} tone={tone ?? 'neutral'}>
          {p}
        </Badge>
      ))}
    </div>
  );
}

type Capabilities = {
  packs: Array<{
    id: string;
    name: string;
    risk_level: string | null;
    tools: string[];
    known: boolean;
  }>;
  granted_tools: string[];
  denied_tools: string[];
  effective_tool_count: number;
};

function OverviewTab({
  tenantId,
  agentId,
  activeBody,
  activeVersion,
  onEdit,
  canManage,
  capabilities,
  onCapabilitiesChanged,
}: {
  tenantId: string;
  agentId: string;
  activeBody: unknown;
  activeVersion: number | null;
  onEdit: () => void;
  canManage: boolean;
  capabilities: Capabilities | null;
  onCapabilitiesChanged: () => void;
}) {
  const [showCapabilitiesModal, setShowCapabilitiesModal] = React.useState(false);

  // Issue #470 — packs/tools efetivos da função, mesmo contrato fail-closed
  // do runtime (sem grant row ⇒ floor da plataforma). Edição (packs de
  // domínio + hard denies): fase 4 — owner/founder, auditada.
  const capabilitiesCard = capabilities && (
    <Card>
      <CardHeader
        title="Capacidades da função"
        description={`${capabilities.effective_tool_count} ferramentas visíveis ao agente — princípio do menor privilégio: ele nasce com o mínimo da função e aprende o resto sob aprovação.`}
        actions={
          canManage && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowCapabilitiesModal(true)}
            >
              Gerenciar
            </Button>
          )
        }
      />
      <CardBody className="space-y-3">
        {capabilities.packs.map((pack) => (
          <div
            key={pack.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2"
          >
            <span className="flex items-center gap-2 text-sm text-zinc-800">
              <span className="font-medium">{pack.name}</span>
              <code className="font-mono text-2xs text-zinc-400">{pack.id}</code>
            </span>
            <span className="flex items-center gap-1.5">
              {pack.risk_level && <StatusBadge status={pack.risk_level} />}
              <Badge tone="neutral">
                {pack.tools.length} ferramenta{pack.tools.length === 1 ? '' : 's'}
              </Badge>
            </span>
          </div>
        ))}
        {capabilities.denied_tools.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-zinc-500">
              Negadas explicitamente (hard deny)
            </p>
            <div className="flex flex-wrap gap-1">
              {capabilities.denied_tools.map((t) => (
                <Badge key={t} tone="danger" className="font-mono">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );

  const capabilitiesModal = showCapabilitiesModal && capabilities && (
    <CapabilitiesModal
      tenantId={tenantId}
      agentId={agentId}
      currentPackIds={capabilities.packs.map((p) => p.id)}
      currentDeniedTools={capabilities.denied_tools}
      onClose={() => setShowCapabilitiesModal(false)}
      onSaved={onCapabilitiesChanged}
    />
  );

  if (!activeBody) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Nenhum perfil em operação"
          description="Este agente ainda não tem uma versão de perfil ativa. Aprove a proposta pendente na aba Versões — sem perfil ativo o agente não opera."
        />
        {capabilitiesCard}
        {capabilitiesModal}
      </div>
    );
  }
  const v = profileBodyToForm(activeBody);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          title={`Identidade em operação (v${activeVersion})`}
          actions={
            canManage && (
              <Button size="sm" variant="secondary" onClick={onEdit}>
                Editar perfil
              </Button>
            )
          }
        />
        <CardBody className="space-y-4 text-sm">
          <div>
            <p className="text-xs font-medium text-zinc-500">Papel</p>
            <p className="mt-0.5 text-zinc-900">{v.role_descriptor || '—'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-zinc-500">Voz</p>
            <p className="mt-0.5 text-zinc-900">
              {v.tone} · formalidade {v.formality} · respostas {v.verbosity}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-zinc-500">Idioma</p>
            <p className="mt-0.5 font-mono text-xs text-zinc-900">{v.language}</p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Limites cognitivos" />
        <CardBody>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-zinc-600">Profundidade máx. de inferência</dt>
              <dd className="font-mono text-xs">{v.max_inference_depth}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-600">Teto de especulação</dt>
              <dd className="font-mono text-xs">
                {Math.round(v.max_speculation_in_response * 100)}%
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-600">Piso de confiança para agir</dt>
              <dd className="font-mono text-xs">
                {Math.round(v.confidence_floor_for_action * 100)}%
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Prioridades"
          description="Pesos operacionais — monitoramento brando de drift."
        />
        <CardBody>
          <ReadonlyList items={v.priorities} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Princípios"
          description="Contratos de valor invioláveis — violações podem congelar o perfil."
        />
        <CardBody>
          <ReadonlyList items={v.principles} tone="danger" />
        </CardBody>
      </Card>

      <div className="lg:col-span-2">{capabilitiesCard}</div>
      {capabilitiesModal}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProfileTab({
  tenantId,
  agentId,
  activeBody,
  canManage,
  onProposed,
}: {
  tenantId: string;
  agentId: string;
  activeBody: unknown;
  canManage: boolean;
  onProposed: () => void;
}) {
  const [value, setValue] = React.useState<ProfileFormValue>(() =>
    activeBody ? profileBodyToForm(activeBody) : DEFAULT_PROFILE,
  );
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.agents.updateProfile.useMutation();

  if (!canManage) {
    return (
      <Alert tone="info">
        Editar o perfil exige papel <strong>owner</strong> ou <strong>founder</strong>.
      </Alert>
    );
  }

  const submit = async () => {
    const err =
      validateIdentity(value) ??
      validateBehavior(value) ??
      (reason.trim().length < 10
        ? 'Explique o motivo da mudança (mínimo 10 caracteres) — isso entra na auditoria.'
        : null);
    setError(err);
    if (err) return;
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId,
        profile_body: formToProfileBodyInput(value),
        proposed_reason: reason.trim(),
      });
      onProposed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Mudanças de perfil não entram em operação direto: o envio cria uma{' '}
        <strong>nova versão proposta</strong>, que precisa de aprovação na aba
        Versões. A versão ativa atual continua valendo até lá.
      </Alert>

      <IdentitySection value={value} onChange={setValue} />
      <BehaviorSection value={value} onChange={setValue} />

      <Card>
        <CardHeader
          title="Motivo da mudança (auditado)"
          description="Registrado na trilha de auditoria junto com a nova versão."
        />
        <CardBody>
          <Field label="Motivo" required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Ex.: Ajuste do tom de voz após feedback dos clientes."
              maxLength={2000}
            />
          </Field>
        </CardBody>
      </Card>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex justify-end">
        <Button onClick={() => void submit()} loading={mutation.isPending}>
          Propor nova versão
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function VersionsTab({
  tenantId,
  agentId,
  canApprove,
  activeBody,
  proposedBodies,
  onChanged,
}: {
  tenantId: string;
  agentId: string;
  canApprove: boolean;
  /** profile_body ativo (null quando não há) — base do diff de aprovação. */
  activeBody: unknown | null;
  /** profile_body por id de versão proposta — alvo do diff. */
  proposedBodies: Record<string, unknown>;
  onChanged: () => void;
}) {
  const versionsQuery = trpc.versions.listVersions.useQuery(
    {
      tenantId,
      sotKind: 'agent_operational_profile_versions',
      agentId,
      limit: 100,
    },
    { enabled: tenantId !== '' },
  );
  const approveMutation = trpc.agents.approveProfile.useMutation();
  const [target, setTarget] = React.useState<{ id: string; version: number } | null>(
    null,
  );
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const approve = async () => {
    if (!target) return;
    if (comment.trim().length < 10) {
      setError('O comentário de aprovação precisa de ao menos 10 caracteres.');
      return;
    }
    try {
      await approveMutation.mutateAsync({
        tenantId,
        agentId,
        versionId: target.id,
        comment: comment.trim(),
      });
      setTarget(null);
      setComment('');
      setError(null);
      void versionsQuery.refetch();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (versionsQuery.isLoading) return <LoadingState label="Carregando versões…" />;
  if (versionsQuery.error)
    return (
      <ErrorState
        message={versionsQuery.error.message}
        onRetry={() => void versionsQuery.refetch()}
      />
    );

  const items = versionsQuery.data?.items ?? [];

  return (
    <>
      {items.length === 0 ? (
        <EmptyState
          title="Nenhuma versão de perfil"
          description="As versões aparecem aqui assim que o perfil do agente for proposto."
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <Th>Versão</Th>
              <Th>Status</Th>
              <Th>Criada em</Th>
              <Th className="text-right">Ações</Th>
            </THead>
            <tbody>
              {items.map((v) => (
                <Tr key={v.id}>
                  <Td className="font-medium">v{v.version}</Td>
                  <Td>
                    <StatusBadge status={v.status} />
                  </Td>
                  <Td className="text-zinc-600">
                    {new Date(v.created_at).toLocaleString('pt-BR')}
                  </Td>
                  <Td className="text-right">
                    {v.status === 'proposed' && canApprove ? (
                      <Button
                        size="sm"
                        variant="success"
                        onClick={() => {
                          setError(null);
                          setTarget({ id: v.id, version: v.version });
                        }}
                      >
                        Aprovar e ativar
                      </Button>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableShell>
      )}

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        size="lg"
        title={`Aprovar e ativar v${target?.version ?? ''}`}
        description="A versão ativa atual (se houver) é congelada na mesma transação. A decisão é auditada."
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="success"
              onClick={() => void approve()}
              loading={approveMutation.isPending}
            >
              Aprovar e ativar
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {target && proposedBodies[target.id] !== undefined ? (
            <DiffOperationalProfile
              predecessorBody={activeBody}
              proposedBody={proposedBodies[target.id]}
            />
          ) : (
            target && (
              <Alert tone="warning" title="Conteúdo da proposta indisponível">
                Não foi possível carregar o corpo desta versão para comparação.
                Recarregue a página antes de aprovar.
              </Alert>
            )
          )}
          <Field
            label="Comentário (auditado)"
            required
            hint="Mínimo de 10 caracteres."
            error={error}
          >
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Ex.: Revisei papel, princípios e limites — aprovado para operação."
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
