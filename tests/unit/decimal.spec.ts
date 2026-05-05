import { describe, it, expect } from 'vitest';
import { Decimal, toDecimal, fmtBRL, sumDecimal } from '../../src/lib/decimal.js';

describe('decimal — toDecimal', () => {
  it('parseia string Postgres', () => {
    expect(toDecimal('1234.56').toString()).toBe('1234.56');
  });

  it('parseia number JS', () => {
    expect(toDecimal(100).toString()).toBe('100');
  });

  it('null vira 0', () => {
    expect(toDecimal(null).toString()).toBe('0');
  });

  it('undefined vira 0', () => {
    expect(toDecimal(undefined).toString()).toBe('0');
  });

  it('string invalida lanca com mensagem clara', () => {
    expect(() => toDecimal('abc')).toThrow(/toDecimal/);
  });

  it('NaN number lanca', () => {
    expect(() => toDecimal(Number.NaN)).toThrow(/toDecimal/);
  });

  it('Infinity number lanca', () => {
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(/toDecimal/);
  });

  it('aceita Decimal e retorna a mesma referencia (no-op)', () => {
    const d = new Decimal('42');
    expect(toDecimal(d)).toBe(d);
  });
});

describe('decimal — aritmetica exata', () => {
  it('0.1 + 0.2 === 0.3 com Decimal (vs ponto flutuante JS)', () => {
    // Sanity check: o bug classico de IEEE-754 que motiva a lib.
    expect(0.1 + 0.2).not.toBe(0.3);
    // Solucao com Decimal:
    expect(toDecimal('0.1').plus(toDecimal('0.2')).toString()).toBe('0.3');
  });

  it('soma de centavos nao acumula erro', () => {
    // 100 vezes 0.01 deve ser exatamente 1.00 (ponto flutuante erra aqui).
    let acc = new Decimal(0);
    for (let i = 0; i < 100; i++) acc = acc.plus(toDecimal('0.01'));
    expect(acc.toString()).toBe('1');
  });

  it('subtracao preserva precisao decimal', () => {
    expect(toDecimal('1234.56').minus(toDecimal('234.56')).toString()).toBe('1000');
  });
});

describe('decimal — fmtBRL', () => {
  // Nota: Intl.NumberFormat 'pt-BR' insere um NBSP (U+00A0) entre "R$" e
  // o numero. Construimos o esperado via fromCharCode pra evitar caracter
  // irregular literal no fonte (que o ESLint reclama).
  const NBSP = String.fromCharCode(160);

  it('formata 1234.56 como R$ 1.234,56', () => {
    expect(fmtBRL(toDecimal('1234.56'))).toBe(`R$${NBSP}1.234,56`);
  });

  it('formata 0 como R$ 0,00', () => {
    expect(fmtBRL(toDecimal(0))).toBe(`R$${NBSP}0,00`);
  });

  it('formata valor negativo', () => {
    expect(fmtBRL(toDecimal('-50.5'))).toBe(`-R$${NBSP}50,50`);
  });
});

describe('decimal — sumDecimal', () => {
  it('soma lista de strings Postgres exatamente', () => {
    expect(sumDecimal(['100.10', '200.20', '300.30']).toString()).toBe('600.6');
  });

  it('soma mista de string/number/null/Decimal', () => {
    const result = sumDecimal(['10.50', 20, null, new Decimal('5.25'), undefined]);
    expect(result.toString()).toBe('35.75');
  });

  it('lista vazia vira 0', () => {
    expect(sumDecimal([]).toString()).toBe('0');
  });

  it('100 itens de 0.01 viram 1 exato (sem erro flutuante)', () => {
    const items = new Array(100).fill('0.01');
    expect(sumDecimal(items).toString()).toBe('1');
  });
});
