import { procedureDefinitionsRepo, procedureTestsRepo } from '@/db/repositories.js';
import type { ProcedureDefinition, ProcedureTest } from '@/db/schema.js';

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

  // P3c gate: proposed → active requires green tests.
  if (args.definition.status === 'proposed' && args.to === 'active') {
    const tests = await procedureTestsRepo.listByDefinition(args.definition.id);
    if (tests.length === 0) {
      return { ok: false, reason: 'tests_required', missing_tests: true };
    }
    const failing = tests.filter((t) => t.last_run_status !== 'pass');
    if (failing.length > 0) {
      return { ok: false, reason: 'tests_not_passing', failing_tests: failing };
    }
  }

  const now = new Date();
  const updates: Record<string, unknown> = { status: args.to };

  if (args.to === 'proposed') {
    updates.proposed_by = args.actor;
  } else if (args.to === 'active') {
    updates.approved_by = args.actor;
    updates.approved_at = now;
    updates.activated_at = now;
    updates.deactivated_at = null;

    // Deactivate previous active version (only one active per nome)
    const previousActive = await procedureDefinitionsRepo.findActiveByName(args.definition.nome);
    if (previousActive && previousActive.id !== args.definition.id) {
      await procedureDefinitionsRepo.updateStatus(previousActive.id, {
        status: 'frozen',
        deactivated_at: now,
      });
    }
  } else if (args.to === 'frozen' || args.to === 'rolled_back') {
    updates.deactivated_at = now;
  }

  await procedureDefinitionsRepo.updateStatus(
    args.definition.id,
    updates as Parameters<typeof procedureDefinitionsRepo.updateStatus>[1],
  );

  return {
    ok: true,
    definition: { ...args.definition, ...(updates as Partial<ProcedureDefinition>) },
  };
}
