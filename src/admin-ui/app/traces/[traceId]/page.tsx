'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Button } from '../../../components/ui/button.js';
import { Badge } from '../../../components/ui/badge.js';
import { Modal } from '../../../components/ui/modal.js';
import { Field, Input, Select, Textarea } from '../../../components/ui/field.js';
import {
  LoadingState,
  ErrorState,
  Alert,
} from '../../../components/ui/states.js';
import { IconArrowLeft } from '../../../components/ui/icons.js';

export default function TraceDetailPage({
  params,
}: {
  // Next 16 — `params` é uma Promise. A compatibilidade síncrona da 15 foi
  // REMOVIDA; em componente de cliente quem a resolve é `React.use()`.
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = React.use(params);
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const [showSnapshotModal, setShowSnapshotModal] = React.useState(false);

  const traceQuery = trpc.traces.getTrace.useQuery(
    { tenantId, traceId },
    { enabled: tenantId !== '' },
  );

  if (!tenantId) return <LoadingState label="Carregando sessão…" />;

  const backLink = (
    <Link
      href="/traces"
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-800"
    >
      <IconArrowLeft size={15} />
      Voltar para Traces
    </Link>
  );

  if (traceQuery.isLoading) {
    return (
      <div>
        {backLink}
        <LoadingState label="Carregando trace…" />
      </div>
    );
  }
  if (traceQuery.error) {
    return (
      <div>
        {backLink}
        <ErrorState
          message={traceQuery.error.message}
          onRetry={() => void traceQuery.refetch()}
        />
      </div>
    );
  }

  const trace = traceQuery.data;
  if (!trace) return null;

  return (
    <div>
      {backLink}
      <PageHeader
        title={
          <>
            Trace{' '}
            <span className="font-mono">{traceId.slice(0, 8)}</span>
          </>
        }
        description={
          trace.full_snapshot_available
            ? 'Snapshot ativo — visão sem redação habilitada.'
            : 'Corpo redigido. Solicite um snapshot para visualizar o corpo completo.'
        }
        actions={
          !trace.full_snapshot_available && (
            <Button onClick={() => setShowSnapshotModal(true)}>
              Solicitar snapshot completo
            </Button>
          )
        }
      />

      <div className="space-y-4">
        {/* Issue #514 §7 — envelope summary: integrity + body lifecycle.
            A "pending" or "orphaned" body must be legible as such, otherwise
            an incomplete trace reads as a trace where nothing happened. */}
        <Card>
          <CardHeader
            title="Envelope"
            description="Registro durável e assinado da decisão deste turno."
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Meta label="Agente" value={trace.agent_id} />
              <Meta label="Decisão" value={trace.decision} />
              <Meta label="Nível de efeito" value={trace.side_effect_level} />
              <Meta label="Classe de redação" value={trace.redaction_class} />
              <Meta
                label="Início"
                value={new Date(trace.started_at).toLocaleString('pt-BR')}
              />
              <Meta
                label="Conversa"
                value={trace.conversa_id ? trace.conversa_id.slice(0, 8) : '—'}
              />
              <Meta
                label="Integridade"
                value={
                  trace.envelope_integrity === 'verified'
                    ? `HMAC v${trace.hmac_key_version} verificado`
                    : trace.envelope_integrity === 'invalid'
                      ? 'ADULTERADO — HMAC não confere'
                      : `Não verificável (chave v${trace.hmac_key_version} ausente)`
                }
              />
              <Meta
                label="Integridade do corpo"
                value={
                  trace.body_integrity === 'verified'
                    ? 'HMAC verificado'
                    : trace.body_integrity === 'invalid'
                      ? 'ADULTERADO — HMAC não confere'
                      : trace.body_integrity === 'unknown'
                        ? 'Não verificável (chave ausente)'
                        : 'Ainda não persistido'
                }
              />
              <Meta
                label="Corpo"
                value={
                  trace.body_status === 'persisted'
                    ? 'persistido'
                    : trace.body_status === 'orphaned'
                      ? 'ÓRFÃO (evidência perdida)'
                      : 'pendente'
                }
              />
              <Meta
                label="Persistido em"
                value={
                  trace.body_persisted_at
                    ? new Date(trace.body_persisted_at).toLocaleString('pt-BR')
                    : '—'
                }
              />
            </dl>
            {trace.body_integrity === 'invalid' && (
              <Alert tone="danger">
                O corpo persistido NÃO confere com sua assinatura HMAC. O
                conteúdo abaixo não é confiável — trate como incidente de
                integridade.
              </Alert>
            )}
            {trace.envelope_integrity === 'invalid' && (
              <Alert tone="danger">
                A assinatura HMAC deste envelope NÃO confere com o conteúdo da
                linha. Trate como incidente de integridade — não tome decisão
                com base neste trace. Ver docs/runbooks/observability-slo.md §4.1.
              </Alert>
            )}
            {trace.envelope_integrity === 'unknown' && (
              <Alert tone="warning">
                Não foi possível verificar a assinatura: a chave HMAC v
                {trace.hmac_key_version} não está configurada neste processo.
                Ausência de prova não é prova de adulteração.
              </Alert>
            )}
            {trace.body_status === 'orphaned' && (
              <Alert tone="danger">
                O corpo deste trace nunca foi persistido e passou da janela de
                recuperação. Ver docs/runbooks/p10b-runtime-trace.md.
              </Alert>
            )}
            {trace.body_encrypted && (
              <Alert tone="warning">
                Corpo cifrado (classe debug). O conteúdo só é acessível pelo
                fluxo governado de snapshot.
              </Alert>
            )}
          </CardBody>
        </Card>

        {/* Issue #514 review round 2 — attempt grouping. A retry gets its own
            trace id (so it cannot collide on the PK); without this card the
            operator would see N unrelated traces for one turn. */}
        {trace.attempt_count > 1 && (
          <Card>
            <CardHeader
              title={`Tentativas deste turno (${trace.attempt_count})`}
              description="Retry e recovery reusam o mesmo turno; cada tentativa tem seu próprio envelope."
            />
            <CardBody>
              <ul className="divide-y divide-zinc-100">
                {trace.attempts.map((a) => (
                  <li key={a.trace_id} className="flex items-center gap-3 py-2 text-sm">
                    <Badge tone={a.is_current ? 'brand' : 'neutral'}>#{a.attempt}</Badge>
                    {a.is_current ? (
                      <span className="font-mono text-xs text-zinc-800">
                        {a.trace_id.slice(0, 8)} (atual)
                      </span>
                    ) : (
                      <Link
                        href={`/traces/${a.trace_id}`}
                        className="font-mono text-xs text-brand-600 hover:underline"
                      >
                        {a.trace_id.slice(0, 8)}
                      </Link>
                    )}
                    <span className="text-zinc-600">{a.decision}</span>
                    <span className="text-zinc-500">{a.side_effect_level}</span>
                    <span className="ml-auto text-xs text-zinc-500">
                      {new Date(a.started_at).toLocaleString('pt-BR')}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Decisões PEP"
            description="Decisões do ponto de aplicação de políticas registradas neste trace."
          />
          <CardBody>
            {trace.pep_decisions.length === 0 ? (
              <p className="text-sm text-zinc-500">
                Nenhuma decisão PEP neste trace.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {trace.pep_decisions.map((d) => (
                  <li key={d.id} className="flex items-baseline gap-2">
                    <Badge tone="neutral">{d.pep}</Badge>
                    <span className="font-mono text-xs text-zinc-700">
                      {d.decision}
                    </span>
                    {d.reason && <span className="text-zinc-600">— {d.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Pacote redigido"
            description="Corpo do trace com a política de redação (P10) aplicada."
          />
          <CardBody>
            <pre className="scroll-thin overflow-x-auto rounded-lg bg-zinc-950 p-4 text-xs text-zinc-100">
              {JSON.stringify(
                trace.redacted_packet ??
                  (trace.body_available
                    ? { note: 'Corpo cifrado — use o fluxo de snapshot' }
                    : { note: 'Corpo ainda não persistido', body_status: trace.body_status }),
                null,
                2,
              )}
            </pre>
          </CardBody>
        </Card>
      </div>

      {showSnapshotModal && (
        <SnapshotRequestModal
          traceId={traceId}
          tenantId={tenantId}
          onClose={() => {
            setShowSnapshotModal(false);
            void traceQuery.refetch();
          }}
        />
      )}
    </div>
  );
}

/** Small definition-list cell used by the envelope summary. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-xs text-zinc-800">{value}</dd>
    </div>
  );
}

type SnapshotCategory =
  | 'debugging'
  | 'incident_response'
  | 'audit_review'
  | 'support';

function SnapshotRequestModal({
  traceId,
  tenantId,
  onClose,
}: {
  traceId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [category, setCategory] = React.useState<SnapshotCategory>('debugging');
  const [ttlHours, setTtlHours] = React.useState(24);
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.traces.requestFullSnapshot.useMutation();

  const handleSubmit = async () => {
    setError(null);
    if (reason.trim().length < 20) {
      setError('O motivo deve ter no mínimo 20 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({ tenantId, traceId, reason, category, ttlHours });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Solicitar snapshot completo"
      description="Acesso temporário (TTL) ao corpo do trace sem redação. Registrado no log de auditoria."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={mutation.isPending} onClick={() => void handleSubmit()}>
            Solicitar acesso
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Motivo"
          required
          hint="Mínimo de 20 caracteres."
        >
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Descreva por que o acesso sem redação é necessário…"
          />
        </Field>

        <Field label="Categoria" required>
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as SnapshotCategory)}
          >
            <option value="debugging">Depuração</option>
            <option value="incident_response">Resposta a incidente</option>
            <option value="audit_review">Revisão de auditoria</option>
            <option value="support">Suporte</option>
          </Select>
        </Field>

        <Field label="TTL (horas, 1–72)" required>
          <Input
            type="number"
            min={1}
            max={72}
            value={ttlHours}
            onChange={(e) => setTtlHours(Number(e.target.value))}
          />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
