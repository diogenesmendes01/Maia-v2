'use client';

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import {
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../components/ui/states.js';
import { IconWrench } from '../../../components/ui/icons.js';

/**
 * Pedidos de ferramenta — a TRIAGEM do dono (issue #638, fatia C da épica #471).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O QUE MUDOU EM RELAÇÃO À v1 (#476), E POR QUÊ
 * ─────────────────────────────────────────────────────────────────────────────
 * A v1 desta tela lia `agent_capability_gaps` cru e montava, NO NAVEGADOR, o
 * `title`, o `body` e o esqueleto do contrato Zod de uma issue — depois abria
 * `github.com/.../issues/new?...` num link. Três consequências, todas ruins:
 *
 *   · o console DUPLICAVA lógica de backend (o nome da tool era derivado por um
 *     `slugify` próprio, que não é o `esbocarNomeDeTool` que a fatia A usa para
 *     de fato nomear o pedido — dois nomes para a mesma coisa);
 *   · não havia idempotência nenhuma: dois cliques abriam duas abas de "nova
 *     issue", e nada no sistema sabia que o pedido tinha sido aceito;
 *   · o pedido mostrado era o GAP, não o PEDIDO AGRUPADO — cinco lacunas
 *     parecidas apareciam como cinco itens de duas ocorrências, em vez de um de
 *     dez, que é justamente o que a fatia B existe para corrigir.
 *
 * Esta versão lê `toolRequests.list`: agregado, contador, estado do contrato e
 * estado do aceite vêm PRONTOS do backend. Nada aqui recalcula similaridade,
 * re-deriva rascunho de contrato ou monta corpo de issue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O GUARDRAIL, NA TELA
 * ─────────────────────────────────────────────────────────────────────────────
 * **O agente especifica; humano implementa e instala.** Não existe botão
 * "aprovar e instalar", e não pode passar a existir. "Aceitar" abre UMA issue —
 * duas vezes o mesmo pedido não abre duas — e nada mais: nenhuma tool é
 * registrada, nenhuma capability é concedida. O gap fecha sozinho, mais tarde,
 * quando o backend constatar que a ferramenta existe E está concedida a este
 * agente. Não há caixinha aqui que feche gap nenhum.
 */

/** Rótulos do estado da fusão. O estado vem do backend; aqui só se traduz. */
const CONTRATO_ROTULO: Record<string, { texto: string; tom: 'neutral' | 'warning' | 'success' }> = {
  single: { texto: 'contrato de um pedido', tom: 'neutral' },
  consistent: { texto: 'contratos compatíveis (união)', tom: 'success' },
  divergent: { texto: 'contratos em conflito', tom: 'warning' },
};

function EstadoDoAceite({
  aceite,
}: {
  aceite: {
    status: string;
    issue_number: number | null;
    issue_url: string | null;
    repo_slug: string;
    adopted: boolean;
    last_error: string | null;
    attempts: number;
  };
}) {
  if (aceite.status === 'created' && aceite.issue_number !== null) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone="success">issue #{aceite.issue_number}</Badge>
        {aceite.adopted ? (
          // "Readotada" é um fato distinto de "criada agora": o relayer
          // reconheceu, pelo marcador, uma issue que ele já tinha aberto antes
          // de um crash. Esconder a distinção apagaria a única pista de que a
          // janela de crash foi exercitada.
          <Badge tone="neutral">readotada</Badge>
        ) : null}
        {aceite.issue_url ? (
          <a
            className="text-xs font-medium text-brand-700 underline"
            href={aceite.issue_url}
            target="_blank"
            rel="noreferrer"
          >
            abrir no GitHub
          </a>
        ) : null}
      </span>
    );
  }
  if (aceite.status === 'failed') {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone="danger">falha ao abrir a issue</Badge>
        <span className="text-xs text-zinc-500">{aceite.last_error ?? 'sem detalhe'}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone="warning">aceito — issue em fila</Badge>
      <span className="text-xs text-zinc-500">
        o runtime abre em {aceite.repo_slug}
        {aceite.attempts > 0 ? ` (${aceite.attempts} tentativa(s))` : ''}
      </span>
    </span>
  );
}

export default function ToolRequests({
  tenantId,
  agentId,
}: {
  tenantId: string;
  agentId: string;
}) {
  const utils = trpc.useUtils();
  const query = trpc.toolRequests.list.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' },
  );
  const [erroDoAceite, setErroDoAceite] = React.useState<string | null>(null);
  const [emVoo, setEmVoo] = React.useState<string | null>(null);

  const aceitar = trpc.toolRequests.aceitar.useMutation({
    onSuccess: async () => {
      setErroDoAceite(null);
      await utils.toolRequests.list.invalidate();
    },
    onError: (e) => setErroDoAceite(e.message),
    onSettled: () => setEmVoo(null),
  });

  if (query.isLoading) return <LoadingState label="Carregando pedidos…" />;
  if (query.error)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const items = query.data?.items ?? [];
  const repoSlug = query.data?.repo_slug ?? null;

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Quando o agente esbarra numa ferramenta que <strong>não existe</strong>, o
        pedido chega aqui — já agrupado com os pedidos parecidos e com o contador
        de demanda que o backend calculou. <strong>Aceitar</strong> abre uma issue
        para o time de desenvolvimento e <strong>nada mais</strong>: nenhuma tool é
        registrada, nenhuma capability é concedida. O agente especifica; humanos
        implementam e instalam. A lacuna fecha sozinha quando a ferramenta
        realmente existir e estiver concedida a este agente — e o agente é avisado.
      </Alert>

      {repoSlug === null ? (
        <Alert tone="warning">
          <code>MAIA_TOOL_REQUEST_ISSUE_REPO</code> não está configurado. Sem
          destino explícito nenhuma issue é aberta — efeito externo não tem
          destino implícito.
        </Alert>
      ) : null}

      {erroDoAceite ? <Alert tone="danger">{erroDoAceite}</Alert> : null}

      {items.length === 0 ? (
        <EmptyState
          icon={<IconWrench size={32} />}
          title="Nenhum pedido de ferramenta"
          description="O agente ainda não pediu uma ferramenta que não existe. Os pedidos aparecem aqui conforme ele esbarra em limites durante conversas reais."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((item) => {
            const contrato = CONTRATO_ROTULO[item.contract_state] ?? {
              texto: item.contract_state,
              tom: 'neutral' as const,
            };
            const jaAceito = item.aceite !== null;
            return (
              <Card key={item.aggregate_id}>
                <CardHeader
                  title={item.proposed_tool_name}
                  description={`nome proposto pelo agente · agrupamento ${item.metrica} @ ${item.limiar} (assinatura v${item.assinatura_version})`}
                  actions={<Badge tone={contrato.tom}>{contrato.texto}</Badge>}
                />
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* O CONTADOR vem do backend (`member_count` /
                        `total_occurrences`, recalculados a partir dos membros
                        ativos). O front não soma nada. */}
                    <Badge tone={item.member_count >= 3 ? 'warning' : 'neutral'}>
                      {item.member_count} pedido(s) agrupado(s)
                    </Badge>
                    <Badge tone="neutral">{item.total_occurrences} ocorrência(s)</Badge>
                    {item.nomes_propostos.length > 1 ? (
                      <Badge tone="neutral">
                        {item.nomes_propostos.length} nomes propostos
                      </Badge>
                    ) : null}
                  </div>

                  {item.contract_state === 'divergent' ? (
                    <p className="text-xs text-zinc-600">
                      Os pedidos agrupados discordam sobre o contrato. Nenhum
                      rascunho venceu e <strong>não há contrato fundido</strong> —
                      os conflitos vão nomeados no corpo da issue, e a decisão é
                      do dev.
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    {jaAceito ? (
                      <EstadoDoAceite aceite={item.aceite!} />
                    ) : (
                      <span className="text-xs text-zinc-500">ainda não triado</span>
                    )}
                    <Button
                      size="sm"
                      variant={jaAceito ? 'secondary' : 'primary'}
                      disabled={jaAceito || repoSlug === null}
                      loading={emVoo === item.aggregate_id}
                      onClick={() => {
                        setEmVoo(item.aggregate_id);
                        aceitar.mutate({
                          tenantId,
                          agentId,
                          aggregateId: item.aggregate_id,
                        });
                      }}
                    >
                      <IconWrench size={13} />
                      {jaAceito ? 'Já aceito' : 'Aceitar e abrir issue'}
                    </Button>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
