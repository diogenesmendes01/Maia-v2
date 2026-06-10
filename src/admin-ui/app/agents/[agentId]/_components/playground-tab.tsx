'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Button } from '../../../../components/ui/button.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Field, Select, Textarea } from '../../../../components/ui/field.js';
import { Badge } from '../../../../components/ui/badge.js';
import { Alert, ErrorState, Spinner } from '../../../../components/ui/states.js';
import { IconSparkles } from '../../../../components/ui/icons.js';
import { cn } from '../../../../components/ui/cn.js';

/**
 * Aba "Testar" (issue #464): chat sandbox com o agente — perfil ativo ou uma
 * versão proposta — sem tocar clientes, memória, aprendizado ou WhatsApp.
 * O turno roda no processo do runtime via fila em Postgres; aqui fazemos
 * polling leve (2s) enquanto há resposta pendente.
 */
export default function PlaygroundTab({
  tenantId,
  agentId,
  proposedVersions,
  hasActiveProfile,
}: {
  tenantId: string;
  agentId: string;
  proposedVersions: Array<{ id: string; version: number }>;
  hasActiveProfile: boolean;
}) {
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [versionPick, setVersionPick] = React.useState(''); // '' = perfil ativo
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  const createMutation = trpc.playground.createSession.useMutation();
  const sendMutation = trpc.playground.sendTurn.useMutation();

  const turnsQuery = trpc.playground.listTurns.useQuery(
    { tenantId, agentId, sessionId: sessionId ?? '' },
    {
      enabled: sessionId !== null,
      refetchInterval: (query) => {
        const items = query.state.data?.items ?? [];
        const pending = items.some(
          (t) => t.status === 'queued' || t.status === 'running',
        );
        return pending ? 2_000 : 10_000;
      },
    },
  );

  const items = turnsQuery.data?.items ?? [];
  const waiting = items.some((t) => t.status === 'queued' || t.status === 'running');

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items.length, waiting]);

  const startSession = async () => {
    setError(null);
    try {
      const session = await createMutation.mutateAsync({
        tenantId,
        agentId,
        profileVersionId: versionPick || null,
      });
      setSessionId(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    const message = draft.trim();
    if (!message || !sessionId) return;
    setError(null);
    setDraft('');
    try {
      await sendMutation.mutateAsync({ tenantId, agentId, sessionId, message });
      void turnsQuery.refetch();
    } catch (e) {
      setDraft(message); // devolve o texto para o operador não perder a mensagem
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!hasActiveProfile && proposedVersions.length === 0) {
    return (
      <Alert tone="info" title="Nada para testar ainda">
        O agente não tem perfil ativo nem versões propostas. Crie ou proponha um
        perfil primeiro.
      </Alert>
    );
  }

  if (!sessionId) {
    return (
      <Card>
        <CardHeader
          title="Iniciar sessão de teste"
          description="Converse com o agente em ambiente isolado: nada aqui afeta clientes, memória, aprendizado ou WhatsApp. Ferramentas ficam desativadas — o agente descreve a ação que tomaria."
        />
        <CardBody className="space-y-4">
          <Field
            label="Conversar com"
            hint={
              proposedVersions.length > 0
                ? 'Teste uma versão proposta antes de aprová-la — sem ativá-la.'
                : undefined
            }
          >
            <Select
              value={versionPick}
              onChange={(e) => setVersionPick(e.target.value)}
              className="max-w-xs"
            >
              {hasActiveProfile && <option value="">Perfil ativo</option>}
              {proposedVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  Proposta v{v.version}
                </option>
              ))}
            </Select>
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button
            onClick={() => void startSession()}
            loading={createMutation.isPending}
            disabled={!hasActiveProfile && !versionPick}
          >
            <IconSparkles size={15} />
            Iniciar conversa de teste
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Alert tone="info">
        <strong>Ambiente de teste</strong> — nada aqui afeta clientes, memória ou
        aprendizado. Conversando com{' '}
        {turnsQuery.data?.session.profile_version_id ? (
          <Badge tone="warning">versão proposta</Badge>
        ) : (
          <Badge tone="success">perfil ativo</Badge>
        )}
        . Cada interação fica registrada na auditoria como{' '}
        <code className="font-mono text-2xs">playground_turn</code>.
      </Alert>

      <Card>
        <CardBody className="scroll-thin max-h-[28rem] space-y-3 overflow-y-auto">
          {turnsQuery.error ? (
            <ErrorState
              message={turnsQuery.error.message}
              onRetry={() => void turnsQuery.refetch()}
            />
          ) : items.length === 0 && !waiting ? (
            <p className="py-8 text-center text-sm text-zinc-400">
              Envie a primeira mensagem para começar o teste.
            </p>
          ) : (
            items.map((t) => (
              <div
                key={t.id}
                className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                    t.role === 'user'
                      ? 'rounded-br-md bg-brand-600 text-white'
                      : 'rounded-bl-md bg-zinc-100 text-zinc-900',
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{t.content}</p>
                  {t.status === 'error' && (
                    <p className="mt-1.5 text-xs text-red-600">
                      Falha ao processar: {t.error_detail ?? 'erro desconhecido'}
                    </p>
                  )}
                  {t.role === 'agent' && t.decision_meta != null && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-2xs text-zinc-500 hover:text-zinc-700">
                        ver decisão
                      </summary>
                      <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded-lg bg-zinc-950 p-2.5 text-2xs text-zinc-100">
                        {JSON.stringify(t.decision_meta, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            ))
          )}
          {waiting && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Spinner className="h-3 w-3" />
              O agente está respondendo…
            </div>
          )}
          <div ref={bottomRef} />
        </CardBody>
        <div className="border-t border-zinc-100 p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              maxLength={4000}
              placeholder="Escreva como se fosse um cliente… (Enter envia, Shift+Enter quebra linha)"
            />
            <Button
              onClick={() => void send()}
              loading={sendMutation.isPending}
              disabled={draft.trim().length === 0 || waiting}
            >
              Enviar
            </Button>
          </div>
          {error && (
            <p className="mt-2 text-xs text-red-600">{error}</p>
          )}
        </div>
      </Card>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setSessionId(null)}>
          Encerrar e iniciar nova sessão
        </Button>
      </div>
    </div>
  );
}
