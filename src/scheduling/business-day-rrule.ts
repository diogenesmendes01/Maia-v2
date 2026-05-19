/**
 * Extensão do parser RRULE para "N° dia útil do mês" (BYNTHWORKDAY) e
 * pular feriados em DAILY (BYWORKDAY=true) — com WORKDAY_KIND opcional.
 *
 * Mantém compat com `src/scheduling/rrule.ts` (síncrono): se a regra não usa
 * extensões, delega para o parser/computeNext legado. Quando usa, o caller
 * DEVE invocar `computeNextWithBusinessDays` (async) para resolver via DB.
 *
 * Sintaxe nova:
 *   FREQ=MONTHLY;BYNTHWORKDAY=<n>;WORKDAY_KIND=<standard|clt>
 *     n ∈ [1..28] ∪ {-1}: n-ésimo dia útil do mês; -1 = último
 *   FREQ=DAILY;BYWORKDAY=true
 *     pula sáb/dom/feriado para próximo dia útil
 *
 * Skip direction sempre `next` (prorroga). Spec §4.6.
 */
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { parseRRule as parseLegacyRRule, computeNext as computeNextLegacy } from './rrule.js';
import type { ParsedRRule as LegacyParsed } from './rrule.js';
import type { MonthEndPolicy } from './types.js';
import {
  isBusinessDayBR,
  getNthBusinessDayOfMonth,
  nextBusinessDayBR,
  type BusinessDayKind,
  type BusinessDayOptions,
} from '../lib/business-days.js';

const TZ = 'America/Sao_Paulo';

export type ExtendedParsedRRule = LegacyParsed & {
  byNthWorkday?: number;        // 1..28 | -1
  byWorkday?: boolean;
  workdayKind?: BusinessDayKind;
};

/**
 * Parser estendido — primeiro tenta o parser legacy; em paralelo escaneia
 * BYNTHWORKDAY/BYWORKDAY/WORKDAY_KIND. Se uma extensão é usada, retorna
 * marcada (caller usa computeNextWithBusinessDays).
 */
export function parseRRule(s: string): ExtendedParsedRRule {
  const parts = s
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (!k || v === undefined) throw new Error(`rrule: malformed segment "${p}"`);
    kv[k.toUpperCase()] = v;
  }

  const hasNthWorkday = kv['BYNTHWORKDAY'] !== undefined;
  const hasByWorkday = kv['BYWORKDAY'] !== undefined;

  if (!hasNthWorkday && !hasByWorkday) {
    // Sem extensão → delega.
    return parseLegacyRRule(s);
  }

  // Construímos um RRULE compatível para o parser legacy aceitar.
  // BYNTHWORKDAY → FREQ=MONTHLY (sem BYMONTHDAY, vamos resolver na hora).
  // BYWORKDAY → FREQ=DAILY.
  const freq = kv['FREQ'];
  if (hasNthWorkday && freq !== 'MONTHLY') {
    throw new Error('rrule: BYNTHWORKDAY only valid with FREQ=MONTHLY');
  }
  if (hasByWorkday && freq !== 'DAILY') {
    throw new Error('rrule: BYWORKDAY only valid with FREQ=DAILY');
  }

  const byhour = kv['BYHOUR'] !== undefined ? parseInt(kv['BYHOUR'], 10) : 9;
  const byminute = kv['BYMINUTE'] !== undefined ? parseInt(kv['BYMINUTE'], 10) : 0;
  if (!Number.isInteger(byhour) || byhour < 0 || byhour > 23) {
    throw new Error('rrule: BYHOUR out of range');
  }
  if (!Number.isInteger(byminute) || byminute < 0 || byminute > 59) {
    throw new Error('rrule: BYMINUTE out of range');
  }

  const parsed: ExtendedParsedRRule = {
    freq: freq as 'DAILY' | 'WEEKLY' | 'MONTHLY',
    byhour,
    byminute,
  };

  if (hasNthWorkday) {
    const nRaw = parseInt(kv['BYNTHWORKDAY']!, 10);
    if (!Number.isInteger(nRaw) || (nRaw !== -1 && (nRaw < 1 || nRaw > 28))) {
      throw new Error('rrule: BYNTHWORKDAY must be in [1..28] or -1');
    }
    parsed.byNthWorkday = nRaw;
  }

  if (hasByWorkday) {
    const v = kv['BYWORKDAY']!.toLowerCase();
    if (v !== 'true' && v !== 'false' && v !== '1' && v !== '0') {
      throw new Error('rrule: BYWORKDAY must be true|false');
    }
    parsed.byWorkday = v === 'true' || v === '1';
  }

  if (kv['WORKDAY_KIND'] !== undefined) {
    const k = kv['WORKDAY_KIND'].toLowerCase();
    if (k !== 'standard' && k !== 'clt') {
      throw new Error('rrule: WORKDAY_KIND must be standard|clt');
    }
    parsed.workdayKind = k;
  }

  return parsed;
}

/**
 * Indica se a regra parseada usa extensões business-day (precisa async).
 */
export function usesBusinessDayExtension(rule: ExtendedParsedRRule | string): boolean {
  const r = typeof rule === 'string' ? parseRRule(rule) : rule;
  return r.byNthWorkday !== undefined || r.byWorkday === true;
}

/**
 * Versão async que lida com BYNTHWORKDAY/BYWORKDAY (precisa DB lookup), e
 * delega para `computeNext` legacy quando regra é puramente sync.
 *
 * Skip direction sempre `next` (prorroga p/ próximo dia útil).
 */
export async function computeNextWithBusinessDays(
  rule: ExtendedParsedRRule | string,
  after: Date,
  options?: {
    monthEndPolicy?: MonthEndPolicy;
    entidadeId?: string;
  },
): Promise<Date> {
  const r = typeof rule === 'string' ? parseRRule(rule) : rule;
  const bdOpts: BusinessDayOptions = {
    kind: r.workdayKind ?? 'standard',
    entidadeId: options?.entidadeId,
  };

  // Caso BYNTHWORKDAY: itera por meses até achar match estritamente depois de `after`.
  if (r.byNthWorkday !== undefined) {
    const startZ = toZonedTime(after, TZ);
    for (let m = 0; m < 24; m++) {
      const probe = new Date(startZ);
      probe.setDate(1);
      probe.setMonth(probe.getMonth() + m);
      const target = await getNthBusinessDayOfMonth(
        probe.getFullYear(),
        probe.getMonth(),
        r.byNthWorkday,
        bdOpts,
      );
      // target vem UTC mas representa um calendar-day; aplicar HH:MM em TZ.
      const targetTz = new Date(target);
      targetTz.setUTCHours(r.byhour, r.byminute, 0, 0);
      // O `target` é Date.UTC do calendar-day. Re-aplica como TZ local.
      const local = new Date(target);
      local.setUTCHours(0, 0, 0, 0); // garante meia-noite UTC
      // Build a TZ-local datetime: pegar y/m/d do UTC date e formatar em TZ local.
      const y = target.getUTCFullYear();
      const mo = target.getUTCMonth();
      const d = target.getUTCDate();
      const localTz = new Date(y, mo, d, r.byhour, r.byminute, 0, 0);
      const candidate = fromZonedTime(localTz, TZ);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    throw new Error('rrule: no BYNTHWORKDAY match within 24 months');
  }

  // Caso BYWORKDAY (DAILY): primeiro tenta o candidato do MESMO calendar-day
  // local (BR), retornando-o se o dia for útil e o horário ainda for futuro
  // em relação a `after`. Codex review #105 round-2 (medium): a versão
  // anterior delegava direto para `nextBusinessDayBR(after)` que avança no
  // mínimo +1 calendar-day, então `FREQ=DAILY;BYWORKDAY=true;BYHOUR=9`
  // criado às 08:00 de um dia útil agendava amanhã 09:00 em vez de hoje
  // 09:00 — pulando silenciosamente uma execução válida (mesmo-dia).
  // Comportamento legacy (RRULE puro sem BYWORKDAY) inclui o mesmo-dia, e
  // a extensão DEVE preservá-lo.
  if (r.byWorkday === true) {
    // Hoje em TZ local (BR) — y/m/d do calendar-day de `after`.
    const afterZ = toZonedTime(after, TZ);
    const todayY = afterZ.getFullYear();
    const todayMo = afterZ.getMonth();
    const todayD = afterZ.getDate();
    const todayLocal = new Date(todayY, todayMo, todayD, r.byhour, r.byminute, 0, 0);
    const todayCandidate = fromZonedTime(todayLocal, TZ);
    // Para checar se hoje é dia útil pelo calendar-day BR, montamos um Date
    // UTC ancorado nesse y/m/d (à meia-noite UTC) — é o contrato esperado
    // pelos helpers `isBusinessDayBR` / `nextBusinessDayBR` que usam
    // getUTCFullYear/Month/Date sobre o argumento.
    const todayUtcAnchor = new Date(Date.UTC(todayY, todayMo, todayD));
    if (
      todayCandidate.getTime() > after.getTime() &&
      (await isBusinessDayBR(todayUtcAnchor, bdOpts))
    ) {
      return todayCandidate;
    }
    // Senão (hoje não é dia útil, ou horário do dia já passou): avança.
    const next = await nextBusinessDayBR(todayUtcAnchor, bdOpts);
    const y = next.getUTCFullYear();
    const mo = next.getUTCMonth();
    const d = next.getUTCDate();
    const localTz = new Date(y, mo, d, r.byhour, r.byminute, 0, 0);
    return fromZonedTime(localTz, TZ);
  }

  // Caso normal — delega ao parser/engine legacy, mas se BYMONTHDAY pousa em
  // feriado, prorroga para próximo dia útil.
  // Construímos a string de volta a partir de r (a forma mais simples é
  // chamar computeNextLegacy com o objeto original).
  const candidate = computeNextLegacy(r as LegacyParsed, after, options?.monthEndPolicy);
  if (await isBusinessDayBR(candidate, bdOpts)) return candidate;
  // Prorroga para próximo dia útil mantendo HH:MM.
  const next = await nextBusinessDayBR(candidate, bdOpts);
  const y = next.getUTCFullYear();
  const mo = next.getUTCMonth();
  const d = next.getUTCDate();
  const localTz = new Date(y, mo, d, r.byhour, r.byminute, 0, 0);
  return fromZonedTime(localTz, TZ);
}
