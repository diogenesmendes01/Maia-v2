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
 *     SENDER FENCE (#292 Codex blocker #4): o predicate `(tenant, agent,
 *     status='pending', created_at < threshold)` sozinho podia reclamar uma
 *     row que o sender NORMAL ainda está processando → risco de double-send.
 *     O caminho de send (outboundMessagesRepo.upsertPending) serializa o claim
 *     de cada turno via `pg_advisory_xact_lock(hashtext(${tenant}:${agent}:
 *     ${idempotency_key}))` — esse advisory lock É o marcador de in-flight do
 *     ledger (não há coluna locked_until; o status='pending' + o advisory lock
 *     do claim são o mecanismo, ver migrations/063_outbound_messages.sql e
 *     repositories.ts upsertPending). O sweeper adquire o MESMO lock por row
 *     com `pg_try_advisory_xact_lock` antes de promover: se um claim concorrente
 *     segura o lock, a row é PULADA neste pass. Combinado com `FOR UPDATE SKIP
 *     LOCKED` (pula a row-lock de um markSent/markFailed concorrente) e o CAS
 *     `status='pending'`, só rows genuinamente presas são promovidas.
 *
 *     PER-TENANT FAIRNESS (#292 Codex blocker #2): a recuperação promove no
 *     MÁXIMO OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT rows por tenant por
 *     pass (ORDER BY created_at ASC → mais antigas primeiro). Um tenant de alto
 *     volume não consome a janela inteira e não starva os demais; o próximo
 *     tick (cada 5 min) drena o resto.
 *
 * (B) RETENTION CLEANUP
 *     Rows terminais (sent/failed/unknown) com age > N dias são DELETADAS.
 *     Sem retention a tabela cresce indefinidamente (1 row/turno).
 *
 *     BOUNDED DELETE (#292 Codex blocker #1): o DELETE roda em chunks de
 *     OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE (DELETE ... WHERE id IN (SELECT ...
 *     LIMIT N)) e itera até um pass retornar 0 rows. Um backlog grande nunca
 *     segura um lock table-wide num único DELETE ilimitado — mesmo padrão de
 *     batched-delete de scripts/reflection-memory-cleanup.ts.
 *
 * SINGLE-FLIGHT (#292 Codex blocker #3): múltiplas instâncias do worker podem
 *   disparar o cron ao mesmo tempo. O sweep inteiro roda sob um advisory lock
 *   GLOBAL (`pg_try_advisory_lock`, namespace dedicado) adquirido num client
 *   dedicado do pool no início e liberado no finally (sucesso E erro). Se o
 *   lock não é adquirido, este pass é PULADO (outra instância já está varrendo).
 *   Mesmo padrão de reflection-batch (#251), mas escopo GLOBAL (o sweep é um
 *   housekeeping single-flight, não per-tenant).
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
 * (C) O QUE ESTE SWEEPER **NÃO** TOCA — issue #633 (fatia D da #506)
 *
 *     Toda consulta abaixo filtra `turn_id IS NULL`, e o predicado é
 *     CORRETIVO, não cosmético.
 *
 *     `outbound_messages` deixou de ser só o ledger do caminho síncrono: a
 *     migração 121 (#630) a evoluiu para o OUTBOX DURÁVEL do turno, e uma row
 *     nova nasce com `status='pending'` e `turn_id NOT NULL`, esperando o
 *     delivery worker (#632). Sem `turn_id IS NULL` na operação (A), este
 *     sweeper promoveria essa row a `'unknown'` cinco minutos depois de ela ser
 *     criada — e `'unknown'` é TERMINAL para o claim de entrega
 *     (`DELIVERY_TERMINAL_STATUSES`), então a resposta NUNCA seria entregue e
 *     ninguém saberia: a row estaria num estado que o contrato legado chama de
 *     "sent_no_persist", isto é, "não re-envie".
 *
 *     Ou seja: o housekeeping do ledger antigo teria virado uma máquina de
 *     perder respostas do ledger novo. As duas coexistem na mesma tabela por
 *     decisão explícita da 121 (uma autoridade só sobre "esta resposta saiu?"),
 *     e o preço dessa decisão é exatamente este predicado.
 *
 *     Quem cuida da row DURÁVEL é `src/workers/outbound-recovery.ts` (#633):
 *     ele rearma, reconcilia e manda para `dead_letter` — nunca promove a
 *     `unknown` por idade.
 *
 * Padrão de fan-out per-tenant: enumera (tenant_id, agent_id) DISTINCT em
 * outbound_messages (que tenham qualquer trabalho a fazer — rows pending
 * antigas OU rows terminais antigas), abre runWithTenantContext por tupla.
 * Espelha #240/#251 (reflection-batch). NÃO assume sentinela 'default'.
 */
import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client.js';
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
 * Namespace seed for the sweep's GLOBAL single-flight advisory lock.
 *
 * #292 Codex blocker #3: distinct from REFLECTION_BATCH_LOCK_NAMESPACE and any
 * other advisory-lock consumer in Maia so the keyspaces never collide. Any
 * stable constant works — it MUST NOT change between deploys, otherwise an
 * acquire on the new key and a release on the old key would not round-trip.
 *
 * The lock is GLOBAL (not per-tenant): the whole sweep is a housekeeping pass
 * that should run on at most one worker instance at a time. We use a fixed key
 * (the namespace itself, hashed via the constant text 'outbound_messages_sweeper')
 * rather than a per-(tenant,agent) key because the dispatcher enumeration +
 * retention loop spans all tenants.
 */
const OUTBOUND_SWEEPER_LOCK_NAMESPACE = 4712_4712n;
const OUTBOUND_SWEEPER_LOCK_KEY = 'outbound_messages_sweeper';

type AcquiredLock = {
  /** Releases the lock and returns the client to the pool. Safe to call multiple times. */
  release: () => Promise<void>;
};

/**
 * Try to acquire the GLOBAL single-flight advisory lock for the sweep.
 *
 * Mirrors src/workers/reflection-batch.ts `tryAcquireTenantLock` exactly, but
 * with a GLOBAL (fixed) key instead of a per-(tenant,agent) key. Holds the lock
 * on a DEDICATED pool client for the lifetime of the sweep; the inner queries
 * still use the shared `db`/pool. Returns `null` when the lock is already held
 * by another worker instance (this pass is skipped) or when even acquiring a
 * client/lock fails (treated as "could not acquire" — the next 5-min tick
 * retries).
 */
async function tryAcquireSweepLock(): Promise<AcquiredLock | null> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'outbound_messages_sweeper.lock_acquire_failed',
    );
    return null;
  }

  let released = false;
  try {
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked`,
      [OUTBOUND_SWEEPER_LOCK_KEY, OUTBOUND_SWEEPER_LOCK_NAMESPACE.toString()],
    );
    const locked = r.rows[0]?.locked === true;
    if (!locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    logger.warn(
      { err: (err as Error).message },
      'outbound_messages_sweeper.lock_acquire_failed',
    );
    return null;
  }

  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, $2))`,
          [OUTBOUND_SWEEPER_LOCK_KEY, OUTBOUND_SWEEPER_LOCK_NAMESPACE.toString()],
        );
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'outbound_messages_sweeper.lock_release_failed',
        );
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Enumera (tenant_id, agent_id) DISTINCT em outbound_messages QUE TÊM
 * trabalho a fazer (uma pending antiga ou uma terminal antiga). Roda
 * OUTSIDE de tenant context — é o dispatcher.
 *
 * Filtra explicitamente tenant_id/agent_id NOT NULL (belt-and-suspenders;
 * o schema já garante via NOT NULL, mas o predicate protege contra futura
 * relaxação de schema — mesmo padrão de #251).
 *
 * EXPORTADA para teste (#633), e a razão é a mesma de `deliverableStatement`
 * em `outbound-recovery-repo.ts`: o predicado `turn_id IS NULL` que a #633
 * acrescentou aqui não é observável pelo entrypoint — remover só dele deixa a
 * tupla ser enumerada, e as outras duas consultas (que ainda filtram) fazem o
 * passe virar no-op. Sem esta porta, a única sonda possível seria sobre o log,
 * que é global e portanto frágil num banco compartilhado. Não é seam de
 * comportamento: nada em produção chama esta função além de
 * `runOutboundMessagesSweeper`.
 */
export async function listTenantsWithWork(
  stalePendingSec: number,
  retentionDays: number,
): Promise<TenantAgentRow[]> {
  const result = await db.execute<TenantAgentRow>(sql`
    SELECT DISTINCT tenant_id, agent_id
    FROM ${outbound_messages}
    WHERE tenant_id IS NOT NULL
      AND agent_id IS NOT NULL
      -- Issue #633: SÓ row LEGADA. Ver o bloco (C) no topo do arquivo.
      AND turn_id IS NULL
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
  recoveryLimitPerTenant: number,
  retentionBatchSize: number,
): Promise<SweepStats> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  // (A) Stale-pending recovery: pending → unknown.
  //
  // BOUNDED + FENCED single statement (#292 blockers #2 + #4):
  //   - `candidates`: stale-pending rows for THIS (tenant, agent), oldest
  //     first, capped at recoveryLimitPerTenant (per-tenant fairness), with
  //     `FOR UPDATE SKIP LOCKED` so a row currently row-locked by a concurrent
  //     markSent/markFailed UPDATE is skipped this pass (no blocking, no race).
  //   - `fenced`: keep only candidates whose per-row sender lock we can grab.
  //     `pg_try_advisory_xact_lock(hashtext(${tenant}:${agent}:${idempotency_key}))`
  //     is the SAME key upsertPending serializes the claim on (repositories.ts
  //     — the advisory lock is the in-flight marker; there is no locked_until
  //     column). If a normal claim holds it RIGHT NOW, we don't promote → zero
  //     double-send. The xact lock auto-releases when this statement's implicit
  //     transaction commits (db.execute is auto-commit), held just long enough
  //     to serialize against a concurrent claim tx.
  //   - The UPDATE then promotes only the fenced rows, re-checking
  //     `status='pending'` (CAS) defensively.
  // RETURNING idempotency_key etc. pra logar cada promoção (ops_alert por row).
  const promotedRows = await db.execute<{
    idempotency_key: string;
    conversa_id: string;
    in_reply_to: string;
    channel: string;
    created_at: Date;
  }>(sql`
    WITH candidates AS (
      SELECT id, idempotency_key
      FROM ${outbound_messages}
      WHERE tenant_id = ${tenant_id}
        AND agent_id = ${agent_id}
        AND status = 'pending'
        -- Issue #633: SÓ row LEGADA. Sem este predicado, uma linha do OUTBOX
        -- DURÁVEL (#630) esperando entrega seria promovida a 'unknown' — que é
        -- TERMINAL para o delivery worker (#632) — e a resposta nunca sairia.
        -- Ver o bloco (C) no topo do arquivo.
        AND turn_id IS NULL
        AND created_at < now() - (${stalePendingSec} || ' seconds')::interval
      ORDER BY created_at ASC
      LIMIT ${recoveryLimitPerTenant}
      FOR UPDATE SKIP LOCKED
    ),
    fenced AS (
      SELECT id
      FROM candidates
      WHERE pg_try_advisory_xact_lock(
        hashtext(${tenant_id} || ':' || ${agent_id} || ':' || idempotency_key)
      )
    )
    UPDATE ${outbound_messages} AS o
    SET status = 'unknown',
        error = COALESCE(o.error, 'sweeper_promoted_stale_pending')
    FROM fenced
    WHERE o.id = fenced.id
      AND o.status = 'pending'
    RETURNING o.idempotency_key, o.conversa_id, o.in_reply_to, o.channel, o.created_at
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
  //
  // BOUNDED batched DELETE (#292 blocker #1): Postgres DELETE não aceita LIMIT
  // direto, então deletamos `id IN (SELECT ... LIMIT N FOR UPDATE SKIP LOCKED)`
  // e iteramos até um pass retornar 0 rows. Cada chunk é seu próprio statement
  // (auto-commit) — um backlog grande nunca segura um lock table-wide num único
  // DELETE ilimitado. Mesmo padrão de scripts/reflection-memory-cleanup.ts.
  // `FOR UPDATE SKIP LOCKED` evita contender com qualquer escrita concorrente
  // na mesma row (terminais raramente são reescritas, mas é belt-and-suspenders).
  let cleaned = 0;
  // Safety bound on the loop: even if something keeps re-inserting old terminal
  // rows, never run more than this many batches in a single tick (the next
  // 5-min tick continues). Generous headroom over any realistic backlog.
  const MAX_RETENTION_BATCHES = 10_000;
  for (let batch = 0; batch < MAX_RETENTION_BATCHES; batch++) {
    const cleanedRows = await db.execute<{ id: string }>(sql`
      DELETE FROM ${outbound_messages}
      WHERE id IN (
        SELECT id
        FROM ${outbound_messages}
        WHERE tenant_id = ${tenant_id}
          AND agent_id = ${agent_id}
          AND status IN ('sent', 'failed', 'unknown')
          -- Issue #633: SÓ row LEGADA. A retenção do outbox DURÁVEL é outro
          -- assunto (#506 §Retenção) e ainda não tem dono; apagar uma linha
          -- durável por este caminho destruiria a trilha do turno.
          AND turn_id IS NULL
          AND created_at < now() - (${retentionDays} || ' days')::interval
        ORDER BY created_at ASC
        LIMIT ${retentionBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `);
    const inThisBatch = cleanedRows.rows.length;
    cleaned += inThisBatch;
    // A short batch (fewer than the cap) means we drained the backlog; a 0-row
    // batch means nothing left. Either way, stop looping.
    if (inThisBatch < retentionBatchSize) break;
  }

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
 * SINGLE-FLIGHT (#292 blocker #3): o sweep inteiro roda sob um advisory lock
 * GLOBAL adquirido no início e liberado no finally (sucesso E erro). Se outra
 * instância do worker já está varrendo, este pass é PULADO.
 *
 * Fail-isolated por tenant: erro em um tenant não interrompe o loop;
 * o run total fica "parcialmente ok" e telemetria distingue via
 * tenants_failed/tenants_processed no `outbound_messages_sweeper.done`.
 */
export async function runOutboundMessagesSweeper(): Promise<void> {
  const stalePendingSec = config.OUTBOUND_SWEEPER_STALE_PENDING_SEC;
  const retentionDays = config.OUTBOUND_SWEEPER_RETENTION_DAYS;
  const recoveryLimitPerTenant =
    config.OUTBOUND_SWEEPER_RECOVERY_LIMIT_PER_TENANT;
  const retentionBatchSize = config.OUTBOUND_SWEEPER_RETENTION_BATCH_SIZE;

  // (#292 blocker #3) Single-flight: only one worker instance sweeps at a time.
  const lock = await tryAcquireSweepLock();
  if (!lock) {
    logger.info(
      { stale_pending_sec: stalePendingSec, retention_days: retentionDays },
      'outbound_messages_sweeper.skipped_locked',
    );
    return;
  }

  try {
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
          runSweepInner(
            stalePendingSec,
            retentionDays,
            recoveryLimitPerTenant,
            retentionBatchSize,
          ),
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
        recovery_limit_per_tenant: recoveryLimitPerTenant,
        retention_batch_size: retentionBatchSize,
      },
      'outbound_messages_sweeper.done',
    );
  } finally {
    // Release the single-flight lock on BOTH success and error.
    await lock.release();
  }
}
