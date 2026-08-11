/**
 * Rotas do `/setup`.
 *
 * Issue #518 — o bootstrap token SAIU da URL. A autenticação agora é:
 *   - cookie de sessão de operador (`maia_setup_session`), obtido pelo POST
 *     do formulário de `/setup/session` (token no CORPO);
 *   - ou o header `x-maia-setup-token` (break-glass de curl/runbook).
 * `?token=` NÃO autentica mais em rota nenhuma, e nenhuma resposta (HTML,
 * redirect, JSON) devolve o token.
 */
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

const TOKEN = 'TEST-TOKEN';
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
  try { setupState.setUnpaired(); } catch { /* already unpaired */ }
  await registerSetupRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/**
 * Mini cookie-jar. O navegador SUBSTITUI um cookie de mesmo nome; concatenar
 * `Set-Cookie` cegamente produziria dois `maia_setup_csrf` no header e o
 * servidor leria o ANTIGO — um falso 403 que não acontece na vida real. Aqui
 * o último valor vence, como no browser.
 */
class CookieJar {
  private readonly store = new Map<string, string>();

  /** Absorve os `Set-Cookie` de uma resposta (só o par nome=valor). */
  absorb(setCookie: string | string[] | undefined): this {
    const raw = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const entry of raw) this.put(entry.split(';')[0]!);
    return this;
  }

  private put(pair: string): void {
    const i = pair.indexOf('=');
    if (i > 0) this.store.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }

  /** Header `Cookie` a enviar no próximo request. */
  get header(): string {
    return [...this.store].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.store.get(name);
  }
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  return new CookieJar().absorb(setCookie).header;
}

/**
 * Jornada real do operador: abre `/setup` (recebe o portão + cookie csrf),
 * posta o token no CORPO de `/setup/session`, recebe o cookie de sessão.
 */
async function openSession(instance: FastifyInstance = app): Promise<CookieJar> {
  const cookies = new CookieJar();
  const gate = await instance.inject({ method: 'GET', url: '/setup' });
  cookies.absorb(gate.headers['set-cookie']);
  const session = await instance.inject({
    method: 'POST',
    url: '/setup/session',
    headers: { cookie: cookies.header },
    payload: { token: TOKEN, csrf: cookies.get('maia_setup_csrf') ?? '' },
  });
  cookies.absorb(session.headers['set-cookie']);
  return cookies;
}

/** Cookies + o csrf corrente da página do chooser. */
async function chooserFlow(
  instance: FastifyInstance = app,
): Promise<{ cookie: string; csrf: string }> {
  const cookies = await openSession(instance);
  const r = await instance.inject({
    method: 'GET',
    url: '/setup',
    headers: { cookie: cookies.header },
  });
  cookies.absorb(r.headers['set-cookie']);
  const csrf = cookies.get('maia_setup_csrf');
  if (!csrf) throw new Error('csrf cookie not set in GET /setup response');
  return { cookie: cookies.header, csrf };
}

describe('setup routes — o token não autentica mais pela URL (#518)', () => {
  it('GET /setup sem sessão devolve 401 com o PORTÃO de token (não um 403 seco)', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('Token de operador');
    expect(r.body).toContain('action="/setup/session"');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /setup?token=<correto> NÃO autentica: cai no portão', async () => {
    const r = await app.inject({ method: 'GET', url: `/setup?token=${TOKEN}` });
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain('Token de operador');
    expect(r.body).not.toContain('Parear com QR Code');
  });

  for (const url of ['/setup/status', '/setup/qr.png']) {
    it(`GET ${url}?token=<correto> NÃO autentica: 403`, async () => {
      const r = await app.inject({ method: 'GET', url: `${url}?token=${TOKEN}` });
      expect(r.statusCode).toBe(403);
    });
  }

  it('o portão NÃO ecoa o token digitado quando ele está errado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/setup/session',
      payload: { token: 'chute-do-atacante' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('Token inválido');
    expect(r.body).not.toContain('chute-do-atacante');
  });
});

describe('setup routes — sessão de operador', () => {
  it('POST /setup/session com o token no CORPO abre a sessão e redireciona para URL limpa', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/setup/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${TOKEN}`,
    });
    expect(r.statusCode).toBe(303);
    // O redirect NÃO carrega segredo — era exatamente aqui que o token
    // vazava antes (`/setup?token=…`).
    expect(r.headers.location).toBe('/setup');
    const setCookie = cookieHeader(r.headers['set-cookie']);
    expect(setCookie).toMatch(/maia_setup_session=[0-9a-f]{64}/);
    expect(setCookie).not.toContain(TOKEN);
  });

  it('o cookie de sessão é httpOnly + SameSite=Strict', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/setup/session',
      payload: { token: TOKEN },
    });
    const raw = r.headers['set-cookie'];
    const str = Array.isArray(raw) ? raw.join('\n') : (raw ?? '');
    expect(str).toMatch(/maia_setup_session=/);
    expect(str).toMatch(/HttpOnly/);
    expect(str).toMatch(/SameSite=Strict/i);
  });

  it('com sessão, GET /setup entrega o chooser', async () => {
    const cookie = (await openSession()).header;
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Parear com QR Code');
  });

  it('break-glass: o header x-maia-setup-token autentica sem cookie', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/setup/status',
      headers: { 'x-maia-setup-token': TOKEN },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).phase).toBe('unpaired');
  });

  it('break-glass com token errado é 403', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/setup/status',
      headers: { 'x-maia-setup-token': 'errado' },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('setup routes — canário: nenhum token em HTML, redirect ou header', () => {
  it('nenhuma superfície autenticada devolve o token', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;

    setupState.setUnpaired();
    const chooser = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    setupState.setQr('test-qr-string');
    const qrPage = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    setupState.setUnpaired();
    setupState.setCode('12345678');
    const codePage = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    const done = await app.inject({ method: 'GET', url: '/setup/done' });

    for (const r of [chooser, qrPage, codePage, done]) {
      expect(r.body).not.toContain(TOKEN);
      expect(r.body).not.toContain('token=');
      expect(JSON.stringify(r.headers)).not.toContain(TOKEN);
    }
  });

  it('a página do QR aponta para /setup/qr.png SEM query string', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('src="/setup/qr.png"');
    expect(r.body).not.toMatch(/qr\.png\?/);
  });

  it('o polling embutido chama /setup/status sem query e com credenciais same-origin', async () => {
    const cookie = (await openSession()).header;
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.body).toContain(`fetch('/setup/status', { cache: 'no-store', credentials: 'same-origin' })`);
  });

  it('o redirect pós-start volta para /setup limpo', async () => {
    const { cookie, csrf } = await chooserFlow();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `method=qr&csrf=${csrf}`,
    });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/setup');
  });
});

describe('setup routes - POST /setup/start', () => {
  it('method=qr from unpaired returns 200 (server-side no-op)', async () => {
    const { cookie, csrf } = await chooserFlow();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
      headers: { cookie },
      payload: { method: 'qr', csrf },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });

  it('method=code from unpaired calls triggerPairingCode and returns 200', async () => {
    triggerPairingCode.mockResolvedValueOnce('12345678');
    const { cookie, csrf } = await chooserFlow();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
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
    const { cookie, csrf } = await chooserFlow();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
      headers: { cookie },
      payload: { method: 'code', csrf },
    });
    expect(r.statusCode).toBe(503);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.retry_after_s).toBe(2);
  });

  it('sem sessão, POST /setup/start é 403 mesmo com csrf válido', async () => {
    const { csrf } = await chooserFlow();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
      payload: { method: 'qr', csrf },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('setup routes - CSRF defence', () => {
  it('POST /setup/start without CSRF cookie returns 403', async () => {
    const cookie = (await openSession()).header;
    const sessionOnly = cookie
      .split('; ')
      .filter((c) => c.startsWith('maia_setup_session='))
      .join('; ');
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
      headers: { cookie: sessionOnly },
      payload: { method: 'qr', csrf: 'a'.repeat(32) },
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('csrf forbidden');
  });

  it('POST /setup/start with mismatched CSRF returns 403', async () => {
    const { cookie } = await chooserFlow();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
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
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('/setup/qr.png');
  });

  it('GET /setup on connected returns 410 with friendly HTML', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.statusCode).toBe(410);
    expect(r.body).toContain('Maia');
  });

  it('GET /setup on pairing_code shows the formatted code', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setCode('12345678');
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1234-5678');
    expect(r.body).toContain('Copiar');
  });

  it('GET /setup on disconnected_transient returns 503 with reconnecting HTML', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    setupState.markDisconnected();
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('temporariamente');
  });

  it('GET /setup on recovering returns 503 with recovery HTML', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setRecovering();
    const r = await app.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('Limpando');
  });
});

describe('setup routes - GET /setup/qr.png', () => {
  it('returns PNG buffer when phase=pairing_qr with qr set', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('returns 404 when phase is not pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png', headers: { cookie } });
    expect(r.statusCode).toBe(404);
  });
});

describe('setup routes - GET /setup/status', () => {
  it('returns phase JSON with correct shape', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/status', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('pairing_qr');
    expect(body.qr).toBe('available');
    expect(JSON.stringify(body)).not.toContain('test-qr-string');
  });

  it('without a session returns 403 with security headers (auth gate applies)', async () => {
    // /setup/status leaks the current pairing phase if unguarded — assert the
    // authGate is wired and that applyHeaders runs BEFORE the identity check
    // so the 403 itself is no-store/no-referrer.
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
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setCode('87654321');
    const r = await app.inject({ method: 'GET', url: '/setup/status', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('pairing_code');
    expect(typeof body.expiresAt).toBe('string');
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(JSON.stringify(body)).not.toContain('87654321');
  });

  it('on connected returns phase + connectedAt ISO', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const cookie = (await openSession()).header;
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    const r = await app.inject({ method: 'GET', url: '/setup/status', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('connected');
    expect(typeof body.connectedAt).toBe('string');
    expect(body.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('setup routes - POST /setup/start (validation + conflict branches)', () => {
  it('returns 400 when method is missing or unknown', async () => {
    const { cookie, csrf } = await chooserFlow();
    const r1 = await app.inject({
      method: 'POST',
      url: '/setup/start',
      headers: { cookie },
      payload: { csrf },
    });
    expect(r1.statusCode).toBe(400);
    expect(JSON.parse(r1.body).error).toBe('invalid_method');

    const f2 = await chooserFlow();
    const r2 = await app.inject({
      method: 'POST',
      url: '/setup/start',
      headers: { cookie: f2.cookie },
      payload: { method: 'fax', csrf: f2.csrf },
    });
    expect(r2.statusCode).toBe(400);
    expect(JSON.parse(r2.body).error).toBe('invalid_method');
  });

  it('returns 409 when method=code is requested from a non-unpaired phase', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    const { cookie, csrf } = await chooserFlow();
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start',
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
    const cookie = (await openSession(prodApp)).header;
    for (let i = 0; i < 35; i++) {
      const r = await prodApp.inject({
        method: 'GET',
        url: '/setup/status',
        headers: { cookie },
      });
      expect(r.statusCode, `iteration ${i}`).toBe(200);
    }
  });

  it('GET /setup/status polling does not consume the budget for GET /setup', async () => {
    // Simulate a full minute of polling, then the operator opens the chooser.
    // If status counted against the cap, this GET /setup would 429.
    const cookie = (await openSession(prodApp)).header;
    for (let i = 0; i < 30; i++) {
      const poll = await prodApp.inject({
        method: 'GET',
        url: '/setup/status',
        headers: { cookie },
      });
      expect(poll.statusCode).toBe(200);
    }
    const chooser = await prodApp.inject({ method: 'GET', url: '/setup', headers: { cookie } });
    expect(chooser.statusCode).toBe(200);
  });

  it('os cookies de sessão e csrf são Secure quando NODE_ENV=production', async () => {
    const gate = await prodApp.inject({ method: 'GET', url: '/setup' });
    const gateStr = (Array.isArray(gate.headers['set-cookie'])
      ? gate.headers['set-cookie']
      : [gate.headers['set-cookie'] ?? '']
    ).join('\n');
    expect(gateStr).toMatch(/maia_setup_csrf=/);
    expect(gateStr).toMatch(/Secure/);
    expect(gateStr).toMatch(/HttpOnly/);
    expect(gateStr).toMatch(/SameSite=Strict/i);

    const session = await prodApp.inject({
      method: 'POST',
      url: '/setup/session',
      payload: { token: TOKEN },
    });
    const sessionStr = (Array.isArray(session.headers['set-cookie'])
      ? session.headers['set-cookie']
      : [session.headers['set-cookie'] ?? '']
    ).join('\n');
    expect(sessionStr).toMatch(/maia_setup_session=/);
    expect(sessionStr).toMatch(/Secure/);
    expect(sessionStr).toMatch(/HttpOnly/);
    expect(sessionStr).toMatch(/SameSite=Strict/i);
  });
});
