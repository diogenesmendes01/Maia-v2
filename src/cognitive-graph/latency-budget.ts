import { db } from '@/db/client.js';
import { cognitive_module_log } from '@/db/schema.js';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { CognitiveLayer } from '@/types/enums.js';

/** P95 simples (interpolação por ordenação). 0 em entrada vazia. */
export function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)]!;
}

export type BudgetCheck = {
  ok: boolean;
  skipped: boolean;
  budget_ms: number | undefined;
};

/**
 * Verifica observed_p95 ≤ baseline_p95 * (1 + budget_percent/100).
 *
 * `baseline_p95_ms=undefined` → gate SKIPPED (`ok=true, skipped=true`). Isto cobre
 * o cenário "ainda não medimos baseline pré-P7" — não bloqueia merge, só não atesta.
 */
export function assertWithinBudget(args: {
  observed_p95_ms: number;
  baseline_p95_ms: number | undefined;
  budget_percent: number;
}): BudgetCheck {
  if (args.baseline_p95_ms === undefined) {
    return { ok: true, skipped: true, budget_ms: undefined };
  }
  const budget = Math.round(args.baseline_p95_ms * (1 + args.budget_percent / 100));
  return { ok: args.observed_p95_ms <= budget, skipped: false, budget_ms: budget };
}

/**
 * Mede p95 do sync path agregando latências por turno em `cognitive_module_log`.
 *
 * Janela default: últimas 24h. Filtra `triggered_by ∈ {sync_required, sync_conditional}`
 * (ASYNC não conta — é fire-and-forget pós-resposta).
 */
export async function measureSyncP95(args: {
  tenant_id: string;
  agent_id: string;
  windowHours?: number;
}): Promise<{ p95_ms: number; sample_size: number }> {
  const windowHours = args.windowHours ?? 24;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // Soma latency por turno_id, depois p95.
  const rows = await db
    .select({
      turno_id: cognitive_module_log.turno_id,
      total: sql<number>`COALESCE(SUM(${cognitive_module_log.latency_ms}), 0)::int`,
    })
    .from(cognitive_module_log)
    .where(
      and(
        eq(cognitive_module_log.tenant_id, args.tenant_id),
        eq(cognitive_module_log.agent_id, args.agent_id),
        gte(cognitive_module_log.ended_at, since),
        inArray(cognitive_module_log.triggered_by, [
          CognitiveLayer.SYNC_REQUIRED,
          CognitiveLayer.SYNC_CONDITIONAL,
        ]),
      ),
    )
    .groupBy(cognitive_module_log.turno_id);

  const perTurnTotals = rows
    .filter((r) => r.turno_id !== null)
    .map((r) => Number(r.total));

  return { p95_ms: computeP95(perTurnTotals), sample_size: perTurnTotals.length };
}
