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

async function verifyCsrf(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const cookieToken = (req.cookies as Record<string, string | undefined> | undefined)?.[CSRF_COOKIE_NAME] ?? '';
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

async function authGate(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const presented =
    typeof (req.query as { token?: string }).token === 'string'
      ? (req.query as { token: string }).token
      : '';
  const actual = await ensureToken();
  applyHeaders(reply);
  if (!verifyToken(presented, actual)) {
    await audit({
      acao: 'setup_unauthorized_access',
      metadata: {
        ip: (req.ip ?? 'unknown').slice(0, 64),
        ua: (req.headers['user-agent'] ?? 'unknown').slice(0, 200),
      },
    });
    reply.code(403).type('text/plain').send('forbidden');
    return false;
  }
  return true;
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

  app.get('/setup', async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const token = (req.query as { token: string }).token;
    const phaseObj = setupState.current();

    switch (phaseObj.phase) {
      case 'unpaired': {
        const csrf = newCsrf();
        reply.setCookie(CSRF_COOKIE_NAME, csrf, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          maxAge: CSRF_COOKIE_MAX_AGE_S,
          secure: false, // dev/local; nginx terminates TLS in prod (see runbook)
        });
        return reply.type('text/html').send(renderChooser(token, csrf));
      }
      case 'pairing_qr':
        return reply.type('text/html').send(renderQr(token, phaseObj.qr));
      case 'pairing_code':
        return reply.type('text/html').send(
          renderCode(token, phaseObj.code, phaseObj.expiresAt),
        );
      case 'connected':
        return reply
          .code(410)
          .type('text/html')
          .send(renderConnected(phaseObj.connectedAt, !!config.FEATURE_DASHBOARD));
      case 'disconnected_transient':
        return reply.code(503).type('text/html').send(renderTransientDisconnect(token));
      case 'recovering':
        return reply.code(503).type('text/html').send(renderRecovering(token));
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
    // Browsers submit the chooser as a plain HTML form, so on success/retry
    // we redirect them back to /setup with the same token. The page then
    // reflects the new state (chooser still / QR / code) via the existing
    // polling JS. JSON callers (programmatic / tests) keep getting JSON.
    const redirectToSetup = (): void => {
      const token = (req.query as { token?: string }).token ?? '';
      reply.code(303).header('location', `/setup?token=${encodeURIComponent(token)}`).send();
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

  app.get('/setup/status', async (req, reply) => {
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
}
