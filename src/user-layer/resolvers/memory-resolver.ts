import { and, eq, isNull, lte, desc, inArray, ilike, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { memory_entry } from '../../db/schema.js';
import { isVisibleLifecycle } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

export interface MemoryListInput {
  tenant_id: string;
  pessoa_id?: string;
  scope?: string[];
  memory_types?: string[];
  intent_filter?: string;
  limit: number;
  caller_agent_id?: string; // SOMENTE para policy/audit, NÃO para filter
}

export interface MemoryItem {
  id: string;
  conteudo: string;
  memory_type: string;
  scope: string;
  sensitivity: 'low' | 'medium' | 'high';
  proactive_use: boolean;
  mention_allowed: boolean;
  ttl_days: number | null;
  expires_at: string | null;
  needs_review: boolean;
  confidence: number;
  lifecycle_status: KnowledgeLifecycleStatus;
  created_at: string;
}

export interface MemoryUpsertInput {
  tenant_id: string;
  pessoa_id: string;
  conteudo: string;
  memory_type: string;
  scope: string;
  sensitivity: 'low' | 'medium' | 'high';
  proactive_use: boolean;
  mention_allowed: boolean;
  ttl_days?: number;
  lifecycle_status?: KnowledgeLifecycleStatus;
  caller_agent_id?: string;
}

export const memoryResolver = {
  async list(input: MemoryListInput): Promise<MemoryItem[]> {
    const now = new Date();
    const conditions = [
      eq(memory_entry.tenant_id, input.tenant_id),
      isVisibleLifecycle(memory_entry.lifecycle_status),
      or(
        isNull(memory_entry.expires_at),
        lte(memory_entry.expires_at, now),
      ),
    ];

    if (input.pessoa_id) {
      conditions.push(eq(memory_entry.pessoa_id, input.pessoa_id));
    }
    if (input.scope?.length) {
      conditions.push(inArray(memory_entry.scope, input.scope));
    }
    if (input.memory_types?.length) {
      conditions.push(inArray(memory_entry.memory_type, input.memory_types));
    }

    let query = db.select().from(memory_entry).where(and(...conditions));

    if (input.intent_filter) {
      // Ideally use vector recall; fallback to ILIKE
      query = query.where(
        ilike(memory_entry.conteudo, `%${input.intent_filter}%`),
      );
    }

    const rows = await query
      .orderBy(desc(memory_entry.created_at))
      .limit(input.limit);

    return rows.map((r) => ({
      id: r.id,
      conteudo: r.conteudo,
      memory_type: r.memory_type,
      scope: r.scope,
      sensitivity: r.sensitivity as MemoryItem['sensitivity'],
      proactive_use: r.proactive_use,
      mention_allowed: r.mention_allowed,
      ttl_days: r.ttl_days,
      expires_at: r.expires_at?.toISOString() ?? null,
      needs_review: r.needs_review ?? false,
      confidence: Number(r.confidence),
      lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
      created_at: r.created_at?.toISOString() ?? '',
    }));
  },

  async upsert(input: MemoryUpsertInput): Promise<MemoryItem> {
    const expiresAt = input.ttl_days
      ? new Date(Date.now() + input.ttl_days * 86400000)
      : null;

    const [inserted] = await db
      .insert(memory_entry)
      .values({
        tenant_id: input.tenant_id,
        pessoa_id: input.pessoa_id,
        conteudo: input.conteudo,
        memory_type: input.memory_type,
        scope: input.scope,
        sensitivity: input.sensitivity,
        proactive_use: input.proactive_use,
        mention_allowed: input.mention_allowed,
        ttl_days: input.ttl_days ?? null,
        expires_at: expiresAt,
        lifecycle_status: input.lifecycle_status ?? 'active',
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      throw new Error('Failed to upsert memory');
    }

    return {
      id: inserted.id,
      conteudo: inserted.conteudo,
      memory_type: inserted.memory_type,
      scope: inserted.scope,
      sensitivity: inserted.sensitivity as MemoryItem['sensitivity'],
      proactive_use: inserted.proactive_use,
      mention_allowed: inserted.mention_allowed,
      ttl_days: inserted.ttl_days,
      expires_at: inserted.expires_at?.toISOString() ?? null,
      needs_review: inserted.needs_review ?? false,
      confidence: Number(inserted.confidence),
      lifecycle_status: inserted.lifecycle_status as KnowledgeLifecycleStatus,
      created_at: inserted.created_at?.toISOString() ?? '',
    };
  },

  async markObserved(id: string, by_agent_id?: string): Promise<void> {
    await db
      .update(memory_entry)
      .set({ /* last_observed_at, etc. — optional metadata */ })
      .where(eq(memory_entry.id, id));
  },
};
