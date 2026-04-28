import { describe, it, expect } from 'vitest';
import { computeIdempotencyKey } from '../../src/governance/idempotency.js';

describe('idempotency — textual', () => {
  const base = {
    pessoa_id: '11111111-1111-1111-1111-111111111111',
    entity_id: '22222222-2222-2222-2222-222222222222',
    tool_name: 'register_transaction',
    operation_type: 'create',
    payload: { valor: 50, descricao: 'Mercado', data_competencia: '2026-04-28' },
  };

  it('mesma operação no mesmo bucket → mesma key', () => {
    const t = new Date('2026-04-28T14:32:00Z');
    const k1 = computeIdempotencyKey({ ...base, timestamp: t });
    const k2 = computeIdempotencyKey({ ...base, timestamp: new Date(t.getTime() + 30_000) });
    expect(k1).toBe(k2);
  });

  it('descricao com case/acento diferentes → mesma key (normalizada)', () => {
    const t = new Date('2026-04-28T14:32:00Z');
    const k1 = computeIdempotencyKey({ ...base, timestamp: t });
    const k2 = computeIdempotencyKey({
      ...base,
      payload: { ...base.payload, descricao: 'mercado' },
      timestamp: t,
    });
    expect(k1).toBe(k2);
  });

  it('valor diferente → key diferente', () => {
    const t = new Date('2026-04-28T14:32:00Z');
    const k1 = computeIdempotencyKey({ ...base, timestamp: t });
    const k2 = computeIdempotencyKey({
      ...base,
      payload: { ...base.payload, valor: 51 },
      timestamp: t,
    });
    expect(k1).not.toBe(k2);
  });

  it('bucket diferente (5 min) → key diferente', () => {
    const t1 = new Date('2026-04-28T14:32:00Z');
    const t2 = new Date('2026-04-28T14:38:00Z');
    const k1 = computeIdempotencyKey({ ...base, timestamp: t1 });
    const k2 = computeIdempotencyKey({ ...base, timestamp: t2 });
    expect(k1).not.toBe(k2);
  });
});

describe('idempotency — file-based', () => {
  it('arquivo igual → mesma key independente de timestamp', () => {
    const k1 = computeIdempotencyKey({
      pessoa_id: 'a',
      entity_id: 'b',
      tool_name: 'parse_boleto',
      operation_type: 'parse_only',
      payload: {},
      file_sha256: 'abc',
      timestamp: new Date('2026-01-01'),
    });
    const k2 = computeIdempotencyKey({
      pessoa_id: 'a',
      entity_id: 'b',
      tool_name: 'parse_boleto',
      operation_type: 'parse_only',
      payload: {},
      file_sha256: 'abc',
      timestamp: new Date('2026-12-01'),
    });
    expect(k1).toBe(k2);
  });
});
