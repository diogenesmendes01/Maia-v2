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
    // ATENÇÃO: NÃO chamar `.where()` em sequência. No Drizzle <0.29 o segundo
    // `.where(...)` SUBSTITUI o primeiro silenciosamente, dropando o filtro
    // tenant_id — vazamento cross-tenant verificável quando `intent_filter`
    // está setado. A>=0.29 isso é type error. Empilhar TODAS as condições
    // no array antes do `and(...)` é a forma correta.
    const conditions = [
      eq(learned_rules.tenant_id, input.tenant_id),
      isVisibleLifecycle(learned_rules.lifecycle_status),
    ];

    if (input.only_active) {
      conditions.push(eq(learned_rules.ativa, true));
    }

    if (input.intent_filter) {
      conditions.push(ilike(learned_rules.contexto, `%${input.intent_filter}%`));
    }

    const rows = await db
      .select()
      .from(learned_rules)
      .where(and(...conditions))
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
