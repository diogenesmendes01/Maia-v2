import { describe, it, expect } from 'vitest';
import {
  parseHolidayDescriptor,
  buildHolidayDescriptor,
  slugifyName,
} from '../../src/cognition/holiday-descriptor.js';

describe('holiday descriptor', () => {
  it('parses canonical municipal form', () => {
    const p = parseHolidayDescriptor(
      'holiday:imaculada-conceicao:12/8:municipal:550e8400-e29b-41d4-a716-446655440000',
    );
    expect(p.payload).toMatchObject({
      name: 'imaculada-conceicao',
      month: 12,
      day: 8,
      type: 'municipal',
      entidade_id: '550e8400-e29b-41d4-a716-446655440000',
      pattern_descriptor:
        'holiday:imaculada-conceicao:12/8:municipal:550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('parses global national form', () => {
    const p = parseHolidayDescriptor('holiday:dia-da-padaria:5/12:national:global');
    expect(p.payload.entidade_id).toBe('global');
  });

  it('rejects malformed input', () => {
    expect(() => parseHolidayDescriptor('not-a-holiday')).toThrow(/invalid holiday descriptor/);
    expect(() => parseHolidayDescriptor('holiday:x:13/8:municipal:abc')).toThrow(/invalid month/);
  });

  it('buildHolidayDescriptor é parsable de volta', () => {
    const built = buildHolidayDescriptor({
      name: 'Imaculada Conceição',
      month: 12,
      day: 8,
      type: 'municipal',
      entidade_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    const parsed = parseHolidayDescriptor(built);
    expect(parsed.payload.month).toBe(12);
    expect(parsed.payload.day).toBe(8);
  });

  it('slugifyName normaliza acentos', () => {
    expect(slugifyName('Imaculada Conceição')).toBe('imaculada-conceicao');
    expect(slugifyName('Páscoa')).toBe('pascoa');
    expect(slugifyName('OK & GO')).toBe('ok-go');
  });
});
