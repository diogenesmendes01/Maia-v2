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
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  vi.resetModules();
  triggerPairingCode.mockReset();
  // Re-mock everything per test (vi.resetModules clears state)
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
  // Reset state to unpaired for each test
  const { setupState } = await import('../../src/setup/state.js');
  // setupState is a singleton; force back to unpaired
  // (state.ts doesn't expose a reset; but we can call setUnpaired which is allowed from any phase)
  try { setupState.setUnpaired(); } catch {}
  await registerSetupRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('setup routes — auth', () => {
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

  it('GET /setup with correct token returns 200 + chooser HTML', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('Parear com QR Code');
    expect(r.body).toContain('Parear com Código de 8 dígitos');
  });
});

describe('setup routes — POST /setup/start', () => {
  it('method=qr from unpaired returns 200 (server-side no-op)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      payload: { method: 'qr' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
  });

  it('method=code from unpaired calls triggerPairingCode and returns 200', async () => {
    triggerPairingCode.mockResolvedValueOnce('12345678');
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      payload: { method: 'code' },
    });
    expect(triggerPairingCode).toHaveBeenCalledWith('+5511999999999');
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.phase).toBe('pairing_code');
  });

  it('method=code returns 503 with retry_after_s when triggerPairingCode throws baileys_socket_not_ready', async () => {
    triggerPairingCode.mockRejectedValueOnce(new Error('baileys_socket_not_ready'));
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      payload: { method: 'code' },
    });
    expect(r.statusCode).toBe(503);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.retry_after_s).toBe(2);
  });
});

describe('setup routes — phase-dependent rendering', () => {
  // Note: the public state-machine API only allows entering pairing_qr with a
  // non-null qr (`setQr(qr: string)`). The qr=null branch in renderQr exists
  // as a defensive type — unreachable through the route flow today — so we
  // can't exercise it here without poking internal state directly. See
  // src/setup/templates.ts renderQr for the spinner branch.
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
    expect(r.body).toContain('Maia já está pareada');
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
});

describe('setup routes — GET /setup/qr.png', () => {
  it('returns PNG buffer when phase=pairing_qr with qr set', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    // PNG magic bytes
    expect(r.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('returns 404 when phase is not pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(404);
  });
});

describe('setup routes — GET /setup/status', () => {
  it('returns phase JSON with correct shape', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/status?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('pairing_qr');
    expect(body.qr).toBe('available');
    // Raw QR string MUST NOT appear in JSON
    expect(JSON.stringify(body)).not.toContain('test-qr-string');
  });
});

describe('setup routes — GET /setup/done', () => {
  it('returns 200 with confirmation HTML (no token required)', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup/done' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Pareamento completo');
  });
});
