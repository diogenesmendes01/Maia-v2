import { z } from 'zod';
import type { PoolClient } from 'pg';
import { db, pool } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { rulesRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { proposeFromWorker } from '@/learning/service.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import {
  clusterCorrections,
  clusterDedupeKey,
  type CorrectionSignal,
  type Cluster,
} from '@/agent/reflection-clustering.js';

const MAX_LLM_CALLS = 200;

const VALID_TIPOS = ['classificacao', 'identificacao_entidade'] as const;
type ValidTipo = (typeof VALID_TIPOS)[number];

/**
 * O que o modelo PODE devolver, e nada além.
 *
 * Repare no que não existe aqui: `origin`, `confianca`, `lifecycle_status`,
 * `approved_by`, `visible_to_llm`. Não é omissão — é o contrato. Com
 * `.strict()`, um modelo que tentasse declarar qualquer um deles faz a
 * proposta inteira ser rejeitada, em vez de ter o campo silenciosamente
 * ignorado e alguém passar a lê-lo seis meses depois.
 */
const propostaSchema = z
  .object({
    applicable: z.boolean(),
    tipo: z.enum(VALID_TIPOS).optional(),
    contexto: z.string().min(1).max(2_000).optional(),
    acao: z.string().min(1).max(2_000).optional(),
    contexto_jsonb: z.record(z.unknown()).optional(),
    acoes_jsonb: z.record(z.unknown()).optional(),
    justificativa: z.string().max(2_000).optional(),
  })
  .strict();

/**
 * G1 (spec §7.6.1 item 1) — a linha de auditoria com o que ela precisa ter.
 *
 * `id` e `created_at` entram porque sem id estável não há linhagem auditável e
 * sem timestamp não há como ordenar evidência. `conversa_id` entra porque a
 * finalidade e o recurso costumam estar amarrados à conversa.
 *
 * `pessoa_id` continua sendo o ATOR da correção. Ele NÃO é promovido a titular
 * em lugar nenhum deste arquivo — ver `resolveDataSubject`.
 */
type AuditRow = {
  id: string;
  acao: string;
  alvo_id: string | null;
  metadata: unknown;
  pessoa_id: string | null;
  conversa_id: string | null;
  created_at: Date | string;
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
async function listTenantsWithCorrections(
  since: ReturnType<typeof sql>,
): Promise<TenantAgentRow[]> {
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
        await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, $2))`, [
          `${tenant_id}|${agent_id}`,
          REFLECTION_BATCH_LOCK_NAMESPACE.toString(),
        ]);
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
      logger.info({ tenant_id, agent_id }, 'reflection_batch.tenant_skipped_locked');
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
      logger.info({ tenant_id, agent_id, ...stats }, 'reflection_batch.tenant_done');
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

/**
 * G1 (spec §7.6.1 item 1) — DE QUEM É O DADO CORRIGIDO.
 *
 * A linha da spec é literal: "`pessoa_id` é o ator da correção, **não
 * presumir que seja titular de todos os dados do payload**. Resolver
 * titular/recurso pelo evento e ownership canônico; se não for demonstrável,
 * quarentena."
 *
 * Então esta função NÃO cai em `row.pessoa_id`. Ela procura, na ordem, as
 * referências que o EVENTO declara sobre o titular. Não achando nenhuma,
 * devolve `null` — e `null` manda o sinal para quarentena em vez de para um
 * cluster.
 *
 * O `pessoa_id` do ator não é um default ruim: ele é uma resposta ERRADA
 * quando um operador corrige o dado de um cliente, que é o caso comum num
 * atendimento. Usá-lo faria o cluster falar do operador.
 *
 * A ordem das chaves é a da especificidade: uma referência explícita de
 * titular vence uma derivada de recurso.
 */
function resolveDataSubject(
  meta: Record<string, unknown>,
  row: { conversa_id: string | null },
): string | null {
  for (const chave of ['data_subject_ref', 'subject_id', 'titular_id', 'pessoa_alvo_id']) {
    const v = meta[chave];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // A conversa identifica o titular do atendimento quando o evento não o
  // declara. É derivação, não presunção: a conversa TEM titular, enquanto o
  // ator só tem papel.
  if (row.conversa_id !== null && row.conversa_id.length > 0) {
    return `conversa:${row.conversa_id}`;
  }
  return null;
}

async function runReflectionBatchInner(since: ReturnType<typeof sql>): Promise<ReflectionStats> {
  // Defense-in-depth: filter audit_log explicitly by the current tenant/agent
  // pulled from the ALS context. The dispatcher in `runReflectionBatch`
  // already routed us here per (tenant_id, agent_id) — this extra predicate
  // means even a future change to the dispatcher (e.g. a bug that opens the
  // wrong context) cannot cause this read to pull foreign-tenant rows into
  // the LLM proposal stage.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  const rows = await db.execute<AuditRow>(
    sql`SELECT id, acao, alvo_id, metadata, pessoa_id, conversa_id, created_at FROM ${audit_log}
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
      source_event_id: r.id,
      occurred_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      actor_pessoa_id: r.pessoa_id,
      data_subject_ref: resolveDataSubject(meta, r),
      conversa_id: r.conversa_id,
      purpose: typeof meta.purpose === 'string' ? meta.purpose : null,
      authorized_resource:
        typeof meta.authorized_resource === 'string' ? meta.authorized_resource : null,
    });
  }

  if (signals.length === 0) {
    logger.info({ tenant_id, agent_id }, 'reflection_batch.no_signal');
    return { created: 0, skipped: 0, signals: 0, clusters: 0, llm_calls: 0 };
  }

  const { clusters, quarantined } = clusterCorrections(signals);

  /**
   * G1 item 1 — a quarentena é REPORTADA, não descartada em silêncio.
   *
   * Um sinal sem titular demonstrável não vira cluster, e isso é o
   * comportamento certo. Mas se ele sumisse sem registro, um evento de
   * auditoria mal formado — ou uma mudança de esquema que parasse de gravar a
   * referência — apareceria como "o lote não achou nada para aprender", que é
   * indistinguível de "não houve correções".
   */
  if (quarantined.length > 0) {
    const porMotivo: Record<string, number> = {};
    for (const q of quarantined) porMotivo[q.reason] = (porMotivo[q.reason] ?? 0) + 1;
    logger.warn(
      { tenant_id, agent_id, quarantined: quarantined.length, by_reason: porMotivo },
      'reflection_batch.signals_quarantined',
    );
  }
  let llmCalls = 0;
  let created = 0;
  let skipped = 0;
  /**
   * Chaves já propostas NESTA rodada.
   *
   * O dedupe durável entre rodadas é do `LearningService` — ele reencontra a
   * proposta pendente pelo KSM. Este conjunto cobre o caso mais estreito e
   * mais provável: dois clusters da MESMA rodada que derivam a mesma chave.
   */
  const propostasDaRodada = new Set<string>();

  for (const cluster of clusters) {
    if (llmCalls >= MAX_LLM_CALLS) break;

    /**
     * G1 item 3 — DEDUPE PELA CHAVE PERSISTIDA, não por regra visível.
     *
     * `rulesRepo.findByContext` procura só entre regras VISÍVEIS. Uma proposta
     * pendente de revisão não é visível — então, enquanto o humano não
     * decidisse, TODA rodada do lote reabria proposta para o mesmo cluster e a
     * fila enchia com duplicatas da mesma decisão.
     *
     * A chave inclui titular, tipo e as FONTES, e a inclusão das fontes é
     * deliberada: dois clusters com a mesma descrição e evidência diferente
     * são propostas diferentes, e colapsá-los esconderia evidência nova.
     *
     * A checagem de regra visível FICA, como segundo filtro: se a regra já
     * existe e está ativa, não há o que propor, independentemente de a chave
     * ser nova.
     */
    const dedupeKey = clusterDedupeKey(cluster, 'learned_rule');
    if (propostasDaRodada.has(dedupeKey)) {
      skipped++;
      continue;
    }
    propostasDaRodada.add(dedupeKey);

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
      /**
       * G1 (spec §7.6.1 itens 5 e 6) — O WORKER DEIXA DE ESCREVER CONHECIMENTO
       * ATIVO.
       *
       * O que estava aqui eram duas linhas, e juntas elas diziam o seguinte:
       * um lote noturno, a partir de um agrupamento de correções, criava uma
       * REGRA ATIVA (`rulesRepo.create({ …, ativa: true })`) que passava a
       * governar todos os turnos seguintes, e publicava a justificativa do
       * modelo como memória GLOBAL (`writeMemory({ escopo: 'global' })`).
       * Nenhum humano aparecia no caminho.
       *
       * O §7.6.1 é explícito sobre o que `source='worker'` significa: não é
       * selo de confiança. Agora a proposta passa pelo `LearningService`, que
       * a leva ao KSM com nascimento obrigatório em revisão, disposição
       * privada e `visible_to_llm=false`.
       *
       * A `writeMemory(escopo:'global')` saiu e NÃO foi substituída. O item 6
       * é literal: "Raciocínio/justificativa do LLM não vira memória global".
       * A justificativa continua existindo — como METADADO da proposta, que é
       * onde um humano a lê ao decidir, e não como conhecimento indexado que
       * volta ao prompt sem ninguém ter aprovado.
       */
      const r = await proposeFromWorker({
        kind: 'learned_rule',
        tenant_id,
        agent_id,
        trace_id: `reflection_batch:${cluster.descricao_normalized}`,
        key: cluster.descricao_normalized,
        content: {
          type: proposal.tipo,
          context: proposal.contexto,
          action: proposal.acao,
          conditions: proposal.contexto_jsonb ?? {},
          effects: proposal.acoes_jsonb ?? {},
        },
        content_text: `[${proposal.tipo}] ${proposal.contexto} -> ${proposal.acao}`,
        source: 'worker',
        // `alvo_id` é `transacoes.id`, não `audit_log.id` — o nome do campo
        // preserva essa semântica para o consumidor não procurar na tabela
        // errada.
        source_example_ids: cluster.signals
          .map((sig: CorrectionSignal) => sig.alvo_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
        // O MESMO exemplo que o caminho anterior gravava em
        // `learned_rules.exemplo_origem_id`.
        primary_example_id: cluster.signals[0]?.alvo_id ?? null,
        native: {
          rule_tipo: proposal.tipo,
          rule_contexto: proposal.contexto,
          rule_acao: proposal.acao,
          rule_contexto_jsonb: proposal.contexto_jsonb ?? {},
          rule_acoes_jsonb: proposal.acoes_jsonb ?? {},
        },
      });

      if (r.kind === 'refused') {
        logger.warn(
          { tenant_id, agent_id, reason: r.reason, detail: r.detail },
          'reflection_batch.proposal_refused',
        );
        continue;
      }

      /**
       * `learning_proposed`, e não `rule_learned` (§7.6.1 item 7).
       *
       * A ação legada afirma que uma regra foi APRENDIDA, e quem lê contadores
       * ou UI baseados nela concluiria que o agente mudou de comportamento. O
       * que aconteceu foi outra coisa: existe uma proposta esperando um humano.
       * Distinguir proposta de publicação é o item inteiro.
       */
      await audit({
        acao: 'learning_proposed',
        alvo_id: r.proposal_id,
        metadata: {
          source: 'batch',
          learning_kind: 'learned_rule',
          cluster_size: cluster.signals.length,
          lifecycle_status: r.lifecycle_status,
          approval_class: r.approval_class,
          risk: r.risk,
          justificativa: proposal.justificativa,
        },
      });
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
  const examples = cluster.signals
    .slice(0, 5)
    .map((s, i) => `${i + 1}. ${s.descricao}`)
    .join('\n');
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
    logger.warn({ status: proposalResult.status }, 'reflection_batch.llm_failed_skipping');
    return null;
  }
  const text = res.content?.trim() ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;

  let bruto: unknown;
  try {
    bruto = JSON.parse(m[0]);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'reflection_batch.parse_failed');
    return null;
  }

  /**
   * G1 item 4 — SCHEMA FECHADO, no lugar do cast.
   *
   * Era `JSON.parse(m[0]) as Proposal`. Um cast não valida nada: o objeto
   * chegava com a forma que o modelo quisesse, e os campos extras passavam
   * adiante. Numa proposta de aprendizado isso não é descuido de tipagem — é a
   * superfície por onde o modelo declararia o que não é dele.
   *
   * `.strict()` é o ponto: campo desconhecido REPROVA em vez de ser ignorado.
   * Ignorar deixaria um `origin`, um `confianca` ou um `lifecycle_status`
   * vindo do modelo passar despercebido até alguém decidir lê-lo. O §7.6.1
   * item 4 é explícito: "o modelo não escolhe lifecycle, confiança ou origem".
   *
   * Os limites existem para que payload inválido não vire loop nem custo: um
   * modelo que devolvesse um contexto de megabytes seria rejeitado aqui, não
   * lá adiante.
   */
  const parsed = propostaSchema.safeParse(bruto);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}:${i.code}`) },
      'reflection_batch.proposal_schema_rejected',
    );
    return null;
  }
  return parsed.data;
}
