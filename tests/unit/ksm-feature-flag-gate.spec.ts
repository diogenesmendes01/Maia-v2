/**
 * P10a (Codex review #104 high) — `propose_*` tools are gated by the
 * runtime feature flag so a kill switch takes effect without a
 * redeploy.
 *
 * Before this fix, the registry checked the module-level constant
 * FEATURE_KNOWLEDGE_STATE_MACHINE_V1 which freezes at import time;
 * killing the flag at runtime didn't disable the handlers. Now both
 * the schema exposure path (`getToolSchemas`) and the dispatcher
 * (`isToolEnabled` + dispatchTool short-circuit) consult the
 * `featureFlags.isEnabled()` singleton.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagName } from '@/types/enums.js';

// Stand-in featureFlags whose isEnabled value the test owns. We mock
// the whole module so getToolSchemas + isToolEnabled both read the
// same toggle.
const flagState = { ksmEnabled: true };

vi.mock('@/config/feature-flags.js', async () => {
  const actual = await vi.importActual<
    typeof import('@/config/feature-flags.js')
  >('@/config/feature-flags.js');
  return {
    ...actual,
    FEATURE_KNOWLEDGE_STATE_MACHINE_V1: true,
    featureFlags: {
      ...actual.featureFlags,
      isEnabled: (name: FeatureFlagName) =>
        name === FeatureFlagName.KNOWLEDGE_STATE_MACHINE_V1
          ? flagState.ksmEnabled
          : true,
      override: () => undefined,
      killSwitch: () => undefined,
      unkillSwitch: () => undefined,
      reset: () => undefined,
    },
  };
});

import { isToolEnabled, getToolSchemas } from '@/tools/_registry.js';

afterEach(() => {
  // Reset between tests so order-independence holds.
  flagState.ksmEnabled = true;
  vi.clearAllMocks();
});

describe('P10a propose_* tools are runtime-flag-gated', () => {
  it('isToolEnabled returns true for propose_fact when flag is on', () => {
    flagState.ksmEnabled = true;
    expect(isToolEnabled('propose_fact')).toBe(true);
    expect(isToolEnabled('propose_rule')).toBe(true);
    expect(isToolEnabled('propose_memory')).toBe(true);
    expect(isToolEnabled('propose_hint')).toBe(true);
  });

  it('isToolEnabled returns false for propose_* when flag is off', () => {
    flagState.ksmEnabled = false;
    expect(isToolEnabled('propose_fact')).toBe(false);
    expect(isToolEnabled('propose_rule')).toBe(false);
    expect(isToolEnabled('propose_memory')).toBe(false);
    expect(isToolEnabled('propose_hint')).toBe(false);
  });

  it('isToolEnabled returns true for non-KSM tools regardless of flag', () => {
    flagState.ksmEnabled = false;
    expect(isToolEnabled('query_balance')).toBe(true);
    expect(isToolEnabled('register_transaction')).toBe(true);
    expect(isToolEnabled('recall_memory')).toBe(true);
    // unknown tool also reports enabled (the dispatcher already returns
    // 'unknown_tool' for that case)
    expect(isToolEnabled('this_does_not_exist')).toBe(true);
  });

  it('getToolSchemas hides propose_* when flag is off (owner profile)', () => {
    flagState.ksmEnabled = false;
    // Owner profile = '*' → bypasses per-action filter
    const ownerScope = new Map();
    ownerScope.set('e-1', {
      profile: { id: 'owner', acoes: ['*'] },
      effective_limits: { valor_max: 999999 },
    });
    const schemas = getToolSchemas(ownerScope) as Array<{ name: string }>;
    const names = schemas.map((s) => s.name);
    expect(names).not.toContain('propose_fact');
    expect(names).not.toContain('propose_rule');
    expect(names).not.toContain('propose_memory');
    expect(names).not.toContain('propose_hint');
  });

  it('getToolSchemas exposes propose_* when flag is on', () => {
    flagState.ksmEnabled = true;
    const ownerScope = new Map();
    ownerScope.set('e-1', {
      profile: { id: 'owner', acoes: ['*'] },
      effective_limits: { valor_max: 999999 },
    });
    const schemas = getToolSchemas(ownerScope) as Array<{ name: string }>;
    const names = schemas.map((s) => s.name);
    expect(names).toContain('propose_fact');
    expect(names).toContain('propose_rule');
    expect(names).toContain('propose_memory');
    expect(names).toContain('propose_hint');
  });
});

describe('P10a dispatcher rejects propose_* when feature flag is off', () => {
  it('dispatchTool returns tool_disabled error when KSM flag is off', async () => {
    flagState.ksmEnabled = false;
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const fakeCtx = {
      pessoa: { id: 'p1' } as unknown as import('@/db/schema.js').Pessoa,
      scope: { entidades: ['e-1'], byEntity: new Map() },
      conversa: { id: 'c1' } as unknown as import('@/db/schema.js').Conversa,
      mensagem_id: 'm1',
      request_id: 'r1',
    };
    const result = (await dispatchTool({
      tool: 'propose_fact',
      args: {
        escopo: 'global',
        chave: 'x',
        valor: {},
        texto: 'hello',
        fonte: 'aprendido',
        confianca: 0.7,
      },
      ctx: fakeCtx,
    })) as { error?: string; details?: Record<string, unknown> };
    expect(result.error).toBe('tool_disabled');
    expect(result.details?.['reason']).toBe('feature_flag_off');
    expect(result.details?.['tool']).toBe('propose_fact');
  });
});
