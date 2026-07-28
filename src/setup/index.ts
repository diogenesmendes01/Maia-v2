import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { setupState } from './state.js';
import { ensureToken, verifyToken } from './token.js';
import { qrToPngBuffer } from './qr-png.js';
import {
  createSetupSession,
  verifySetupSession,
  SETUP_SESSION_COOKIE,
  SETUP_SESSION_TTL_MS,
  SETUP_TOKEN_HEADER,
} from './session.js';
import {
  renderTokenGate,
  renderChooser,
  renderQr,
  renderCode,
  renderConnected,
  renderTransientDisconnect,
  renderRecovering,
  renderDone,
} from './templates.js';
import { triggerPairingCode } from '@/gateway/baileys.js';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function applyHeaders(reply: FastifyReply): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    reply.header(k, v);
  }
}

/**
 * CSRF defence (spec section 11 cookie-based, deferred originally; landed in
 * chunk-B setup hardening). The chooser page sets a sameSite=strict httpOnly
 * cookie `maia_setup_csrf` and embeds the same random hex string in the form's
 * hidden `csrf` field. POST /setup/start requires both to match (timing-safe)
 * - sameSite=strict prevents the cookie from riding cross-origin POSTs, so
 * even an attacker holding the bootstrap token cannot force a re-pair from a
 * malicious page.
 */
const CSRF_COOKIE_NAME = 'maia_setup_csrf';
const CSRF_COOKIE_MAX_AGE_S = 900; // 15 minutes - long enough for a pair attempt.

function newCsrf(): string {
  return randomBytes(16).toString('hex');
}

function cookieOpts(maxAgeS: number): {
  path: string;
  httpOnly: true;
  sameSite: 'strict';
  maxAge: number;
  secure: boolean;
} {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: maxAgeS,
    // Code self-decides per env so prod doesn't need a manual edit.
    // dev/local stays cleartext-friendly; prod requires HTTPS via nginx.
    secure: config.NODE_ENV === 'production',
  };
}

function setCsrfCookie(reply: FastifyReply): string {
  const csrf = newCsrf();
  reply.setCookie(CSRF_COOKIE_NAME, csrf, cookieOpts(CSRF_COOKIE_MAX_AGE_S));
  return csrf;
}

function cookies(req: FastifyRequest): Record<string, string | undefined> {
  return (req.cookies as Record<string, string | undefined> | undefined) ?? {};
}

async function verifyCsrf(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const cookieToken = cookies(req)[CSRF_COOKIE_NAME] ?? '';
  const body = (req.body ?? {}) as { csrf?: string };
  const presented = typeof body.csrf === 'string' ? body.csrf : '';
  const ok =
    cookieToken.length > 0 &&
    cookieToken.length === presented.length &&
    timingSafeEqual(Buffer.from(cookieToken), Buffer.from(presented));
  if (!ok) {
    await audit({
      acao: 'setup_csrf_mismatch',
      metadata: {
        ip: (req.ip ?? 'unknown').slice(0, 64),
        ua: (req.headers['user-agent'] ?? 'unknown').slice(0, 200),
        had_cookie: cookieToken.length > 0,
        had_body: presented.length > 0,
      },
    });
    reply.code(403).type('text/plain').send('csrf forbidden');
    return false;
  }
  return true;
}

async function auditUnauthorized(req: FastifyRequest, via: string): Promise<void> {
  await audit({
    acao: 'setup_unauthorized_access',
    metadata: {
      ip: (req.ip ?? 'unknown').slice(0, 64),
      ua: (req.headers['user-agent'] ?? 'unknown').slice(0, 200),
      via,
    },
  });
}

/**
 * Issue #518 — o gate NÃO lê mais `req.query.token`.
 *
 * Duas provas de identidade são aceitas, nenhuma delas em URL:
 *   1. cookie de sessão de operador (`maia_setup_session`), estabelecido pelo
 *      formulário de `POST /setup/session`;
 *   2. header `x-maia-setup-token` com o bootstrap token — o caminho
 *      BREAK-GLASS documentado para curl/automação/runbook.
 *
 * Um `?token=` numa URL antiga simplesmente não autentica mais; o operador
 * cai no portão e cola o token no formulário.
 */
async function authGate(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  applyHeaders(reply);

  const headerToken = req.headers[SETUP_TOKEN_HEADER];
  if (typeof headerToken === 'string' && headerToken.length > 0) {
    const actual = await ensureToken();
    if (verifyToken(headerToken, actual)) return true;
    await auditUnauthorized(req, 'header');
    reply.code(403).type('text/plain').send('forbidden');
    return false;
  }

  if (verifySetupSession(cookies(req)[SETUP_SESSION_COOKIE])) return true;

  await auditUnauthorized(req, 'no_session');
  reply.code(403).type('text/plain').send('forbidden');
  return false;
}

/**
 * The chooser page (`renderChooser`) submits via a plain HTML
 * `<form method="POST">`, which sends `application/x-www-form-urlencoded`
 * — Fastify rejects that with 415 unless we register a parser. We register
 * one inline (no extra dep) and turn the body into a plain object so the
 * `/setup/start` handler reads `body.method` the same way for both
 * form-encoded (browser) and JSON (tests / programmatic clients).
 *
 * `addContentTypeParser` is idempotent across the same Fastify instance:
 * a duplicate-registration error throws synchronously and is rethrown as a
 * setup-time crash, which is fine — `registerSetupRoutes` runs once per
 * process during boot.
 */
function isFormSubmit(req: FastifyRequest): boolean {
  const ct = req.headers['content-type'] ?? '';
  return ct.includes('application/x-www-form-urlencoded');
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(rateLimit, {
    // Operator-only surface - tight global limit (per IP). Tests bypass via
    // NODE_ENV=test so app.inject loops are not tripped by 429s.
    // /setup/status is opted out per-route below: the chooser polls it every
    // 2s (30 req/min on its own), and without the exemption a single operator
    // session would starve the budget for /setup, /setup/start and qr.png.
    global: process.env.NODE_ENV !== 'test',
    max: 30,
    timeWindow: '1 minute',
    skipOnError: true, // never let a Redis/store hiccup take down /setup
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const parsed = Object.fromEntries(new URLSearchParams(body as string));
        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  /**
   * Portão de sessão (#518). O token chega no CORPO — nunca em query string —
   * e é trocado por um id de sessão opaco em cookie httpOnly. A resposta é um
   * 303 para `/setup`, uma URL LIMPA: nada de segredo em histórico ou referer.
   */
  app.post('/setup/session', async (req, reply) => {
    applyHeaders(reply);
    const body = (req.body ?? {}) as { token?: string };
    const presented = typeof body.token === 'string' ? body.token.trim() : '';
    const actual = await ensureToken();

    if (!verifyToken(presented, actual)) {
      await auditUnauthorized(req, 'session_form');
      const csrf = setCsrfCookie(reply);
      return reply
        .code(403)
        .type('text/html')
        .send(renderTokenGate(csrf, 'Token inválido. Confira o arquivo e tente de novo.'));
    }

    reply.setCookie(
      SETUP_SESSION_COOKIE,
      createSetupSession(),
      cookieOpts(Math.floor(SETUP_SESSION_TTL_MS / 1000)),
    );
    if (isFormSubmit(req)) {
      return reply.code(303).header('location', '/setup').send();
    }
    return reply.type('application/json').send({ ok: true });
  });

  app.get('/setup', async (req, reply) => {
    applyHeaders(reply);
    // Sem sessão o operador recebe o PORTÃO (formulário), não um 403 seco:
    // é o único ponto da jornada em que o token é digitado, e ele vai no
    // corpo do POST.
    const headerToken = req.headers[SETUP_TOKEN_HEADER];
    const hasHeader = typeof headerToken === 'string' && headerToken.length > 0;
    if (!hasHeader && !verifySetupSession(cookies(req)[SETUP_SESSION_COOKIE])) {
      const csrf = setCsrfCookie(reply);
      return reply.code(401).type('text/html').send(renderTokenGate(csrf));
    }
    if (!(await authGate(req, reply))) return;

    const phaseObj = setupState.current();

    switch (phaseObj.phase) {
      case 'unpaired': {
        const csrf = setCsrfCookie(reply);
        return reply.type('text/html').send(renderChooser(csrf));
      }
      case 'pairing_qr':
        return reply.type('text/html').send(renderQr(phaseObj.qr));
      case 'pairing_code':
        return reply.type('text/html').send(renderCode(phaseObj.code, phaseObj.expiresAt));
      case 'connected':
        return reply
          .code(410)
          .type('text/html')
          .send(renderConnected(phaseObj.connectedAt, !!config.FEATURE_DASHBOARD));
      case 'disconnected_transient':
        return reply.code(503).type('text/html').send(renderTransientDisconnect());
      case 'recovering':
        return reply.code(503).type('text/html').send(renderRecovering());
    }
  });

  app.get('/setup/qr.png', async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const phaseObj = setupState.current();
    if (phaseObj.phase !== 'pairing_qr' || !phaseObj.qr) {
      return reply.code(404).type('text/plain').send('not found');
    }
    try {
      const buf = await qrToPngBuffer(phaseObj.qr);
      return reply.type('image/png').send(buf);
    } catch (err) {
      logger.error({ err }, 'setup.qr_png_render_failed');
      return reply.code(500).type('text/plain').send('qr render failed');
    }
  });

  app.post('/setup/start', async (req, reply) => {
    if (!(await authGate(req, reply))) return;
    if (!(await verifyCsrf(req, reply))) return;

    const body = (req.body ?? {}) as { method?: 'qr' | 'code'; csrf?: string };
    const fromForm = isFormSubmit(req);
    // Browsers submit the chooser as a plain HTML form, so on success/retry we
    // redirect them back to /setup — agora uma URL LIMPA (#518): a sessão
    // viaja no cookie, então o redirect não carrega segredo nenhum.
    const redirectToSetup = (): void => {
      reply.code(303).header('location', '/setup').send();
    };

    if (body.method !== 'qr' && body.method !== 'code') {
      return reply.code(400).type('application/json').send({ ok: false, error: 'invalid_method' });
    }
    const phase = setupState.current().phase;

    if (body.method === 'qr') {
      // Server-side no-op: Baileys' QR auto-transitions the state when emitted.
      // This endpoint exists for HTML form clarity. Conflict only if currently
      // in a non-unpaired/non-pairing_qr phase.
      if (phase !== 'unpaired' && phase !== 'pairing_qr') {
        return reply.code(409).type('application/json').send({ ok: false, phase });
      }
      if (fromForm) return redirectToSetup();
      return reply.type('application/json').send({ ok: true, phase: setupState.current().phase });
    }

    // method === 'code'
    if (phase !== 'unpaired') {
      return reply.code(409).type('application/json').send({ ok: false, phase });
    }
    try {
      const code = await triggerPairingCode(config.WHATSAPP_NUMBER_MAIA);
      setupState.setCode(code);
      await audit({ acao: 'pairing_code_requested' });
      if (fromForm) return redirectToSetup();
      return reply.type('application/json').send({ ok: true, phase: 'pairing_code' });
    } catch (err) {
      const msg = (err as Error).message;
      // Exact equality (not includes): the only producer of this string is the
      // socket-null guard in baileys.ts. Substring match would mis-classify any
      // future error containing this token as "retryable".
      if (msg === 'baileys_socket_not_ready') {
        if (fromForm) return redirectToSetup();
        return reply.code(503).type('application/json').send({ ok: false, retry_after_s: 2 });
      }
      logger.error({ err }, 'setup.trigger_pairing_code_failed');
      return reply.code(500).type('application/json').send({ ok: false, error: 'trigger_failed' });
    }
  });

  // Polled by the chooser page every 2s (POLL_INTERVAL_MS in templates.ts).
  // 2s polling = 30 req/min, which exactly matches the global rate-limit cap;
  // without this exemption a single operator session would starve the budget
  // for /setup, /setup/start and /setup/qr.png. Auth is still enforced via
  // authGate; payload is metadata only (raw QR/code never appear here).
  app.get('/setup/status', { config: { rateLimit: false } }, async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const phaseObj = setupState.current();
    // Build a status payload that NEVER includes the raw QR string. The QR
    // is delivered as a PNG via /setup/qr.png; only metadata is exposed here.
    const out: Record<string, unknown> = { phase: phaseObj.phase };
    if (phaseObj.phase === 'pairing_qr') {
      out.qr = phaseObj.qr ? 'available' : 'pending';
    }
    if (phaseObj.phase === 'pairing_code') {
      out.expiresAt = phaseObj.expiresAt.toISOString();
    }
    if (phaseObj.phase === 'connected') {
      out.connectedAt = phaseObj.connectedAt.toISOString();
    }
    return reply.type('application/json').send(out);
  });

  app.get('/setup/done', async (_req, reply) => {
    applyHeaders(reply);
    return reply.type('text/html').send(renderDone());
  });

  // ── §2.5 (spec roteamento v4) — pareamento de LINHAS ADICIONAIS ──────────
  //
  // ⚠️ LEGADO / BREAK-GLASS (issue #518). A jornada normal de pareamento de
  // linhas adicionais é o Admin UI autenticado (`channelLines.*`), que carrega
  // o ATOR administrativo até a auditoria e não expõe segredo algum. Estes
  // endpoints permanecem por um ciclo como caminho de emergência, e já NÃO
  // aceitam `?token=`: a prova de identidade é o cookie de sessão de operador
  // ou o header `x-maia-setup-token`.
  const linePairing = await import('./line-pairing.js');

  app.post('/setup/channels/:channelId/pair', async (req, reply) => {
    if (!(await authGate(req, reply))) return;
    const { channelId } = req.params as { channelId: string };
    const body = (req.body ?? {}) as { method?: 'qr' | 'code' };
    const method = body.method === 'code' ? ('code' as const) : ('qr' as const);
    const result = await linePairing.startChannelPairing({
      channel_id: channelId,
      method,
    });
    if (!result.ok) {
      const code =
        result.error === 'channel_not_found'
          ? 404
          : result.error === 'pairing_in_progress' || result.error === 'already_active'
            ? 409
            : 400;
      return reply.code(code).type('application/json').send({ ok: false, error: result.error });
    }
    return reply.type('application/json').send({ ok: true });
  });

  app.get(
    '/setup/channels/:channelId/pair/status',
    { config: { rateLimit: false } },
    async (req, reply) => {
      if (!(await authGate(req, reply))) return;
      const { channelId } = req.params as { channelId: string };
      const st = linePairing.channelPairingStatus(channelId);
      // O QR cru é entregue aqui (JSON de operador autenticado por sessão/
      // header) — esta superfície de break-glass não tem página HTML própria;
      // o consumidor renderiza o QR localmente. A jornada normal (Admin UI)
      // entrega o QR já renderizado e cifrado em repouso.
      return reply.type('application/json').send(st);
    },
  );

  app.post('/setup/channels/:channelId/pair/abort', async (req, reply) => {
    if (!(await authGate(req, reply))) return;
    const { channelId } = req.params as { channelId: string };
    await linePairing.abortChannelPairing(channelId);
    return reply.type('application/json').send({ ok: true });
  });
}
