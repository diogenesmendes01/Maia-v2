/**
 * Issue #355 — scheduling tenant-leak suite (REAL Postgres).
 *
 * The single most important property for the Spec-18 scheduling subsystem: a
 * worker (or tool handler) routed to tenant A must NEVER read or mutate tenant
 * B's series / occurrences / tasks / outbox_messages. The unit spec
 * (`tests/unit/scheduling-tenant-isolation.spec.ts`) proves the predicates are
 * present (store-mock + raw-CTE SQL assertions); THIS spec proves the predicates
 * actually isolate against real Postgres semantics — including the three claim
 * CTEs (`claimDue` / `reclaimExpiredLeases` / `claimInProgressForAdvance`) whose
 * `FOR UPDATE SKIP LOCKED` + UPDATE pair a mock cannot fully model.
 *
 * Harness mirrors the existing leak suites (`tests/integration/repos-leak.spec.ts`
 * and `tests/integration/scheduling`-adjacent `issue-316-exactly-once-outbox.spec.ts`):
 *   - Gated on `TEST_DB_URL` AND `DATABASE_URL === TEST_DB_URL`. The repo methods
 *     use the global `db` connection pool (bound to DATABASE_URL at import time),
 *     while seeding/inspection uses a raw `pg.Pool` on TEST_DB_URL — so the two
 *     MUST address the same database. Without TEST_DB_URL the whole suite is
 *     `describe.skip`, so the unit-only CI lane passes without Postgres.
 *   - Fixtures are seeded with raw SQL via `pg.Pool` (`ON CONFLICT DO NOTHING`)
 *     and torn down in FK-safe reverse order in `afterAll` (children → parents),
 *     so even a crash mid-run leaves the next run clean.
 *
 * Migration prerequisites (manual checklist when running): the TEST_DB_URL
 * database has the scheduling migrations applied — 007_scheduling (tables),
 * 071/072/073 (tenant_id/agent_id columns + tenant-led indexes). The INSERTs
 * fail loudly if the tenant_id/agent_id columns are absent.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import pg from "pg";
import { runWithTenantContext } from "@/db/tenant-context.js";

// The worker-path test below (`runScheduling` → `runSchedulingTick`) drives the
// REAL engine against Postgres. Per the engine's side-effect contract (it NEVER
// calls Baileys/LLM directly — it only writes occurrence/task/outbox rows and
// escalations route through the outbox), the ONLY non-DB-pure call the tick
// reaches is `audit()`. Stub it to a no-op so the worker-path assertions don't
// depend on the audit_log schema or the metrics counter, while every scheduling
// REPO call (the enumerate* discovery SQL + the claim/reclaim CTEs we are here
// to exercise) still runs for real. Inert for the read/claim describe blocks
// (they never call audit). Mocking audit does NOT touch `@/scheduling/repos.js`
// — repos.ts has no dependency on the audit module.
vi.mock("@/governance/audit.js", () => ({
  audit: vi.fn(async () => undefined),
  auditTx: vi.fn(async () => undefined),
}));

// Same gate as repos-leak.spec.ts / issue-316: the global `db` pool (bound to
// DATABASE_URL) and the raw seeding pool (TEST_DB_URL) must be the SAME database.
const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Distinct, namespaced tenants/agents so the suite can't collide with other
// fixtures and cleanup can target exactly its own rows.
const TENANT_A = "sched-leak-tenant-a";
const TENANT_B = "sched-leak-tenant-b";
const AGENT_A = "sched-leak-agent-a";
const AGENT_B = "sched-leak-agent-b";
const CTX_A = { tenant_id: TENANT_A, agent_id: AGENT_A };
const CTX_B = { tenant_id: TENANT_B, agent_id: AGENT_B };

// Fixed UUIDs (deterministic seed + cleanup). `*_A` belong to tenant A, `*_B`
// to tenant B. Per tenant: one DUE pending occurrence (claimDue), one EXPIRED
// claimed occurrence (reclaimExpiredLeases), one IN_PROGRESS occurrence under a
// recurring_outreach series (claimInProgressForAdvance), and the matching
// outbox rows (one due-pending, one expired-claimed).
const PESSOA_A = "3550aaaa-0000-0000-0000-0000000000a1";
const PESSOA_B = "3550bbbb-0000-0000-0000-0000000000b1";

const SERIES_A = "3550aaaa-0000-0000-0000-00000000a001";
const SERIES_B = "3550bbbb-0000-0000-0000-00000000b001";

const OCC_DUE_A = "3550aaaa-0000-0000-0000-00000000a010";
const OCC_EXPIRED_A = "3550aaaa-0000-0000-0000-00000000a011";
const OCC_INPROG_A = "3550aaaa-0000-0000-0000-00000000a012";
const OCC_DUE_B = "3550bbbb-0000-0000-0000-00000000b010";
const OCC_EXPIRED_B = "3550bbbb-0000-0000-0000-00000000b011";
const OCC_INPROG_B = "3550bbbb-0000-0000-0000-00000000b012";

const TASK_A = "3550aaaa-0000-0000-0000-00000000a020";
const TASK_B = "3550bbbb-0000-0000-0000-00000000b020";

const OB_DUE_A = "3550aaaa-0000-0000-0000-00000000a030";
const OB_EXPIRED_A = "3550aaaa-0000-0000-0000-00000000a031";
const OB_DUE_B = "3550bbbb-0000-0000-0000-00000000b030";
const OB_EXPIRED_B = "3550bbbb-0000-0000-0000-00000000b031";

const ALL_OCC = [
  OCC_DUE_A,
  OCC_EXPIRED_A,
  OCC_INPROG_A,
  OCC_DUE_B,
  OCC_EXPIRED_B,
  OCC_INPROG_B,
];
const ALL_OB = [OB_DUE_A, OB_EXPIRED_A, OB_DUE_B, OB_EXPIRED_B];

let pool: pg.Pool;

/** Re-seed every scheduling row to a known baseline (idempotent). */
async function seedRows(c: pg.PoolClient): Promise<void> {
  // tenants + agents (FK roots for tenant_id/agent_id on every scheduling row).
  await c.query(
    `INSERT INTO tenants(id, nome) VALUES ($1,'Sched Leak A'), ($2,'Sched Leak B')
       ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await c.query(
    `INSERT INTO agents(id, tenant_id, nome)
       VALUES ($1,$2,'Sched Leak Agent A'), ($3,$4,'Sched Leak Agent B')
       ON CONFLICT (id) DO NOTHING`,
    [AGENT_A, TENANT_A, AGENT_B, TENANT_B],
  );
  // pessoas (series.owner_pessoa_id FK). Unique phone per pessoa.
  await c.query(
    `INSERT INTO pessoas(id, tenant_id, agent_id, nome, telefone_whatsapp, tipo)
       VALUES ($1,$2,$3,'Owner A','+5511000000A55','funcionario'),
              ($4,$5,$6,'Owner B','+5511000000B55','funcionario')
       ON CONFLICT (id) DO NOTHING`,
    [PESSOA_A, TENANT_A, AGENT_A, PESSOA_B, TENANT_B, AGENT_B],
  );
  // series — recurring_outreach so claimInProgressForAdvance's tipo gate matches.
  await c.query(
    // recurring series must satisfy series_schedule_kind_check: tipo <> 'one_shot_reminder'
    // requires rrule IS NOT NULL AND one_shot_at IS NULL (one_shot_at defaults to NULL here).
    `INSERT INTO series(id, tenant_id, agent_id, tipo, status, owner_pessoa_id, rrule)
       VALUES ($1,$2,$3,'recurring_outreach','active',$4,'FREQ=DAILY'),
              ($5,$6,$7,'recurring_outreach','active',$8,'FREQ=DAILY')
       ON CONFLICT (id) DO NOTHING`,
    [
      SERIES_A,
      TENANT_A,
      AGENT_A,
      PESSOA_A,
      SERIES_B,
      TENANT_B,
      AGENT_B,
      PESSOA_B,
    ],
  );
  // occurrences: due-pending (claimDue), expired-claimed (reclaimExpiredLeases),
  // in_progress with a stale claim (claimInProgressForAdvance). The expired and
  // in_progress rows are stamped claimed_at far in the past so both reapers fire.
  await c.query(
    `INSERT INTO occurrences
        (id, tenant_id, agent_id, series_id, scheduled_for, status, claimed_by, claimed_at)
      VALUES
        ($1,$2,$3,$4, now() - interval '5 minutes', 'pending',     NULL,        NULL),
        ($5,$2,$3,$4, now() - interval '5 minutes', 'claimed',     'stale-w-a', now() - interval '1 hour'),
        ($6,$2,$3,$4, now() - interval '5 minutes', 'in_progress', 'stale-w-a', now() - interval '1 hour')
      ON CONFLICT (id) DO NOTHING`,
    [OCC_DUE_A, TENANT_A, AGENT_A, SERIES_A, OCC_EXPIRED_A, OCC_INPROG_A],
  );
  await c.query(
    `INSERT INTO occurrences
        (id, tenant_id, agent_id, series_id, scheduled_for, status, claimed_by, claimed_at)
      VALUES
        ($1,$2,$3,$4, now() - interval '5 minutes', 'pending',     NULL,        NULL),
        ($5,$2,$3,$4, now() - interval '5 minutes', 'claimed',     'stale-w-b', now() - interval '1 hour'),
        ($6,$2,$3,$4, now() - interval '5 minutes', 'in_progress', 'stale-w-b', now() - interval '1 hour')
      ON CONFLICT (id) DO NOTHING`,
    [OCC_DUE_B, TENANT_B, AGENT_B, SERIES_B, OCC_EXPIRED_B, OCC_INPROG_B],
  );
  // tasks (tasksRepo.byOccurrence read isolation), one per tenant's due occurrence.
  await c.query(
    `INSERT INTO tasks(id, tenant_id, agent_id, occurrence_id, ordem, kind, status)
       VALUES ($1,$2,$3,$4,1,'fire_reminder','pending'),
              ($5,$6,$7,$8,1,'fire_reminder','pending')
       ON CONFLICT (id) DO NOTHING`,
    [
      TASK_A,
      TENANT_A,
      AGENT_A,
      OCC_DUE_A,
      TASK_B,
      TENANT_B,
      AGENT_B,
      OCC_DUE_B,
    ],
  );
  // outbox_messages: due-pending (claimDue) + expired-claimed (reclaimExpiredLeases).
  await c.query(
    `INSERT INTO outbox_messages
        (id, tenant_id, agent_id, kind, payload, status, claimed_by, claimed_at, next_attempt_at)
      VALUES
        ($1,$2,$3,'whatsapp_text','{"jid":"x","text":"a"}'::jsonb,'pending', NULL,        NULL,                       now() - interval '1 minute'),
        ($4,$2,$3,'whatsapp_text','{"jid":"x","text":"a"}'::jsonb,'claimed', 'stale-w-a', now() - interval '1 hour', now() - interval '1 minute')
      ON CONFLICT (id) DO NOTHING`,
    [OB_DUE_A, TENANT_A, AGENT_A, OB_EXPIRED_A],
  );
  await c.query(
    `INSERT INTO outbox_messages
        (id, tenant_id, agent_id, kind, payload, status, claimed_by, claimed_at, next_attempt_at)
      VALUES
        ($1,$2,$3,'whatsapp_text','{"jid":"x","text":"b"}'::jsonb,'pending', NULL,        NULL,                       now() - interval '1 minute'),
        ($4,$2,$3,'whatsapp_text','{"jid":"x","text":"b"}'::jsonb,'claimed', 'stale-w-b', now() - interval '1 hour', now() - interval '1 minute')
      ON CONFLICT (id) DO NOTHING`,
    [OB_DUE_B, TENANT_B, AGENT_B, OB_EXPIRED_B],
  );
}

/** Delete the suite's rows in FK-safe reverse order (children → parents). */
async function wipeRows(c: pg.PoolClient): Promise<void> {
  await c.query(`DELETE FROM outbox_messages WHERE id = ANY($1)`, [ALL_OB]);
  await c.query(`DELETE FROM tasks WHERE id = ANY($1)`, [[TASK_A, TASK_B]]);
  await c.query(`DELETE FROM occurrences WHERE id = ANY($1)`, [ALL_OCC]);
  await c.query(`DELETE FROM series WHERE id = ANY($1)`, [
    [SERIES_A, SERIES_B],
  ]);
}

async function dropFixtures(c: pg.PoolClient): Promise<void> {
  await wipeRows(c);
  await c.query(`DELETE FROM pessoas WHERE id = ANY($1)`, [
    [PESSOA_A, PESSOA_B],
  ]);
  await c.query(`DELETE FROM agents WHERE id = ANY($1)`, [[AGENT_A, AGENT_B]]);
  await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [
    [TENANT_A, TENANT_B],
  ]);
}

/** Current status of an occurrence by id (NULL if absent). */
async function occStatus(
  c: pg.PoolClient,
  id: string,
): Promise<string | undefined> {
  const r = await c.query<{ status: string }>(
    `SELECT status FROM occurrences WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.status;
}
async function obStatus(
  c: pg.PoolClient,
  id: string,
): Promise<string | undefined> {
  const r = await c.query<{ status: string }>(
    `SELECT status FROM outbox_messages WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.status;
}

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      // Drop any leftover rows from a prior crashed run, then seed fresh.
      await dropFixtures(c);
      await seedRows(c);
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    const c = await pool.connect();
    try {
      await dropFixtures(c);
    } finally {
      c.release();
    }
    await pool.end();
  });
  // The claim/reclaim tests MUTATE rows; re-seed scheduling rows before each
  // test so every case starts from the known baseline regardless of order.
  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await wipeRows(c);
      await seedRows(c);
    } finally {
      c.release();
    }
  });
}

d("scheduling tenant-leak — reads never cross tenants", () => {
  it("seriesRepo.findById: A cannot read B-owned series", async () => {
    const { seriesRepo } = await import("@/scheduling/repos.js");
    const asA = await runWithTenantContext(CTX_A, () =>
      seriesRepo.findById(SERIES_B),
    );
    expect(asA).toBeNull();
    const asB = await runWithTenantContext(CTX_B, () =>
      seriesRepo.findById(SERIES_B),
    );
    expect(asB?.id).toBe(SERIES_B);
  });

  it("occurrencesRepo.byId: A cannot read B-owned occurrence", async () => {
    const { occurrencesRepo } = await import("@/scheduling/repos.js");
    const asA = await runWithTenantContext(CTX_A, () =>
      occurrencesRepo.byId(OCC_DUE_B),
    );
    expect(asA).toBeNull();
    const asB = await runWithTenantContext(CTX_B, () =>
      occurrencesRepo.byId(OCC_DUE_B),
    );
    expect(asB?.id).toBe(OCC_DUE_B);
  });

  it("occurrencesRepo.listOverdueForSeries: A cannot enumerate a B series", async () => {
    const { occurrencesRepo } = await import("@/scheduling/repos.js");
    const future = new Date(Date.now() + 60_000);
    const asA = await runWithTenantContext(CTX_A, () =>
      occurrencesRepo.listOverdueForSeries(SERIES_B, future),
    );
    expect(asA).toHaveLength(0);
    const asB = await runWithTenantContext(CTX_B, () =>
      occurrencesRepo.listOverdueForSeries(SERIES_B, future),
    );
    expect(asB.length).toBeGreaterThan(0);
    expect(asB.every((o) => o.tenant_id === TENANT_B)).toBe(true);
  });

  it("tasksRepo.byOccurrence: A cannot read tasks of a B-owned occurrence", async () => {
    const { tasksRepo } = await import("@/scheduling/repos.js");
    const asA = await runWithTenantContext(CTX_A, () =>
      tasksRepo.byOccurrence(OCC_DUE_B),
    );
    expect(asA).toHaveLength(0);
    const asB = await runWithTenantContext(CTX_B, () =>
      tasksRepo.byOccurrence(OCC_DUE_B),
    );
    expect(asB).toHaveLength(1);
    expect(asB[0]!.id).toBe(TASK_B);
  });

  it("outboxRepo.byStatus: A only sees its own pending outbox rows", async () => {
    const { outboxRepo } = await import("@/scheduling/repos.js");
    const asA = await runWithTenantContext(CTX_A, () =>
      outboxRepo.byStatus("pending"),
    );
    expect(asA.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    expect(asA.some((r) => r.id === OB_DUE_B)).toBe(false);
    expect(asA.some((r) => r.id === OB_DUE_A)).toBe(true);
  });
});

d(
  "scheduling tenant-leak — occurrence claim CTEs never touch the other tenant",
  () => {
    it("occurrencesRepo.claimDue: A never claims B-owned due occurrences (no read, no mutate)", async () => {
      const { occurrencesRepo } = await import("@/scheduling/repos.js");
      const claimedByA = await runWithTenantContext(CTX_A, () =>
        occurrencesRepo.claimDue("worker-A", 100),
      );
      // A only ever gets its own due row.
      expect(claimedByA.map((o) => o.id)).toEqual([OCC_DUE_A]);
      expect(claimedByA.every((o) => o.tenant_id === TENANT_A)).toBe(true);

      const c = await pool.connect();
      try {
        // Revert-check: B's due occurrence is STILL pending — A's UPDATE never touched it.
        expect(await occStatus(c, OCC_DUE_B)).toBe("pending");
        // And A's row really was claimed (the claim is not a no-op).
        expect(await occStatus(c, OCC_DUE_A)).toBe("claimed");
      } finally {
        c.release();
      }

      // Sanity: B CAN claim its own due row.
      const claimedByB = await runWithTenantContext(CTX_B, () =>
        occurrencesRepo.claimDue("worker-B", 100),
      );
      expect(claimedByB.map((o) => o.id)).toEqual([OCC_DUE_B]);
    });

    it("occurrencesRepo.reclaimExpiredLeases: A never reclaims B-owned expired claims", async () => {
      const { occurrencesRepo } = await import("@/scheduling/repos.js");
      const reclaimedByA = await runWithTenantContext(CTX_A, () =>
        occurrencesRepo.reclaimExpiredLeases("worker-A", 1, 100),
      );
      expect(reclaimedByA).toEqual([OCC_EXPIRED_A]);

      const c = await pool.connect();
      try {
        // Revert-check: B's expired claim is untouched (still 'claimed').
        expect(await occStatus(c, OCC_EXPIRED_B)).toBe("claimed");
        // A's expired claim was reset to pending.
        expect(await occStatus(c, OCC_EXPIRED_A)).toBe("pending");
      } finally {
        c.release();
      }

      const reclaimedByB = await runWithTenantContext(CTX_B, () =>
        occurrencesRepo.reclaimExpiredLeases("worker-B", 1, 100),
      );
      expect(reclaimedByB).toEqual([OCC_EXPIRED_B]);
    });

    it("occurrencesRepo.claimInProgressForAdvance: A never claims a B in_progress occurrence (join is tenant-fenced)", async () => {
      const { occurrencesRepo } = await import("@/scheduling/repos.js");
      const claimedByA = await runWithTenantContext(CTX_A, () =>
        occurrencesRepo.claimInProgressForAdvance("worker-A", 100),
      );
      expect(claimedByA.map((o) => o.id)).toEqual([OCC_INPROG_A]);
      expect(claimedByA.every((o) => o.tenant_id === TENANT_A)).toBe(true);

      const c = await pool.connect();
      try {
        // Revert-check: B's in_progress row keeps its stale claim owner — A never
        // re-stamped it (the occurrence↔series join is fenced on matching tenant).
        const r = await c.query<{ status: string; claimed_by: string | null }>(
          `SELECT status, claimed_by FROM occurrences WHERE id = $1`,
          [OCC_INPROG_B],
        );
        expect(r.rows[0]!.status).toBe("in_progress");
        expect(r.rows[0]!.claimed_by).toBe("stale-w-b");
      } finally {
        c.release();
      }

      const claimedByB = await runWithTenantContext(CTX_B, () =>
        occurrencesRepo.claimInProgressForAdvance("worker-B", 100),
      );
      expect(claimedByB.map((o) => o.id)).toEqual([OCC_INPROG_B]);
    });
  },
);

d(
  "scheduling tenant-leak — outbox claim CTEs never touch the other tenant",
  () => {
    it("outboxRepo.claimDue: A never claims B-owned due outbox rows (no read, no mutate)", async () => {
      const { outboxRepo } = await import("@/scheduling/repos.js");
      const claimedByA = await runWithTenantContext(CTX_A, () =>
        outboxRepo.claimDue("worker-A", 100),
      );
      expect(claimedByA.map((o) => o.id)).toEqual([OB_DUE_A]);
      expect(claimedByA.every((o) => o.tenant_id === TENANT_A)).toBe(true);

      const c = await pool.connect();
      try {
        // Revert-check: B's due outbox row is STILL pending.
        expect(await obStatus(c, OB_DUE_B)).toBe("pending");
        expect(await obStatus(c, OB_DUE_A)).toBe("claimed");
      } finally {
        c.release();
      }

      const claimedByB = await runWithTenantContext(CTX_B, () =>
        outboxRepo.claimDue("worker-B", 100),
      );
      expect(claimedByB.map((o) => o.id)).toEqual([OB_DUE_B]);
    });

    it("outboxRepo.reclaimExpiredLeases: A never reclaims B-owned expired outbox claims", async () => {
      const { outboxRepo } = await import("@/scheduling/repos.js");
      const reclaimedByA = await runWithTenantContext(CTX_A, () =>
        outboxRepo.reclaimExpiredLeases("worker-A", 1, 100),
      );
      expect(reclaimedByA).toEqual([OB_EXPIRED_A]);

      const c = await pool.connect();
      try {
        // Revert-check: B's expired outbox claim is untouched (still 'claimed').
        expect(await obStatus(c, OB_EXPIRED_B)).toBe("claimed");
        expect(await obStatus(c, OB_EXPIRED_A)).toBe("pending");
      } finally {
        c.release();
      }

      const reclaimedByB = await runWithTenantContext(CTX_B, () =>
        outboxRepo.reclaimExpiredLeases("worker-B", 1, 100),
      );
      expect(reclaimedByB).toEqual([OB_EXPIRED_B]);
    });
  },
);

// ===========================================================================
// Finding 1 (High) — exercise the REAL dispatcher-discovery SQL + worker path.
//
// The worker UNIT spec (`tests/unit/workers/scheduling-workers-tenant-dispatch.
// spec.ts`) mocks BOTH `schedulingDispatch.enumerate*` AND the engine inner, so
// it proves the dispatcher's loop/scope wiring but NEVER runs the real
// DISTINCT-tuple discovery SQL or the real claim CTEs — it would stay green if
// either regressed. These two describe blocks close that gap against real
// Postgres: (a) the discovery queries return EXACTLY the seeded tuples (and no
// `default`), and (b) the real `runSchedulingTick` worker path is
// tenant-isolated end-to-end.
// ===========================================================================
d(
  "scheduling tenant-leak — REAL dispatcher discovery SQL returns exactly the seeded tuples",
  () => {
    // The seed gives BOTH tenants a due `pending` occurrence, a `claimed` row, an
    // `in_progress` row, an active `FREQ=DAILY` series, and a due-pending +
    // claimed outbox row — so every `enumerate*` predicate matches each tenant.
    const key = (r: { tenant_id: string; agent_id: string }) =>
      `${r.tenant_id}|${r.agent_id}`;

    it("enumerateTickTenants: includes A and B tuples, never the `default` sentinel", async () => {
      const { schedulingDispatch } = await import("@/scheduling/repos.js");
      // Enumeration runs OUTSIDE tenant context (the worker's cross-tenant
      // contract); it must surface real tuples and never the legacy `default`.
      const rows = await schedulingDispatch.enumerateTickTenants();
      const keys = new Set(rows.map(key));
      expect(keys.has(`${TENANT_A}|${AGENT_A}`)).toBe(true);
      expect(keys.has(`${TENANT_B}|${AGENT_B}`)).toBe(true);
      // No NULL/`default` leak: the discovery SQL's `IS NOT NULL` guard + the
      // namespaced fixtures mean a real tuple is returned, never the sentinel.
      expect(
        rows.every(
          (r) => r.tenant_id !== "default" && r.agent_id !== "default",
        ),
      ).toBe(true);
      expect(rows.every((r) => r.tenant_id != null && r.agent_id != null)).toBe(
        true,
      );
      // The exact rows for our two tenants are present and correctly paired.
      expect(rows).toContainEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
      expect(rows).toContainEqual({ tenant_id: TENANT_B, agent_id: AGENT_B });
    });

    it("enumerateActiveSeriesTenants: includes A and B tuples, never the `default` sentinel", async () => {
      const { schedulingDispatch } = await import("@/scheduling/repos.js");
      const rows = await schedulingDispatch.enumerateActiveSeriesTenants();
      const keys = new Set(rows.map(key));
      expect(keys.has(`${TENANT_A}|${AGENT_A}`)).toBe(true);
      expect(keys.has(`${TENANT_B}|${AGENT_B}`)).toBe(true);
      expect(
        rows.every(
          (r) => r.tenant_id !== "default" && r.agent_id !== "default",
        ),
      ).toBe(true);
      expect(rows).toContainEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
      expect(rows).toContainEqual({ tenant_id: TENANT_B, agent_id: AGENT_B });
    });

    it("enumerateOutboxTenants: includes A and B tuples, never the `default` sentinel", async () => {
      const { schedulingDispatch } = await import("@/scheduling/repos.js");
      const rows = await schedulingDispatch.enumerateOutboxTenants();
      const keys = new Set(rows.map(key));
      expect(keys.has(`${TENANT_A}|${AGENT_A}`)).toBe(true);
      expect(keys.has(`${TENANT_B}|${AGENT_B}`)).toBe(true);
      expect(
        rows.every(
          (r) => r.tenant_id !== "default" && r.agent_id !== "default",
        ),
      ).toBe(true);
      expect(rows).toContainEqual({ tenant_id: TENANT_A, agent_id: AGENT_A });
      expect(rows).toContainEqual({ tenant_id: TENANT_B, agent_id: AGENT_B });
    });
  },
);

d(
  "scheduling tenant-leak — REAL worker path (runSchedulingTick) is tenant-isolated",
  () => {
    // What the seed's `recurring_outreach` occurrences do under a REAL tick (the
    // `contexto_snapshot` defaults to `{}`, so `destinatario_pessoa_id` is absent):
    //   step 1 reclaim  : OCC_EXPIRED (stale `claimed`) → back to `pending`
    //                       [real reclaimExpiredLeases CTE]
    //   step 2 claimDue : OCC_DUE + the just-reclaimed OCC_EXPIRED → `claimed`
    //                       [real claimDue CTE], then advanceRecurringOutreach
    //                       finds no destinatario → both end `failed`
    //   step 3 inprog   : OCC_INPROG (stale `in_progress` recurring_outreach) →
    //                       claimed [real claimInProgressForAdvance CTE], advanced
    //                       (no forward task to do) → `completed` (+ a next-cycle
    //                       occurrence inserted; cleaned via series ON DELETE
    //                       CASCADE in wipeRows/dropFixtures).
    // The deterministic post-tick fingerprint for the acting tenant is therefore
    // DUE→failed, EXPIRED→failed, INPROG→completed — every row moved OFF its
    // baseline by the real claim CTEs. The non-acting tenant's rows MUST stay at
    // baseline, proving the CTEs' tenant fence holds on the real worker path.

    /** Snapshot the three baseline occurrence statuses for a tenant's row set. */
    async function snapshot(
      c: pg.PoolClient,
      ids: { due: string; expired: string; inprog: string },
    ): Promise<{ due?: string; expired?: string; inprog?: string }> {
      return {
        due: await occStatus(c, ids.due),
        expired: await occStatus(c, ids.expired),
        inprog: await occStatus(c, ids.inprog),
      };
    }
    const A_IDS = {
      due: OCC_DUE_A,
      expired: OCC_EXPIRED_A,
      inprog: OCC_INPROG_A,
    };
    const B_IDS = {
      due: OCC_DUE_B,
      expired: OCC_EXPIRED_B,
      inprog: OCC_INPROG_B,
    };
    const BASELINE = {
      due: "pending",
      expired: "claimed",
      inprog: "in_progress",
    };

    it("tenant A's tick claims/advances ONLY A's occurrences; B's rows are untouched", async () => {
      const { runSchedulingTick } = await import("@/scheduling/engine.js");
      // The real per-tenant worker inner: exactly what the dispatcher opens for a
      // single enumerated tuple (`runWithTenantContext({...}, () => runSchedulingTick())`).
      const result = await runWithTenantContext(CTX_A, () =>
        runSchedulingTick(),
      );
      // The real claim CTEs fired for A: a reclaim, a due-claim, an in_progress claim.
      expect(result.reclaimed).toBeGreaterThan(0);
      expect(result.claimed).toBeGreaterThan(0);

      const c = await pool.connect();
      try {
        // A's rows all moved OFF baseline via the real claim/advance path.
        const a = await snapshot(c, A_IDS);
        expect(a.due).not.toBe("pending"); // was claimed → advanced (failed)
        expect(a.due).toBe("failed");
        expect(a.expired).toBe("failed"); // reclaimed → re-claimed → advanced
        expect(a.inprog).toBe("completed"); // in_progress advanced + next cycle scheduled

        // B's rows are EXACTLY at baseline — A's tenant-fenced tick never read or
        // mutated them. A dropped tenant predicate in any claim CTE would let A's
        // pass claim/advance a B row here and flip one of these off baseline.
        expect(await snapshot(c, B_IDS)).toEqual(BASELINE);
        // And B's stale in_progress claim owner is intact (A never re-stamped it).
        const r = await c.query<{ claimed_by: string | null }>(
          `SELECT claimed_by FROM occurrences WHERE id = $1`,
          [OCC_INPROG_B],
        );
        expect(r.rows[0]!.claimed_by).toBe("stale-w-b");
      } finally {
        c.release();
      }
    });

    it("tenant B's tick claims/advances ONLY B's occurrences; A's rows are untouched (symmetric)", async () => {
      const { runSchedulingTick } = await import("@/scheduling/engine.js");
      const result = await runWithTenantContext(CTX_B, () =>
        runSchedulingTick(),
      );
      expect(result.claimed).toBeGreaterThan(0);

      const c = await pool.connect();
      try {
        const b = await snapshot(c, B_IDS);
        expect(b.due).toBe("failed");
        expect(b.expired).toBe("failed");
        expect(b.inprog).toBe("completed");
        // A's rows untouched by B's pass.
        expect(await snapshot(c, A_IDS)).toEqual(BASELINE);
      } finally {
        c.release();
      }
    });

    it("full dispatcher runScheduling(): REAL enumerateTickTenants + per-tenant dispatch advances BOTH tenants", async () => {
      // End-to-end through the worker entrypoint: it calls the REAL
      // enumerateTickTenants() discovery SQL, then opens runWithTenantContext per
      // tuple and runs the REAL tick. Both seeded tenants must be discovered AND
      // their due occurrences claimed under their OWN context (no cross-claim,
      // no `default`).
      const { runScheduling } = await import("@/workers/scheduling-tick.js");
      await expect(runScheduling()).resolves.toBeUndefined();

      const c = await pool.connect();
      try {
        // Both tenants' due occurrences were picked up by their own pass — each
        // left `pending` (claimed → advanced). If the dispatcher failed to
        // enumerate a tenant, that tenant's due row would still be `pending`.
        expect(await occStatus(c, OCC_DUE_A)).not.toBe("pending");
        expect(await occStatus(c, OCC_DUE_B)).not.toBe("pending");
        expect(await occStatus(c, OCC_DUE_A)).toBe("failed");
        expect(await occStatus(c, OCC_DUE_B)).toBe("failed");
      } finally {
        c.release();
      }
    });
  },
);

// ===========================================================================
// Finding 3 (Medium) — outbox dedup UNIQUE index is cross-tenant SAFE.
//
// `idx_outbox_dedup` is a GLOBAL UNIQUE index on `(dedup_key)` WHERE dedup_key
// IS NOT NULL (migration 007_scheduling.sql:124). Migration 073 DELIBERATELY
// left it untouched (it documents: "the latter is a global dedup uniqueness
// guard that must stay tenant-agnostic"). That is SAFE — and NOT a cross-tenant
// leak vector — because every real `dedup_key` embeds a per-occurrence /
// per-pending-question UUID (the engine uses `${occ.id}:fire_reminder`,
// `${occ.id}:send_outreach`, …; the pending-resolver uses `disambig:${pq.id}`).
// Those UUIDs are globally unique, so two different tenants NEVER collide on a
// real dedup_key, and the global index therefore never blocks tenant B from
// enqueuing just because tenant A enqueued. The read path (`outboxRepo.*`) is
// still fully tenant-scoped, so even if a key DID somehow collide, neither
// tenant could ever READ the other's row. This block proves both halves with
// realistic UUID-embedded keys. (We assert the design — we do NOT and must not
// change the index.)
// ===========================================================================
d(
  "scheduling tenant-leak — outbox dedup is cross-tenant safe (global UNIQUE index, UUID-embedded keys)",
  () => {
    // Realistic keys, exactly the shape the engine emits for the due occurrences:
    // `${occurrence_uuid}:fire_reminder`. The occurrence UUIDs differ per tenant,
    // so the keys differ → no collision on the global UNIQUE(dedup_key) index.
    const DEDUP_A = `${OCC_DUE_A}:fire_reminder`;
    const DEDUP_B = `${OCC_DUE_B}:fire_reminder`;

    it("A and B each enqueue under their own UUID-embedded dedup_key; reads stay isolated", async () => {
      const { outboxRepo } = await import("@/scheduling/repos.js");

      // Defensive idempotency: these rows carry random UUID ids (not in ALL_OB),
      // so `beforeEach`'s id-list wipe can't catch them. Clear any leftover from a
      // prior crashed run by dedup_key so the global UNIQUE index is clean before
      // we re-enqueue the same keys.
      const c0 = await pool.connect();
      try {
        await c0.query(
          `DELETE FROM outbox_messages WHERE dedup_key = ANY($1)`,
          [[DEDUP_A, DEDUP_B]],
        );
      } finally {
        c0.release();
      }

      // Enqueue under each tenant's OWN context (stamps tenant_id/agent_id from ALS).
      const rowA = await runWithTenantContext(CTX_A, () =>
        outboxRepo.enqueue({
          occurrence_id: OCC_DUE_A,
          task_id: null,
          kind: "whatsapp_text",
          payload: { jid: "x", text: "a" },
          dedup_key: DEDUP_A,
        }),
      );
      const rowB = await runWithTenantContext(CTX_B, () =>
        outboxRepo.enqueue({
          occurrence_id: OCC_DUE_B,
          task_id: null,
          kind: "whatsapp_text",
          payload: { jid: "x", text: "b" },
          dedup_key: DEDUP_B,
        }),
      );

      // Distinct UUID-embedded keys → the global UNIQUE index admits BOTH rows
      // (neither enqueue collided / returned null).
      expect(rowA?.id).toBeTruthy();
      expect(rowB?.id).toBeTruthy();
      expect(rowA!.tenant_id).toBe(TENANT_A);
      expect(rowB!.tenant_id).toBe(TENANT_B);
      expect(rowA!.id).not.toBe(rowB!.id);

      const c = await pool.connect();
      try {
        // Each row physically exists under its own tenant.
        const both = await c.query<{
          id: string;
          tenant_id: string;
          dedup_key: string;
        }>(
          `SELECT id, tenant_id, dedup_key FROM outbox_messages WHERE dedup_key = ANY($1) ORDER BY tenant_id`,
          [[DEDUP_A, DEDUP_B]],
        );
        expect(both.rows.map((r) => r.tenant_id)).toEqual([TENANT_A, TENANT_B]);

        // Negative assert: a tenant-scoped READ never returns the OTHER tenant's
        // row, even though the dedup index is global. (Reads filter by tenant/agent.)
        const aSees = await runWithTenantContext(CTX_A, () =>
          outboxRepo.byStatus("pending", 1000),
        );
        expect(aSees.some((r) => r.id === rowA!.id)).toBe(true);
        expect(aSees.some((r) => r.id === rowB!.id)).toBe(false);
        expect(aSees.every((r) => r.tenant_id === TENANT_A)).toBe(true);

        const bSees = await runWithTenantContext(CTX_B, () =>
          outboxRepo.byStatus("pending", 1000),
        );
        expect(bSees.some((r) => r.id === rowB!.id)).toBe(true);
        expect(bSees.some((r) => r.id === rowA!.id)).toBe(false);
        expect(bSees.every((r) => r.tenant_id === TENANT_B)).toBe(true);
      } finally {
        c.release();
      }

      // Cleanup: these two rows have random UUIDs (not in ALL_OB), and their
      // dedup_keys reference OCC_DUE_* which beforeEach re-seeds — so delete them
      // by dedup_key here to keep the global UNIQUE index clean for re-runs.
      const c2 = await pool.connect();
      try {
        await c2.query(
          `DELETE FROM outbox_messages WHERE dedup_key = ANY($1)`,
          [[DEDUP_A, DEDUP_B]],
        );
      } finally {
        c2.release();
      }
    });
  },
);
