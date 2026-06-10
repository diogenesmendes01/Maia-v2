'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../../trpc/client.js';
import { PageHeader } from '../../../components/ui/page-header.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Button } from '../../../components/ui/button.js';
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
  params: { traceId: string };
}) {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';
  const [showSnapshotModal, setShowSnapshotModal] = React.useState(false);

  const traceQuery = trpc.traces.getTrace.useQuery(
    { tenantId, traceId: params.traceId },
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
            <span className="font-mono">{params.traceId.slice(0, 8)}</span>
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
                    <span className="font-mono text-xs text-zinc-700">
                      {d.decision}
                    </span>
                    <span className="text-zinc-600">— {d.reason}</span>
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
                trace.redacted_packet ?? { note: 'Corpo ainda não populado' },
                null,
                2,
              )}
            </pre>
          </CardBody>
        </Card>
      </div>

      {showSnapshotModal && (
        <SnapshotRequestModal
          traceId={params.traceId}
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
