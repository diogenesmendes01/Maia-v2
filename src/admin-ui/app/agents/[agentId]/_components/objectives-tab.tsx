'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Button } from '../../../../components/ui/button.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Field, Input, Select, Textarea } from '../../../../components/ui/field.js';
import { Badge, StatusBadge } from '../../../../components/ui/badge.js';
import { Modal } from '../../../../components/ui/modal.js';
import {
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../components/ui/states.js';
import { IconPlus } from '../../../../components/ui/icons.js';

/**
 * Aba "Objetivos" (issue #469 — work loop v1): responsabilidades do agente,
 * tarefas em andamento e a fila de exceções (waiting_human) com resolução
 * humana. v1 expõe o kind `manual` (validação do ciclo); kinds com
 * perceptores reais (cobrança) chegam na v2 sem mudar esta tela.
 */
export default function ObjectivesTab({
  tenantId,
  agentId,
  canManage,
}: {
  tenantId: string;
  agentId: string;
  canManage: boolean;
}) {
  const [showCreate, setShowCreate] = React.useState(false);
  const [selectedObjective, setSelectedObjective] = React.useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = React.useState<{
    id: string;
    title: string;
  } | null>(null);

  const objectivesQuery = trpc.objectives.list.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' },
  );
  const tasksQuery = trpc.objectives.listTasks.useQuery(
    {
      tenantId,
      agentId,
      objectiveId: selectedObjective ?? undefined,
    },
    { enabled: tenantId !== '', refetchInterval: 15_000 },
  );
  const setStatusMutation = trpc.objectives.setStatus.useMutation();
  const createTaskMutation = trpc.objectives.createTask.useMutation();

  if (objectivesQuery.isLoading) return <LoadingState label="Carregando objetivos…" />;
  if (objectivesQuery.error)
    return (
      <ErrorState
        message={objectivesQuery.error.message}
        onRetry={() => void objectivesQuery.refetch()}
      />
    );

  const objectives = objectivesQuery.data?.items ?? [];
  const tasks = tasksQuery.data?.items ?? [];
  const exceptions = tasks.filter((t) => t.status === 'waiting_human');

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Objetivos são as <strong>responsabilidades</strong> do agente: o work loop
        percebe trabalho pendente e executa tarefas sem ninguém pedir; exceções
        param aqui esperando sua decisão. Nesta v1, o kind <code>manual</code>{' '}
        valida o ciclo — kinds com percepção automática (ex.: cobrança de
        inadimplentes) chegam na v2.
      </Alert>

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900">
          Objetivos ({objectives.length})
        </h3>
        {canManage && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <IconPlus size={14} />
            Novo objetivo
          </Button>
        )}
      </div>

      {objectives.length === 0 ? (
        <EmptyState
          title="Nenhum objetivo declarado"
          description="Declare a primeira responsabilidade deste agente — o work loop só trabalha dentro de objetivos aprovados por você."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {objectives.map((o) => (
            <button
              key={o.id}
              onClick={() =>
                setSelectedObjective(selectedObjective === o.id ? null : o.id)
              }
              className={`rounded-xl border bg-white p-4 text-left shadow-card transition-all hover:shadow-md ${
                selectedObjective === o.id
                  ? 'border-brand-500 ring-2 ring-brand-500/20'
                  : 'border-zinc-200'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-zinc-900">{o.title}</p>
                <StatusBadge status={o.status} />
              </div>
              <p className="mt-1 font-mono text-2xs text-zinc-400">kind: {o.kind}</p>
              {canManage && (
                <span className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
                  {o.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void setStatusMutation
                          .mutateAsync({
                            tenantId,
                            agentId,
                            objectiveId: o.id,
                            status: 'paused',
                          })
                          .then(() => objectivesQuery.refetch())
                      }
                    >
                      Pausar
                    </Button>
                  ) : o.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void setStatusMutation
                          .mutateAsync({
                            tenantId,
                            agentId,
                            objectiveId: o.id,
                            status: 'active',
                          })
                          .then(() => objectivesQuery.refetch())
                      }
                    >
                      Reativar
                    </Button>
                  ) : null}
                  {o.status !== 'archived' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void setStatusMutation
                          .mutateAsync({
                            tenantId,
                            agentId,
                            objectiveId: o.id,
                            status: 'archived',
                          })
                          .then(() => objectivesQuery.refetch())
                      }
                    >
                      Arquivar
                    </Button>
                  )}
                  {o.status === 'active' && o.kind === 'manual' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={createTaskMutation.isPending}
                      onClick={() =>
                        void createTaskMutation
                          .mutateAsync({
                            tenantId,
                            agentId,
                            objectiveId: o.id,
                            title: `Tarefa de validação — ${new Date().toLocaleTimeString('pt-BR')}`,
                            flow: 'auto',
                          })
                          .then(() => tasksQuery.refetch())
                      }
                    >
                      + Tarefa
                    </Button>
                  )}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {exceptions.length > 0 && (
        <Card>
          <CardHeader
            title={`Exceções aguardando você (${exceptions.length})`}
            description="Tarefas que o agente não pôde concluir sozinho — sua decisão destrava o trabalho."
          />
          <CardBody className="space-y-2">
            {exceptions.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2"
              >
                <span className="text-sm text-zinc-800">{t.title}</span>
                {canManage && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setResolveTarget({ id: t.id, title: t.title })}
                  >
                    Resolver
                  </Button>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Tarefas"
          description={
            selectedObjective
              ? 'Filtrando pelo objetivo selecionado — clique nele de novo para ver todas.'
              : 'Todas as tarefas recentes do agente, mais novas primeiro.'
          }
        />
        <CardBody className="p-0">
          {tasks.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-zinc-400">
              Nenhuma tarefa ainda.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-800">{t.title}</span>
                    <span className="block text-2xs text-zinc-400">
                      {new Date(t.created_at).toLocaleString('pt-BR')}
                      {t.error_detail ? ` · ${t.error_detail}` : ''}
                    </span>
                  </span>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <CreateObjectiveModal
        open={showCreate}
        onClose={(created) => {
          setShowCreate(false);
          if (created) void objectivesQuery.refetch();
        }}
        tenantId={tenantId}
        agentId={agentId}
      />
      <ResolveTaskModal
        target={resolveTarget}
        onClose={(resolved) => {
          setResolveTarget(null);
          if (resolved) void tasksQuery.refetch();
        }}
        tenantId={tenantId}
        agentId={agentId}
      />
    </div>
  );
}

function CreateObjectiveModal({
  open,
  onClose,
  tenantId,
  agentId,
}: {
  open: boolean;
  onClose: (created: boolean) => void;
  tenantId: string;
  agentId: string;
}) {
  const [title, setTitle] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.objectives.create.useMutation();

  const submit = async () => {
    if (title.trim().length < 3) {
      setError('Dê um título ao objetivo (mínimo 3 caracteres).');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId,
        kind: 'manual',
        title: title.trim(),
        params: {},
      });
      setTitle('');
      setError(null);
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => onClose(false)}
      title="Novo objetivo"
      description="Uma responsabilidade declarativa do agente. A criação é auditada."
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>
            Criar objetivo
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Título" required hint="Ex.: “Validar o ciclo do work loop”.">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Tipo" hint="v1: apenas o kind manual (tarefas criadas por você). Kinds com percepção automática chegam na v2.">
          <Select value="manual" disabled>
            <option value="manual">manual</option>
          </Select>
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

function ResolveTaskModal({
  target,
  onClose,
  tenantId,
  agentId,
}: {
  target: { id: string; title: string } | null;
  onClose: (resolved: boolean) => void;
  tenantId: string;
  agentId: string;
}) {
  const [resolution, setResolution] = React.useState<'done' | 'failed'>('done');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.objectives.resolveTask.useMutation();

  const submit = async () => {
    if (!target) return;
    if (note.trim().length < 3) {
      setError('Explique a resolução (mínimo 3 caracteres) — entra na auditoria.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId,
        taskId: target.id,
        resolution,
        note: note.trim(),
      });
      setNote('');
      setError(null);
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open={target !== null}
      onClose={() => onClose(false)}
      title="Resolver exceção"
      description={target?.title ?? ''}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>
            Resolver
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Desfecho">
          <Select
            value={resolution}
            onChange={(e) => setResolution(e.target.value as 'done' | 'failed')}
          >
            <option value="done">Concluída (resolvi/autorizei)</option>
            <option value="failed">Falhou (não deve prosseguir)</option>
          </Select>
        </Field>
        <Field label="Nota (auditada)" required>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Badge tone="info">A resolução fica registrada na trilha de auditoria.</Badge>
      </div>
    </Modal>
  );
}
