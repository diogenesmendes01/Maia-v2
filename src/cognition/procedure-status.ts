import { procedureDefinitionsRepo, procedureStatusEventsRepo, procedureTestsRepo } from '@/db/repositories.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { withTx } from '@/db/client.js';
import type { ProcedureDefinition, ProcedureStatusUpdate, ProcedureTest } from '@/db/schema.js';

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
 */
export async function transitionProcedureStatus(args: {
  definition: ProcedureDefinition;
  to: ProcedureStatus;
  actor: string;
}): Promise<TransitionResult> {
  validateTransition(args.definition.status, args.to);
  // P83-M6 guard: throw if invoked outside a tenant context.
  getCurrentTenant();
  getCurrentAgent();

  // -------------------------------------------------------------------------
  // Round-1 Fix 1: tenant-scoped ownership/existence check BEFORE any gate
  // evaluation. A cross-tenant caller may possess a definition object from
  // another tenant; `findById` is tenant-scoped so it returns null for any
  // row invisible to the current context. Throwing here prevents the gate
  // (listByDefinition / tests_required) from masking the trust-boundary
  // violation with a soft governance result.
  // -------------------------------------------------------------------------
  const owned = await procedureDefinitionsRepo.findById(args.definition.id);
  if (!owned) {
    throw new ProcedureNotFoundError(
      `procedure ${args.definition.id} not found or not accessible from the current tenant context`,
    );
  }

  if (args.to === 'active') {
    // P3c gate: proposed → active requires green tests. Fires ONLY on
    // proposed → active; other transitions to active (e.g., frozen → active
    // re-activation by an operator) bypass the gate.
    if (args.definition.status === 'proposed') {
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
  // Round-1 Fix 2: wrap update + event insert in a single transaction so
  // that a failure in either step rolls back both. Prior to this fix, a
  // failed `record()` call left the status changed with no audit trail.
  // -------------------------------------------------------------------------
  const now = new Date();
  // P83-L1: use the exported ProcedureStatusUpdate type directly instead of
  // a `Parameters<typeof ...>[1]` lookup. Both refer to the same shape; the
  // direct alias is clearer at the call site and easier to evolve.
  const updates: ProcedureStatusUpdate = {
    status: args.to,
  };

  if (args.to === 'proposed') {
    updates.proposed_by = args.actor;
  } else if (args.to === 'frozen' || args.to === 'rolled_back') {
    updates.deactivated_at = now;
  }

  return withTx(async () => {
    const rowCount = await procedureDefinitionsRepo.updateStatus(
      args.definition.id,
      updates as Parameters<typeof procedureDefinitionsRepo.updateStatus>[1],
    );

    if (rowCount === 0) {
      throw new ProcedureNotFoundError(
        `procedure ${args.definition.id} was not updated — id not found or not accessible from the current tenant context`,
      );
    }

    // Record an audit event for every accepted non-active transition.
    // (Active transitions are handled inside atomicActivate, which records its
    // own event row atomically within the same transaction.)
    await procedureStatusEventsRepo.record({
      definition_id: args.definition.id,
      from_status: args.definition.status,
      to_status: args.to,
      actor: args.actor,
    });

    return {
      ok: true as const,
      definition: { ...args.definition, ...(updates as Partial<ProcedureDefinition>) },
    };
  });
}
