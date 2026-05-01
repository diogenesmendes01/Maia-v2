import { describe, it, expect } from 'vitest';
import {
  isValidCPF,
  formatCPF,
  isValidCNPJ,
  formatCNPJ,
  classifyDocument,
  detectPixKey,
  isValidEndToEndId,
  normalizePhoneBR,
  parseBRL,
  formatBRL,
  isValidLinhaDigitavel,
} from '../../src/lib/brazilian.js';

describe('brazilian — CPF', () => {
  it('valida CPFs reais', () => {
    expect(isValidCPF('11144477735')).toBe(true);
    expect(isValidCPF('111.444.777-35')).toBe(true);
  });
  it('rejeita CPFs com dígitos repetidos', () => {
    expect(isValidCPF('11111111111')).toBe(false);
  });
  it('rejeita CPFs com tamanho errado', () => {
    expect(isValidCPF('123')).toBe(false);
  });
  it('formata CPF', () => {
    expect(formatCPF('11144477735')).toBe('111.444.777-35');
  });
});

describe('brazilian — CNPJ', () => {
  it('valida CNPJs reais', () => {
    expect(isValidCNPJ('11222333000181')).toBe(true);
    expect(isValidCNPJ('11.222.333/0001-81')).toBe(true);
  });
  it('rejeita CNPJ inválido', () => {
    expect(isValidCNPJ('11222333000182')).toBe(false);
  });
  it('formata CNPJ', () => {
    expect(formatCNPJ('11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('brazilian — classifyDocument', () => {
  it('detecta CPF', () => {
    expect(classifyDocument('111.444.777-35')).toEqual({ kind: 'cpf', canonical: '11144477735' });
  });
  it('detecta CNPJ', () => {
    expect(classifyDocument('11.222.333/0001-81')).toEqual({
      kind: 'cnpj',
      canonical: '11222333000181',
    });
  });
  it('marca inválido', () => {
    expect(classifyDocument('123').kind).toBe('invalid');
  });
});

describe('brazilian — PIX key', () => {
  it('detecta CPF', () => {
    expect(detectPixKey('111.444.777-35')).toEqual({ kind: 'cpf', canonical: '11144477735' });
  });
  it('detecta email', () => {
    expect(detectPixKey('foo@example.com')).toEqual({
      kind: 'email',
      canonical: 'foo@example.com',
    });
  });
  it('detecta telefone', () => {
    expect(detectPixKey('+5511999999999')?.kind).toBe('phone');
  });
  it('detecta chave aleatória', () => {
    expect(detectPixKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')?.kind).toBe('random');
  });
  it('valida endToEndId', () => {
    expect(isValidEndToEndId('E12345678' + '202604281200' + 'ABCDEF123456')).toBe(true);
    expect(isValidEndToEndId('XYZ')).toBe(false);
  });
});

describe('brazilian — phone', () => {
  it('normaliza com DDI', () => {
    expect(normalizePhoneBR('+55 11 99999-9999')).toBe('+5511999999999');
  });
  it('normaliza sem DDI', () => {
    expect(normalizePhoneBR('11 99999-9999')).toBe('+5511999999999');
  });
  it('rejeita inválido', () => {
    expect(normalizePhoneBR('123')).toBe(null);
  });
  it('rejeita móvel sem 9 inicial', () => {
    expect(normalizePhoneBR('+5511899999999')).toBe(null);
  });
});

describe('brazilian — currency', () => {
  it('parseia formato BR', () => {
    expect(parseBRL('R$ 1.234,56')).toBe(1234.56);
    expect(parseBRL('1.234,56')).toBe(1234.56);
    expect(parseBRL('R$ 50')).toBe(50);
    expect(parseBRL('50,00')).toBe(50);
    expect(parseBRL('50.00')).toBe(50);
  });
  it('parseia negativo', () => {
    expect(parseBRL('-R$ 50,00')).toBe(-50);
  });
  it('formata BR', () => {
    const formatted = formatBRL(1234.56);
    expect(formatted.replace(/\u00A0/g, ' ')).toBe('R$ 1.234,56');
  });
});

describe('brazilian — boleto', () => {
  it('rejeita linha com tamanho errado', () => {
    expect(isValidLinhaDigitavel('123')).toBe(false);
  });
});
