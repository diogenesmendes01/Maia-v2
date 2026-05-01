import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const triggerPairingCode = vi.fn();

vi.mock('../../src/gateway/baileys.js', () => ({
  triggerPairingCode,
  isBaileysConnected: () => false,
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-setup-routes-test',
    SETUP_TOKEN_OVERRIDE: 'TEST-TOKEN',
    WHATSAPP_NUMBER_MAIA: '+5511999999999',
    FEATURE_DASHBOARD: false,
    NODE_ENV: 'test',
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  vi.resetModules();
  triggerPairingCode.mockReset();
  vi.doMock('../../src/gateway/baileys.js', () => ({
    triggerPairingCode,
    isBaileysConnected: () => false,
  }));
  vi.doMock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
  vi.doMock('../../src/lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../../src/config/env.js', () => ({
    config: {
      BAILEYS_AUTH_DIR: '/tmp/maia-setup-routes-test',
      SETUP_TOKEN_OVERRIDE: 'TEST-TOKEN',
      WHATSAPP_NUMBER_MAIA: '+5511999999999',
      FEATURE_DASHBOARD: false,
    },
  }));
  app = Fastify();
  const { registerSetupRoutes } = await import('../../src/setup/index.js');
  const { setupState } = await import('../../src/setup/state.js');
  try { setupState.setUnpaired(); } catch {}
  await registerSetupRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/**
 * Helper: simulate the operator's first GET /setup which mints the CSRF cookie
 * and embeds the same value in the chooser form. Returns the Cookie header to
 * pass to subsequent POSTs and the csrf value to include in the body.
 */
async function csrfFlow(token: string): Promise<{ cookie: string; csrf: string }> {
  const r = await app.inject({ method: 'GET', url: `/setup?token=${token}` });
  const setCookie = r.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
  const match = /maia_setup_csrf=([0-9a-f]+)/.exec(cookieStr);
  if (!match) throw new Error('csrf cookie not set in GET /setup response');
  const csrf = match[1]!;
  return { cookie: `maia_setup_csrf=${csrf}`, csrf };
}

describe('setup routes - auth', () => {
  it('GET /setup without token returns 403 with security headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup' });
    expect(r.statusCode).toBe(403);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /setup with wrong token returns 403', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup?token=wrong' });
    expect(r.statusCode).toBe(403);
  });

  it('GET /setup with correct token returns 200 + chooser HTML + security headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).toContain('Parear com QR Code');
  });
});

describe('setup routes - POST /setup/start', () => {
  it('method=qr from unpaired returns 200 (server-side no-op)', async () => {
    const { cookie, csrf } = await csrfFlow('TEST-TOKEN');
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      headers: { cookie },
      payload: { method: 'qr', csrf },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
  });

  it('method=code from unpaired calls triggerPairingCode and returns 200', async () => {
    triggerPairingCode.mockResolvedValueOnce('12345678');
    const { cookie, csrf } = await csrfFlow('TEST-TOKEN');
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      headers: { cookie },
      payload: { method: 'code', csrf },
    });
    expect(triggerPairingCode).toHaveBeenCalledWith('+5511999999999');
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.phase).toBe('pairing_code');
  });

  it('method=code returns 503 with retry_after_s when triggerPairingCode throws baileys_socket_not_ready', async () => {
    triggerPairingCode.mockRejectedValueOnce(new Error('baileys_socket_not_ready'));
    const { cookie, csrf } = await csrfFlow('TEST-TOKEN');
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      headers: { cookie },
      payload: { method: 'code', csrf },
    });
    expect(r.statusCode).toBe(503);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.retry_after_s).toBe(2);
  });
});

describe('setup routes - CSRF defence', () => {
  it('POST /setup/start without CSRF cookie returns 403', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      payload: { method: 'qr', csrf: 'a'.repeat(32) },
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('csrf forbidden');
  });

  it('POST /setup/start with mismatched CSRF returns 403', async () => {
    const { cookie } = await csrfFlow('TEST-TOKEN');
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      headers: { cookie },
      payload: { method: 'qr', csrf: 'b'.repeat(32) },
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('csrf forbidden');
  });
});

describe('setup routes - phase-dependent rendering', () => {
  it('GET /setup on pairing_qr embeds the QR image tag', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('/setup/qr.png?token=TEST-TOKEN');
  });

  it('GET /setup on connected returns 410 with friendly HTML', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(410);
    expect(r.body).toContain('Maia');
  });

  it('GET /setup on pairing_code shows the formatted code', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setCode('12345678');
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1234-5678');
    expect(r.body).toContain('Copiar');
  });

  it('GET /setup on disconnected_transient returns 503 with reconnecting HTML', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    setupState.markDisconnected();
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('temporariamente');
  });

  it('GET /setup on recovering returns 503 with recovery HTML', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setRecovering();
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('Limpando');
  });
});

describe('setup routes - GET /setup/qr.png', () => {
  it('returns PNG buffer when phase=pairing_qr with qr set', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('returns 404 when phase is not pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(404);
  });
});

describe('setup routes - GET /setup/status', () => {
  it('returns phase JSON with correct shape', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/status?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('pairing_qr');
    expect(body.qr).toBe('available');
    expect(JSON.stringify(body)).not.toContain('test-qr-string');
  });

  it('without token returns 403 with security headers (auth gate applies)', async () => {
    // /setup/status leaks the current pairing phase if unguarded — assert the
    // authGate is wired and that applyHeaders runs BEFORE verifyToken so the
    // 403 itself is no-store/no-referrer (defence in depth: the empty body
    // still benefits from cache controls if a proxy ever sees it).
    const r = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(r.statusCode).toBe(403);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('setup routes - GET /setup/status (per-phase shape)', () => {
  it('on pairing_code returns phase + expiresAt ISO; raw code is NOT leaked', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setCode('87654321');
    const r = await app.inject({ method: 'GET', url: '/setup/status?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('pairing_code');
    expect(typeof body.expiresAt).toBe('string');
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(JSON.stringify(body)).not.toContain('87654321');
  });

  it('on connected returns phase + connectedAt ISO', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    const r = await app.inject({ method: 'GET', url: '/setup/status?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('connected');
    expect(typeof body.connectedAt).toBe('string');
    expect(body.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('setup routes - POST /setup/start (validation + conflict branches)', () => {
  it('returns 400 when method is missing or unknown', async () => {
    const { cookie, csrf } = await csrfFlow('TEST-TOKEN');
    const r1 = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      headers: { cookie },
      payload: { csrf },
    });
    expect(r1.statusCode).toBe(400);
    expect(JSON.parse(r1.body).error).toBe('invalid_method');

    const f2 = await csrfFlow('TEST-TOKEN');
    const r2 = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      headers: { cookie: f2.cookie },
      payload: { method: 'fax', csrf: f2.csrf },
    });
    expect(r2.statusCode).toBe(400);
    expect(JSON.parse(r2.body).error).toBe('invalid_method');
  });

  it('returns 409 when method=code is requested from a non-unpaired phase', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const { cookie, csrf } = await csrfFlow('TEST-TOKEN');
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      headers: { cookie },
      payload: { method: 'code', csrf },
    });
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.phase).toBe('connected');
    expect(triggerPairingCode).not.toHaveBeenCalled();
  });
});

describe('setup routes - GET /setup/done', () => {
  it('returns 200 with confirmation HTML (no token required)', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup/done' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Pareamento completo');
  });
});

// Run with NODE_ENV != 'test' so the global rate limit is actually engaged
// (it's bypassed in tests by design - see registerSetupRoutes). The chooser
// polls /setup/status every 2s = 30 req/min; if /setup/status counted against
// the 30/min cap, the operator would hit 429 mid-pairing as soon as they did
// anything else (POST /setup/start, refresh, /setup/qr.png).
describe('setup routes - rate limit (production mode)', () => {
  let prodApp: FastifyInstance;
  const savedEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    await app.close(); // discard the test-mode app from the outer beforeEach
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    vi.doMock('../../src/gateway/baileys.js', () => ({
      triggerPairingCode,
      isBaileysConnected: () => false,
    }));
    vi.doMock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
    vi.doMock('../../src/lib/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../src/config/env.js', () => ({
      config: {
        BAILEYS_AUTH_DIR: '/tmp/maia-setup-routes-test',
        SETUP_TOKEN_OVERRIDE: 'TEST-TOKEN',
        WHATSAPP_NUMBER_MAIA: '+5511999999999',
        FEATURE_DASHBOARD: false,
        NODE_ENV: 'production',
      },
    }));
    prodApp = Fastify();
    const { registerSetupRoutes } = await import('../../src/setup/index.js');
    const { setupState } = await import('../../src/setup/state.js');
    try { setupState.setUnpaired(); } catch { /* already unpaired */ }
    await registerSetupRoutes(prodApp);
    await prodApp.ready();
  });

  afterEach(async () => {
    await prodApp.close();
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  });

  it('GET /setup/status is exempt from the per-IP rate limit', async () => {
    // 35 polls > 30/min cap. Without `config: { rateLimit: false }` the 31st
    // request would be 429 and the chooser page would silently stop refreshing.
    for (let i = 0; i < 35; i++) {
      const r = await prodApp.inject({ method: 'GET', url: '/setup/status?token=TEST-TOKEN' });
      expect(r.statusCode, `iteration ${i}`).toBe(200);
    }
  });

  it('GET /setup/status polling does not consume the budget for GET /setup', async () => {
    // Simulate a full minute of polling, then the operator opens the chooser.
    // If status counted against the cap, this GET /setup would 429.
    for (let i = 0; i < 30; i++) {
      const poll = await prodApp.inject({ method: 'GET', url: '/setup/status?token=TEST-TOKEN' });
      expect(poll.statusCode).toBe(200);
    }
    const chooser = await prodApp.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(chooser.statusCode).toBe(200);
  });

  it('CSRF cookie is marked Secure when NODE_ENV=production', async () => {
    const r = await prodApp.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    const setCookie = r.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(cookieStr).toMatch(/maia_setup_csrf=/);
    expect(cookieStr).toMatch(/Secure/);
    expect(cookieStr).toMatch(/HttpOnly/);
    expect(cookieStr).toMatch(/SameSite=Strict/i);
  });
});
