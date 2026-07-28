/**
 * Issue #511 — typed contract for turn-context loading.
 *
 * The problem this replaces: every optional block of the prompt builder was a
 * bare `try { … } catch { /* degrade *\/ }`. That preserves availability, which
 * is right, but it makes six very different situations indistinguishable to the
 * operator looking at a thin prompt:
 *
 *   legitimately empty · timed out · query failed · stale cache ·
 *   repository unavailable · omitted by budget
 *
 * `LoadedSection` forces the difference to be carried in the value instead of
 * being thrown away, so `empty` and `degraded` can never be confused again.
 */

export type SectionSource = 'db' | 'cache';

export type LoadedSection<T> =
  /** Loaded successfully. `truncated` counts items dropped by the budget. */
  | { status: 'loaded'; value: T; source: SectionSource; truncated: number }
  /** Loaded successfully and there was genuinely nothing there. */
  | { status: 'empty'; value: T }
  /** The load failed. `value` is the safe fallback the caller renders instead. */
  | { status: 'degraded'; value: T; reason: string };

export function loaded<T>(
  value: T,
  opts: { source?: SectionSource; truncated?: number } = {},
): LoadedSection<T> {
  return {
    status: 'loaded',
    value,
    source: opts.source ?? 'db',
    truncated: opts.truncated ?? 0,
  };
}

export function empty<T>(value: T): LoadedSection<T> {
  return { status: 'empty', value };
}

export function degraded<T>(value: T, reason: string): LoadedSection<T> {
  return { status: 'degraded', value, reason };
}

/**
 * Wrap an array result: an empty array is `empty`, not `loaded`. The
 * distinction is the whole point — "no memories for this person" and "the
 * memory read failed" must not render the same way in a dashboard.
 */
export function fromArray<T>(
  items: T[],
  opts: { source?: SectionSource; truncated?: number } = {},
): LoadedSection<T[]> {
  return items.length === 0 && !opts.truncated ? empty(items) : loaded(items, opts);
}

/**
 * Per-section limits.
 *
 * `max_items` values reproduce the caps that were previously hard-coded inline
 * (`facts.slice(0, 20)`, `topSkills.slice(0, 5)`, `findRelevant({limit: 30})`,
 * …) — this commit does not change WHAT gets cut, it makes the cut visible and
 * gives it a byte ceiling as well.
 *
 * `max_bytes` is the new half. An item cap alone does not bound the prompt: 20
 * facts whose values are 50 KB blobs is still 1 MB of context, and nothing
 * stopped one tenant from producing it. The byte ceiling is what makes a single
 * tenant unable to generate an unbounded prompt (issue §6).
 *
 * Policy/permission blocks are DELIBERATELY absent from this table: the scope
 * block, the LLM boundaries and the input-handling rules are never truncated,
 * because silently dropping a security rule would be a governance failure
 * wearing a performance costume (issue §6, "nunca truncar silenciosamente
 * policies/permissions").
 */
export type SectionBudget = { max_items: number; max_bytes: number };

export const SECTION_BUDGETS = {
  history: { max_items: 10, max_bytes: 24_000 },
  facts: { max_items: 20, max_bytes: 8_000 },
  rules: { max_items: 20, max_bytes: 8_000 },
  memories: { max_items: 30, max_bytes: 8_000 },
  hints: { max_items: 20, max_bytes: 4_000 },
  capabilities: { max_items: 5, max_bytes: 2_000 },
  gaps: { max_items: 5, max_bytes: 2_000 },
  entity_states: { max_items: 100, max_bytes: 8_000 },
} as const satisfies Record<string, SectionBudget>;

export type BudgetedSection = keyof typeof SECTION_BUDGETS;

/**
 * Item cap for the gap list inside the self-awareness ("## Autoconhecimento")
 * section — the "Ainda não tem: …" clause.
 *
 * The `capabilities` budget has TWO contributing lists with different natural
 * sizes: skill names (short identifiers) and capability descriptions (free-form
 * sentences). They share one `max_bytes` ceiling — that is what makes the
 * SECTION bounded rather than just one of its clauses — but each gets its own
 * item cap, because "5 skills" and "3 gaps" are independent editorial choices.
 */
export const SELF_AWARENESS_GAP_MAX_ITEMS = 3;

/** Roll-up published once per turn, and logged with the trace id. */
export type TurnContextDiagnostics = {
  query_count: number;
  duration_ms: number;
  cache_hits: number;
  /** Sections that failed to load and rendered a fallback. */
  degraded_sections: string[];
  /** Sections the budget cut, with how many items were dropped. */
  truncated_sections: Array<{ section: string; dropped: number; reason: string }>;
};
