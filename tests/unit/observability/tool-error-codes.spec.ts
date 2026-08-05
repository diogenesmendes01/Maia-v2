/**
 * Issue #535 §2 — the tool-dispatch SLI must not count governance as an outage.
 *
 * `classifyToolResult` used to carry a hand-written `switch` over five codes.
 * The dispatcher and the MCP bridge return NINETEEN, and every unmapped one
 * fell into the default `error` — so `feature_disabled`, `redis_unavailable_blocked`,
 * `approval_pending`, `requires_confirmation`, `requires_dual_approval` and
 * `mcp_tool_not_executable` (all of them fail-closed refusals working exactly
 * as designed) inflated `maia:tool_error_ratio:rate5m`, the numerator of
 * `MaiaToolErrorRateHigh` in `monitoring/alerts/slo.rules.yml`.
 *
 * ### How this file proves EXHAUSTIVENESS rather than sampling
 *
 * A list of `expect(classify(x)).toBe(y)` cases only ever proves the cases
 * somebody remembered. So the first describe block does not enumerate anything
 * by hand: it STATICALLY SCANS `src/tools/_dispatcher.ts` and
 * `src/tools/mcp-bridge.ts` for every `error:` literal they can return, and
 * asserts SET EQUALITY against the closed sets those modules export. Both
 * directions fail loudly:
 *
 *   - add a `return { error: 'new_code' }` to the dispatcher without listing it
 *     ⇒ scanned ⊃ declared ⇒ red;
 *   - list a code nothing returns ⇒ declared ⊃ scanned ⇒ red.
 *
 * The classification table below then covers 100% of that same set, checked by
 * key equality — so a newly-listed code cannot reach the metric until someone
 * has said, in this file, whether it is the platform refusing or the platform
 * breaking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyToolResult, type ToolDispatchOutcome } from '@/observability/instrumentation.js';
import { DISPATCHER_ERROR_CODES } from '@/tools/_dispatcher.js';
import { MCP_BRIDGE_ERROR_CODES } from '@/tools/mcp-bridge.js';
import {
  TOOL_ERROR_CODES,
  TOOL_FAILURE_CODES,
  TOOL_INVALID_CODES,
  TOOL_REFUSAL_CODES,
  type ToolErrorCode,
} from '@/tools/_dispatch-error-codes.js';

/**
 * Pull every code a module can put in `{ error: … }`.
 *
 * Two shapes exist in the sources, and both must be caught:
 *   `return { error: 'tool_disabled', … }`
 *   `error: approvalRequirement === 'single' ? 'requires_confirmation' : 'requires_dual_approval'`
 *
 * The value expression is cut at the first top-level `,` or `}` so a sibling
 * `details: { … , feature_flag: 'MCP_TOOLS' }` on the same line cannot be
 * mistaken for a code, and the comparison operands of a ternary (`=== 'single'`)
 * are stripped so a CONDITION cannot invent one either. Type declarations
 * (`error: string`) are skipped — they declare the field, they do not return.
 */
function errorValueExpression(rest: string): string {
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && (ch === ',' || ch === '}')) return rest.slice(0, i);
    else if (ch === '}') depth -= 1;
  }
  return rest;
}

function scanReturnedErrorCodes(file: string): { codes: Set<string>; sites: number } {
  const source = readFileSync(join(process.cwd(), file), 'utf8');
  const codes = new Set<string>();
  let sites = 0;
  for (const match of source.matchAll(/\berror:\s*(.+)$/gm)) {
    const rest = match[1]!;
    if (/^(string|unknown)\b/.test(rest)) continue;
    sites += 1;
    const expression = errorValueExpression(rest).replace(/[!=]==?\s*'[^']*'/g, '');
    for (const literal of expression.matchAll(/'([^']*)'/g)) codes.add(literal[1]!);
  }
  return { codes, sites };
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

describe('issue #535 — the refusal vocabulary is a CLOSED set, scanned from the source', () => {
  it('DISPATCHER_ERROR_CODES is exactly what src/tools/_dispatcher.ts returns', () => {
    const { codes, sites } = scanReturnedErrorCodes('src/tools/_dispatcher.ts');
    expect(sorted(codes)).toEqual(sorted(DISPATCHER_ERROR_CODES));
    // Tripwire: if the return shape is ever refactored away from string
    // literals, the scan would find nothing and both sets would "agree" at
    // zero. 20 `error:` sites yield the 17 distinct codes today (`forbidden`
    // ×3, `execution_failed` ×2, `idempotency_payload_hash_collision` ×2, and
    // one ternary that yields two). Assert the scan never collapses.
    expect(sites).toBeGreaterThanOrEqual(20);
  });

  it('MCP_BRIDGE_ERROR_CODES is exactly what src/tools/mcp-bridge.ts returns', () => {
    const { codes, sites } = scanReturnedErrorCodes('src/tools/mcp-bridge.ts');
    expect(sorted(codes)).toEqual(sorted(MCP_BRIDGE_ERROR_CODES));
    expect(sites).toBeGreaterThanOrEqual(8);
  });

  it('the classification sets partition the whole vocabulary — nothing double-counted, nothing orphaned', () => {
    const union = sorted([...TOOL_REFUSAL_CODES, ...TOOL_INVALID_CODES, ...TOOL_FAILURE_CODES]);
    const produced = sorted([...DISPATCHER_ERROR_CODES, ...MCP_BRIDGE_ERROR_CODES]);
    expect(union).toEqual(produced);
    expect(sorted(TOOL_ERROR_CODES)).toEqual(produced);

    const counted = [...TOOL_REFUSAL_CODES, ...TOOL_INVALID_CODES, ...TOOL_FAILURE_CODES];
    expect(counted).toHaveLength(new Set(counted).size);
  });
});

/**
 * The intent, stated ONCE and by hand — deliberately not derived from the
 * production sets, or the assertion would be a tautology that agrees with any
 * regression.
 */
const EXPECTED: Readonly<Record<ToolErrorCode, ToolDispatchOutcome>> = {
  // --- governance refusing: the platform working, NOT the error SLI --------
  forbidden: 'blocked',
  tool_not_granted: 'blocked',
  tool_disabled: 'blocked',
  feature_disabled: 'blocked',
  no_entity_in_scope: 'blocked',
  redis_unavailable_blocked: 'blocked',
  approval_pending: 'blocked',
  requires_confirmation: 'blocked',
  requires_dual_approval: 'blocked',
  mcp_tool_not_executable: 'blocked',
  // --- the call was malformed: model/prompt quality ------------------------
  invalid_args: 'invalid',
  unknown_tool: 'invalid',
  // --- the platform broke: this is what pages ------------------------------
  execution_failed: 'error',
  mcp_call_failed: 'error',
  idempotency_payload_hash_collision: 'error',
  idempotency_prior_failed: 'error',
  idempotency_owner_failed: 'error',
  idempotency_wait_timeout: 'error',
  idempotency_completion_fenced: 'error',
};

describe('issue #535 — every code the tool boundary can return is classified', () => {
  it('covers the closed set exactly — no gaps, no phantoms', () => {
    expect(sorted(Object.keys(EXPECTED))).toEqual(sorted(TOOL_ERROR_CODES));
  });

  it.each(Object.entries(EXPECTED))('classifies %s as %s', (code, expected) => {
    expect(classifyToolResult({ error: code })).toBe(expected);
  });

  it('no dispatcher or bridge code falls into the default bucket by accident', () => {
    // The regression this whole spec exists for: a fail-closed refusal landing
    // in `error` and paging somebody for governance doing its job.
    for (const code of TOOL_REFUSAL_CODES) {
      expect(classifyToolResult({ error: code }), `${code} must not read as an outage`).toBe(
        'blocked',
      );
    }
  });

  it('keeps `error` as the default for a code outside the boundary vocabulary', () => {
    // Tool HANDLERS also return `{ error }` (e.g. `cancel-transaction` →
    // `not_found`, `generate-report` → `pdf_generation_failed`). Those are not
    // dispatcher verdicts; counting an unrecognised failure as a failure is the
    // fail-safe direction.
    expect(classifyToolResult({ error: 'not_found' })).toBe('error');
    expect(classifyToolResult({ error: 'db_timeout' })).toBe('error');
  });

  it('does not classify a code no dispatcher path can return', () => {
    // `approval_required` is a skill EXPOSURE policy
    // (`src/skills/usage-policy.ts:45`) that the old hand-written switch mapped
    // to `blocked`. A copy of a vocabulary drifts in BOTH directions.
    expect(TOOL_ERROR_CODES).not.toContain('approval_required');
  });
});
