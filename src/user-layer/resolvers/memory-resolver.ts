import { and, eq, isNull, gt, desc, inArray, ilike, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { memory_entry } from '../../db/schema.js';
import { isVisibleLifecycle } from '../internal/visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

/**
 * memory-resolver — facade over memory_entry table.
 *
 * Tenant-scoped: filters by tenant_id ALWAYS, never by agent_id as a predicate.
 * Applies lifecycle visibility (KSM) + TTL/expires_at.
 *
 * Schema mapping (P8c keeps schema legacy intact; resolver translates to canonical shape):
 *   memory_entry.content        → MemoryItem.conteudo
 *   memory_entry.interlocutor_id → MemoryItem.pessoa_id (input filter)
 *   memory_entry.scope_type/subject_id → MemoryItem.scope (composite "{scope_type}:{subject_id}")
 *   memory_entry.confidence     → MemoryItem.confidence
 *   memory_entry.lifecycle_status → MemoryItem.lifecycle_status
 */

export interface MemoryListInput {
  tenant_id: string;
  pessoa_id?: string;
  scope?: string[];
  memory_types?: string[];
  intent_filter?: string;
  limit: number;
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
  agent_id: string;
  pessoa_id?: string;
  conteudo: string;
  memory_type: string;
  scope_type: string;
  subject_id?: string;
  sensitivity: 'low' | 'medium' | 'high';
  proactive_use: boolean;
  mention_allowed: boolean;
  ttl_days?: number;
  lifecycle_status?: KnowledgeLifecycleStatus;
}

function rowToItem(r: typeof memory_entry.$inferSelect): MemoryItem {
  const scope = r.subject_id ? `${r.scope_type}:${r.subject_id}` : r.scope_type;
  return {
    id: r.id,
    conteudo: r.content,
    memory_type: r.memory_type,
    scope,
    sensitivity: r.sensitivity as MemoryItem['sensitivity'],
    proactive_use: r.proactive_use,
    mention_allowed: r.mention_allowed,
    ttl_days: r.ttl_days,
    expires_at: r.expires_at?.toISOString() ?? null,
    needs_review: r.needs_review ?? false,
    confidence: Number(r.confidence),
    lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
    created_at: r.created_at?.toISOString() ?? '',
  };
}

export const memoryResolver = {
  async list(input: MemoryListInput): Promise<MemoryItem[]> {
    const now = new Date();
    const conditions = [
      eq(memory_entry.tenant_id, input.tenant_id),
      isVisibleLifecycle(memory_entry.lifecycle_status),
      // Expired memories are filtered out: expires_at IS NULL or expires_at > now
      or(
        isNull(memory_entry.expires_at),
        gt(memory_entry.expires_at, now),
      ),
    ];

    if (input.pessoa_id) {
      conditions.push(eq(memory_entry.interlocutor_id, input.pessoa_id));
    }
    if (input.memory_types?.length) {
      conditions.push(inArray(memory_entry.memory_type, input.memory_types));
    }
    if (input.intent_filter) {
      conditions.push(
        ilike(memory_entry.content, `%${input.intent_filter}%`),
      );
    }

    const rows = await db
      .select()
      .from(memory_entry)
      .where(and(...conditions))
      .orderBy(desc(memory_entry.created_at))
      .limit(input.limit);

    return rows.map(rowToItem);
  },

  async upsert(input: MemoryUpsertInput): Promise<MemoryItem> {
    const expiresAt = input.ttl_days
      ? new Date(Date.now() + input.ttl_days * 86400000)
      : null;

    const [inserted] = await db
      .insert(memory_entry)
      .values({
        tenant_id: input.tenant_id,
        agent_id: input.agent_id,
        interlocutor_id: input.pessoa_id ?? null,
        content: input.conteudo,
        memory_type: input.memory_type,
        scope_type: input.scope_type,
        subject_id: input.subject_id ?? null,
        sensitivity: input.sensitivity,
        proactive_use: input.proactive_use,
        mention_allowed: input.mention_allowed,
        ttl_days: input.ttl_days ?? null,
        expires_at: expiresAt,
        lifecycle_status: input.lifecycle_status ?? 'active',
      })
      .returning();

    if (!inserted) {
      throw new Error('Failed to upsert memory');
    }
    return rowToItem(inserted);
  },

  /**
   * P8c: stub — full KSM lifecycle transitions land in P10a.
   *
   * Requires tenant_id explicitly to keep the cross-tenant invariant intact
   * (the rest of the resolver enforces it on every read/upsert; markObserved
   * MUST follow the same contract even while it's a no-op shell).
   */
  async markObserved(input: {
    tenant_id: string;
    id: string;
    by_agent_id?: string;
  }): Promise<void> {
    void input.by_agent_id; // reserved for KSM auto-evolution (P10a)
    await db
      .update(memory_entry)
      .set({ updated_at: new Date() })
      .where(
        and(
          eq(memory_entry.tenant_id, input.tenant_id),
          eq(memory_entry.id, input.id),
        ),
      );
  },
};
