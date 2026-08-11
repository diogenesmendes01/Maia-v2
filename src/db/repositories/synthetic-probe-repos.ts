/**
 * Sonda sintética (spec §1.5/§1.6) — estado DURÁVEL em Postgres.
 *
 * Todos os métodos são EXPLICITAMENTE cross-context (args diretos / literais da
 * sonda, sem ALS): o gauge de `/metrics` (§1.6) é lido no scrape SEM contexto
 * de tenant, e o worker roda sob `runWithSystemContext`. Escopar por
 * `getCurrentTenant()` aqui quebraria essas leituras. O escopo está SEMPRE no
 * WHERE por construção (tenant_id/agent_id da sonda), então não bypassamos
 * isolamento — carregamos o escopo completo.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { synthetic_probe_runs, synthetic_probe_state, channels, transacoes } from '../schema.js';
import { PRIMARY_TENANT_ID } from '../tenant-context.js';
import type { SyntheticProbeState } from '../schema.js';

export type ProbeOutcome = 'ok' | 'slow' | 'wrong' | 'silent' | 'error';

/** Escopo (tenant, agent) da sonda — aplicado em TODO WHERE (isolamento). */
export type ProbeScope = { tenant_id: string; agent_id: string };

/** Resultado da validação fail-fast de boot (§1.3). */
export type ChannelSyntheticCheck =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_synthetic' | 'primary_tenant' };

/** Resultado do guard de prontidão por tick (§1.2, review): exige ATIVO. */
export type ChannelReadyCheck =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_synthetic' | 'primary_tenant' | 'inactive' };

export const syntheticProbeRepo = {
  /**
   * Boot fail-fast (§1.3): o canal do triplete configurado existe e é
   * EXCLUSIVAMENTE sintético (is_synthetic=true, tenant ≠ primary)? O canal
   * pode (e deve) estar INATIVO no boot — a ativação é um passo operacional
   * posterior (§1.2); inatividade NÃO é motivo de falha de boot (o guard de
   * prontidão por tick, `channelReady`, é que exige ativo).
   */
  async checkChannelSynthetic(scope: {
    tenant_id: string;
    agent_id: string;
    channel_id: string;
  }): Promise<ChannelSyntheticCheck> {
    const rows = await db
      .select({ is_synthetic: channels.is_synthetic, tenant_id: channels.tenant_id })
      .from(channels)
      .where(
        and(
          eq(channels.id, scope.channel_id),
          eq(channels.tenant_id, scope.tenant_id),
          eq(channels.agent_id, scope.agent_id),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (!row.is_synthetic) return { ok: false, reason: 'not_synthetic' };
    if (row.tenant_id === PRIMARY_TENANT_ID) return { ok: false, reason: 'primary_tenant' };
    return { ok: true };
  },

  /**
   * Guard de prontidão POR TICK (§1.2, correção do review — alta): o canal
   * precisa estar ATIVO + is_synthetic + tenant ≠ primary para o exact-match
   * resolver a injeção para o canal de sonda. Se estiver INATIVO, o
   * `resolveChannel` cai no `resolveLegacy` (catch-all `primary/primary` no
   * runtime mono-tenant) e a sonda injetaria num tenant REAL — com o sink SEM
   * casar (escopo ≠ triplete de sonda). O boot fail-fast (que aceita inativo)
   * não cobre desativação POSTERIOR; por isso a checagem é a cada tick, e o
   * worker FALHA FECHADO (não injeta) quando não está pronto.
   */
  async channelReady(scope: {
    tenant_id: string;
    agent_id: string;
    channel_id: string;
  }): Promise<ChannelReadyCheck> {
    const rows = await db
      .select({
        is_synthetic: channels.is_synthetic,
        tenant_id: channels.tenant_id,
        active: channels.active,
      })
      .from(channels)
      .where(
        and(
          eq(channels.id, scope.channel_id),
          eq(channels.tenant_id, scope.tenant_id),
          eq(channels.agent_id, scope.agent_id),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (!row.is_synthetic) return { ok: false, reason: 'not_synthetic' };
    if (row.tenant_id === PRIMARY_TENANT_ID) return { ok: false, reason: 'primary_tenant' };
    if (!row.active) return { ok: false, reason: 'inactive' };
    return { ok: true };
  },

  /**
   * Todos os `channels.id` marcados `is_synthetic=true` — carregado no boot
   * (sempre, review P1-C) para o gate do sink neutralizar o outbound desses
   * canais INDEPENDENTE da flag. Cross-tenant (sem ALS): roda no boot.
   */
  async listSyntheticChannelIds(): Promise<string[]> {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.is_synthetic, true));
    return rows.map((r) => r.id);
  },

  /**
   * Ativa/desativa o canal de sonda ATOMICAMENTE (review P1-B): o predicado do
   * UPDATE EXIGE `is_synthetic=true` + tenant ≠ primary (proteção não é uma
   * pré-checagem separada) e o RETURNING valida que a row foi de fato mexida.
   * Devolve o novo estado ou `null` se nada casou (não-sintético / inexistente).
   */
  async setChannelActive(
    scope: { tenant_id: string; agent_id: string; channel_id: string },
    active: boolean,
  ): Promise<{ active: boolean } | null> {
    const rows = await db
      .update(channels)
      .set({ active, updated_at: new Date() })
      .where(
        and(
          eq(channels.id, scope.channel_id),
          eq(channels.tenant_id, scope.tenant_id),
          eq(channels.agent_id, scope.agent_id),
          // is_synthetic no PREDICADO (atômico) — nunca ativa um canal real,
          // mesmo que o scope aponte por engano para um tenant/canal comum.
          eq(channels.is_synthetic, true),
        ),
      )
      .returning({ active: channels.active });
    return rows[0] ?? null;
  },

  // ── runs ─────────────────────────────────────────────────────────────────

  async createRun(input: {
    tenant_id: string;
    agent_id: string;
    channel_id: string;
    scenario: string;
    whatsapp_id: string;
  }): Promise<string> {
    const [row] = await db
      .insert(synthetic_probe_runs)
      .values({
        tenant_id: input.tenant_id,
        agent_id: input.agent_id,
        channel_id: input.channel_id,
        scenario: input.scenario,
        whatsapp_id: input.whatsapp_id,
      })
      .returning({ id: synthetic_probe_runs.id });
    return row!.id;
  },

  // Escopo COMPLETO (tenant+agent) em TODO WHERE das rows de run (correção do
  // review — alta): o UUID do run é único, mas escopar é defense-in-depth
  // contra qualquer row indevido de outra dupla mutar cross-context.

  async setRunMensagemId(scope: ProbeScope, runId: string, mensagem_id: string): Promise<void> {
    await db
      .update(synthetic_probe_runs)
      .set({ mensagem_id })
      .where(
        and(
          eq(synthetic_probe_runs.id, runId),
          eq(synthetic_probe_runs.tenant_id, scope.tenant_id),
          eq(synthetic_probe_runs.agent_id, scope.agent_id),
        ),
      );
  },

  /**
   * Fecha o run com o desfecho. `terminal` marca `terminal_at` — só então o
   * cleanup pode recolher o tráfego do run (§1.5).
   */
  async completeRun(
    scope: ProbeScope,
    runId: string,
    input: { outcome: ProbeOutcome; latency_ms: number | null; detail?: unknown; terminal: boolean },
  ): Promise<void> {
    await db
      .update(synthetic_probe_runs)
      .set({
        outcome: input.outcome,
        latency_ms: input.latency_ms,
        detail: (input.detail as object) ?? {},
        ...(input.terminal ? { terminal_at: sql`now()` } : {}),
      })
      .where(
        and(
          eq(synthetic_probe_runs.id, runId),
          eq(synthetic_probe_runs.tenant_id, scope.tenant_id),
          eq(synthetic_probe_runs.agent_id, scope.agent_id),
        ),
      );
  },

  /**
   * Runs em voo (terminal_at NULL) mais velhos que o cutoff — órfãos do sweep
   * de TTL (§1.5). Escopado por (tenant, agent).
   */
  async listOpenRunsOlderThan(
    scope: ProbeScope,
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ id: string; mensagem_id: string | null; whatsapp_id: string }>> {
    return db
      .select({
        id: synthetic_probe_runs.id,
        mensagem_id: synthetic_probe_runs.mensagem_id,
        whatsapp_id: synthetic_probe_runs.whatsapp_id,
      })
      .from(synthetic_probe_runs)
      .where(
        and(
          eq(synthetic_probe_runs.tenant_id, scope.tenant_id),
          eq(synthetic_probe_runs.agent_id, scope.agent_id),
          sql`${synthetic_probe_runs.terminal_at} IS NULL`,
          lt(synthetic_probe_runs.started_at, cutoff),
        ),
      )
      .limit(limit);
  },

  /** Fecha um órfão do sweep como `error` terminal (idempotente). Escopado. */
  async closeOrphanRun(scope: ProbeScope, runId: string): Promise<void> {
    await db
      .update(synthetic_probe_runs)
      .set({ outcome: sql`COALESCE(${synthetic_probe_runs.outcome}, 'error')`, terminal_at: sql`now()` })
      .where(
        and(
          eq(synthetic_probe_runs.id, runId),
          eq(synthetic_probe_runs.tenant_id, scope.tenant_id),
          eq(synthetic_probe_runs.agent_id, scope.agent_id),
          sql`${synthetic_probe_runs.terminal_at} IS NULL`,
        ),
      );
  },

  /**
   * Cleanup do tráfego do run (§1.5): remove a `transacoes` criada pelo cenário
   * (a side-effect que polui dados de finança), correlacionada por
   * `mensagem_id` e escopada pelo TRIPLETE (tenant+agent). Idempotente. NÃO toca
   * `mensagens`/`conversas` — elas são fixadas pela FK NO ACTION de `audit_log`
   * (preservar audit ⇒ preservar a trilha; §1.7.6). Retorna quantas removeu.
   */
  async cleanupRunTraffic(input: {
    tenant_id: string;
    agent_id: string;
    mensagem_id: string;
  }): Promise<number> {
    const deleted = await db
      .delete(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, input.tenant_id),
          eq(transacoes.agent_id, input.agent_id),
          eq(transacoes.mensagem_id, input.mensagem_id),
        ),
      )
      .returning({ id: transacoes.id });
    return deleted.length;
  },

  // ── state (last_ok / K-falhas / health / alert / lease) ────────────────────

  async getState(tenant_id: string, agent_id: string): Promise<SyntheticProbeState | null> {
    const rows = await db
      .select()
      .from(synthetic_probe_state)
      .where(and(eq(synthetic_probe_state.tenant_id, tenant_id), eq(synthetic_probe_state.agent_id, agent_id)))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Single-flight (§1.5): adquire o lease atomicamente. Sucede quando não há
   * row, o lease está nulo, ou venceu. Um único statement — sem corrida.
   */
  async acquireLease(input: {
    tenant_id: string;
    agent_id: string;
    lease_ms: number;
  }): Promise<boolean> {
    const res = await db.execute(sql`
      INSERT INTO synthetic_probe_state (tenant_id, agent_id, lease_until, updated_at)
      VALUES (${input.tenant_id}, ${input.agent_id}, now() + ${input.lease_ms}::int * interval '1 millisecond', now())
      ON CONFLICT (tenant_id, agent_id) DO UPDATE
        SET lease_until = EXCLUDED.lease_until, updated_at = now()
        WHERE synthetic_probe_state.lease_until IS NULL OR synthetic_probe_state.lease_until < now()
      RETURNING tenant_id
    `);
    return (res.rowCount ?? 0) > 0;
  },

  async releaseLease(tenant_id: string, agent_id: string): Promise<void> {
    await db
      .update(synthetic_probe_state)
      .set({ lease_until: null, updated_at: sql`now()` })
      .where(and(eq(synthetic_probe_state.tenant_id, tenant_id), eq(synthetic_probe_state.agent_id, agent_id)));
  },

  /**
   * Auto-silêncio (§1.5/§5): SEGURA o lease por `ms` em vez de liberar — os
   * próximos ticks não conseguem adquirir e no-opam (zero custo de LLM). Após o
   * backoff, um tick adquire e sonda recuperação. Reusa o single-flight como
   * throttle, sem estado extra.
   */
  async holdLease(tenant_id: string, agent_id: string, ms: number): Promise<void> {
    await db.execute(sql`
      UPDATE synthetic_probe_state
         SET lease_until = now() + ${ms}::int * interval '1 millisecond', updated_at = now()
       WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
    `);
  },

  /**
   * Desfecho OK: zera `consecutive_failures`, marca `last_ok_at`, volta a
   * `healthy`. Retorna se ESTAVA degradado (transição de recuperação, para o
   * caller decidir o alerta de recuperação).
   */
  async recordOk(tenant_id: string, agent_id: string): Promise<{ recovered: boolean }> {
    // O CTE `prev` lê o snapshot PRÉ-statement (o health ANTES do update), então
    // detectamos a transição degraded→healthy corretamente — o RETURNING do
    // próprio UPDATE já traria 'healthy' (pós). Sem row anterior ⇒ prev vazio ⇒
    // NULL = 'degraded' ⇒ NULL ⇒ COALESCE false.
    const rows = await db.execute<{ recovered: boolean }>(sql`
      WITH prev AS (
        SELECT health FROM synthetic_probe_state
        WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
      ), upsert AS (
        INSERT INTO synthetic_probe_state (tenant_id, agent_id, last_ok_at, first_attempt_at, consecutive_failures, health, updated_at)
        VALUES (${tenant_id}, ${agent_id}, now(), now(), 0, 'healthy', now())
        ON CONFLICT (tenant_id, agent_id) DO UPDATE
          SET last_ok_at = now(),
              first_attempt_at = COALESCE(synthetic_probe_state.first_attempt_at, now()),
              consecutive_failures = 0, health = 'healthy',
              alert_pending = false, alert_pending_since = null, updated_at = now()
        RETURNING 1
      )
      SELECT COALESCE((SELECT health FROM prev) = 'degraded', false) AS recovered FROM upsert
    `);
    return { recovered: rows.rows[0]?.recovered ?? false };
  },

  /**
   * Falha: incrementa `consecutive_failures`; ao ATINGIR K com health saudável,
   * transiciona para `degraded` e arma `alert_pending`. Retorna o novo contador
   * e se HOUVE transição (para o caller disparar sendAlert uma única vez).
   */
  async recordFailure(input: {
    tenant_id: string;
    agent_id: string;
    alert_after_k: number;
  }): Promise<{ consecutive_failures: number; transitioned_to_degraded: boolean }> {
    // Correção P2 (K=1): a PRIMEIRA falha (INSERT) precisa derivar health/
    // alert_pending de K — com K=1, a 1ª falha JÁ é a transição saudável→
    // degradado. Antes o INSERT fixava 'healthy' e K=1 nunca alertava. A
    // transição é sinalizada quando `consecutive_failures = K` e health é
    // 'degraded' (vale tanto no INSERT com K=1 quanto no UPDATE ao cruzar K).
    const res = await db.execute<{ consecutive_failures: number; transitioned: boolean }>(sql`
      INSERT INTO synthetic_probe_state (tenant_id, agent_id, first_attempt_at, consecutive_failures, health, alert_pending, alert_pending_since, updated_at)
      VALUES (
        ${input.tenant_id}, ${input.agent_id}, now(), 1,
        CASE WHEN 1 >= ${input.alert_after_k} THEN 'degraded' ELSE 'healthy' END,
        CASE WHEN 1 >= ${input.alert_after_k} THEN true ELSE false END,
        CASE WHEN 1 >= ${input.alert_after_k} THEN now() ELSE NULL END,
        now()
      )
      ON CONFLICT (tenant_id, agent_id) DO UPDATE
        SET first_attempt_at = COALESCE(synthetic_probe_state.first_attempt_at, now()),
            consecutive_failures = synthetic_probe_state.consecutive_failures + 1,
            health = CASE
              WHEN synthetic_probe_state.consecutive_failures + 1 >= ${input.alert_after_k} THEN 'degraded'
              ELSE synthetic_probe_state.health END,
            alert_pending = CASE
              WHEN synthetic_probe_state.consecutive_failures + 1 >= ${input.alert_after_k}
                   AND synthetic_probe_state.health = 'healthy' THEN true
              ELSE synthetic_probe_state.alert_pending END,
            alert_pending_since = CASE
              WHEN synthetic_probe_state.consecutive_failures + 1 >= ${input.alert_after_k}
                   AND synthetic_probe_state.health = 'healthy' THEN now()
              ELSE synthetic_probe_state.alert_pending_since END,
            updated_at = now()
      RETURNING consecutive_failures,
        (health = 'degraded'
         AND consecutive_failures = ${input.alert_after_k}) AS transitioned
    `);
    const row = res.rows[0];
    return {
      consecutive_failures: Number(row?.consecutive_failures ?? 0),
      transitioned_to_degraded: row?.transitioned ?? false,
    };
  },

  /** Registra tentativa de entrega do alerta; `delivered` zera `alert_pending`. */
  async recordAlertAttempt(input: {
    tenant_id: string;
    agent_id: string;
    delivered: boolean;
  }): Promise<void> {
    await db
      .update(synthetic_probe_state)
      .set({
        last_alert_attempt_at: sql`now()`,
        ...(input.delivered ? { alert_pending: false, alert_pending_since: null } : {}),
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(synthetic_probe_state.tenant_id, input.tenant_id),
          eq(synthetic_probe_state.agent_id, input.agent_id),
        ),
      );
  },

  /**
   * Gauge PRIMÁRIO de outage (§1.6): segundos desde o último OK do recurso de
   * sonda. Sem ALS (scrape de /metrics). Um valor que CRESCE É o outage e
   * sobrevive a restart.
   *
   * Correção do review (alta — "never green"): se a sonda NUNCA passou
   * (`last_ok_at` nulo) mas já tentou (`first_attempt_at` set), o gauge cresce
   * a partir da PRIMEIRA tentativa — senão ficaria em 0 para sempre e uma regra
   * `>15m` jamais dispararia num ambiente quebrado desde o 1º tick. Só retorna
   * 0 quando nunca houve tentativa (sonda off / ainda não rodou).
   */
  async secondsSinceLastOk(tenant_id: string, agent_id: string): Promise<number> {
    const rows = await db
      .select({
        last_ok_at: synthetic_probe_state.last_ok_at,
        first_attempt_at: synthetic_probe_state.first_attempt_at,
      })
      .from(synthetic_probe_state)
      .where(and(eq(synthetic_probe_state.tenant_id, tenant_id), eq(synthetic_probe_state.agent_id, agent_id)))
      .limit(1);
    const anchor = rows[0]?.last_ok_at ?? rows[0]?.first_attempt_at;
    if (!anchor) return 0;
    return Math.max(0, Math.floor((Date.now() - anchor.getTime()) / 1000));
  },
};
