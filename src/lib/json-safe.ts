/**
 * Centralized "extract JSON from LLM output" helper.
 *
 * Cognitive modules ask the LLM for strict JSON but the model frequently
 * wraps it in prose or a markdown fence. The defensive parse pattern
 *
 *   const match = text.match(/\{[\s\S]*\}/);
 *   if (!match) return null;
 *   try {
 *     const parsed = Schema.safeParse(JSON.parse(match[0]));
 *     return parsed.success ? parsed.data : null;
 *   } catch {
 *     return null;
 *   }
 *
 * was duplicated across `src/cognition/` and `src/workers/`. This helper is
 * the single implementation of that pattern.
 *
 * Contract (FAIL-CLOSED, never throws):
 *  - Extraction is greedy first-`{`-to-last-`}` — identical to the inline
 *    regex it replaces, so prose/fences around the object are tolerated and
 *    nested objects survive.
 *  - No `{...}` in the text → null. Malformed JSON → null. Zod schema
 *    mismatch → null.
 *  - Success returns the Zod OUTPUT type (defaults/transforms applied).
 *
 * When NOT to use this helper — sites that need to OBSERVE the failure:
 *  - `src/shared/risk/llm-gate.ts` throws typed `LLMGateParseError`s per
 *    stage so the cognitive runner records status='error' (fail-loud by
 *    design, Codex review #97 finding 2).
 *  - Sites that log/audit on parse failure, return stage-specific fallback
 *    payloads, or deliberately let `JSON.parse` throw into
 *    `runCognitiveModule` keep their inline versions.
 */
import { z } from 'zod';

/**
 * Extract the first JSON object from LLM output text, parse it and validate
 * it against `schema`. Returns the validated value, or `null` on any
 * failure (no JSON found / malformed JSON / schema mismatch). Never throws.
 */
export function safeExtractAndParseJson<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
