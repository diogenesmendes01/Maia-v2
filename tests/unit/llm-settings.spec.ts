import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * PR #188 (issue #183) Codex round 1, [high]: storage moved from
 * `agent_facts` (per-tenant + per-agent) to `global_settings`
 * (process-wide). These tests now exercise the new repo seam.
 */

type GlobalRow = { value: unknown; updated_at: Date; updated_by: string | null };

const globalByKey = new Map<string, GlobalRow>();

const globalSettingsRepoMock = {
  getByKey: vi.fn(async (key: string): Promise<GlobalRow | null> => {
    return globalByKey.get(key) ?? null;
  }),
  updateAtomic: vi.fn(
    async (input: {
      keys: ReadonlyArray<{ key: string; value: Record<string, unknown> }>;
      audit: { actor_id: string };
    }) => {
      const now = new Date();
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      let changed = 0;
      for (const entry of input.keys) {
        const lockedRow = globalByKey.get(entry.key) ?? null;
        before[entry.key] = lockedRow?.value ?? null;
        after[entry.key] = entry.value;
        if (JSON.stringify(lockedRow?.value ?? null) === JSON.stringify(entry.value)) {
          continue;
        }
        globalByKey.set(entry.key, {
          value: entry.value,
          updated_at: now,
          updated_by: input.audit.actor_id,
        });
        changed++;
      }
      if (changed === 0) {
        return { ok: false as const, reason: 'no_changes' as const, before };
      }
      return { ok: true as const, applied_at: now, before, after };
    },
  ),
};

vi.mock('../../src/db/repositories.js', () => ({
  globalSettingsRepo: globalSettingsRepoMock,
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    LLM_PROVIDER: 'openrouter',
    OPENROUTER_MODEL_MAIN: 'anthropic/claude-sonnet-4.6',
    OPENROUTER_MODEL_FAST: 'anthropic/claude-haiku-4.5',
    CLAUDE_MODEL_MAIN: 'claude-sonnet-4-6',
    CLAUDE_MODEL_FAST: 'claude-haiku-4-5-20251001',
  },
}));

beforeEach(() => {
  globalByKey.clear();
  globalSettingsRepoMock.getByKey.mockClear();
  globalSettingsRepoMock.updateAtomic.mockClear();
});

describe('llm-settings (global_settings storage)', () => {
  it('returns env default for main when no row set (provider=openrouter)', async () => {
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  it('returns env default for fast when no row set (provider=openrouter)', async () => {
    const { getCurrentFastModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentFastModel()).toBe('anthropic/claude-haiku-4.5');
  });

  it('reads from global_settings when the row exists', async () => {
    globalByKey.set('llm.model.main', {
      value: { model: 'openai/gpt-5' },
      updated_at: new Date(),
      updated_by: 'founder@example.com',
    });
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('openai/gpt-5');
  });

  it('round-trips: legacy setCurrentMainModel shim then getCurrentMainModel', async () => {
    const { setCurrentMainModel, getCurrentMainModel } = await import(
      '../../src/lib/llm-settings.js'
    );
    await setCurrentMainModel('openai/gpt-5');
    expect(await getCurrentMainModel()).toBe('openai/gpt-5');
  });

  it('round-trips: legacy setCurrentFastModel shim then getCurrentFastModel', async () => {
    const { setCurrentFastModel, getCurrentFastModel } = await import(
      '../../src/lib/llm-settings.js'
    );
    await setCurrentFastModel('deepseek/deepseek-r1');
    expect(await getCurrentFastModel()).toBe('deepseek/deepseek-r1');
  });

  it('falls back to env default if DB throws on read', async () => {
    globalSettingsRepoMock.getByKey.mockRejectedValueOnce(
      new Error('connection lost'),
    );
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  it('envDefaults returns the expected struct for openrouter provider', async () => {
    const { envDefaults } = await import('../../src/lib/llm-settings.js');
    expect(envDefaults()).toEqual({
      main: 'anthropic/claude-sonnet-4.6',
      fast: 'anthropic/claude-haiku-4.5',
      provider: 'openrouter',
    });
  });

  it('setGlobalLLMSettingsAtomic flips both keys and surfaces before/after', async () => {
    // Seed the "fast" row so we can prove before reflects what's stored.
    globalByKey.set('llm.model.fast', {
      value: { model: 'anthropic/claude-haiku-4.5' },
      updated_at: new Date(),
      updated_by: 'seed',
    });

    const { setGlobalLLMSettingsAtomic } = await import('../../src/lib/llm-settings.js');
    const res = await setGlobalLLMSettingsAtomic({
      main: 'openai/gpt-5',
      fast: 'x-ai/grok-4.1-fast',
      updated_by: 'founder@example.com',
      actor_role: 'founder',
      tenant_id: 'tenant-test',
      comment: 'Anthropic outage at 14:30 UTC',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.before).toEqual({
      main: null, // not previously set → null (router will map to env)
      fast: 'anthropic/claude-haiku-4.5',
    });
    expect(res.after).toEqual({
      main: 'openai/gpt-5',
      fast: 'x-ai/grok-4.1-fast',
    });
  });

  it('setGlobalLLMSettingsAtomic returns no_changes when nothing differs', async () => {
    globalByKey.set('llm.model.main', {
      value: { model: 'openai/gpt-5' },
      updated_at: new Date(),
      updated_by: 'seed',
    });
    globalByKey.set('llm.model.fast', {
      value: { model: 'openai/gpt-5' },
      updated_at: new Date(),
      updated_by: 'seed',
    });

    const { setGlobalLLMSettingsAtomic } = await import('../../src/lib/llm-settings.js');
    const res = await setGlobalLLMSettingsAtomic({
      main: 'openai/gpt-5',
      fast: 'openai/gpt-5',
      updated_by: 'founder@example.com',
      actor_role: 'founder',
      tenant_id: 'tenant-test',
      comment: 'no-op renew should be rejected',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('no_changes');
  });
});
