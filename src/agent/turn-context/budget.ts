/**
 * Issue #511 — deterministic, observable budgets for turn-context sections.
 *
 * Before this, every cap was an inline `.slice(0, N)`: deterministic, but
 * invisible. An operator could not tell a tenant whose 200 facts were being cut
 * to 20 from a tenant that genuinely had 20, and nothing bounded the SIZE of
 * what survived — 20 facts carrying 50 KB payloads each is still a megabyte of
 * prompt, and one tenant could produce it.
 *
 * `applyBudget` keeps the same cut and adds the two missing halves: a byte
 * ceiling, and a counter plus a log line for every item dropped.
 *
 * Determinism is a contract, not an accident: the caller passes items in an
 * already-deterministic order and this function only ever takes a PREFIX. The
 * same snapshot therefore renders the same prompt on every replica — which is
 * what makes the shadow/canary hash comparison in the rollout plan meaningful.
 */
import { recordTruncation, recordSectionSize, type TurnContextSection } from './metrics.js';
import type { SectionBudget } from './types.js';

/**
 * Rough token estimate: ~4 characters per token.
 *
 * Deliberately provider-agnostic and deliberately not a real tokenizer. Its job
 * is to make "this section is getting expensive" visible on a dashboard, and
 * the error of a 4-chars/token heuristic is far smaller than the variation
 * between providers we would be pretending to model. Nothing enforces limits on
 * this number — the byte ceiling is the enforcement, this is just reporting.
 */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export type BudgetOutcome<T> = {
  items: T[];
  /** How many items the budget dropped. */
  dropped: number;
  /** Which limit bit first, when anything was dropped. */
  reason: 'max_items' | 'max_bytes' | null;
  bytes: number;
};

/**
 * Cut `items` to fit `budget`, reporting what was lost.
 *
 * `size` measures one item's contribution in bytes. It is the caller's job to
 * make that match what will actually be rendered (usually the length of the
 * line the item becomes), so the ceiling bounds the PROMPT and not some
 * unrelated internal representation.
 *
 * The item cap is applied first, then the byte ceiling walks the survivors in
 * order and stops at the first item that would overflow. Stopping — rather than
 * skipping the big item and continuing — keeps the result a strict prefix,
 * which is what makes the output deterministic and diffable.
 */
export function applyBudget<T>(
  section: TurnContextSection & string,
  items: readonly T[],
  budget: SectionBudget,
  size: (item: T) => number,
): BudgetOutcome<T> {
  const byCount = items.slice(0, budget.max_items);
  let droppedByCount = items.length - byCount.length;

  const kept: T[] = [];
  let bytes = 0;
  let droppedByBytes = 0;
  for (const item of byCount) {
    const itemBytes = size(item);
    if (bytes + itemBytes > budget.max_bytes && kept.length > 0) {
      // Everything from here on is dropped — see the prefix rationale above.
      droppedByBytes = byCount.length - kept.length;
      break;
    }
    kept.push(item);
    bytes += itemBytes;
  }

  // A single oversized first item is kept: dropping it would render an empty
  // section that looks identical to "there was nothing", which is precisely the
  // ambiguity this issue exists to remove. It is reported as a byte truncation
  // so it still shows up on the dashboard.
  const dropped = droppedByCount + droppedByBytes;
  const reason: 'max_items' | 'max_bytes' | null =
    dropped === 0 ? null : droppedByCount > 0 ? 'max_items' : 'max_bytes';

  if (dropped > 0 && reason) recordTruncation(section, reason, dropped);
  recordSectionSize(section, bytes, estimateTokens(bytes));

  return { items: kept, dropped, reason, bytes };
}

/** Byte size of a string as it will appear in the prompt (UTF-8). */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
