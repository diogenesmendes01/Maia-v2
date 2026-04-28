import { db } from '@/db/client.js';
import { mensagens, transacoes, audit_log } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { callLLM } from '@/lib/claude.js';
import { rulesRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';

const MAX_LLM_CALLS = 200;

export async function runReflectionBatch(): Promise<void> {
  const since = sql`now() - interval '24 hours'`;
  const corrections = await db.execute<{ count: number }>(
    sql`SELECT count(*)::int as count FROM ${audit_log} WHERE acao = 'transaction_corrected' AND created_at >= ${since}`,
  );
  const total = (corrections.rows[0] as { count: number } | undefined)?.count ?? 0;
  if (total === 0) {
    logger.info('reflection_batch.no_signal');
    return;
  }

  // Sample recent corrections (cap LLM calls)
  const sample = await db.execute<{ acao: string; metadata: unknown; alvo_id: string | null }>(
    sql`SELECT acao, metadata, alvo_id FROM ${audit_log}
        WHERE acao = 'transaction_corrected' AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT ${MAX_LLM_CALLS}`,
  );
  let created = 0;
  for (const row of sample.rows.slice(0, MAX_LLM_CALLS)) {
    try {
      const res = await callLLM({
        system:
          'Você é a Maia em modo reflexão noturna (Haiku). Dada uma correção, proponha uma regra em JSON: {"applicable": boolean, "tipo": "classificacao"|"identificacao_entidade", "contexto": string, "acao": string}. Se não aplicável, {"applicable": false}.',
        messages: [{ role: 'user', content: JSON.stringify(row) }],
        max_tokens: 300,
        temperature: 0.0,
      });
      const text = res.content ?? '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const parsed = JSON.parse(m[0]) as {
        applicable?: boolean;
        tipo?: string;
        contexto?: string;
        acao?: string;
      };
      if (!parsed.applicable || !parsed.tipo || !parsed.contexto || !parsed.acao) continue;
      const r = await rulesRepo.create({
        tipo: parsed.tipo,
        contexto: parsed.contexto,
        acao: parsed.acao,
        contexto_jsonb: {},
        acoes_jsonb: {},
        confianca: '0.50',
        acertos: 0,
        erros: 0,
        ativa: true,
        exemplo_origem_id: null,
      });
      await audit({ acao: 'rule_learned', alvo_id: r.id, metadata: { source: 'batch' } });
      created++;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'reflection_batch.item_failed');
    }
  }
  void mensagens;
  void transacoes;
  logger.info({ created, sample_size: sample.rows.length }, 'reflection_batch.done');
}
