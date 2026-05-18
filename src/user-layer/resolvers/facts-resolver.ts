import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { VISIBLE_LIFECYCLE_STATES } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

/**
 * facts-resolver — facade over agent_facts.
 *
 * Tenant-scoped: filters by tenant_id ALWAYS (never by agent_id as predicate).
 *
 * Privacy gate (Codex review PR #94 critical #1):
 *   `agent_facts.valor` may carry raw candidate text whose underlying
 *   `memory_entry` is still `needs_review=true` or `mention_allowed=false`.
 *   When migration 038 backfills every legacy row to lifecycle_status='active',
 *   those previously hidden facts would otherwise become eligible for
 *   KnowledgeSlice. We replicate `factsRepo.listMentionableForScopes` (see
 *   `src/db/repositories.ts:832`): a `NOT EXISTS` correlated subquery on
 *   `memory_entry` that excludes any fact whose source memory still requires
 *   review or is not mention-allowed.
 *
 *   Two content-shape disjuncts are matched (same as the repo):
 *     a) `me.content = (af.valor->>'content')` — modern shape
 *     b) `me.content = (af.chave || ': ' || af.valor::text)` — pre-P2
 *        seed shape (migration 017). Facts predating P2 with NO memory_entry
 *        at all are still returned (conservative: 017 guaranteed a
 *        needs_review=true twin that the reclassifier will re-evaluate).
 */

export interface FactItem {
  id: string;
  key: string;
  value: unknown;
  scope: 'global' | 'tenant' | 'domain' | 'entity';
  confidence: number;
  source: string;
  ultima_validacao: string | null;
  lifecycle_status: KnowledgeLifecycleStatus;
}

export const factsResolver = {
  async list(input: {
    tenant_id: string;
    /**
     * PR #94 round-2: agent_id from enforceTenantBoundary ensures sibling
     * agents within the same tenant cannot read each other's facts.
     */
    agent_id?: string;
    scope?: Array<'global' | 'tenant' | 'domain' | 'entity'>;
    keys?: string[];
    limit: number;
  }): Promise<FactItem[]> {
    // Note: kept as raw SQL (mirrors repositories.ts:832) so the correlated
    // NOT EXISTS gate is unambiguous and matches the existing prompt path.
    // Arrays/maybe-empty filters are inlined via `sql.raw` only where the
    // value source is the literal allowlist below — never from user input.
    const visibleStates = VISIBLE_LIFECYCLE_STATES as readonly string[];

    const scopeFilter =
      input.scope && input.scope.length > 0
        ? sql`AND af.escopo = ANY(${input.scope})`
        : sql``;
    const keysFilter =
      input.keys && input.keys.length > 0
        ? sql`AND af.chave = ANY(${input.keys})`
        : sql``;
    // PR #94 round-2 high: enforce agent isolation when agent_id supplied.
    const agentFilter = input.agent_id
      ? sql`AND af.agent_id = ${input.agent_id}`
      : sql``;

    const rows = await db.execute<{
      id: string;
      tenant_id: string;
      agent_id: string;
      escopo: string;
      chave: string;
      valor: unknown;
      confianca: string;
      fonte: string;
      ultima_validacao: Date | null;
      lifecycle_status: string;
    }>(sql`
      SELECT af.*
      FROM agent_facts af
      WHERE af.tenant_id = ${input.tenant_id}
        AND af.lifecycle_status = ANY(${visibleStates})
        ${agentFilter}
        ${scopeFilter}
        ${keysFilter}
        AND NOT EXISTS (
          SELECT 1 FROM memory_entry me
          WHERE me.tenant_id = af.tenant_id
            AND me.agent_id = af.agent_id
            AND (
              me.content = (af.valor->>'content')
              OR me.content = (af.chave || ': ' || af.valor::text)
            )
            AND (
              me.needs_review = true
              OR me.mention_allowed = false
            )
        )
      ORDER BY af.confianca DESC, af.updated_at DESC
      LIMIT ${input.limit}
    `);

    return Array.from(rows.rows as unknown[]).map((raw) => {
      const r = raw as {
        id: string;
        chave: string;
        valor: unknown;
        escopo: string;
        confianca: string;
        fonte: string;
        ultima_validacao: Date | null;
        lifecycle_status: string;
      };
      return {
        id: r.id,
        key: r.chave,
        value: r.valor,
        scope: r.escopo as FactItem['scope'],
        confidence: Number(r.confianca),
        source: r.fonte,
        ultima_validacao: r.ultima_validacao?.toISOString() ?? null,
        lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
      };
    });
  },
};
