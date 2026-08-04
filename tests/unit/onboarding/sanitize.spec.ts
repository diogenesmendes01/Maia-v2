/**
 * Issue #519 — "segredos, QR codes, tokens e credenciais não entram em URL,
 * evento, auditoria ou log". `sanitizeForPersistence` é o gate único das três
 * colunas jsonb da saga.
 */
import { describe, it, expect } from 'vitest';
import { isDeniedKey, sanitizeForPersistence } from '../../../src/onboarding/sanitize.js';

describe('isDeniedKey', () => {
  it.each([
    'secret',
    'client_secret',
    'SENHA',
    'password',
    'session_token',
    'apiKey',
    'api_key',
    'Authorization',
    'cookie',
    'qr',
    'qr_code',
    'pairing_code',
    'pairing_material',
    'external_id',
    'telefone_whatsapp',
    'phone',
    'email',
    'user_email',
    'cpf',
    'cnpj',
    'documento',
  ])("bloqueia '%s'", (key) => {
    expect(isDeniedKey(key)).toBe(true);
  });

  it.each(['tenant_id', 'agent_id', 'run_id', 'step', 'state', 'channel_id', 'role_key'])(
    "permite '%s'",
    (key) => {
      expect(isDeniedKey(key)).toBe(false);
    },
  );
});

describe('sanitizeForPersistence', () => {
  it('redige o valor mas PRESERVA a chave — a redação precisa ser visível', () => {
    expect(sanitizeForPersistence({ tenant_id: 'acme', senha: 'hunter2' })).toEqual({
      tenant_id: 'acme',
      senha: '[redacted]',
    });
  });

  it('redige em profundidade', () => {
    expect(
      sanitizeForPersistence({ linha: { channel_id: 'c1', external_id: '+5511999999999' } }),
    ).toEqual({ linha: { channel_id: 'c1', external_id: '[redacted]' } });
  });

  it('redige dentro de arrays de objetos', () => {
    expect(sanitizeForPersistence({ users: [{ id: 'u1', email: 'a@b.com' }] })).toEqual({
      users: [{ id: 'u1', email: '[redacted]' }],
    });
  });

  it('trunca strings longas', () => {
    const out = sanitizeForPersistence({ nota: 'x'.repeat(2000) }) as { nota: string };
    expect(out.nota.length).toBeLessThan(600);
    expect(out.nota.endsWith('…[truncated]')).toBe(true);
  });

  it('limita arrays', () => {
    const out = sanitizeForPersistence({ xs: Array.from({ length: 200 }, (_, i) => i) }) as {
      xs: unknown[];
    };
    expect(out.xs.length).toBe(51);
    expect(out.xs[50]).toBe('…+150');
  });

  it('corta profundidade excessiva', () => {
    let deep: Record<string, unknown> = { leaf: 'v' };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    const json = JSON.stringify(sanitizeForPersistence(deep));
    expect(json).toContain('[depth-limit]');
  });

  it('sempre devolve um objeto (a coluna é jsonb NOT NULL)', () => {
    expect(sanitizeForPersistence(null)).toEqual({ value: null });
    expect(sanitizeForPersistence('texto')).toEqual({ value: 'texto' });
    expect(sanitizeForPersistence([1, 2])).toEqual({ value: [1, 2] });
  });

  it('normaliza Date e recusa tipos que não pertencem a um jsonb', () => {
    expect(sanitizeForPersistence({ d: new Date('2026-08-04T00:00:00Z') })).toEqual({
      d: '2026-08-04T00:00:00.000Z',
    });
    expect(sanitizeForPersistence({ f: () => 1 })).toEqual({ f: '[unsupported]' });
  });
});
