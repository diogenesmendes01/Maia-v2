/**
 * Surface-check spec for the mockFactsRepo factory.
 *
 * This test ensures that every key exported by the live production factsRepo
 * object is also present in the mock returned by mockFactsRepo(). If the
 * production repo grows a new method and the factory is not updated, this
 * spec fails — preventing the silent "TypeError: factsRepo.X is not a
 * function" runtime errors that previously broke ~64 tests (Issue #106).
 *
 * This is NOT an integration test. It does NOT connect to a database.
 * It only compares the shape of the live export against the mock factory.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockFactsRepo } from './factsRepo.js';

vi.mock('../../src/db/client.js', () => ({
  db: {},
  withTx: vi.fn(),
}));
vi.mock('../../src/db/tenant-context.js', () => ({
  getCurrentTenant: vi.fn(() => 'default'),
  getCurrentAgent: vi.fn(() => 'default'),
}));

describe('mockFactsRepo — surface matches live factsRepo', () => {
  it('has every key that the live production factsRepo exports', async () => {
    const { factsRepo } = await import('../../src/db/repositories.js');
    const mock = mockFactsRepo();
    for (const key of Object.keys(factsRepo)) {
      expect(mock, `mockFactsRepo is missing key: "${key}"`).toHaveProperty(key);
    }
  });

  it('all values in mock are vi.fn() stubs (callable)', () => {
    const mock = mockFactsRepo();
    for (const [key, value] of Object.entries(mock)) {
      expect(typeof value, `mockFactsRepo.${key} should be a function`).toBe('function');
    }
  });

  it('overrides parameter replaces specific methods', () => {
    const customUpsert = vi.fn().mockResolvedValue({ id: 'custom' });
    const mock = mockFactsRepo({ upsert: customUpsert });
    expect(mock.upsert).toBe(customUpsert);
    // Other methods are still the defaults
    expect(mock.getByKey).not.toBe(customUpsert);
  });
});
