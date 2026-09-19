/**
 * P07 — o journal do Hermes grava com o tenant do BINDING, e a revogação
 * segue como recuperação quando o dono já perdeu a posse.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getCurrentAgent, getCurrentTenant } from '@/db/tenant-context.js';
import type { RunBindingV1 } from '@/integrations/hermes/run-binding.js';
import type { EngineTerminalProposalV1 } from '@/runtime/engines/contracts.js';
import {
  HERMES_SUPERVISOR_ACTOR_REF,
  createHermesJournalPort,
} from '@/runtime/engines/hermes-journal.js';

const run_id = randomUUID();
const binding = {
  run_id,
  turn_id: randomUUID(),
  origin_claim_token: randomUUID(),
  tenant_id: 'tenant-a',
  agent_id: 'agent-a',
} as unknown as RunBindingV1;

const proposal = {
  version: 1,
  run_id,
  request_key: randomUUID(),
  stop: { kind: 'reply', raw_text: 'oi' },
  iterations: 1,
  observed_tool_call_ids: [],
  usage: { input_tokens: null, output_tokens: null, cost_microusd: null, source: 'unavailable' },
} as EngineTerminalProposalV1;

describe('createHermesJournalPort', () => {
  it('recordTerminal roda no escopo do binding e passa o fence de origem', async () => {
    const seen: string[] = [];
    const repo = {
      recordTerminalProposal: vi.fn(async () => {
        seen.push(`${getCurrentTenant()}/${getCurrentAgent()}`);
        return { ok: true as const, run: {} as never };
      }),
      revokeRunCapabilities: vi.fn(),
    };
    const port = createHermesJournalPort(repo as never);
    expect(await port.recordTerminal({ binding, proposal })).toEqual({ ok: true });
    expect(seen).toEqual(['tenant-a/agent-a']);
    expect(repo.recordTerminalProposal).toHaveBeenCalledWith({
      run_id,
      turn_id: binding.turn_id,
      origin_claim_token: binding.origin_claim_token,
      proposal,
    });
  });

  it('recusa do journal vira { ok: false, reason }', async () => {
    const repo = {
      recordTerminalProposal: vi.fn(async () => ({ ok: false as const, reason: 'stale_claim' })),
      revokeRunCapabilities: vi.fn(),
    };
    const port = createHermesJournalPort(repo as never);
    expect(await port.recordTerminal({ binding, proposal })).toEqual({
      ok: false,
      reason: 'stale_claim',
    });
  });

  it('revoga como dono; se o dono perdeu a posse, revoga como recuperação', async () => {
    const actors: unknown[] = [];
    const repo = {
      recordTerminalProposal: vi.fn(),
      revokeRunCapabilities: vi.fn(async (input: { actor: unknown }) => {
        actors.push(input.actor);
        expect(getCurrentTenant()).toBe('tenant-a');
        return actors.length === 1
          ? { ok: false as const, reason: 'stale_claim' }
          : { ok: true as const, revoked_at: 'x', already: false };
      }),
    };
    await createHermesJournalPort(repo as never).revokeCapabilities({
      binding,
      reason_code: 'cancel:ownership_lost',
    });
    expect(actors).toEqual([
      { kind: 'turn_owner', origin_claim_token: binding.origin_claim_token },
      { kind: 'recovery', actor_ref: HERMES_SUPERVISOR_ACTOR_REF },
    ]);
  });

  it('run inexistente não tenta de novo', async () => {
    const repo = {
      recordTerminalProposal: vi.fn(),
      revokeRunCapabilities: vi.fn(async () => ({ ok: false as const, reason: 'not_found' })),
    };
    await createHermesJournalPort(repo as never).revokeCapabilities({ binding, reason_code: 'x' });
    expect(repo.revokeRunCapabilities).toHaveBeenCalledTimes(1);
  });
});
