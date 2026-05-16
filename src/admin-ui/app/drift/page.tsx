'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
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

  if (!tenantId) return <p>Loading session...</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Drift &amp; Incidents</h1>
        <p className="text-sm text-gray-600">
          Identity drift alerts (P4) + PEP blocks + budget alerts + regression alerts.
        </p>
      </header>

      <section>
        <h2 className="font-semibold mb-2">Drift alerts</h2>
        {driftQuery.isLoading ? (
          <p>Loading...</p>
        ) : (
          <DecisionsLog items={driftQuery.data?.items ?? []} />
        )}
      </section>

      <section>
        <h2 className="font-semibold mb-2">Incidents</h2>
        {incidentsQuery.isLoading ? (
          <p>Loading...</p>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            <IncidentCard
              title="PEP blocks"
              count={incidentsQuery.data?.pep_blocks.length ?? 0}
              note="depends on P9"
            />
            <IncidentCard
              title="Budget alerts"
              count={incidentsQuery.data?.budget_alerts.length ?? 0}
              note=""
            />
            <IncidentCard
              title="Regression alerts"
              count={incidentsQuery.data?.regression_alerts.length ?? 0}
              note="depends on P9"
            />
          </div>
        )}
      </section>
    </div>
  );
}

function IncidentCard({ title, count, note }: { title: string; count: number; note: string }) {
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-sm text-gray-600">{title}</div>
      <div className="text-3xl font-bold">{count}</div>
      {note && <div className="text-xs text-gray-500 mt-1">{note}</div>}
    </div>
  );
}
