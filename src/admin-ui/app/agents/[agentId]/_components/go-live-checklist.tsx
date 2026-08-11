'use client';

import * as React from 'react';
import Link from 'next/link';
import { trpc } from '../../../../trpc/client.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Button } from '../../../../components/ui/button.js';

/**
 * Checklist "colocar no ar" — mostra em um só lugar as três pré-condições
 * reais para o agente operar (perfil ativo → canal → papel + política), cada
 * uma com link para a tela que resolve. Some quando tudo está completo.
 *
 * Antes deste card as duas últimas etapas não eram sequer mencionadas na UI:
 * o wizard terminava em "aprove o perfil" e o elo canal/papel/política ficava
 * invisível (canais e papéis eram seed/SQL-only).
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
    { tenantId, agentId },
    { enabled: tenantId !== '' },
  );

  if (overviewQuery.isLoading || overviewQuery.error) return null;

  const overview = overviewQuery.data;
  const channels = overview?.channels ?? [];
  const rolesCount = overview?.roles_count ?? 0;

  const hasChannel = channels.length > 0;
  // policy_ready = política existe E o papel padrão está ativo — has_policy
  // sozinho deixaria o checklist sumir com um papel padrão desativado
  // (review do PR #491, medium).
  const allChannelsReady = hasChannel && channels.every((c) => c.policy_ready);
  const policyDone = rolesCount > 0 && allChannelsReady;
  const hasStalePolicy = channels.some((c) => c.has_policy && !c.policy_ready);

  // Tudo pronto — o checklist já cumpriu o papel; não polui a visão geral.
  if (hasActiveProfile && hasChannel && policyDone) return null;

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

  return (
    <Card>
      <CardHeader
        title="Colocar no ar"
        description="As três pré-condições para este agente atender. O card some quando tudo estiver pronto."
      />
      <CardBody>
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-3">
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  item.done
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-amber-100 text-amber-700'
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
                <span className="mt-0.5 block text-xs text-zinc-500">
                  {item.detail}
                </span>
              </span>
              {item.action}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
