/**
 * Issue #431 — `case_risk_classify` (boleto proposal domain adapter).
 *
 * Classifies operational risk for a boleto proposal case. This is NOT a parallel
 * risk engine and introduces NO second risk enum.
 *
 * Reuse boundary (the whole point):
 *   - COMPOSES `classifyTurnRisk` (`src/shared/risk/turn-risk-adapter.ts`), the
 *     SAME domain-neutral adapter the #433 `risk_signal_classify` wraps. It
 *     extracts `TurnRiskSignals` and delegates to the shared two-stage scorer
 *     (heuristic + Haiku gate, no-downgrade enforced).
 *   - This adapter's ONLY net-new logic is (a) folding boleto-domain context
 *     (payment / refund / document / legal intent) into the adapter's INPUT, and
 *     (b) deriving `recommended_policy_action` ('allow'|'confirm'|'block'|
 *     'escalate') from the scored `risk` (+ `legal_intent`). The risk LEVEL is
 *     the deterministic scorer's — never something this tool invents.
 *
 * Output mapping from the adapter result:
 *   risk        ← result.risk        (RiskLevel, 4-level scale, unchanged)
 *   reasons     ← result.reasons     (trigger signal strings)
 *   triggers    ← result.triggers    (raw deterministic triggers)
 *   source      ← result.source      ('heuristic' | 'llm_upgrade' — i.e. the
 *                                      scorer's `decided_by`)
 *
 * Classification ONLY — never overrides a policy decision (invariant #3).
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { RiskLevel } from '@/types/enums.js';
import { classifyTurnRisk } from '@/shared/risk/turn-risk-adapter.js';
import type { ToolKind } from '@/shared/risk/types.js';

const RISK_LEVEL_VALUES = [
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
] as const;

const inputSchema = z.object({
  customer_message: z.string().max(8000).optional(),
  history: z.string().max(8000).optional(),
  company_context: z.unknown().optional(),
  payment_context: z.unknown().optional(),
  refund_context: z.unknown().optional(),
  document_context: z.unknown().optional(),
  // The deterministic signal from `legal_intent_detect`. Lifts the case toward
  // the `legal` topic (HIGH floor) regardless of keyword inference.
  legal_intent: z.boolean().optional(),
});

const outputSchema = z.object({
  risk: z.enum(RISK_LEVEL_VALUES),
  reasons: z.array(z.string()),
  recommended_policy_action: z.enum(['allow', 'confirm', 'block', 'escalate']),
  triggers: z.array(z.unknown()),
  source: z.enum(['heuristic', 'llm_upgrade']),
});

type Output = z.infer<typeof outputSchema>;

/**
 * Net-new mapping: scored level (+ legal intent) → the boleto policy action.
 * This is a SUGGESTION for the policy layer, which remains the authority — the
 * tool classifies, it does not enforce. Legal intent forces at least
 * `escalate` (a human/legal owner should see it) even on a medium level.
 */
function recommendedPolicyAction(
  risk: RiskLevel,
  legalIntent: boolean,
): Output['recommended_policy_action'] {
  if (legalIntent) {
    // Legal context never silently proceeds; high/critical escalate to a human.
    return risk === RiskLevel.LOW ? 'confirm' : 'escalate';
  }
  switch (risk) {
    case RiskLevel.LOW:
      return 'allow';
    case RiskLevel.MEDIUM:
      return 'confirm';
    case RiskLevel.HIGH:
      return 'block';
    case RiskLevel.CRITICAL:
      return 'escalate';
    default:
      return 'escalate';
  }
}

export const caseRiskClassifyTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'case_risk_classify',
  description:
    'Classifica o risco operacional de um caso de proposta de boleto (low/medium/high/critical) compondo o scorer de risco compartilhado, e recomenda uma ação de política (allow/confirm/block/escalate). Apenas classifica — não decide nem sobrepõe política.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'case_risk_classified',
  handler: async (args) => {
    const legalIntent = args.legal_intent === true;

    // Build the domain text the adapter extracts signals from: the message +
    // history + a compact serialization of whichever contexts are present. The
    // mere PRESENCE of a payment/refund/document context is a financial signal.
    const contextHints: string[] = [];
    if (args.payment_context !== undefined) contextHints.push('pagamento boleto');
    if (args.refund_context !== undefined) contextHints.push('reembolso refund');
    if (args.document_context !== undefined) contextHints.push('documento comprovante');
    if (legalIntent) contextHints.push('jurídico advogado processo');

    const text = [args.customer_message ?? '', args.history ?? '', contextHints.join(' ')]
      .filter((s) => s.trim().length > 0)
      .join('\n');

    // A boleto case ALWAYS touches the financial domain → at least a `transfer`
    // tool-kind so the heuristic floor reflects a money-adjacent flow.
    const toolKinds: ToolKind[] = ['transfer'];

    const result = await classifyTurnRisk({
      text,
      // Legal intent pins the `legal` topic (HIGH floor) over keyword inference.
      topic: legalIntent ? 'legal' : undefined,
      tool_kinds: toolKinds,
    });

    return {
      risk: result.risk,
      reasons: result.reasons,
      recommended_policy_action: recommendedPolicyAction(result.risk, legalIntent),
      triggers: [...result.triggers],
      source: result.source,
    };
  },
};
