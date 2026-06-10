import { eq, and, inArray, desc, isNull, sql, or, gt, Param } from 'drizzle-orm';
import { db } from '../client.js';
import {
  agent_facts,
  learned_rules,
  cognitive_module_log,
  cognitive_candidates,
  memory_entry,
  behavioral_hint,
} from '../schema.js';
import { TypedError } from '@/lib/utils.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type {
  AgentFact,
  LearnedRule,
  CognitiveModuleLog,
  CognitiveCandidate,
  MemoryEntry,
  BehavioralHint,
} from '../schema.js';

export const factsRepo = {
  async getByKey(escopo: string, chave: string): Promise<AgentFact | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_facts)
      .where(
        and(
          eq(agent_facts.tenant_id, tenant_id),
          eq(agent_facts.agent_id, agent_id),
          eq(agent_facts.escopo, escopo),
          eq(agent_facts.chave, chave),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async upsert(input: {
    escopo: string;
    chave: string;
    valor: unknown;
    fonte: 'configurado' | 'aprendido' | 'inferido';
    confianca?: number;
  }): Promise<AgentFact> {
    const guarded = applyTenantGuard({
      escopo: input.escopo,
      chave: input.chave,
      valor: input.valor as object,
      fonte: input.fonte,
      confianca: String(input.confianca ?? 1),
    });
    const rows = await db
      .insert(agent_facts)
      .values(guarded)
      .onConflictDoUpdate({
        // PR #82 review (Codex): conflict target must match the
        // (tenant_id, agent_id, escopo, chave) unique introduced in
        // migration 018 — otherwise tenant B can overwrite tenant A's
        // fact by colliding on (escopo, chave).
        target: [
          agent_facts.tenant_id,
          agent_facts.agent_id,
          agent_facts.escopo,
          agent_facts.chave,
        ],
        set: {
          valor: input.valor as object,
          fonte: input.fonte,
          updated_at: new Date(),
        },
      })
      .returning();
    return rows[0]!;
  },
  async listForScopes(escopos: string[]): Promise<AgentFact[]> {
    if (escopos.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104 critical): every read path that surfaces knowledge
    // to the LLM MUST filter by lifecycle_status. Without this, a
    // propose_fact row with lifecycle_status='pending_review' (or even
    // 'revoked') reaches the prompt because the legacy path filtered only
    // by tenant/agent/escopo. The 5 visible states mirror
    // visibility.VISIBLE_STATES.
    return db
      .select()
      .from(agent_facts)
      .where(
        and(
          eq(agent_facts.tenant_id, tenant_id),
          eq(agent_facts.agent_id, agent_id),
          inArray(agent_facts.escopo, escopos),
          inArray(agent_facts.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      );
  },
  /**
   * PR #82 review (Superpowers Critical #1): the legacy factsBlock in the
   * system prompt was rendering every agent_fact unfiltered, bypassing the
   * memory_entry sensitivity/mention_allowed model. This method returns
   * only facts whose content has either (a) no corresponding memory_entry
   * row yet (e.g. classifier hasn't run, or the fact predates P2) or
   * (b) has a memory_entry that is needs_review=false AND mention_allowed=
   * true. Sensitive/personal facts whose memory_entry says do-not-mention
   * are dropped from the prompt.
   *
   * The match is by literal `content` against two known shapes:
   *   1. P2-era persister: valor = { content, subject_id }, so the join
   *      is `me.content = af.valor->>'content'`.
   *   2. Legacy (pre-P2) facts: migration 017 seeded memory_entry with
   *      `content = CONCAT(af.chave, ': ', af.valor::text)`. If the fact's
   *      `valor` happened to already include a `content` key, shape (1)
   *      alone wouldn't catch it until the reclassifier worker rewrote
   *      that entry. We also match shape (2) so the sensitivity filter
   *      is correct during the reclassifier-backlog window.
   *
   * Facts predating P2 with NO memory_entry row at all are still shown —
   * a conservative default for migration-window legacy data, since the
   * 017 seed guarantees they get a needs_review=true entry the reclassifier
   * will eventually re-evaluate.
   */
  async listMentionableForScopes(escopos: string[]): Promise<AgentFact[]> {
    if (escopos.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104 critical): lifecycle_status filter is mandatory
    // on every read that the LLM can see. pending_review / deprecated /
    // revoked rows MUST NOT reach the prompt — they live behind the
    // Admin UI Proposal Inbox until a human acts on them.
    //
    // escopos is wrapped in new Param(...) so it binds as one $n (a real PG
    // array). A bare interpolated JS array expands to a parenthesized scalar
    // list ($1, $2, ...), which PG rejects on the right of ANY (42809).
    const result = await db.execute<AgentFact>(sql`
      SELECT af.*
      FROM agent_facts af
      WHERE af.tenant_id = ${tenant_id}
        AND af.agent_id = ${agent_id}
        AND af.escopo = ANY(${new Param(escopos)})
        AND af.lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM memory_entry me
          WHERE me.tenant_id = af.tenant_id
            AND me.agent_id = af.agent_id
            AND (
              me.content = (af.valor->>'content')
              OR me.content = (af.chave || ': ' || af.valor::text)
            )
            AND (
              me.needs_review = true
              OR me.mention_allowed = false
            )
        )
    `);
    return Array.from(result.rows as unknown as AgentFact[]);
  },
};

export const rulesRepo = {
  async listActive(tipo: string): Promise<LearnedRule[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Codex round-2 finding 2: lifecycle_status is the source of truth
    // for "is this rule visible to the LLM". The legacy `ativa=true`
    // requirement was double-bookkeeping: KSM-proposed rules transitioned
    // through pending_review → … → active never flipped `ativa`, so
    // approved proposals stayed invisible forever. We drop the
    // `ativa=true` predicate here and rely on lifecycle_status alone.
    // (The `ativa` column is preserved for ops/admin "soft disable"
    // outside the lifecycle pipeline; if it gets set to false in the
    // DB, a follow-up migration can join it back.)
    return db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.tipo, tipo),
          inArray(learned_rules.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      )
      .orderBy(desc(learned_rules.confianca), desc(learned_rules.updated_at))
      .limit(50);
  },
  async create(
    input: Omit<
      LearnedRule,
      | 'id'
      | 'tenant_id'
      | 'agent_id'
      | 'created_at'
      | 'updated_at'
      // P10a: lifecycle columns have DB defaults — callers don't supply them.
      | 'lifecycle_status'
      | 'evidence_count'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<LearnedRule> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(learned_rules).values(guarded).returning();
    return rows[0]!;
  },
  async findByContext(tipo: string, contexto: string): Promise<LearnedRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Codex round-2 finding 2: same drop of legacy `ativa=true` here —
    // lifecycle_status is the source of truth for visibility (see
    // listActive comment above).
    const rows = await db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.tipo, tipo),
          eq(learned_rules.contexto, contexto),
          inArray(learned_rules.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async byId(id: string): Promise<LearnedRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  // ---------------------------------------------------------------------------
  // INVARIANT — TENANT/AGENT-SCOPED MUTATIONS (issue #230, north star):
  //   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
  //    herdam aprendizado. Sem exceção."
  //
  //   The 3 mutators below (incrementAcerto / incrementErro / setStatus) accept
  //   a raw `rule_id`. BEFORE this fix the WHERE clause was `id = ?` only —
  //   any agent in any tenant could mutate ANY rule by knowing the id. That
  //   broke the inviolable cross-tenant isolation invariant for the procedural
  //   memory layer (reads via `listActive` / `findByContext` were already
  //   scoped, but writes leaked).
  //
  //   AFTER this fix every mutator pins `tenant_id = <ctx> AND agent_id = <ctx>`
  //   into the WHERE. A mutation against a foreign-tenant/agent rule matches
  //   0 rows on the UPDATE; we then throw a typed `rule_not_in_scope` error so
  //   callers see a LOUD failure instead of a silent no-op. The silent no-op
  //   was rejected because:
  //     1. The invariant is INVIOLABLE — masking a violation is worse than
  //        surfacing it; a thrown error is a louder signal than a swallowed
  //        write that the calling reflection/promotion logic still trusts.
  //     2. `recordAcerto` / `recordErro` (src/memory/procedural.ts) follow up
  //        with `byId(rule_id)` + `setStatus`. Under the OLD code a foreign
  //        id that somehow surfaced would silently chain to setStatus; throwing
  //        here guarantees the promotion/deactivation side-effects never fire
  //        on out-of-scope rows.
  //     3. Detectable from telemetry: a thrown `rule_not_in_scope` is grep-
  //        pable in logs; a silent no-op is not.
  //
  //   The status-conditioned UPDATE pattern (RETURNING + rows.length check) is
  //   the same one `skillsRepo.deprecate` / `.activate` use for lifecycle
  //   guards (PR #213 FIX 2). It is server-authoritative — no caller has to
  //   remember to pre-filter; the SQL itself enforces the boundary.
  // ---------------------------------------------------------------------------
  async incrementAcerto(id: string): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(learned_rules)
      .set({
        acertos: sql`acertos + 1`,
        confianca: sql`LEAST(1.00, confianca + 0.10)`,
        updated_at: new Date(),
      })
      .where(and(
        eq(learned_rules.id, id),
        eq(learned_rules.tenant_id, tenant_id),
        eq(learned_rules.agent_id, agent_id),
      ))
      .returning({ id: learned_rules.id });
    if (rows.length === 0) {
      // Loud failure — see INVARIANT block above. Either the id doesn't exist
      // OR it belongs to a different tenant/agent; both surface as the same
      // typed error so callers can't probe foreign-tenant existence.
      throw new TypedError('rule_not_in_scope', `rule ${id} not found in current tenant/agent scope`);
    }
  },
  async incrementErro(id: string): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(learned_rules)
      .set({
        erros: sql`erros + 1`,
        confianca: sql`GREATEST(0.00, confianca - 0.20)`,
        updated_at: new Date(),
      })
      .where(and(
        eq(learned_rules.id, id),
        eq(learned_rules.tenant_id, tenant_id),
        eq(learned_rules.agent_id, agent_id),
      ))
      .returning({ id: learned_rules.id });
    if (rows.length === 0) {
      // Loud failure — see INVARIANT block above.
      throw new TypedError('rule_not_in_scope', `rule ${id} not found in current tenant/agent scope`);
    }
  },
  async setStatus(
    id: string,
    update: { ativa?: boolean; confianca?: number },
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (update.ativa !== undefined) set.ativa = update.ativa;
    if (update.confianca !== undefined) set.confianca = String(update.confianca);
    const rows = await db
      .update(learned_rules)
      .set(set)
      .where(and(
        eq(learned_rules.id, id),
        eq(learned_rules.tenant_id, tenant_id),
        eq(learned_rules.agent_id, agent_id),
      ))
      .returning({ id: learned_rules.id });
    if (rows.length === 0) {
      // Loud failure — see INVARIANT block above.
      throw new TypedError('rule_not_in_scope', `rule ${id} not found in current tenant/agent scope`);
    }
  },
};

export const cognitiveModuleLogRepo = {
  // PR #75 review (Superpowers finding #6): cognitive_module_log é tenant-aware
  // (tenant_id + agent_id NOT NULL desde migration 008). O caller atual
  // (reflection.ts) já passa tenant_id/agent_id explicitamente e roda dentro
  // de runWithTenantContext, mas aplicamos `applyTenantGuard` aqui pra:
  //   1. Falhar fechado se algum caller futuro esquecer o contexto.
  //   2. Detectar mismatch entre input e contexto (caller passou tenant errado).
  // O DEFAULT 'default' do schema fica como rede de segurança em P0 — sweep
  // de DROP DEFAULT está agendado pro pós-P0 (finding #7).
  async record(entry: Omit<CognitiveModuleLog, 'id' | 'created_at'>): Promise<void> {
    const guarded = applyTenantGuard(entry as Record<string, unknown>);
    await db.insert(cognitive_module_log).values(guarded as typeof entry);
  },

  async recentByModule(module_name: string, limit = 100): Promise<CognitiveModuleLog[]> {
    return db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, module_name))
      .orderBy(desc(cognitive_module_log.created_at))
      .limit(limit);
  },
};

export const cognitiveCandidatesRepo = {
  async create(
    input: Omit<CognitiveCandidate, 'id' | 'created_at' | 'tenant_id' | 'agent_id' | 'status' | 'consumed_by_phase' | 'consumed_at'>,
  ): Promise<CognitiveCandidate> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(cognitive_candidates).values(guarded).returning();
    return row!;
  },

  async listPending(candidate_type?: string, limit = 100): Promise<CognitiveCandidate[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conditions = [
      eq(cognitive_candidates.tenant_id, tenant_id),
      eq(cognitive_candidates.agent_id, agent_id),
      eq(cognitive_candidates.status, 'pending'),
    ];
    if (candidate_type) conditions.push(eq(cognitive_candidates.candidate_type, candidate_type));
    return db
      .select()
      .from(cognitive_candidates)
      .where(and(...conditions))
      .orderBy(desc(cognitive_candidates.created_at))
      .limit(limit);
  },

  async markConsumed(id: string, phase: string): Promise<void> {
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `listPending`. Both columns are
    // NOT NULL (schema `cognitive_candidates`). The sole live caller
    // (`workers/procedure-candidate-consumer.ts`) marks the EXACT candidate it
    // just read via the tenant+agent-scoped `listPending('procedimento', 50)`,
    // and does so inside the SAME `runWithTenantContext({tenant_id, agent_id})`
    // it opened for that tenant — so the row provably belongs to the running
    // tuple and the predicate matches it.
    //
    // FAIL-LOUD (throw on !=1): this transitions one specific, known-present
    // candidate from 'pending' to 'consumed' (the worker's idempotency hinge —
    // a consumed candidate is never re-processed). The id-only WHERE always
    // matched, so a 0-row result under the new predicate can ONLY be a
    // tenant/agent mismatch (cross-tenant misroute), never a benign no-op. A
    // silent miss would leave the candidate 'pending' forever (re-drafted every
    // run → duplicate procedure drafts) while the worker logged success — so
    // surface it loudly. Same `.returning({id})` + `.length` idiom as
    // `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(cognitive_candidates)
      .set({ status: 'consumed', consumed_by_phase: phase, consumed_at: new Date() })
      .where(
        and(
          eq(cognitive_candidates.id, id),
          eq(cognitive_candidates.tenant_id, tenant_id),
          eq(cognitive_candidates.agent_id, agent_id),
        ),
      )
      .returning({ id: cognitive_candidates.id });
    if (updated.length !== 1) {
      throw new Error(
        `cognitiveCandidatesRepo.markConsumed matched ${updated.length} rows for candidate ${id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does not match the ` +
          `target candidate; the consume would have been silently lost, leaving it pending and ` +
          `re-processed every run while reported as consumed)`,
      );
    }
  },

  /**
   * Returns the distinct (tenant_id, agent_id) pairs that own at least
   * one pending candidate of the requested type. Used by workers that
   * must fan out across tenants (e.g., procedure_candidate_consumer).
   *
   * NOTE: This method intentionally does NOT use the tenant guard —
   * iteration is part of the worker's contract. Callers MUST invoke it
   * once at worker startup and then wrap per-pair processing in
   * `runWithTenantContext`. (P83-C2)
   */
  async listPendingTenantPairsForType(
    candidate_type: string,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const rows = await db
      .selectDistinct({
        tenant_id: cognitive_candidates.tenant_id,
        agent_id: cognitive_candidates.agent_id,
      })
      .from(cognitive_candidates)
      .where(
        and(
          eq(cognitive_candidates.status, 'pending'),
          eq(cognitive_candidates.candidate_type, candidate_type),
        ),
      );
    return rows;
  },
};

export const memoryEntryRepo = {
  async create(
    input: Omit<
      MemoryEntry,
      | 'id'
      | 'created_at'
      | 'updated_at'
      | 'tenant_id'
      | 'agent_id'
      // P10a: lifecycle columns have DB defaults — callers don't supply them.
      | 'lifecycle_status'
      | 'evidence_count'
      | 'confidence'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<MemoryEntry> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(memory_entry).values(guarded).returning();
    return row!;
  },

  async findRelevant(opts: {
    interlocutor_id?: string;
    role_id?: string;
    channel_id?: string;
    conversa_id?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();
    const conds = [
      eq(memory_entry.tenant_id, tenant_id),
      eq(memory_entry.agent_id, agent_id),
      eq(memory_entry.needs_review, false),
      // PR #82 review (Codex medium + Superpowers Critical #2): TTL must
      // be enforced at query time. Entries past expires_at MUST NOT be
      // returned to the prompt builder. NULL expires_at = no TTL.
      or(isNull(memory_entry.expires_at), gt(memory_entry.expires_at, now)),
      // P10a (review #104 critical): lifecycle_status filter enforced on
      // every prompt-exposing read. pending_review / deprecated / revoked
      // entries stay hidden from the LLM.
      inArray(memory_entry.lifecycle_status, [
        'ephemeral',
        'observed',
        'reinforced',
        'verified',
        'active',
      ]),
    ];
    // Filtrar por scope_type + subject_id apropriado. PR #82 review
    // (Superpowers Critical #4): role/channel devem só ser incluídos
    // quando o caller passar o subject id correspondente — senão a
    // memória escopada por role/channel atravessa todas as fronteiras.
    const orConds = [];
    if (opts.interlocutor_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'interlocutor'),
          eq(memory_entry.subject_id, opts.interlocutor_id),
        ),
      );
    }
    if (opts.role_id) {
      orConds.push(
        and(eq(memory_entry.scope_type, 'role'), eq(memory_entry.subject_id, opts.role_id)),
      );
    }
    if (opts.channel_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'channel'),
          eq(memory_entry.subject_id, opts.channel_id),
        ),
      );
    }
    if (opts.conversa_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'conversation'),
          eq(memory_entry.subject_id, opts.conversa_id),
        ),
      );
    }
    orConds.push(eq(memory_entry.scope_type, 'agent'));

    return db
      .select()
      .from(memory_entry)
      .where(and(...conds, or(...orConds)))
      .orderBy(desc(memory_entry.created_at))
      .limit(opts.limit ?? 50);
  },

  async markReviewed(
    id: string,
    updates: {
      memory_type: string;
      sensitivity: string;
      proactive_use: boolean;
      mention_allowed: boolean;
      ttl_days?: number | null;
      scope_type?: string;
      subject_id?: string;
    },
  ): Promise<void> {
    // PR #82 review (Superpowers Critical #3): when promoting a candidate
    // out of needs_review, compute expires_at from ttl_days so that the
    // TTL filter in findRelevant can actually evict the row. Without this
    // a sensitive memory with ttl_days=7 was kept indefinitely.
    const expires_at =
      updates.ttl_days != null
        ? new Date(Date.now() + updates.ttl_days * 24 * 60 * 60 * 1000)
        : null;
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `findRelevant` / `listNeedsReview`.
    // Both columns are NOT NULL (schema `memory_entry`). The sole live caller
    // (`workers/legacy-memory-reclassifier.ts`) updates the EXACT entry it just
    // read via the tenant+agent-scoped `listNeedsReview(100)`, inside the SAME
    // `runWithTenantContext({tenant_id, agent_id})` it opened for that tenant —
    // so the row provably belongs to the running tuple and the predicate matches.
    //
    // FAIL-LOUD (throw on !=1): this promotes one specific, known-present entry
    // OUT of `needs_review` (computing its `expires_at` so the TTL filter can
    // evict it). The id-only WHERE always matched, so a 0-row result under the
    // new predicate can ONLY be a tenant/agent mismatch (cross-tenant misroute),
    // never a benign no-op. A silent miss would leave the memory stuck in
    // needs_review=true (permanently hidden from the prompt) while the worker
    // logged it reclassified — so surface it loudly. Same `.returning({id})` +
    // `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(memory_entry)
      .set({ ...updates, expires_at, needs_review: false, updated_at: new Date() })
      .where(
        and(
          eq(memory_entry.id, id),
          eq(memory_entry.tenant_id, tenant_id),
          eq(memory_entry.agent_id, agent_id),
        ),
      )
      .returning({ id: memory_entry.id });
    if (updated.length !== 1) {
      throw new Error(
        `memoryEntryRepo.markReviewed matched ${updated.length} rows for memory ${id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does not match the ` +
          `target memory; the review would have been silently lost, leaving it stuck in ` +
          `needs_review and hidden from the prompt while reported as reclassified)`,
      );
    }
  },

  async listNeedsReview(limit = 100): Promise<MemoryEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(memory_entry)
      .where(
        and(
          eq(memory_entry.tenant_id, tenant_id),
          eq(memory_entry.agent_id, agent_id),
          eq(memory_entry.needs_review, true),
        ),
      )
      .limit(limit);
  },
};

export const behavioralHintRepo = {
  async create(
    input: Omit<
      BehavioralHint,
      | 'id'
      | 'created_at'
      | 'tenant_id'
      | 'agent_id'
      // P10a: lifecycle columns + updated_at have DB defaults — callers
      // don't supply them.
      | 'updated_at'
      | 'lifecycle_status'
      | 'evidence_count'
      | 'confidence'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<BehavioralHint> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(behavioral_hint).values(guarded).returning();
    return row!;
  },

  async findActiveForScope(opts: {
    scope_type: string;
    subject_id?: string | null;
  }): Promise<BehavioralHint[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();
    const conds = [
      eq(behavioral_hint.tenant_id, tenant_id),
      eq(behavioral_hint.agent_id, agent_id),
      eq(behavioral_hint.scope_type, opts.scope_type),
      isNull(behavioral_hint.revoked_at),
      // P10a (review #104 critical): hints proposed via propose_hint
      // start in pending_review / ephemeral. The LLM-facing path must
      // include only visible states so a pending hint never steers
      // behavior before a human approves it.
      inArray(behavioral_hint.lifecycle_status, [
        'ephemeral',
        'observed',
        'reinforced',
        'verified',
        'active',
      ]),
    ];
    if (opts.subject_id) conds.push(eq(behavioral_hint.subject_id, opts.subject_id));
    return db
      .select()
      .from(behavioral_hint)
      .where(
        and(
          ...conds,
          or(isNull(behavioral_hint.expires_at), gt(behavioral_hint.expires_at, now)),
        ),
      );
  },

  async revoke(id: string): Promise<void> {
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `findActiveForScope`. Both columns
    // are NOT NULL (schema `behavioral_hint`). This method has NO live caller in
    // `src` today (it is part of the repo's governance surface for revoking a
    // hint by id); because it now READS ALS, any FUTURE caller MUST run inside
    // `runWithTenantContext` (an unwrapped caller throws MissingTenantContextError
    // — the intended fail-closed contract for a tenant-owned write).
    //
    // FAIL-LOUD (throw on !=1): revoking a hint sets `revoked_at`, removing it
    // from every LLM-facing read (`findActiveForScope` filters `revoked_at IS
    // NULL`). A revoke targets one specific, operator-/caller-identified hint id;
    // a 0-row result under the new predicate means that id is NOT owned by the
    // running tenant/agent — a cross-tenant revoke attempt that must be surfaced,
    // not silently swallowed (which would report a sensitive hint as revoked
    // while it stayed live for its real owner). Same `.returning({id})` +
    // `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(behavioral_hint)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(behavioral_hint.id, id),
          eq(behavioral_hint.tenant_id, tenant_id),
          eq(behavioral_hint.agent_id, agent_id),
        ),
      )
      .returning({ id: behavioral_hint.id });
    if (updated.length !== 1) {
      throw new Error(
        `behavioralHintRepo.revoke matched ${updated.length} rows for hint ${id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does not match the ` +
          `target hint; the revoke would have been silently lost while the hint stayed live for ` +
          `its real owner)`,
      );
    }
  },
};
