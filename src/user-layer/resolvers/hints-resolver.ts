import { and, eq, desc, isNull, gt, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { behavioral_hint } from '../../db/schema.js';
import { isVisibleLifecycle } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

/**
 * hints-resolver — facade over behavioral_hint table.
 *
 * Tenant-scoped: filters by tenant_id ALWAYS, never by agent_id as predicate.
 * Applies lifecycle visibility (KSM) + active-window (not revoked, not expired).
 *
 * Schema mapping:
 *   behavioral_hint.hint_text     → HintItem.hint
 *   behavioral_hint.scope_type/subject_id → HintItem.scope (composite)
 *   behavioral_hint.confidence    → HintItem.confidence
 *   behavioral_hint.lifecycle_status → HintItem.lifecycle_status
 *   pessoa_id filter maps to subject_id when scope_type='interlocutor'
 */

export interface HintItem {
  id: string;
  hint: string;
  scope: string;
  confidence: number;
  lifecycle_status: KnowledgeLifecycleStatus;
}

export const hintsResolver = {
  async list(input: {
    tenant_id: string;
    /**
     * PR #94 round-2: agent_id from enforceTenantBoundary ensures sibling
     * agents within the same tenant cannot read each other's hints.
     */
    agent_id?: string;
    pessoa_id?: string;
    scope?: string[];
    limit: number;
  }): Promise<HintItem[]> {
    const now = new Date();
    const conditions = [
      eq(behavioral_hint.tenant_id, input.tenant_id),
      isVisibleLifecycle(behavioral_hint.lifecycle_status),
      // Active hints: not revoked + not expired (or no expiration)
      isNull(behavioral_hint.revoked_at),
      or(
        isNull(behavioral_hint.expires_at),
        gt(behavioral_hint.expires_at, now),
      ),
    ];

    // PR #94 round-2 high: enforce agent isolation.
    if (input.agent_id) {
      conditions.push(eq(behavioral_hint.agent_id, input.agent_id));
    }

    if (input.pessoa_id) {
      conditions.push(eq(behavioral_hint.subject_id, input.pessoa_id));
    }

    const rows = await db
      .select()
      .from(behavioral_hint)
      .where(and(...conditions))
      .orderBy(desc(behavioral_hint.confidence), desc(behavioral_hint.created_at))
      .limit(input.limit);

    return rows.map((r) => ({
      id: r.id,
      hint: r.hint_text,
      scope: r.subject_id ? `${r.scope_type}:${r.subject_id}` : r.scope_type,
      confidence: Number(r.confidence),
      lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
    }));
  },
};
