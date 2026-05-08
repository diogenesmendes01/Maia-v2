import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  db: {},
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

let envState: { NODE_ENV: string } = { NODE_ENV: 'development' };
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'NODE_ENV') return envState.NODE_ENV;
      if (prop === 'FEATURE_DASHBOARD') return false;
      return undefined;
    },
  }),
}));

describe('dashboard — sessionCookie helper', () => {
  it('does NOT include Secure when NODE_ENV=development', async () => {
    envState = { NODE_ENV: 'development' };
    const { sessionCookie } = await import('../../src/dashboard/index.js');
    const cookie = sessionCookie('tok123', 28800);
    expect(cookie).toContain('maia_session=tok123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=28800');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
  });

  it('includes Secure when NODE_ENV=production', async () => {
    envState = { NODE_ENV: 'production' };
    vi.resetModules();
    const { sessionCookie } = await import('../../src/dashboard/index.js');
    const cookie = sessionCookie('tok123', 28800);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('logout (Max-Age=0) also gets Secure in production', async () => {
    envState = { NODE_ENV: 'production' };
    vi.resetModules();
    const { sessionCookie } = await import('../../src/dashboard/index.js');
    const cookie = sessionCookie('', 0);
    expect(cookie).toContain('maia_session=;');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
  });

  it('test env (NODE_ENV=test) does NOT get Secure', async () => {
    envState = { NODE_ENV: 'test' };
    vi.resetModules();
    const { sessionCookie } = await import('../../src/dashboard/index.js');
    expect(sessionCookie('x', 60)).not.toContain('Secure');
  });
});
