/**
 * Issue #535 — one wiring point for everything this issue adds.
 *
 * `server.ts` already registers five collectors inline and was becoming the
 * de-facto observability bootstrap. Rather than add four more calls there,
 * everything #535 introduces is wired from HERE and `server.ts` gains a single
 * line. The practical payoff: the sources these collectors read (`pg.Pool`,
 * the Baileys socket, the scheduler tables) are imported lazily inside this
 * module, so importing the taxonomy or the label gate still does not drag the
 * driver, the WhatsApp stack or the DB client into a unit test.
 */
import { logger } from '@/lib/logger.js';
import { registerBackupReadinessGauges } from './backup-readiness-collector.js';
import { registerMigrationGauges } from './migration-collector.js';
import { registerOnboardingExpiryGauges } from './onboarding-expiry-collector.js';
import { startOtlpExporter } from './otlp-exporter.js';
import { registrarSeriesDeStream } from '@/runtime/turns/stream-metrics.js';
import {
  registerDbPoolGauges,
  registerSchedulerLagGauges,
  registerWhatsAppSessionGauges,
  type SchedulerLagEntry,
} from './runtime-collectors.js';

/**
 * Cross-tenant scheduler backlog, one query for both queues.
 *
 * Deliberately NOT routed through `scheduling/repos.ts`: every method there is
 * ALS-scoped by `tenant_id + agent_id` (correctly — they run inside a tenant's
 * tick), and a scrape has no tenant. This is the same sanctioned shape as
 * `turnRepos.snapshotLiveTurnStates()`: a cross-tenant aggregate whose scope
 * lives in the GROUP BY rather than in a WHERE over ALS, returning ONLY counts
 * and ages. No row id, no payload and no tenant identifier leaves the query,
 * so the aggregate cannot become a cross-tenant read of anyone's data.
 *
 * `status = 'pending' AND <due column> <= now()` is exactly the predicate the
 * claim queries use (`occurrencesRepo.claimDue`, `outboxRepo.claimDue`), so
 * the lag measures the same rows the workers would pick up — not rows that are
 * merely scheduled for the future.
 */
async function schedulerLagSnapshot(): Promise<SchedulerLagEntry[]> {
  const { db } = await import('@/db/client.js');
  const { sql } = await import('drizzle-orm');
  const result = await db.execute<{ queue: string; backlog: string; lag_ms: string }>(sql`
    SELECT 'occurrences' AS queue,
           count(*)::text AS backlog,
           COALESCE(
             EXTRACT(EPOCH FROM (now() - min(scheduled_for))) * 1000, 0
           )::text AS lag_ms
      FROM occurrences
     WHERE status = 'pending' AND scheduled_for <= now()
    UNION ALL
    SELECT 'outbox' AS queue,
           count(*)::text AS backlog,
           COALESCE(
             EXTRACT(EPOCH FROM (now() - min(next_attempt_at))) * 1000, 0
           )::text AS lag_ms
      FROM outbox_messages
     WHERE status = 'pending' AND next_attempt_at <= now()
  `);
  return Array.from(result.rows as unknown as Array<{
    queue: string;
    backlog: string;
    lag_ms: string;
  }>).map((r) => ({
    queue: r.queue,
    backlog: Number(r.backlog),
    lag_ms: Math.max(0, Math.round(Number(r.lag_ms))),
  }));
}

/**
 * Register the #535 collectors and start the OTLP exporter.
 *
 * Idempotent and inert-by-default: every collector below is a scrape-time
 * provider keyed by series name (re-registering replaces, never stacks), and
 * the exporter returns without starting anything when
 * `MAIA_OTLP_TRACES_ENDPOINT` is unset.
 */
export async function registerRuntimeObservability(): Promise<void> {
  try {
    const { pool } = await import('@/db/client.js');
    registerDbPoolGauges(pool);
  } catch (err) {
    logger.debug({ err }, 'observability.db_pool_gauges_failed');
  }

  try {
    const { isBaileysConnected, getLastDisconnectAt } = await import('@/gateway/baileys.js');
    registerWhatsAppSessionGauges({
      connected: isBaileysConnected,
      lastDisconnectAt: getLastDisconnectAt,
    });
  } catch (err) {
    logger.debug({ err }, 'observability.whatsapp_session_gauges_failed');
  }

  registerSchedulerLagGauges(schedulerLagSnapshot);

  // Issue #626 (fatia C da #505) — PUBLICA em zero as séries do escalonamento
  // por stream. Não é um coletor: é uma semeadura, e ela existe porque
  // `src/lib/metrics.ts` cria a série na PRIMEIRA incrementação. Uma métrica
  // que (corretamente) nunca é incrementada não aparece em `/metrics`, e o
  // critério de pronto da issue — "`maia_stream_fifo_violation_total` existe e
  // é sempre zero" — seria satisfeito por uma AUSÊNCIA, contra a qual nenhum
  // alerta dispara nunca. É a forma mais silenciosa de um alerta falhar, e ela
  // se parece exatamente com sucesso.
  //
  // Aqui, e não no import de `stream-metrics.ts`: aquele módulo é alcançado por
  // `turn-repos.ts`, e um efeito de topo num módulo de repositório roda dentro
  // do `import` de qualquer spec que mocke `@/lib/metrics.js` — o arquivo
  // inteiro deixa de carregar, com um erro que não aponta para a causa.
  registrarSeriesDeStream();

  // Issue #536 — the restore-drill gate. `maia_restore_drill_check_level` goes
  // to 2 when the newest drill in `restore_drills` is older than
  // `BACKUP_RESTORE_DRILL_INTERVAL_HOURS`, when it failed, or (in production)
  // when no drill has ever run. Read at SCRAPE time, from the evidence tables,
  // so the level ages out even if the `restore_drill` worker itself stops —
  // which is the failure the gate exists to catch. Everything it needs is
  // imported lazily, for the same reason the collectors above are.
  registerBackupReadinessGauges({
    now: () => new Date(),
    readFacts: async () => {
      const { readReadinessFacts } = await import('@/db/repositories/ops-repos.js');
      return readReadinessFacts();
    },
    resolveProfile: async () => {
      const { backupProfile } = await import('@/ops/backup/config-input.js');
      return backupProfile();
    },
  });

  // Issue #519 — o backlog do `onboarding_expirer`. Lido no SCRAPE, do banco,
  // pelo mesmo motivo do gate acima: uma fila publicada pelo worker congela no
  // último valor quando o worker para, que é a falha que a série existe para
  // pegar. O agregado vem do repositório (`snapshotExpiryBacklog`), com o mesmo
  // predicado que a varredura usa e devolvendo só números — a forma sancionada
  // de agregado cross-tenant, igual a `turnRepos.snapshotLiveTurnStates()`.
  registerOnboardingExpiryGauges(async () => {
    const { onboardingRunsRepo } = await import('@/db/repositories/onboarding-repos.js');
    return onboardingRunsRepo.snapshotExpiryBacklog();
  });

  // Issue #516 §Observabilidade — head esperado vs. aplicado, pendentes, dirty
  // e duração da última execução. Lido no SCRAPE, do veredito CANÔNICO
  // (`getSchemaReadiness`), nunca de uma re-derivação: `checkSchemaReadiness()`
  // é o mesmo adaptador cacheado que o `/readyz` consome, então a métrica e o
  // gate não podem divergir — se divergissem, o dashboard estaria explicando um
  // 503 que ele mesmo não vê.
  registerMigrationGauges({
    readVerdict: async () => {
      const { checkSchemaReadiness } = await import('@/runtime/lifecycle/schema-readiness.js');
      return checkSchemaReadiness();
    },
  });

  startOtlpExporter();
}

/** Exposed for tests — the SQL snapshot without the registration side effect. */
export const _schedulerLagSnapshot = schedulerLagSnapshot;
