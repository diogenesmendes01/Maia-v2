/**
 * Issue #536 — derived data never outlives what it was derived from.
 *
 * THE OWNER'S TWO RULES, RESTATED AS ONE MECHANISM:
 *
 *   `postgres.memory`        — "herda o MENOR prazo das fontes e NUNCA prolonga
 *                              silenciosamente a vida de uma mensagem"
 *   `postgres.conversations` — "o shell identificável não sobrevive às
 *                              mensagens"
 *
 * Both say the same thing: a class that only exists because another class
 * exists must expire no later than it. Writing that as a comment next to a
 * number in a policy file would leave it to whoever edits the policy next. So
 * it is a CLAMP, and the clamp is on the only path that answers "how long may
 * this class be kept" — `resolveEffectiveRetention`. There is no second path
 * that skips it. A policy that says memory 365 / messages 180 does not produce
 * an error the operator can dismiss: it produces 180, and says which source
 * bound it.
 *
 * DIRECTIONALITY — the half that is easy to get backwards. Clamping only ever
 * LOWERS. A source with no approved period imposes no bound (it is being kept
 * indefinitely, which is not a reason to keep the derived row longer), and the
 * derived class can always be shorter than its source. What it can never be is
 * longer. `assertDoesNotExtendSource` is the executable statement of that, and
 * `resolveEffectiveRetention` satisfies it by construction.
 *
 * THE OTHER DIRECTION, for completeness: derived data must also never be a
 * REASON to keep a source alive. That one is structural — the retention pass
 * for `postgres.messages` plans from message rows only and never consults
 * memory — so there is nothing here to enforce; see the matrix.
 *
 * PURE: no clock, no IO, no config singleton.
 */
import { TypedError } from '@/lib/utils.js';
import {
  type RetentionPolicy,
  type RetentionVerdict,
  getDataClass,
  resolveRetention,
} from './data-classes.js';

/**
 * Class → the classes whose lifetime it must not exceed.
 *
 * `postgres.memory.pinned` is deliberately ABSENT: memory the user pinned on
 * purpose is not derived data, and clamping it to the conversation that
 * produced it would delete exactly what the user asked to keep. It carries its
 * own purpose and its own period (see the matrix), which is why it is a
 * separate data class rather than an exception inside this table.
 */
export const RETENTION_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // A transcript is a rendering of the message that carries it.
  'postgres.messages.audio_transcript': Object.freeze(['postgres.messages']),
  // The identifiable conversation shell (title, snippet, JID) is only the
  // envelope of its messages. Anonymous statistics are NOT this class.
  'postgres.conversations': Object.freeze(['postgres.messages']),
  // Memory derived from a dialogue: facts, embeddings, summaries.
  'postgres.memory': Object.freeze(['postgres.messages', 'postgres.conversations']),
});

/**
 * Classes whose period is clamped by a source.
 *
 * The table above is the TRANSITIVE closure — a derived class lists every
 * ancestor, not just its parent — so the clamp is one pass with no recursion
 * and no cycle risk. `tests/unit/ops/retention-derivation.spec.ts` enforces the
 * closure, which is what makes the single pass safe as the graph grows.
 */
export function derivedClasses(): string[] {
  return Object.keys(RETENTION_SOURCES).sort();
}

/** The classes `classId` may not outlive. Empty for a non-derived class. */
export function retentionSourcesOf(classId: string): readonly string[] {
  return RETENTION_SOURCES[classId] ?? [];
}

export interface EffectiveRetentionVerdict extends RetentionVerdict {
  /** What the policy asked for, before the clamp. `null` when unbounded. */
  declared_days: number | null;
  /** The source class that lowered the period, when one did. */
  clamped_by: string | null;
  /** Every source consulted, in declaration order. */
  sources: readonly string[];
}

/**
 * THE ONLY correct way to ask how long a class may be kept.
 *
 * For a non-derived class this is `resolveRetention` plus bookkeeping. For a
 * derived one the period is `min(declared, …every bounded source)`, and the
 * verdict names the source that won so an operator reading a dry-run row can
 * see WHY the number is not the one they wrote.
 */
export function resolveEffectiveRetention(
  classId: string,
  policy: RetentionPolicy,
): EffectiveRetentionVerdict {
  // Throws on an unknown class rather than inventing a default.
  getDataClass(classId);
  const own = resolveRetention(classId, policy);
  const sources = retentionSourcesOf(classId);

  const base: EffectiveRetentionVerdict = {
    ...own,
    declared_days: own.retention_days,
    clamped_by: null,
    sources,
  };
  if (sources.length === 0) return base;
  // A structurally non-purgeable class stays non-purgeable. Inheritance lowers
  // a period; it can never manufacture permission to delete that the inventory
  // withholds — the same refusal `parseRetentionPolicy` makes.
  if (own.reason === 'class_not_purgeable') return base;

  let days = own.retention_days;
  let clampedBy: string | null = null;
  for (const sourceId of sources) {
    const source = resolveRetention(sourceId, policy);
    // An unbounded source imposes no ceiling — see DIRECTIONALITY above.
    if (source.retention_days === null) continue;
    if (days === null || source.retention_days < days) {
      days = source.retention_days;
      clampedBy = sourceId;
    }
  }

  if (days === null || clampedBy === null) return base;
  return {
    ...base,
    // A derived class with no declared period of its own still expires with its
    // source: inheriting the ceiling is the point of the rule. The reason code
    // distinguishes the two, so a dry-run row shows whether the number came
    // from the policy or from the clamp.
    purgeable: true,
    retention_days: days,
    reason: own.purgeable ? 'ok' : 'inherited_from_source',
    clamped_by: clampedBy,
  };
}

/**
 * The invariant, as an assertion a destructive caller can put in its path.
 *
 * `resolveEffectiveRetention` cannot violate it — this exists so that a FUTURE
 * caller that computes a period some other way trips over it instead of
 * quietly extending a message's life through a derived row.
 */
export function assertDoesNotExtendSource(
  classId: string,
  effectiveDays: number | null,
  policy: RetentionPolicy,
): void {
  for (const sourceId of retentionSourcesOf(classId)) {
    const source = resolveRetention(sourceId, policy);
    if (source.retention_days === null) continue;
    if (effectiveDays === null || effectiveDays > source.retention_days) {
      throw new TypedError(
        'retention_extends_source',
        `retention for '${classId}' would outlive its source '${sourceId}'`,
        {
          data_class: classId,
          source_class: sourceId,
          effective_days: effectiveDays,
          source_days: source.retention_days,
        },
      );
    }
  }
}
