import type { PoolClient } from 'pg';
import { db, pool } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { rulesRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { writeMemory } from '@/memory/vector.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import {
  clusterCorrections,
  type CorrectionSignal,
  type Cluster,
} from '@/agent/reflection-clustering.js';

const MAX_LLM_CALLS = 200;
const VALID_TIPOS = ['classificacao', 'identificacao_entidade'] as const;
type ValidTipo = (typeof VALID_TIPOS)[number];

type AuditRow = {
  acao: string;
  alvo_id: string | null;
  metadata: unknown;
  pessoa_id: string | null;
};

type Proposal = {
  applicable: boolean;
  tipo?: ValidTipo;
  contexto?: string;
  acao?: string;
  contexto_jsonb?: Record<string, unknown>;
  acoes_jsonb?: Record<string, unknown>;
  justificativa?: string;
};

type TenantAgentRow = { tenant_id: string; agent_id: string };

/**
 * Enumera tuplas (tenant_id, agent_id) DISTINCT no audit_log dentro da janela
 * relevante. Roda OUTSIDE de qualquer tenant context — é o dispatcher que
 * decide em quais escopos aplicar a reflexão. NÃO filtra por
 * `tenant_id='default'` nem usa qualquer sentinela: cada par real entra no
 * loop e cada um abre seu próprio `runWithTenantContext`.
 *
 * NOT NULL guards: audit_log.tenant_id/agent_id são NOT NULL com default
 * legacy 'default' (ver schema.ts). Linhas com 'default' aparecem aqui SE
 * existirem — historicamente o batch escrevia toda reflexão em
 * tenant_id='default' (issue #240). A partir do fix, novas reflexões nunca
 * mais entram em 'default'; rows pré-existentes ficam como artefato (ver
 * follow-up de migração no PR body).
 *
 * Codex REQUEST_CHANGES (PR #251) MINOR: o predicate `tenant_id IS NOT NULL
 * AND agent_id IS NOT NULL` é explicitamente solicitado pela issue #240.
 * O schema já garante NOT NULL (com default 'default'), então estes
 * predicados são belt-and-suspenders contra um futuro relaxamento do schema
 * ou uma migração de coluna que temporariamente permita NULL.
 */
async function listTenantsWithCorrections(since: ReturnType<typeof sql>): Promise<TenantAgentRow[]> {
  const result = await db.execute<TenantAgentRow>(sql`
    SELECT DISTINCT tenant_id, agent_id
    FROM ${audit_log}
    WHERE acao = 'transaction_corrected'
      AND created_at >= ${since}
      AND tenant_id IS NOT NULL
      AND agent_id IS NOT NULL
  `);
  return Array.from(result.rows as unknown as TenantAgentRow[]);
}

/**
 * Codex REQUEST_CHANGES (PR #251) MEDIUM #2 — concurrent worker guard.
 *
 * Cenário: 2 instâncias do reflection_batch rodam em paralelo (rolling deploy,
 * restart, debug local). Cada uma:
 *   1. Lê audit_log do tenant X
 *   2. `rulesRepo.findByContext('classificacao', cluster.descricao)` → null
 *      em ambos (read antes do write)
 *   3. `rulesRepo.create` em ambos → DUAS regras duplicadas, mesma descricao
 *
 * Solução: Postgres session-level advisory lock por (tenant_id, agent_id).
 * `pg_try_advisory_lock` retorna `false` se outro worker já segura a chave —
 * nesse caso o tenant é SKIPADO com log, não bloqueia. O lock é session-level
 * (não xact-level) porque o trabalho do tenant inclui chamadas LLM de até 30s
 * que NÃO devem rodar dentro de uma transação Postgres (vão segurar
 * conexão+xact bloat).
 *
 * Por que session-level + cliente dedicado: a advisory lock é amarrada à
 * conexão Postgres. `db.execute(...)` no pool pode pegar uma conexão diferente
 * a cada chamada — o lock perderia significado. Em vez disso, alocamos um
 * cliente dedicado do pool, seguramos o lock NELE durante todo o
 * processamento daquele tenant, e liberamos no `finally`. As queries internas
 * (`db.execute`, `rulesRepo.*`, `writeMemory`) ainda usam o pool — o lock é
 * apenas mutex EXTERNO contra outras instâncias do worker tentando o MESMO
 * (tenant, agent).
 *
 * Chave: `pg_try_advisory_lock(int8)` exige um único bigint. Derivamos por
 * `hashtextextended(tenant_id || '|' || agent_id, NAMESPACE_SEED)`.
 * NAMESPACE_SEED isola o keyspace do reflection_batch de outros usos futuros
 * de advisory lock no Maia (qualquer constante estável serve — não pode
 * trocar entre deploys senão round-trip de release não bate).
 *
 * Retorno: { client, released() }. Caller chama `released()` no finally.
 * `client` não é exposto pra inner — só serve pra segurar o lock na conexão.
 */
const REFLECTION_BATCH_LOCK_NAMESPACE = 4711_4711n;

type AcquiredLock = {
  /** Libera o lock e devolve o client ao pool. Safe to call multiple times. */
  release: () => Promise<void>;
};

async function tryAcquireTenantLock(
  tenant_id: string,
  agent_id: string,
): Promise<AcquiredLock | null> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    // Even acquiring a pool client failed (pool exhaustion, DB down). Skip the
    // tenant this tick; the next cron run will retry.
    logger.warn(
      { err: (err as Error).message, tenant_id, agent_id },
      'reflection_batch.lock_acquire_failed',
    );
    return null;
  }

  let released = false;
  try {
    // Use hashtextextended (bigint) seeded com o namespace pra evitar colisão
    // com outros consumidores de advisory lock no futuro. Key derivada do
    // par (tenant, agent) — distintos pares têm chaves distintas com alta
    // probabilidade.
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked`,
      [`${tenant_id}|${agent_id}`, REFLECTION_BATCH_LOCK_NAMESPACE.toString()],
    );
    const locked = r.rows[0]?.locked === true;
    if (!locked) {
      client.release();
      return null;
    }
  } catch (err) {
    // Lock acquisition itself failed (e.g. connection error). Release client
    // and treat as "could not acquire" — the tenant gets skipped this run.
    client.release();
    logger.warn(
      { err: (err as Error).message, tenant_id, agent_id },
      'reflection_batch.lock_acquire_failed',
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
          [`${tenant_id}|${agent_id}`, REFLECTION_BATCH_LOCK_NAMESPACE.toString()],
        );
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, tenant_id, agent_id },
          'reflection_batch.lock_release_failed',
        );
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Issue #240 — per-tenant fan-out.
 *
 * BEFORE: `runReflectionBatch` rodava em `runWithTenantContext({tenant_id:'default', agent_id:'default'})`
 * fixo, lia `audit_log` sem filtro de tenant, e chamava `writeMemory`. Com #237
 * (vector memory scoping) mergeado, `writeMemory` agora resolve tenant/agent
 * via `getCurrentTenant()`/`getCurrentAgent()` — então todo write da reflexão
 * caía em `agent_memories(tenant_id='default', agent_id='default')`,
 * independente do tenant que gerou o sinal de correção. Resultado: vazamento
 * silencioso — memória vetorial de tenants reais nunca era populada por
 * reflexão noturna, ou pior, se algum tenant fosse literalmente 'default',
 * suas memórias se misturavam com as de outros tenants.
 *
 * AFTER: o worker é um dispatcher. Ele enumera tuplas (tenant_id, agent_id)
 * DISTINCT que produziram `transaction_corrected` na janela, e para cada par
 * abre `runWithTenantContext` ANTES de tocar qualquer read/write tenant-aware.
 *
 *   - A leitura do `audit_log` interna filtra por tenant_id+agent_id (defesa
 *     em profundidade — mesmo se o dispatcher errasse, a query interna não
 *     veria linhas de outro tenant).
 *   - `rulesRepo.findByContext` / `rulesRepo.create` já são tenant-aware
 *     (issue #230) e resolvem o contexto ALS.
 *   - `writeMemory` (issue #229/#237) resolve tenant/agent do contexto ALS
 *     e escreve no `agent_memories` correto.
 *   - `audit()` herda o contexto ALS via `tryGetCurrentContext()` — a entrada
 *     `rule_learned` cai no tenant correto, não em 'system'/'default'.
 *
 * Sem sentinela 'default': se nenhum tenant tiver eventos na janela, o worker
 * faz no-op e retorna sem trocar de contexto. Não há fallback para um bucket
 * compartilhado.
 */
export async function runReflectionBatch(): Promise<void> {
  const since = sql`now() - interval '24 hours'`;
  const tenants = await listTenantsWithCorrections(since);

  if (tenants.length === 0) {
    logger.info('reflection_batch.idle');
    return;
  }

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalSignals = 0;
  let totalClusters = 0;
  let totalLlmCalls = 0;
  let tenantsProcessed = 0;
  let tenantsSkippedLocked = 0;
  let tenantsFailed = 0;

  for (const { tenant_id, agent_id } of tenants) {
    // Codex REQUEST_CHANGES (PR #251) MEDIUM #2: tentar adquirir advisory
    // lock per (tenant, agent). Se outro worker já está rodando esse par,
    // skipar — não bloquear, não aguardar (o próximo cron tick pega).
    const lock = await tryAcquireTenantLock(tenant_id, agent_id);
    if (!lock) {
      tenantsSkippedLocked++;
      logger.info(
        { tenant_id, agent_id },
        'reflection_batch.tenant_skipped_locked',
      );
      continue;
    }

    try {
      // Codex REQUEST_CHANGES (PR #251) MEDIUM #1: try/catch POR tenant
      // garante fail-isolated. Antes, um erro não tratado em `findByContext`
      // / `proposeRule` / inner SELECT abortaria o loop inteiro — uma falha
      // em tenant X bloqueava reflexão de todos os outros tenants na janela.
      // Agora o erro fica contido: loga + métrica e continua com o próximo.
      const stats = await runWithTenantContext({ tenant_id, agent_id }, () =>
        runReflectionBatchInner(since),
      );
      totalCreated += stats.created;
      totalSkipped += stats.skipped;
      totalSignals += stats.signals;
      totalClusters += stats.clusters;
      totalLlmCalls += stats.llm_calls;
      tenantsProcessed++;
      logger.info(
        { tenant_id, agent_id, ...stats },
        'reflection_batch.tenant_done',
      );
    } catch (err) {
      // Fail-isolated: o erro de UM tenant não afeta os demais. O run total
      // permanece "parcialmente ok" — telemetria distingue via
      // `tenants_failed`/`tenants_processed` no `reflection_batch.done`.
      tenantsFailed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'reflection_batch.tenant_failed',
      );
    } finally {
      await lock.release();
    }
  }

  logger.info(
    {
      tenants: tenants.length,
      tenants_processed: tenantsProcessed,
      tenants_skipped_locked: tenantsSkippedLocked,
      tenants_failed: tenantsFailed,
      created: totalCreated,
      skipped_existing: totalSkipped,
      clusters: totalClusters,
      signals: totalSignals,
      llm_calls: totalLlmCalls,
    },
    'reflection_batch.done',
  );
}

type ReflectionStats = {
  created: number;
  skipped: number;
  signals: number;
  clusters: number;
  llm_calls: number;
};

async function runReflectionBatchInner(
  since: ReturnType<typeof sql>,
): Promise<ReflectionStats> {
  // Defense-in-depth: filter audit_log explicitly by the current tenant/agent
  // pulled from the ALS context. The dispatcher in `runReflectionBatch`
  // already routed us here per (tenant_id, agent_id) — this extra predicate
  // means even a future change to the dispatcher (e.g. a bug that opens the
  // wrong context) cannot cause this read to pull foreign-tenant rows into
  // the LLM proposal stage.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  const rows = await db.execute<AuditRow>(
    sql`SELECT acao, alvo_id, metadata, pessoa_id FROM ${audit_log}
        WHERE acao = 'transaction_corrected'
          AND created_at >= ${since}
          AND tenant_id = ${tenant_id}
          AND agent_id = ${agent_id}
        ORDER BY created_at DESC LIMIT 1000`,
  );
  const signals: CorrectionSignal[] = [];
  for (const r of rows.rows as AuditRow[]) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const descricao = (meta.descricao as string | undefined) ?? '';
    if (!descricao) continue;
    signals.push({
      alvo_id: r.alvo_id,
      descricao,
      contexto: meta,
    });
  }

  if (signals.length === 0) {
    logger.info({ tenant_id, agent_id }, 'reflection_batch.no_signal');
    return { created: 0, skipped: 0, signals: 0, clusters: 0, llm_calls: 0 };
  }

  const clusters = clusterCorrections(signals);
  let llmCalls = 0;
  let created = 0;
  let skipped = 0;

  for (const cluster of clusters) {
    if (llmCalls >= MAX_LLM_CALLS) break;

    // Dedupe: skip if a rule with the same contexto already exists.
    const existing = await rulesRepo.findByContext('classificacao', cluster.descricao_normalized);
    if (existing) {
      skipped++;
      continue;
    }

    const proposal = await proposeRule(cluster);
    llmCalls++;
    if (
      !proposal ||
      !proposal.applicable ||
      !proposal.tipo ||
      !VALID_TIPOS.includes(proposal.tipo as ValidTipo) ||
      !proposal.contexto ||
      !proposal.acao
    ) {
      continue;
    }

    try {
      const r = await rulesRepo.create({
        tipo: proposal.tipo,
        contexto: proposal.contexto,
        acao: proposal.acao,
        contexto_jsonb: proposal.contexto_jsonb ?? {},
        acoes_jsonb: proposal.acoes_jsonb ?? {},
        confianca: '0.50',
        acertos: 0,
        erros: 0,
        ativa: true,
        exemplo_origem_id: cluster.signals[0]?.alvo_id ?? null,
        // P10a: lifecycle columns populated by DB defaults.
      });
      await audit({
        acao: 'rule_learned',
        alvo_id: r.id,
        metadata: {
          source: 'batch',
          cluster_size: cluster.signals.length,
          justificativa: proposal.justificativa,
        },
      });
      // Write a reflexao memory so future recall can surface the reasoning.
      // writeMemory resolves tenant/agent from the active ALS context (#229/#237)
      // — the routed tuple, NEVER 'default/default'.
      await writeMemory({
        conteudo: `Regra ${r.id.slice(0, 8)}: ${proposal.contexto} → ${proposal.acao}. ${
          proposal.justificativa ?? ''
        }`,
        tipo: 'reflexao',
        escopo: 'global',
        metadata: { rule_id: r.id, cluster_size: cluster.signals.length },
      }).catch((err) =>
        // Codex REQUEST_CHANGES (PR #251) LOW: incluir tenant/agent no log
        // de falha pra simetria com o caminho de sucesso. Antes só `{err}`.
        logger.warn(
          { err: (err as Error).message, tenant_id, agent_id },
          'reflection_batch.memory_write_failed',
        ),
      );
      created++;
    } catch (err) {
      // Idem — log de falha simétrico ao de sucesso.
      logger.warn(
        { err: (err as Error).message, tenant_id, agent_id },
        'reflection_batch.create_failed',
      );
    }
  }

  return {
    created,
    skipped,
    signals: signals.length,
    clusters: clusters.length,
    llm_calls: llmCalls,
  };
}

async function proposeRule(cluster: Cluster): Promise<Proposal | null> {
  const examples = cluster.signals.slice(0, 5).map((s, i) => `${i + 1}. ${s.descricao}`).join('\n');
  const system =
    'Você é a Maia em modo reflexão noturna (modelo rápido). ' +
    'Receberá um cluster de correções repetidas do usuário sobre transações. ' +
    'Proponha UMA regra que evitaria os erros futuros, em JSON estrito. ' +
    'Schema: {"applicable":bool,"tipo":"classificacao"|"identificacao_entidade","contexto":string,"acao":string,"contexto_jsonb":obj,"acoes_jsonb":obj,"justificativa":string}. ' +
    'Se não houver padrão claro, retorne {"applicable":false}.';
  const user = `Cluster (descricao normalizada: "${cluster.descricao_normalized}", ${cluster.signals.length} ocorrências):\n${examples}`;
  const proposalResult = await runCognitiveModule(
    { name: 'reflection-batch', triggered_by: 'async_event', timeoutMs: 30000 },
    () =>
      callLLM({
        workload: 'reflection',
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 400,
        temperature: 0.0,
      }),
  );
  const res = proposalResult.output;
  if (!res) {
    logger.warn(
      { status: proposalResult.status },
      'reflection_batch.llm_failed_skipping',
    );
    return null;
  }
  try {
    const text = res.content?.trim() ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as Proposal;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'reflection_batch.parse_failed');
    return null;
  }
}
