import { eq, and } from 'drizzle-orm';
import { procedureDefinitionsRepo, procedureTestsRepo } from '@/db/repositories.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { withTx } from '@/db/client.js';
import { procedure_definitions, procedure_status_events } from '@/db/schema.js';
import type { ProcedureDefinition, ProcedureTest } from '@/db/schema.js';

/**
 * Thrown when `updateStatus` returns 0 rows — meaning the procedure ID
 * does not belong to the current tenant/agent, or simply does not exist.
 * Callers MUST NOT treat this as a soft failure; a 0-row update is a
 * security boundary violation in multi-tenant code.
 */
export class ProcedureNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcedureNotFoundError';
  }
}

/**
 * Thrown when the caller's definition.status does not match the persisted
 * owned.status. Indicates a stale or forged caller payload — the caller must
 * re-fetch before retrying.
 */
export class StatusMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusMismatchError';
  }
}

/**
 * Thrown when a concurrent write races ahead of this call — the WHERE
 * status = owned.status predicate matched 0 rows, meaning another actor
 * already advanced the row. Callers should re-fetch and retry if appropriate.
 */
export class OptimisticLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

export type ProcedureStatus = 'draft' | 'proposed' | 'active' | 'frozen' | 'rolled_back';

const VALID_TRANSITIONS: Record<ProcedureStatus, ProcedureStatus[]> = {
  draft: ['proposed'],
  proposed: ['active', 'draft'],
  active: ['frozen', 'rolled_back'],
  frozen: ['active', 'rolled_back'],
  rolled_back: [], // terminal
};

export function canTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from as ProcedureStatus];
  if (!allowed) return false;
  return allowed.includes(to as ProcedureStatus);
}

export function validateTransition(from: string, to: string): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid procedure status transition: ${from} → ${to}`);
  }
}

/**
 * Result of an attempted transition.
 *
 * `ok: true` ⇒ the transition was performed.
 * `ok: false` ⇒ the transition was rejected by a gate (e.g. P3c test gate)
 * with a structured `reason`. Hard schema-level invariants (invalid
 * source→target combinations) still throw via `validateTransition` — those
 * are programming errors, not governance decisions.
 */
export type TransitionResult =
  | { ok: true; definition: ProcedureDefinition }
  | {
      ok: false;
      reason: 'tests_required';
      missing_tests: true;
    }
  | {
      ok: false;
      reason: 'tests_not_passing';
      failing_tests: ProcedureTest[];
    };

/**
 * Async helper that applies a transition AND, if going to 'active',
 * deactivates the previous active version of the same nome.
 *
 * P3c gate: `proposed → active` requires at least 1 procedure_test row
 * for the definition AND every row must have last_run_status='pass'.
 * The gate fires ONLY on `proposed → active`; other transitions
 * (draft→proposed, active→frozen, frozen→active, …) bypass it. Existing
 * `active` definitions are unaffected — they never re-enter `proposed`,
 * so the gate cannot retroactively block them.
 *
 * Round-2 fixes:
 * - All validation/gating/from_status derived from persisted `owned.status`
 *   (DB-authoritative), NOT from `args.definition.status` (caller-supplied).
 * - StatusMismatchError if caller status ≠ owned status — stale/forged payload.
 * - Non-active tx: inlines tx.update + tx.insert on the tx handle so rollback
 *   covers both writes atomically.
 * - WHERE status = owned.status optimistic lock on update; 0 rows → OptimisticLockError.
 */
export async function transitionProcedureStatus(args: {
  definition: ProcedureDefinition;
  to: ProcedureStatus;
  actor: string;
}): Promise<TransitionResult> {
  // P83-M6 guard: throw if invoked outside a tenant context.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  // -------------------------------------------------------------------------
  // Ownership check (tenant-scoped): verify the row is visible in this
  // tenant context. A cross-tenant caller may possess a definition object from
  // another tenant; `findById` is tenant-scoped so it returns null for any
  // row invisible to the current context.
  // -------------------------------------------------------------------------
  const owned = await procedureDefinitionsRepo.findById(args.definition.id);
  if (!owned) {
    throw new ProcedureNotFoundError(
      `procedure ${args.definition.id} not found or not accessible from the current tenant context`,
    );
  }

  // -------------------------------------------------------------------------
  // Round-2 Fix: Persisted status is the source of truth.
  // Reject stale/forged caller payloads before running any gate logic.
  // -------------------------------------------------------------------------
  if (owned.status !== args.definition.status) {
    throw new StatusMismatchError(
      `caller definition.status='${args.definition.status}' does not match persisted owned.status='${owned.status}' for procedure ${args.definition.id} — re-fetch before retrying`,
    );
  }

  // Validate transition from the persisted owned.status (not caller status).
  validateTransition(owned.status, args.to);

  if (args.to === 'active') {
    // P3c gate: proposed → active requires green tests. Fires ONLY on
    // proposed → active; other transitions to active (e.g., frozen → active
    // re-activation by an operator) bypass the gate.
    if (owned.status === 'proposed') {
      const tests = await procedureTestsRepo.listByDefinition(args.definition.id);
      if (tests.length === 0) {
        return { ok: false, reason: 'tests_required', missing_tests: true };
      }
      const failing = tests.filter((t) => t.last_run_status !== 'pass');
      if (failing.length > 0) {
        return { ok: false, reason: 'tests_not_passing', failing_tests: failing };
      }
    }
    // Atomic path: locking + freeze-previous + event log in one tx.
    const { activated } = await procedureDefinitionsRepo.atomicActivate({
      target_id: args.definition.id,
      actor: args.actor,
      preserve_activated_at: true,
    });
    return { ok: true, definition: activated };
  }

  // -------------------------------------------------------------------------
  // Non-active path: wrap status update + event insert in a single real tx.
  //
  // Round-2 Fix: the callback now receives and uses the `tx` handle for BOTH
  // writes. This means a failed event insert causes both writes to roll back
  // atomically — the tx is no longer cosmetic.
  //
  // Optimistic lock: WHERE status = owned.status ensures a concurrent write
  // that already advanced the row produces 0 rows affected, surfaced as
  // OptimisticLockError rather than a silent overwrite.
  // -------------------------------------------------------------------------
  const now = new Date();

  const setPayload: {
    status: string;
    updated_at: Date;
    proposed_by?: string;
    deactivated_at?: Date;
  } = {
    status: args.to,
    updated_at: now,
  };

  if (args.to === 'proposed') {
    setPayload.proposed_by = args.actor;
  } else if (args.to === 'frozen' || args.to === 'rolled_back') {
    setPayload.deactivated_at = now;
  }

  return withTx(async (tx) => {
    // Inline tx.update with optimistic lock: WHERE id = ? AND tenant = ? AND agent = ? AND status = owned.status
    const updated = await tx
      .update(procedure_definitions)
      .set(setPayload)
      .where(
        and(
          eq(procedure_definitions.id, args.definition.id),
          eq(procedure_definitions.tenant_id, tenant_id),
          eq(procedure_definitions.agent_id, agent_id),
          eq(procedure_definitions.status, owned.status), // optimistic lock
        ),
      )
      .returning({ id: procedure_definitions.id });

    if (updated.length === 0) {
      throw new OptimisticLockError(
        `procedure ${args.definition.id} was not updated — concurrent write raced ahead (optimistic lock conflict) or row no longer accessible`,
      );
    }

    // Inline tx.insert for the audit event — same tx, same rollback boundary.
    await tx
      .insert(procedure_status_events)
      .values({
        tenant_id,
        agent_id,
        definition_id: args.definition.id,
        from_status: owned.status, // persisted, not caller-supplied
        to_status: args.to,
        actor: args.actor,
      });

    return {
      ok: true as const,
      definition: { ...owned, ...setPayload } as ProcedureDefinition,
    };
  });
}
