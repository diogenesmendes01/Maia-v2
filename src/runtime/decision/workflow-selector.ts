/**
 * P9b — Workflow Selector.
 *
 * Spec §7.3: decides continue / switch / none for an active procedure
 * execution. Pure heuristic (no LLM) — uses domain match + TTL threshold.
 *
 * Budget target: <20ms.
 */
import type {
  ProceduresRepo,
  WorkflowSelector,
  WorkflowSelectorResult,
} from './types.js';
import type {
  BaseContextPacket,
  DecisionPacket,
} from '../context-packet/types.js';

export interface WorkflowSelectorDeps {
  proceduresRepo: ProceduresRepo;
}

/**
 * Simple intent → domain mapping. Override-friendly: a future iteration may
 * read this from a tenant_settings table.
 */
const DOMAIN_INTENT_MAP: Record<string, readonly string[]> = {
  onboarding: ['onboarding_next_step', 'account_setup'],
  support: ['issue_report', 'faq_query', 'help_request'],
  transfer: ['transfer_intent', 'transfer_confirm'],
  cancel: ['cancel_request'],
};

const TTL_KEEP_THRESHOLD_MS = 30_000;

export class WorkflowSelectorImpl implements WorkflowSelector {
  constructor(private deps: WorkflowSelectorDeps) {}

  async select(
    base: BaseContextPacket,
    intent: DecisionPacket['intent'],
  ): Promise<WorkflowSelectorResult> {
    if (!base.active_procedure_execution_id) {
      return { mode: 'none' };
    }

    const exec = await this.deps.proceduresRepo.findExecution(
      base.active_procedure_execution_id,
    );
    if (!exec) {
      return { mode: 'none' };
    }

    if (this.intentMatchesProcedureDomain(intent.label, exec.procedure_domain)) {
      return { workflow_id: exec.procedure_id, mode: 'continue' };
    }

    // Different intent: stay if there's plenty of TTL left; switch if near expiry.
    if (exec.ttl_remaining_ms > TTL_KEEP_THRESHOLD_MS) {
      return { workflow_id: exec.procedure_id, mode: 'continue' };
    }
    return { mode: 'switch' };
  }

  private intentMatchesProcedureDomain(intent: string, domain: string): boolean {
    const intents = DOMAIN_INTENT_MAP[domain];
    if (!intents) return false;
    return intents.includes(intent);
  }
}
