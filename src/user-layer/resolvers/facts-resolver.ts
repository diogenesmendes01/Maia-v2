import { and, eq, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agent_facts } from '../../db/schema.js';
import { isVisibleLifecycle } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

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
    scope?: Array<'global' | 'tenant' | 'domain' | 'entity'>;
    keys?: string[];
    limit: number;
  }): Promise<FactItem[]> {
    const conditions = [
      eq(agent_facts.tenant_id, input.tenant_id),
      isVisibleLifecycle(agent_facts.lifecycle_status),
    ];
    if (input.scope?.length) {
      conditions.push(inArray(agent_facts.escopo, input.scope));
    }
    if (input.keys?.length) {
      conditions.push(inArray(agent_facts.chave, input.keys));
    }

    const rows = await db
      .select()
      .from(agent_facts)
      .where(and(...conditions))
      .orderBy(desc(agent_facts.confianca), desc(agent_facts.updated_at))
      .limit(input.limit);

    return rows.map((r) => ({
      id: r.id,
      key: r.chave,
      value: r.valor,
      scope: r.escopo as FactItem['scope'],
      confidence: Number(r.confianca),
      source: r.fonte,
      ultima_validacao: r.ultima_validacao?.toISOString() ?? null,
      lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
    }));
  },
};
