'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardBody, CardHeader } from '../../components/ui/card.js';
import { Field, Input } from '../../components/ui/field.js';
import {
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/ui/states.js';
import { STATE_TONE, STATE_LABEL, STEP_LABEL } from './_components/labels.js';

/**
 * Onboarding — lista e RETOMADA das runs (issue #519).
 *
 * O estado vive no Postgres, não nesta aba: fechar o navegador, reiniciar o
 * processo ou trocar de máquina não perde nada. Esta tela existe para achar a
 * run e voltar a ela — a URL carrega apenas o id da run, nunca segredo.
 */
export default function OnboardingListPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const canOperate = role === 'owner' || role === 'founder';

  const [label, setLabel] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const listQuery = trpc.onboarding.list.useQuery(
    { includeTerminal: false },
    { enabled: canOperate },
  );
  const start = trpc.onboarding.start.useMutation();

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  if (!canOperate) {
    return (
      <div>
        <PageHeader title="Onboarding" />
        <Alert tone="danger" title="Acesso restrito">
          Provisionar tenant e agente exige o papel <code className="font-mono">owner</code> ou{' '}
          <code className="font-mono">founder</code>. Seu papel atual é{' '}
          <code className="font-mono">{role || '(nenhum)'}</code>.
        </Alert>
      </div>
    );
  }

  const runs = listQuery.data?.runs ?? [];

  const handleStart = async () => {
    setError(null);
    try {
      const run = await start.mutateAsync(label.trim() ? { label: label.trim() } : {});
      window.location.href = `/onboarding/${run.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="Onboarding"
        description={
          <>
            Provisionamento governado de ponta a ponta: tenant → administrador → agente →
            perfil → capacidades → papel → canal → pareamento → prontidão → ativação. O
            progresso é persistido; você pode sair e voltar a qualquer momento.
          </>
        }
      />

      <Card className="mb-6">
        <CardHeader
          title="Nova jornada"
          description="Abre uma run persistida. Um mesmo par tenant/agente só pode ter uma run viva."
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Rótulo (opcional)"
              hint="Só para você reconhecer a run na lista. Não vai para auditoria."
              className="min-w-[16rem] flex-1"
            >
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex.: cliente Acme — linha comercial"
                maxLength={200}
              />
            </Field>
            <Button onClick={() => void handleStart()} loading={start.isPending}>
              Começar
            </Button>
          </div>
          {error && (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
        </CardBody>
      </Card>

      {listQuery.isLoading ? (
        <LoadingState label="Carregando runs…" />
      ) : listQuery.error ? (
        <ErrorState message={listQuery.error.message} />
      ) : runs.length === 0 ? (
        <EmptyState
          title="Nenhuma jornada em andamento"
          description="Comece uma nova acima. Runs concluídas e canceladas ficam fora desta lista."
        />
      ) : (
        <ul className="space-y-3">
          {runs.map((run) => (
            <li key={run.id}>
              <Card>
                <CardBody className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATE_TONE[run.state] ?? 'neutral'}>
                        {STATE_LABEL[run.state] ?? run.state}
                      </Badge>
                      <span className="text-sm font-medium text-zinc-900">
                        {run.tenant_id ?? '(tenant a criar)'}
                        {run.agent_id ? ` · ${run.agent_id}` : ''}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      Etapa atual: {STEP_LABEL[run.current_step] ?? run.current_step} · aberta por{' '}
                      {run.created_by} · expira em{' '}
                      {new Date(run.expires_at).toLocaleString('pt-BR')}
                    </p>
                    {run.last_error_code && (
                      <p className="mt-1 text-xs text-amber-700">
                        Último erro: <code className="font-mono">{run.last_error_code}</code>
                      </p>
                    )}
                  </div>
                  <Link href={`/onboarding/${run.id}`}>
                    <Button size="sm" variant="secondary">
                      Retomar
                    </Button>
                  </Link>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
