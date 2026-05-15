import { and, eq, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { behavioral_hint } from '../../db/schema.js';
import { isVisibleLifecycle } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

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
    pessoa_id?: string;
    scope?: string[];
    limit: number;
  }): Promise<HintItem[]> {
    const conditions = [
      eq(behavioral_hint.tenant_id, input.tenant_id),
      isVisibleLifecycle(behavioral_hint.lifecycle_status),
    ];

    if (input.pessoa_id) {
      conditions.push(eq(behavioral_hint.pessoa_id, input.pessoa_id));
    }

    if (input.scope?.length) {
      conditions.push(inArray(behavioral_hint.escopo, input.scope));
    }

    const rows = await db
      .select()
      .from(behavioral_hint)
      .where(and(...conditions))
      .orderBy(desc(behavioral_hint.confianca), desc(behavioral_hint.created_at))
      .limit(input.limit);

    return rows.map((r) => ({
      id: r.id,
      hint: r.dica,
      scope: r.escopo,
      confidence: Number(r.confianca),
      lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
    }));
  },
};
