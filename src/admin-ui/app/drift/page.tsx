'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { StatCard } from '../../components/ui/stat-card.js';
import { LoadingState, ErrorState } from '../../components/ui/states.js';
import DecisionsLog from './_components/decisions-log.js';

export default function DriftPage() {
  const { data: session } = useSession();
  const tenantId = session?.user?.tenant_id ?? '';

  const driftQuery = trpc.drift.listDriftAlerts.useQuery(
    { tenantId, limit: 50 },
    { enabled: tenantId !== '' },
  );
  const incidentsQuery = trpc.drift.listIncidents.useQuery(
    { tenantId, limit: 50 },
    { enabled: tenantId !== '' },
  );

  if (!tenantId) return <LoadingState label="Carregando sessão…" />;

  const pepBlocks = incidentsQuery.data?.pep_blocks.length ?? 0;
  const budgetAlerts = incidentsQuery.data?.budget_alerts.length ?? 0;
  const regressionAlerts = incidentsQuery.data?.regression_alerts.length ?? 0;

  return (
    <div>
      <PageHeader
        title="Drift"
        description="Alertas de drift de identidade (P4), bloqueios PEP, alertas de orçamento e alertas de regressão."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Alertas de drift</h2>
        {driftQuery.isLoading ? (
          <LoadingState label="Carregando alertas…" />
        ) : driftQuery.error ? (
          <ErrorState
            message={driftQuery.error.message}
            onRetry={() => void driftQuery.refetch()}
          />
        ) : (
          <DecisionsLog items={driftQuery.data?.items ?? []} />
        )}
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Incidentes</h2>
        {incidentsQuery.isLoading ? (
          <LoadingState label="Carregando incidentes…" />
        ) : incidentsQuery.error ? (
          <ErrorState
            message={incidentsQuery.error.message}
            onRetry={() => void incidentsQuery.refetch()}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Bloqueios PEP"
              value={pepBlocks}
              tone={pepBlocks > 0 ? 'danger' : 'neutral'}
              hint="depende do P9"
            />
            <StatCard
              label="Alertas de orçamento"
              value={budgetAlerts}
              tone={budgetAlerts > 0 ? 'warning' : 'neutral'}
            />
            <StatCard
              label="Alertas de regressão"
              value={regressionAlerts}
              tone={regressionAlerts > 0 ? 'danger' : 'neutral'}
              hint="depende do P9"
            />
          </div>
        )}
      </section>
    </div>
  );
}
