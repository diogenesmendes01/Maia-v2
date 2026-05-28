import { db } from '@/db/client.js';
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
 */
async function listTenantsWithCorrections(since: ReturnType<typeof sql>): Promise<TenantAgentRow[]> {
  const result = await db.execute<TenantAgentRow>(sql`
    SELECT DISTINCT tenant_id, agent_id
    FROM ${audit_log}
    WHERE acao = 'transaction_corrected' AND created_at >= ${since}
  `);
  return Array.from(result.rows as unknown as TenantAgentRow[]);
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

  for (const { tenant_id, agent_id } of tenants) {
    const stats = await runWithTenantContext({ tenant_id, agent_id }, () =>
      runReflectionBatchInner(since),
    );
    totalCreated += stats.created;
    totalSkipped += stats.skipped;
    totalSignals += stats.signals;
    totalClusters += stats.clusters;
    totalLlmCalls += stats.llm_calls;
    logger.info(
      { tenant_id, agent_id, ...stats },
      'reflection_batch.tenant_done',
    );
  }

  logger.info(
    {
      tenants: tenants.length,
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
        logger.warn({ err: (err as Error).message }, 'reflection_batch.memory_write_failed'),
      );
      created++;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'reflection_batch.create_failed');
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
