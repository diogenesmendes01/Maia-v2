'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { trpc } from '../../../trpc/client.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Button } from '../../../components/ui/button.js';
import { Badge } from '../../../components/ui/badge.js';
import { Card, CardBody, CardHeader } from '../../../components/ui/card.js';
import { Stepper } from '../../../components/ui/stepper.js';
import { Field, Textarea } from '../../../components/ui/field.js';
import { Modal } from '../../../components/ui/modal.js';
import { Alert, ErrorState, LoadingState } from '../../../components/ui/states.js';
import StepForm from '../_components/step-form.js';
import { STATE_LABEL, STATE_TONE, STEP_LABEL, WIZARD_STEPS } from '../_components/labels.js';

/**
 * Onboarding — a run (issue #519 §7).
 *
 * A URL carrega SÓ o id da run: nenhum token, nenhum segredo, nada que um
 * access log ou um referer possa capturar. Todo o estado vem do backend a cada
 * render — refresh, troca de aba e reinício do processo caem no mesmo caminho.
 *
 * O que a tela mostra sempre, por exigência da issue: o tenant e o agente
 * exatos, a etapa corrente, e o laudo de prontidão com a remediação de cada
 * check que falhou.
 */
export default function OnboardingRunPage() {
  const params = useParams<{ runId: string }>();
  const runId = params?.runId ?? '';

  const runQuery = trpc.onboarding.get.useQuery(
    { runId },
    {
      enabled: runId !== '',
      // O pareamento é concluído pelo RUNTIME, não por esta aba: sem poll, a
      // tela ficaria mostrando "aguardando" depois de a linha já ter provado
      // posse.
      refetchInterval: 5000,
      refetchOnWindowFocus: true,
    },
  );
  const eventsQuery = trpc.onboarding.events.useQuery(
    { runId },
    { enabled: runId !== '' },
  );
  const cancel = trpc.onboarding.cancel.useMutation();

  const [showCancel, setShowCancel] = React.useState(false);
  const [cancelComment, setCancelComment] = React.useState('');
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    void runQuery.refetch();
    void eventsQuery.refetch();
  }, [runQuery, eventsQuery]);

  if (runQuery.isLoading) return <LoadingState label="Carregando jornada…" />;
  if (runQuery.error) return <ErrorState message={runQuery.error.message} />;
  const run = runQuery.data;
  if (!run) return <ErrorState message="Run não encontrada." />;

  const stepIndex = Math.max(0, WIZARD_STEPS.indexOf(run.current_step));
  const readiness = run.readiness;
  const isTerminal = ['active', 'cancelled', 'failed_terminal'].includes(run.state);

  const handleCancel = async () => {
    setCancelError(null);
    if (cancelComment.trim().length < 10) {
      setCancelError('O motivo deve ter pelo menos 10 caracteres — ele vai para a auditoria.');
      return;
    }
    try {
      await cancel.mutateAsync({
        runId: run.id,
        expectedVersion: run.version,
        comment: cancelComment.trim(),
      });
      setShowCancel(false);
      refresh();
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="Onboarding"
        description={
          <>
            Tenant <strong>{run.tenant_id ?? '(a criar)'}</strong>
            {run.agent_id ? (
              <>
                {' '}
                · agente <strong>{run.agent_id}</strong>
              </>
            ) : null}
            {' · '}
            <code className="font-mono text-2xs">{run.correlation_id}</code>
          </>
        }
        actions={
          <>
            <Link href="/onboarding">
              <Button size="sm" variant="secondary">
                Todas as jornadas
              </Button>
            </Link>
            {!isTerminal && (
              <Button size="sm" variant="secondary" onClick={() => setShowCancel(true)}>
                Cancelar jornada
              </Button>
            )}
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone={STATE_TONE[run.state] ?? 'neutral'}>
          {STATE_LABEL[run.state] ?? run.state}
        </Badge>
        <Stepper steps={WIZARD_STEPS.map((s) => STEP_LABEL[s] ?? s)} current={stepIndex} />
      </div>

      {run.state === 'active' && (
        <div className="mb-6">
          <Alert tone="success" title="Agente ativo">
            O agente <strong>{run.agent_id}</strong> está em operação. A ativação ficou registrada
            em auditoria com a impressão digital da configuração aprovada.
          </Alert>
        </div>
      )}

      {run.state === 'activating' && (
        <div className="mb-6">
          <Alert tone="warning" title="Ativação em andamento">
            A run está em <code className="font-mono">activating</code>. Se ela permanecer assim,
            houve uma interrupção no meio da transição final — consulte o runbook de onboarding.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Etapa corrente"
              description="O que está habilitado vem do backend — a tela não avança sozinha."
            />
            <CardBody>
              {isTerminal ? (
                <Alert tone="info">
                  Esta jornada terminou em <strong>{STATE_LABEL[run.state] ?? run.state}</strong>.
                  O histórico permanece para consulta.
                </Alert>
              ) : (
                <StepForm run={run} onChanged={refresh} />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Histórico"
              description="Append-only. Reconstrói o que a jornada fez, em que ordem e por quem."
            />
            <CardBody>
              {eventsQuery.isLoading ? (
                <LoadingState label="Carregando histórico…" />
              ) : (
                <ol className="space-y-2">
                  {(eventsQuery.data?.events ?? []).map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span className="font-mono text-zinc-400">
                        {new Date(e.created_at).toLocaleString('pt-BR')}
                      </span>
                      <Badge
                        tone={
                          e.event_type === 'completed'
                            ? 'success'
                            : e.event_type === 'denied' || e.event_type === 'failed'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {e.event_type}
                      </Badge>
                      <span className="text-zinc-700">{STEP_LABEL[e.step] ?? e.step}</span>
                      {e.from_state && e.to_state && e.from_state !== e.to_state && (
                        <span className="text-zinc-500">
                          {e.from_state} → {e.to_state}
                        </span>
                      )}
                      {e.error_code && (
                        <code className="font-mono text-red-600">{e.error_code}</code>
                      )}
                      <span className="text-zinc-400">por {e.actor_id}</span>
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader
            title="Prontidão"
            description="A mesma avaliação que a ativação usa. Um check bloqueante vermelho impede o agente de entrar no ar."
          />
          <CardBody>
            {!readiness ? (
              <p className="text-xs text-zinc-500">
                Disponível assim que a run tiver tenant e agente resolvidos.
              </p>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <Badge tone={readiness.ready ? 'success' : 'warning'}>
                    {readiness.ready ? 'Pronto para ativar' : 'Bloqueado'}
                  </Badge>
                  <span className="text-2xs text-zinc-400">
                    avaliado em {new Date(readiness.evaluated_at).toLocaleString('pt-BR')}
                  </span>
                </div>
                <ul className="space-y-2">
                  {readiness.checks.map((c) => (
                    <li key={c.code} className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-semibold ${
                          c.status === 'pass'
                            ? 'bg-emerald-100 text-emerald-700'
                            : c.severity === 'advisory'
                              ? 'bg-zinc-100 text-zinc-500'
                              : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {c.status === 'pass' ? '✓' : '•'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-zinc-800">
                          {c.message}
                        </span>
                        <span className="block text-2xs text-zinc-400">
                          <code className="font-mono">{c.code}</code>
                          {c.severity === 'advisory' && ' · informativo'}
                        </span>
                        {c.remediation && c.status !== 'pass' && (
                          <span className="mt-0.5 block text-2xs leading-relaxed text-amber-700">
                            {c.remediation}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 break-all text-2xs text-zinc-400">
                  configuração <code className="font-mono">{readiness.configuration_fingerprint.slice(0, 16)}</code>
                  {' · '}schema <code className="font-mono">{readiness.schema_fingerprint.slice(0, 16)}</code>
                </p>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {showCancel && (
        <Modal
          open
          onClose={() => setShowCancel(false)}
          title="Cancelar jornada"
          description="O que já foi provisionado NÃO é apagado — tenant, agente, papel e canal podem já estar em uso. O agente permanece pausado, a sessão de pareamento é encerrada e a auditoria fica."
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowCancel(false)}>
                Voltar
              </Button>
              <Button variant="danger" onClick={() => void handleCancel()} loading={cancel.isPending}>
                Cancelar jornada
              </Button>
            </>
          }
        >
          <Field label="Motivo (auditado, mín. 10 caracteres)" required>
            <Textarea
              rows={3}
              value={cancelComment}
              onChange={(e) => setCancelComment(e.target.value)}
            />
          </Field>
          {cancelError && (
            <div className="mt-3">
              <Alert tone="danger">{cancelError}</Alert>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
