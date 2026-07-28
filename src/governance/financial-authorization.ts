/**
 * Fase 0 — política financeira determinística (auditoria P0, capítulo 1).
 *
 * `resolveScope()` sempre calculou `effective_limits` (valor_max, naturezas,
 * categorias, horário), mas `canAct()` só comparava contra o teto global
 * `VALOR_LIMITE_DURO` — o limite individual resolvido nunca era aplicado.
 * Este módulo é o avaliador ÚNICO e puro da decisão financeira: combina
 * status, ação, restrições da permissão, limite individual, teto global e a
 * classificação de confirmação pelos thresholds.
 *
 * Contrato (invariantes Maia):
 *  - Backend decide; nenhum argumento do LLM altera limites ou confirmação.
 *  - Fail-closed: restrição presente + dado ausente/inválido ⇒ deny.
 *  - O limite individual nunca AMPLIA o global (owner continua sob o teto).
 *  - Money math em centavos inteiros (via Decimal) — nunca float impreciso.
 *
 * Semântica das restrições (documentada + testada):
 *  - `undefined` em naturezas/categorias/horário ⇒ sem restrição adicional;
 *  - `[]` em naturezas/categorias ⇒ nada permitido (deny);
 *  - `valor <= VALOR_LIMITE_SEM_CONFIRMACAO` ⇒ allow_without_confirmation;
 *  - `SEM_CONFIRMACAO < valor <= VALOR_DUAL_APPROVAL` ⇒ require_single_confirmation;
 *  - `DUAL_APPROVAL < valor <= VALOR_LIMITE_DURO` ⇒ require_dual_approval;
 *  - `valor > VALOR_LIMITE_DURO` ou `valor > valor_max` individual ⇒ deny.
 *
 * A ordem VALOR_LIMITE_SEM_CONFIRMACAO <= VALOR_DUAL_APPROVAL <=
 * VALOR_LIMITE_DURO é validada no boot (config/env.ts superRefine) — aqui ela
 * é assumida como pré-condição.
 */
import type { Pessoa } from '@/db/schema.js';
import type { ActionKey } from './audit-actions.js';
import type { ResolvedPermission } from './permissions.js';
import { profileAllows } from './permissions.js';
import { config } from '@/config/env.js';
import { Decimal } from '@/lib/decimal.js';

/** Versão da política — registrada em audit/metadata para rastrear mudanças. */
export const FINANCIAL_POLICY_VERSION = 1;

export type FinancialReasonCode =
  | 'pessoa_inactive'
  | 'no_permission_for_entity'
  | 'permission_inactive'
  | 'action_not_allowed'
  | 'invalid_amount'
  | 'natureza_not_allowed'
  | 'categoria_not_allowed'
  | 'invalid_time_window'
  | 'outside_allowed_hours'
  | 'above_individual_limit'
  | 'above_hard_limit'
  | 'above_no_confirmation_threshold'
  | 'above_dual_approval_threshold';

export type FinancialDecision =
  | { decision: 'allow_without_confirmation'; policy_version: number }
  | {
      decision: 'require_single_confirmation' | 'require_dual_approval' | 'deny';
      reason_code: FinancialReasonCode;
      policy_version: number;
    };

export type FinancialAuthorizationInput = {
  pessoa: Pessoa;
  resolved: ResolvedPermission | null;
  action: ActionKey;
  /** Valor em reais (número do arg Zod). Convertido para centavos aqui. */
  valor: number;
  natureza?: string;
  categoria_id?: string;
  /** Instante da decisão — injetável para testes determinísticos. */
  now?: Date;
  /** Timezone IANA do tenant/agente. Default: config.TZ. */
  timezone?: string;
};

/**
 * Teto absoluto de segurança para conversão em centavos: acima disso a
 * aritmética float que gerou o `number` já não é confiável (2^53/100).
 */
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * Converte reais (number) para centavos inteiros. `null` quando o valor não é
 * um montante financeiro representável (NaN, ±Infinity, negativo, overflow).
 */
export function toCents(valor: number): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  if (valor < 0) return null;
  const cents = new Decimal(valor).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
  if (!cents.isFinite() || cents.greaterThan(MAX_SAFE_CENTS)) return null;
  return cents.toNumber();
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minuto-do-dia + dia ISO (1=segunda … 7=domingo) no timezone dado. */
function localDayAndMinute(now: Date, timezone: string): { isoDay: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const dayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const isoDay = dayMap[get('weekday')] ?? 0;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return { isoDay, minute };
}

const hhmmToMinute = (s: string): number =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/**
 * Janela de horário permitida. `inicio <= fim` é janela intradia; `inicio >
 * fim` é janela que atravessa a meia-noite (o dia checado é o dia em que a
 * janela COMEÇOU). Estrutura malformada ⇒ 'invalid' (fail-closed no caller).
 */
function evaluateTimeWindow(
  window: { dias: number[]; inicio: string; fim: string },
  now: Date,
  timezone: string,
): 'inside' | 'outside' | 'invalid' {
  if (
    window === null ||
    typeof window !== 'object' ||
    !Array.isArray(window.dias) ||
    window.dias.length === 0 ||
    !window.dias.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) ||
    typeof window.inicio !== 'string' ||
    typeof window.fim !== 'string' ||
    !HHMM_PATTERN.test(window.inicio) ||
    !HHMM_PATTERN.test(window.fim)
  ) {
    return 'invalid';
  }
  const { isoDay, minute } = localDayAndMinute(now, timezone);
  if (isoDay === 0) return 'invalid';
  const inicio = hhmmToMinute(window.inicio);
  const fim = hhmmToMinute(window.fim);
  if (inicio <= fim) {
    return window.dias.includes(isoDay) && minute >= inicio && minute <= fim
      ? 'inside'
      : 'outside';
  }
  // Janela overnight: [inicio, 23:59] do dia D ∪ [00:00, fim] do dia D+1.
  const previousDay = isoDay === 1 ? 7 : isoDay - 1;
  if (minute >= inicio) return window.dias.includes(isoDay) ? 'inside' : 'outside';
  if (minute <= fim) return window.dias.includes(previousDay) ? 'inside' : 'outside';
  return 'outside';
}

/**
 * Decisão financeira única, fail-closed, em ordem estável:
 *  1. pessoa/permissão inativa            → deny
 *  2. ação fora do profile                → deny
 *  3. valor inválido (NaN/∞/negativo)     → deny
 *  4. natureza/categoria/horário          → deny quando fora da permissão
 *  5. limite individual (valor_max)       → deny acima
 *  6. teto global (VALOR_LIMITE_DURO)     → deny acima
 *  7. classificação pelos thresholds      → allow / single / dual
 */
export function evaluateFinancialAuthorization(
  input: FinancialAuthorizationInput,
): FinancialDecision {
  const deny = (reason_code: FinancialReasonCode): FinancialDecision => ({
    decision: 'deny',
    reason_code,
    policy_version: FINANCIAL_POLICY_VERSION,
  });

  if (input.pessoa.status !== 'ativa') return deny('pessoa_inactive');
  if (!input.resolved) return deny('no_permission_for_entity');
  if (input.resolved.permissao.status !== 'ativa') return deny('permission_inactive');
  if (!profileAllows(input.resolved.profile, input.action)) {
    return deny('action_not_allowed');
  }

  const cents = toCents(input.valor);
  if (cents === null) return deny('invalid_amount');

  const limits = input.resolved.effective_limits;

  // Naturezas: undefined = sem restrição; [] = nada permitido; restrição
  // presente + natureza ausente no intent = fail-closed (deny). `limites` é
  // jsonb sem tipo forte — valor presente mas NÃO-array (null, string...) é
  // restrição malformada e também nega (fail-closed, nunca "sem restrição").
  if (limits.naturezas_permitidas !== undefined) {
    if (
      !Array.isArray(limits.naturezas_permitidas) ||
      !input.natureza ||
      !limits.naturezas_permitidas.includes(input.natureza)
    ) {
      return deny('natureza_not_allowed');
    }
  }
  if (limits.categorias_permitidas !== undefined) {
    if (
      !Array.isArray(limits.categorias_permitidas) ||
      !input.categoria_id ||
      !limits.categorias_permitidas.includes(input.categoria_id)
    ) {
      return deny('categoria_not_allowed');
    }
  }
  if (limits.horario_permitido !== undefined) {
    const verdict = evaluateTimeWindow(
      limits.horario_permitido,
      input.now ?? new Date(),
      input.timezone ?? config.TZ,
    );
    if (verdict === 'invalid') return deny('invalid_time_window');
    if (verdict === 'outside') return deny('outside_allowed_hours');
  }

  // Limite individual (permissão/profile). `null` = nenhum limite individual
  // configurado — cai direto para o teto global. O individual nunca amplia o
  // global: os dois checks são independentes e ambos deny.
  if (limits.valor_max !== null) {
    const individualCents = toCents(limits.valor_max);
    if (individualCents === null) return deny('invalid_amount');
    if (cents > individualCents) return deny('above_individual_limit');
  }

  const hardCents = toCents(config.VALOR_LIMITE_DURO);
  if (hardCents === null || cents > hardCents) return deny('above_hard_limit');

  // Bordas (documentadas + testadas): igualdade fica na faixa MAIS BRANDA —
  // valor == threshold não escala para a exigência seguinte.
  const semConfirmacaoCents = toCents(config.VALOR_LIMITE_SEM_CONFIRMACAO);
  const dualCents = toCents(config.VALOR_DUAL_APPROVAL);
  if (semConfirmacaoCents !== null && cents <= semConfirmacaoCents) {
    return { decision: 'allow_without_confirmation', policy_version: FINANCIAL_POLICY_VERSION };
  }
  if (dualCents !== null && cents <= dualCents) {
    return {
      decision: 'require_single_confirmation',
      reason_code: 'above_no_confirmation_threshold',
      policy_version: FINANCIAL_POLICY_VERSION,
    };
  }
  return {
    decision: 'require_dual_approval',
    reason_code: 'above_dual_approval_threshold',
    policy_version: FINANCIAL_POLICY_VERSION,
  };
}
