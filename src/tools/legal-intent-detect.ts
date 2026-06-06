/**
 * Issue #431 — `legal_intent_detect` (boleto proposal domain adapter).
 *
 * Detects legal threats / formal legal requests / legal-department contact /
 * formal complaint signals in a customer message via DETERMINISTIC lexical
 * rules (PT-BR + a few EN terms). It feeds risk/policy — it gives NO legal
 * advice and does NOT escalate by itself.
 *
 * Reuse boundary: this is the deterministic SIGNAL producer. Its boolean output
 * is consumed by `case_risk_classify` (which composes the shared risk scorer);
 * it does NOT score risk itself and introduces no risk enum. The `legal` topic
 * the shared risk heuristic already understands is the downstream effect.
 *
 * Confidence is COMPUTED from the matched-category evidence (deterministic
 * formula over signal counts), never declared by an LLM (invariant #5).
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { stripDiacritics } from '@/lib/utils.js';

const inputSchema = z.object({
  customer_message: z.string().min(1).max(8000),
  recent_context: z.string().max(8000).optional(),
});

const outputSchema = z.object({
  has_legal_intent: z.boolean(),
  identified_reasons: z.array(z.string()),
  signals: z.array(z.string()),
  excerpts: z.array(z.string()),
  confidence: z.enum(['low', 'medium', 'high']),
});

/**
 * Lexical categories. Each maps a stable reason code to the diacritic-stripped,
 * lowercased substrings that signal it. Kept coarse and high-precision — these
 * are the terms the issue calls out (lawyer, legal department, lawsuit, court
 * action, formal complaint, consumer protection, legal notification).
 */
const LEGAL_LEXICON: ReadonlyArray<{ reason: string; terms: readonly string[] }> = [
  {
    reason: 'lawyer',
    terms: ['advogad', 'advocacia', 'escritorio de advocacia', 'meu juridico', 'lawyer', 'attorney'],
  },
  {
    reason: 'legal_department',
    terms: ['departamento juridico', 'setor juridico', 'area juridica', 'legal department'],
  },
  {
    reason: 'lawsuit',
    terms: ['processar', 'processo judicial', 'vou processar', 'acao judicial', 'acao na justica', 'lawsuit', 'sue you', 'litig'],
  },
  {
    reason: 'court_action',
    terms: ['justica', 'tribunal', 'judicial', 'na justica', 'court', 'juiz', 'vara civel', 'mandado'],
  },
  {
    reason: 'formal_complaint',
    terms: ['reclamacao formal', 'queixa formal', 'notificacao extrajudicial', 'formal complaint', 'reclamacao no'],
  },
  {
    reason: 'consumer_protection',
    terms: ['procon', 'codigo de defesa do consumidor', 'defesa do consumidor', 'cdc', 'consumer protection', 'reclame aqui'],
  },
  {
    reason: 'legal_notification',
    terms: ['notificacao judicial', 'notificacao legal', 'intimacao', 'intimar', 'legal notice', 'cease and desist'],
  },
];

/** Pull a short excerpt around a matched term so the agent/policy can see the
 * context without re-reading the whole message. */
function excerptAround(original: string, _normalized: string, termStart: number, termLen: number): string {
  // termStart/termLen are indices in the NORMALIZED string, which is the same
  // length as the lowercased original (stripDiacritics preserves length for the
  // combining-mark removal we do). Clamp a small window.
  const start = Math.max(0, termStart - 24);
  const end = Math.min(original.length, termStart + termLen + 24);
  const slice = original.slice(start, end).trim();
  return (start > 0 ? '…' : '') + slice + (end < original.length ? '…' : '');
}

export const legalIntentDetectTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'legal_intent_detect',
  description:
    'Detecta intenção jurídica em mensagens do cliente (advogado, departamento jurídico, processo, ação judicial, reclamação formal, Procon/CDC, notificação) por regras léxicas determinísticas. Apenas sinaliza para risco/política — não dá orientação jurídica nem escala sozinho.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'legal_intent_detected',
  handler: async (args) => {
    const original = `${args.customer_message}${args.recent_context ? `\n${args.recent_context}` : ''}`;
    const lower = original.toLowerCase();
    const normalized = stripDiacritics(lower);

    const reasons = new Set<string>();
    const signals = new Set<string>();
    const excerpts: string[] = [];

    for (const { reason, terms } of LEGAL_LEXICON) {
      for (const term of terms) {
        const idx = normalized.indexOf(term);
        if (idx >= 0) {
          reasons.add(reason);
          signals.add(term);
          if (excerpts.length < 8) {
            excerpts.push(excerptAround(original, normalized, idx, term.length));
          }
        }
      }
    }

    const reasonCount = reasons.size;
    const hasLegalIntent = reasonCount > 0;
    // Deterministic confidence: more independent categories → higher confidence.
    const confidence: 'low' | 'medium' | 'high' =
      reasonCount >= 2 ? 'high' : reasonCount === 1 ? 'medium' : 'low';

    return {
      has_legal_intent: hasLegalIntent,
      identified_reasons: [...reasons],
      signals: [...signals],
      excerpts,
      confidence,
    };
  },
};
