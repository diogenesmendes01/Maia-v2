/**
 * identify_entity handler tests.
 *
 * Mocks `entidadesRepo.byIds` to return synthetic entities so we can drive
 * the trigram-similarity scorer to specific outcomes:
 *   1. Clear match → returns the entidade_id with confianca > 0.4.
 *   2. Empty scope → returns null + ambiguous=true (no DB call).
 *   3. Two close matches → ambiguous=true, entidade_id=null.
 *   4. Schema rejects empty texto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const byIdsMock = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  entidadesRepo: { byIds: (...args: unknown[]) => byIdsMock(...args) },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

beforeEach(() => byIdsMock.mockReset());

const ctxWith = (entidades: string[]) =>
  ({
    pessoa: { id: 'p1' },
    conversa: { id: 'c1' },
    scope: { entidades, byEntity: new Map() },
    mensagem_id: 'm1',
    request_id: 'r1',
    idempotency_key: 'ik1',
  }) as never;

describe('identify_entity — handler', () => {
  it('happy path: returns the best match when one entity clearly wins', async () => {
    byIdsMock.mockResolvedValueOnce([
      { id: 'e-padaria', nome: 'Padaria do João' },
      { id: 'e-mercado', nome: 'Mercado Central' },
    ]);
    const { identifyEntityTool } = await import('../../../src/tools/identify-entity.js');
    const out = await identifyEntityTool.handler(
      { texto: 'Padaria do João' },
      ctxWith(['e-padaria', 'e-mercado']),
    );
    expect(out.entidade_id).toBe('e-padaria');
    expect(out.ambiguous).toBe(false);
    expect(out.confianca).toBeGreaterThan(0.4);
    expect(out.alternativas[0]?.entidade_id).toBe('e-padaria');
  });

  it('empty scope → entidade_id null and ambiguous, without hitting the repo', async () => {
    const { identifyEntityTool } = await import('../../../src/tools/identify-entity.js');
    const out = await identifyEntityTool.handler({ texto: 'qualquer coisa' }, ctxWith([]));
    expect(out.entidade_id).toBeNull();
    expect(out.ambiguous).toBe(true);
    expect(out.alternativas).toEqual([]);
    expect(byIdsMock).not.toHaveBeenCalled();
  });

  it('ambiguous: two near-equal matches yield entidade_id=null and ambiguous=true', async () => {
    // Same name → trigram scores tie; the < 0.1 gap test triggers ambiguity.
    byIdsMock.mockResolvedValueOnce([
      { id: 'e1', nome: 'Loja Central' },
      { id: 'e2', nome: 'Loja Central' },
    ]);
    const { identifyEntityTool } = await import('../../../src/tools/identify-entity.js');
    const out = await identifyEntityTool.handler(
      { texto: 'Loja Central' },
      ctxWith(['e1', 'e2']),
    );
    expect(out.ambiguous).toBe(true);
    expect(out.entidade_id).toBeNull();
    expect(out.alternativas.length).toBe(2);
  });

  it('low similarity (no entity name resembles texto) → ambiguous=true', async () => {
    byIdsMock.mockResolvedValueOnce([{ id: 'e-padaria', nome: 'Padaria' }]);
    const { identifyEntityTool } = await import('../../../src/tools/identify-entity.js');
    const out = await identifyEntityTool.handler(
      { texto: 'xyzqwk completamente diferente' },
      ctxWith(['e-padaria']),
    );
    expect(out.ambiguous).toBe(true);
    expect(out.entidade_id).toBeNull();
    expect(out.confianca).toBeLessThan(0.4);
  });

  it('schema rejects empty texto', async () => {
    const { identifyEntityTool } = await import('../../../src/tools/identify-entity.js');
    const r = identifyEntityTool.input_schema.safeParse({ texto: '' });
    expect(r.success).toBe(false);
  });
});
