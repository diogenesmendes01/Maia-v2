import { describe, it, expect } from 'vitest';
import {
  parseRRule,
  usesBusinessDayExtension,
} from '../../src/scheduling/business-day-rrule.js';

describe('parseRRule extension', () => {
  it('parses FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=standard', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=standard');
    expect(rule.byNthWorkday).toBe(5);
    expect(rule.workdayKind).toBe('standard');
    expect(usesBusinessDayExtension(rule)).toBe(true);
  });

  it('parses FREQ=DAILY;BYWORKDAY=true', () => {
    const rule = parseRRule('FREQ=DAILY;BYWORKDAY=true');
    expect(rule.byWorkday).toBe(true);
    expect(usesBusinessDayExtension(rule)).toBe(true);
  });

  it('legacy FREQ=MONTHLY;BYMONTHDAY=15 não usa extensão', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYMONTHDAY=15');
    expect(usesBusinessDayExtension(rule)).toBe(false);
  });

  it('rejects BYNTHWORKDAY=29', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=29')).toThrow(/BYNTHWORKDAY must be in/);
  });

  it('rejects BYNTHWORKDAY=0', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=0')).toThrow();
  });

  it('rejects BYNTHWORKDAY with FREQ=WEEKLY', () => {
    expect(() => parseRRule('FREQ=WEEKLY;BYNTHWORKDAY=2;BYDAY=MO')).toThrow(
      /only valid with FREQ=MONTHLY/,
    );
  });

  it('rejects BYWORKDAY with FREQ=MONTHLY', () => {
    expect(() => parseRRule('FREQ=MONTHLY;BYWORKDAY=true')).toThrow(/only valid with FREQ=DAILY/);
  });

  it('rejects WORKDAY_KIND inválido', () => {
    expect(() =>
      parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=5;WORKDAY_KIND=foo'),
    ).toThrow(/standard\|clt/);
  });

  it('parses BYNTHWORKDAY=-1 (último DU)', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYNTHWORKDAY=-1');
    expect(rule.byNthWorkday).toBe(-1);
  });
});
