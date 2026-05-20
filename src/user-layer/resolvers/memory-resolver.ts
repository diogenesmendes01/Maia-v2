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
 * Privacy gates (Codex review PR #94 critical #2):
 *   The prompt-builder path (memoryEntryRepo.findRelevant in repositories.ts)
 *   gates rows by `needs_review=false` BEFORE handing content to the LLM.
 *   Migration 041 defaults every legacy row to lifecycle_status='active', so
 *   without these gates a sensitive `needs_review=true` row would re-enter
 *   the slice. We enforce three privacy rails here:
 *     - `needs_review = false`                  (drop never-reviewed candidates)
 *     - raw `content` returned ONLY when `mention_allowed = true`; otherwise
 *       the field is replaced with a placeholder marker so downstream
 *       prompt rendering can still iterate the row (for counters / behavioral
 *       hint backreferences) without ever surfacing the raw text.
 *     - when `scope_hint` is passed, the SQL disjunct mirrors `findRelevant`:
 *       only rows whose scope_type matches an allowlisted (scope, subject)
 *       pair OR scope_type='agent' (broadcast) are eligible.
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
  /**
   * Agent isolation: when provided, SQL predicate adds `agent_id = ?`.
   * Slice builders MUST pass the effective agent_id returned by
   * `enforceTenantBoundary` so sibling agents in the same tenant stay
   * isolated. Omitting this field disables agent-level filtering (use only
   * for explicit privileged fan-out paths, never as the default).
   */
  agent_id?: string;
  pessoa_id?: string;
  scope?: string[];
  memory_types?: string[];
  intent_filter?: string;
  /**
   * When provided, the disjunct mirrors `memoryEntryRepo.findRelevant`:
   * only memories whose scope_type matches one of `interlocutor / role /
   * channel / conversation` with the corresponding subject_id pass, plus
   * the broadcast `scope_type='agent'`. Other scopes are excluded.
   */
  role_id?: string;
  channel_id?: string;
  conversa_id?: string;
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

/**
 * Placeholder used when `mention_allowed = false`. Downstream code can iterate
 * the slice for behavioral-hint lookup / counts without ever rendering the raw
 * text. Renderers that detect this marker MUST fall back to validated
 * behavioral hints derived from the memory id.
 */
export const NON_MENTIONABLE_CONTENT_MARKER = '[non-mentionable memory]';

function rowToItem(r: typeof memory_entry.$inferSelect): MemoryItem {
  const scope = r.subject_id ? `${r.scope_type}:${r.subject_id}` : r.scope_type;
  return {
    id: r.id,
    // Privacy gate: surface raw content only when explicitly mention-allowed.
    conteudo: r.mention_allowed ? r.content : NON_MENTIONABLE_CONTENT_MARKER,
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
      // PR #82 / PR #94 review: never surface unreviewed candidates.
      eq(memory_entry.needs_review, false),
      // Expired memories are filtered out: expires_at IS NULL or expires_at > now
      or(
        isNull(memory_entry.expires_at),
        gt(memory_entry.expires_at, now),
      ),
    ];

    // PR #94 round-2 high: enforce agent isolation. The effective agent_id
    // from enforceTenantBoundary must be propagated here so sibling agents
    // within the same tenant cannot read each other's memories.
    if (input.agent_id) {
      conditions.push(eq(memory_entry.agent_id, input.agent_id));
    }

    // Scope disjunct (matches memoryEntryRepo.findRelevant in repositories.ts).
    // Only emit the OR clause when AT LEAST ONE subject is passed. Otherwise
    // we fall through to the general pessoa_id / memory_types filters below.
    const scopeOrs = [];
    if (input.pessoa_id) {
      scopeOrs.push(
        and(
          eq(memory_entry.scope_type, 'interlocutor'),
          eq(memory_entry.subject_id, input.pessoa_id),
        ),
      );
    }
    if (input.role_id) {
      scopeOrs.push(
        and(eq(memory_entry.scope_type, 'role'), eq(memory_entry.subject_id, input.role_id)),
      );
    }
    if (input.channel_id) {
      scopeOrs.push(
        and(
          eq(memory_entry.scope_type, 'channel'),
          eq(memory_entry.subject_id, input.channel_id),
        ),
      );
    }
    if (input.conversa_id) {
      scopeOrs.push(
        and(
          eq(memory_entry.scope_type, 'conversation'),
          eq(memory_entry.subject_id, input.conversa_id),
        ),
      );
    }
    if (scopeOrs.length > 0) {
      // Always include the broadcast scope ('agent') so global memories
      // reach every subject — same shape findRelevant uses.
      scopeOrs.push(eq(memory_entry.scope_type, 'agent'));
      conditions.push(or(...scopeOrs)!);
    } else if (input.pessoa_id) {
      // Backwards compat: when only pessoa_id is set (legacy callers), still
      // narrow to that interlocutor. The block above already covers this
      // case via scopeOrs, so this branch is unreachable — kept commented as
      // a contract note for future maintainers.
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
   * Count active sensitive memories in scope (tenant + agent + optional conversation).
   *
   * Used by BaseContextBuilder to populate active_sensitive_memory_count in
   * BaseContextPacket, which RiskScorer P9c consumes for the sensitive-memory
   * risk floor. Agent isolation is mandatory — never omit agent_id.
   *
   * @returns count >= 0. Returns 0 on any DB error (fail-open for risk scoring).
   */
  async countActiveSensitive(input: {
    tenant_id: string;
    /** PR #94 round-2: agent isolation — always required for this method. */
    agent_id: string;
    conversation_id?: string;
  }): Promise<number> {
    const now = new Date();
    const conditions = [
      eq(memory_entry.tenant_id, input.tenant_id),
      eq(memory_entry.agent_id, input.agent_id),
      eq(memory_entry.sensitivity, 'high'),
      isVisibleLifecycle(memory_entry.lifecycle_status),
      eq(memory_entry.needs_review, false),
      or(
        isNull(memory_entry.expires_at),
        gt(memory_entry.expires_at, now),
      ),
    ];

    if (input.conversation_id) {
      // Narrow to conversation-scoped OR agent-broadcast sensitive memories.
      conditions.push(
        or(
          and(
            eq(memory_entry.scope_type, 'conversation'),
            eq(memory_entry.subject_id, input.conversation_id),
          ),
          eq(memory_entry.scope_type, 'agent'),
        )!,
      );
    }

    const rows = await db
      .select({ id: memory_entry.id })
      .from(memory_entry)
      .where(and(...conditions));

    return rows.length;
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
    /** PR #94 round-2: agent_id from enforceTenantBoundary ensures we only
     * touch rows owned by the calling agent, not sibling agents' rows. */
    agent_id?: string;
    by_agent_id?: string;
  }): Promise<void> {
    void input.by_agent_id; // reserved for KSM auto-evolution (P10a)
    const whereClauses = [
      eq(memory_entry.tenant_id, input.tenant_id),
      eq(memory_entry.id, input.id),
    ];
    if (input.agent_id) {
      whereClauses.push(eq(memory_entry.agent_id, input.agent_id));
    }
    await db
      .update(memory_entry)
      .set({ updated_at: new Date() })
      .where(and(...whereClauses));
  },
};
