/**
 * P06 — a ligação de produção registra a rota com as dependências reais, e
 * as recusas que não precisam de banco (rede, credencial) acontecem antes de
 * qualquer consulta.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '@/config/env.js';
import { INFERENCE_GATEWAY_COMPLETIONS_PATH } from '@/integrations/hermes/inference-gateway.js';
import { registerHermesInferenceGateway } from '@/integrations/hermes/inference-wiring.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe('registerHermesInferenceGateway', () => {
  it('registra a rota: 401 sem credencial, 404 fora da rede interna', async () => {
    const app = Fastify();
    apps.push(app);
    await registerHermesInferenceGateway(app);
    await app.ready();
    const semCredencial = await app.inject({
      method: 'POST',
      url: INFERENCE_GATEWAY_COMPLETIONS_PATH,
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(semCredencial.statusCode).toBe(401);
    expect(semCredencial.json()).toMatchObject({ error: { code: 'invalid_inference_grant' } });
    const publica = await app.inject({
      method: 'POST',
      url: INFERENCE_GATEWAY_COMPLETIONS_PATH,
      remoteAddress: '203.0.113.9',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(publica.statusCode).toBe(404);
  });

  it('sem credencial do provider: registra a rota mesmo assim (o boot não depende do Hermes)', async () => {
    const cfg = config as { OPENROUTER_API_KEY?: string };
    const antes = cfg.OPENROUTER_API_KEY;
    cfg.OPENROUTER_API_KEY = '';
    try {
      const app = Fastify();
      apps.push(app);
      await registerHermesInferenceGateway(app);
      await app.ready();
      const r = await app.inject({
        method: 'POST',
        url: INFERENCE_GATEWAY_COMPLETIONS_PATH,
        remoteAddress: '127.0.0.1',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(r.statusCode).toBe(401);
    } finally {
      cfg.OPENROUTER_API_KEY = antes;
    }
  });
});
