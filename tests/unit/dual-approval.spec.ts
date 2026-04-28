import { describe, it, expect } from 'vitest';
import { requiresDualApproval } from '../../src/governance/dual-approval.js';

describe('dual approval triggers', () => {
  it('valor abaixo do threshold não exige', () => {
    expect(
      requiresDualApproval({
        tool: 'register_transaction',
        args: { valor: 1000, metadata: { tipo: 'cartao' } },
      }).required,
    ).toBe(false);
  });

  it('valor acima do threshold exige', () => {
    expect(
      requiresDualApproval({
        tool: 'register_transaction',
        args: { valor: 25000, metadata: { tipo: 'cartao' } },
      }).required,
    ).toBe(true);
  });

  it('PIX sempre exige', () => {
    expect(
      requiresDualApproval({
        tool: 'register_transaction',
        args: { valor: 50, metadata: { tipo: 'pix' } },
      }).required,
    ).toBe(true);
  });

  it('TED sempre exige', () => {
    expect(
      requiresDualApproval({
        tool: 'register_transaction',
        args: { valor: 100, metadata: { tipo: 'ted' } },
      }).required,
    ).toBe(true);
  });

  it('mudança de conta bancária exige', () => {
    expect(requiresDualApproval({ tool: 'update_conta_bancaria', args: {} }).required).toBe(true);
  });

  it('cadastrar contraparte exige', () => {
    expect(requiresDualApproval({ tool: 'create_contraparte', args: {} }).required).toBe(true);
  });

  it('mudar permissão exige', () => {
    expect(requiresDualApproval({ tool: 'change_permission', args: {} }).required).toBe(true);
  });
});
