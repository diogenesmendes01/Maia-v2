import { config } from '@/config/env.js';
import type { ResolvedPermission } from './permissions.js';
import type { Pessoa } from '@/db/schema.js';

export type RuleViolation =
  | { kind: 'forbidden'; rule_id: string; reason: string }
  | { kind: 'limit_exceeded'; required_action: 'single_sig' | 'dual_approval'; reason: string };

export type IntentLike = {
  tool: string;
  args: Record<string, unknown>;
};

export function constitutionalCheck(input: {
  intent: IntentLike;
  pessoa: Pessoa;
  resolved: ResolvedPermission | null;
  scope: { entidades: string[] };
  dual_approval_granted?: boolean;
}): RuleViolation | null {
  const { intent } = input;

  // C-001: hard limit on transactions
  if (
    (intent.tool === 'register_transaction' || intent.tool === 'correct_transaction') &&
    typeof intent.args.valor === 'number' &&
    intent.args.valor > config.VALOR_LIMITE_DURO
  ) {
    return { kind: 'forbidden', rule_id: 'C-001', reason: 'acima do limite duro' };
  }

  // C-002: deletion is impossible by design (no delete tool registered)

  // C-003: proactive messages require dual approval (Phase 1-2)
  if (intent.tool === 'send_proactive_message' && !input.dual_approval_granted) {
    return {
      kind: 'limit_exceeded',
      required_action: 'dual_approval',
      reason: 'mensagem proativa requer 4-eyes',
    };
  }

  // C-004: cross-entity guard
  const entidade_id = (intent.args.entidade_id as string | undefined) ?? null;
  if (entidade_id && !input.scope.entidades.includes(entidade_id)) {
    return { kind: 'forbidden', rule_id: 'C-004', reason: 'fora do escopo' };
  }

  // C-005: strategic decisions
  const meta = intent.args.metadata as Record<string, unknown> | undefined;
  if (intent.tool === 'register_transaction' && meta && meta['tipo'] === 'investimento_estrategico') {
    return { kind: 'forbidden', rule_id: 'C-005', reason: 'decisão estratégica exige humano' };
  }

  // C-006 (spec 18 §9): start_recurring_payment with valor > LIMITE_DURO
  // rejected at creation. Hard limit must hold at scheduling, not only at
  // dispatch — we never persist a series that would always fail.
  if (intent.tool === 'start_recurring_payment') {
    const valor = intent.args.valor;
    if (typeof valor === 'number' && valor > config.VALOR_LIMITE_DURO) {
      return { kind: 'forbidden', rule_id: 'C-006', reason: 'pagamento agendado acima do limite duro' };
    }
  }

  // C-007 (spec 18 §9): start_recurring_outreach requires dual_approval at
  // creation. Owner approves the recurring contract once; each occurrence
  // inherits via the series row.
  if (intent.tool === 'start_recurring_outreach' && !input.dual_approval_granted) {
    return {
      kind: 'limit_exceeded',
      required_action: 'dual_approval',
      reason: 'agendamento recorrente envolvendo terceiros requer aprovação',
    };
  }

  // C-008 (spec 18 §9): defence-in-depth — an occurrence whose snapshot
  // exceeds VALOR_LIMITE_DURO is rejected when claimed by the engine.
  // Guards against limit changes after the series was created.
  if (intent.tool === '__occurrence_claim__' && intent.args.tipo === 'recurring_payment') {
    const valor = (intent.args.contexto_snapshot as Record<string, unknown> | undefined)?.['valor'];
    if (typeof valor === 'number' && valor > config.VALOR_LIMITE_DURO) {
      return { kind: 'forbidden', rule_id: 'C-008', reason: 'ocorrência acima do limite duro atual' };
    }
  }

  // C-009 (issue #437): the boleto-proposta sensitive WRITES
  // (boleto_cancel, company_campaign_remove, refund_create) require explicit
  // confirmation / dual approval before execution. This is the synchronous,
  // constitutional FLOOR at the dispatcher (capability-taxonomy §3/§6: "a skill
  // never decides confirmation — policy + the dispatcher decide"). It COMPOSES
  // with `confirm_before_write_policy` (migration 078), which DECIDES the same
  // outcome via the P9d DSL at the Mid PEP, and with the dispatcher grant guard.
  // Fail-closed: without a granted approval the write is refused here even if
  // every other gate (skill scope, canAct) would allow it. The `confirm before
  // write` intent maps to the existing dual_approval signal the three tools
  // already accept (`dual_approval_granted` in their input schema), so no DSL
  // vocabulary change is needed.
  if (SENSITIVE_BOLETO_WRITE_TOOLS.has(intent.tool) && !input.dual_approval_granted) {
    return {
      kind: 'limit_exceeded',
      required_action: 'dual_approval',
      reason: 'escrita sensível do vertical boleto requer confirmação explícita antes de executar',
    };
  }

  return null;
}

/**
 * Issue #437 — the three sensitive WRITE tools of the boleto-proposta vertical
 * governed by `confirm_before_write_policy` (migration 078). Kept in sync with
 * `CONFIRM_BEFORE_WRITE_GOVERNED_TOOLS`
 * (`src/control-plane/policy/boleto-write-policies.ts`); duplicated here as a
 * literal so this module stays free of a control-plane import (the dispatcher
 * guard is in the action layer and must not pull the policy resolver in).
 */
const SENSITIVE_BOLETO_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'boleto_cancel',
  'company_campaign_remove',
  'refund_create',
]);
