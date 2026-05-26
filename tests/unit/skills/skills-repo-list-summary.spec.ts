/**
 * Review PR #209 finding 2 — skillsRepo list bounding + summary projection.
 *
 * These tests exercise the REAL skillsRepo (not a mock) against a fake drizzle
 * query-builder injected via `@/db/client.js`. The fake records the arguments
 * passed to `.select(...)` and `.limit(...)` so we can assert the two
 * guarantees the finding requires WITHOUT a live database:
 *
 *   1. `listSummaries` selects ONLY the summary columns — never the large
 *      JSONB contract fields (procedure / input_schema / output_schema /
 *      constraints / success_criteria / failure_modes / runtime_hints /
 *      allowed_tools / policy_descriptors).
 *   2. Both `listAll` (full-row legacy path) and `listSummaries` clamp the row
 *      count to SKILLS_LIST_MAX_LIMIT server-side, regardless of the caller's
 *      requested limit (missing / oversized / non-positive all collapse to the
 *      cap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// Capture the args the repo passes through the query builder.
const calls: { selectArg: unknown; limitArg: number | undefined }[] = [];
let current: { selectArg: unknown; limitArg: number | undefined };
// Rows the fake "returns" when awaited (kept tiny; content is irrelevant —
// these tests assert on the QUERY shape, not the result rows).
let cannedRows: unknown[] = [];

vi.mock('@/db/client.js', () => {
  // A thenable fluent builder: every chain method returns `this`; awaiting it
  // resolves to cannedRows. `.select(arg)` and `.limit(arg)` record their args.
  function makeBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.from = chain;
    builder.where = chain;
    builder.orderBy = chain;
    builder.limit = (n: number) => {
      current.limitArg = n;
      return builder;
    };
    // Make it awaitable — resolves to the canned rows.
    builder.then = (resolve: (v: unknown[]) => unknown) => resolve(cannedRows);
    return builder;
  }
  return {
    db: {
      select(arg?: unknown) {
        current = { selectArg: arg, limitArg: undefined };
        calls.push(current);
        return makeBuilder();
      },
    },
    withTx: vi.fn(),
  };
});

// Import AFTER the mock so the repo binds to the faked `db`.
const repoModule = await import('@/control-plane/skill-registry/skills-repo.js');
const { skillsRepo, SKILLS_LIST_MAX_LIMIT } = repoModule;

const BIG_JSONB_FIELDS = [
  'procedure',
  'input_schema',
  'output_schema',
  'constraints',
  'success_criteria',
  'failure_modes',
  'runtime_hints',
  'allowed_tools',
  'policy_descriptors',
];

const SUMMARY_FIELDS = [
  'id',
  'tenant_id',
  'agent_id',
  'skill_descriptor',
  'category',
  'execution_mode',
  'version',
  'status',
  'activated_at',
  'created_at',
];

describe('skillsRepo.listSummaries — projection (review PR #209 finding 2)', () => {
  beforeEach(() => {
    calls.length = 0;
    cannedRows = [];
  });

  it('selects ONLY the summary columns — no large JSONB fields', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listSummaries();
    });
    expect(calls).toHaveLength(1);
    const projection = calls[0]!.selectArg as Record<string, unknown>;
    // A column map was passed (not a bare select()).
    expect(projection).toBeTruthy();
    const keys = Object.keys(projection);
    // Exactly the summary columns, in any order.
    expect(keys.sort()).toEqual([...SUMMARY_FIELDS].sort());
    // None of the heavy JSONB / array columns leaked into the projection.
    for (const f of BIG_JSONB_FIELDS) {
      expect(keys).not.toContain(f);
    }
  });

  it('caps the row count at SKILLS_LIST_MAX_LIMIT when no limit is given', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listSummaries();
    });
    expect(calls[0]!.limitArg).toBe(SKILLS_LIST_MAX_LIMIT);
  });

  it('clamps an oversized limit down to the cap', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listSummaries(undefined, SKILLS_LIST_MAX_LIMIT + 5000);
    });
    expect(calls[0]!.limitArg).toBe(SKILLS_LIST_MAX_LIMIT);
  });

  it('honours a smaller in-range limit', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listSummaries('active', 25);
    });
    expect(calls[0]!.limitArg).toBe(25);
  });

  it('collapses a non-positive limit to the cap (never unbounded)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listSummaries(undefined, 0);
    });
    expect(calls[0]!.limitArg).toBe(SKILLS_LIST_MAX_LIMIT);
  });
});

describe('skillsRepo.listAll — full-row path stays bounded (review PR #209 finding 2)', () => {
  beforeEach(() => {
    calls.length = 0;
    cannedRows = [];
  });

  it('selects full rows (bare select, no projection arg)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listAll();
    });
    expect(calls).toHaveLength(1);
    // Legacy full-row contract: select() called with no projection argument.
    expect(calls[0]!.selectArg).toBeUndefined();
  });

  it('still caps at SKILLS_LIST_MAX_LIMIT (default + oversized both clamp)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listAll(); // default
      await skillsRepo.listAll('active', 99999); // oversized
    });
    expect(calls[0]!.limitArg).toBe(SKILLS_LIST_MAX_LIMIT);
    expect(calls[1]!.limitArg).toBe(SKILLS_LIST_MAX_LIMIT);
  });
});
