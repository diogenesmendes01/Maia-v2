/**
 * Issue #292 — outbound_messages sweeper (follow-up de #227 / PR #233).
 *
 * Two operations per tick, both scoped per (tenant_id, agent_id):
 *
 * (A) STALE-PENDING RECOVERY
 *     Rows com status='pending' E created_at < now() - cutoff são PROMOVIDAS
 *     a status='unknown' (terminal per #233's contract). Cobre as duas
 *     classes de risco residual identificadas em #233:
 *       - markSent lança exceção (DB indisponível pós-ACK do provider) →
 *         row fica pending indefinida.
 *       - Crash de processo / network blip ENTRE o ACK do provider e a
 *         chamada de markSent → row fica pending (não capturável por
 *         try/catch — é crash, não throw).
 *
 *     Trade-off explícito: promover a 'unknown' (boundary guard trata como
 *     'sent_no_persist' → NÃO re-envia) troca um sliver de risco de silêncio
 *     (caso a row tivesse sido 'failed' se markSent tivesse rodado) por zero
 *     double-send. É a mesma escolha conservadora que o output-dispatch já
 *     faz no caminho de erro ambíguo.
 *
 *     Defesa-em-profundidade — a chave única (`${conversa_id}:${in_reply_to}`)
 *     já garante na prática que uma pending órfã só bloqueia O MESMO turno
 *     (que não deveria reentrar). O sweeper é housekeeping + observabilidade.
 *
 * (B) RETENTION CLEANUP
 *     Rows terminais (sent/failed/unknown) com age > N dias são DELETADAS.
 *     Sem retention a tabela cresce indefinidamente (1 row/turno).
 *
 * Audit/observabilidade:
 *   - Cada promoção emite `outbound_ledger.sweeper_promoted_pending_to_unknown`
 *     com ops_alert:true (estes são SEMPRE indicação de algo errado — markSent
 *     crashou ou processo crashou pós-ACK).
 *   - Cleanup emite `outbound_ledger.sweeper_cleaned_terminal` com ops_alert:
 *     true por tenant (housekeeping; ops_alert pra dar visibilidade mas a
 *     cadência é esperada — é por isso que o ledger não loga por row, só
 *     resume agregado).
 *
 * Métricas:
 *   - maia_outbound_ledger_sweeper_promoted_total{tenant_id,agent_id}
 *   - maia_outbound_ledger_sweeper_cleaned_total{tenant_id,agent_id}
 *
 * Padrão de fan-out per-tenant: enumera (tenant_id, agent_id) DISTINCT em
 * outbound_messages (que tenham qualquer trabalho a fazer — rows pending
 * antigas OU rows terminais antigas), abre runWithTenantContext por tupla.
 * Espelha #240/#251 (reflection-batch). NÃO assume sentinela 'default'.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { outbound_messages } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';
import { incCounter } from '@/lib/metrics.js';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';

type TenantAgentRow = { tenant_id: string; agent_id: string };

/**
 * Enumera (tenant_id, agent_id) DISTINCT em outbound_messages QUE TÊM
 * trabalho a fazer (uma pending antiga ou uma terminal antiga). Roda
 * OUTSIDE de tenant context — é o dispatcher.
 *
 * Filtra explicitamente tenant_id/agent_id NOT NULL (belt-and-suspenders;
 * o schema já garante via NOT NULL, mas o predicate protege contra futura
 * relaxação de schema — mesmo padrão de #251).
 */
async function listTenantsWithWork(
  stalePendingSec: number,
  retentionDays: number,
): Promise<TenantAgentRow[]> {
  const result = await db.execute<TenantAgentRow>(sql`
    SELECT DISTINCT tenant_id, agent_id
    FROM ${outbound_messages}
    WHERE tenant_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND (
        (status = 'pending' AND created_at < now() - (${stalePendingSec} || ' seconds')::interval)
        OR (status IN ('sent', 'failed', 'unknown') AND created_at < now() - (${retentionDays} || ' days')::interval)
      )
  `);
  return Array.from(result.rows as unknown as TenantAgentRow[]);
}

type SweepStats = {
  promoted: number;
  cleaned: number;
};

/**
 * Per-tenant sweep. ASSUME caller já abriu runWithTenantContext para
 * (tenant_id, agent_id) — todas as queries filtram explicitamente por
 * essa tupla (defense-in-depth contra um futuro bug do dispatcher).
 */
async function runSweepInner(
  stalePendingSec: number,
  retentionDays: number,
): Promise<SweepStats> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  // (A) Stale-pending recovery: pending → unknown.
  // RETURNING idempotency_key pra logar cada promoção (ops_alert por row).
  const promotedRows = await db.execute<{
    idempotency_key: string;
    conversa_id: string;
    in_reply_to: string;
    channel: string;
    created_at: Date;
  }>(sql`
    UPDATE ${outbound_messages}
    SET status = 'unknown',
        error = COALESCE(error, 'sweeper_promoted_stale_pending')
    WHERE tenant_id = ${tenant_id}
      AND agent_id = ${agent_id}
      AND status = 'pending'
      AND created_at < now() - (${stalePendingSec} || ' seconds')::interval
    RETURNING idempotency_key, conversa_id, in_reply_to, channel, created_at
  `);

  for (const row of promotedRows.rows) {
    // ops_alert por promoção: cada pending órfã indica falha de markSent
    // (DB blip pós-ACK) ou crash de processo (network blip pós-ACK).
    // Em produção normal isso deve ser 0/raro — log granular ajuda ops a
    // correlacionar com incidentes específicos.
    logger.warn(
      {
        tenant_id,
        agent_id,
        idempotency_key: row.idempotency_key,
        conversa_id: row.conversa_id,
        in_reply_to: row.in_reply_to,
        channel: row.channel,
        created_at: row.created_at,
        ops_alert: true,
      },
      'outbound_ledger.sweeper_promoted_pending_to_unknown',
    );
  }

  const promoted = promotedRows.rows.length;
  if (promoted > 0) {
    incCounter(
      'maia_outbound_ledger_sweeper_promoted_total',
      { tenant_id, agent_id },
      promoted,
    );
  }

  // (B) Retention cleanup: terminais antigas → DELETE.
  // Mesma query, scoped por tenant+agent. RETURNING count via execute.
  const cleanedRows = await db.execute<{ id: string }>(sql`
    DELETE FROM ${outbound_messages}
    WHERE tenant_id = ${tenant_id}
      AND agent_id = ${agent_id}
      AND status IN ('sent', 'failed', 'unknown')
      AND created_at < now() - (${retentionDays} || ' days')::interval
    RETURNING id
  `);
  const cleaned = cleanedRows.rows.length;
  if (cleaned > 0) {
    incCounter(
      'maia_outbound_ledger_sweeper_cleaned_total',
      { tenant_id, agent_id },
      cleaned,
    );
    // Agregado por tenant (housekeeping); ops_alert pra surfaçar no
    // dashboard mas sem flood — cleanup acontece todo tick, é esperado.
    logger.warn(
      {
        tenant_id,
        agent_id,
        cleaned,
        retention_days: retentionDays,
        ops_alert: true,
      },
      'outbound_ledger.sweeper_cleaned_terminal',
    );
  }

  return { promoted, cleaned };
}

/**
 * Worker entrypoint. Dispatcher per-tenant — mesmo padrão de
 * reflection-batch (#240/#251). Cron registrado em src/workers/index.ts.
 *
 * Fail-isolated por tenant: erro em um tenant não interrompe o loop;
 * o run total fica "parcialmente ok" e telemetria distingue via
 * tenants_failed/tenants_processed no `outbound_messages_sweeper.done`.
 */
export async function runOutboundMessagesSweeper(): Promise<void> {
  const stalePendingSec = config.OUTBOUND_SWEEPER_STALE_PENDING_SEC;
  const retentionDays = config.OUTBOUND_SWEEPER_RETENTION_DAYS;

  const tenants = await listTenantsWithWork(stalePendingSec, retentionDays);

  if (tenants.length === 0) {
    logger.debug(
      { stale_pending_sec: stalePendingSec, retention_days: retentionDays },
      'outbound_messages_sweeper.idle',
    );
    return;
  }

  let totalPromoted = 0;
  let totalCleaned = 0;
  let tenantsProcessed = 0;
  let tenantsFailed = 0;

  for (const { tenant_id, agent_id } of tenants) {
    try {
      const stats = await runWithTenantContext({ tenant_id, agent_id }, () =>
        runSweepInner(stalePendingSec, retentionDays),
      );
      totalPromoted += stats.promoted;
      totalCleaned += stats.cleaned;
      tenantsProcessed++;
    } catch (err) {
      // Fail-isolated: erro de um tenant não derruba o sweeper.
      tenantsFailed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'outbound_messages_sweeper.tenant_failed',
      );
    }
  }

  logger.info(
    {
      tenants: tenants.length,
      tenants_processed: tenantsProcessed,
      tenants_failed: tenantsFailed,
      promoted: totalPromoted,
      cleaned: totalCleaned,
      stale_pending_sec: stalePendingSec,
      retention_days: retentionDays,
    },
    'outbound_messages_sweeper.done',
  );
}
