'use client';

import * as React from 'react';
import Link from 'next/link';
import { trpc } from '../../../../trpc/client.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Button } from '../../../../components/ui/button.js';

/**
 * Checklist "colocar no ar" — a lista real de pré-condições para este agente
 * operar, com a remediação de cada uma. Some quando tudo está pronto.
 *
 * ── Por que este card mudou de fonte (issue #519) ────────────────────────────
 * Ele computava as próprias três verificações a partir de
 * `channelPolicies.channelsOverview`. Isso fazia dele uma TERCEIRA opinião
 * sobre "o agente está pronto?", ao lado do dashboard (que somava sinais
 * globais, sem provar que o perfil e o canal eram do MESMO agente) e do gate de
 * roteamento de linha da #518. Três respostas diferentes para a mesma pergunta
 * é como se produz um falso positivo de "go live": a tela dizia pronto e o
 * runtime recusava — ou, pior, o contrário.
 *
 * Agora ele RENDERIZA o laudo canônico de `evaluateAgentReadiness`, o mesmo que
 * o wizard mostra e que a ativação REAVALIA dentro da transição atômica. Este
 * componente não decide mais nada; ele só apresenta.
 *
 * Checks `advisory` (hoje o roteamento da linha, que o backend liga sozinho
 * quando a política fica pronta) ficam de fora da lista: pedir ação humana para
 * algo que se resolve sozinho treina o operador a ignorar o card.
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
  const readinessQuery = trpc.onboarding.readiness.useQuery(
    { tenantId, agentId },
    { enabled: tenantId !== '' && agentId !== '' },
  );

  if (readinessQuery.isLoading || readinessQuery.error) return null;
  const readiness = readinessQuery.data;
  if (!readiness) return null;

  // Tudo pronto — o card já cumpriu o papel; não polui a visão geral.
  if (readiness.ready) return null;

  const blocking = readiness.checks.filter(
    (c) => c.severity === 'blocking' && c.status !== 'pass',
  );
  if (blocking.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Colocar no ar"
        description="As pré-condições que faltam para este agente atender. É a mesma avaliação que a ativação usa — o card some quando tudo estiver verde."
        actions={
          <Link href="/onboarding">
            <Button size="sm" variant="secondary">
              Abrir onboarding
            </Button>
          </Link>
        }
      />
      <CardBody>
        <ul className="space-y-3">
          {blocking.map((check) => (
            <li key={check.code} className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-semibold text-amber-700"
              >
                •
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-zinc-900">{check.message}</span>
                {check.remediation && (
                  <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">
                    {check.remediation}
                  </span>
                )}
                <span className="mt-0.5 block text-2xs text-zinc-400">
                  <code className="font-mono">{check.code}</code>
                </span>
              </span>
              {check.code === 'agent_profile_active' && !hasActiveProfile && (
                <Button size="sm" variant="secondary" onClick={onGoToVersions}>
                  Ir para Versões
                </Button>
              )}
              {check.code === 'channel_policy_resolved' && (
                <Link href="/setup/channels">
                  <Button size="sm" variant="secondary">
                    Configurar
                  </Button>
                </Link>
              )}
              {(check.code === 'whatsapp_line_declared' ||
                check.code === 'whatsapp_line_verified') && (
                <Link href="/setup/channels">
                  <Button size="sm" variant="secondary">
                    Registrar canal
                  </Button>
                </Link>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
