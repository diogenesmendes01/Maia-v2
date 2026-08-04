/**
 * Issue #519 §5 — o LOADER dos fatos de readiness. Toda a lógica de decisão
 * vive em `readiness.ts` (pura); aqui só existe I/O.
 *
 * Duas escolhas deliberadas:
 *
 * 1. **Escopo EXPLÍCITO, não ALS.** Os repos tenant-scoped leem o par corrente
 *    do AsyncLocalStorage, o que é certo para o turno do agente e errado aqui:
 *    o doctor (#517) e o console avaliam a prontidão de um par ARBITRÁRIO, que
 *    não é o par sob o qual o processo está rodando. Envolver tudo em
 *    `runWithTenantContext` funcionaria, mas esconderia o escopo dentro de um
 *    contexto implícito no exato módulo cuja razão de existir é PROVAR escopo.
 *    Aqui o `(tenant_id, agent_id)` aparece literalmente em cada `WHERE`.
 *
 * 2. **O loader não é confiável por construção.** Os fatos carregam o escopo
 *    DONO de cada objeto e o avaliador puro re-verifica. Se um `WHERE` aqui
 *    regredir, o avaliador descarta o objeto de escopo errado em vez de
 *    compor um falso "pronto".
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  agent_drift_alerts,
  agent_operational_profile_versions,
  agent_tool_grants,
  agents,
  channel_line_state,
  channel_policies,
  channels,
  roles,
  tenants,
} from '@/db/schema.js';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import { logger } from '@/lib/logger.js';
import type { ReadinessFacts } from './readiness.js';

/**
 * Migrations aplicadas vs. presentes no disco.
 *
 * Fail-closed: se a leitura falhar (tabela ausente numa instalação zerada,
 * diretório inacessível), devolvemos a lista de arquivos INTEIRA como
 * pendente. Um erro aqui não pode virar "schema pronto" — seria a via mais
 * curta para ativar um agente contra um banco desatualizado.
 */
export async function loadSchemaState(): Promise<{
  applied_migrations: string[];
  pending_migrations: string[];
}> {
  let onDisk: string[];
  try {
    onDisk = (await readdir(join(process.cwd(), 'migrations')))
      .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
      .sort();
  } catch (err) {
    logger.warn({ err }, 'onboarding.readiness.migrations_dir_unreadable');
    // Sem lista de arquivos não há como afirmar nada; devolvemos um pendente
    // sintético para que `schema_ready` reprove.
    return { applied_migrations: [], pending_migrations: ['<migrations-dir-unreadable>'] };
  }

  try {
    const rows = await db.execute<{ id: string }>(sql`SELECT id FROM schema_migrations`);
    const applied = new Set((rows.rows ?? []).map((r) => r.id));
    return {
      applied_migrations: onDisk.filter((f) => applied.has(f)),
      pending_migrations: onDisk.filter((f) => !applied.has(f)),
    };
  } catch (err) {
    logger.warn({ err }, 'onboarding.readiness.schema_migrations_unreadable');
    return { applied_migrations: [], pending_migrations: onDisk };
  }
}

export async function loadReadinessFactsFromDb(scope: {
  tenant_id: string;
  agent_id: string;
}): Promise<ReadinessFacts> {
  const { tenant_id, agent_id } = scope;

  const [tenantRows, agentRows, profileRows, grantRows, roleRows, channelRows, policyRows, driftRows, schema] =
    await Promise.all([
      db.select().from(tenants).where(eq(tenants.id, tenant_id)).limit(1),
      // O agente é buscado por id APENAS — de propósito. Filtrar por
      // `tenant_id` aqui esconderia o caso "o agente existe mas é de outro
      // tenant" como "não existe", e o operador perderia o diagnóstico que
      // mais importa. O avaliador puro tem um check dedicado (`agent_belongs_to_tenant`).
      db.select().from(agents).where(eq(agents.id, agent_id)).limit(1),
      db
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .limit(1),
      db
        .select()
        .from(agent_tool_grants)
        .where(
          and(eq(agent_tool_grants.tenant_id, tenant_id), eq(agent_tool_grants.agent_id, agent_id)),
        )
        .limit(1),
      db
        .select()
        .from(roles)
        .where(and(eq(roles.tenant_id, tenant_id), eq(roles.agent_id, agent_id))),
      db
        .select({
          id: channels.id,
          tenant_id: channels.tenant_id,
          agent_id: channels.agent_id,
          channel_type: channels.channel_type,
          active: channels.active,
          is_synthetic: channels.is_synthetic,
          line_state: channel_line_state.state,
        })
        .from(channels)
        // O par (tenant, agente) entra no ON, não só no WHERE. `channel_id` é
        // PK de `channel_line_state`, então hoje o join já é 1:1 e não poderia
        // cruzar escopo; mas `channel_line_state` REPLICA (tenant_id, agent_id)
        // sem FK composta (`migrations/103_channel_line_state.sql:28`), e uma
        // linha replicada divergente é precisamente o que o avaliador puro
        // trata como fato de outro dono. Casar o escopo no ON faz a divergência
        // virar `line_state = NULL` (posse NÃO provada, fail-closed) em vez de
        // um estado herdado de outro escopo. Invariante 1 do AGENTS.md.
        .leftJoin(
          channel_line_state,
          and(
            eq(channel_line_state.channel_id, channels.id),
            eq(channel_line_state.tenant_id, tenant_id),
            eq(channel_line_state.agent_id, agent_id),
          ),
        )
        .where(and(eq(channels.tenant_id, tenant_id), eq(channels.agent_id, agent_id))),
      db
        .select()
        .from(channel_policies)
        .where(
          and(
            eq(channel_policies.tenant_id, tenant_id),
            eq(channel_policies.agent_id, agent_id),
          ),
        ),
      // Pendência de governança bloqueante = alerta de drift CRÍTICO ainda não
      // resolvido para este (tenant, agente).
      db
        .select({ id: agent_drift_alerts.id })
        .from(agent_drift_alerts)
        .where(
          and(
            eq(agent_drift_alerts.tenant_id, tenant_id),
            eq(agent_drift_alerts.agent_id, agent_id),
            eq(agent_drift_alerts.severity, 'critical'),
            isNull(agent_drift_alerts.resolved_at),
          ),
        ),
      loadSchemaState(),
    ]);

  const tenant = tenantRows[0];
  const agent = agentRows[0];
  const profile = profileRows[0];
  const grant = grantRows[0];

  return {
    requested: { tenant_id, agent_id },
    tenant: tenant ? { id: tenant.id, status: tenant.status } : null,
    agent: agent ? { id: agent.id, tenant_id: agent.tenant_id, status: agent.status } : null,
    profile: profile
      ? {
          id: profile.id,
          tenant_id: profile.tenant_id,
          agent_id: profile.agent_id,
          version: profile.version,
          status: profile.status,
        }
      : null,
    tool_grant: grant
      ? {
          tenant_id: grant.tenant_id,
          agent_id: grant.agent_id,
          granted_packs: grant.granted_packs,
          granted_tools: grant.granted_tools,
          denied_tools: grant.denied_tools,
        }
      : null,
    roles: roleRows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      agent_id: r.agent_id,
      role_key: r.role_key,
      active: r.active,
      is_default: r.is_default,
    })),
    channels: channelRows.map((c) => ({
      id: c.id,
      tenant_id: c.tenant_id,
      agent_id: c.agent_id,
      channel_type: c.channel_type,
      active: c.active,
      is_synthetic: c.is_synthetic,
      line_state: c.line_state ?? null,
    })),
    policies: policyRows.map((p) => ({
      id: p.id,
      tenant_id: p.tenant_id,
      agent_id: p.agent_id,
      channel_id: p.channel_id,
      default_role_id: p.default_role_id,
    })),
    required_packs: [...BASE_AGENT_PACKS],
    schema,
    blocking_governance_items: driftRows.length,
  };
}
