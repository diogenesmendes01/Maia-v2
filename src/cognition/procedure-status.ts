import {
  procedureDefinitionsRepo,
  procedureStatusEventsRepo,
} from '@/db/repositories.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import type { ProcedureDefinition } from '@/db/schema.js';

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
 * Apply a status transition.
 *
 * - Refuses to run without a tenant context (P83-M6: no fallback to
 *   `default`; every transition must be auditable to a real tenant).
 * - Routes `→ active` through `procedureDefinitionsRepo.atomicActivate`,
 *   which (a) takes row-level locks, (b) freezes any sibling active
 *   version, (c) appends event rows — all in a single transaction.
 *   Combined with the UNIQUE partial index on (tenant,agent,nome) WHERE
 *   status='active', dual-active is impossible. (P83-C4, H1, H2)
 * - For other transitions, performs a tenant-scoped update and appends
 *   an event row. updateStatus returns the affected-row count so a
 *   cross-tenant id surfaces as "no row affected" instead of silent
 *   success. (P83-H5)
 */
export async function transitionProcedureStatus(args: {
  definition: ProcedureDefinition;
  to: ProcedureStatus;
  actor: string;
  reason?: string;
}): Promise<void> {
  validateTransition(args.definition.status, args.to);
  // P83-M6 guard: throw if invoked outside a tenant context.
  getCurrentTenant();
  getCurrentAgent();

  if (args.to === 'active') {
    // Atomic path: locking + freeze-previous + event log in one tx.
    await procedureDefinitionsRepo.atomicActivate({
      target_id: args.definition.id,
      actor: args.actor,
      preserve_activated_at: true,
    });
    return;
  }

  const now = new Date();
  const updates: Parameters<typeof procedureDefinitionsRepo.updateStatus>[1] = {
    status: args.to,
  };

  if (args.to === 'proposed') {
    updates.proposed_by = args.actor;
  } else if (args.to === 'frozen' || args.to === 'rolled_back') {
    updates.deactivated_at = now;
  }

  const affected = await procedureDefinitionsRepo.updateStatus(args.definition.id, updates);
  if (affected === 0) {
    throw new Error(
      `procedure_definition ${args.definition.id} not updated — wrong tenant context or row missing`,
    );
  }

  await procedureStatusEventsRepo.record({
    definition_id: args.definition.id,
    from_status: args.definition.status,
    to_status: args.to,
    actor: args.actor,
    reason: args.reason,
  });
}
