import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/setup', async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const token = (req.query as { token: string }).token;
    const phaseObj = setupState.current();

    switch (phaseObj.phase) {
      case 'unpaired':
        return reply.type('text/html').send(renderChooser(token));
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

    const body = (req.body ?? {}) as { method?: 'qr' | 'code' };
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
      return reply.type('application/json').send({ ok: true, phase: 'pairing_code' });
    } catch (err) {
      const msg = (err as Error).message;
      // Exact equality (not includes): the only producer of this string is the
      // socket-null guard in baileys.ts. Substring match would mis-classify any
      // future error containing this token as "retryable".
      if (msg === 'baileys_socket_not_ready') {
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
