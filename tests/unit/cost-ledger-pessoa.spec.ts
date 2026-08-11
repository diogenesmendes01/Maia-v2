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

// Issue #508 (review rodada 2): a acumulação do fact de custo deixou de ser
// read-modify-write em JS e virou um `INSERT … ON CONFLICT DO UPDATE` atômico.
// O spec passa a observar o statement, não o repo.
vi.mock('../../src/db/client.js', () => ({ db: { execute: executeMock } }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/lib/metrics.js', () => ({ incCounter: vi.fn() }));

import { runWithTenantContext } from '../../src/db/tenant-context.js';

/**
 * O template `sql` do drizzle guarda os fragmentos literais como `StringChunk`
 * (um objeto com `value: string[]`) e os valores ligados como o próprio valor,
 * intercalados. Estes dois helpers separam um do outro.
 */
function chunksOf(call: unknown): unknown[] {
  return (call as { queryChunks?: unknown[] })?.queryChunks ?? [];
}
function isLiteral(chunk: unknown): boolean {
  return Array.isArray((chunk as { value?: unknown })?.value);
}

/** Concatena os fragmentos literais numa string legível. */
function sqlTextOf(call: unknown): string {
  return chunksOf(call)
    .filter(isLiteral)
    .map((c) => ((c as { value: string[] }).value ?? []).join(''))
    .join(' ');
}

/** Valores ligados ao statement, na ordem. */
function paramsOf(call: unknown): unknown[] {
  return chunksOf(call).filter((c) => !isLiteral(c));
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: 'acme', agent_id: 'ana' }, fn);
}

beforeEach(() => {
  upsertMock.mockReset();
  getByKeyMock.mockReset();
  executeMock.mockClear();
  getByKeyMock.mockResolvedValue(null);
});

describe('recordLLMCost — per-pessoa breakdown', () => {
  it('writes ONLY the global aggregate when pessoa_id is undefined', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await withTenant(() =>
      recordLLMCost({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens_input: 1000,
        tokens_output: 1000,
      }),
    );
    expect(executeMock).toHaveBeenCalledTimes(1);
    const params = paramsOf(executeMock.mock.calls[0]![0]);
    expect(params).toContain('global');
    expect(params.some((p) => /^cost\.daily\.llm\.\d{4}-\d{2}-\d{2}$/.test(String(p)))).toBe(
      true,
    );
  });

  it('writes BOTH global + pessoa entries when pessoa_id is provided', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await withTenant(() =>
      recordLLMCost({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens_input: 1000,
        tokens_output: 1000,
        pessoa_id: 'p1',
      }),
    );
    expect(executeMock).toHaveBeenCalledTimes(2);
    const allParams = executeMock.mock.calls.map((c) => paramsOf(c[0]));
    expect(allParams.some((p) => p.includes('global'))).toBe(true);
    expect(allParams.some((p) => p.includes('pessoa'))).toBe(true);
    const pessoaParams = allParams.find((p) => p.includes('pessoa'))!;
    expect(
      pessoaParams.some((p) => /^cost\.daily\.llm\.\d{4}-\d{2}-\d{2}\.p1$/.test(String(p))),
    ).toBe(true);
    // Same delta on both keys.
    expect(pessoaParams).toContain(1000);
  });

  /**
   * O achado da rodada 2: o ledger durável fazia read-modify-write absoluto
   * (`getByKey` → somar em JS → `upsert` com o total). Duas escritas
   * concorrentes liam o mesmo acumulado e a segunda sobrescrevia o incremento
   * da primeira. A soma agora acontece dentro do `ON CONFLICT DO UPDATE`,
   * sobre a linha travada pelo próprio upsert.
   */
  it('acumula com um único statement atômico, sem ler antes', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await withTenant(() =>
      recordLLMCost({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens_input: 1000,
        tokens_output: 1000,
      }),
    );

    const text = sqlTextOf(executeMock.mock.calls[0]![0]);
    expect(text).toMatch(/INSERT INTO agent_facts/);
    expect(text).toMatch(/ON CONFLICT \(tenant_id, agent_id, escopo, chave\) DO UPDATE/);
    // A soma lê a linha existente — é isso que a torna atômica.
    expect(text).toMatch(/agent_facts\.valor->>'tokens_input'/);
    expect(text).toMatch(/agent_facts\.valor->>'usd_cents'/);
    // E nenhuma leitura prévia pelo repo.
    expect(getByKeyMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('o statement carrega tenant_id e agent_id do ALS', async () => {
    const { recordLLMCost } = await import('../../src/lib/cost-ledger.js');
    await withTenant(() =>
      recordLLMCost({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens_input: 10,
        tokens_output: 5,
      }),
    );
    const params = paramsOf(executeMock.mock.calls[0]![0]);
    expect(params).toContain('acme');
    expect(params).toContain('ana');
  });

  it('readDailyLLMUsdByPessoa returns 0 when no fact exists', async () => {
    const { readDailyLLMUsdByPessoa } = await import('../../src/lib/cost-ledger.js');
    expect(await readDailyLLMUsdByPessoa('p1', '2026-05-08')).toBe(0);
  });

  it('readDailyLLMUsdByPessoa converts cents to USD', async () => {
    getByKeyMock.mockResolvedValueOnce({ valor: { usd_cents: 250 } });
    const { readDailyLLMUsdByPessoa } = await import('../../src/lib/cost-ledger.js');
    expect(await readDailyLLMUsdByPessoa('p1', '2026-05-08')).toBe(2.5);
    expect(getByKeyMock).toHaveBeenCalledWith('pessoa', 'cost.daily.llm.2026-05-08.p1');
  });
});
