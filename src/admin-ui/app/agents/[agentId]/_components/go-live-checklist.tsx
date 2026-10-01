'use client';

import * as React from 'react';
import Link from 'next/link';
import { trpc } from '../../../../trpc/client.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Button } from '../../../../components/ui/button.js';
import { goLiveEngineItem } from './go-live-engine-status.js';

/**
 * Checklist "colocar no ar" — mostra em um só lugar as pré-condições reais para
 * o agente operar (perfil ativo → canal → papel + política → motor remoto),
 * cada uma com link para a tela que resolve. Some quando tudo está completo.
 *
 * Antes deste card as duas últimas etapas não eram sequer mencionadas na UI:
 * o wizard terminava em "aprove o perfil" e o elo canal/papel/política ficava
 * invisível (canais e papéis eram seed/SQL-only).
 *
 * ─── SC03: indisponível ≠ pronto ────────────────────────────────────────────
 *
 * 1. O componente antes fazia `if (isLoading || error) return null`, e o efeito
 *    era o pior possível para um checklist: quando o backend NÃO respondia, o
 *    card simplesmente desaparecia — e ausência de card lê como "nada
 *    pendente". Era o mesmo falso positivo que o readiness canônico existe para
 *    matar, só que pintado de vazio em vez de verde (§8.3: "Status desconhecido
 *    precisa permanecer visível, em vez de o card sumir em erro"). Agora o
 *    estado DESCONHECIDO é explícito: o card continua na tela dizendo que não
 *    foi possível verificar, com o motivo e um "Tentar de novo".
 *
 * 2. (correção pós-QA239/240) O checklist passa a consumir a projeção
 *    `AgentReadiness.engine` do BACKEND — a mesma que o avaliador canônico
 *    produz —, e não declara "pronto" a partir de booleanos locais. A decisão
 *    do que o veredito significa é pura e vive em `go-live-engine-status.ts`;
 *    aqui só se RENDERIZA. Quando `engine.requested && !engine.available` (ou
 *    quando a projeção não veio), o item do motor entra bloqueando e o card NÃO
 *    some: o operador vê o motivo fechado — kill switch, evidência ausente,
 *    bundle não aprovado, limites, pin — vindo do backend, em vez de um "tudo
 *    pronto" inventado. Nenhum critério de readiness é replicado no React
 *    (§8.3.3): o console consulta e apresenta.
 */
export default function GoLiveChecklist({
  tenantId,
  agentId,
  hasActiveProfile,
  onGoToVersions,
}: {
  tenantId: string;
  agentId: string;
  hasActiveProfile: boolean;
  onGoToVersions: () => void;
}) {
  const overviewQuery = trpc.channelPolicies.channelsOverview.useQuery(
    // SC03-AC04 — `includeEngine` pede ao backend a projeção
    // `AgentReadiness.engine` do avaliador canônico. Ela é a ÚNICA fonte da
    // disponibilidade do motor remoto: o console não reavalia nada por conta.
    { tenantId, agentId, includeEngine: true },
    { enabled: tenantId !== '' },
  );

  // O veredito do backend não chegou: nem verde, nem oculto. `data` ausente sem
  // erro é o mesmo estado — "não sei", nunca "nada pendente".
  if (overviewQuery.error || (overviewQuery.data === undefined && !overviewQuery.isLoading)) {
    return (
      <Card>
        <CardHeader title="Colocar no ar" description="Pré-condições para este agente atender." />
        <CardBody>
          <ul className="space-y-3">
            <li className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700"
              >
                ?
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-zinc-900">
                  Status indisponível
                </span>
                <span className="mt-0.5 block text-xs text-zinc-500">
                  O backend não respondeu sobre canais e papéis deste agente. Sem
                  essa resposta não é possível afirmar que ele está pronto — nem
                  que não está.
                </span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void overviewQuery.refetch()}>
                Tentar de novo
              </Button>
            </li>
          </ul>
        </CardBody>
      </Card>
    );
  }

  // Carregando é estado transitório e conhecido: o card aparece assim que o
  // veredito chega (o que não pode acontecer é o erro cair no mesmo silêncio).
  if (overviewQuery.isLoading) return null;

  const overview = overviewQuery.data;
  const channels = overview?.channels ?? [];
  const rolesCount = overview?.roles_count ?? 0;

  // SC03-AC04 — o veredito do MOTOR REMOTO, direto da projeção do backend.
  // `undefined` (backend antigo/sem a projeção) e `null` (avaliação que não
  // respondeu) caem os dois em `unknown` BLOQUEANTE: o checklist não declara
  // pronto o que não conseguiu verificar.
  const engineItem = goLiveEngineItem(overview?.engine);

  const hasChannel = channels.length > 0;
  // policy_ready = política existe E o papel padrão está ativo — has_policy
  // sozinho deixaria o checklist sumir com um papel padrão desativado
  // (review do PR #491, medium).
  const allChannelsReady = hasChannel && channels.every((c) => c.policy_ready);
  const policyDone = rolesCount > 0 && allChannelsReady;
  const hasStalePolicy = channels.some((c) => c.has_policy && !c.policy_ready);

  // Tudo pronto — o checklist já cumpriu o papel; não polui a visão geral.
  // MAS o motor remoto tem veto: perfil + canal + política verdes NÃO bastam
  // para o agente operar quando ele PEDE Hermes e o backend diz que o motor
  // está indisponível (ou não diz nada). Nesse caso o card continua na tela
  // (correção pós-QA239/240 do SC03-AC04).
  if (hasActiveProfile && hasChannel && policyDone && !engineItem.blocks_ready) return null;

  const channelsHref = '/setup/channels';

  const items: Array<{
    key: string;
    done: boolean;
    label: string;
    detail: string;
    action: React.ReactNode;
  }> = [
    {
      key: 'profile',
      done: hasActiveProfile,
      label: 'Perfil aprovado e ativo',
      detail: hasActiveProfile
        ? 'O agente tem uma versão de perfil em operação.'
        : 'Aprove a versão proposta — sem perfil ativo o agente não opera.',
      action: !hasActiveProfile && (
        <Button size="sm" variant="secondary" onClick={onGoToVersions}>
          Ir para Versões
        </Button>
      ),
    },
    {
      key: 'channel',
      done: hasChannel,
      label: 'Canal registrado',
      detail: hasChannel
        ? `${channels.length} ${channels.length === 1 ? 'canal registrado' : 'canais registrados'}.`
        : 'Sem canal o agente não recebe mensagens.',
      action: !hasChannel && (
        <Link href={channelsHref}>
          <Button size="sm" variant="secondary">
            Registrar canal
          </Button>
        </Link>
      ),
    },
    {
      key: 'policy',
      done: policyDone,
      label: 'Papel padrão e política do canal',
      detail: policyDone
        ? 'Todos os canais têm política com papel padrão ativo.'
        : rolesCount === 0
          ? 'Crie um papel para o agente — a política de canal exige um papel padrão.'
          : hasStalePolicy
            ? 'Há política apontando para papel inativo — atualize o papel padrão do canal.'
            : 'Há canal sem política configurada.',
      action: !policyDone && (
        <Link href={channelsHref}>
          <Button size="sm" variant="secondary">
            Configurar
          </Button>
        </Link>
      ),
    },
  ];

  // SC03-AC04 — o item do MOTOR REMOTO. Entra quando o backend diz que o
  // agente PEDE o motor remoto e ele não está disponível (motivo fechado), ou
  // quando a projeção não veio (`unknown`). Nos dois casos ele BLOQUEIA o
  // "tudo pronto" — é o veto que impede o card de sumir com o motor fora.
  if (engineItem.blocks_ready) {
    items.push({
      key: 'engine',
      done: false,
      label: engineItem.label,
      detail: engineItem.detail,
      // Só o estado DESCONHECIDO ganha "tentar de novo": indisponibilidade com
      // motivo é um fato do backend, e refazer a consulta não muda o motivo.
      action:
        engineItem.state === 'unknown' && (
          <Button size="sm" variant="secondary" onClick={() => void overviewQuery.refetch()}>
            Tentar de novo
          </Button>
        ),
    });
  }

  return (
    <Card>
      <CardHeader
        title="Colocar no ar"
        description="As pré-condições para este agente atender. O card some quando tudo estiver pronto."
      />
      <CardBody>
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-3">
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  item.done ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {item.done ? '✓' : '•'}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm font-medium ${
                    item.done ? 'text-zinc-500 line-through' : 'text-zinc-900'
                  }`}
                >
                  {item.label}
                </span>
                <span className="mt-0.5 block text-xs text-zinc-500">{item.detail}</span>
              </span>
              {item.action}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
