import { describe, it, expect, vi } from 'vitest';
import {
  WorkflowSelectorImpl,
  type WorkflowSelectorDeps,
} from '@/runtime/decision/workflow-selector.ts';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';
import type { ProceduresRepo } from '@/runtime/decision/types.js';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
    ...overrides,
  };
}

function mkDeps(overrides?: Partial<WorkflowSelectorDeps>): WorkflowSelectorDeps {
  const proceduresRepo: ProceduresRepo = {
    findExecution: vi.fn().mockResolvedValue(null),
  };
  return { proceduresRepo, ...overrides };
}

describe('P9b — WorkflowSelector', () => {
  it('returns none if no active_procedure_execution_id', async () => {
    const deps = mkDeps();
    const selector = new WorkflowSelectorImpl(deps);
    const r = await selector.select(mkBase(), { label: 'greet', confidence: 0.9 });
    expect(r.mode).toBe('none');
    expect(r.workflow_id).toBeUndefined();
    expect(deps.proceduresRepo.findExecution).not.toHaveBeenCalled();
  });

  it('returns none if execution not found', async () => {
    const deps = mkDeps();
    const selector = new WorkflowSelectorImpl(deps);
    const r = await selector.select(
      mkBase({ active_procedure_execution_id: 'exec_missing' }),
      { label: 'help_request', confidence: 0.95 },
    );
    expect(r.mode).toBe('none');
  });

  it('returns continue with workflow_id when intent matches procedure domain', async () => {
    const deps = mkDeps({
      proceduresRepo: {
        findExecution: vi.fn().mockResolvedValue({
          execution_id: 'exec_1',
          procedure_id: 'onboard_pf',
          procedure_domain: 'onboarding',
          ttl_remaining_ms: 60_000,
        }),
      },
    });
    const selector = new WorkflowSelectorImpl(deps);
    const r = await selector.select(
      mkBase({ active_procedure_execution_id: 'exec_1' }),
      { label: 'onboarding_next_step', confidence: 0.85 },
    );
    expect(r.mode).toBe('continue');
    expect(r.workflow_id).toBe('onboard_pf');
  });

  it('returns continue (stay) if intent differs but TTL > 30s', async () => {
    const deps = mkDeps({
      proceduresRepo: {
        findExecution: vi.fn().mockResolvedValue({
          execution_id: 'exec_1',
          procedure_id: 'onboard_pf',
          procedure_domain: 'onboarding',
          ttl_remaining_ms: 60_000,
        }),
      },
    });
    const selector = new WorkflowSelectorImpl(deps);
    const r = await selector.select(
      mkBase({ active_procedure_execution_id: 'exec_1' }),
      { label: 'help_request', confidence: 0.95 },
    );
    expect(r.mode).toBe('continue');
    expect(r.workflow_id).toBe('onboard_pf');
  });

  it('returns switch if intent differs and TTL < 30s', async () => {
    const deps = mkDeps({
      proceduresRepo: {
        findExecution: vi.fn().mockResolvedValue({
          execution_id: 'exec_1',
          procedure_id: 'old_proc',
          procedure_domain: 'support',
          ttl_remaining_ms: 10_000,
        }),
      },
    });
    const selector = new WorkflowSelectorImpl(deps);
    const r = await selector.select(
      mkBase({ active_procedure_execution_id: 'exec_1' }),
      { label: 'transfer_intent', confidence: 0.85 },
    );
    expect(r.mode).toBe('switch');
    expect(r.workflow_id).toBeUndefined();
  });

  it('maps support domain to help_request intent', async () => {
    const deps = mkDeps({
      proceduresRepo: {
        findExecution: vi.fn().mockResolvedValue({
          execution_id: 'exec_1',
          procedure_id: 'support_ticket',
          procedure_domain: 'support',
          ttl_remaining_ms: 60_000,
        }),
      },
    });
    const selector = new WorkflowSelectorImpl(deps);
    const r = await selector.select(
      mkBase({ active_procedure_execution_id: 'exec_1' }),
      { label: 'help_request', confidence: 0.99 },
    );
    expect(r.mode).toBe('continue');
  });
});
