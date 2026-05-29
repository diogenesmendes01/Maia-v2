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

describe('skillsRepo.listSummariesPage — truncation signal (review PR #209 finding A)', () => {
  beforeEach(() => {
    calls.length = 0;
    cannedRows = [];
  });

  // Build n believable summary rows.
  function summaryRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      tenant_id: 'default',
      agent_id: 'agent-x',
      skill_descriptor: `d${i}`,
      category: 'classify',
      execution_mode: 'prompt_only',
      version: 1,
      status: 'active',
      activated_at: null,
      created_at: new Date(),
    }));
  }

  it('uses the summary projection (no large JSONB) like listSummaries', async () => {
    cannedRows = summaryRows(1);
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listSummariesPage();
    });
    const projection = calls[0]!.selectArg as Record<string, unknown>;
    expect(projection).toBeTruthy();
    expect(Object.keys(projection).sort()).toEqual([...SUMMARY_FIELDS].sort());
    for (const f of BIG_JSONB_FIELDS) {
      expect(Object.keys(projection)).not.toContain(f);
    }
  });

  it('fetches cap+1 rows to probe for more (default limit)', async () => {
    cannedRows = summaryRows(SKILLS_LIST_MAX_LIMIT + 1);
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listSummariesPage();
    });
    // The probe is the cap + 1 — never an unbounded select.
    expect(calls[0]!.limitArg).toBe(SKILLS_LIST_MAX_LIMIT + 1);
  });

  it('hasMore=true and items sliced to the cap when more than cap rows exist', async () => {
    cannedRows = summaryRows(SKILLS_LIST_MAX_LIMIT + 1);
    const res = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'agent-x' },
      async () => skillsRepo.listSummariesPage(),
    );
    expect(res.hasMore).toBe(true);
    expect(res.items).toHaveLength(SKILLS_LIST_MAX_LIMIT);
  });

  it('hasMore=false and returns all rows when at or under the cap', async () => {
    cannedRows = summaryRows(SKILLS_LIST_MAX_LIMIT); // exactly cap, no probe overflow
    const res = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'agent-x' },
      async () => skillsRepo.listSummariesPage(),
    );
    expect(res.hasMore).toBe(false);
    expect(res.items).toHaveLength(SKILLS_LIST_MAX_LIMIT);
  });

  it('respects a smaller in-range limit for the probe (limit+1)', async () => {
    cannedRows = summaryRows(11); // 11 = limit(10) + 1 → hasMore
    const res = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'agent-x' },
      async () => skillsRepo.listSummariesPage('active', 10),
    );
    expect(calls[0]!.limitArg).toBe(11);
    expect(res.hasMore).toBe(true);
    expect(res.items).toHaveLength(10);
  });
});

describe('skillsRepo.listVersions — summary projection + cap (review PR #209 finding B)', () => {
  beforeEach(() => {
    calls.length = 0;
    cannedRows = [];
  });

  const VERSION_SUMMARY_FIELDS = [
    'id',
    'version',
    'status',
    'agent_id',
    'activated_at',
    'deprecated_at',
    'rolled_back_at',
    'created_at',
    'proposed_by',
    'approved_by',
  ];

  it('selects ONLY scalar version columns — no large JSONB fields', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listVersions('detect_legal_risk');
    });
    expect(calls).toHaveLength(1);
    const projection = calls[0]!.selectArg as Record<string, unknown>;
    expect(projection).toBeTruthy();
    expect(Object.keys(projection).sort()).toEqual([...VERSION_SUMMARY_FIELDS].sort());
    for (const f of BIG_JSONB_FIELDS) {
      expect(Object.keys(projection)).not.toContain(f);
    }
  });

  it('caps the version history at SKILLS_LIST_MAX_LIMIT', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'agent-x' }, async () => {
      await skillsRepo.listVersions('detect_legal_risk');
    });
    expect(calls[0]!.limitArg).toBe(SKILLS_LIST_MAX_LIMIT);
  });
});
