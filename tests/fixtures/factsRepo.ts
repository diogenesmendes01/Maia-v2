/**
 * Shared mock factory for factsRepo.
 *
 * Single source of truth for the factsRepo mock surface.
 * When the production factsRepo grows a new method, add it here once —
 * every spec that calls mockFactsRepo() picks it up automatically.
 * The companion spec (factsRepo.spec.ts) will then fail CI if the surfaces
 * diverge.
 */
import { vi } from 'vitest';
import type { AgentFact } from '../../src/db/schema.js';

/** A minimal AgentFact stub returned by upsert() by default. */
const STUB_FACT: AgentFact = {
  id: 'fact-stub-id',
  tenant_id: 'default',
  agent_id: 'default',
  escopo: 'global',
  chave: 'stub.key',
  valor: {},
  confianca: '1.00',
  fonte: 'aprendido',
  ultima_validacao: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

export type MockFactsRepo = {
  getByKey: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  listForScopes: ReturnType<typeof vi.fn>;
  listMentionableForScopes: ReturnType<typeof vi.fn>;
};

/**
 * Returns a fully-stubbed factsRepo mock whose surface matches the live
 * production repository object.
 *
 * @param overrides - Per-test method overrides. Pass a partial record of
 *   method names → vi.fn() replacements for the methods you want to control
 *   specifically. Unspecified methods get sensible defaults.
 *
 * @example
 * ```ts
 * vi.mock('../../src/db/repositories.js', () => ({
 *   factsRepo: mockFactsRepo(),
 * }));
 *
 * // Override one method in a specific test:
 * vi.mock('../../src/db/repositories.js', () => ({
 *   factsRepo: mockFactsRepo({
 *     upsert: vi.fn().mockResolvedValue({ ...STUB_FACT, chave: 'my.key' }),
 *   }),
 * }));
 * ```
 */
export function mockFactsRepo(overrides: Partial<MockFactsRepo> = {}): MockFactsRepo {
  return {
    getByKey: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(STUB_FACT),
    listForScopes: vi.fn().mockResolvedValue([]),
    listMentionableForScopes: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}
