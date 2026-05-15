/**
 * P6 Task 8 — INVARIANTE de auditoria sempre-registrada.
 *
 * Spec §9 P6 done criterion #3: TODA chamada a `selectRole` produz exatamente
 * 1 row em `role_selector_decisions`, INDEPENDENTE da action (keep_current,
 * switch, handoff, fallback). Este arquivo prova essa invariante para os 3
 * caminhos principais: keep_current, switch, handoff. (fallback segue o mesmo
 * caminho de switch/handoff — vai pelo mesmo recordMock.)
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

const defaultRole = makeRole('default', 'role-default');
const suporteRole = makeRole('suporte', 'role-suporte');

function makeInput() {
  return {
    inbound_text: 'mensagem',
    current_role: defaultRole,
    available_roles: [defaultRole, suporteRole],
    policy: {
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
    } as ChannelPolicy,
    conversa_id: 'conv-1',
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
  // suggesters padrão: ambos sugerem o mesmo role (não influencia auditoria)
  detSuggestMock.mockResolvedValue({
    role_id: 'role-suporte',
    role_key: 'suporte',
    confidence: 0.8,
    strength: RoleSelectorStrength.STRONG,
    suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
    reason: 'mock',
  });
  llmSuggestMock.mockResolvedValue(null);
});

describe('INVARIANTE — auditoria SEMPRE registrada (1 row por chamada)', () => {
  it('action=keep_current → record chamado exatamente 1 vez', async () => {
    decidePolicyMock.mockResolvedValue({
      decided_role: defaultRole,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_DEFAULT,
      reason: 'kept',
    });

    await selectRole(makeInput());

    expect(recordMock).toHaveBeenCalledTimes(1);
    const payload = recordMock.mock.calls[0]![0] as { action: RoleDecisionAction };
    expect(payload.action).toBe(RoleDecisionAction.KEEP_CURRENT);
  });

  it('action=switch → record chamado exatamente 1 vez', async () => {
    decidePolicyMock.mockResolvedValue({
      decided_role: suporteRole,
      action: RoleDecisionAction.SWITCH,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'switched',
    });

    await selectRole(makeInput());

    expect(recordMock).toHaveBeenCalledTimes(1);
    const payload = recordMock.mock.calls[0]![0] as { action: RoleDecisionAction };
    expect(payload.action).toBe(RoleDecisionAction.SWITCH);
  });

  it('action=handoff → record chamado exatamente 1 vez', async () => {
    decidePolicyMock.mockResolvedValue({
      decided_role: defaultRole,
      action: RoleDecisionAction.HANDOFF,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'handed off',
    });

    await selectRole(makeInput());

    expect(recordMock).toHaveBeenCalledTimes(1);
    const payload = recordMock.mock.calls[0]![0] as { action: RoleDecisionAction };
    expect(payload.action).toBe(RoleDecisionAction.HANDOFF);
  });
});
