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

  return null;
}
