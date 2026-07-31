/**
 * Issue #536 — the activation gate: WHICH class may stop counting and start
 * deleting, and WHEN.
 *
 * #520 wrote the path down: "DPO responde → registra na matriz → vira
 * `RETENTION_POLICY` → dry-run → comparar contagens → desligar dry-run por
 * classe." Every step of that lived in a runbook, which means it held for
 * exactly as long as the operator remembered it. This module is that path as
 * code, and it is FAIL-CLOSED at every branch: `enforce` requires all five
 * conditions; anything unknown, unproven or merely proposed yields `dry_run`.
 *
 * THE FIVE CONDITIONS
 *
 *   1. The global lever is off        `RETENTION_DRY_RUN=false`
 *   2. The policy is HOMOLOGATED      not the `pending_dpo_homologation` sentinel
 *   3. The class is armed IN WRITING  `classes.<id>.dry_run === false`
 *   4. Its wave has been reached      every earlier-wave class already observed
 *   5. It has been OBSERVED           >= 2 completed dry-run cycles, same policy version
 *
 * WHY THE WAVE ORDER IS `postgres.traces` → `privacy.export` → `backup.artifact`.
 * These three are the classes whose deletion destroys the least: a trace body
 * is debug exhaust, an export package is a COPY the subject already received,
 * and a backup artifact is one of several redundant copies whose absence the
 * readiness view reports loudly. Getting the executor wrong on any of them is
 * recoverable. Getting it wrong on `postgres.messages` is not — which is why
 * conversation content is in a later wave and only after the first has run
 * clean.
 *
 * WHY TWO CYCLES AND NOT ONE. One cycle proves the query runs. Two prove the
 * count is STABLE — the second pass over the same corpus should find roughly
 * what the first did, and a wild difference means the plan is reacting to
 * something other than the policy. The retention job is weekly, so two cycles
 * is a fortnight of evidence. Cycles are counted per policy VERSION: editing
 * the policy restarts the observation, because the counts an operator compared
 * were counts of a different policy.
 *
 * PURE — the caller supplies the observed cycle counts (from `retention_runs`).
 */
import {
  type RetentionPolicy,
  getDataClass,
  resolveRetention,
} from './data-classes.js';
import { assertDoesNotExtendSource, resolveEffectiveRetention } from './derivation.js';

/** Completed dry-run cycles a class must show before it may be armed. */
export const MIN_DRY_RUN_CYCLES = 2;

export interface ActivationWave {
  wave: number;
  classes: readonly string[];
  rationale: string;
}

/**
 * The activation order proposed by the owner (#536), lowest blast radius first.
 * A class ABSENT from every wave can never be armed by this gate — adding it
 * here is a deliberate act, reviewed like any other code change.
 */
export const ACTIVATION_WAVES: readonly ActivationWave[] = Object.freeze([
  Object.freeze({
    wave: 1,
    classes: Object.freeze(['postgres.traces', 'privacy.export', 'backup.artifact']),
    rationale:
      'debug exhaust, a copy the subject already holds, and a redundant artifact — each recoverable if the executor is wrong',
  }),
  Object.freeze({
    wave: 2,
    classes: Object.freeze(['media.blobs', 'postgres.messages.audio_transcript']),
    rationale:
      'ephemeral attachments and transcripts, once wave 1 has shown the executor deletes what it planned and nothing else',
  }),
  Object.freeze({
    wave: 3,
    classes: Object.freeze([
      'postgres.messages',
      'postgres.conversations',
      'postgres.memory',
      'postgres.memory.pinned',
      'postgres.people',
      'postgres.audit',
    ]),
    rationale:
      'conversation content, identity and the audit trail — irreversible, and last on purpose',
  }),
]);

const WAVE_OF = new Map<string, number>(
  ACTIVATION_WAVES.flatMap((w) => w.classes.map((c) => [c, w.wave] as const)),
);

/** The wave a class belongs to, or `null` when it is not in the order at all. */
export function activationWaveOf(classId: string): number | null {
  return WAVE_OF.get(classId) ?? null;
}

export type ActivationMode = 'dry_run' | 'enforce';

export type ActivationReason =
  | 'ok'
  /** Global `RETENTION_DRY_RUN` is on (the default). */
  | 'dry_run_configured'
  | 'policy_not_approved'
  /** The policy parses but carries the pending-homologation sentinel. */
  | 'policy_not_homologated'
  | 'class_not_purgeable'
  | 'class_not_in_policy'
  /** The policy names the class but has not armed it (`dry_run` not false). */
  | 'class_not_armed'
  /** The class is not in `ACTIVATION_WAVES`. */
  | 'class_not_in_activation_order'
  /** An earlier wave has not finished its observation. */
  | 'earlier_wave_not_observed'
  | 'insufficient_dry_run_cycles';

export interface ActivationInput {
  classId: string;
  policy: RetentionPolicy;
  /** The resolved `RETENTION_DRY_RUN`. */
  dryRunConfigured: boolean;
  /**
   * Completed dry-run cycles per class, for the CURRENT policy version. A class
   * missing from the map counts as zero — the fail-closed direction.
   */
  cyclesByClass: Readonly<Record<string, number>>;
}

export interface ActivationVerdict {
  mode: ActivationMode;
  reason: ActivationReason;
  wave: number | null;
  /** Effective period after the derivation clamp; `null` when unbounded. */
  retention_days: number | null;
  observed_cycles: number;
  required_cycles: number;
  policy_version: string;
  /** The earlier-wave class still owing observation, when that is the blocker. */
  blocking_class: string | null;
}

/**
 * May this class delete right now?
 *
 * Order of the checks is deliberate: the STRUCTURAL refusals come first, so a
 * non-purgeable class reports `class_not_purgeable` rather than "you forgot to
 * run a dry-run" — the operator must not be told to do something that would
 * still not be enough.
 */
export function resolveActivation(input: ActivationInput): ActivationVerdict {
  const { classId, policy, cyclesByClass } = input;
  getDataClass(classId); // unknown class throws rather than defaulting
  const effective = resolveEffectiveRetention(classId, policy);
  const wave = activationWaveOf(classId);
  const observed = cycleCount(cyclesByClass, classId);

  const verdict = (reason: ActivationReason, extra?: { blocking_class?: string }) => ({
    mode: (reason === 'ok' ? 'enforce' : 'dry_run') as ActivationMode,
    reason,
    wave,
    retention_days: effective.retention_days,
    observed_cycles: observed,
    required_cycles: MIN_DRY_RUN_CYCLES,
    policy_version: policy.version,
    blocking_class: extra?.blocking_class ?? null,
  });

  const structural = resolveRetention(classId, policy);
  if (structural.reason === 'class_not_purgeable') return verdict('class_not_purgeable');
  if (!policy.approved) return verdict('policy_not_approved');
  if (!policy.homologated) return verdict('policy_not_homologated');

  const entry = policy.classes[classId];
  if (!entry) return verdict('class_not_in_policy');
  if (entry.dry_run) return verdict('class_not_armed');
  if (input.dryRunConfigured) return verdict('dry_run_configured');
  if (wave === null) return verdict('class_not_in_activation_order');

  // Every class of an EARLIER wave that the policy also names must have
  // finished its own observation first. A later wave riding on an unobserved
  // earlier one is the ordering silently not happening.
  for (const w of ACTIVATION_WAVES) {
    if (w.wave >= wave) break;
    for (const earlier of w.classes) {
      if (!policy.classes[earlier]) continue;
      if (cycleCount(cyclesByClass, earlier) < MIN_DRY_RUN_CYCLES) {
        return verdict('earlier_wave_not_observed', { blocking_class: earlier });
      }
    }
  }

  if (observed < MIN_DRY_RUN_CYCLES) return verdict('insufficient_dry_run_cycles');

  // Last line before the only branch that deletes. `resolveEffectiveRetention`
  // cannot produce a period that outlives a source, so this can never throw
  // today — which is exactly why it belongs here. A future change that computes
  // the period some other way crashes the pass instead of quietly deleting a
  // message's derived memory later than the message itself.
  assertDoesNotExtendSource(classId, effective.retention_days, policy);
  return verdict('ok');
}

function cycleCount(map: Readonly<Record<string, number>>, classId: string): number {
  const n = map[classId];
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * What the executor actually asks. Named so the call site reads as the
 * question it is answering, and so `true` is the value you get by default.
 */
export function effectiveDryRun(input: ActivationInput): boolean {
  return resolveActivation(input).mode !== 'enforce';
}

/** Every class in activation order, flattened — for the runbook and `maia doctor`. */
export function activationOrder(): { data_class: string; wave: number }[] {
  return ACTIVATION_WAVES.flatMap((w) =>
    w.classes.map((c) => ({ data_class: c, wave: w.wave })),
  );
}
