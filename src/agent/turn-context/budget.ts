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
  /** How many items the budget removed entirely. */
  dropped: number;
  /** How many surviving items had their CONTENT cut to fit (0 or 1). */
  clipped: number;
  /** Which limit bit first, when anything was lost. */
  reason: 'max_items' | 'max_bytes' | null;
  bytes: number;
};

/** Appended to any value the byte ceiling cut. Fixed string — never localised. */
export const TRUNCATION_MARKER = '… [truncado]';

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes on a codepoint boundary.
 *
 * Slicing a UTF-8 buffer at an arbitrary offset can land mid-sequence, and
 * `Buffer.toString` would then emit U+FFFD — a replacement character that
 * changes the prompt bytes depending on where the cut fell. Walking back off
 * continuation bytes (`0b10xxxxxx`) keeps the result a valid, stable prefix.
 */
function sliceUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Clip `s` to `maxBytes`, marking the cut so a reader (and anyone diffing two
 * prompts) can tell truncated content from content that was simply short.
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  const markerBytes = utf8Bytes(TRUNCATION_MARKER);
  // Not enough room for the marker itself — cut hard rather than overshoot.
  if (maxBytes <= markerBytes) return sliceUtf8(s, maxBytes);
  return sliceUtf8(s, maxBytes - markerBytes) + TRUNCATION_MARKER;
}

/**
 * Cut `items` to fit `budget`, reporting what was lost.
 *
 * `size` measures one item's contribution in bytes. It is the caller's job to
 * make that match what will actually be rendered (usually the length of the
 * line the item becomes), so the ceiling bounds the PROMPT and not some
 * unrelated internal representation.
 *
 * `clip` cuts a single item down to a byte budget. It is REQUIRED, and that is
 * the whole point: an earlier version kept an oversized first item whole rather
 * than render an empty section, which meant one tenant-controlled TEXT column
 * could still produce an unbounded prompt. A ceiling a single item can blow is
 * not a ceiling. Making `clip` part of the signature removes the hole
 * structurally instead of by convention — a caller cannot forget it.
 *
 * The item cap is applied first, then the byte ceiling walks the survivors in
 * order and stops at the first item that would overflow. Stopping — rather than
 * skipping the big item and continuing — keeps the result a strict prefix,
 * which is what makes the output deterministic and diffable across replicas.
 *
 * When the FIRST item alone exceeds the ceiling it is clipped rather than
 * dropped: an empty section is indistinguishable from "there was nothing to
 * say", which is exactly the ambiguity issue #511 exists to remove. The clip is
 * deterministic (a byte prefix plus a fixed marker), so the prompt stays
 * byte-stable, and it is metered under `max_bytes`.
 */
export function applyBudget<T>(
  section: TurnContextSection & string,
  items: readonly T[],
  budget: SectionBudget,
  size: (item: T) => number,
  clip: (item: T, maxBytes: number) => T,
): BudgetOutcome<T> {
  const byCount = items.slice(0, budget.max_items);
  const droppedByCount = items.length - byCount.length;

  const kept: T[] = [];
  let bytes = 0;
  let droppedByBytes = 0;
  let clipped = 0;

  for (const item of byCount) {
    const itemBytes = size(item);
    if (bytes + itemBytes > budget.max_bytes) {
      if (kept.length === 0) {
        // Nothing kept yet: clip this one to the ceiling so the section is
        // present but bounded.
        const clippedItem = clip(item, budget.max_bytes);
        kept.push(clippedItem);
        bytes += size(clippedItem);
        clipped = 1;
      }
      droppedByBytes = byCount.length - kept.length;
      break;
    }
    kept.push(item);
    bytes += itemBytes;
  }

  const dropped = droppedByCount + droppedByBytes;
  const reason: 'max_items' | 'max_bytes' | null =
    droppedByCount > 0 ? 'max_items' : droppedByBytes + clipped > 0 ? 'max_bytes' : null;

  // Attribute each loss to the limit that actually caused it, rather than
  // collapsing both into whichever bit first — an operator tuning a budget
  // needs to know which knob to turn.
  if (droppedByCount > 0) recordTruncation(section, 'max_items', droppedByCount);
  const lostToBytes = droppedByBytes + clipped;
  if (lostToBytes > 0) recordTruncation(section, 'max_bytes', lostToBytes);
  recordSectionSize(section, bytes, estimateTokens(bytes));

  return { items: kept, dropped, clipped, reason, bytes };
}

/** Byte size of a string as it will appear in the prompt (UTF-8). */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
