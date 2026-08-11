/**
 * Issue #519 — "segredos, QR codes, tokens e credenciais não entram em URL,
 * evento, auditoria ou log". `sanitizeForPersistence` é o gate único das três
 * colunas jsonb da saga.
 */
import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_CANCEL_REASONS,
  isDeniedKey,
  parseCancelReason,
  projectRunMetadata,
  sanitizeForPersistence,
} from '../../../src/onboarding/sanitize.js';
import { OnboardingError } from '../../../src/onboarding/errors.js';

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

/**
 * [Medium] da review do PR #541, achado 5 — o BURACO da denylist de chave.
 *
 * A denylist decide pelo NOME do campo e nunca olha o valor (por desenho:
 * heurística sobre valor falha em silêncio). O problema é que as duas
 * superfícies livres da saga não tinham nome de chave sob controle do backend:
 * `metadata` era `Record<string, unknown>` arbitrário e `reason_code` era texto
 * livre persistido em `last_error_code`, no evento e na auditoria.
 *
 * O primeiro caso abaixo DEMONSTRA o buraco (a denylist sozinha realmente deixa
 * passar), e os seguintes provam que ele foi fechado na ENTRADA, que é onde uma
 * superfície livre se fecha.
 */
describe('achado 5 — a denylist de chave não fecha texto livre; o schema tipado fecha', () => {
  it('a denylist sozinha DEIXA PASSAR PII sob uma chave permitida', () => {
    // Demonstração do defeito, não do comportamento desejado: `note` é um nome
    // inofensivo, então o valor inteiro sobrevive à sanitização.
    const out = sanitizeForPersistence({
      note: 'token abc / telefone +5511987654321 / e-mail joao@acme.com',
    });
    expect(out.note).toContain('+5511987654321');
    expect(isDeniedKey('note')).toBe(false);
  });

  it('`projectRunMetadata` RECUSA a chave desconhecida — ela nunca chega ao jsonb', () => {
    expect(() =>
      projectRunMetadata({ source: 'console', note: 'telefone +5511987654321' }),
    ).toThrow(OnboardingError);
    try {
      projectRunMetadata({ source: 'console', note: 'x' });
    } catch (err) {
      expect((err as OnboardingError).code).toBe('invalid_scope');
    }
  });

  it('projeta SÓ os campos aprovados, montados um a um', () => {
    expect(projectRunMetadata({ source: 'cli', intent: 'migration', ticket_ref: 'OPS-42' })).toEqual({
      source: 'cli',
      intent: 'migration',
      ticket_ref: 'OPS-42',
    });
    expect(projectRunMetadata(undefined)).toEqual({ source: 'console' });
  });

  it.each([
    { source: 'whatsapp' },
    { source: 'console', intent: 'qualquer-coisa' },
    { source: 'console', ticket_ref: 'ligar para +5511987654321' },
    { source: 'console', ticket_ref: 'joao@acme.com' },
  ])('valor fora do vocabulário é recusado: %j', (raw) => {
    expect(() => projectRunMetadata(raw)).toThrow(OnboardingError);
  });

  it('`parseCancelReason` só aceita o vocabulário fechado', () => {
    for (const reason of ONBOARDING_CANCEL_REASONS) {
      expect(parseCancelReason(reason)).toBe(reason);
    }
    for (const raw of [
      'cliente +5511987654321 desistiu',
      'joao@acme.com pediu cancelamento',
      'motivo livre',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(() => parseCancelReason(raw)).toThrow(OnboardingError);
    }
  });

  it('o vocabulário de cancelamento é SUBCONJUNTO do vocabulário de métrica', async () => {
    // A propriedade que faz trilha e série dizerem a mesma coisa: o valor
    // persistido em `last_error_code` é exatamente o que vira label.
    const { ONBOARDING_REASONS } = await import('../../../src/observability/taxonomy.js');
    for (const reason of ONBOARDING_CANCEL_REASONS) {
      expect(ONBOARDING_REASONS).toContain(reason);
    }
  });
});
