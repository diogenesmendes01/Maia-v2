/**
 * P6 Task 6 — role-selector LLM suggester (Haiku 4.5) tests.
 *
 * Mock pattern: vi.hoisted + vi.mock('@anthropic-ai/sdk') (mesmo shape do
 * capability-proposer P5). runCognitiveModule é executado real (não-mock)
 * para validar fallback=null em Anthropic throw.
 *
 * Cenários (criterio #1 da spec: LLM apenas sugere):
 *  1. Anthropic ok com {role_key, confidence, reason} → candidate com
 *     suggested_by='llm_classifier'.
 *  2. role_key fora de available_roles → null (proteção contra alucinação).
 *  3. Texto unparseable (sem JSON) → null.
 *  4. Anthropic throws → runCognitiveModule fallback=null → null.
 *  5. Mapping confidence → strength: 0.3=weak, 0.6=medium, 0.9=strong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { anthropicCreateMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  }));
  return { default: Anthropic };
});

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { llmSuggester } from '@/cognition/role-selector/llm-suggester.js';
import { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';
import type { Role, ChannelPolicy } from '@/db/schema.js';
import type { RoleSelectorInput } from '@/cognition/role-selector/types.js';

beforeEach(() => {
  anthropicCreateMock.mockReset();
});

function makeRole(role_key: string, id: string, opts: { display_name?: string } = {}): Role {
  return {
    id,
    tenant_id: 'default',
    agent_id: 'default',
    role_key,
    display_name: opts.display_name ?? role_key,
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

function makeInput(overrides: Partial<RoleSelectorInput> = {}): RoleSelectorInput {
  const current = makeRole('default', 'role-default');
  const suporte = makeRole('suporte', 'role-suporte', { display_name: 'Suporte' });
  const comercial = makeRole('comercial', 'role-comercial', { display_name: 'Comercial' });
  return {
    inbound_text: 'mensagem',
    current_role: current,
    available_roles: [current, suporte, comercial],
    policy: makePolicy(),
    ...overrides,
  };
}

describe('llmSuggester', () => {
  it('Anthropic ok → retorna candidate com suggested_by=llm_classifier', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '{"role_key":"suporte","confidence":0.85,"reason":"usuário relatou erro"}',
        },
      ],
    });

    const r = await llmSuggester.suggest(makeInput({ inbound_text: 'estou com problema' }));

    expect(r).not.toBeNull();
    expect(r?.role_key).toBe('suporte');
    expect(r?.role_id).toBe('role-suporte');
    expect(r?.confidence).toBeCloseTo(0.85);
    expect(r?.strength).toBe(RoleSelectorStrength.STRONG);
    expect(r?.suggested_by).toBe(SuggestedBy.LLM_CLASSIFIER);
    expect(r?.reason).toBe('usuário relatou erro');
  });

  it('role_key fora de available_roles → null', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '{"role_key":"financeiro","confidence":0.9,"reason":"x"}',
        },
      ],
    });

    const r = await llmSuggester.suggest(makeInput());

    expect(r).toBeNull();
  });

  it('texto unparseable (sem JSON) → null', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sem json aqui, desculpe' }],
    });

    const r = await llmSuggester.suggest(makeInput());

    expect(r).toBeNull();
  });

  it('Anthropic throws → runCognitiveModule fallback=null → null', async () => {
    anthropicCreateMock.mockRejectedValueOnce(new Error('boom'));

    const r = await llmSuggester.suggest(makeInput());

    expect(r).toBeNull();
  });

  it('mapping confidence → strength: 0.3=weak, 0.6=medium, 0.9=strong', async () => {
    // confidence 0.3 → weak
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"role_key":"suporte","confidence":0.3,"reason":"w"}' },
      ],
    });
    const weak = await llmSuggester.suggest(makeInput());
    expect(weak?.strength).toBe(RoleSelectorStrength.WEAK);
    expect(weak?.confidence).toBeCloseTo(0.3);

    // confidence 0.6 → medium
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"role_key":"suporte","confidence":0.6,"reason":"m"}' },
      ],
    });
    const medium = await llmSuggester.suggest(makeInput());
    expect(medium?.strength).toBe(RoleSelectorStrength.MEDIUM);
    expect(medium?.confidence).toBeCloseTo(0.6);

    // confidence 0.9 → strong
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"role_key":"suporte","confidence":0.9,"reason":"s"}' },
      ],
    });
    const strong = await llmSuggester.suggest(makeInput());
    expect(strong?.strength).toBe(RoleSelectorStrength.STRONG);
    expect(strong?.confidence).toBeCloseTo(0.9);
  });

  it('JSON malformado (parse fail) → null sem crash', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"role_key":"suporte","confidence":0.5,' /* trunc */ },
      ],
    });

    const r = await llmSuggester.suggest(makeInput());

    expect(r).toBeNull();
  });
});
