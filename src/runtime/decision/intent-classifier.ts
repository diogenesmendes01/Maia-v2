/**
 * P9b — Intent Classifier (rules-first + Haiku LLM fallback).
 *
 * Spec §7.1: deterministic heuristic patterns first; LLM (Haiku) only if no
 * heuristic matches AND text is non-trivial. Implements master §0.4 principle
 * 1: "regra para estrutura, LLM para ambiguidade".
 *
 * Budget target: <80ms (Haiku call is the worst case).
 */
import type {
  ContentResolver,
  HaikuClient,
  IntentClassifier,
  MetricsClient,
} from './types.js';
import type {
  BaseContextPacket,
  DecisionPacket,
} from '../context-packet/types.js';

export interface IntentClassifierDeps {
  contentResolver: ContentResolver;
  haiku: HaikuClient;
  metrics?: MetricsClient;
}

interface HeuristicIntent {
  pattern: RegExp;
  label: string;
  confidence: number;
}

/**
 * Tenant-agnostic heuristics (spec §7.1). Tenants can later override via
 * TENANT_INTENT_TAXONOMY. Order matters — first match wins.
 */
const HEURISTIC_INTENTS: readonly HeuristicIntent[] = [
  // Specific patterns BEFORE generic greet to avoid mismatches
  { pattern: /^\/ajuda|^ajuda$/i, label: 'help_request', confidence: 0.99 },
  {
    pattern: /qual.+(meu\s+)?(saldo|extrato)/i,
    label: 'balance_query',
    confidence: 0.85,
  },
  {
    pattern: /transferir|enviar.+(reais|R\$)/i,
    label: 'transfer_intent',
    confidence: 0.8,
  },
  {
    pattern: /cancelar.+(operação|transferência|pagamento)/i,
    label: 'cancel_request',
    confidence: 0.9,
  },
  // Greet falls last since it's the most generic.
  // Note: avoid \b after á — Unicode word-boundaries are unreliable in JS regex.
  // Use explicit end-of-line or non-word lookahead.
  {
    pattern: /^(olá|oi|bom dia|boa tarde|boa noite)([\s,.!?]|$)/i,
    label: 'greet',
    confidence: 0.95,
  },
];

const DEFAULT_TAXONOMY: readonly string[] = [
  'greet',
  'help_request',
  'balance_query',
  'transfer_intent',
  'cancel_request',
  'information_request',
  'complaint',
  'feedback',
  'unknown',
];

/** Per-tenant overrides. P9b ships empty; tenants register via control plane. */
const TENANT_INTENT_TAXONOMY: Record<string, readonly string[]> = {};

export class IntentClassifierImpl implements IntentClassifier {
  constructor(private deps: IntentClassifierDeps) {}

  async classify(
    base: BaseContextPacket,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionPacket['intent']> {
    const opts: { signal?: AbortSignal } = {};
    if (options?.signal) opts.signal = options.signal;
    const text = await this.deps.contentResolver.text(
      base.input.content_ref,
      opts,
    );

    // 1. Rules first.
    for (const h of HEURISTIC_INTENTS) {
      if (h.pattern.test(text)) {
        this.deps.metrics?.increment('intent_classifier.heuristic_hit', {
          label: h.label,
        });
        return { label: h.label, confidence: h.confidence };
      }
    }

    // 2. Trivially short text — don't waste LLM call.
    if (text.trim().length < 4) {
      this.deps.metrics?.increment('intent_classifier.too_short');
      return { label: 'unknown', confidence: 0.3 };
    }

    // 3. LLM only when ambiguous (spec §7.1 step 2).
    const taxonomy =
      TENANT_INTENT_TAXONOMY[base.tenant_id] ?? DEFAULT_TAXONOMY;

    this.deps.metrics?.increment('intent_classifier.llm_calls');
    try {
      const haiku = await this.deps.haiku.classify(
        {
          text,
          allowed_labels: Array.from(taxonomy),
          max_tokens: 50,
        },
        opts,
      );
      const intent: DecisionPacket['intent'] = {
        label: haiku.label,
        confidence: haiku.confidence,
      };
      if (haiku.top3) intent.alternatives = haiku.top3;
      return intent;
    } catch {
      this.deps.metrics?.increment('intent_classifier.llm_error');
      return { label: 'unknown', confidence: 0.2 };
    }
  }
}
