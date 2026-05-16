/**
 * P9b — Agent Selector (no-op).
 *
 * Spec §7.4 + master §0.2 Non-goal: "agent-selector initializes as no-op via
 * channel_policies". Multi-agent selection is reserved for a future
 * `MULTI_AGENT_SELECTOR_V2` flag.
 *
 * Budget target: <10ms.
 */
import type {
  AgentSelector,
  ChannelPoliciesReader,
} from './types.js';
import type { BaseContextPacket } from '../context-packet/types.js';

export interface AgentSelectorDeps {
  channelPolicies: ChannelPoliciesReader;
}

export class AgentSelectorImpl implements AgentSelector {
  constructor(private deps: AgentSelectorDeps) {}

  async select(base: BaseContextPacket): Promise<{ agent_id: string }> {
    // NO-OP in P9b: single agent per channel via channel_policies.
    // Future: MULTI_AGENT_SELECTOR_V2 flag will enable per-turn selection.
    const policy = await this.deps.channelPolicies.getForChannel(
      base.tenant_id,
      base.channel.id,
    );
    return { agent_id: policy.default_agent_id };
  }
}
