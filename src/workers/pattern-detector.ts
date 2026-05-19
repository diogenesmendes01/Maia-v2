import { db } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';

const MIN_OCCURRENCES = 3;

/**
 * Detecta padrões repetidos em audit_log nas últimas 24h.
 * P0-era single-tenant shim: roda em escopo do tenant 'default'.
 *
 * FIXME(P6 multi-tenant): este corpo precisa
 *   1. enumerar tuplas (tenant_id, agent_id) ativas;
 *   2. para cada uma, rodar este corpo dentro de `runWithTenantContext`;
 *   3. trocar os literais `'default'` na WHERE pelos `getCurrentTenant()/getCurrentAgent()`;
 *   4. confirmar que `evidence_ids = array_agg(alvo_id)` só agrega `alvo_id`
 *      do tenant atual (atualmente é garantido pelo WHERE; deixar comentário
 *      pra que a refatoração não esqueça do filtro).
 */
export async function runPatternDetector(): Promise<void> {
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    // The WHERE clause already restricts to the current tenant/agent, so
    // `array_agg(alvo_id)` cannot contain ids from other tenants. Keep this
    // invariant when generalising to multi-tenant in P6.
    const rows = await db.execute<{ pattern: string; count: number; alvo_ids: string[] }>(sql`
      SELECT
        acao || '|' || COALESCE((metadata->>'descricao'), '') AS pattern,
        count(*) AS count,
        array_agg(DISTINCT alvo_id::text) FILTER (WHERE alvo_id IS NOT NULL) AS alvo_ids
      FROM ${audit_log}
      WHERE tenant_id = 'default'
        AND agent_id = 'default'
        AND created_at >= now() - interval '24 hours'
      GROUP BY pattern
      HAVING count(*) >= ${MIN_OCCURRENCES}
      ORDER BY count DESC
      LIMIT 20
    `);

    for (const r of rows.rows as Array<{ pattern: string; count: number; alvo_ids: string[] }>) {
      const event = {
        type: CognitiveEventType.PATTERN_DETECTED,
        pattern_descriptor: r.pattern,
        evidence_count: Number(r.count),
        evidence_ids: r.alvo_ids ?? [],
      } as const;
      try {
        const reflected = await reflect(event);
        if (!reflected) continue;
        const classified = await classify(reflected.insight);
        if (!classified) continue;
        await persistCandidate(classified, event, 'worker');
      } catch (err) {
        logger.warn({ err: (err as Error).message, pattern: r.pattern }, 'pattern_detector.failed');
      }
    }
  });
}
