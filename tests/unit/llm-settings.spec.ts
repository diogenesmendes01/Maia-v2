import { describe, it, expect, beforeEach, vi } from 'vitest';

const factsByKey = new Map<string, { valor: unknown }>();
const factsRepoMock = {
  getByKey: vi.fn(async (escopo: string, chave: string) => {
    return factsByKey.get(`${escopo}|${chave}`) ?? null;
  }),
  upsert: vi.fn(async (input: { escopo: string; chave: string; valor: unknown }) => {
    factsByKey.set(`${input.escopo}|${input.chave}`, { valor: input.valor });
  }),
};

vi.mock('../../src/db/repositories.js', () => ({ factsRepo: factsRepoMock }));

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
  factsByKey.clear();
  factsRepoMock.getByKey.mockClear();
  factsRepoMock.upsert.mockClear();
});

describe('llm-settings', () => {
  it('returns env default for main when no fact set (provider=openrouter)', async () => {
    const { getCurrentMainModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentMainModel()).toBe('anthropic/claude-sonnet-4.6');
  });

  it('returns env default for fast when no fact set (provider=openrouter)', async () => {
    const { getCurrentFastModel } = await import('../../src/lib/llm-settings.js');
    expect(await getCurrentFastModel()).toBe('anthropic/claude-haiku-4.5');
  });

  it('round-trips: setCurrentMainModel then getCurrentMainModel', async () => {
    const { setCurrentMainModel, getCurrentMainModel } = await import(
      '../../src/lib/llm-settings.js'
    );
    await setCurrentMainModel('openai/gpt-5');
    expect(await getCurrentMainModel()).toBe('openai/gpt-5');
  });

  it('round-trips: setCurrentFastModel then getCurrentFastModel', async () => {
    const { setCurrentFastModel, getCurrentFastModel } = await import(
      '../../src/lib/llm-settings.js'
    );
    await setCurrentFastModel('deepseek/deepseek-r1');
    expect(await getCurrentFastModel()).toBe('deepseek/deepseek-r1');
  });

  it('falls back to env default if DB throws', async () => {
    factsRepoMock.getByKey.mockRejectedValueOnce(new Error('connection lost'));
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
});
