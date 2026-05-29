/**
 * Typed builder for a production `skills` row (`src/db/schema.ts:1894-1965`).
 *
 * Why this exists: ad-hoc `mkRow` helpers in cross-tenant specs (e.g.
 * `tests/unit/runtime/decision/action-decider-cross-tenant.spec.ts`) returned
 * a STRIPPED-DOWN row missing NOT NULL columns from the real schema — `goal`,
 * `procedure`, `constraints`, `input_schema`, `output_schema`,
 * `success_criteria`, `failure_modes`, `proposed_by`, `created_at`. Those
 * specs use a fake DB that does NOT enforce schema constraints, so the
 * omissions are silently tolerated. A future regression where the production
 * INSERT path adds a real constraint or where a code path begins reading one
 * of these JSONB columns would PASS the existing spec while FAILING in
 * production (NOT NULL violation or `undefined`-deref).
 *
 * The builder returns a COMPLETE row whose every field matches the real
 * `NewSkillRow` type (`typeof skills.$inferInsert`). Spec authors override
 * only the columns the test exercises via `Partial`.
 *
 * Codex PR #236 review v2 (BLOCKER 3b): the cross-tenant spec must seed the
 * fake DB with rows that mirror the production schema shape, so a future
 * refactor cannot silently widen the surface a missing field would crash on.
 *
 * Usage:
 *   const row = mkSkillRow({ id: 's_A', tenant_id: 'tenant-A' });
 *   const row = mkSkillRow({
 *     id: 'compose_message',
 *     tenant_id: 'tenant-A',
 *     agent_id: null,
 *     allowed_tools: ['tool_for_A_compose'],
 *   });
 */
import type { NewSkillRow } from '@/db/schema.js';

/**
 * Default `created_at` timestamp. Matches the convention used by
 * `tests/fixtures/base-context-packet.ts` (frozen 2026-01-01 UTC) so traces
 * across fixtures share a stable wall clock.
 */
const DEFAULT_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * Build a complete `skills` row for use in specs. Every NOT NULL column has a
 * sensible default; pass `overrides` to tune only what the spec exercises.
 *
 * The defaults map 1:1 to an `active`, `tool_mediated`, `agent_id`-scoped
 * skill that ships with a single allowed tool named `tool_for_<id>` — the
 * most common test shape across the Decision Engine cross-tenant specs.
 *
 * Note on JSONB shape: `input_schema` / `output_schema` are NOT NULL in the
 * DB but have NO default — the production INSERT path always supplies them.
 * We use minimal `{ type: 'object', properties: {} }` placeholders so the
 * shape is structurally valid (an empty object would also be NOT NULL-safe
 * but a `type: 'object'` shape is closer to the JSON Schema convention the
 * production code emits).
 */
export function mkSkillRow(overrides?: Partial<NewSkillRow>): NewSkillRow {
  const id = overrides?.id ?? 'skill-fixture';
  const descriptor = overrides?.skill_descriptor ?? id;
  return {
    id,
    tenant_id: 'tenant-fixture',
    agent_id: 'agent-fixture',
    skill_descriptor: descriptor,
    category: 'tool_mediated',
    execution_mode: 'tool_mediated',
    goal: 'fixture goal',
    when_to_use: '',
    procedure: {},
    constraints: [],
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: {} },
    allowed_tools: [`tool_for_${id}`],
    policy_descriptors: [],
    success_criteria: [],
    failure_modes: [],
    runtime_hints: {},
    status: 'active',
    version: 1,
    proposed_by: 'fixture-proposer',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: null,
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: DEFAULT_CREATED_AT,
    ...overrides,
  };
}
