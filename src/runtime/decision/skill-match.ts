/**
 * F1 Phase 0 — deterministic skill/intent matcher (anti-hijack guard).
 *
 * SkillSelector used to return the top active skill ranked by
 * (category × priority) for EVERY turn, regardless of whether the message
 * related to that skill. With the Decision Engine ON, that meant any active
 * skill hijacked every conversation. This module scores how well a classified
 * intent matches a skill so the selector can select ONLY on a clear match and
 * otherwise return an empty selection (routing the turn to a normal `respond`).
 *
 * The scorer is intentionally:
 *   - DETERMINISTIC + CHEAP: pure string/token math over data already in hand
 *     (the upstream-classified `intent` + the skill's `applicable_to_intent` /
 *     `when_to_use` / descriptor). No new LLM call, no I/O — import-safe.
 *   - CONSERVATIVE: when nothing clearly matches it scores low so the selector
 *     under-selects. Under-selecting is safe (free-form chat); over-selecting
 *     hijacks.
 *
 * Score is in [0, 1]:
 *   1.00  exact `applicable_to_intent` membership (strongest, explicit contract)
 *   ~0.x  token overlap between the intent label and the skill's `when_to_use`
 *         text / descriptor (Jaccard-style ratio of intent tokens covered)
 *   0.00  the intent is unusable (empty / `unknown`) or nothing overlaps
 */
import type { Skill } from './types.js';
import type { DecisionPacket } from '../context-packet/types.js';

/**
 * Minimum match score for the selector to commit to a `selected_skill_id`.
 * Anything below routes the turn to a normal free-form `respond`. Tuned so a
 * single shared token (e.g. a skill descriptor that merely mentions a common
 * word) is NOT enough on its own, but an explicit `applicable_to_intent` hit or
 * a strong descriptor/`when_to_use` overlap is.
 */
export const SKILL_MATCH_THRESHOLD = 0.5;

/**
 * Intent labels that signal "no clear intent" — never strong enough to select
 * a skill from on their own (they would match nothing meaningfully and only
 * invite hijack). Kept lowercase.
 */
const NON_COMMITTAL_INTENT_LABELS: ReadonlySet<string> = new Set([
  '',
  'unknown',
  'unclear',
  'ambiguous',
]);

/**
 * Tokens too generic to carry matching signal. Without this, a `when_to_use`
 * like "use when the user asks about ..." would match almost any intent.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'when', 'use', 'used',
  'this', 'skill', 'user', 'about', 'with', 'on', 'in', 'is', 'are', 'be',
  'request', 'intent', 'query', 'asks', 'ask', 'wants', 'want',
  // Portuguese (Maia is pt-BR first)
  'o', 'os', 'a', 'as', 'de', 'do', 'da', 'para', 'e', 'ou', 'quando',
  'usar', 'usado', 'esta', 'este', 'usuario', 'usuário', 'sobre', 'com',
  'em', 'no', 'na', 'pedido', 'pergunta', 'quer', 'solicita',
]);

/** Split a string into lowercase alphanumeric tokens, dropping stopwords. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9á-ú]+/i)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Tokens that carry meaning from an intent label (snake/space separated). */
function intentTokens(label: string): string[] {
  return tokenize(label);
}

/**
 * Score how well `intent` matches `skill` in [0, 1]. Higher = stronger match.
 *
 * Exported for unit testing of the boundary behaviour.
 */
export function scoreSkillMatch(
  skill: Skill,
  intent: DecisionPacket['intent'],
): number {
  const label = (intent.label ?? '').trim().toLowerCase();
  if (NON_COMMITTAL_INTENT_LABELS.has(label)) return 0;

  // 1. Explicit contract: applicable_to_intent membership is the strongest,
  //    most intentional signal a skill author can give. Exact (case-insensitive).
  const applicable = (skill.applicable_to_intent ?? []).map((i) =>
    i.trim().toLowerCase(),
  );
  if (applicable.includes(label)) return 1;

  // 2. Token overlap between the intent and the skill's free-text guidance.
  const iTokens = intentTokens(label);
  if (iTokens.length === 0) return 0;

  const haystack = [
    skill.when_to_use ?? '',
    skill.id ?? '',
    ...applicable,
  ].join(' ');
  const hTokens = new Set(tokenize(haystack));
  if (hTokens.size === 0) return 0;

  let covered = 0;
  for (const t of iTokens) {
    if (hTokens.has(t)) covered += 1;
  }
  // Ratio of the intent's meaningful tokens that the skill covers. Requiring
  // a *proportion* (not an absolute count) keeps a long `when_to_use` from
  // matching every intent just by containing many words.
  return covered / iTokens.length;
}
