import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  computeIntentHash,
  requiredApprovalsFor,
  dualClassFor,
  approvalRef,
  INTENT_HASH_VERSION,
} from '../../src/governance/approval-requests.js';
import type { Pessoa } from '../../src/db/schema.js';

const pessoa = (tipo: Pessoa['tipo']): Pessoa => ({
  id: 'p1',
  nome: 'Joana',
  apelido: null,
  telefone_whatsapp: '+5511999999999',
  tipo,
  email: null,
  observacoes: null,
  preferencias: {},
  modelo_mental: {},
  status: 'ativa',
  created_at: new Date(),
  updated_at: new Date(),
});

describe('canonicalJson', () => {
  it('ordena chaves recursivamente', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('preserva ordem de arrays', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
  it('omite undefined em objetos (semântica JSON)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it('é estável para permutações do mesmo objeto', () => {
    expect(canonicalJson({ x: 1, y: [true, null], z: 's' })).toBe(
      canonicalJson({ z: 's', y: [true, null], x: 1 }),
    );
  });
});

describe('computeIntentHash', () => {
  const base = {
    tenant_id: 'primary',
    agent_id: 'maia',
    requester_pessoa_id: 'p1',
    entidade_id: 'e1',
    tool: 'register_transaction',
    operation_type: 'create',
    args: { valor: 25000, natureza: 'despesa' },
    approval_class: 'two_distinct_owners' as const,
  };

  it('é versionado e determinístico', () => {
    const h1 = computeIntentHash(base);
    const h2 = computeIntentHash({ ...base, args: { natureza: 'despesa', valor: 25000 } });
    expect(h1).toBe(h2);
    expect(h1.startsWith(`v${INTENT_HASH_VERSION}:`)).toBe(true);
  });

  it.each([
    ['valor', { args: { valor: 25001, natureza: 'despesa' } }],
    ['tool', { tool: 'refund_create' }],
    ['entidade', { entidade_id: 'e2' }],
    ['requester', { requester_pessoa_id: 'p2' }],
    ['tenant', { tenant_id: 'other' }],
    ['classe', { approval_class: 'requester_plus_one_owner' as const }],
  ])('mudar %s muda o hash', (_label, override) => {
    expect(computeIntentHash({ ...base, ...override })).not.toBe(computeIntentHash(base));
  });
});

describe('classes de aprovação', () => {
  it('single_confirmation exige 1; duais exigem 2', () => {
    expect(requiredApprovalsFor('single_confirmation')).toBe(1);
    expect(requiredApprovalsFor('requester_plus_one_owner')).toBe(2);
    expect(requiredApprovalsFor('two_distinct_owners')).toBe(2);
  });
  it('requester dono/co-dono usa requester_plus_one_owner', () => {
    expect(dualClassFor(pessoa('dono'))).toBe('requester_plus_one_owner');
    expect(dualClassFor(pessoa('co_dono'))).toBe('requester_plus_one_owner');
  });
  it('requester não-owner usa two_distinct_owners', () => {
    expect(dualClassFor(pessoa('contador'))).toBe('two_distinct_owners');
  });
});

describe('approvalRef', () => {
  it('usa o prefixo de 8 hex do id', () => {
    expect(approvalRef({ id: 'abcdef12-3456-7890-abcd-ef1234567890' })).toBe('AP-abcdef12');
  });
});
