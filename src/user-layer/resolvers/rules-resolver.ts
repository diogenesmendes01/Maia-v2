import { and, eq, desc, ilike } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { learned_rules } from '../../db/schema.js';
import { isVisibleLifecycle } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

export interface RuleItem {
  id: string;
  context: string;
  action: string;
  confidence: number;
  acertos: number;
  erros: number;
  ativa: boolean;
  lifecycle_status: KnowledgeLifecycleStatus;
}

export const rulesResolver = {
  async list(input: {
    tenant_id: string;
    intent_filter?: string;
    only_active?: boolean;
    limit: number;
  }): Promise<RuleItem[]> {
    const conditions = [
      eq(learned_rules.tenant_id, input.tenant_id),
      isVisibleLifecycle(learned_rules.lifecycle_status),
    ];

    if (input.only_active) {
      conditions.push(eq(learned_rules.ativa, true));
    }

    let query = db.select().from(learned_rules).where(and(...conditions));

    if (input.intent_filter) {
      query = query.where(
        ilike(learned_rules.contexto, `%${input.intent_filter}%`),
      );
    }

    const rows = await query
      .orderBy(desc(learned_rules.confianca), desc(learned_rules.updated_at))
      .limit(input.limit);

    return rows.map((r) => ({
      id: r.id,
      context: r.contexto,
      action: r.acao,
      confidence: Number(r.confianca),
      acertos: r.acertos,
      erros: r.erros,
      ativa: r.ativa,
      lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
    }));
  },
};
