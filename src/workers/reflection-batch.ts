import { db } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { config } from '@/config/env.js';
import { rulesRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { writeMemory } from '@/memory/vector.js';
import {
  clusterCorrections,
  type CorrectionSignal,
  type Cluster,
} from '@/agent/reflection-clustering.js';

const MAX_LLM_CALLS = 200;

type AuditRow = {
  acao: string;
  alvo_id: string | null;
  metadata: unknown;
  pessoa_id: string | null;
};

type Proposal = {
  applicable: boolean;
  tipo?: 'classificacao' | 'identificacao_entidade' | 'tom_resposta' | 'recorrencia';
  contexto?: string;
  acao?: string;
  contexto_jsonb?: Record<string, unknown>;
  acoes_jsonb?: Record<string, unknown>;
  justificativa?: string;
};

export async function runReflectionBatch(): Promise<void> {
  const since = sql`now() - interval '24 hours'`;
  const rows = await db.execute<AuditRow>(
    sql`SELECT acao, alvo_id, metadata, pessoa_id FROM ${audit_log}
        WHERE acao = 'transaction_corrected' AND created_at >= ${since}
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
    logger.info('reflection_batch.no_signal');
    return;
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
    if (!proposal || !proposal.applicable || !proposal.tipo || !proposal.contexto || !proposal.acao) {
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

  logger.info(
    {
      created,
      skipped_existing: skipped,
      clusters: clusters.length,
      signals: signals.length,
      llm_calls: llmCalls,
    },
    'reflection_batch.done',
  );
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
  try {
    const res = await callLLM({
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 400,
      temperature: 0.0,
    });
    void config; // model selection respects env via callLLM (Sonnet→Haiku fallback already wired)
    const text = res.content?.trim() ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as Proposal;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'reflection_batch.llm_failed');
    return null;
  }
}
