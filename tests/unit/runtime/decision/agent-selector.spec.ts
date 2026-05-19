import { describe, it, expect, vi } from 'vitest';
import {
  AgentSelectorImpl,
  type AgentSelectorDeps,
} from '@/runtime/decision/agent-selector.ts';
import type { ChannelPoliciesReader } from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'agent_overridden_or_resolved',
    channel: { id: 'ch_123', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
    ...overrides,
  };
}

function mkDeps(default_agent_id: string): AgentSelectorDeps {
  const channelPolicies: ChannelPoliciesReader = {
    getForChannel: vi.fn().mockResolvedValue({
      channel_id: 'ch_123',
      tenant_id: 'tn1',
      default_agent_id,
    }),
  };
  return { channelPolicies };
}

describe('P9b — AgentSelector (no-op)', () => {
  it('returns default_agent_id from channel_policies', async () => {
    const deps = mkDeps('agent_default_1');
    const selector = new AgentSelectorImpl(deps);
    const r = await selector.select(mkBase());
    expect(r.agent_id).toBe('agent_default_1');
    expect(deps.channelPolicies.getForChannel).toHaveBeenCalledWith(
      'tn1',
      'ch_123',
    );
  });

  it('uses tenant_id and channel.id from base packet', async () => {
    const deps = mkDeps('agent_x');
    const selector = new AgentSelectorImpl(deps);
    await selector.select(
      mkBase({
        tenant_id: 'tn_other',
        channel: { id: 'ch_other', kind: 'telegram', is_locked_down: false },
      }),
    );
    expect(deps.channelPolicies.getForChannel).toHaveBeenCalledWith(
      'tn_other',
      'ch_other',
    );
  });

  it('does not consider intent / skill / actor (no-op behaviour)', async () => {
    const deps = mkDeps('agent_z');
    const selector = new AgentSelectorImpl(deps);
    // Multiple calls with different bases but same channel → same agent.
    const r1 = await selector.select(mkBase());
    const r2 = await selector.select(
      mkBase({ actor: { id: 'a_other', is_authenticated: false } }),
    );
    expect(r1.agent_id).toBe(r2.agent_id);
  });
});
