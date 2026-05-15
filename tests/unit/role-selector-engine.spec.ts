/**
 * P6 Task 8 — Role Selector Engine tests.
 *
 * Mockamos suggesters, policy decider e repo. Verificamos:
 *  - Resolução de conflitos entre sugestores (determinístico vence).
 *  - candidates[] e conflicts[] corretamente populados no record().
 *  - suggested_by reflete a origem do candidato vencedor (ou 'none').
 *  - switch_count_in_conversation incrementa em SWITCH.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SuggestedBy,
  DecidedBy,
  RoleDecisionAction,
  RoleSelectorStrength,
  SwitchBehavior,
} from '@/types/enums.js';
import type { Role, ChannelPolicy } from '@/db/schema.js';
import type { RoleCandidate } from '@/cognition/role-selector/types.js';

const {
  detSuggestMock,
  llmSuggestMock,
  decidePolicyMock,
  recordMock,
  countSwitchesMock,
} = vi.hoisted(() => ({
  detSuggestMock: vi.fn(),
  llmSuggestMock: vi.fn(),
  decidePolicyMock: vi.fn(),
  recordMock: vi.fn(),
  countSwitchesMock: vi.fn(),
}));

vi.mock('@/cognition/role-selector/deterministic-classifier.js', () => ({
  deterministicSuggester: { suggest: detSuggestMock },
}));

vi.mock('@/cognition/role-selector/llm-suggester.js', () => ({
  llmSuggester: { suggest: llmSuggestMock },
}));

vi.mock('@/cognition/role-selector/policy-decider.js', () => ({
  decidePolicy: decidePolicyMock,
}));

vi.mock('@/db/repositories.js', () => ({
  roleSelectorDecisionsRepo: {
    record: recordMock,
    countSwitchesInConversation: countSwitchesMock,
  },
}));

import { selectRole } from '@/cognition/role-selector/engine.js';

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

function makePolicy(): ChannelPolicy {
  return {
    id: 'pol-1',
    tenant_id: 'default',
    agent_id: 'default',
    channel_id: 'chan-1',
    default_role_id: 'role-default',
    switch_behavior: SwitchBehavior.FREE_WITH_TRIGGER,
    announce_mode: 'affects_user',
    by_context_guards: {},
    allowed_role_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
  } as ChannelPolicy;
}

function makeCandidate(overrides: Partial<RoleCandidate>): RoleCandidate {
  return {
    role_id: 'role-suporte',
    role_key: 'suporte',
    confidence: 0.8,
    strength: RoleSelectorStrength.STRONG,
    suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
    reason: 'mock',
    ...overrides,
  };
}

const defaultRole = makeRole('default', 'role-default');
const suporteRole = makeRole('suporte', 'role-suporte');
const comercialRole = makeRole('comercial', 'role-comercial');

function makeInput(opts: { conversa_id?: string } = {}) {
  return {
    inbound_text: 'mensagem',
    current_role: defaultRole,
    available_roles: [defaultRole, suporteRole, comercialRole],
    policy: makePolicy(),
    conversa_id: opts.conversa_id,
    channel_id: 'chan-1',
    turno_id: 'turno-1',
  };
}

beforeEach(() => {
  detSuggestMock.mockReset();
  llmSuggestMock.mockReset();
  decidePolicyMock.mockReset();
  recordMock.mockReset();
  countSwitchesMock.mockReset();
  recordMock.mockResolvedValue({ id: 'dec-1' });
  countSwitchesMock.mockResolvedValue(0);
});

describe('selectRole — orquestrador', () => {
  it('ambos suggesters concordam → 1 candidate, sem conflito, suggested_by=deterministic', async () => {
    const candidate = makeCandidate({ suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER });
    const llmCandidate = makeCandidate({
      suggested_by: SuggestedBy.LLM_CLASSIFIER,
      reason: 'llm match',
    });
    detSuggestMock.mockResolvedValue(candidate);
    llmSuggestMock.mockResolvedValue(llmCandidate);
    decidePolicyMock.mockResolvedValue({
      decided_role: suporteRole,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'agreed',
    });

    await selectRole(makeInput());

    expect(recordMock).toHaveBeenCalledTimes(1);
    const payload = recordMock.mock.calls[0]![0] as {
      candidates: unknown[];
      conflicts: unknown[];
      suggested_by: SuggestedBy;
    };
    expect(payload.candidates).toHaveLength(2); // both suggesters produced one
    expect(payload.conflicts).toEqual([]);
    expect(payload.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
  });

  it('suggesters discordam → conflicts tem 1 entrada, determinístico vence', async () => {
    const detCandidate = makeCandidate({
      role_id: 'role-suporte',
      role_key: 'suporte',
      suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
    });
    const llmCandidate = makeCandidate({
      role_id: 'role-comercial',
      role_key: 'comercial',
      suggested_by: SuggestedBy.LLM_CLASSIFIER,
    });
    detSuggestMock.mockResolvedValue(detCandidate);
    llmSuggestMock.mockResolvedValue(llmCandidate);
    decidePolicyMock.mockResolvedValue({
      decided_role: suporteRole,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'det wins',
    });

    await selectRole(makeInput());

    const payload = recordMock.mock.calls[0]![0] as {
      conflicts: Array<{ a: string; b: string; reason: string }>;
      suggested_by: SuggestedBy;
      suggested_role_id?: string;
    };
    expect(payload.conflicts).toHaveLength(1);
    expect(payload.conflicts[0]).toEqual({
      a: 'suporte',
      b: 'comercial',
      reason: 'suggesters_disagree',
    });
    expect(payload.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
    expect(payload.suggested_role_id).toBe('role-suporte');
    // policy decider deve ter recebido o determinístico
    const decideArg = decidePolicyMock.mock.calls[0]![0] as { candidate: RoleCandidate };
    expect(decideArg.candidate.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
  });

  it('apenas LLM sugere (determinístico null) → suggested_by=llm_classifier', async () => {
    const llmCandidate = makeCandidate({
      suggested_by: SuggestedBy.LLM_CLASSIFIER,
      reason: 'llm only',
    });
    detSuggestMock.mockResolvedValue(null);
    llmSuggestMock.mockResolvedValue(llmCandidate);
    decidePolicyMock.mockResolvedValue({
      decided_role: suporteRole,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'llm only',
    });

    await selectRole(makeInput());

    const payload = recordMock.mock.calls[0]![0] as {
      candidates: unknown[];
      conflicts: unknown[];
      suggested_by: SuggestedBy;
    };
    expect(payload.candidates).toHaveLength(1);
    expect(payload.conflicts).toEqual([]);
    expect(payload.suggested_by).toBe(SuggestedBy.LLM_CLASSIFIER);
  });

  it('apenas determinístico sugere → suggested_by=deterministic_classifier', async () => {
    const detCandidate = makeCandidate({
      suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
      reason: 'regex hit',
    });
    detSuggestMock.mockResolvedValue(detCandidate);
    llmSuggestMock.mockResolvedValue(null);
    decidePolicyMock.mockResolvedValue({
      decided_role: suporteRole,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'det only',
    });

    await selectRole(makeInput());

    const payload = recordMock.mock.calls[0]![0] as {
      candidates: unknown[];
      conflicts: unknown[];
      suggested_by: SuggestedBy;
    };
    expect(payload.candidates).toHaveLength(1);
    expect(payload.conflicts).toEqual([]);
    expect(payload.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
  });

  it('nenhum suggester sugere → candidate null → keep_current, suggested_by=none', async () => {
    detSuggestMock.mockResolvedValue(null);
    llmSuggestMock.mockResolvedValue(null);
    decidePolicyMock.mockResolvedValue({
      decided_role: defaultRole,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_DEFAULT,
      reason: 'no candidate',
    });

    const out = await selectRole(makeInput());

    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    const payload = recordMock.mock.calls[0]![0] as {
      candidates: unknown[];
      conflicts: unknown[];
      suggested_by: SuggestedBy;
      suggested_role_id?: string;
      suggested_strength?: RoleSelectorStrength;
      suggested_confidence?: number;
    };
    expect(payload.candidates).toEqual([]);
    expect(payload.conflicts).toEqual([]);
    expect(payload.suggested_by).toBe(SuggestedBy.NONE);
    expect(payload.suggested_role_id).toBeUndefined();
    expect(payload.suggested_strength).toBeUndefined();
    expect(payload.suggested_confidence).toBeUndefined();
    // policy_decider chamado com candidate=null
    const decideArg = decidePolicyMock.mock.calls[0]![0] as { candidate: RoleCandidate | null };
    expect(decideArg.candidate).toBeNull();
  });

  it('SWITCH → switch_count_in_conversation = baseCount + 1', async () => {
    countSwitchesMock.mockResolvedValue(2); // baseCount=2
    const candidate = makeCandidate({ suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER });
    detSuggestMock.mockResolvedValue(candidate);
    llmSuggestMock.mockResolvedValue(null);
    decidePolicyMock.mockResolvedValue({
      decided_role: suporteRole,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'switch',
    });

    await selectRole(makeInput({ conversa_id: 'conv-1' }));

    const payload = recordMock.mock.calls[0]![0] as {
      switch_count_in_conversation: number;
    };
    expect(payload.switch_count_in_conversation).toBe(3); // 2 + 1
    expect(countSwitchesMock).toHaveBeenCalledWith('conv-1');
  });

  // [P88-H4] Locked policies skip suggesters entirely (hot-path waste).
  it('LOCKED short-circuit → suggesters NOT called, audit records keep_current', async () => {
    const lockedInput = {
      ...makeInput({ conversa_id: 'conv-locked' }),
      policy: { ...makePolicy(), switch_behavior: SwitchBehavior.LOCKED },
    };

    const out = await selectRole(lockedInput);

    expect(detSuggestMock).not.toHaveBeenCalled();
    expect(llmSuggestMock).not.toHaveBeenCalled();
    expect(decidePolicyMock).not.toHaveBeenCalled();
    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_role.id).toBe('role-default');
    expect(recordMock).toHaveBeenCalledTimes(1);
    const payload = recordMock.mock.calls[0]![0] as {
      action: RoleDecisionAction;
      decided_by: DecidedBy;
      candidates: unknown[];
      suggested_by: SuggestedBy;
      reason: string;
    };
    expect(payload.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(payload.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(payload.candidates).toEqual([]);
    expect(payload.suggested_by).toBe(SuggestedBy.NONE);
    expect(payload.reason).toBe('policy locked');
  });

  // [P88-H3] When suggesters disagree, a strictly stronger LLM signal wins.
  it('suggesters discordam + LLM strength STRONG > det MEDIUM → LLM wins, conflict registra llm_stronger_signal', async () => {
    const detCandidate = makeCandidate({
      role_id: 'role-suporte',
      role_key: 'suporte',
      strength: RoleSelectorStrength.MEDIUM,
      confidence: 0.65,
      suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
    });
    const llmCandidate = makeCandidate({
      role_id: 'role-comercial',
      role_key: 'comercial',
      strength: RoleSelectorStrength.STRONG,
      confidence: 0.95,
      suggested_by: SuggestedBy.LLM_CLASSIFIER,
    });
    detSuggestMock.mockResolvedValue(detCandidate);
    llmSuggestMock.mockResolvedValue(llmCandidate);
    decidePolicyMock.mockResolvedValue({
      decided_role: comercialRole,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'llm stronger',
    });

    await selectRole(makeInput());

    const payload = recordMock.mock.calls[0]![0] as {
      conflicts: Array<{ a: string; b: string; reason: string }>;
      suggested_by: SuggestedBy;
      suggested_role_id?: string;
    };
    expect(payload.conflicts).toHaveLength(1);
    expect(payload.conflicts[0]!.reason).toBe('llm_stronger_signal');
    expect(payload.suggested_by).toBe(SuggestedBy.LLM_CLASSIFIER);
    expect(payload.suggested_role_id).toBe('role-comercial');
    // The policy decider received the LLM candidate (the stronger one).
    const decideArg = decidePolicyMock.mock.calls[0]![0] as { candidate: RoleCandidate };
    expect(decideArg.candidate.role_id).toBe('role-comercial');
  });
});
