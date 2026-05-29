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
 *     `operationalProfileVersionsRepo.transition` passando
 *     `expected_from: 'active'` para que uma corrida concorrente que troque
 *     o active sob o lock (ex.: priorities seed promovendo nova versão)
 *     surfaça como `{ok:false, reason:'stale'}` em vez de aplicar o rollback
 *     no row antigo já-congelado. Falhas no transition NÃO bloqueiam o
 *     pipeline: marcam `applied=false` + `applied_error` (com o estado
 *     observado quando `stale`).
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
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import type { DriftEvidence } from './types.js';

export type DriftDecisionResult = {
  drift_type: DriftType;
  severity: DriftSeverity;
  decision: DriftDecision;
  evidence: DriftEvidence;
  applied: boolean;
  applied_error?: string;
  alert_id?: string;
  /**
   * When set, this result was DEMOTED by the batch collapse step (Codex
   * Adversarial Review round 2 on PR #182): a stronger evidence for the
   * SAME `active_profile_id` was selected to drive the single transition
   * for that profile in this batch, so the present evidence's transition
   * was intentionally skipped. The alert row is still persisted so the
   * forensic trail is preserved. Value is the `alert_id` of the kept
   * (strongest) evidence; `null` if the kept evidence's alert insert
   * failed and therefore has no id.
   */
  superseded_by?: string | null;
};

/**
 * Numeric rank for DriftSeverity used by the batch collapse step. Higher
 * number = stronger action. critico > alto > medio > baixo.
 *
 * NOTE: this is action strength, not "badness" — soul_drift CRITICO maps to
 * queued_human, not rollback. The collapse only considers profile-mutating
 * decisions (frozen, rollback), so the rank ordering still produces the
 * right semantic (rollback dominates frozen when both target the same
 * active profile row).
 */
const SEVERITY_RANK: Record<DriftSeverity, number> = {
  [DriftSeverity.BAIXO]: 0,
  [DriftSeverity.MEDIO]: 1,
  [DriftSeverity.ALTO]: 2,
  [DriftSeverity.CRITICO]: 3,
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
      // P8b — soul_drift severity = quantidade de violações de soul biases (spec §5.4).
      // Hint do detector wins quando >= 2 (CRITICO requer hint).
      const violationsRaw = (p as { violations?: unknown }).violations;
      const violations = Array.isArray(violationsRaw) ? violationsRaw : [];
      if (hint === DriftSeverity.CRITICO) return DriftSeverity.CRITICO;
      if (violations.length >= 5) return DriftSeverity.ALTO;
      if (violations.length >= 2) return DriftSeverity.MEDIO;
      if (hint !== null) return hint;
      return DriftSeverity.BAIXO;
    }
    case DriftType.PAPEL_DRIFT: {
      // P8d §7 — floor rules determinísticas. Conservadoras: 3+ exemplos
      // são piso `alto`; rolesDiverge + 3+ é `critico`. Hint só age se
      // nenhuma regra-piso disparou.
      const offRoleRaw = (p as { off_role_examples?: unknown }).off_role_examples;
      const offRole = Array.isArray(offRoleRaw) ? offRoleRaw : [];
      const observed = (p as { observed_role_inferred?: unknown }).observed_role_inferred;
      const declared = (p as { declared_role?: unknown }).declared_role;

      // rolesDiverge requires BOTH sides to be validated role slugs (snake_case,
      // no spaces). Free-text prose descriptors (role_descriptor from seed) are
      // NOT slugs — comparing prose prefixes against role ids produces false
      // positives that promote normal alto drift to critico/rollback.
      // A valid slug: word chars + underscores only, at least one underscore
      // (e.g. "atendimento_financeiro_pf"), no spaces.
      const SLUG_RE = /^\w+(_\w+)+$/;
      const rolesDiverge =
        typeof observed === 'string' &&
        typeof declared === 'string' &&
        SLUG_RE.test(observed.trim()) &&
        SLUG_RE.test(declared.trim()) &&
        !observed.toLowerCase().includes(
          (declared.toLowerCase().split('_')[0] ?? ''),
        );

      if (offRole.length >= 5 || (rolesDiverge && offRole.length >= 3))
        return DriftSeverity.CRITICO;
      if (offRole.length >= 3) return DriftSeverity.ALTO;
      if (offRole.length === 2) return DriftSeverity.MEDIO;
      if (offRole.length === 1) return DriftSeverity.BAIXO;
      if (hint !== null) return hint;
      return DriftSeverity.BAIXO;
    }
    default:
      // unknown drift_type — defensivo
      return hint !== null ? hint : DriftSeverity.BAIXO;
  }
}

/**
 * Internal: compute (severity, decision) for an evidence. soul_drift maps to
 * a DIFFERENT decision table (P8b spec §5.4 — biases modulate, never gate),
 * which is why we branch here rather than baking it into `decisionForSeverity`.
 */
function classifyAndDecide(ev: DriftEvidence): {
  severity: DriftSeverity;
  decision: DriftDecision;
} {
  const severity = classifySeverity(ev);
  const decision =
    ev.drift_type === DriftType.SOUL_DRIFT
      ? decisionForSoulDriftSeverity(severity)
      : decisionForSeverity(severity);
  return { severity, decision };
}

/**
 * Processa uma lista de evidências, criando alert para TODAS e aplicando no
 * máximo UMA transição de perfil por `active_profile_id` no batch. Continua o
 * loop mesmo se transition ou alert falharem — o `applied`/`applied_error`
 * por item reflete o resultado.
 *
 * Codex Adversarial Review round 2 on PR #182: a sequential batch that
 * processed `[alto, critico]` for the same profile was hard-coding
 * `expected_from:'active'` for EVERY transition. The first transition froze
 * the row; the second (critico → rolled_back) then hit the repository's
 * stale guard (`active != frozen`) and was demoted to `applied=false`, so
 * the critical rollback was silently lost and the profile ended frozen
 * instead of rolled_back.
 *
 * Fix (Opção A — strongest action per profile per batch): group by
 * `active_profile_id` (today the caller passes a single id, but the data
 * shape we group on is generic so future multi-profile callers Just Work),
 * pick the evidence with the strongest profile-mutating action per group
 * (rollback > frozen; tie broken by the earlier index in the input list to
 * keep behavior deterministic), and apply only that one transition. The
 * other evidences in the same group still get their alert row persisted —
 * the audit trail captures every detector signal — but they are marked
 * `applied=false` with `superseded_by` pointing at the kept evidence's
 * alert_id. baixo/medio (auto_approved/queued_human) and soul_drift never
 * touch the profile, so they are exempt from the collapse step and always
 * round-trip individually.
 *
 * Codex Adversarial Review round 3 on PR #182 — partial-failure fallback:
 * the round-2 collapse picked the winner BEFORE alert persistence. If the
 * intended winner's alert insert failed (real Postgres outage, CHECK
 * constraint mismatch, transient connection drop), the engine would
 * (a) mark that winner `applied=false` with `alert_persist_failed:...`,
 * and (b) mark every other mutator `superseded_by: null` with no
 * transition fired — leaving the active profile running uncovered even
 * when a weaker-but-persisted alto/critico was ready to act.
 *
 * The round-3 ordering pushes winner selection BELOW alert persistence:
 * pass 1 inserts alerts for every evidence; pass 2 re-ranks ONLY mutators
 * with a persisted `alert_id` and elects the strongest of THAT subset as
 * the real winner; pass 3 fires the single transition. Forensic trail:
 * a structured `drift.batch.collapse.fallback` log fires whenever the
 * intended winner (by raw rank) differs from the real winner (by
 * persisted rank), so the rescue path is discoverable in postmortems.
 *
 * Codex Adversarial Review round 4 on PR #182 — CROSS-INVOCATION escalation.
 * Round 2 fixed intra-batch ordering, but two concurrent `decideAndApply`
 * calls for the same agent could still race: an `alto` batch freezes the
 * active row; the `critico` batch arrives second, sees the row as `frozen`
 * (not `active`), and the `expected_from='active'` guard demotes its
 * rollback to `applied=false`. The critical drift ends up `frozen` instead
 * of `rolled_back`.
 *
 * Codex Adversarial Review round 1 on PR #196 — refetch semantics. The
 * round-4 helper queried `WHERE status='active' LIMIT 1`, so in the EXACT
 * race the patch was meant to handle — target row already frozen by a
 * concurrent invocation, no replacement seeded — the helper returned
 * `null` because the target row was no longer active. The engine then
 * took the `currentActiveId !== profileId` branch and skipped with
 * `active_replaced`, dropping the critical rollback in the very scenario
 * the escalation was designed to recover.
 *
 * Codex Adversarial Review round 2 on PR #196 — TOCTOU under lock. Round 1
 * split the escalation into refetch + retry, but the refetch
 * (`getActiveContextForAgent`) ran OUTSIDE any lock and the retry took its
 * own lock fresh. Between those two steps, the active-slot snapshot was
 * released — a concurrent `seedNewActiveAtomic` could promote a new active
 * v2 between the refetch (saw null) and the retry, causing the retry to
 * roll back the original target while v2 was the live contract surface
 * (rollback applied to the wrong row). The `frozen → active` reactivation
 * edge was also unprotected.
 *
 * Round 2 fix: collapse the entire escalation into ONE transaction held
 * under `lockParentAgent` via the new
 * `operationalProfileVersionsRepo.escalateRollbackIfStillFrozen` method.
 * The repo method re-reads the target row FOR UPDATE, re-reads the active
 * slot FOR UPDATE, then commits the rollback only if both predicates
 * still hold. Engine's job is just to translate the five typed outcomes
 * into log shapes:
 *
 *   - `ok` → `drift.rollback.escalated`, mark applied.
 *   - `replaced` (different row holds active slot) →
 *     `drift.skip.active_replaced`; next cycle re-evaluates against the
 *     new active.
 *   - `reactivated` (target itself `frozen → active`) →
 *     `drift.skip.reactivated`; refuse to roll back a row that's back in
 *     service.
 *   - `terminal_state` (target reached non-frozen non-active state, e.g.
 *     `rolled_back` because someone else escalated) →
 *     `drift.skip.terminal_state`.
 *   - `target_missing` (extreme race, row deleted) →
 *     `drift.skip.target_missing` warn log.
 *
 * Single-shot under one lock (no bounded retry needed; the atomic method
 * makes the right decision once). Only ROLLBACK winners trigger the
 * escalation path — FROZEN winners that race a concurrent freeze are
 * already at the desired state, so the stale path stays the original
 * `applied=false / stale:...` outcome.
 */
export async function decideAndApply(args: {
  evidences: DriftEvidence[];
  active_profile_id: string;
}): Promise<DriftDecisionResult[]> {
  // (0) Pre-classify every evidence so we know upfront which ones are
  //     profile-mutating (frozen/rollback) and which are not. This lets us
  //     decide the strongest mutator per active_profile_id BEFORE doing any
  //     I/O — alerts are persisted in input order, but the transition is
  //     only attempted for the selected winner.
  const classified = args.evidences.map((ev, index) => {
    const { severity, decision } = classifyAndDecide(ev);
    const mutatesProfile =
      ev.drift_type !== DriftType.SOUL_DRIFT &&
      (decision === DriftDecision.FROZEN ||
        decision === DriftDecision.ROLLBACK);
    return { ev, index, severity, decision, mutatesProfile };
  });

  // (1) Group profile-mutating evidences by `active_profile_id` (today
  //     always `args.active_profile_id` — single value — but written as a
  //     map so that if a future caller passes evidences for multiple
  //     profiles in one batch, each profile's collapse is independent and
  //     evidences across profiles never interfere).
  type Item = (typeof classified)[number];
  const mutatorsByProfile = new Map<string, Item[]>();
  for (const item of classified) {
    if (!item.mutatesProfile) continue;
    const list = mutatorsByProfile.get(args.active_profile_id) ?? [];
    list.push(item);
    mutatorsByProfile.set(args.active_profile_id, list);
  }

  // (2) PASS 1 — alert persistence. Persist alert row for EVERY evidence in
  //     input order, regardless of whether it'll win or lose the collapse.
  //     This preserves the forensic trail (every detector signal becomes a
  //     row) and lets us populate `superseded_by` accurately in pass 2 even
  //     when discarded evidences appear BEFORE the winner in input order.
  //
  //     Codex Adversarial Review of PR #182 round 3 — winner selection has
  //     moved BELOW this loop. Previously the winner was chosen BEFORE
  //     alert persistence (by raw severity rank), so a batch like
  //     `[alto, critico]` whose top mutator's alert insert failed would
  //     drop the entire batch's transition while the active profile kept
  //     running. The alto's alert WAS persisted but it was already demoted
  //     to `superseded_by null`, so no fallback action ever fired. The new
  //     ordering — persist all alerts first, THEN rank only persisted
  //     mutators — lets a strong-but-failed evidence fall back to the next
  //     strongest persisted mutator so the batch still produces an
  //     auditable governance action.
  //
  //     Review #100 invariant: persist alert BEFORE attempting transition.
  //     The prior ordering (transition → alert) could freeze/rollback the
  //     profile and then crash on alert insert (e.g. CHECK constraint
  //     rejecting a new drift_type without the matching migration). That
  //     left profile state mutated without any audit row explaining why.
  type PerItem = {
    alert_id?: string;
    applied_error?: string;
  };
  const perItem: PerItem[] = new Array(classified.length);
  for (let i = 0; i < classified.length; i++) {
    const { ev, severity, decision } = classified[i]!;
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
      perItem[i] = { alert_id: alert.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      perItem[i] = { applied_error: 'alert_persist_failed:' + msg };
    }
  }

  // (3) Round 3 alert-aware winner selection.
  //
  //     For each profile, pick the strongest mutator AMONG THOSE WHOSE ALERT
  //     ROW PERSISTED. Mutators with `alert_persist_failed` are excluded
  //     from the candidate set: they cannot become the real winner because
  //     the applied-only-if-alert-persisted invariant would force them to
  //     applied=false anyway, and treating them as the winner would silently
  //     skip the batch's whole transition (the original Codex round 3 bug —
  //     `[alto, critico]` with the critico alert failing would leave the
  //     alto marked `superseded_by null` and no transition fired, so the
  //     active profile kept running uncovered).
  //
  //     Tie-break: highest severity rank wins; on equal rank, the lower
  //     input index wins (preserves prior deterministic behavior).
  //
  //     If no mutators persisted (all failed alert insert), `realWinnerIndex`
  //     is left unset for the profile — pass 2 then attempts no transition
  //     and every mutator stays applied=false with its own alert_persist_failed.
  const realWinnerIndexByProfile = new Map<string, number>();
  for (const [profileId, items] of mutatorsByProfile) {
    const persisted = items.filter((it) => perItem[it.index]!.alert_id);
    if (persisted.length === 0) continue;
    let winner = persisted[0]!;
    for (const item of persisted) {
      const stronger =
        SEVERITY_RANK[item.severity] > SEVERITY_RANK[winner.severity];
      if (stronger) winner = item;
    }
    realWinnerIndexByProfile.set(profileId, winner.index);
  }
  const realWinningIndices = new Set(realWinnerIndexByProfile.values());

  // Forensic trail: per-profile log of {intended winner by raw rank, real
  // winner by alert-persisted rank}. This makes it discoverable when the
  // batch was rescued by the fallback (intended !== real) vs. baseline
  // (intended === real).
  for (const [profileId, items] of mutatorsByProfile) {
    let intendedWinner = items[0]!;
    for (const item of items) {
      const stronger =
        SEVERITY_RANK[item.severity] > SEVERITY_RANK[intendedWinner.severity];
      if (stronger) intendedWinner = item;
    }
    const realWinnerIdx = realWinnerIndexByProfile.get(profileId);
    if (realWinnerIdx === undefined) {
      logger.warn(
        {
          active_profile_id: profileId,
          intended_winner: {
            index: intendedWinner.index,
            severity: intendedWinner.severity,
            decision: intendedWinner.decision,
          },
          real_winner: null,
          reason: 'all_mutators_alert_persist_failed',
        },
        'drift.batch.collapse.no_winner',
      );
    } else if (realWinnerIdx !== intendedWinner.index) {
      const realWinner = classified[realWinnerIdx]!;
      logger.warn(
        {
          active_profile_id: profileId,
          intended_winner: {
            index: intendedWinner.index,
            severity: intendedWinner.severity,
            decision: intendedWinner.decision,
          },
          real_winner: {
            index: realWinner.index,
            severity: realWinner.severity,
            decision: realWinner.decision,
            alert_id: perItem[realWinnerIdx]!.alert_id ?? null,
          },
          reason: 'intended_winner_alert_persist_failed',
        },
        'drift.batch.collapse.fallback',
      );
    }
  }

  // (4) PASS 2 — single transition per real winner. Only the real winner of
  //     each profile group attempts `transition`; persisted mutators that
  //     lost the collapse are marked `applied=false` with `superseded_by`
  //     pointing at the real winner's alert_id. Mutators whose alert failed
  //     to persist keep their own `alert_persist_failed:<msg>` error from
  //     pass 1 and `superseded_by: null` (no alert, no link).
  //
  //     The applied-only-if-alert-persisted invariant still holds: the
  //     winner selection step above ALREADY filtered out unpersisted
  //     mutators, so the winner here always has an alert_id.
  const applyResult = new Map<
    number,
    { applied: boolean; applied_error?: string }
  >();
  for (const [profileId, winnerIndex] of realWinnerIndexByProfile) {
    const winner = classified[winnerIndex]!;
    const winnerAlertId = perItem[winnerIndex]!.alert_id;
    // Invariant: realWinnerIndex always points at a mutator with a
    // persisted alert_id (filtered above). The defensive `if` below is
    // belt-and-suspenders for future refactors.
    if (!winnerAlertId) {
      applyResult.set(winnerIndex, {
        applied: false,
        applied_error: perItem[winnerIndex]!.applied_error,
      });
      continue;
    }
    try {
      // Codex Adversarial Review of PR #182 round 1: pass `expected_from:
      // 'active'` so a concurrent `seedNewActiveAtomic` that won the
      // parent-agent lock first (freezing `active_profile_id` and seeding
      // a new active row) doesn't cause this caller to silently transition
      // the FROZEN old row to `rolled_back` while the NEW active row keeps
      // running. With `expected_from`, that race surfaces as
      // `{ok:false, reason:'stale'}` and we mark the rollback as NOT
      // applied — the operator/next drift cycle will see the new active
      // and can re-evaluate against fresh evidence. The alert was already
      // persisted so the attempt is still auditable.
      //
      // Round 2 follow-up: now that the batch collapse step guarantees at
      // most ONE transition per `active_profile_id` per batch, this
      // `expected_from:'active'` is also safe against the engine's own
      // sequential mutation — the previous bug (alto froze the row, then
      // critico tried rolled_back against `expected_from:'active'` and
      // hit the stale guard) is impossible because the demoted evidence
      // never reaches `transition`.
      const r = await operationalProfileVersionsRepo.transition({
        id: profileId,
        to: winner.decision === DriftDecision.FROZEN ? 'frozen' : 'rolled_back',
        expected_from: 'active',
        approved_by: `auto:drift_${winner.severity}`,
        rollback_reason:
          winner.decision === DriftDecision.ROLLBACK
            ? winner.ev.evidence_summary
            : undefined,
      });
      if (r.ok) {
        applyResult.set(winnerIndex, { applied: true });
      } else if (
        r.reason === 'stale' &&
        r.actual === 'frozen' &&
        winner.decision === DriftDecision.ROLLBACK
      ) {
        // Codex Adversarial Review of PR #196 round 2 (issue #177 follow-up) —
        // CROSS-INVOCATION escalation, NOW UNDER A SINGLE LOCK.
        //
        // Round 1 split the escalation into two unlocked steps: a refetch
        // (`getActiveContextForAgent`) outside any lock, then a `transition`
        // retry that took its own lock. Between those steps the active-slot
        // snapshot was RELEASED, opening a TOCTOU window:
        //
        //   - `seedNewActiveAtomic` could promote a brand-new v2 to `active`
        //     between the refetch (which saw `null`) and the retry — the
        //     retry then transitioned the original target `frozen →
        //     rolled_back` and returned `applied:true` while v2 was the
        //     agent's live contract surface (rollback applied to the wrong
        //     row).
        //
        //   - `frozen → active` is a legal edge: an operator could
        //     re-activate the original target between the two reads. The
        //     retry's `expected_from='frozen'` guard surfaced stale, but
        //     the original "no replacement exists" observation was already
        //     wrong — the row itself was the replacement.
        //
        // Round 2 fix: collapse both reads + the UPDATE into ONE transaction
        // held under `lockParentAgent`. The new repo method re-reads the
        // target row FOR UPDATE, re-reads the active slot FOR UPDATE, then
        // commits the rollback only if both predicates still hold under the
        // lock. Every TOCTOU window is closed under the same lock that
        // every other writer of this table acquires.
        //
        // Five typed outcomes drive the engine's decision:
        //   - ok: rollback committed atomically. Log
        //     `drift.rollback.escalated`, mark applied.
        //   - replaced: a different row holds the active slot. Skip with
        //     `drift.skip.active_replaced`.
        //   - reactivated: target itself transitioned `frozen → active`.
        //     Skip with `drift.skip.reactivated`; refuse to roll back a
        //     row that's back in service.
        //   - terminal_state: target reached non-frozen non-active state
        //     (e.g. another worker already escalated). Log
        //     `drift.skip.terminal_state`.
        //   - target_missing: extreme race, target deleted. Warn.
        let tenantId: string;
        let agentId: string;
        try {
          tenantId = getCurrentTenant();
          agentId = getCurrentAgent();
        } catch (e) {
          // Caller didn't wrap us in `runWithTenantContext` — preserve the
          // original stale outcome with the context error so postmortems
          // see why the escalation couldn't run.
          const ctxErr = e instanceof Error ? e.message : String(e);
          applyResult.set(winnerIndex, {
            applied: false,
            applied_error: `stale:expected=${r.expected_from},actual=${r.actual};context_missing:${ctxErr}`,
          });
          continue;
        }

        try {
          const r2 = await operationalProfileVersionsRepo.escalateRollbackIfStillFrozen({
            tenant_id: tenantId,
            agent_id: agentId,
            target_profile_id: profileId,
            approved_by: `auto:drift_${winner.severity}`,
            rollback_reason: winner.ev.evidence_summary,
          });
          if (r2.ok) {
            applyResult.set(winnerIndex, { applied: true });
            logger.info(
              {
                active_profile_id: profileId,
                from: 'frozen',
                to: 'rolled_back',
                original_alert_id: winnerAlertId,
                severity: winner.severity,
              },
              'drift.rollback.escalated',
            );
          } else if (r2.reason === 'replaced') {
            // Active slot is owned by a different row — a new version was
            // seeded between the engine's observation and this tx. Skip;
            // next drift cycle re-evaluates against the new active.
            applyResult.set(winnerIndex, {
              applied: false,
              applied_error: `stale:expected=${r.expected_from},actual=${r.actual};active_replaced`,
            });
            logger.info(
              {
                original_active_id: profileId,
                new_active_id: r2.current_active_profile_id,
                dropped_evidence: winner.severity,
                original_alert_id: winnerAlertId,
              },
              'drift.skip.active_replaced',
            );
          } else if (r2.reason === 'reactivated') {
            // Target itself transitioned `frozen → active` under the lock.
            // Refuse to roll back a row that's back in service; log so
            // postmortems can trace the converging path.
            applyResult.set(winnerIndex, {
              applied: false,
              applied_error: `stale:expected=${r.expected_from},actual=${r.actual};reactivated`,
            });
            logger.warn(
              {
                active_profile_id: profileId,
                original_alert_id: winnerAlertId,
                dropped_evidence: winner.severity,
              },
              'drift.skip.reactivated',
            );
          } else if (r2.reason === 'terminal_state') {
            // Target reached a non-frozen non-active state (most commonly
            // `rolled_back` because another worker escalated first). The
            // desired terminal is achieved (or close); applied=false but
            // logged so the converging path is discoverable.
            applyResult.set(winnerIndex, {
              applied: false,
              applied_error: `terminal:actual=${r2.actual_status}`,
            });
            logger.info(
              {
                active_profile_id: profileId,
                actual_status: r2.actual_status,
                original_alert_id: winnerAlertId,
              },
              'drift.skip.terminal_state',
            );
          } else if (r2.reason === 'target_missing') {
            // Extreme race: the target row was deleted between observation
            // and this tx. Should be impossible in normal traffic; warn so
            // anomalies surface.
            applyResult.set(winnerIndex, {
              applied: false,
              applied_error: `stale:expected=${r.expected_from},actual=${r.actual};target_missing`,
            });
            logger.warn(
              {
                active_profile_id: profileId,
                original_alert_id: winnerAlertId,
              },
              'drift.skip.target_missing',
            );
          } else {
            // agent_missing — the agent was deleted out from under us.
            applyResult.set(winnerIndex, {
              applied: false,
              applied_error: `stale:expected=${r.expected_from},actual=${r.actual};agent_missing`,
            });
            logger.warn(
              {
                active_profile_id: profileId,
                original_alert_id: winnerAlertId,
              },
              'drift.skip.agent_missing',
            );
          }
        } catch (e2) {
          const applied_error = e2 instanceof Error ? e2.message : String(e2);
          applyResult.set(winnerIndex, { applied: false, applied_error });
        }
      } else {
        const applied_error =
          r.reason === 'stale'
            // Encode the observed-state in the error string so postmortems
            // can see WHY the rollback was skipped (active row was already
            // frozen/rolled_back/replaced by a concurrent writer).
            ? `stale:expected=${r.expected_from},actual=${r.actual}`
            : r.reason;
        applyResult.set(winnerIndex, { applied: false, applied_error });
      }
    } catch (e) {
      const applied_error = e instanceof Error ? e.message : String(e);
      applyResult.set(winnerIndex, { applied: false, applied_error });
    }
  }

  // (5) Assemble results in input order. Each mutator that lost the
  //     collapse gets `superseded_by = <real winner's alert_id or null>`
  //     so the operator can trace WHY this evidence's transition wasn't
  //     applied. Log one `drift.batch.collapsed` line per discarded
  //     evidence to keep the forensic narrative discoverable.
  //
  //     Round 3 nuance: a mutator whose own alert insert FAILED is NOT
  //     marked `superseded_by`. Its `applied_error` already encodes
  //     `alert_persist_failed:<msg>` (from pass 1) and there is no causal
  //     link to a winning alert — it lost because it had no audit row,
  //     not because a stronger evidence beat it. This keeps the
  //     forensic story honest.
  const results: DriftDecisionResult[] = [];
  for (const item of classified) {
    const { ev, severity, decision, mutatesProfile, index } = item;
    const persistResult = perItem[index]!;
    const alert_id = persistResult.alert_id;
    let applied = false;
    let applied_error = persistResult.applied_error;
    let superseded_by: string | null | undefined;

    if (mutatesProfile) {
      if (realWinningIndices.has(index)) {
        const ap = applyResult.get(index);
        if (ap) {
          applied = ap.applied;
          // Winner with alert_persist_failed gets the pass-1 error; winner
          // with transition failure overwrites with the transition error.
          // If pass 1 succeeded and pass 2 succeeded, no error.
          if (ap.applied_error !== undefined) applied_error = ap.applied_error;
        }
      } else if (alert_id) {
        // Lost the collapse but its own alert persisted — link to the
        // real winner so postmortems can trace the supersession.
        const realWinnerIndex = realWinnerIndexByProfile.get(args.active_profile_id);
        const realWinnerAlertId =
          realWinnerIndex !== undefined ? perItem[realWinnerIndex]!.alert_id : undefined;
        superseded_by = realWinnerAlertId ?? null;
        logger.info(
          {
            active_profile_id: args.active_profile_id,
            discarded: {
              drift_type: ev.drift_type,
              severity,
              decision,
              alert_id,
            },
            kept_alert_id: realWinnerAlertId ?? null,
          },
          'drift.batch.collapsed',
        );
      }
      // else: alert_id is falsy → this mutator's own alert failed to
      // persist. Leave `superseded_by` undefined and `applied_error` set
      // to `alert_persist_failed:<msg>` from pass 1. The result still
      // appears in the output for forensic completeness.
    }

    results.push({
      drift_type: ev.drift_type,
      severity,
      decision,
      evidence: ev,
      applied,
      applied_error,
      alert_id,
      ...(superseded_by !== undefined ? { superseded_by } : {}),
    });
  }

  return results;
}
