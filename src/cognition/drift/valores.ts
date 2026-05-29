/**
 * P4 Task 8 — Drift detector: VALORES.
 *
 * LLM-as-judge: verifica se as mensagens recentes do agente CONTRADIZEM
 * explicitamente algum dos `core_immutable.principles`. Mesma forma do
 * tomDetector, mas o universo de comparação são os princípios (string[]),
 * não o tom/voz.
 *
 * Returns `null` quando não há princípios definidos, sem mensagens do agente,
 * sem drift detectado, ou erro (defensivo, mesma justificativa do tom).
 *
 * Issue #189 — true-principles requirement:
 *   Until #189 the resolver synthesized `core_immutable.principles` from
 *   `identity.priorities` for admin-ui rows that only had priorities.
 *   This detector consumed those synthesized values as value contracts,
 *   and the decision engine floors any VALORES violation to `alto` →
 *   `frozen` (or `critico` → `rollback`). Routine operational priority
 *   labels could therefore trigger user-visible auto-freezes.
 *
 *   The fix:
 *     1. Resolver no longer synthesizes principles from priorities.
 *     2. This detector requires TRUE principles. When none are configured,
 *        it skips silently AND emits a one-shot observability log per
 *        profile-version-id so operators can correlate "no value drift
 *        guardrail" with "this profile never declared principles".
 *
 *   NO fallback to identity.priorities here. Priorities are operational
 *   labels (papelDriftDetector audits THEM); principles are core value
 *   contracts. Conflating the two is exactly the bug class #189 fixes.
 */
import Anthropic from '@anthropic-ai/sdk';
import { DriftType } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

import { resolveLegacyPayload } from '@/identity/profile-legacy-resolver.js';

/**
 * Process-local set of profile-version ids already logged for the
 * "no principles configured" branch, so a single misconfigured profile
 * doesn't spam observability on every drift run. One log per profile_id
 * keeps the signal: "this profile has no value drift guardrail" without
 * becoming noise.
 */
const noPrinciplesLoggedFor = new Set<string>();

export const valoresDetector: DriftDetector = {
  type: DriftType.VALORES,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    // v3.1.1 contract (migration 061 + Codex review #163 round 4):
    // The legacy core_immutable now lives at profile_body.core_immutable on
    // a Drizzle-shaped row. The shared resolver handles read precedence
    // (profile_body direct-embed → top-level legacy → synthesized).
    //
    // Issue #189: the resolver's synthesized layer no longer back-fills
    // principles from priorities. If a profile reaches this detector with
    // no principles, drift is skipped silently — we will NOT treat
    // operational priority labels as core value contracts.
    const { core_immutable } = resolveLegacyPayload(input.profile_active);
    const principlesRaw = Array.isArray(core_immutable.principles)
      ? core_immutable.principles
      : [];
    const principles = principlesRaw.filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0,
    );
    if (principles.length === 0) {
      // Observability for issue #189: emit ONE structured log per
      // profile-version-id so operators can spot profiles missing the
      // value-drift guardrail (admin-ui setup that never declared
      // principles). The log carries no principle text — just length-free
      // identifiers — so it is safe for any log sink.
      const profileId = input.profile_active.id;
      if (profileId && !noPrinciplesLoggedFor.has(profileId)) {
        noPrinciplesLoggedFor.add(profileId);
        logger.info(
          {
            profile_id: profileId,
            tenant_id: input.profile_active.tenant_id,
            agent_id: input.profile_active.agent_id,
          },
          'valores_drift.no_principles_configured',
        );
      }
      return null;
    }

    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages.slice(-20).map((m) => `- ${m.text}`).join('\n');
    const principlesTxt = principles.map((p, i) => `${i + 1}. ${p}`).join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    const system = [
      'Você é um auditor de princípios do agente.',
      'Dado os princípios do núcleo e as últimas mensagens do agente,',
      'identifique se alguma contradiz explicitamente um princípio. Devolva JSON.',
    ].join('\n');
    const user = [
      `PRINCÍPIOS:\n${principlesTxt}\n`,
      `MENSAGENS RECENTES DO AGENTE:\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "violated_principles": [<indices>], "examples": [...], "reasoning": "..."}',
    ].join('\n');

    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = completion.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        drift_detected?: boolean;
        severity_hint?: string;
        violated_principles?: number[];
        examples?: unknown[];
        reasoning?: string;
      };
      if (!parsed.drift_detected) return null;
      return {
        drift_type: DriftType.VALORES,
        detected_by: 'drift_detector_valores',
        payload: {
          severity_hint: parsed.severity_hint ?? 'medio',
          violated_principles: Array.isArray(parsed.violated_principles) ? parsed.violated_principles : [],
          examples: Array.isArray(parsed.examples) ? parsed.examples : [],
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? 'drift de valores detectado').slice(0, 200),
      };
    } catch {
      return null;
    }
  },
};

/**
 * Test-only: clear the dedupe cache so multiple specs can exercise the
 * `no_principles_configured` log branch independently. Mirrors the helper
 * exposed by papelDriftDetector for the same reason.
 */
export const __test_only_resetNoPrinciplesLogCache = (): void => {
  noPrinciplesLoggedFor.clear();
};
