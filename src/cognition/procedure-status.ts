import { procedureDefinitionsRepo } from '@/db/repositories.js';
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
 * Async helper that applies a transition AND, if going to 'active',
 * deactivates the previous active version of the same nome.
 * Returns the updated definition.
 */
export async function transitionProcedureStatus(args: {
  definition: ProcedureDefinition;
  to: ProcedureStatus;
  actor: string;
}): Promise<void> {
  validateTransition(args.definition.status, args.to);

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

  await procedureDefinitionsRepo.updateStatus(args.definition.id, updates as Parameters<typeof procedureDefinitionsRepo.updateStatus>[1]);
}
