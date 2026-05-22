/**
 * P8d §6 — Drift detector: papel (LLM-as-judge).
 *
 * 9º detector. Verifica aderência das mensagens recentes do agente ao
 * `role_descriptor` declarado em `profile_body.identity`.
 *
 * Exemplos de drift:
 *  - Profile = `atendimento_financeiro_pf`, agente responde dúvidas trabalhistas
 *  - Profile = `consultoria_juridica`, agente está fechando vendas
 *
 * Returns `null` quando:
 *  - role_descriptor é '' ou 'unset' (sem papel para auditar)
 *  - sem mensagens do agente (nada para auditar)
 *  - LLM diz drift_detected=false
 *  - JSON inválido / Anthropic throw (defensivo, mesma justificativa do tom)
 *
 * Issue #172 (priorities fallback chain):
 *   Migration 061 backfills `identity.principles` from
 *   `core_immutable.principles` MAS persiste `identity.priorities` como `[]`
 *   (`scripts/p8d-migration-priorities.ts` é o canonical writer). Ler só
 *   `identity.priorities` deixava o prompt enviado ao auditor com
 *   "PRIORIDADES: (nenhuma)" em toda profile migrada até alguém lembrar de
 *   rodar o script TS — desligando effectively o guardrail role-drift.
 *
 *   Fix: cadeia de fallback forward-compatible (nada muda no banco):
 *     1. `profile_body.identity.priorities`   — produção pós-migration TS
 *     2. `profile_body.identity.principles`   — backfill da migration 061
 *     3. `profile_body.core_immutable.principles` (via resolver) — direct-embed
 *
 *   Conversão é "safe": cada item é filtrado para `string` não-vazio com
 *   `trim()` — nunca tenta slug-extract ou coerção. Os princípios podem ser
 *   sentenças descritivas (não slugs) e isso é OK pro auditor LLM, que
 *   trata "PRIORIDADES" como lista textual livre.
 */
import Anthropic from '@anthropic-ai/sdk';
import { DriftType } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';
import { resolveLegacyPayload } from '@/identity/profile-legacy-resolver.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

type IdentityPapel = {
  role_descriptor?: string;
  priorities?: unknown[];
  principles?: unknown[];
};

type PrioritiesSource = 'priorities' | 'identity_principles' | 'core_principles' | 'empty';

/**
 * Process-local set of profile-version ids already logged for fallback usage,
 * so a single migrated agent doesn't spam observability on every drift run
 * (drift orchestrator fans out per `runCognitiveModule`, potentially many
 * times per worker lifetime). One log per (profile_id, source) keeps the
 * signal: "this profile is on fallback" without becoming noise.
 */
const fallbackLoggedFor = new Set<string>();

/**
 * Coerce a raw list (priorities or principles) into a trimmed string[].
 * Non-string entries (numbers, objects, nulls) are silently dropped — the
 * upstream writers (proposal-generator, migration 061, p8d migration TS)
 * all emit strings, so anything else is a corruption guard.
 */
function toStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Resolve priorities with a hierarchical fallback. Returns the chosen list
 * plus which source it came from, so the caller can log fallback usage
 * exactly once per profile-version-id.
 */
function resolvePriorities(
  input: DriftDetectionInput,
  identity: IdentityPapel,
): { priorities: string[]; source: PrioritiesSource } {
  const primary = toStringList(identity.priorities);
  if (primary.length > 0) {
    return { priorities: primary, source: 'priorities' };
  }

  const identityPrinciples = toStringList(identity.principles);
  if (identityPrinciples.length > 0) {
    return { priorities: identityPrinciples, source: 'identity_principles' };
  }

  // Resolver handles read precedence (profile_body.core_immutable →
  // top-level legacy → synthesized from identity.priorities/principles).
  const { core_immutable } = resolveLegacyPayload(input.profile_active);
  const corePrinciples = toStringList(core_immutable.principles);
  if (corePrinciples.length > 0) {
    return { priorities: corePrinciples, source: 'core_principles' };
  }

  return { priorities: [], source: 'empty' };
}

export const papelDriftDetector: DriftDetector = {
  type: DriftType.PAPEL_DRIFT,
  async detect(input: DriftDetectionInput): Promise<DriftEvidence | null> {
    const body = (input.profile_active.profile_body ?? {}) as Record<string, unknown>;
    const identity = (body.identity ?? {}) as IdentityPapel;

    const role = typeof identity.role_descriptor === 'string' ? identity.role_descriptor : '';
    if (!role || role === 'unset') return null;

    const { priorities, source } = resolvePriorities(input, identity);

    // Observability for issue #172 fix: emit ONE structured log per
    // profile-version-id when we fell back or had no priorities at all.
    // Production case worth flagging: source='empty' on a profile with a
    // declared role — drift still runs (LLM can audit role-only), but the
    // guardrail loses the priorities signal and someone should investigate.
    if (source !== 'priorities') {
      const profileId = input.profile_active.id;
      const logKey = `${profileId}::${source}`;
      if (!fallbackLoggedFor.has(logKey)) {
        fallbackLoggedFor.add(logKey);
        if (source === 'empty') {
          logger.warn(
            {
              profile_id: profileId,
              tenant_id: input.profile_active.tenant_id,
              agent_id: input.profile_active.agent_id,
              role_descriptor: role,
            },
            'papel_drift.priorities_empty_all_sources',
          );
        } else {
          logger.info(
            {
              profile_id: profileId,
              tenant_id: input.profile_active.tenant_id,
              agent_id: input.profile_active.agent_id,
              source,
              count: priorities.length,
            },
            'papel_drift.priorities_fallback_used',
          );
        }
      }
    }

    const agentMessages = input.recent_messages.filter((m) => m.from === 'agent');
    if (agentMessages.length === 0) return null;

    const sample = agentMessages
      .slice(-20)
      .map((m) => `- ${m.text}`)
      .join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    const system = [
      'Você é um auditor de papel operacional do agente.',
      'Dado o papel declarado e as prioridades, avalie se as mensagens recentes',
      'estão aderentes ao papel ou claramente saem do escopo. Devolva JSON.',
    ].join('\n');
    const user = [
      `PAPEL DECLARADO: ${role}\n`,
      `PRIORIDADES: ${priorities.length > 0 ? priorities.join(', ') : '(nenhuma)'}\n`,
      `MENSAGENS RECENTES DO AGENTE:\n${sample}\n`,
      'Devolva {"drift_detected": bool, "severity_hint": "baixo"|"medio"|"alto"|"critico", "off_role_examples": [...], "observed_role_inferred": "...", "reasoning": "..."}.',
    ].join('\n');

    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
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
        off_role_examples?: unknown[];
        observed_role_inferred?: string;
        reasoning?: string;
      };
      if (!parsed.drift_detected) return null;

      return {
        drift_type: DriftType.PAPEL_DRIFT,
        detected_by: 'drift_detector_papel',
        payload: {
          severity_hint: parsed.severity_hint ?? 'medio',
          declared_role: role,
          observed_role_inferred:
            typeof parsed.observed_role_inferred === 'string'
              ? parsed.observed_role_inferred
              : null,
          off_role_examples: Array.isArray(parsed.off_role_examples)
            ? parsed.off_role_examples
            : [],
          reasoning: parsed.reasoning ?? '',
        },
        evidence_summary: (parsed.reasoning ?? 'papel desviado').slice(0, 200),
      };
    } catch {
      return null; // defensivo; orchestrator wrappa fallback null
    }
  },
};

/**
 * Test-only: clear the dedupe cache so multiple specs can exercise the
 * fallback-log branches independently. Not exported in the type but
 * exposed via a side-channel symbol the test suite imports.
 */
export const __test_only_resetFallbackLogCache = (): void => {
  fallbackLoggedFor.clear();
};
