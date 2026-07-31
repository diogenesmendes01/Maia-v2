/**
 * Issue #536 — the tombstone floor, the one open question from #520 that is
 * TECHNICAL rather than legal, and therefore the one that can be answered
 * without waiting for the DPO.
 *
 * THE FAILURE THIS PREVENTS. A deletion writes a tombstone; a restore replays
 * every tombstone newer than the artifact's watermark before releasing traffic
 * (`./tombstones.ts`). That defence has an expiry date: once a tombstone is
 * gone, restoring an artifact that still contains the deleted row resurrects it
 * and NOTHING notices — the ledger cannot block what it no longer remembers.
 *
 * So the tombstone must outlive every artifact that could still carry the row:
 *
 *     tombstone_min_days  >  max(local backup retention, off-site retention)
 *
 * STRICTLY greater, not "at least". Equal windows expire on the same day, and
 * an artifact restored in the hours before the sweep would find the ledger
 * already empty.
 *
 * Today: local 7d, off-site 30d, floor 60d — satisfied with margin. Raise the
 * off-site window past the floor and `retention/tombstone-exceeds-backup`
 * (`src/config/rules.ts`, BOOT scope) stops the deploy until the floor follows.
 * That is the whole point: the invariant is enforced by the configuration
 * validator, not by whoever remembers to read this file.
 *
 * ZERO IMPORTS on purpose — `src/config/rules.ts` is a module the purity gate
 * (`tests/unit/config/contract-purity.spec.ts`) walks transitively, so anything
 * reachable from it must not drag in I/O.
 */

/**
 * Proposed operational floor for `privacy.tombstone`, pending homologation.
 *
 * NOT a legal period: `privacy.tombstone` is structurally non-purgeable in v1
 * (`parseRetentionPolicy` refuses to make it purgeable even if a policy asks),
 * so this number is a MINIMUM the deployment must honour, never a licence to
 * delete a tombstone once it is reached.
 */
export const DEFAULT_TOMBSTONE_MIN_DAYS = 60;

/** The longest window during which a deleted row may still sit in an artifact. */
export function longestBackupRetentionDays(
  localDays: number | undefined,
  cloudDays: number | undefined,
): number | undefined {
  const known = [localDays, cloudDays].filter(
    (d): d is number => typeof d === 'number' && Number.isFinite(d),
  );
  if (known.length === 0) return undefined;
  return Math.max(...known);
}

export interface TombstoneFloorVerdict {
  /** `false` ⇒ resurrection is possible; boot must fail. */
  ok: boolean;
  /** `undefined` when neither retention window is known (nothing to compare). */
  longest_backup_days: number | undefined;
  tombstone_min_days: number | undefined;
  /** Smallest floor that would satisfy the invariant. */
  required_min_days: number | undefined;
}

/**
 * Evaluate the invariant. Unknown inputs yield `ok: true` — this predicate
 * answers "is the configured pair contradictory?", and the contract's own
 * `requiredWhen`/defaults own "is it configured at all?". Two mechanisms
 * reporting the same missing variable is the drift #515 exists to remove.
 */
export function evaluateTombstoneFloor(input: {
  tombstoneMinDays: number | undefined;
  localBackupDays: number | undefined;
  cloudBackupDays: number | undefined;
}): TombstoneFloorVerdict {
  const longest = longestBackupRetentionDays(input.localBackupDays, input.cloudBackupDays);
  const floor = input.tombstoneMinDays;
  if (longest === undefined || floor === undefined) {
    return {
      ok: true,
      longest_backup_days: longest,
      tombstone_min_days: floor,
      required_min_days: longest === undefined ? undefined : longest + 1,
    };
  }
  return {
    ok: floor > longest,
    longest_backup_days: longest,
    tombstone_min_days: floor,
    required_min_days: longest + 1,
  };
}
