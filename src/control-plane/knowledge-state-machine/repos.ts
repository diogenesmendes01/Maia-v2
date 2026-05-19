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
  KnowledgeProposalNativeFields,
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
  /**
   * Codex round-2 finding 2 — preserves table-native columns
   * (escopo/chave/tipo/contexto/acao/scope_type/subject_id/etc.) so
   * proposed rows match what the legacy read paths look for.
   */
  native?: KnowledgeProposalNativeFields;
}

interface UpdateInput {
  lifecycle_status?: KnowledgeLifecycleStatus;
  lifecycle_transitions?: KnowledgeTransitionRecord[];
  evidence_count?: number;
  /**
   * Optimistic concurrency guard — when set, the UPDATE includes a
   * `WHERE lifecycle_status = expected_previous_status` predicate so a
   * stale read (e.g. an auto-promoter tick racing with a human revoke)
   * cannot overwrite the latest persisted status. The repo returns
   * false when affected rows = 0 so the caller can retry/refresh.
   * See Codex review #104 — without this, a parallel revoke can be lost.
   */
  expected_previous_status?: KnowledgeLifecycleStatus;
}

/**
 * Thrown by `knowledgeRepos.update` when an optimistic-concurrency
 * conditional update finds 0 affected rows. The state-machine catches
 * this, re-reads the row, and translates it into IllegalTransitionError
 * (lost-revoke scenario) or a benign skip (already-promoted scenario).
 */
export class KnowledgeConflictError extends Error {
  constructor(
    public readonly kind: KnowledgeKind,
    public readonly id: string,
    public readonly expected_previous_status: KnowledgeLifecycleStatus,
  ) {
    super(
      `knowledge_conflict:${kind}:${id}:expected_${expected_previous_status}`,
    );
    this.name = 'KnowledgeConflictError';
  }
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
    const native = input.native ?? {};
    switch (input.kind) {
      case 'fact': {
        // Codex round-2 finding 2: legacy read paths look for
        // `pessoa:<id>` / `entidade:<id>` / `global` / `tenant` in
        // agent_facts.escopo. The previous facade wrote
        // `user:<id>` / `agent:<id>`, breaking factsRepo.listForScopes.
        // Prefer `native.fact_escopo` when callers supply it; otherwise
        // map known generic scopes back to the legacy convention.
        const escopo =
          native.fact_escopo ??
          (input.scope === 'user' && input.scope_value
            ? `pessoa:${input.scope_value}`
            : input.scope === 'agent' && input.scope_value
              ? `entidade:${input.scope_value}`
              : input.scope === 'tenant'
                ? 'tenant'
                : input.scope === 'global'
                  ? 'global'
                  : input.scope_value
                    ? `${input.scope}:${input.scope_value}`
                    : input.scope);
        const chave = native.fact_chave ?? input.key;
        const rows = await db
          .insert(agent_facts)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            escopo,
            chave,
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
        // Codex round-2 finding 2: preserve tipo/contexto/acao verbatim
        // from the proposer. Previously the facade hard-coded
        // tipo='classificacao' and lost the LLM's structured contexto/acao
        // payload. We also keep `ativa=true` on insert so the column
        // semantics are "this rule is not disabled" — lifecycle_status
        // is the source of truth for visibility, and rulesRepo.listActive
        // now relies on lifecycle_status instead of ativa.
        const tipo = native.rule_tipo ?? 'classificacao';
        const contexto = native.rule_contexto ?? input.content_text.slice(0, 4000);
        const acao =
          native.rule_acao ??
          (typeof input.content === 'string' ? input.content : input.key);
        const rows = await db
          .insert(learned_rules)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            tipo,
            contexto,
            acao,
            contexto_jsonb: (native.rule_contexto_jsonb ?? {}) as object,
            acoes_jsonb: (native.rule_acoes_jsonb ?? {}) as object,
            confianca: String(input.confidence),
            ativa: true,
            lifecycle_status: input.lifecycle_status,
            evidence_count: input.evidence_count,
            lifecycle_transitions: input.lifecycle_transitions as unknown as object,
          })
          .returning({ id: learned_rules.id });
        return String(rows[0]?.id ?? '');
      }
      case 'memory': {
        // Codex round-2 finding 2: memory_entry needs scope_type +
        // subject_id + interlocutor_id + conversa_id round-tripped from
        // the proposer so `findRelevant` can match by
        // interlocutor/role/channel/conversation. The previous facade
        // wrote scope_type=<generic kind scope> (e.g. 'user', 'session')
        // which findRelevant never looks for.
        const ttlDays =
          input.ttl_days ?? (input.lifecycle_status === 'ephemeral' ? 30 : 90);
        const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
        const scopeType =
          native.memory_scope_type ??
          (input.scope === 'user'
            ? 'interlocutor'
            : input.scope === 'session'
              ? 'conversation'
              : input.scope === 'agent'
                ? 'agent'
                : input.scope === 'tenant'
                  ? 'tenant'
                  : 'agent');
        const subjectId = native.memory_subject_id ?? input.scope_value ?? null;
        const sensitivity = native.memory_sensitivity ?? 'low';
        const rows = await db
          .insert(memory_entry)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            content: input.content_text,
            memory_type: native.memory_type ?? input.key,
            scope_type: scopeType,
            subject_id: subjectId,
            interlocutor_id: native.memory_interlocutor_id ?? null,
            conversa_id: native.memory_conversa_id ?? null,
            sensitivity,
            proactive_use: native.memory_proactive_use ?? false,
            mention_allowed: native.memory_mention_allowed ?? false,
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
        // Codex round-2 finding 2: behavioral_hint.scope_type accepts
        // `interlocutor`/`role`/`channel`/`conversation`/`agent`/`tenant`.
        // The previous facade wrote the generic KnowledgeScope literal
        // (`user`, `session`, etc.), which the prompt-builder lookup
        // can't match. Prefer `native.hint_scope_type` and fall back to
        // a sensible mapping from the generic scope.
        const ttlDays =
          input.ttl_days ?? (input.lifecycle_status === 'ephemeral' ? 14 : 60);
        const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
        const scopeType =
          native.hint_scope_type ??
          (input.scope === 'user'
            ? 'interlocutor'
            : input.scope === 'session'
              ? 'conversation'
              : input.scope === 'agent'
                ? 'agent'
                : input.scope === 'tenant'
                  ? 'tenant'
                  : 'agent');
        const rows = await db
          .insert(behavioral_hint)
          .values({
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            scope_type: scopeType,
            subject_id: native.hint_subject_id ?? input.scope_value ?? null,
            hint_text: input.content_text,
            derived_sensitivity: native.hint_derived_sensitivity ?? 'low',
            derived_from_memory_id: native.hint_derived_from_memory_id ?? null,
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

  /**
   * Update a knowledge row.
   *
   * When `updates.expected_previous_status` is set, the UPDATE includes
   * a `WHERE lifecycle_status = <expected>` predicate so it only fires
   * when the persisted state still matches what the caller read. If
   * another writer changed the row in between, affected rows = 0 and
   * we throw KnowledgeConflictError. The state-machine catches and
   * surfaces this as an IllegalTransitionError after re-reading.
   *
   * Without the expected-previous guard, a worker promotion and a
   * concurrent human revoke can both read the same old status, and the
   * second write wins blindly — so a revoke can be lost and a terminal
   * row "resurrected". See Codex review #104 (critical).
   */
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

    const expected = updates.expected_previous_status;

    switch (kind) {
      case 'fact': {
        const where = expected
          ? and(eq(agent_facts.id, id), eq(agent_facts.lifecycle_status, expected))
          : eq(agent_facts.id, id);
        const rows = await db
          .update(agent_facts)
          .set(set)
          .where(where)
          .returning({ id: agent_facts.id });
        if (expected && rows.length === 0) {
          throw new KnowledgeConflictError(kind, id, expected);
        }
        return;
      }
      case 'rule': {
        const where = expected
          ? and(
              eq(learned_rules.id, id),
              eq(learned_rules.lifecycle_status, expected),
            )
          : eq(learned_rules.id, id);
        const rows = await db
          .update(learned_rules)
          .set(set)
          .where(where)
          .returning({ id: learned_rules.id });
        if (expected && rows.length === 0) {
          throw new KnowledgeConflictError(kind, id, expected);
        }
        return;
      }
      case 'memory': {
        const where = expected
          ? and(
              eq(memory_entry.id, id),
              eq(memory_entry.lifecycle_status, expected),
            )
          : eq(memory_entry.id, id);
        const rows = await db
          .update(memory_entry)
          .set(set)
          .where(where)
          .returning({ id: memory_entry.id });
        if (expected && rows.length === 0) {
          throw new KnowledgeConflictError(kind, id, expected);
        }
        return;
      }
      case 'behavioral_hint':
      case 'procedure_hint': {
        const where = expected
          ? and(
              eq(behavioral_hint.id, id),
              eq(behavioral_hint.lifecycle_status, expected),
            )
          : eq(behavioral_hint.id, id);
        const rows = await db
          .update(behavioral_hint)
          .set(set)
          .where(where)
          .returning({ id: behavioral_hint.id });
        if (expected && rows.length === 0) {
          throw new KnowledgeConflictError(kind, id, expected);
        }
        return;
      }
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
