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
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { TypedError } from '@/lib/utils.js';
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
        // Issue #254 — cross-tenant guard. `agent_facts` reads via the
        // KSM facade must be tenant/agent-scoped so a UUID from tenant-B
        // cannot be fetched (and subsequently mutated) under tenant-A's
        // context. Mirrors the `kind: 'rule'` guard added in PR #243
        // (issue #234). ALS contract: callers MUST establish tenant
        // context via `runWithTenantContext` before invoking the KSM.
        // The auto-promoter (workers/knowledge-state-promoter.ts) wraps
        // each per-row transition() call using the row's persisted
        // tenant_id+agent_id (extended for all 4 kinds by PR #243).
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const rows = await db
          .select()
          .from(agent_facts)
          .where(
            and(
              eq(agent_facts.id, id),
              eq(agent_facts.tenant_id, tenant_id),
              eq(agent_facts.agent_id, agent_id),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row ? normaliseRow(row as unknown as AnyRow) : null;
      }
      case 'rule': {
        // Issue #234 — cross-tenant guard. `learned_rules` reads via the
        // KSM facade must be tenant/agent-scoped so a UUID from tenant-B
        // cannot be fetched (and subsequently mutated) under tenant-A's
        // context. Reads through `rulesRepo.byId` already enforce this
        // (src/db/repositories.ts); the KSM facade was bypassing it.
        // ALS contract: callers MUST establish tenant context via
        // `runWithTenantContext` before invoking the KSM. The
        // auto-promoter wraps each per-row transition() call using the
        // row's persisted tenant_id+agent_id (workers/knowledge-state-promoter.ts).
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const rows = await db
          .select()
          .from(learned_rules)
          .where(
            and(
              eq(learned_rules.id, id),
              eq(learned_rules.tenant_id, tenant_id),
              eq(learned_rules.agent_id, agent_id),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row ? normaliseRow(row as unknown as AnyRow) : null;
      }
      case 'memory': {
        // Issue #254 — cross-tenant guard. Same pattern as fact/rule.
        // Memory rows are episodic/declarative memories and must never
        // leak across tenants via the KSM facade.
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const rows = await db
          .select()
          .from(memory_entry)
          .where(
            and(
              eq(memory_entry.id, id),
              eq(memory_entry.tenant_id, tenant_id),
              eq(memory_entry.agent_id, agent_id),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row ? normaliseRow(row as unknown as AnyRow) : null;
      }
      case 'behavioral_hint':
      case 'procedure_hint': {
        // Issue #254 — cross-tenant guard. Behavioral hints and
        // procedure hints share the `behavioral_hint` table; same
        // pattern as fact/memory/rule applies.
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const rows = await db
          .select()
          .from(behavioral_hint)
          .where(
            and(
              eq(behavioral_hint.id, id),
              eq(behavioral_hint.tenant_id, tenant_id),
              eq(behavioral_hint.agent_id, agent_id),
            ),
          )
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
        // Issue #254 — cross-tenant guard. Pin tenant_id+agent_id into
        // the UPDATE WHERE so a foreign-tenant fact id cannot be mutated
        // through the KSM facade. Mirrors the `kind: 'rule'` pattern
        // added in PR #243 (issue #234).
        // Failure-mode disambiguation:
        //   1. 0 rows AND no `expected` → tenant_id/agent_id/id mismatch
        //      → throw `TypedError('fact_not_in_scope', ...)`
        //      (greppable in telemetry, never silent on cross-tenant
        //      mutation attempts).
        //   2. 0 rows AND `expected` set → either out-of-scope OR
        //      optimistic-concurrency mismatch. Re-read scoped by
        //      tenant/agent disambiguates: NULL probe → out-of-scope
        //      (`fact_not_in_scope`); non-NULL probe with diverged
        //      lifecycle_status → real concurrency conflict
        //      (`KnowledgeConflictError`, preserves state-machine catch).
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const where = expected
          ? and(
              eq(agent_facts.id, id),
              eq(agent_facts.tenant_id, tenant_id),
              eq(agent_facts.agent_id, agent_id),
              eq(agent_facts.lifecycle_status, expected),
            )
          : and(
              eq(agent_facts.id, id),
              eq(agent_facts.tenant_id, tenant_id),
              eq(agent_facts.agent_id, agent_id),
            );
        const rows = await db
          .update(agent_facts)
          .set(set)
          .where(where)
          .returning({ id: agent_facts.id });
        if (rows.length === 0) {
          if (expected) {
            // Disambiguate scope-miss vs concurrency-miss by re-reading
            // under the SAME tenant/agent scope. Disambiguation matters
            // because the auto-promoter treats IllegalTransitionError
            // (state-machine's surfaced form of KnowledgeConflictError)
            // as benign for parallel-promote races, but cross-tenant
            // attempts MUST surface as `fact_not_in_scope` for
            // telemetry/alerting.
            const probe = await db
              .select({
                id: agent_facts.id,
                lifecycle_status: agent_facts.lifecycle_status,
              })
              .from(agent_facts)
              .where(
                and(
                  eq(agent_facts.id, id),
                  eq(agent_facts.tenant_id, tenant_id),
                  eq(agent_facts.agent_id, agent_id),
                ),
              )
              .limit(1);
            if (probe.length === 0) {
              throw new TypedError(
                'fact_not_in_scope',
                `fact ${id} not found in current tenant/agent scope`,
              );
            }
            // In-scope row exists but lifecycle_status diverged → real
            // optimistic-concurrency conflict.
            throw new KnowledgeConflictError(kind, id, expected);
          }
          // No `expected` and no rows matched → unambiguously out-of-scope
          // (foreign tenant, foreign agent, or unknown id). Loud failure.
          throw new TypedError(
            'fact_not_in_scope',
            `fact ${id} not found in current tenant/agent scope`,
          );
        }
        return;
      }
      case 'rule': {
        // Issue #234 — cross-tenant guard. Pin tenant_id+agent_id into
        // the UPDATE WHERE so a foreign-tenant rule id cannot be mutated
        // through the KSM facade. The mutators on `rulesRepo`
        // (incrementAcerto/incrementErro/setStatus) already enforce this
        // (PR #232 / issue #230); the KSM facade was the remaining hole.
        // Distinguishing the two failure modes:
        //   1. 0 rows AND no `expected` → tenant_id/agent_id/id mismatch
        //      → throw `TypedError('rule_not_in_scope', ...)` to match
        //      rulesRepo behaviour (greppable in telemetry, never silent).
        //   2. 0 rows AND `expected` set → either out-of-scope OR
        //      optimistic-concurrency mismatch. We can't tell which from
        //      affected_rows alone. A re-read scoped by tenant/agent
        //      tells us: a NULL row means out-of-scope (throw
        //      `rule_not_in_scope`); a non-NULL row with a different
        //      lifecycle_status means concurrency mismatch (throw
        //      `KnowledgeConflictError`, preserving the existing
        //      state-machine catch path).
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const where = expected
          ? and(
              eq(learned_rules.id, id),
              eq(learned_rules.tenant_id, tenant_id),
              eq(learned_rules.agent_id, agent_id),
              eq(learned_rules.lifecycle_status, expected),
            )
          : and(
              eq(learned_rules.id, id),
              eq(learned_rules.tenant_id, tenant_id),
              eq(learned_rules.agent_id, agent_id),
            );
        const rows = await db
          .update(learned_rules)
          .set(set)
          .where(where)
          .returning({ id: learned_rules.id });
        if (rows.length === 0) {
          if (expected) {
            // Disambiguate scope-miss vs concurrency-miss by re-reading
            // under the SAME tenant/agent scope. Disambiguation is
            // important because the auto-promoter treats
            // IllegalTransitionError (the state-machine's surfaced form
            // of KnowledgeConflictError) as benign for parallel-promote
            // races, but cross-tenant attempts MUST surface as
            // `rule_not_in_scope` for telemetry/alerting.
            const probe = await db
              .select({
                id: learned_rules.id,
                lifecycle_status: learned_rules.lifecycle_status,
              })
              .from(learned_rules)
              .where(
                and(
                  eq(learned_rules.id, id),
                  eq(learned_rules.tenant_id, tenant_id),
                  eq(learned_rules.agent_id, agent_id),
                ),
              )
              .limit(1);
            if (probe.length === 0) {
              throw new TypedError(
                'rule_not_in_scope',
                `rule ${id} not found in current tenant/agent scope`,
              );
            }
            // In-scope row exists but lifecycle_status diverged → real
            // optimistic-concurrency conflict.
            throw new KnowledgeConflictError(kind, id, expected);
          }
          // No `expected` and no rows matched → unambiguously out-of-scope
          // (foreign tenant, foreign agent, or unknown id). Loud failure.
          throw new TypedError(
            'rule_not_in_scope',
            `rule ${id} not found in current tenant/agent scope`,
          );
        }
        return;
      }
      case 'memory': {
        // Issue #254 — cross-tenant guard. Same disambiguation pattern
        // as fact/rule. See `case 'fact'` above for rationale.
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const where = expected
          ? and(
              eq(memory_entry.id, id),
              eq(memory_entry.tenant_id, tenant_id),
              eq(memory_entry.agent_id, agent_id),
              eq(memory_entry.lifecycle_status, expected),
            )
          : and(
              eq(memory_entry.id, id),
              eq(memory_entry.tenant_id, tenant_id),
              eq(memory_entry.agent_id, agent_id),
            );
        const rows = await db
          .update(memory_entry)
          .set(set)
          .where(where)
          .returning({ id: memory_entry.id });
        if (rows.length === 0) {
          if (expected) {
            const probe = await db
              .select({
                id: memory_entry.id,
                lifecycle_status: memory_entry.lifecycle_status,
              })
              .from(memory_entry)
              .where(
                and(
                  eq(memory_entry.id, id),
                  eq(memory_entry.tenant_id, tenant_id),
                  eq(memory_entry.agent_id, agent_id),
                ),
              )
              .limit(1);
            if (probe.length === 0) {
              throw new TypedError(
                'memory_not_in_scope',
                `memory ${id} not found in current tenant/agent scope`,
              );
            }
            throw new KnowledgeConflictError(kind, id, expected);
          }
          throw new TypedError(
            'memory_not_in_scope',
            `memory ${id} not found in current tenant/agent scope`,
          );
        }
        return;
      }
      case 'behavioral_hint':
      case 'procedure_hint': {
        // Issue #254 — cross-tenant guard. `behavioral_hint` table is
        // shared by both `behavioral_hint` and `procedure_hint` kinds.
        // The TypedError code is derived from the kind so callers can
        // grep by `behavioral_hint_not_in_scope` or
        // `procedure_hint_not_in_scope` independently in telemetry.
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const scopeErrorCode = `${kind}_not_in_scope`;
        const where = expected
          ? and(
              eq(behavioral_hint.id, id),
              eq(behavioral_hint.tenant_id, tenant_id),
              eq(behavioral_hint.agent_id, agent_id),
              eq(behavioral_hint.lifecycle_status, expected),
            )
          : and(
              eq(behavioral_hint.id, id),
              eq(behavioral_hint.tenant_id, tenant_id),
              eq(behavioral_hint.agent_id, agent_id),
            );
        const rows = await db
          .update(behavioral_hint)
          .set(set)
          .where(where)
          .returning({ id: behavioral_hint.id });
        if (rows.length === 0) {
          if (expected) {
            const probe = await db
              .select({
                id: behavioral_hint.id,
                lifecycle_status: behavioral_hint.lifecycle_status,
              })
              .from(behavioral_hint)
              .where(
                and(
                  eq(behavioral_hint.id, id),
                  eq(behavioral_hint.tenant_id, tenant_id),
                  eq(behavioral_hint.agent_id, agent_id),
                ),
              )
              .limit(1);
            if (probe.length === 0) {
              throw new TypedError(
                scopeErrorCode,
                `${kind} ${id} not found in current tenant/agent scope`,
              );
            }
            throw new KnowledgeConflictError(kind, id, expected);
          }
          throw new TypedError(
            scopeErrorCode,
            `${kind} ${id} not found in current tenant/agent scope`,
          );
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
   * transition. Returns `{id, tenant_id, agent_id}` pairs — the
   * promoter loops single-row transitions through
   * KnowledgeStateMachine.transition (so audit invariants hold) AND
   * uses tenant_id/agent_id to establish ALS context via
   * `runWithTenantContext` before invoking transition() (issue #234).
   * Without ALS context the tenant-scoped guard on the KSM facade's
   * `findById`/`update` for `kind: 'rule'` would throw
   * MissingTenantContextError.
   *
   * `extraFilter` is a SQL predicate string that gets ANDed onto
   * the lifecycle_status filter. We build it via `sql.raw` only for
   * fixed-shape comparisons the promoter owns.
   */
  async listEligible(args: {
    kind: KnowledgeKind;
    from: KnowledgeLifecycleStatus;
    extraFilter: SQL;
    limit?: number;
  }): Promise<Array<{ id: string; tenant_id: string; agent_id: string }>> {
    const limit = args.limit ?? 100;
    const fromVal = args.from;
    switch (args.kind) {
      case 'fact': {
        return (await db
          .select({
            id: agent_facts.id,
            tenant_id: agent_facts.tenant_id,
            agent_id: agent_facts.agent_id,
          })
          .from(agent_facts)
          .where(
            and(eq(agent_facts.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{
          id: string;
          tenant_id: string;
          agent_id: string;
        }>;
      }
      case 'rule': {
        return (await db
          .select({
            id: learned_rules.id,
            tenant_id: learned_rules.tenant_id,
            agent_id: learned_rules.agent_id,
          })
          .from(learned_rules)
          .where(
            and(eq(learned_rules.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{
          id: string;
          tenant_id: string;
          agent_id: string;
        }>;
      }
      case 'memory': {
        return (await db
          .select({
            id: memory_entry.id,
            tenant_id: memory_entry.tenant_id,
            agent_id: memory_entry.agent_id,
          })
          .from(memory_entry)
          .where(
            and(eq(memory_entry.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{
          id: string;
          tenant_id: string;
          agent_id: string;
        }>;
      }
      case 'behavioral_hint':
      case 'procedure_hint': {
        return (await db
          .select({
            id: behavioral_hint.id,
            tenant_id: behavioral_hint.tenant_id,
            agent_id: behavioral_hint.agent_id,
          })
          .from(behavioral_hint)
          .where(
            and(eq(behavioral_hint.lifecycle_status, fromVal), args.extraFilter),
          )
          .limit(limit)) as Array<{
          id: string;
          tenant_id: string;
          agent_id: string;
        }>;
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
