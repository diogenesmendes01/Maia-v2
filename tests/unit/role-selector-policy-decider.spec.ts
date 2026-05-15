/**
 * P6 Task 7 — policy decider tests (determinístico, sem LLM).
 *
 * Criterios da spec:
 *  - #2: `decided_by` JAMAIS é `llm_classifier` — asserção em CADA teste.
 *  - #4: by_context com travas anti-osc previne >3 trocas/conversa (default).
 *
 * Mocks: o tracker depende de `roleSelectorDecisionsRepo.countSwitchesInConversation`.
 * Mockamos APENAS esse método; toda a lógica do decider+tracker é exercitada real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { countSwitchesMock } = vi.hoisted(() => ({
  countSwitchesMock: vi.fn<[conversa_id: string], Promise<number>>(),
}));

vi.mock('@/db/repositories.js', () => ({
  roleSelectorDecisionsRepo: {
    countSwitchesInConversation: countSwitchesMock,
  },
}));

import { decidePolicy } from '@/cognition/role-selector/policy-decider.js';
import {
  DecidedBy,
  RoleDecisionAction,
  SwitchBehavior,
  SuggestedBy,
  RoleSelectorStrength,
} from '@/types/enums.js';
import type { Role, ChannelPolicy } from '@/db/schema.js';
import type { RoleSelectorInput, RoleCandidate } from '@/cognition/role-selector/types.js';

beforeEach(() => {
  countSwitchesMock.mockReset();
});

function makeRole(role_key: string, id: string): Role {
  return {
    id,
    tenant_id: 'default',
    agent_id: 'default',
    role_key,
    display_name: role_key,
    description: null,
    prompt_addendum: null,
    active: true,
    is_default: false,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  } as Role;
}

function makePolicy(
  switch_behavior: SwitchBehavior,
  guards: Partial<{
    min_confidence_to_switch: number;
    cooldown_turns: number;
    required_strength_delta: number;
    max_switches_per_conversation: number;
  }> = {},
): ChannelPolicy {
  return {
    id: 'pol-1',
    tenant_id: 'default',
    agent_id: 'default',
    channel_id: 'chan-1',
    default_role_id: 'role-default',
    switch_behavior,
    announce_mode: 'affects_user',
    by_context_guards: {
      min_confidence_to_switch: 0.7,
      cooldown_turns: 3,
      required_strength_delta: 0.2,
      max_switches_per_conversation: 3,
      ...guards,
    },
    allowed_role_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
  } as ChannelPolicy;
}

function makeInput(
  switch_behavior: SwitchBehavior,
  opts: {
    current?: Role;
    available?: Role[];
    conversa_id?: string;
    guards?: Parameters<typeof makePolicy>[1];
  } = {},
): RoleSelectorInput {
  const def = opts.current ?? makeRole('default', 'role-default');
  const suporte = makeRole('suporte', 'role-suporte');
  const comercial = makeRole('comercial', 'role-comercial');
  return {
    inbound_text: 'mensagem',
    current_role: def,
    available_roles: opts.available ?? [def, suporte, comercial],
    policy: makePolicy(switch_behavior, opts.guards),
    conversa_id: opts.conversa_id,
  };
}

function makeCandidate(overrides: Partial<RoleCandidate> = {}): RoleCandidate {
  return {
    role_id: 'role-suporte',
    role_key: 'suporte',
    confidence: 0.85,
    strength: RoleSelectorStrength.STRONG,
    suggested_by: SuggestedBy.LLM_CLASSIFIER,
    reason: 'mock',
    ...overrides,
  };
}

/**
 * Helper invariant: decided_by NUNCA pode ser 'llm_classifier' (criterio #2).
 * Chamado em CADA teste — não há atalho.
 */
function assertNotLlmClassifier(decided_by: DecidedBy): void {
  expect(decided_by).not.toBe('llm_classifier');
}

describe('decidePolicy — LOCKED', () => {
  it('LOCKED + candidate strong → keep_current, decided_by=policy_rule', async () => {
    const input = makeInput(SwitchBehavior.LOCKED);
    const candidate = makeCandidate();
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(out.decided_role.id).toBe('role-default');
    expect(out.reason).toBe('policy locked');
    assertNotLlmClassifier(out.decided_by);
  });
});

describe('decidePolicy — PREFER_HANDOFF', () => {
  it('PREFER_HANDOFF + candidate diferente → handoff, decided_by=policy_rule', async () => {
    const input = makeInput(SwitchBehavior.PREFER_HANDOFF);
    const candidate = makeCandidate({ role_id: 'role-suporte', role_key: 'suporte' });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.HANDOFF);
    expect(out.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(out.decided_role.id).toBe('role-default'); // role atual mantido (sinaliza handoff)
    expect(out.reason).toContain('prefer_handoff');
    assertNotLlmClassifier(out.decided_by);
  });
});

describe('decidePolicy — FREE_WITH_TRIGGER', () => {
  it('strength=weak → keep_current, decided_by=policy_default', async () => {
    const input = makeInput(SwitchBehavior.FREE_WITH_TRIGGER);
    const candidate = makeCandidate({
      strength: RoleSelectorStrength.WEAK,
      confidence: 0.3,
    });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_by).toBe(DecidedBy.POLICY_DEFAULT);
    expect(out.reason).toBe('weak signal, no trigger');
    assertNotLlmClassifier(out.decided_by);
  });

  it('strength=medium → switch, decided_by=policy_rule', async () => {
    const input = makeInput(SwitchBehavior.FREE_WITH_TRIGGER);
    const candidate = makeCandidate({
      strength: RoleSelectorStrength.MEDIUM,
      confidence: 0.6,
    });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.SWITCH);
    expect(out.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(out.decided_role.id).toBe('role-suporte');
    expect(out.reason).toContain('strength=medium');
    assertNotLlmClassifier(out.decided_by);
  });

  it('strength=strong → switch, decided_by=policy_rule', async () => {
    const input = makeInput(SwitchBehavior.FREE_WITH_TRIGGER);
    const candidate = makeCandidate({
      strength: RoleSelectorStrength.STRONG,
      confidence: 0.9,
    });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.SWITCH);
    expect(out.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(out.decided_role.id).toBe('role-suporte');
    expect(out.reason).toContain('strength=strong');
    assertNotLlmClassifier(out.decided_by);
  });
});

describe('decidePolicy — BY_CONTEXT (travas anti-osc)', () => {
  it('confidence < min → keep_current, decided_by=policy_rule', async () => {
    const input = makeInput(SwitchBehavior.BY_CONTEXT, { conversa_id: 'conv-1' });
    const candidate = makeCandidate({ confidence: 0.5 }); // < 0.7 default
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(out.reason).toContain('< min');
    expect(countSwitchesMock).not.toHaveBeenCalled(); // não chega ao tracker
    assertNotLlmClassifier(out.decided_by);
  });

  it('confidence >= min + osc count < max → switch, decided_by=policy_rule', async () => {
    countSwitchesMock.mockResolvedValueOnce(1); // abaixo do default max=3
    const input = makeInput(SwitchBehavior.BY_CONTEXT, { conversa_id: 'conv-1' });
    const candidate = makeCandidate({ confidence: 0.85 });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.SWITCH);
    expect(out.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(out.decided_role.id).toBe('role-suporte');
    expect(out.reason).toContain('by_context approved');
    expect(countSwitchesMock).toHaveBeenCalledWith('conv-1');
    assertNotLlmClassifier(out.decided_by);
  });

  it('confidence >= min + osc count >= max → fallback, decided_by=fallback_rule (ANTI-OSC)', async () => {
    countSwitchesMock.mockResolvedValueOnce(3); // == max default
    const input = makeInput(SwitchBehavior.BY_CONTEXT, { conversa_id: 'conv-1' });
    const candidate = makeCandidate({ confidence: 0.9 });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.FALLBACK);
    expect(out.decided_by).toBe(DecidedBy.FALLBACK_RULE);
    expect(out.decided_role.id).toBe('role-default'); // mantém role atual
    expect(out.reason).toContain('max_switches_per_conversation reached');
    expect(out.reason).toContain('3/3');
    assertNotLlmClassifier(out.decided_by);
  });

  it('custom guards (min_confidence=0.9; candidate@0.85) → keep_current', async () => {
    const input = makeInput(SwitchBehavior.BY_CONTEXT, {
      conversa_id: 'conv-1',
      guards: { min_confidence_to_switch: 0.9 },
    });
    const candidate = makeCandidate({ confidence: 0.85 });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(out.reason).toContain('< min 0.9');
    assertNotLlmClassifier(out.decided_by);
  });
});

describe('decidePolicy — sem candidate / candidate == atual', () => {
  it('no candidate (null) → keep_current, decided_by=policy_default', async () => {
    const input = makeInput(SwitchBehavior.FREE_WITH_TRIGGER);
    const out = await decidePolicy({ input, candidate: null });

    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_by).toBe(DecidedBy.POLICY_DEFAULT);
    expect(out.reason).toBe('no candidate');
    assertNotLlmClassifier(out.decided_by);
  });

  it('candidate equals current → keep_current, decided_by=policy_default', async () => {
    const input = makeInput(SwitchBehavior.FREE_WITH_TRIGGER);
    const candidate = makeCandidate({
      role_id: 'role-default',
      role_key: 'default',
    });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_by).toBe(DecidedBy.POLICY_DEFAULT);
    expect(out.reason).toBe('candidate equals current');
    assertNotLlmClassifier(out.decided_by);
  });
});

describe('decidePolicy — edge cases', () => {
  it('unknown switch_behavior → fallback, decided_by=fallback_rule', async () => {
    const input = makeInput(SwitchBehavior.FREE_WITH_TRIGGER);
    // sobrescreve forçadamente um valor inválido
    (input.policy as { switch_behavior: string }).switch_behavior = 'bogus_behavior';
    const candidate = makeCandidate();
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.FALLBACK);
    expect(out.decided_by).toBe(DecidedBy.FALLBACK_RULE);
    expect(out.reason).toContain('unknown switch_behavior');
    assertNotLlmClassifier(out.decided_by);
  });

  it('FREE_WITH_TRIGGER + candidate role_id fora de available_roles → fallback', async () => {
    const def = makeRole('default', 'role-default');
    const input = makeInput(SwitchBehavior.FREE_WITH_TRIGGER, {
      current: def,
      available: [def], // suporte NÃO está em available
    });
    const candidate = makeCandidate({
      role_id: 'role-suporte',
      strength: RoleSelectorStrength.STRONG,
    });
    const out = await decidePolicy({ input, candidate });

    expect(out.action).toBe(RoleDecisionAction.FALLBACK);
    expect(out.decided_by).toBe(DecidedBy.FALLBACK_RULE);
    expect(out.reason).toContain('not in available_roles');
    assertNotLlmClassifier(out.decided_by);
  });

  it('EXCLUSIVITY — decided_by NUNCA é llm_classifier em TODOS os caminhos', async () => {
    // Esta meta-asserção roda em cima dos 4 switch_behaviors + null candidate.
    const def = makeRole('default', 'role-default');
    const suporte = makeRole('suporte', 'role-suporte');

    countSwitchesMock.mockResolvedValue(0); // não bloqueia osc

    const scenarios: Array<{ behavior: SwitchBehavior; candidate: RoleCandidate | null }> = [
      { behavior: SwitchBehavior.LOCKED, candidate: makeCandidate() },
      { behavior: SwitchBehavior.PREFER_HANDOFF, candidate: makeCandidate() },
      {
        behavior: SwitchBehavior.FREE_WITH_TRIGGER,
        candidate: makeCandidate({ strength: RoleSelectorStrength.WEAK, confidence: 0.3 }),
      },
      {
        behavior: SwitchBehavior.FREE_WITH_TRIGGER,
        candidate: makeCandidate({ strength: RoleSelectorStrength.STRONG }),
      },
      {
        behavior: SwitchBehavior.BY_CONTEXT,
        candidate: makeCandidate({ confidence: 0.85 }),
      },
      { behavior: SwitchBehavior.BY_CONTEXT, candidate: null },
    ];

    for (const sc of scenarios) {
      const input: RoleSelectorInput = {
        inbound_text: 'x',
        current_role: def,
        available_roles: [def, suporte],
        policy: makePolicy(sc.behavior),
        conversa_id: 'conv-x',
      };
      const out = await decidePolicy({ input, candidate: sc.candidate });
      expect(out.decided_by).not.toBe('llm_classifier');
    }
  });
});
