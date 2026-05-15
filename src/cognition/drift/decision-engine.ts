/**
 * P4 Task 9 — Drift decision engine.
 *
 * Pega a saída do orchestrador (DriftEvidence[]) e, para cada evidência:
 *  1) Classifica `severity` deterministicamente (NUNCA LLM). O classificador
 *     usa o payload tipado por `drift_type` e respeita um `severity_hint`
 *     opcional fornecido pelo detector, mas mantém regras-piso por tipo
 *     (ex.: VALORES com `violated_principles` é no mínimo 'alto'; LINGUAGEM
 *     `offensive=true` é sempre 'critico').
 *  2) Mapeia severity → decision:
 *        baixo   → auto_approved
 *        medio   → queued_human
 *        alto    → frozen
 *        critico → rollback
 *  3) Para `frozen`/`rollback`, transiciona o perfil ativo via
 *     `operationalProfileVersionsRepo.transition`. Falhas no transition NÃO
 *     bloqueiam o pipeline: marcam `applied=false` + `applied_error`.
 *  4) Persiste SEMPRE 1 row em `agent_drift_alerts` (incluindo decisões
 *     baixo/medio que não tocam no perfil). Falhas no `create` do alert são
 *     concatenadas em `applied_error` mas não interrompem as evidências
 *     restantes do loop.
 *
 * Sem dependência de LLM, sem `runCognitiveModule` — o orchestrator (Task 8)
 * já governou os detectores. Este engine é a borda determinística que
 * traduz evidência em ação operacional + audit.
 */
import {
  DriftSeverity,
  DriftDecision,
  DriftType,
} from '@/types/enums.js';
import {
  operationalProfileVersionsRepo,
  driftAlertsRepo,
} from '@/db/repositories.js';
import type { DriftEvidence } from './types.js';

export type DriftDecisionResult = {
  drift_type: DriftType;
  severity: DriftSeverity;
  decision: DriftDecision;
  evidence: DriftEvidence;
  applied: boolean;
  applied_error?: string;
  alert_id?: string;
};

function decisionForSeverity(s: DriftSeverity): DriftDecision {
  switch (s) {
    case DriftSeverity.BAIXO:
      return DriftDecision.AUTO_APPROVED;
    case DriftSeverity.MEDIO:
      return DriftDecision.QUEUED_HUMAN;
    case DriftSeverity.ALTO:
      return DriftDecision.FROZEN;
    case DriftSeverity.CRITICO:
      return DriftDecision.ROLLBACK;
  }
}

/**
 * P8b — soul_drift NUNCA promove rollback de profile (spec §5.4):
 *  - BAIXO   → auto_approved (log only)
 *  - MEDIO   → queued_human
 *  - ALTO    → queued_human (cap; sem frozen)
 *  - CRITICO → queued_human (cap; com Admin UI banner downstream)
 *
 * Diferença em relação aos 7 detectores anteriores: soul detection é sinal
 * de *aderência*, não de violação de identity/policy. A bias modula; ela
 * NUNCA gera gate de execução. O remediation correto é proposal review
 * pelo owner, não rollback automático.
 */
function decisionForSoulDriftSeverity(s: DriftSeverity): DriftDecision {
  switch (s) {
    case DriftSeverity.BAIXO:
      return DriftDecision.AUTO_APPROVED;
    case DriftSeverity.MEDIO:
    case DriftSeverity.ALTO:
    case DriftSeverity.CRITICO:
      return DriftDecision.QUEUED_HUMAN;
  }
}

const VALID_SEVERITIES: readonly string[] = [
  DriftSeverity.BAIXO,
  DriftSeverity.MEDIO,
  DriftSeverity.ALTO,
  DriftSeverity.CRITICO,
];

function readHint(p: Record<string, unknown>): DriftSeverity | null {
  const raw = p['severity_hint'];
  if (typeof raw !== 'string') return null;
  if (!VALID_SEVERITIES.includes(raw)) return null;
  return raw as DriftSeverity;
}

export function classifySeverity(ev: DriftEvidence): DriftSeverity {
  const p = ev.payload ?? {};
  const hint = readHint(p);

  switch (ev.drift_type) {
    case DriftType.TOM: {
      const examplesRaw = (p as { examples?: unknown }).examples;
      const examples = Array.isArray(examplesRaw) ? examplesRaw : [];
      if (hint !== null) return hint;
      if (examples.length >= 3) return DriftSeverity.ALTO;
      if (examples.length === 2) return DriftSeverity.MEDIO;
      return DriftSeverity.BAIXO;
    }
    case DriftType.VALORES: {
      const violatedRaw = (p as { violated_principles?: unknown }).violated_principles;
      const violated = Array.isArray(violatedRaw) ? violatedRaw : [];
      // Contradição explícita de princípio é no mínimo 'alto'; 'critico' só
      // se o detector pediu via hint.
      if (hint === DriftSeverity.CRITICO) return DriftSeverity.CRITICO;
      if (violated.length > 0) return DriftSeverity.ALTO;
      if (hint !== null) return hint;
      return DriftSeverity.MEDIO;
    }
    case DriftType.CONFIANCA: {
      const gapRaw = (p as { max_gap?: unknown }).max_gap;
      const gap = typeof gapRaw === 'number' ? gapRaw : 0;
      if (gap >= 0.7) return DriftSeverity.CRITICO;
      if (gap >= 0.5) return DriftSeverity.ALTO;
      if (gap >= 0.3) return DriftSeverity.MEDIO;
      return DriftSeverity.BAIXO;
    }
    case DriftType.VIES: {
      const confirmedRaw = (p as { confirmed?: unknown }).confirmed;
      const confirmed = Array.isArray(confirmedRaw) ? confirmedRaw : [];
      if (confirmed.length >= 2) return DriftSeverity.ALTO;
      if (confirmed.length === 1) return DriftSeverity.MEDIO;
      if (hint !== null) return hint;
      return DriftSeverity.BAIXO;
    }
    case DriftType.ESCOPO: {
      const promisesRaw = (p as { unfulfillable_promises?: unknown }).unfulfillable_promises;
      const promises = Array.isArray(promisesRaw) ? promisesRaw : [];
      if (promises.length >= 3) return DriftSeverity.CRITICO;
      if (promises.length > 0) return DriftSeverity.ALTO;
      if (hint !== null) return hint;
      return DriftSeverity.MEDIO;
    }
    case DriftType.LINGUAGEM: {
      const offensive = (p as { offensive?: unknown }).offensive === true;
      if (offensive) return DriftSeverity.CRITICO;
      if (hint !== null) return hint;
      return DriftSeverity.BAIXO;
    }
    case DriftType.PROCEDIMENTO: {
      const anyActive = (p as { any_active?: unknown }).any_active === true;
      if (anyActive) return DriftSeverity.ALTO;
      const countRaw = (p as { count?: unknown }).count;
      const count = typeof countRaw === 'number' ? countRaw : 0;
      if (count >= 3) return DriftSeverity.ALTO;
      if (count >= 1) return DriftSeverity.MEDIO;
      if (hint !== null) return hint;
      return DriftSeverity.BAIXO;
    }
    case DriftType.SOUL_DRIFT: {
      // soul_drift severity = quantidade de violações de soul biases (spec §5.4).
      // Hint do detector wins quando >= 2 (CRITICO requer hint).
      const violationsRaw = (p as { violations?: unknown }).violations;
      const violations = Array.isArray(violationsRaw) ? violationsRaw : [];
      if (hint === DriftSeverity.CRITICO) return DriftSeverity.CRITICO;
      if (violations.length >= 5) return DriftSeverity.ALTO;
      if (violations.length >= 2) return DriftSeverity.MEDIO;
      if (hint !== null) return hint;
      return DriftSeverity.BAIXO;
    }
    default:
      // unknown drift_type — defensivo
      return hint !== null ? hint : DriftSeverity.BAIXO;
  }
}

/**
 * Processa uma lista de evidências sequencialmente, criando alert e aplicando
 * transições conforme decisão. Continua o loop mesmo se transition ou alert
 * falharem — o `applied`/`applied_error` por item reflete o resultado.
 */
export async function decideAndApply(args: {
  evidences: DriftEvidence[];
  active_profile_id: string;
}): Promise<DriftDecisionResult[]> {
  const results: DriftDecisionResult[] = [];

  for (const ev of args.evidences) {
    const severity = classifySeverity(ev);
    // P8b: soul_drift maps to a DIFFERENT decision table — it NEVER promotes
    // frozen/rollback because soul biases modulate (not gate) behavior.
    const decision =
      ev.drift_type === DriftType.SOUL_DRIFT
        ? decisionForSoulDriftSeverity(severity)
        : decisionForSeverity(severity);

    let applied = false;
    let applied_error: string | undefined;

    // soul_drift NEVER touches the profile, regardless of severity.
    if (
      ev.drift_type !== DriftType.SOUL_DRIFT &&
      (decision === DriftDecision.FROZEN || decision === DriftDecision.ROLLBACK)
    ) {
      try {
        const r = await operationalProfileVersionsRepo.transition({
          id: args.active_profile_id,
          to: decision === DriftDecision.FROZEN ? 'frozen' : 'rolled_back',
          approved_by: `auto:drift_${severity}`,
          rollback_reason:
            decision === DriftDecision.ROLLBACK ? ev.evidence_summary : undefined,
        });
        applied = r.ok;
        if (!r.ok) applied_error = r.reason;
      } catch (e) {
        applied_error = e instanceof Error ? e.message : String(e);
      }
    }

    let alert_id: string | undefined;
    try {
      const alert = await driftAlertsRepo.create({
        profile_version_id: args.active_profile_id,
        drift_type: ev.drift_type,
        severity,
        evidence: { ...ev.payload, summary: ev.evidence_summary },
        detected_by: ev.detected_by,
        decision,
        decided_by: 'decision_engine',
      });
      alert_id = alert.id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      applied_error =
        (applied_error ? applied_error + '; ' : '') + 'alert_persist_failed:' + msg;
    }

    results.push({
      drift_type: ev.drift_type,
      severity,
      decision,
      evidence: ev,
      applied,
      applied_error,
      alert_id,
    });
  }

  return results;
}
