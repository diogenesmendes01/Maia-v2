'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { PageHeader } from '../../components/ui/page-header.js';
import { StatusBadge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Field, Select } from '../../components/ui/field.js';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../components/ui/states.js';
import { IconBot, IconPlus, IconChevronRight } from '../../components/ui/icons.js';

/**
 * Agent hub — the console's center of gravity. One card per agent with the
 * essentials at a glance; everything about an agent is configured from its
 * detail page.
 */
export default function AgentsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? '';
  const sessionTenant = session?.user?.tenant_id ?? '';
  const [tenantId, setTenantId] = React.useState('');
  const effectiveTenant = tenantId || sessionTenant;

  const canManage = role === 'founder' || role === 'owner';

  const tenantsQuery = trpc.tenants.list.useQuery(undefined, {
    enabled: role === 'founder',
  });
  const agentsQuery = trpc.agents.list.useQuery(
    { tenantId: effectiveTenant },
    { enabled: effectiveTenant !== '' },
  );

  if (status === 'loading') return <LoadingState label="Carregando sessão…" />;

  const agents = agentsQuery.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Agentes"
        description="Cada agente é uma identidade operacional versionada: perfil próprio, skills aprendidas e memória isolada por tenant."
        actions={
          canManage && (
            <Link href="/agents/new">
              <Button>
                <IconPlus size={15} />
                Novo agente
              </Button>
            </Link>
          )
        }
      />

      {role === 'founder' && (
        <div className="mb-5 max-w-xs">
          <Field label="Tenant">
            <Select value={effectiveTenant} onChange={(e) => setTenantId(e.target.value)}>
              {sessionTenant && !tenantsQuery.data && (
                <option value={sessionTenant}>{sessionTenant}</option>
              )}
              {(tenantsQuery.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nome} ({t.id})
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {agentsQuery.isLoading ? (
        <LoadingState label="Carregando agentes…" />
      ) : agentsQuery.error ? (
        <ErrorState
          message={agentsQuery.error.message}
          onRetry={() => void agentsQuery.refetch()}
        />
      ) : agents.length === 0 ? (
        <EmptyState
          icon={<IconBot size={36} />}
          title="Nenhum agente neste tenant"
          description="Crie o primeiro agente para começar: o assistente guia você pela identidade, voz e limites de comportamento."
          action={
            canManage && (
              <Link href="/agents/new">
                <Button>
                  <IconPlus size={15} />
                  Criar primeiro agente
                </Button>
              </Link>
            )
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${encodeURIComponent(agent.id)}`}
              className="group rounded-xl border border-zinc-200 bg-white p-5 shadow-card transition-all hover:border-brand-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <IconBot size={20} />
                </span>
                <StatusBadge status={agent.status} />
              </div>
              <p className="mt-3 truncate text-sm font-semibold text-zinc-900">
                {agent.nome}
              </p>
              <p className="truncate font-mono text-xs text-zinc-500">{agent.id}</p>
              <div className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-3 text-xs text-zinc-500">
                <span>
                  criado em {new Date(agent.created_at).toLocaleDateString('pt-BR')}
                </span>
                <span className="flex items-center gap-0.5 font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
                  configurar
                  <IconChevronRight size={13} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
