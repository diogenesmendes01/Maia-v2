import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import {
  agent_operational_profile_versions,
  agent_drift_alerts,
  admin_audit_log,
} from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type { ProfileStatus, DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';
import type {
  AgentOperationalProfileVersion,
  ProfileBody,
  AgentDriftAlert,
} from '../schema.js';
import {
  validateProfileBodyP8d,
  readExpectedPredecessor,
  isMigratedLegacy,
  lockParentAgent,
  acquireNextVersionForAgent,
} from './profile-internal.js';

type Tx = typeof db;

/**
 * Spec perfil-inbox v4 §1.4 — contrato de falha do primitivo InTx.
 *
 * `decideAtomically` (motor unificado) insere approval e audit ANTES da
 * transição do source; um InTx que sinalizasse falha por retorno commitaria
 * a aprovação SEM ativação, e o retry do operador seria bloqueado pelo
 * dup-check como "já aprovou". Falha do InTx portanto SEMPRE **lança** — o
 * rollback da MESMA tx desfaz approval + audit; nenhum estado parcial,
 * nenhum falso-positivo no retry (invariante 1b).
 */
export type ProfileTransitionFailure =
  | { reason: 'not_found' | 'invalid_source_status' | 'transition_failed' | 'agent_missing' }
  | {
      reason: 'predecessor_conflict';
      expected: string | null | 'unknown';
      current: string | null;
    }
  | { reason: 'migrated_legacy_proposal'; expected: null; current: string | null }
  | {
      reason: 'missing_predecessor';
      proposed_version: number;
      current_predecessor: string | null;
    };

export class ProfileTransitionError extends Error {
  readonly code = 'profile_transition_failed';
  constructor(readonly detail: ProfileTransitionFailure) {
    super(`profile transition failed: ${detail.reason}`);
    this.name = 'ProfileTransitionError';
  }
}

/**
 * Issue #511 — publish the `identity` turn-context cache invalidation for a
 * (tenant, agent) whose ACTIVE operational profile just changed.
 *
 * Call sites are every mutation that changes what `getActive()` returns:
 * activation, freeze, rollback and the seed path. Transitions that only touch
 * `proposed`/`rejected` rows are deliberately NOT here — they cannot change the
 * active profile, and a spurious publish is pointless cache churn.
 *
 * ALWAYS called AFTER the transaction commits, never inside it. From inside, a
 * replica receiving the event before COMMIT would re-read the pre-commit
 * snapshot and pin the OLD identity for a full TTL — strictly worse than not
 * publishing at all.
 *
 * Best-effort: `publishTurnContextInvalidation` already swallows broker
 * failures (staleness then falls back to the TTL bound). The extra guard here
 * covers the dynamic import itself, so a governance mutation that already
 * committed and audited can never fail because a cache hint could not be sent.
 */
async function publishIdentityInvalidation(tenant_id: string, agent_id: string): Promise<void> {
  try {
    const { publishTurnContextInvalidation } = await import('@/agent/turn-context/cache.js');
    await publishTurnContextInvalidation({ tenant_id, agent_id, resource: 'identity' });
  } catch {
    // Deliberately silent: the mutation succeeded, and the cache degrades to
    // its TTL bound. `publishTurnContextInvalidation` logs its own failures.
  }
}

/**
 * Issue #525 — SELECT builder behind `operationalProfileVersionsRepo.getActive`,
 * shared with the batched turn-context read. `status = 'active'` is the whole
 * safety property of this read (a `proposed` or `frozen` persona must never
 * reach the prompt), so it gets one definition, not two.
 */
export function operationalProfileGetActiveQuery() {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return db
    .select()
    .from(agent_operational_profile_versions)
    .where(
      and(
        eq(agent_operational_profile_versions.tenant_id, tenant_id),
        eq(agent_operational_profile_versions.agent_id, agent_id),
        eq(agent_operational_profile_versions.status, 'active'),
      ),
    )
    .limit(1);
}

export const operationalProfileVersionsRepo = {
  async create(input: {
    profile_body: ProfileBody;
    proposed_by: string;
    proposed_reason?: string;
  }): Promise<AgentOperationalProfileVersion> {
    // P8d §10 — write-path validation: rejeita cognitive_limits fora de range
    // e modifiers malformados. Defesa em depth contra inserts "tortos" via
    // qualquer caller (proposal-generator, migration script, Admin UI).
    validateProfileBodyP8d(input.profile_body);

    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // Codex Adversarial Review of PR #171 round 2 (issue #166) — version
    // allocation now goes through the shared `acquireNextVersionForAgent`
    // helper, which locks the parent agent row before reading MAX(version).
    // This serializes against the OTHER allocators (`proposeAndAuditAtomic`,
    // `seedNewActiveAtomic`), closing the mixed-allocator race where two
    // different writers for the same (tenant, agent) could both read the
    // same MAX and collide on `agent_op_profile_version_uq`. Wrapping the
    // insert in `withTx` keeps the lock held across the INSERT so a third
    // writer cannot squeeze in between MAX and INSERT.
    return withTx(async (tx) => {
      const version = await acquireNextVersionForAgent(tx, tenant_id, agent_id);
      if (version == null) {
        throw new Error(
          `operationalProfileVersionsRepo.create: parent agent ${agent_id} ` +
            `not found in tenant ${tenant_id}`,
        );
      }
      const guarded = applyTenantGuard({
        version,
        status: 'proposed',
        profile_body: input.profile_body,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
      });
      const [row] = await tx
        .insert(agent_operational_profile_versions)
        .values(guarded)
        .returning();
      return row!;
    });
  },

  async getActive(): Promise<AgentOperationalProfileVersion | null> {
    const rows = await operationalProfileGetActiveQuery();
    return rows[0] ?? null;
  },

  async getById(id: string): Promise<AgentOperationalProfileVersion | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
          eq(agent_operational_profile_versions.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: ProfileStatus): Promise<AgentOperationalProfileVersion[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
          eq(agent_operational_profile_versions.status, status),
        ),
      )
      .orderBy(desc(agent_operational_profile_versions.version));
  },

  // Validated state-machine transition. Retorna typed result, sem throw.
  // - not_found:           id desconhecido
  // - terminal:            row já está rolled_back (terminal)
  // - invalid_transition:  destino não permitido a partir do source, same-state,
  //                        OR source status changed concurrently between read
  //                        and write (status predicate guard fired)
  // - already_has_active:  to:'active' mas outra row ativa existe para (tenant,agent)
  // - stale:               caller passed `expected_from` and the row's status
  //                        changed between caller's pre-lock read and our
  //                        post-lock re-read (concurrent writer won the lock
  //                        first and committed a transition the caller never
  //                        saw). Returned with `actual` so the caller can
  //                        decide whether to retry against the new state.
  //
  // Codex Adversarial Review of PR #171 round 4 (issue #177) — until that
  // refactor, `transition` was the LAST writer of
  // `agent_operational_profile_versions` that bypassed the parent-agent
  // `FOR UPDATE` lock established by `acquireNextVersionForAgent` /
  // `lockParentAgent`. The drift decision engine calls this method to
  // freeze/rollback the active profile when a drift severity threshold is
  // crossed, and the priorities seed script calls `seedNewActiveAtomic`
  // (which DOES take the lock) on the same `(tenant, agent)` slot. The
  // documented race was: seed reads active A → drift `transition` rolls A
  // back/frozen → seed re-writes A as `frozen` using only `id/tenant/agent`
  // → silently undoes `rolled_back` (the terminal state per the doccomment).
  //
  // Round 4 fix was twofold:
  //   (a) Wrap the whole transition in `withTx` and acquire `lockParentAgent`
  //       as the FIRST step. Every other writer of this table now goes
  //       through the same lock target (`approveAndActivateAtomic`,
  //       `proposeAndAuditAtomic`, `seedNewActiveAtomic`, and
  //       `operationalProfileVersionsRepo.create`), so concurrent writers
  //       serialize on `agents(id)` regardless of which transition shape
  //       they perform.
  //   (b) Add a `status = <from>` predicate to the UPDATE itself + check
  //       `returning().length === 1`. Belt-and-suspenders for the case where
  //       another writer somehow holds the row in a different lock domain
  //       (or future codepath bypasses the parent lock): if the source
  //       status changed concurrently, the UPDATE matches zero rows and we
  //       surface `invalid_transition` (the source predicate the caller
  //       asked about no longer holds) instead of silently overwriting it.
  //
  // Codex Adversarial Review of PR #182 round 1 (issue #177 follow-up) —
  // the parent lock + status-predicate guard prevent the silent overwrite,
  // but they did NOT prevent a different fail-open: if `seedNewActiveAtomic`
  // wins the lock first (freezing the old active A and seeding a new active
  // B), a waiting drift `transition({to:'rolled_back'})` caller wakes up,
  // re-reads A as `frozen`, the state machine still permits `frozen →
  // rolled_back`, so the UPDATE succeeds and `transition` returns `ok:true`.
  // The decision engine then marks the rollback as APPLIED even though the
  // newly-seeded version B remains `active` — the rollback was NOT applied
  // to the currently-active row. Critical rollback fails open with false
  // success.
  //
  // Fix: a typed `expected_from` parameter. Callers that have a snapshot
  // expectation of the source state (drift engine: `active`; priorities
  // seed promotion: `proposed`) MUST pass it; after the parent lock + row
  // re-read, if the row's status no longer matches, we surface
  // `{ok:false, reason:'stale', expected_from, actual}` so the caller can
  // observe the race explicitly and decide (retry against the new active,
  // log+skip, etc) instead of silently completing the wrong write.
  //
  // The parameter is OPTIONAL for backwards-compat with sequential callers
  // (unit tests, single-threaded admin scripts) that genuinely do not have
  // a snapshot expectation. Concurrent callers MUST pass it — see the
  // `decision-engine.ts` and `proposal-generator.ts` usages for examples.
  async transition(args: {
    id: string;
    to: ProfileStatus;
    /**
     * The status the caller saw when they decided to transition. After we
     * take the parent-agent lock and re-read the row, if the status changed
     * (a concurrent writer landed first), we return `{ok:false,
     * reason:'stale'}` instead of applying the transition from a state the
     * caller never saw. REQUIRED for concurrent callers (drift engine,
     * priorities seed, any background worker). Optional only for
     * sequential single-writer callers (unit tests, admin scripts running
     * with no concurrent traffic) where the snapshot expectation is
     * implicitly satisfied.
     */
    expected_from?: ProfileStatus;
    approved_by?: string;
    rollback_reason?: string;
  }): Promise<
    | { ok: true; updated: AgentOperationalProfileVersion }
    | { ok: false; reason: 'not_found' | 'invalid_transition' | 'already_has_active' | 'terminal' }
    | { ok: false; reason: 'stale'; expected_from: ProfileStatus; actual: ProfileStatus }
  > {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // #511: `transition` is the broad status mutator — it covers freeze,
    // rollback and frozen→active re-activation, i.e. most of the ways the
    // active profile changes outside the approval flow. Publish after commit
    // when the transition touched the ACTIVE row in either direction; the
    // source status is captured here because it is only known inside the tx.
    let fromStatus: ProfileStatus | null = null;
    const result = await withTx(async (tx) => {
      // (0) Lock the parent `agents` row FIRST so we serialize against every
      //     OTHER writer that touches `(tenant, agent)` profile state
      //     (`approveAndActivateAtomic`, `proposeAndAuditAtomic`,
      //     `seedNewActiveAtomic`, `operationalProfileVersionsRepo.create`).
      //     Round 4 (#177): closes the seed-vs-drift `transition` race.
      const agentLocked = await lockParentAgent(tx, tenant_id, agent_id);
      if (!agentLocked) {
        // Agent was deleted between caller's read and this lock. Treat as
        // not_found to preserve the existing contract.
        return { ok: false as const, reason: 'not_found' as const };
      }

      // (1) Re-read the target row INSIDE the tx + behind the parent lock so
      //     post-lock state drives the validation. `for('update')` on the row
      //     itself is defense-in-depth (a future codepath that bypasses
      //     `lockParentAgent` but still does row-level locks would still
      //     serialize with us).
      const rows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.id),
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
          ),
        )
        .for('update')
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false as const, reason: 'not_found' as const };

      const from = row.status as ProfileStatus;
      fromStatus = from;

      // (1.5) Codex Adversarial Review of PR #182 round 1 fail-open guard:
      //       if the caller passed an `expected_from`, enforce that the
      //       row is STILL in that state under our lock. If a concurrent
      //       writer (e.g. seedNewActiveAtomic, approveAndActivateAtomic)
      //       transitioned the row to a different state while we waited
      //       for the lock, we surface `stale` so the caller can react
      //       explicitly rather than silently completing a write against
      //       a state they never observed.
      if (args.expected_from !== undefined && from !== args.expected_from) {
        return {
          ok: false as const,
          reason: 'stale' as const,
          expected_from: args.expected_from,
          actual: from,
        };
      }

      if (from === 'rolled_back') return { ok: false as const, reason: 'terminal' as const };
      if (from === args.to) return { ok: false as const, reason: 'invalid_transition' as const };

      const allowed: Record<string, readonly string[]> = {
        proposed: ['active', 'frozen', 'rolled_back'],
        active: ['frozen', 'rolled_back'],
        frozen: ['active', 'rolled_back'],
      };
      if (!allowed[from]?.includes(args.to)) {
        return { ok: false as const, reason: 'invalid_transition' as const };
      }

      if (args.to === 'active') {
        // Re-read inside the tx + behind the parent lock so a concurrent
        // approve/seed that landed before we acquired the lock is visible.
        const activeRows = await tx
          .select()
          .from(agent_operational_profile_versions)
          .where(
            and(
              eq(agent_operational_profile_versions.tenant_id, tenant_id),
              eq(agent_operational_profile_versions.agent_id, agent_id),
              eq(agent_operational_profile_versions.status, 'active'),
            ),
          )
          .limit(1);
        const active = activeRows[0];
        if (active && active.id !== row.id) {
          return { ok: false as const, reason: 'already_has_active' as const };
        }
      }

      const now = new Date();
      const patch: Record<string, unknown> = { status: args.to };
      if (args.to === 'active') {
        // approved_at é definido na primeira vez que se aprova; re-ativações
        // a partir de frozen preservam o approved_at original.
        if (!row.approved_at) {
          patch.approved_at = now;
          if (args.approved_by) patch.approved_by = args.approved_by;
        }
        patch.activated_at = now;
      } else if (args.to === 'frozen') {
        patch.frozen_at = now;
      } else if (args.to === 'rolled_back') {
        patch.rolled_back_at = now;
        patch.rollback_reason = args.rollback_reason ?? null;
      }

      // [P86-C3] tenant-scoped write predicate: even though the SELECT above
      // already filtered by tenant_id/agent_id, the actual UPDATE must
      // include them in WHERE as defense-in-depth (an alert UUID alone is
      // not enough authorization to mutate identity in a different tenant
      // context). This is the inviolable tenant isolation invariant.
      //
      // Round 4 (#177): also include `status = from` in the WHERE so a
      // concurrent state change (under READ COMMITTED a snapshot inversion
      // is theoretically possible even with FOR UPDATE if a future writer
      // bypasses the parent lock) cannot be silently overwritten. If the
      // status changed between our locked re-read and the UPDATE, the
      // UPDATE matches zero rows and we surface `invalid_transition` —
      // the source predicate the caller asked about no longer holds.
      const updated = await tx
        .update(agent_operational_profile_versions)
        .set(patch as Partial<typeof agent_operational_profile_versions.$inferInsert>)
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.id),
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
            eq(agent_operational_profile_versions.status, from),
          ),
        )
        .returning();
      if (updated.length === 0) {
        // Status changed concurrently between our locked re-read and this
        // UPDATE — surface as invalid_transition (the source predicate the
        // caller asked about no longer holds). Caller can re-read and decide
        // whether to retry the transition from the new source state.
        return { ok: false as const, reason: 'invalid_transition' as const };
      }
      return { ok: true as const, updated: updated[0]! };
    });

    // #511: publish only when the active profile actually moved — a row
    // entering OR leaving `active` both change what `getActive()` returns. A
    // proposed→rejected transition changes nothing the prompt reads.
    if (
      result.ok &&
      (result.updated.status === 'active' ||
        (fromStatus as ProfileStatus | null) === 'active')
    ) {
      await publishIdentityInvalidation(tenant_id, agent_id);
    }
    return result;
  },

  /**
   * Atomic escalation: if `target_profile_id` is STILL `frozen` and no other
   * row holds the active slot under the same lock, transition it to
   * `rolled_back`. Used by the drift decision engine when an `active →
   * rolled_back` rollback was demoted to `stale + actual='frozen'` by a
   * concurrent `alto` invocation that froze the target first.
   *
   * Codex Adversarial Review of PR #196 round 2 (issue #177 follow-up) — the
   * round-1 fix split the escalation into TWO steps:
   *   1. `getActiveContextForAgent()` — reads the active-slot occupant
   *      OUTSIDE any lock (regular `db.select` with no `FOR UPDATE`).
   *   2. `transition({to:'rolled_back', expected_from:'frozen'})` — opens a
   *      fresh tx, acquires `lockParentAgent`, re-reads the target row.
   *
   * Between steps 1 and 2 the snapshot of the active slot is **released**, so
   * any concurrent writer with the parent lock can land a new state:
   *
   *   - `seedNewActiveAtomic` can promote a brand-new v2 to `active` between
   *     the refetch (which saw `null`) and the retry — the retry then sees
   *     target still `frozen`, transitions it to `rolled_back`, and reports
   *     `applied: true` even though v2 is now the agent's live contract
   *     surface (rollback was applied to the wrong row).
   *
   *   - The state machine permits `frozen → active` (e.g. an operator
   *     re-activates the frozen row via the Admin UI). If the row is
   *     re-activated between the refetch and the retry, the retry's
   *     `expected_from='frozen'` guard surfaces stale, but the original
   *     observation that "no replacement exists" was already wrong — the
   *     row IS the replacement.
   *
   * Fix: collapse both reads into ONE transaction held under
   * `lockParentAgent`. Inside the tx we re-read the target row FOR UPDATE,
   * re-read the active slot FOR UPDATE, and then commit the rollback ONLY
   * if both predicates still hold (target is still `frozen` AND no other
   * row holds the active slot). Every TOCTOU window is closed under the
   * same lock that every other writer of this table uses.
   *
   * Five typed outcomes, all rejected at the source so the caller decides
   * the right log/audit shape:
   *
   *   - `ok: true` — atomically transitioned `frozen → rolled_back`. The
   *     engine logs `drift.rollback.escalated` and reports applied.
   *
   *   - `replaced` — a different row holds the active slot. The seed (or
   *     equivalent writer) won between the engine's pre-lock observation and
   *     this tx. The original target is no longer the contract surface, so
   *     the rollback would be meaningless. Engine skips with
   *     `drift.skip.active_replaced`.
   *
   *   - `reactivated` — the target row itself transitioned `frozen → active`
   *     between the engine's stale observation and this tx (operator
   *     re-activate, future codepath, etc). The engine refuses to roll back
   *     a row that's back in service; skips with `drift.skip.reactivated`.
   *
   *   - `terminal_state` — the target reached a non-frozen non-active state
   *     (e.g. another worker already escalated to `rolled_back`). The
   *     desired terminal is achieved (or close); engine logs
   *     `drift.skip.terminal_state`.
   *
   *   - `target_missing` — the target row was deleted between the engine's
   *     observation and this tx. Extreme race; engine logs as warning.
   *
   * Inputs are explicit (tenant_id, agent_id, target_profile_id) — no
   * AsyncLocalStorage dependency — so this method is callable from any
   * worker context (including ones that haven't `runWithTenantContext`-
   * wrapped their call).
   */
  async escalateRollbackIfStillFrozen(args: {
    tenant_id: string;
    agent_id: string;
    target_profile_id: string;
    approved_by?: string;
    rollback_reason?: string;
  }): Promise<
    | { ok: true; target_profile_id: string; rolled_back_at: Date }
    | { ok: false; reason: 'replaced'; current_active_profile_id: string }
    | { ok: false; reason: 'reactivated' }
    | { ok: false; reason: 'terminal_state'; actual_status: ProfileStatus }
    | { ok: false; reason: 'target_missing' }
    | { ok: false; reason: 'agent_missing' }
  > {
    return await withTx(async (tx) => {
      // (1) Lock the parent agent row FIRST — same lock target as
      //     `transition`, `approveAndActivateAtomic`, `proposeAndAuditAtomic`,
      //     `seedNewActiveAtomic`, and `acquireNextVersionForAgent`. This
      //     serializes us against every writer that could change the active
      //     slot OR the target row's status between our reads and the UPDATE.
      const agentLocked = await lockParentAgent(tx, args.tenant_id, args.agent_id);
      if (!agentLocked) {
        return { ok: false as const, reason: 'agent_missing' as const };
      }

      // (2) Re-read the target row INSIDE the tx + behind the parent lock,
      //     FOR UPDATE. Status may have changed since the engine's
      //     observation; we drive the decision from the post-lock value.
      const targetRows = await tx
        .select({
          id: agent_operational_profile_versions.id,
          status: agent_operational_profile_versions.status,
        })
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.target_profile_id),
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
          ),
        )
        .for('update')
        .limit(1);
      const target = targetRows[0];
      if (!target) {
        return { ok: false as const, reason: 'target_missing' as const };
      }

      const targetStatus = target.status as ProfileStatus;

      // The target was already re-activated (frozen → active is a legal
      // edge). The engine's observation that "no replacement exists" was
      // wrong — this row IS the replacement. Refuse to roll back; the
      // operator/next-cycle re-evaluation will see the live row.
      if (targetStatus === 'active') {
        return { ok: false as const, reason: 'reactivated' as const };
      }

      // Anything other than `frozen` is a terminal/non-recoverable state for
      // our escalation contract (we never escalate from `proposed` or
      // `rolled_back`). Surface the actual status so the caller can log it.
      if (targetStatus !== 'frozen') {
        return {
          ok: false as const,
          reason: 'terminal_state' as const,
          actual_status: targetStatus,
        };
      }

      // (3) Re-read the active slot INSIDE the tx + behind the parent lock,
      //     FOR UPDATE. If a different row holds the slot, the seed (or
      //     equivalent) committed a replacement between the engine's
      //     observation and this tx — we must NOT roll back the original
      //     target because it's no longer the contract surface.
      const activeRows = await tx
        .select({ id: agent_operational_profile_versions.id })
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      const active = activeRows[0];
      if (active) {
        // Defensive: a `frozen` target should never share the active slot,
        // but if it somehow did (status==='frozen' AND active row has the
        // same id — impossible under the unique partial index but cheap to
        // guard), treat it as reactivated rather than replaced.
        if (active.id === args.target_profile_id) {
          return { ok: false as const, reason: 'reactivated' as const };
        }
        return {
          ok: false as const,
          reason: 'replaced' as const,
          current_active_profile_id: active.id,
        };
      }

      // (4) All predicates still hold under the lock — target is frozen
      //     AND no replacement exists. Atomically roll it back. The status
      //     predicate in the WHERE clause is belt-and-suspenders: if a
      //     future codepath ever bypassed this lock, the UPDATE would match
      //     zero rows and we'd still surface a typed miss.
      const now = new Date();
      const updated = await tx
        .update(agent_operational_profile_versions)
        .set({
          status: 'rolled_back',
          rolled_back_at: now,
          rollback_reason: args.rollback_reason ?? null,
        })
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.target_profile_id),
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
            eq(agent_operational_profile_versions.status, 'frozen'),
          ),
        )
        .returning({ id: agent_operational_profile_versions.id });

      if (updated.length === 0) {
        // Should be unreachable: we hold the parent lock AND a row-level
        // FOR UPDATE on the target, so its status cannot change between our
        // read and this UPDATE. If it somehow did (future codepath that
        // bypasses both locks), surface as terminal_state so the caller
        // doesn't double-process.
        return {
          ok: false as const,
          reason: 'terminal_state' as const,
          actual_status: targetStatus,
        };
      }

      return {
        ok: true as const,
        target_profile_id: args.target_profile_id,
        rolled_back_at: now,
      };
    });
  },

  /**
   * Atomic "propose new version + admin audit" — both writes inside a single
   * transaction so a partial commit cannot leave a profile_version row with
   * no audit record of who proposed it (forensics gap).
   *
   * Codex review of PR #162 round 3 (issue #166) — same class of multi-write
   * atomicity gap that `approveAndActivateAtomic` solved for approve. The
   * proposal stays in `status='proposed'`; only `approveAndActivateAtomic`
   * activates it (P8.5 invariant — no profile activates without approval).
   *
   * Codex Adversarial Review of PR #171 (issue #166 follow-up) — even with
   * MAX(version)+1 computed inside the tx, two concurrent `updateProfile`
   * calls for the same (tenant, agent) under READ COMMITTED can both read
   * the same `max` and both attempt to insert `max+1`, colliding on the
   * `(tenant_id, agent_id, version)` unique index. The router translates
   * that DB error into an unhelpful 500 with no retry. Fix: lock the parent
   * `agents` row with `SELECT ... FOR UPDATE` BEFORE reading MAX. This
   * serializes version allocation per-agent (different agents don't
   * contend) and matches the `.for('update')` pattern already used in
   * `approveAndActivateAtomic`. We chose row-lock over `pg_advisory_xact_lock`
   * because the row lock is naturally scoped, debuggable via `pg_locks`,
   * and consistent with the rest of this repo.
   *
   * Codex Adversarial Review of PR #171 round 2 — version allocation moved
   * to the shared `acquireNextVersionForAgent` helper so this method, the
   * priorities-migration `seedNewActiveAtomic`, and `create` ALL serialize
   * on the same parent-agent FOR UPDATE lock. Mixed-allocator race closed.
   *
   * Required input is explicit (no AsyncLocalStorage dependency) so the
   * router can call it without `runWithTenantContext`. The previous active
   * id is captured by the caller (router) BEFORE this call because the
   * read is part of the same logical operation but doesn't need tx
   * isolation — concurrent updateProfile + approval races are guarded by
   * the FOR UPDATE on the active row inside `approveAndActivateInTx`.
   *
   * Returns `null` if the agent was deleted between the caller's
   * `findById` check and this call — the router translates that into
   * NOT_FOUND. Otherwise the proposal commits atomically with the audit
   * row.
   */
  async proposeAndAuditAtomic(args: {
    tenant_id: string;
    agent_id: string;
    profile_body: ProfileBody;
    proposed_by: string;
    proposed_reason: string;
    /** Captured by caller from getActive() before opening the tx. */
    previous_active_id: string | null;
    actor_id: string;
    actor_role: string;
  }): Promise<
    | {
        version: AgentOperationalProfileVersion;
        previous_version_id: string | null;
      }
    | { agent_missing: true }
  > {
    // Validate before opening the tx so a malformed body fails fast without
    // touching the DB.
    validateProfileBodyP8d(args.profile_body);

    return await withTx(async (tx) => {
      // (1) Allocate next version via the shared helper, which (a) locks the
      //     parent agent row FOR UPDATE and (b) reads MAX(version) behind
      //     that lock. The lock is held until tx commit so the subsequent
      //     INSERT lands behind it, eliminating both same-allocator and
      //     mixed-allocator races (Codex round 2 #166: other writers like
      //     `seedNewActiveAtomic` and `operationalProfileVersionsRepo.create`
      //     now use the same helper).
      const nextV = await acquireNextVersionForAgent(tx, args.tenant_id, args.agent_id);
      if (nextV == null) {
        // Agent was deleted between the router's findById and this tx.
        // Surface a typed sentinel so the caller can translate to NOT_FOUND
        // instead of leaking a half-applied transaction or generic 500.
        return { agent_missing: true as const };
      }

      // (2) Insert the proposed row.
      const [version] = await tx
        .insert(agent_operational_profile_versions)
        .values({
          tenant_id: args.tenant_id,
          agent_id: args.agent_id,
          version: nextV,
          status: 'proposed',
          profile_body: args.profile_body,
          proposed_by: args.proposed_by,
          proposed_reason: args.proposed_reason,
        })
        .returning();
      if (!version) {
        throw new Error('propose_atomic_insert_failed: returning() empty');
      }

      // (3) Audit in the SAME tx. If this fails, the profile_version insert
      //     rolls back and there's no orphaned proposal.
      await tx.insert(admin_audit_log).values({
        tenant_id: args.tenant_id,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        action: 'agent_profile_propose',
        resource_type: 'agent_operational_profile_version',
        resource_id: version.id,
        change_summary: {
          agent_id: args.agent_id,
          previous_version_id: args.previous_active_id,
          new_version: version.version,
          status: version.status,
          proposed_reason: args.proposed_reason,
        },
      });

      return {
        version,
        previous_version_id: args.previous_active_id,
      };
    });
  },

  /**
   * Atomic "proposed → active" approval with auto-freeze of the incumbent
   * active version, plus admin_audit_log append — all inside a single
   * transaction so a partial commit cannot leave the agent with no active
   * profile OR with an unaudited governance change.
   *
   * Codex review of PR #162 round 2 ([high] x2) — addresses both:
   *   - "Profile approval can activate runtime state without an audit trail":
   *     mutation + audit commit together.
   *   - "Freeze incumbent profiles before approving replacements": when an
   *     active version already exists, this method freezes it in the same tx
   *     before activating the new one. (`transition({to:'active'})` alone
   *     fails with already_has_active.)
   *
   * Codex Adversarial Review of PR #171 round 2 ([high] #1) — adds predecessor
   * enforcement. The router's `updateProfile` reads the active version OUTSIDE
   * the proposal tx and chains its id into `profile_body.metadata.previous_version_id`
   * (the "expected predecessor"). If a *different* proposal gets approved
   * between that read and this approval, the active row id no longer matches
   * the predecessor — approving would silently overwrite the newer version
   * with stale content while the audit lineage still points at the original
   * predecessor (write-skew).
   *
   * Mitigation: inside this tx, after locking BOTH the proposed row AND the
   * incumbent active row FOR UPDATE, compare the proposed's expected
   * predecessor against the freshly-locked incumbent. If they diverge,
   * reject with `predecessor_conflict` so the caller can refresh + re-propose.
   *
   * Codex Adversarial Review of PR #171 round 3 ([medium]) — the parent-agent
   * `FOR UPDATE` lock is now the FIRST thing this tx takes, BEFORE reading
   * the proposed or active rows. This closes the cross-allocator race where
   * a concurrent `seedNewActiveAtomic` (priorities migration) could freeze
   * and insert a new active row between this tx's active read and freeze,
   * surfacing as a partial-unique-index conflict / 500 instead of a
   * serialized update. Every writer that touches active state OR allocates
   * a version now shares the same lock target via `lockParentAgent`.
   *
   * Codex Adversarial Review of PR #171 round 3 ([high] #173) — explicit
   * `null` predecessor is now context-sensitive:
   *
   *   - **Intentional seed (no incumbent + version === 1)**: ACCEPT. This is
   *     the first activation of a freshly-created agent; there's nothing for
   *     a predecessor to point at. Matches the router's `create → approve`
   *     flow (`createWithSeedAndAudit` inserts a `proposed` v1 with
   *     `previous_version_id: null` and the owner immediately approves it).
   *
   *   - **Migrated legacy (any version, `metadata.migrated_from_legacy === true`)**:
   *     REJECT with `migrated_legacy_proposal`. Migration 061 stamps every
   *     backfilled row with `previous_version_id: null` + the
   *     `migrated_from_legacy` marker because the original lineage is
   *     unknowable from the legacy four-column shape. Accepting these would
   *     let a stale migrated proposal silently activate against an empty
   *     active slot (#173 finding).
   *
   *   - **`previous_version_id` key absent entirely**: REJECT with
   *     `predecessor_conflict` (`expected: 'unknown'`). Same conservative
   *     policy as round 2 — worst case is silent overwrite of a newer
   *     approved version.
   *
   * Codex Adversarial Review of PR #182 round 3 ([high] #186) — explicit
   * `null` predecessor on a non-seed proposal is now REJECTED outright with
   * the new `missing_predecessor` typed reason:
   *
   *   - **v2+ with `null` predecessor, no incumbent active**: REJECT. The
   *     round-2 policy structurally accepted `null === null` here, so an
   *     agent with `frozen`/`rolled_back` versions but no active row could
   *     approve a v2+ proposal with no lineage anchor — bypassing the
   *     stale-predecessor guard and reactivating profile state after
   *     rollback without binding to the last known version. Recovery from
   *     this state must go through an explicit recovery flow that binds the
   *     new proposal to the last frozen/rolled_back row, not through the
   *     normal approve path.
   *
   *   - **v1 with an incumbent active**: REJECT. A genuine v1 cannot
   *     coexist with an active incumbent (the version allocator wouldn't
   *     have produced v1 in that state). Treat as missing_predecessor
   *     rather than predecessor_conflict so the operator sees the right
   *     diagnosis.
   *
   *   - **v2+ with explicit `null` predecessor against a non-null
   *     incumbent**: still rejected — now via `missing_predecessor` (was
   *     `predecessor_conflict` in round 2). The dangerous shape is the
   *     same; the new reason name better describes the cause.
   *
   * Required input is explicit (no AsyncLocalStorage dependency) so the
   * router can call it without `runWithTenantContext`.
   *
   * Spec perfil-inbox v4 §1.4 — o CORPO vive em `approveAndActivateInTx`
   * (extração mecânica; locks/guards/transições idênticos) para compor com a
   * tx do motor unificado (`decideAtomically`). Este wrapper abre a própria
   * tx, chama o InTx, escreve o audit DENTRO da mesma tx e traduz o throw
   * tipado de volta para o resultado tipado histórico — comportamento
   * byte-a-byte, verificado por teste de caracterização.
   *
   * FASE C (spec §3): o shim `agents.approveProfile` foi removido — este
   * wrapper NÃO tem mais caller de produção. É mantido como o primitivo
   * atômico caracterizado do repo: as suites de concorrência issue-166/
   * issue-177 e o contrato InTx (`profile-approve-intx-contract`) exercitam
   * os guards de predecessor contra DB real ATRAVÉS dele. Remover só quando
   * essas suites forem migradas para dirigir `decideAtomically` diretamente.
   */
  async approveAndActivateAtomic(args: {
    tenant_id: string;
    agent_id: string;
    /** ID of the `proposed` version being approved. */
    id: string;
    actor_id: string;
    actor_role: string;
    comment: string;
  }): Promise<
    | {
        ok: true;
        activated: { id: string; version: number };
        frozen_previous: { id: string; version: number } | null;
      }
    | {
        ok: false;
        reason:
          | 'not_found'
          | 'invalid_source_status'
          | 'transition_failed'
          | 'agent_missing';
      }
    | {
        ok: false;
        reason: 'predecessor_conflict';
        /** What the proposal expected the incumbent active id to be. */
        expected: string | null | 'unknown';
        /** What the incumbent active id actually is right now (post-lock). */
        current: string | null;
      }
    | {
        ok: false;
        reason: 'migrated_legacy_proposal';
        /** Always `null` for this case — migration 061 backfills explicit null. */
        expected: null;
        /** What the incumbent active id actually is right now (post-lock). */
        current: string | null;
      }
    | {
        ok: false;
        reason: 'missing_predecessor';
        /** The proposal's declared version — useful for the operator message. */
        proposed_version: number;
        /** What the incumbent active id actually is right now (post-lock). */
        current_predecessor: string | null;
      }
  > {
    // #511: set as the LAST thing inside the tx callback, so a throw before
    // that point publishes nothing. See `publishIdentityInvalidation`.
    let activated = false;
    try {
      return await withTx(async (tx) => {
        const r = await this.approveAndActivateInTx(tx, {
          tenant_id: args.tenant_id,
          agent_id: args.agent_id,
          id: args.id,
          actor_id: args.actor_id,
        });
        // Audit do wrapper legado DENTRO da MESMA tx (review v3 do spec
        // perfil-inbox): se este insert falhar, TUDO reverte e o incumbente
        // segue ativo — nenhuma mudança de governança sem trilha.
        await tx.insert(admin_audit_log).values({
          tenant_id: args.tenant_id,
          actor_id: args.actor_id,
          actor_role: args.actor_role,
          action: 'agent_profile_approve',
          resource_type: 'agent_operational_profile_version',
          resource_id: args.id,
          change_summary: {
            agent_id: args.agent_id,
            new_version_id: args.id,
            new_version: r.activated.version,
            previous_active_id: r.frozen_previous?.id ?? null,
            previous_active_version: r.frozen_previous?.version ?? null,
            // Codex round 2: record the predecessor expectation declared by
            // the proposal so forensics can prove this approval did NOT win
            // a write-skew race (expected == current at lock time).
            expected_predecessor_id: r.expected_predecessor,
            comment: args.comment,
          },
        });
        activated = true;
        return {
          ok: true as const,
          activated: r.activated,
          frozen_previous: r.frozen_previous,
        };
      });
    } catch (err) {
      // Tradução do contrato de THROW do InTx de volta ao resultado tipado
      // histórico deste wrapper (caracterização byte-a-byte).
      if (err instanceof ProfileTransitionError) {
        const d = err.detail;
        switch (d.reason) {
          case 'predecessor_conflict':
            return { ok: false, reason: d.reason, expected: d.expected, current: d.current };
          case 'migrated_legacy_proposal':
            return { ok: false, reason: d.reason, expected: d.expected, current: d.current };
          case 'missing_predecessor':
            return {
              ok: false,
              reason: d.reason,
              proposed_version: d.proposed_version,
              current_predecessor: d.current_predecessor,
            };
          default:
            return { ok: false, reason: d.reason };
        }
      }
      throw err;
    } finally {
      if (activated) await publishIdentityInvalidation(args.tenant_id, args.agent_id);
    }
  },

  /**
   * Spec perfil-inbox v4 §1.4 — PRIMITIVO transacional da aprovação de
   * perfil: locks (agente pai FOR UPDATE, proposta, incumbente), guards de
   * predecessor (#171/#173/#182/#186) e transições — extração MECÂNICA do
   * corpo de `approveAndActivateAtomic`, sem abrir tx e sem audit próprio.
   *
   * FALHA SEMPRE LANÇA `ProfileTransitionError`: dentro da tx do
   * `decideAtomically` (que insere approval + audit ANTES da transição), o
   * throw faz rollback TOTAL — nenhum estado parcial, nenhum dup-check
   * falso-positivo no retry (invariante 1b). O chamador captura FORA do
   * `withTx` e traduz para o seu resultado tipado.
   */
  async approveAndActivateInTx(
    tx: Tx,
    args: {
      tenant_id: string;
      agent_id: string;
      /** ID of the `proposed` version being approved. */
      id: string;
      actor_id: string;
    },
  ): Promise<{
    activated: { id: string; version: number };
    frozen_previous: { id: string; version: number } | null;
    /** Expectativa de predecessor declarada pela proposta (para o audit do chamador). */
    expected_predecessor: string | null;
  }> {
    // (0) Lock the parent agent row FIRST. This serializes against EVERY
    // other writer that touches `(tenant, agent)` operational profile
    // state — `proposeAndAuditAtomic`, `seedNewActiveAtomic`, and
    // `operationalProfileVersionsRepo.create` all go through
    // `lockParentAgent` (directly or via `acquireNextVersionForAgent`).
    // Without this lock, a concurrent `seedNewActiveAtomic` could freeze
    // and insert a new active row between our read and freeze, causing
    // the partial unique index on (tenant, agent) WHERE status='active'
    // to reject one tx as a 500 instead of a serialized update
    // (Codex round 3 [medium]).
    const agentLocked = await lockParentAgent(tx, args.tenant_id, args.agent_id);
    if (!agentLocked) {
      // The agent was deleted between the router's findById check and
      // this lock acquisition. Surface a typed-miss so the caller can
      // translate to NOT_FOUND (same outcome as the upfront check) and
      // we don't leak a half-applied transaction.
      throw new ProfileTransitionError({ reason: 'agent_missing' });
    }

    // (1) Lock the proposed row inside the tx so concurrent approvers
    // serialize on it.
    const proposedRows = await tx
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.id, args.id),
          eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
          eq(agent_operational_profile_versions.agent_id, args.agent_id),
        ),
      )
      .for('update')
      .limit(1);
    const proposed = proposedRows[0];
    if (!proposed) throw new ProfileTransitionError({ reason: 'not_found' });
    if (proposed.status !== 'proposed') {
      throw new ProfileTransitionError({ reason: 'invalid_source_status' });
    }

    // (2) Lock the current active (if any). Note: the parent-agent lock
    // already serializes every writer, so this row lock is defense-in-
    // depth (catches any future codepath that bypasses the parent lock
    // and only touches the active row directly).
    const activeRows = await tx
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
          eq(agent_operational_profile_versions.agent_id, args.agent_id),
          eq(agent_operational_profile_versions.status, 'active'),
        ),
      )
      .for('update')
      .limit(1);
    const incumbent = activeRows[0] ?? null;

    // (2b) Predecessor enforcement — Codex round 2 [high] #1 + round 3
    // [high] #173.
    // The proposal was built against a specific incumbent id (recorded in
    // profile_body.metadata.previous_version_id). If the current incumbent
    // (re-read post-lock) doesn't match, a different proposal won the
    // race — approving this one would silently drop that newer version's
    // changes while the audit lineage still pointed at the old
    // predecessor. Reject so the caller can refresh + re-propose.
    const expectedPredecessor = readExpectedPredecessor(proposed.profile_body);
    const currentPredecessor = incumbent?.id ?? null;
    if (expectedPredecessor === 'unknown') {
      // Legacy proposal authored before this codepath — see policy in
      // the doccomment above. Refuse rather than risk silent overwrite.
      throw new ProfileTransitionError({
        reason: 'predecessor_conflict',
        expected: 'unknown',
        current: currentPredecessor,
      });
    }

    // Round 3 [high] #173: explicit `null` predecessor needs context.
    // Migration 061 backfills `null` + `migrated_from_legacy: true` for
    // every legacy row whose original lineage is unknowable. Without this
    // discriminator, a stale migrated proposal could silently activate
    // against an empty active slot (the (no incumbent + null predecessor)
    // pair is indistinguishable from intentional seed v1). Reject migrated
    // proposals with a distinct sentinel so the operator must re-propose
    // under the new flow.
    if (expectedPredecessor === null && isMigratedLegacy(proposed.profile_body)) {
      throw new ProfileTransitionError({
        reason: 'migrated_legacy_proposal',
        expected: null,
        current: currentPredecessor,
      });
    }

    // Round 3 [high] #173: intentional-seed exception. Explicit `null`
    // predecessor is legitimate when (a) there's no incumbent active row
    // AND (b) this is version 1 — the first activation of a freshly-
    // created agent (`createWithSeedAndAudit` → owner approves the seed).
    const isIntentionalSeed =
      expectedPredecessor === null && currentPredecessor === null && proposed.version === 1;

    // Codex Adversarial Review of PR #182 round 3 ([high] #186): explicit
    // `null` predecessor on any non-seed proposal must be rejected.
    // Without this gate, an agent with `frozen`/`rolled_back` versions but
    // no active row (e.g. post-rollback recovery window) could approve a
    // v2+ proposal whose `previous_version_id` is `null` — the structural
    // `null === null` equality would pass and the new active row would
    // appear with no lineage anchor at all, silently bypassing the
    // stale-predecessor guard that round 2/3 introduced.
    //
    // The four explicit cases we now distinguish:
    //   - v1 + no incumbent + null pred       → ACCEPT (intentional seed, handled above)
    //   - v1 + incumbent present + null pred  → REJECT as missing_predecessor
    //       (a v1 cannot coexist with an active row — the version allocator
    //       would never produce v1 in that state)
    //   - v2+ + no incumbent + null pred      → REJECT as missing_predecessor
    //       (recovery requires explicit lineage to the last frozen/rolled_back row)
    //   - v2+ + incumbent + null pred         → REJECT as missing_predecessor
    //       (round 2 already caught this as predecessor_conflict; the new
    //       reason name better describes the cause)
    if (!isIntentionalSeed && expectedPredecessor === null) {
      throw new ProfileTransitionError({
        reason: 'missing_predecessor',
        proposed_version: proposed.version,
        current_predecessor: currentPredecessor,
      });
    }

    if (!isIntentionalSeed && expectedPredecessor !== currentPredecessor) {
      throw new ProfileTransitionError({
        reason: 'predecessor_conflict',
        expected: expectedPredecessor,
        current: currentPredecessor,
      });
    }

    const now = new Date();

    // (3) Freeze incumbent if it exists. proposed-version row itself can't
    // be its own incumbent (we already asserted proposed.status==='proposed'
    // != 'active'), so the WHERE id != proposed.id is defensive.
    if (incumbent) {
      const frozen = await tx
        .update(agent_operational_profile_versions)
        .set({ status: 'frozen', frozen_at: now })
        .where(eq(agent_operational_profile_versions.id, incumbent.id))
        .returning({ id: agent_operational_profile_versions.id });
      if (frozen.length === 0) {
        throw new ProfileTransitionError({ reason: 'transition_failed' });
      }
    }

    // (4) Activate the proposed.
    const activated = await tx
      .update(agent_operational_profile_versions)
      .set({
        status: 'active',
        approved_at: proposed.approved_at ?? now,
        approved_by: proposed.approved_by ?? args.actor_id,
        activated_at: now,
      })
      .where(eq(agent_operational_profile_versions.id, args.id))
      .returning({ id: agent_operational_profile_versions.id });
    if (activated.length === 0) {
      throw new ProfileTransitionError({ reason: 'transition_failed' });
    }

    return {
      activated: { id: proposed.id, version: proposed.version },
      frozen_previous: incumbent
        ? { id: incumbent.id, version: incumbent.version }
        : null,
      expected_predecessor: expectedPredecessor,
    };
  },

  /**
   * Spec perfil-inbox v4 §1.4 — reject dentro da tx do motor unificado:
   * `proposed → rolled_back` (terminal) pelo MESMO padrão (falha ⇒ throw ⇒
   * rollback). Serializa no lock do agente pai como todo writer desta tabela.
   */
  async rejectProposedInTx(
    tx: Tx,
    args: {
      tenant_id: string;
      agent_id: string;
      id: string;
      rollback_reason: string;
    },
  ): Promise<{ rejected: { id: string; version: number } }> {
    const agentLocked = await lockParentAgent(tx, args.tenant_id, args.agent_id);
    if (!agentLocked) throw new ProfileTransitionError({ reason: 'agent_missing' });

    const rows = await tx
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.id, args.id),
          eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
          eq(agent_operational_profile_versions.agent_id, args.agent_id),
        ),
      )
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) throw new ProfileTransitionError({ reason: 'not_found' });
    if (row.status !== 'proposed') {
      throw new ProfileTransitionError({ reason: 'invalid_source_status' });
    }

    const updated = await tx
      .update(agent_operational_profile_versions)
      .set({
        status: 'rolled_back',
        rolled_back_at: new Date(),
        rollback_reason: args.rollback_reason,
      })
      .where(
        and(
          eq(agent_operational_profile_versions.id, args.id),
          eq(agent_operational_profile_versions.status, 'proposed'),
        ),
      )
      .returning({ id: agent_operational_profile_versions.id });
    if (updated.length === 0) {
      throw new ProfileTransitionError({ reason: 'transition_failed' });
    }
    return { rejected: { id: row.id, version: row.version } };
  },

  /**
   * Operator-initiated rollback (Admin UI `/versions`, issue #468): demote the
   * current active version to `rolled_back` and re-activate an earlier
   * `frozen` version — both transitions + the completion audit in ONE
   * transaction under the parent-agent lock (same serialization protocol as
   * `approveAndActivateAtomic` / `escalateRollbackIfStillFrozen`).
   *
   * Both edges are legal in the state machine (`active → rolled_back`,
   * `frozen → active`). The `from_version` argument is a stale guard: the
   * operator decided looking at a specific active version; if a concurrent
   * approve/seed changed the slot, we refuse with the post-lock truth instead
   * of rolling back the wrong row.
   *
   * Only `frozen` rows are valid targets — `proposed` was never approved
   * (re-activating it would bypass the approval invariant) and `rolled_back`
   * is terminal.
   */
  async adminRollbackAtomic(args: {
    tenant_id: string;
    agent_id: string;
    /** Active version the operator believes is current (stale guard). */
    from_version: number;
    /** Earlier frozen version to re-activate. */
    to_version: number;
    actor_id: string;
    actor_role: string;
    reason: string;
  }): Promise<
    | {
        ok: true;
        activated: { id: string; version: number };
        rolled_back: { id: string; version: number };
      }
    | { ok: false; reason: 'agent_missing' }
    | { ok: false; reason: 'active_mismatch'; actual_active_version: number | null }
    | { ok: false; reason: 'target_not_found' }
    | { ok: false; reason: 'target_invalid_status'; actual_status: ProfileStatus }
    | { ok: false; reason: 'transition_failed' }
  > {
    const result = await withTx(async (tx) => {
      // (0) Parent-agent lock — serializes against every other writer of
      // this (tenant, agent)'s profile state.
      const agentLocked = await lockParentAgent(tx, args.tenant_id, args.agent_id);
      if (!agentLocked) {
        return { ok: false as const, reason: 'agent_missing' as const };
      }

      // (1) Lock the current active row and verify it is the version the
      // operator decided on. Post-lock mismatch (including "no active row")
      // → refuse with the actual state so the UI can refresh.
      const activeRows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      const active = activeRows[0] ?? null;
      if (!active || active.version !== args.from_version) {
        return {
          ok: false as const,
          reason: 'active_mismatch' as const,
          actual_active_version: active?.version ?? null,
        };
      }

      // (2) Lock the target row by version. Must exist and be `frozen`.
      const targetRows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
            eq(agent_operational_profile_versions.version, args.to_version),
          ),
        )
        .for('update')
        .limit(1);
      const target = targetRows[0];
      if (!target) {
        return { ok: false as const, reason: 'target_not_found' as const };
      }
      if (target.status !== 'frozen') {
        return {
          ok: false as const,
          reason: 'target_invalid_status' as const,
          actual_status: target.status as ProfileStatus,
        };
      }

      const now = new Date();

      // (3) Demote the active row. Status predicate is belt-and-suspenders —
      // we hold both the parent lock and the row lock.
      const demoted = await tx
        .update(agent_operational_profile_versions)
        .set({
          status: 'rolled_back',
          rolled_back_at: now,
          rollback_reason: args.reason,
        })
        .where(
          and(
            eq(agent_operational_profile_versions.id, active.id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .returning({ id: agent_operational_profile_versions.id });
      if (demoted.length === 0) {
        return { ok: false as const, reason: 'transition_failed' as const };
      }

      // (4) Re-activate the frozen target. Demote committed first inside the
      // same tx, so the partial unique index on (tenant, agent)
      // WHERE status='active' never sees two active rows.
      const activated = await tx
        .update(agent_operational_profile_versions)
        .set({ status: 'active', activated_at: now })
        .where(
          and(
            eq(agent_operational_profile_versions.id, target.id),
            eq(agent_operational_profile_versions.status, 'frozen'),
          ),
        )
        .returning({ id: agent_operational_profile_versions.id });
      if (activated.length === 0) {
        return { ok: false as const, reason: 'transition_failed' as const };
      }

      // (5) Completion audit in the SAME tx — a rollback that isn't audited
      // doesn't happen (everything above rolls back with it).
      await tx.insert(admin_audit_log).values({
        tenant_id: args.tenant_id,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        action: 'version_rollback_completed',
        resource_type: 'agent_operational_profile_version',
        resource_id: target.id,
        change_summary: {
          agent_id: args.agent_id,
          rolled_back_id: active.id,
          rolled_back_version: active.version,
          activated_id: target.id,
          activated_version: target.version,
          reason: args.reason,
        },
      });

      return {
        ok: true as const,
        activated: { id: target.id, version: target.version },
        rolled_back: { id: active.id, version: active.version },
      };
    });

    // #511: a rollback swaps which version occupies the active slot, so every
    // replica's cached identity is stale the moment this commits.
    if (result.ok) await publishIdentityInvalidation(args.tenant_id, args.agent_id);
    return result;
  },

  // Próxima version sequencial para (tenant_id, agent_id) corrente.
  // MAX(version) + 1, ou 1 quando não existe versão ainda.
  async nextVersion(): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ max: number | null }>(sql`
      SELECT MAX(version) AS max
        FROM agent_operational_profile_versions
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
    `);
    const max = result.rows[0]?.max ?? null;
    return max == null ? 1 : Number(max) + 1;
  },

  // Review #100 fix: atomic create-frozen-active in one transaction with
  // FOR UPDATE locking. Used by data migration scripts (P8d priorities) to
  // avoid the create→freeze→activate window where a crash leaves the agent
  // with no active profile.
  //
  // Codex Adversarial Review of PR #171 round 2 (issue #166) — the lock
  // target moved from the active-row tuple to the parent `agents` row via
  // `acquireNextVersionForAgent`. Locking the active row only serializes
  // concurrent seeds against EACH OTHER; it does NOT block a concurrent
  // `proposeAndAuditAtomic` (which only has a proposed insert, not an active
  // freeze) from also reading MAX(version) and colliding on
  // `agent_op_profile_version_uq`. By harmonizing on the parent-agent lock,
  // every writer for the same (tenant, agent) now serializes regardless of
  // status.
  //
  // We STILL re-read the current active row inside the tx (after the agent
  // lock) to (a) keep the freeze→activate semantics intact and (b) honor
  // `expected_current_active_id` for the stale-read guard.
  //
  // Codex Adversarial Review of PR #190 (issue #195, [high]) — the
  // doccomment that previously said "we no longer need to lock this row
  // separately — the parent agent lock above already serializes every
  // writer" was DEFENSE-IN-DEPTH FALSE. `lockParentAgent` locks the
  // `agents` row, not the profile_versions row. Under READ COMMITTED a
  // concurrent writer that holds the v1 row lock — e.g. an out-of-band
  // SQL repair, a future codepath that drops `lockParentAgent`, or
  // (theoretically) `operationalProfileVersionsRepo.transition` running
  // in a tx whose lock ordering interleaves with our snapshot read —
  // can commit a `status` change to v1 between the snapshot SELECT here
  // and the freeze UPDATE below. Without `FOR UPDATE` on the read AND a
  // `status='active'` predicate on the freeze, the seed would silently
  // overwrite a just-rolled-back v1 back to `frozen`, undoing a drift
  // rollback and reporting success.
  //
  // Strategy A from the issue (preferred): keep `lockParentAgent` as the
  // primary serialization point, AND restore `FOR UPDATE` on the active-row
  // read here (so we hold a real row lock through the freeze window), AND
  // add `status='active'` to the freeze UPDATE WHERE so the DB itself
  // refuses to overwrite a row whose status changed under us regardless
  // of which locks any writer holds. Either guard alone would close the
  // lost-write window; both together make the invariant explicit at the
  // SQL level for any future reviewer.
  //
  // Semantics:
  //   - Locks the parent agent row FOR UPDATE so EVERY allocator of
  //     `agent_operational_profile_versions.version` for this (tenant, agent)
  //     serializes here.
  //   - Locks the current active profile-version row FOR UPDATE so the
  //     freeze window is held under a row-level lock (defense-in-depth
  //     against any writer that bypasses `lockParentAgent`).
  //   - Verifies tenant scope on both the lock and the inserts.
  //   - On any error inside the closure, the transaction rolls back —
  //     the old active row stays active.
  //   - Throws (instead of returning result) so callers can wrap in
  //     try/catch and count failures distinctly.
  async seedNewActiveAtomic(input: {
    profile_body: ProfileBody;
    proposed_by: string;
    proposed_reason?: string;
    /**
     * Expected current active id; if mismatch, throws — protects against
     * the caller having read stale data outside the tx.
     *
     * Codex PR #202 [HIGH]: REQUIRED for non-initial seeds (any seed where
     * prior versions exist for this agent). The seed throws
     * `seed_atomic_missing_predecessor_expectation` when omitted on a
     * non-initial allocation. Initial seeds (`nextV === 1`, no prior
     * versions) accept an absent expectation.
     */
    expected_current_active_id?: string;
  }): Promise<{
    new_active: AgentOperationalProfileVersion;
    frozen_previous: AgentOperationalProfileVersion | null;
  }> {
    // Validate before opening the transaction so we fail fast without
    // touching the DB on a malformed body.
    validateProfileBodyP8d(input.profile_body);

    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // #511: seeding promotes a brand-new version straight into the active
    // slot, so it changes `getActive()` exactly like an approval does.
    const seeded = await withTx(async (tx) => {
      // 1) Allocate next version via the shared helper. This (a) takes the
      //    parent agent FOR UPDATE lock and (b) reads MAX(version) behind
      //    it. Throws on missing agent — historically this method was
      //    invoked only by migration scripts that pre-verified the agent
      //    exists, so a missing agent here is a real programmer error.
      const nextV = await acquireNextVersionForAgent(tx, tenant_id, agent_id);
      if (nextV == null) {
        throw new Error(
          `seed_atomic_missing_agent: ${tenant_id}/${agent_id} not found before lock`,
        );
      }

      // 2) Re-read the current active row INSIDE the tx so the stale-read
      //    guard (`expected_current_active_id`) sees post-lock state.
      //
      //    Issue #195: this read is now `FOR UPDATE`. The parent-agent lock
      //    already serializes every writer that goes through
      //    `lockParentAgent` / `acquireNextVersionForAgent`, but it does
      //    NOT block a writer that holds a row-level lock on this
      //    profile_versions row in a different lock domain (out-of-band
      //    SQL, future refactor, edge-case `transition` interleaving).
      //    Re-acquiring `FOR UPDATE` here turns the snapshot read into a
      //    hard row lock that's held through the freeze UPDATE below,
      //    closing the lost-write window even when callers race in ways
      //    `lockParentAgent` alone can't serialize.
      const activeRows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      const currentActive = activeRows[0] ?? null;

      // Codex Adversarial Review of PR #202 (issue #195 follow-up, [HIGH]) —
      // closed lost-write window for the "rolled-back-before-lock" path.
      //
      // After the `FOR UPDATE` re-read above, a row whose status was
      // concurrently flipped to a non-active value (e.g. `rolled_back` by
      // the drift engine, `frozen` by another writer) disappears from the
      // `status='active'` result set. Pre-#202, when the caller omitted
      // `expected_current_active_id`, this code:
      //
      //   1. Saw `currentActive == null` (the rolled-back row is no
      //      longer 'active').
      //   2. Skipped the freeze step entirely (no active row to freeze).
      //   3. Inserted a brand-new `status='active'` row, immediately
      //      re-enabling runtime profile state — defeating the rollback's
      //      intent (the decision engine wanted the agent OFF, not
      //      OFF-then-ON-with-a-new-row).
      //
      // The single production caller (`scripts/p8d-migration-priorities.ts`)
      // already passes `expected_current_active_id` because it has read
      // `getActive()` first. There is no legitimate production code path
      // today that creates a non-initial active version without first
      // observing the predecessor. Make that contract explicit:
      //
      //   - `nextV === 1` (no prior versions for this agent) is the
      //     legitimate "initial seed" case — there is no predecessor to be
      //     stale against, so omitting `expected_current_active_id` is OK.
      //   - `nextV > 1` (prior versions exist) means the caller is
      //     re-seeding an agent whose history is non-empty. The caller
      //     MUST declare which active row they expect to supersede,
      //     because that is the ONLY way to detect "the predecessor was
      //     rolled back under us between my `getActive()` and this lock".
      //     Omitting the expectation throws and the tx rolls back —
      //     no silent re-activation post-rollback.
      //
      // Future intentional "no-active recovery seed" (e.g. operator
      // creating a fresh active after every prior version was rolled back
      // manually) should add an explicit `allow_no_predecessor: true`
      // input. Today no caller needs that path; surface it as a typed
      // error so any future addition has to opt in deliberately.
      if (nextV > 1 && !input.expected_current_active_id) {
        throw new Error(
          'seed_atomic_missing_predecessor_expectation: ' +
            `non-initial seed (nextV=${nextV}) requires expected_current_active_id ` +
            'to detect concurrent rollback/freeze of the predecessor',
        );
      }

      if (
        input.expected_current_active_id &&
        currentActive?.id !== input.expected_current_active_id
      ) {
        throw new Error(
          `seed_atomic_stale_active: expected ${input.expected_current_active_id}, found ${currentActive?.id ?? 'none'}`,
        );
      }

      const now = new Date();

      // 3) Freeze the previous active row FIRST so the partial unique index
      //    on (tenant, agent) WHERE status='active' is satisfied before the
      //    new insert lands. Otherwise both rows would compete for activeness.
      //
      //    Issue #195: `status = 'active'` is now in the WHERE clause as
      //    defense-in-depth. Under READ COMMITTED, if a concurrent writer
      //    committed a status change between our snapshot (step 2) and this
      //    UPDATE, EvalPlanQual re-evaluates the predicate against the new
      //    committed row — `status != 'active'` matches zero rows and we
      //    throw `seed_atomic_freeze_failed`, rolling the seed tx back
      //    rather than silently undoing the concurrent state change (e.g.
      //    a drift `transition({to:'rolled_back'})` win). With the
      //    `FOR UPDATE` lock in step 2 this path is the unreachable
      //    defense-in-depth tier; without it, this predicate alone still
      //    closes the lost-write window.
      let frozenPrevious: AgentOperationalProfileVersion | null = null;
      if (currentActive) {
        const [updated] = await tx
          .update(agent_operational_profile_versions)
          .set({ status: 'frozen', frozen_at: now })
          .where(
            and(
              eq(agent_operational_profile_versions.id, currentActive.id),
              eq(agent_operational_profile_versions.tenant_id, tenant_id),
              eq(agent_operational_profile_versions.agent_id, agent_id),
              eq(agent_operational_profile_versions.status, 'active'),
            ),
          )
          .returning();
        if (!updated) {
          // Either the row vanished (rare; agent deletion under the parent
          // lock is impossible) or — issue #195 — a concurrent writer
          // changed `status` out from under us between the FOR UPDATE
          // snapshot and this UPDATE. Surface as `seed_atomic_freeze_failed`
          // so the seed tx rolls back and the caller observes the race
          // rather than silently overwriting a non-active row.
          throw new Error(
            'seed_atomic_freeze_failed: previous active row vanished or status changed mid-tx',
          );
        }
        frozenPrevious = updated;
      }

      // 4) Insert the new row directly as `active`. The partial unique index
      //    rejects if another active row sneaks in between the freeze above
      //    and this insert — that forces tx rollback and the caller retries.
      const guarded = applyTenantGuard({
        version: nextV,
        status: 'active',
        profile_body: input.profile_body,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
        approved_by: input.proposed_by,
        approved_at: now,
        activated_at: now,
      });
      const [inserted] = await tx
        .insert(agent_operational_profile_versions)
        .values(guarded)
        .returning();
      if (!inserted) {
        throw new Error('seed_atomic_insert_failed: returning() empty');
      }

      return { new_active: inserted, frozen_previous: frozenPrevious };
    });

    await publishIdentityInvalidation(tenant_id, agent_id);
    return seeded;
  },
};

// P4: agent_drift_alerts — audit das execuções do drift detector.
// Cada alert = 1 evento (drift_type, severity, decision) + evidência + audit
// trail (decided_by, resolved_by, resolution_note). FK opcional para
// agent_operational_profile_versions porque drifts podem ser detectados antes
// de uma nova versão de perfil ser proposta.
export const driftAlertsRepo = {
  async create(input: {
    profile_version_id?: string;
    drift_type: DriftType;
    severity: DriftSeverity;
    evidence: unknown;
    detected_by: string;
    decision: DriftDecision;
    decided_by: string;
  }): Promise<AgentDriftAlert> {
    const guarded = applyTenantGuard({
      profile_version_id: input.profile_version_id ?? null,
      drift_type: input.drift_type,
      severity: input.severity,
      evidence: input.evidence as object,
      detected_by: input.detected_by,
      decision: input.decision,
      decided_by: input.decided_by,
    });
    const [row] = await db
      .insert(agent_drift_alerts)
      .values(guarded as typeof agent_drift_alerts.$inferInsert)
      .returning();
    return row!;
  },

  async listUnresolved(): Promise<AgentDriftAlert[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_drift_alerts)
      .where(
        and(
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
          isNull(agent_drift_alerts.resolved_at),
        ),
      )
      .orderBy(desc(agent_drift_alerts.created_at));
  },

  async listByProfileVersion(profile_version_id: string): Promise<AgentDriftAlert[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_drift_alerts)
      .where(
        and(
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
          eq(agent_drift_alerts.profile_version_id, profile_version_id),
        ),
      )
      .orderBy(desc(agent_drift_alerts.created_at));
  },

  // [P86-C3] tenant-scoped: includes tenant_id AND agent_id predicates in
  // the UPDATE so an alert UUID from another tenant cannot be resolved from
  // the wrong context. Returns { ok, found } so callers can detect a
  // forbidden/missing target without silently no-op'ing.
  async resolve(args: {
    id: string;
    resolution_note: string;
    resolved_by: string;
  }): Promise<{ ok: boolean; found: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(agent_drift_alerts)
      .set({
        resolution_note: args.resolution_note,
        resolved_at: new Date(),
        resolved_by: args.resolved_by,
      })
      .where(
        and(
          eq(agent_drift_alerts.id, args.id),
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
        ),
      )
      .returning({ id: agent_drift_alerts.id });
    return { ok: updated.length > 0, found: updated.length > 0 };
  },
};
