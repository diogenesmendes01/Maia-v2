/**
 * P6 Task 6 — role-selector deterministic suggester tests.
 *
 * Cenários (sem mocks de SDK; suggester é puro regex):
 *  1. "tenho um problema com a fatura" + suporte disponível → suporte (medium).
 *     (primeira pattern a casar vence; "problema" bate em suporte antes de
 *     "fatura" em financeiro)
 *  2. "quero saber o preço" + comercial disponível → comercial (medium 0.7).
 *  3. "preciso do boleto" + financeiro disponível → financeiro (STRONG 0.85).
 *  4. Nenhum match → null.
 *  5. Match regex MAS role_key não está em available_roles → null (skip, no crash).
 *  6. suggested_by é sempre DETERMINISTIC_CLASSIFIER.
 */
import { describe, it, expect } from 'vitest';
import { deterministicSuggester } from '@/cognition/role-selector/deterministic-classifier.js';
import { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';
import type { Role, ChannelPolicy } from '@/db/schema.js';
import type { RoleSelectorInput } from '@/cognition/role-selector/types.js';

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
    switch_behavior: 'free_with_trigger',
    announce_mode: 'affects_user',
    by_context_guards: {
      min_confidence_to_switch: 0.7,
      cooldown_turns: 3,
      required_strength_delta: 0.2,
      max_switches_per_conversation: 3,
    },
    allowed_role_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
  } as ChannelPolicy;
}

function makeInput(
  text: string,
  available: Role[],
  current?: Role,
): RoleSelectorInput {
  return {
    inbound_text: text,
    current_role: current ?? available[0]!,
    available_roles: available,
    policy: makePolicy(),
  };
}

describe('deterministicSuggester', () => {
  it('"tenho um problema com a fatura" + suporte disponível → suporte (medium)', async () => {
    const def = makeRole('default', 'role-default');
    const suporte = makeRole('suporte', 'role-suporte');
    const financeiro = makeRole('financeiro', 'role-fin');

    const r = await deterministicSuggester.suggest(
      makeInput('tenho um problema com a fatura', [def, suporte, financeiro]),
    );

    // Primeira pattern (suporte) casa antes da financeiro
    expect(r).not.toBeNull();
    expect(r?.role_key).toBe('suporte');
    expect(r?.role_id).toBe('role-suporte');
    expect(r?.strength).toBe(RoleSelectorStrength.MEDIUM);
    expect(r?.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
  });

  it('"quero saber o preço" + comercial disponível → comercial (medium 0.7)', async () => {
    const def = makeRole('default', 'role-default');
    const comercial = makeRole('comercial', 'role-com');

    const r = await deterministicSuggester.suggest(
      makeInput('quero saber o preço', [def, comercial]),
    );

    expect(r).not.toBeNull();
    expect(r?.role_key).toBe('comercial');
    expect(r?.confidence).toBeCloseTo(0.7);
    expect(r?.strength).toBe(RoleSelectorStrength.MEDIUM);
    expect(r?.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
    expect(r?.reason).toContain('regex match');
  });

  it('"preciso do boleto" + financeiro disponível → financeiro (STRONG 0.85)', async () => {
    const def = makeRole('default', 'role-default');
    const financeiro = makeRole('financeiro', 'role-fin');

    const r = await deterministicSuggester.suggest(
      makeInput('preciso do boleto', [def, financeiro]),
    );

    expect(r).not.toBeNull();
    expect(r?.role_key).toBe('financeiro');
    expect(r?.confidence).toBeCloseTo(0.85);
    expect(r?.strength).toBe(RoleSelectorStrength.STRONG);
    expect(r?.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
  });

  it('nenhum match (texto genérico) → null', async () => {
    const def = makeRole('default', 'role-default');
    const suporte = makeRole('suporte', 'role-suporte');

    const r = await deterministicSuggester.suggest(
      makeInput('oi, bom dia, tudo bem?', [def, suporte]),
    );

    expect(r).toBeNull();
  });

  it('match regex MAS role_key fora de available_roles → null (skip, no crash)', async () => {
    // Texto bate em "financeiro" (boleto), mas só temos default disponível.
    const def = makeRole('default', 'role-default');

    const r = await deterministicSuggester.suggest(
      makeInput('preciso do boleto urgente', [def]),
    );

    expect(r).toBeNull();
  });

  it('todos suggested_by são DETERMINISTIC_CLASSIFIER (nunca llm)', async () => {
    const def = makeRole('default', 'role-default');
    const suporte = makeRole('suporte', 'role-suporte');
    const comercial = makeRole('comercial', 'role-com');
    const financeiro = makeRole('financeiro', 'role-fin');
    const available = [def, suporte, comercial, financeiro];

    const inputs = [
      'tenho um erro grave',
      'qual o orçamento?',
      'me envie o pix',
    ];

    for (const text of inputs) {
      const r = await deterministicSuggester.suggest(makeInput(text, available));
      expect(r?.suggested_by).toBe(SuggestedBy.DETERMINISTIC_CLASSIFIER);
    }
  });
});
