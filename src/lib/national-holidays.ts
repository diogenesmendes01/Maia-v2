/**
 * Feriados nacionais brasileiros — fixos + móveis derivados de Easter.
 * Lista fixos representa as 9 datas de calendário fixas reconhecidas pelo país
 * em 2026 (Lei 662/49 + Lei 14.759/23, Consciência Negra). Móveis são derivados
 * via algoritmo Easter (Meeus-Jones-Butcher).
 */
import { easter } from './easter.js';

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export interface NationalHolidayLike {
  name: string;
  date: Date;
  type: 'national';
}

export function nationalMovingHolidays(year: number): NationalHolidayLike[] {
  const e = easter(year);
  return [
    { name: 'Carnaval — Segunda', date: addDays(e, -48), type: 'national' },
    { name: 'Carnaval — Terça', date: addDays(e, -47), type: 'national' },
    { name: 'Sexta-feira Santa', date: addDays(e, -2), type: 'national' },
    { name: 'Páscoa', date: e, type: 'national' },
    { name: 'Corpus Christi', date: addDays(e, 60), type: 'national' },
  ];
}

export const NATIONAL_FIXED: ReadonlyArray<{ name: string; month: number; day: number }> = [
  { name: 'Confraternização Universal', month: 1, day: 1 },
  { name: 'Tiradentes', month: 4, day: 21 },
  { name: 'Dia do Trabalho', month: 5, day: 1 },
  { name: 'Independência', month: 9, day: 7 },
  { name: 'N. Sra. Aparecida', month: 10, day: 12 },
  { name: 'Finados', month: 11, day: 2 },
  { name: 'Proclamação da República', month: 11, day: 15 },
  { name: 'Consciência Negra', month: 11, day: 20 },
  { name: 'Natal', month: 12, day: 25 },
];
