/**
 * Preço por modelo do ledger de custo.
 *
 * Issue #508 (review rodada 2): a acumulação do fact deixou de ser
 * read-modify-write em JS (`getByKey` → somar → `upsert` absoluto) e virou um
 * `INSERT … ON CONFLICT DO UPDATE` atômico. Este spec, que é sobre PREÇO e não
 * sobre persistência, passa a observar o valor calculado por
 * `estimateLLMCostUsd` — a mesma função que a reserva de orçamento usa, de
 * modo que reservar e cobrar não podem divergir de tabela — e confirma, num
 * caso, que `recordLLMCost` leva esse mesmo número para o statement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertMock = vi.fn();
const getByKeyMock = vi.fn();
const executeMock = vi.fn(async () => ({ rows: [] }));

vi.mock('../../src/db/repositories.js', () => ({
  factsRepo: {
    upsert: upsertMock,
    getByKey: getByKeyMock,
  },
}));

vi.mock('../../src/db/client.js', () => ({ db: { execute: executeMock } }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/lib/metrics.js', () => ({ incCounter: vi.fn() }));

const getToolCallingModelsMock = vi.fn();
vi.mock('../../src/lib/openrouter-models.js', () => ({
  getToolCallingModels: getToolCallingModelsMock,
}));

import { runWithTenantContext } from '../../src/db/tenant-context.js';

/** Valores ligados ao statement (ver helper gêmeo em cost-ledger-pessoa.spec). */
function paramsOf(call: unknown): unknown[] {
  const chunks = (call as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter((c) => !Array.isArray((c as { value?: unknown })?.value));
}

/** O payload JSON semeado no INSERT (o ramo "linha nova"). */
function seedOf(call: unknown): { usd_cents: number; last_model: string } {
  const json = paramsOf(call).find(
    (p) => typeof p === 'string' && p.startsWith('{') && p.includes('usd_cents'),
  );
  return JSON.parse(String(json));
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, fn);
}

beforeEach(() => {
  upsertMock.mockReset();
  getByKeyMock.mockReset();
  executeMock.mockClear();
  getByKeyMock.mockResolvedValue(null);
  getToolCallingModelsMock.mockReset();
});

describe('preço por modelo (estimateLLMCostUsd)', () => {
  it('uses live OpenRouter pricing for slugs with "/"', async () => {
    getToolCallingModelsMock.mockResolvedValue([
      {
        id: 'openai/gpt-5',
        name: 'OpenAI: GPT-5',
        context_length: 200000,
        // $5/M input, $15/M output → 0.5¢/1k input, 1.5¢/1k output
        pricing: { prompt_per_million: 5, completion_per_million: 15 },
        supports_tools: true,
      },
    ]);
    const { estimateLLMCostUsd } = await import('../../src/lib/cost-ledger.js');
    // 1k * 0.5¢ + 1k * 1.5¢ = 2¢ = US$ 0,02
    expect(
      await estimateLLMCostUsd({
        model: 'openai/gpt-5',
        tokens_input: 1000,
        tokens_output: 1000,
      }),
    ).toBeCloseTo(0.02, 6);
  });

  it('uses local hardcoded rate for direct-vendor model names (no slash)', async () => {
    const { estimateLLMCostUsd } = await import('../../src/lib/cost-ledger.js');
    // claude-sonnet-4-6 → 0.3¢ in / 1.5¢ out → 1.8¢
    expect(
      await estimateLLMCostUsd({
        model: 'claude-sonnet-4-6',
        tokens_input: 1000,
        tokens_output: 1000,
      }),
    ).toBeCloseTo(0.018, 6);
    // Importantly: never hit OpenRouter for direct vendor calls.
    expect(getToolCallingModelsMock).not.toHaveBeenCalled();
  });

  it('falls back to conservative default when OpenRouter slug is unknown', async () => {
    getToolCallingModelsMock.mockResolvedValue([]); // empty catalog
    const { estimateLLMCostUsd } = await import('../../src/lib/cost-ledger.js');
    expect(
      await estimateLLMCostUsd({
        model: 'unknown-vendor/never-seen-model',
        tokens_input: 1000,
        tokens_output: 1000,
      }),
    ).toBeCloseTo(0.018, 6);
  });

  it('falls back when getToolCallingModels rejects (network down + no cache)', async () => {
    getToolCallingModelsMock.mockRejectedValue(new Error('network down'));
    const { estimateLLMCostUsd } = await import('../../src/lib/cost-ledger.js');
    expect(
      await estimateLLMCostUsd({
        model: 'anthropic/claude-sonnet-4.6',
        tokens_input: 1000,
        tokens_output: 1000,
      }),
    ).toBeCloseTo(0.018, 6);
  });
});

describe('recordLLMCost leva o preço calculado para o statement', () => {
  it('grava os centavos da mesma tabela de preços', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await withTenant(() =>
      recordLLMCost({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens_input: 1000,
        tokens_output: 1000,
      }),
    );
    const seed = seedOf(executeMock.mock.calls[0]![0]);
    expect(seed.usd_cents).toBeCloseTo(1.8, 5);
    expect(seed.last_model).toBe('claude-sonnet-4-6');
  });
});
