/**
 * P10a — Knowledge repos facade.
 *
 * Provides a unified create / findById / update / listEligible /
 * countByStatus API across the four knowledge tables:
 *   - memory_entry      (kind='memory')
 *   - agent_facts       (kind='fact')
 *   - learned_rules     (kind='rule')
 *   - behavioral_hint   (kind='behavioral_hint' / 'procedure_hint')
 *
 * The facade hides the table-specific column naming (Portuguese vs.
 * English) by writing the operational fields the KSM needs into the
 * P10a-added columns (lifecycle_status, evidence_count,
 * lifecycle_transitions, updated_at) and persisting the kind-specific
 * payload in the legacy columns each table already exposes.
 *
 * This keeps the legacy upsert/listForScopes paths (factsRepo /
 * memoryEntryRepo / etc.) intact for callers that haven't migrated to
 * propose_* tools yet — they continue to write rows with
 * lifecycle_status='active' by DB default.
 */

import { and, eq, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  agent_facts,
  behavioral_hint,
  learned_rules,
  memory_entry,
} from '@/db/schema.js';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeRow,
  KnowledgeTransitionRecord,
} from './types.js';

interface CreateInput {
  tenant_id: string;
  agent_id: string;
  kind: KnowledgeKind;
  key: string;
  scope: string;
  scope_value?: string;
  content: unknown;
  content_text: string;
  confidence: number;
  lifecycle_status: KnowledgeLifecycleStatus;
  lifecycle_transitions: KnowledgeTransitionRecord[];
  evidence_count: number;
  ttl_days?: number;
}

interface UpdateInput {
  lifecycle_status?: KnowledgeLifecycleStatus;
  lifecycle_transitions?: KnowledgeTransitionRecord[];
  evidence_count?: number;
}

type AnyRow = Record<string, unknown>;

function normaliseRow(raw: AnyRow): KnowledgeRow {
  const lifecycleTransitionsRaw = raw['lifecycle_transitions'];
  const transitions: KnowledgeTransitionRecord[] = Array.isArray(
    lifecycleTransitionsRaw,
  )
    ? (lifecycleTransitionsRaw as KnowledgeTransitionRecord[])
    : [];
  const updatedAt = raw['updated_at'];
  const lastRecall = raw['last_recall_at'];
  const confidenceRaw = raw['confidence'] ?? raw['confianca'];
  return {
    id: String(raw['id']),
    tenant_id: String(raw['tenant_id'] ?? ''),
    agent_id: String(raw['agent_id'] ?? ''),
    lifecycle_status: (raw['lifecycle_status'] as KnowledgeLifecycleStatus) ?? 'active',
    lifecycle_transitions: transitions,
    evidence_count:
      typeof raw['evidence_count'] === 'number'
        ? (raw['evidence_count'] as number)
        : Number(raw['evidence_count'] ?? 0),
    confidence:
      confidenceRaw === undefined || confidenceRaw === null
        ? undefined
        : Number(confidenceRaw),
    updated_at:
      updatedAt instanceof Date
        ? updatedAt
        : new Date(String(updatedAt ?? raw['created_at'] ?? Date.now())),
    last_recall_at:
      lastRecall instanceof Date
        ? lastRecall
        : lastRecall
          ? new Date(String(lastRecall))
          : null,
  };
}

export const knowledgeRepos = {
  async create(input: CreateInput): Promise<string> {
    switch (input.kind) {
      case 'fact': {
        const rows = await db
          .insert(agent_facts)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            escopo: input.scope_value
              ? `${input.scope}:${input.scope_value}`
              : input.scope,
            chave: input.key,
            valor: input.content as object,
            confianca: String(input.confidence),
            fonte: 'aprendido',
            lifecycle_status: input.lifecycle_status,
            evidence_count: input.evidence_count,
            lifecycle_transitions: input.lifecycle_transitions as unknown as object,
          })
          .returning({ id: agent_facts.id });
        return String(rows[0]?.id ?? '');
      }
      case 'rule': {
        const rows = await db
          .insert(learned_rules)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            tipo: 'classificacao',
            contexto: input.content_text.slice(0, 4000),
            acao: typeof input.content === 'string' ? input.content : input.key,
            confianca: String(input.confidence),
            ativa: input.lifecycle_status === 'active',
            lifecycle_status: input.lifecycle_status,
            evidence_count: input.evidence_count,
            lifecycle_transitions: input.lifecycle_transitions as unknown as object,
          })
          .returning({ id: learned_rules.id });
        return String(rows[0]?.id ?? '');
      }
      case 'memory': {
        const ttlDays =
          input.ttl_days ?? (input.lifecycle_status === 'ephemeral' ? 30 : 90);
        const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
        const rows = await db
          .insert(memory_entry)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            content: input.content_text,
            memory_type: input.key,
            scope_type: input.scope,
            subject_id: input.scope_value ?? null,
            sensitivity: 'low',
            proactive_use: false,
            mention_allowed: false,
            ttl_days: ttlDays,
            needs_review: false,
            expires_at: expiresAt,
            confidence: String(input.confidence),
            lifecycle_status: input.lifecycle_status,
            evidence_count: input.evidence_count,
            lifecycle_transitions: input.lifecycle_transitions as unknown as object,
          })
          .returning({ id: memory_entry.id });
        return String(rows[0]?.id ?? '');
      }
      case 'behavioral_hint':
      case 'procedure_hint': {
        const ttlDays =
          input.ttl_days ?? (input.lifecycle_status === 'ephemeral' ? 14 : 60);
        const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
        const rows = await db
          .insert(behavioral_hint)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            scope_type: input.scope,
            subject_id: input.scope_value ?? null,
            hint_text: input.content_text,
            derived_sensitivity: 'low',
            ttl_days: ttlDays,
            expires_at: expiresAt,
            confidence: String(input.confidence),
            lifecycle_status: input.lifecycle_status,
            evidence_count: input.evidence_count,
            lifecycle_transitions: input.lifecycle_transitions as unknown as object,
          })
          .returning({ id: behavioral_hint.id });
        return String(rows[0]?.id ?? '');
      }
      default: {
        const _exhaustive: never = input.kind;
        throw new Error(`unknown knowledge kind: ${String(_exhaustive)}`);
      }
    }
  },

  async findById(
    kind: KnowledgeKind,
    id: string,
  ): Promise<KnowledgeRow | null> {
    switch (kind) {
      case 'fact': {
        const rows = await db
          .select()
          .from(agent_facts)
          .where(eq(agent_facts.id, id))
          .limit(1);
        const row = rows[0];
        return row ? normaliseRow(row as unknown as AnyRow) : null;
      }
      case 'rule': {
        const rows = await db
          .select()
          .from(learned_rules)
          .where(eq(learned_rules.id, id))
          .limit(1);
        const row = rows[0];
        return row ? normaliseRow(row as unknown as AnyRow) : null;
      }
      case 'memory': {
        const rows = await db
          .select()
          .from(memory_entry)
          .where(eq(memory_entry.id, id))
          .limit(1);
        const row = rows[0];
        return row ? normaliseRow(row as unknown as AnyRow) : null;
      }
      case 'behavioral_hint':
      case 'procedure_hint': {
        const rows = await db
          .select()
          .from(behavioral_hint)
          .where(eq(behavioral_hint.id, id))
          .limit(1);
        const row = rows[0];
        return row ? normaliseRow(row as unknown as AnyRow) : null;
      }
      default: {
        const _exhaustive: never = kind;
        throw new Error(`unknown knowledge kind: ${String(_exhaustive)}`);
      }
    }
  },

  async update(
    kind: KnowledgeKind,
    id: string,
    updates: UpdateInput,
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (updates.lifecycle_status !== undefined) {
      set['lifecycle_status'] = updates.lifecycle_status;
    }
    if (updates.lifecycle_transitions !== undefined) {
      set['lifecycle_transitions'] = updates.lifecycle_transitions;
    }
    if (updates.evidence_count !== undefined) {
      set['evidence_count'] = updates.evidence_count;
    }

    switch (kind) {
      case 'fact':
        await db.update(agent_facts).set(set).where(eq(agent_facts.id, id));
        return;
      case 'rule':
        await db.update(learned_rules).set(set).where(eq(learned_rules.id, id));
        return;
      case 'memory':
        await db.update(memory_entry).set(set).where(eq(memory_entry.id, id));
        return;
      case 'behavioral_hint':
      case 'procedure_hint':
        await db
          .update(behavioral_hint)
          .set(set)
          .where(eq(behavioral_hint.id, id));
        return;
      default: {
        const _exhaustive: never = kind;
        throw new Error(`unknown knowledge kind: ${String(_exhaustive)}`);
      }
    }
  },

  /**
   * Used by the auto-promoter to find rows eligible for a state
   * transition. Returns `{id, lifecycle_status}` pairs only — the
   * promoter loops single-row transitions through
   * KnowledgeStateMachine.transition so audit invariants hold.
   *
   * `evidenceFilter` is a SQL predicate string that gets ANDed onto
   * the lifecycle_status filter. We build it via `sql.raw` only for
   * fixed-shape comparisons the promoter owns.
   */
  async listEligible(args: {
    kind: KnowledgeKind;
    from: KnowledgeLifecycleStatus;
    extraFilter: SQL;
    limit?: number;
  }): Promise<Array<{ id: string }>> {
    const limit = args.limit ?? 100;
    const fromVal = args.from;
    switch (args.kind) {
      case 'fact': {
        return (await db
          .select({ id: agent_facts.id })
          .from(agent_facts)
          .where(
            and(eq(agent_facts.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{ id: string }>;
      }
      case 'rule': {
        return (await db
          .select({ id: learned_rules.id })
          .from(learned_rules)
          .where(
            and(eq(learned_rules.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{ id: string }>;
      }
      case 'memory': {
        return (await db
          .select({ id: memory_entry.id })
          .from(memory_entry)
          .where(
            and(eq(memory_entry.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{ id: string }>;
      }
      case 'behavioral_hint':
      case 'procedure_hint': {
        return (await db
          .select({ id: behavioral_hint.id })
          .from(behavioral_hint)
          .where(
            and(eq(behavioral_hint.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{ id: string }>;
      }
      default: {
        const _exhaustive: never = args.kind;
        throw new Error(`unknown knowledge kind: ${String(_exhaustive)}`);
      }
    }
  },

  /**
   * Helper that builds the per-table updated_at threshold filter used
   * by the auto-promoter (e.g. "updated_at < NOW() - INTERVAL '30 days'").
   */
  buildUpdatedAtFilter(args: {
    kind: KnowledgeKind;
    olderThanMs?: number;
    newerThanMs?: number;
  }): SQL {
    const clauses: SQL[] = [];
    if (args.olderThanMs !== undefined) {
      const cutoff = new Date(Date.now() - args.olderThanMs);
      clauses.push(sql`updated_at < ${cutoff}`);
    }
    if (args.newerThanMs !== undefined) {
      const cutoff = new Date(Date.now() - args.newerThanMs);
      clauses.push(sql`updated_at >= ${cutoff}`);
    }
    if (clauses.length === 0) return sql`true`;
    if (clauses.length === 1) return clauses[0]!;
    return sql`${clauses[0]} AND ${clauses[1]}`;
  },
};

export type { SQL };
// Re-export for the worker to compose evidence_count predicates.
export { sql, lte };
