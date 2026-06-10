'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { StatCard } from '../../components/ui/stat-card.js';
import { Card, CardHeader, CardBody } from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../components/ui/states.js';
import { IconPlus, IconChevronRight } from '../../components/ui/icons.js';

/**
 * Landing screen: the operator's pulse check. KPIs link straight to the
 * screen where the work happens — pending approvals being the loudest.
 */
export default function DashboardPage() {
  const { data: session, status } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const summaryQuery = trpc.dashboard.summary.useQuery(
    { tenantId },
    { enabled: tenantId !== '', refetchInterval: 60_000 },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;
  if (summaryQuery.isLoading) return <LoadingState label="Carregando visão geral…" />;
  if (summaryQuery.error)
    return (
      <ErrorState
        message={summaryQuery.error.message}
        onRetry={() => void summaryQuery.refetch()}
      />
    );

  const data = summaryQuery.data;
  if (!data) return null;

  const byType = Object.entries(data.proposals.by_type ?? {});

  return (
    <div>
      <PageHeader
        title="Visão geral"
        description={
          <>
            Pulso operacional do tenant <code className="font-mono">{tenantId}</code>.
          </>
        }
        actions={
          <Link href="/agents/new">
            <Button variant="secondary">
              <IconPlus size={15} />
              Novo agente
            </Button>
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Aprovações pendentes"
          value={data.proposals.total}
          tone={data.proposals.total > 0 ? 'warning' : 'success'}
          hint="propostas aguardando decisão"
          href="/inbox"
        />
        <StatCard
          label="Alertas de drift"
          value={data.drift_alerts.open}
          tone={data.drift_alerts.open > 0 ? 'danger' : 'success'}
          hint="desvios de comportamento abertos"
          href="/drift"
        />
        <StatCard
          label="Agentes ativos"
          value={`${data.agents.active}/${data.agents.total}`}
          tone="brand"
          hint="ativos / total no tenant"
          href="/agents"
        />
        <StatCard
          label="Canais ativos"
          value={data.channels.active}
          tone="neutral"
          hint="conexões entregando mensagens"
          href="/setup/channels"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Propostas pendentes por tipo"
            description="Clique para revisar na fila de aprovações."
            actions={
              <Link
                href="/inbox"
                className="flex items-center gap-0.5 text-xs font-medium text-brand-600 hover:text-brand-700"
              >
                Ver fila
                <IconChevronRight size={13} />
              </Link>
            }
          />
          <CardBody className="p-0">
            {byType.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-zinc-500">
                Nenhuma proposta pendente. Tudo em dia. ✓
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {byType.map(([type, count]) => (
                  <li key={type}>
                    <Link
                      href="/inbox"
                      className="flex items-center justify-between px-5 py-3 text-sm transition-colors hover:bg-zinc-50"
                    >
                      <span className="font-mono text-xs text-zinc-700">{type}</span>
                      <Badge tone="warning">{String(count)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Atalhos"
            description="O ciclo diário de operação da plataforma."
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-zinc-100 text-sm">
              {[
                {
                  href: '/agents',
                  label: 'Configurar agentes',
                  hint: 'perfil, voz, prioridades e princípios',
                },
                {
                  href: '/inbox',
                  label: 'Revisar aprovações',
                  hint: 'propostas de skills, regras e identidade',
                },
                {
                  href: '/drift',
                  label: 'Acompanhar drift',
                  hint: 'desvios entre perfil e comportamento observado',
                },
                {
                  href: '/traces',
                  label: 'Investigar traces',
                  hint: 'execução turno a turno de cada conversa',
                },
              ].map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="group flex items-center justify-between px-5 py-3 transition-colors hover:bg-zinc-50"
                  >
                    <span>
                      <span className="font-medium text-zinc-800">{item.label}</span>
                      <span className="block text-xs text-zinc-500">{item.hint}</span>
                    </span>
                    <IconChevronRight
                      size={14}
                      className="text-zinc-300 transition-colors group-hover:text-brand-600"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      {data.agents.total === 0 && (
        <div className="mt-6">
          <EmptyState
            title="Comece criando seu primeiro agente"
            description="Um agente é uma identidade operacional versionada: defina papel, voz e limites — o resto evolui sob governança."
            action={
              <Link href="/agents/new">
                <Button>
                  <IconPlus size={15} />
                  Criar agente
                </Button>
              </Link>
            }
          />
        </div>
      )}
    </div>
  );
}
