/**
 * P07 — leitor NDJSON limitado do pipe do worker (§6.4.2).
 */
import { describe, it, expect } from 'vitest';
import { NdjsonLineSplitter } from '@/integrations/hermes/ndjson-lines.js';

const b = (s: string) => Buffer.from(s, 'utf8');

describe('NdjsonLineSplitter', () => {
  it('separa linhas completas e guarda o resto para o próximo chunk', () => {
    const s = new NdjsonLineSplitter(1024);
    expect(s.feed(b('{"a":1}\n{"b"'))).toEqual([{ kind: 'line', text: '{"a":1}' }]);
    expect(s.feed(b(':2}\n'))).toEqual([{ kind: 'line', text: '{"b":2}' }]);
  });

  it('remonta caractere UTF-8 partido entre dois chunks', () => {
    const s = new NdjsonLineSplitter(1024);
    const bytes = b('"ação"\n');
    expect(s.feed(bytes.subarray(0, 3))).toEqual([]);
    expect(s.feed(bytes.subarray(3))).toEqual([{ kind: 'line', text: '"ação"' }]);
  });

  it('aceita \\r\\n', () => {
    const s = new NdjsonLineSplitter(1024);
    expect(s.feed(b('{}\r\n'))).toEqual([{ kind: 'line', text: '{}' }]);
  });

  it('recusa UTF-8 inválido em vez de trocar por U+FFFD', () => {
    const s = new NdjsonLineSplitter(1024);
    expect(s.feed(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]))).toEqual([{ kind: 'invalid_utf8' }]);
  });

  it('linha acima do teto é overflow e FECHA o leitor, mesmo sem \\n', () => {
    const s = new NdjsonLineSplitter(8);
    expect(s.feed(b('12345'))).toEqual([]);
    const ev = s.feed(b('6789'));
    expect(ev).toEqual([{ kind: 'overflow', bytes: 9 }]);
    expect(s.closed).toBe(true);
    expect(s.feed(b('\n{}\n'))).toEqual([]);
    expect(s.end()).toEqual([]);
  });

  it('linha exatamente no teto passa', () => {
    const s = new NdjsonLineSplitter(4);
    expect(s.feed(b('1234\n'))).toEqual([{ kind: 'line', text: '1234' }]);
  });

  it('end() entrega a última linha sem \\n', () => {
    const s = new NdjsonLineSplitter(64);
    expect(s.feed(b('{"x":1}'))).toEqual([]);
    expect(s.end()).toEqual([{ kind: 'line', text: '{"x":1}' }]);
  });

  it('recusa teto inválido', () => {
    expect(() => new NdjsonLineSplitter(0)).toThrow(TypeError);
  });
});
