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
 *         text / descriptor — the ratio of the intent's meaningful tokens the
 *         skill covers (token-COVERAGE, not Jaccard: the haystack size does not
 *         shrink the score, only the proportion of intent tokens hit does).
 *   0.00  the intent is unusable (empty / `unknown`) or nothing overlaps
 *
 * Anti-hijack policy (Codex PR #215 review, BLOCKER 1): a SINGLE shared token
 * out of a multi-token intent must NEVER be enough to select — otherwise a
 * 2-token intent that happens to share one common word (e.g. `cancel_order`
 * overlapping a `cancel_subscription` skill on just `cancel`) would score the
 * raw ratio `1/2 = 0.5` and hijack the turn. So a partial overlap that covers
 * exactly one meaningful token is DAMPED below the selection threshold. To clear
 * the bar on overlap alone a skill must either cover EVERY meaningful intent
 * token (full coverage — including the legitimate single-token intent case) or
 * cover at least two of them.
 */
import type { Skill } from './types.js';
import type { DecisionPacket } from '../context-packet/types.js';

/**
 * Minimum match score for the selector to commit to a `selected_skill_id`.
 * Anything below routes the turn to a normal free-form `respond`.
 *
 * Combined with the single-token damping in `scoreSkillMatch` (see the module
 * header), a single shared token out of a multi-token intent scores below this
 * bar and can NOT select; an explicit `applicable_to_intent` hit, full
 * token-coverage, or ≥2 covered meaningful tokens clears it.
 */
export const SKILL_MATCH_THRESHOLD = 0.5;

/**
 * Multiplier applied to a partial token-overlap score that covers exactly ONE
 * meaningful intent token while the intent has more. It must push the worst
 * boundary case (1 of 2 tokens, raw ratio `0.5`) strictly below
 * SKILL_MATCH_THRESHOLD: `0.5 * 0.5 = 0.25 < 0.5`. This is what makes a lone
 * shared token incapable of selecting a skill (anti-hijack BLOCKER 1).
 */
const SINGLE_TOKEN_DAMPING = 0.5;

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

/**
 * Split a string into lowercase ASCII tokens, dropping stopwords.
 *
 * Normalizes to NFD and strips combining diacritical marks first so accented
 * pt-BR text matches its unaccented form (e.g. `saudação` ⇒ `saudacao`,
 * `usuário` ⇒ `usuario`). Without this, the classified intent label (often
 * unaccented, snake_case) would never overlap an accented `when_to_use`.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '') // strip combining diacritical marks
    .split(/[^a-z0-9]+/i)
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
  if (covered === 0) return 0;

  // Ratio of the intent's meaningful tokens the skill covers. Using a
  // *proportion* (not an absolute count) keeps a long `when_to_use` from
  // matching every intent just by containing many words.
  const ratio = covered / iTokens.length;

  // Anti-hijack (BLOCKER 1): a single shared token out of a MULTI-token intent
  // must not select. Full coverage (covered === total — this also covers the
  // legitimate single-token intent) and ≥2 covered tokens keep the raw ratio;
  // a lone covered token amid others is damped below SKILL_MATCH_THRESHOLD so
  // the `1/2 = 0.5` boundary case can never commit a selection.
  //
  // The `covered >= 2` branch is DELIBERATE (Codex #217 review item 1):
  // covering two DISTINCT meaningful intent tokens is a genuine signal, so e.g.
  // 2-of-4 (raw ratio exactly 0.5) is allowed to clear SKILL_MATCH_THRESHOLD and
  // select — in contrast to the damped lone-token case. A thinner spread still
  // fails on the ratio alone (e.g. 2-of-6 = 0.33 < 0.5). Both the 2-of-4
  // (selects) and 1-of-2 (does not) boundaries are pinned by tests at the
  // scoreSkillMatch AND SkillSelector levels.
  if (covered >= 2 || covered === iTokens.length) {
    return ratio;
  }
  return ratio * SINGLE_TOKEN_DAMPING;
}
