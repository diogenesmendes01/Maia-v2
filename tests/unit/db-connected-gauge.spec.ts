import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: { DATABASE_URL: 'postgres://nope:nope@localhost:1/none' },
}));

const connectMock = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: class {
      on(): void {}
      connect(): Promise<unknown> {
        return connectMock();
      }
    },
  },
}));

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({}),
}));

beforeEach(() => {
  connectMock.mockReset();
  vi.useFakeTimers();
});

describe('isDbConnected / probeDb', () => {
  it('starts false until the first successful probe', async () => {
    const release = vi.fn();
    connectMock.mockResolvedValue({ query: vi.fn().mockResolvedValue({}), release });
    vi.resetModules();
    const { isDbConnected, probeDb } = await import('../../src/db/client.js');
    expect(isDbConnected()).toBe(false);
    await probeDb();
    expect(isDbConnected()).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it('flips to false when probe rejects', async () => {
    connectMock.mockResolvedValue({
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    });
    vi.resetModules();
    const { isDbConnected, probeDb } = await import('../../src/db/client.js');
    await probeDb();
    expect(isDbConnected()).toBe(true);

    // Force the cache to expire so the next probe runs a fresh attempt.
    await vi.advanceTimersByTimeAsync(6000);
    connectMock.mockRejectedValueOnce(new Error('boom'));
    await probeDb();
    expect(isDbConnected()).toBe(false);
  });

  it('rate-limits probes to 1 per 5s', async () => {
    connectMock.mockResolvedValue({
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    });
    vi.resetModules();
    const { probeDb } = await import('../../src/db/client.js');
    await probeDb();
    await probeDb();
    await probeDb();
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
