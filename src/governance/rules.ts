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

  // C-006 (spec 18 §6.8): payment_due workflow above LIMITE_DURO rejected at
  // creation. The hard limit must hold at scheduling, not only execution,
  // so we never persist a workflow that would always fail when it fires.
  if (intent.tool === 'start_workflow' && intent.args.tipo === 'payment_due') {
    const ctx = intent.args.contexto as Record<string, unknown> | undefined;
    const valor = ctx?.['valor'];
    if (typeof valor === 'number' && valor > config.VALOR_LIMITE_DURO) {
      return { kind: 'forbidden', rule_id: 'C-006', reason: 'pagamento agendado acima do limite duro' };
    }
  }

  // C-007 (spec 18 §6.8): outreach_recorrente requires dual_approval at
  // creation. Same threshold as one-shot send_proactive_message — owner
  // approves the recurring contract once, each cycle inherits the approval.
  if (intent.tool === 'start_workflow' && intent.args.tipo === 'outreach_recorrente' && !input.dual_approval_granted) {
    return {
      kind: 'limit_exceeded',
      required_action: 'dual_approval',
      reason: 'agendamento recorrente envolvendo terceiros requer aprovação',
    };
  }

  return null;
}
