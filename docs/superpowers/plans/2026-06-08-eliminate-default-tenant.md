# Eliminate the `'default'` tenant from runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the single-tenant runtime a reserved `primary` tenant, remove `'default'` from every runtime path (data + schema defaults + code), so `MAIA_REJECT_DEFAULT_LITERAL` can default-ON (unblocks #323).

**Architecture:** Reserved `primary/primary` tenant (like `system`, but an ordinary tenant that passes the guard). Four reversible migrations (seed → rehome → drop column-default → delete). Code re-points the catch-all discriminator/adoption/ingress to `primary`. Flip reader becomes default-ON opt-out. Full design: [`docs/superpowers/specs/2026-06-08-eliminate-default-tenant-design.md`](../specs/2026-06-08-eliminate-default-tenant-design.md).

**Tech Stack:** Node 20 + TS ESM, Drizzle ORM, PostgreSQL 16, Vitest, BullMQ.

---

## Execution shape (read before dispatching)

- **Sequential spine — Tasks 1→6.** Each depends on the previous; same branch `claude/eliminate-default-tenant`; do NOT parallelize (they share `tenant-context.ts`, `repositories.ts`, `core.ts`).
- **Parallel fan-out — Tasks 7 & 8.** Disjoint file sets, independent; safe to dispatch concurrently AFTER Task 6 lands.
- **Environment constraints (project-specific):**
  - `node_modules` is a junction to the root install — **do NOT run `npm install`**.
  - Branch off the existing `claude/eliminate-default-tenant` (already has the spec). Do NOT branch off `main`.
  - **Real-DB / `*-real-db` / `test:leak` tests need Postgres+Docker and do NOT run locally** — validate them by `typecheck`+`lint` locally; real-DB validation happens in CI. For local test runs use `npx vitest run tests/unit/...`.
  - Local gate per task: `npm run typecheck` + `npm run lint` + the task's unit tests.

---

## Task 1: Reserved `primary` constants + helper

**Files:**
- Modify: `src/db/tenant-context.ts` (add after the `SYSTEM_*` block, ~line 77-87)
- Test: `tests/unit/tenant-context.spec.ts`

- [ ] **Step 1: Write failing test** — assert constants + helper + that `primary` passes the guard (is NOT rejected like `default`).

```ts
import { PRIMARY_TENANT_ID, PRIMARY_AGENT_ID, PRIMARY_CONTEXT, isPrimaryContext,
         runWithTenantContext, getCurrentTenant } from '@/db/tenant-context.js';

it('primary is a reserved ordinary tenant (passes the guard)', async () => {
  expect(PRIMARY_TENANT_ID).toBe('primary');
  expect(isPrimaryContext({ tenant_id: 'primary', agent_id: 'primary' })).toBe(true);
  expect(isPrimaryContext({ tenant_id: 'default', agent_id: 'default' })).toBe(false);
  process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
  await runWithTenantContext(PRIMARY_CONTEXT, async () => {
    expect(getCurrentTenant()).toBe('primary'); // does NOT throw
  });
  delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
});
```

- [ ] **Step 2: Run, verify it fails** — `npx vitest run tests/unit/tenant-context.spec.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement** in `tenant-context.ts`:

```ts
export const PRIMARY_TENANT_ID = 'primary' as const;
export const PRIMARY_AGENT_ID = 'primary' as const;
export const PRIMARY_CONTEXT: TenantContext = Object.freeze({
  tenant_id: PRIMARY_TENANT_ID,
  agent_id: PRIMARY_AGENT_ID,
});
export function isPrimaryContext(ctx: { tenant_id: string; agent_id: string }): boolean {
  return ctx.tenant_id === PRIMARY_TENANT_ID && ctx.agent_id === PRIMARY_AGENT_ID;
}
```

- [ ] **Step 4: Run, verify it passes.** Then `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(tenant): add reserved 'primary' tenant constants (#323)`

---

## Task 2: Migrations (seed → rehome → drop-default → delete)

**Files (next free `0NN` against `migrations/` max):**
- Create: `migrations/0NN_seed_primary_tenant.sql` + `_down`
- Create: `migrations/0NN_rehome_default_to_primary.sql` + `_down`
- Create: `migrations/0NN_drop_default_column_default.sql` + `_down`
- Create: `migrations/0NN_delete_default_tenant.sql` + `_down`
- Test: `tests/integration/migration-eliminate-default-real-db.spec.ts` (testcontainer; CI-validated)

> No `BEGIN/COMMIT` in migration files — `migrate.ts` wraps each in a transaction. Follow the `014`/`009` style.

- [ ] **Step 1: Seed migration** — `INSERT … 'primary' … ON CONFLICT (id) DO NOTHING` for tenant then agent (copy 014's shape). `_down`: delete primary agent then tenant.

- [ ] **Step 2: Rehome migration** — `DO $$` block over the **union** of (a) columns named `tenant_id`/`agent_id` and (b) columns FK-referencing `tenants(id)`/`agents(id)` (via `pg_constraint` contype='f'), excluding `tenants`/`agents`. For each `(t,c)`: `UPDATE %I SET %I='primary' WHERE %I='default'`. The union is required: by-name catches no-FK `outbound_messages`/`idempotency_effect_outbox`; by-FK catches `procedure_definitions.owner_agent_id`. `_down`: same discovery, `primary`→`default`. (See spec §3.2 for the SQL skeleton.)

- [ ] **Step 3: Drop-default migration** — `DO $$` over every column where `column_default ~ '''default'''`; `ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT`. `_down`: **explicit hardcoded** `(table, column)` list (009's 27 minus `dashboard_sessions` + 008/063/068/071×4/074/076, both `tenant_id`/`agent_id`), each `SET DEFAULT 'default'` guarded by a column-existence check. (Re-discovery in `_down` would find nothing — see spec §3.3.)

- [ ] **Step 4: Delete migration** — `DELETE FROM agents WHERE id='default'; DELETE FROM tenants WHERE id='default';` (children already rehomed). `_down`: re-`INSERT` the `default` tenant+agent rows (`ON CONFLICT DO NOTHING`).

- [ ] **Step 5: Real-DB tests** (run in CI; author now):
  - rehome correctness: a row seeded under `default` lands under `primary`; **zero residual `default` in child/data tables** for `tenant_id`, `agent_id`, AND `owner_agent_id` before the delete.
  - fail-closed INSERT: an INSERT omitting `tenant_id` raises NOT NULL — assert for a 009 table AND a no-FK table (`outbound_messages`).
  - migration symmetry: the forward drop-default discovered set equals the `_down` hardcoded list.

- [ ] **Step 6: Validate** — `npm run typecheck` + `npm run lint`. (Real-DB specs skip locally without Docker — that's expected; they gate in CI.)
- [ ] **Step 7: Commit** — `feat(db): seed primary tenant, rehome+delete 'default', drop column-defaults (#323)`

---

## Task 3: Catch-all discriminator + resolver → `primary`

**Files:**
- Modify: `src/db/repositories.ts` — `findDefaultCatchAllChannel` (~8386-8417): discriminator `ne(channels.tenant_id, 'default')` → `'primary'`; catch-all lookup `eq(…, 'default')` → `'primary'`; rename → `findPrimaryCatchAllChannel`. Also the `default/default` adoption lookup (~1215).
- Modify: `src/gateway/channel-resolver.ts` — caller + comments → `primary`.
- Test (unit, run locally): `tests/unit/channel-resolver.spec.ts`, `tests/unit/gateway/channel-resolver-discriminator.spec.ts`, `tests/unit/gateway/channel-resolver-fail-loud.spec.ts`, `tests/unit/channels-repo.spec.ts`.

- [ ] **Step 1: Update test expectations first (TDD).** In the four specs, change the single-tenant catch-all expected triplet from `{tenant_id:'default',agent_id:'default'}` to `{…'primary'}`, and the discriminator literal `tenant_id !== 'default'` → `!== 'primary'`.
- [ ] **Step 2: Run, verify they fail** — `npx vitest run tests/unit/channel-resolver.spec.ts tests/unit/gateway/channel-resolver-discriminator.spec.ts` → FAIL.
- [ ] **Step 3: Implement** the repositories.ts + channel-resolver.ts changes (rename helper, swap literals).
- [ ] **Step 4: Run, verify pass** + `npm run typecheck` + `npm run lint`.
- [ ] **Step 5: Commit** — `feat(gateway): re-point single-tenant catch-all to primary (#323)`

---

## Task 4: Request path (`core.ts`) → `primary`

**Files:**
- Modify: `src/agent/core.ts` — `resolved` init (280-284) `default`→`primary`; adoption discriminator (360) `!== 'default'` → `!isPrimaryContext(resolved)`.
- Test (unit): `tests/unit/agent-core-channel-resolution.spec.ts`.

- [ ] **Step 1:** Update spec expectations (single-tenant resolve/run under `primary`; adoption baseline `primary`) → red.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement core.ts changes (import `PRIMARY_*`/`isPrimaryContext`).
- [ ] **Step 4:** Run → PASS + typecheck + lint.
- [ ] **Step 5: Commit** — `feat(agent): run single-tenant turn under primary, not default (#323)`

---

## Task 5: Baileys ingress tests → `primary` (test-only)

**Reality check (corrects a stale `core.ts:328` comment):** baileys does NOT persist under `default/default` before resolving. `baileys.ts:273-277` resolves the scope FIRST (`resolveTenantCtxForUpsert` → `jid-tenant-resolver` → the catch-all repo) and persists INSIDE `runWithTenantContext(ctx.scope, …)`; `createInbound` (`repositories.ts:885`, input type omits tenant/agent) stamps from the ALS. So once **Task 3** re-points the catch-all to `primary`, ingress stamps `primary` automatically — **no production change in this task.**

**Files:**
- Test (unit): `tests/unit/baileys-tenant-context.spec.ts`, `tests/unit/gateway/jid-tenant-resolver.spec.ts` (+ family if they assert the triplet: `baileys-tenant-resolution`, `baileys-enqueue-oom`, `baileys-reaction-stub-reachable`).
- Verify-only (no edit expected): `src/gateway/baileys.ts`, `src/gateway/jid-tenant-resolver.ts`.

- [ ] **Step 1: Verify** `jid-tenant-resolver` resolves via the (now `primary`) catch-all repo and carries NO independent `'default'` literal in production logic. Only if it does → fix that literal; otherwise no production edit.
- [ ] **Step 2:** Update unit-test expectations: single-tenant ingress scope `{default,default}` → `{primary,primary}` → red; run → FAIL.
- [ ] **Step 3:** No production change for the upsert path. Run specs → PASS (with Task 3 in). ⚠️ **Do NOT** wrap the upsert handler in `runWithTenantContext(PRIMARY_CONTEXT)` — that clobbers the resolved per-tenant `ctx.scope` and forces a future tenant-B inbound under `primary` (isolation violation).
- [ ] **Step 4:** `npm run typecheck` + `npm run lint`.
- [ ] **Step 5: Commit** — `test(gateway): baileys/jid ingress specs expect primary catch-all (#323)`

---

## Task 6: Flip reader → default-ON opt-out

**Files:**
- Modify: `src/db/tenant-context.ts` — `shouldThrowOnDefaultLiteral()` (95-97).
- Test (integration/unit): `tests/integration/issue-282-no-default-context-in-prod-path.spec.ts` (+ a focused unit case).

- [ ] **Step 1: Write flip-safety test** — with **no env var set**, a synthetic `default` context throws `DefaultLiteralRejectedError`; with `MAIA_REJECT_DEFAULT_LITERAL='false'`, it's tolerated. **Do NOT test by setting `='true'`** (would mask a silent-OFF default).
- [ ] **Step 2:** Run → FAIL (today default is OFF).
- [ ] **Step 3:** Implement:

```ts
function shouldThrowOnDefaultLiteral(): boolean {
  return process.env.MAIA_REJECT_DEFAULT_LITERAL !== 'false';
}
```

- [ ] **Step 4:** Run → PASS. Then run the **full local unit suite** (`npm test`) to catch any spec that implicitly relied on default-OFF — fix stragglers (unit specs should already be on `primary`/bespoke after Tasks 3-5; real-db specs are Task 8, CI-only).
- [ ] **Step 5: Commit** — `feat(tenant): flip MAIA_REJECT_DEFAULT_LITERAL to default-ON opt-out (#323)`

> ⚠️ This is the Phase-6 flip. It only becomes "live in prod" on deploy + **owner sign-off** (spec §6). Landing the code default-ON is fine; the deploy decision is the owner's.

---

## Task 7 (parallelizable): Periphery → `primary`

**Files (disjoint):**
- Modify: `src/workers/cost-monitor.ts:26` → `runWithTenantContext(PRIMARY_CONTEXT, …)`; ALSO update the now-stale comment (`cost-monitor.ts:14-25`, "NOT migrated… left on the legacy literal") since reader+writer both move to `primary`.
- Modify: `scripts/p8e-seed-policies.ts:225` → `PRIMARY_CONTEXT`.
- Modify: `scripts/setup.ts` — TWO distinct fixes:
  - Wrap the **guarded repo** writes in `main()` (`pessoasRepo.create`, `entidadesRepo.create`, `permissoesRepo.create`, `contasRepo.create`, co-owner block) in `runWithTenantContext(PRIMARY_CONTEXT, …)` — they read tenant from the ALS.
  - The **raw** `db.insert(self_state)` at `setup.ts:26` bypasses the ALS guard, so wrapping does NOT help it — add explicit `tenant_id: PRIMARY_TENANT_ID, agent_id: PRIMARY_AGENT_ID` to its `.values()` (after Task 2 drops the column-default, an omitted tenant here fails NOT NULL). Grep `setup.ts` for any other raw `db.insert` and give each explicit ids.

- [ ] **Step 1:** Apply the edits (import `PRIMARY_*`/`PRIMARY_CONTEXT`). For setup.ts, distinguish guarded-repo writes (wrap) from raw inserts (explicit ids).
- [ ] **Step 2:** `npm run typecheck` + `npm run lint` + any touched unit test.
- [ ] **Step 3: Commit** — `feat(workers,scripts): move cost-monitor + seed scripts to primary (#323)`

---

## Task 8 (parallelizable): Real-DB test remediation

**Pattern (mechanical):** in each file, change `'default'` tenant/agent usage to `'primary'` (for the seeded-tenant assumption) or to a bespoke tenant (model: `tests/integration/tenant-isolation.spec.ts`, which uses explicit `tenant-a`/`tenant-b`). For tests that insert via the old column-default, set `tenant_id` explicitly now.

**Files (~15, each independent — split across agents):**
- Testcontainer: `channel-catch-all-cross-tenant-real-db`, `mensagens-adopt-cross-tenant-real-db` (these also need the discriminator/adoption semantics updated, not just the literal), `baseline-skills-seed-real-db`, `skills-usage-policy-real-db`, `boleto-proposta-role-seed-real-db`.
- `TEST_DB_URL`: `cognitive-module-log`, `p9c-risk-scoring`, `debounce-flow`, `issue-73-anchoring`, `pending-gate-concurrency`, `p84-create-or-find-active`, `leak`, `repos-leak`, `agent-tool-grants-leak`, `agent-audience-profiles-leak`.

- [ ] **Step 1:** Update each file per the pattern.
- [ ] **Step 2:** `npm run typecheck` + `npm run lint` (real-DB execution is CI-only).
- [ ] **Step 3: Commit** (may be several commits, grouped by area) — `test: migrate real-db specs off 'default' to primary/bespoke (#323)`

---

## Final integration

- [ ] All unit tests green locally (`npm test`).
- [ ] `npm run typecheck` + `npm run lint` clean.
- [ ] Push branch; CI runs migrations + integration + `test:leak` (the real gate).
- [ ] Open PR with the 8 required body sections (AGENTS.md §8). Note in the PR: **the default-ON flip needs owner sign-off before the prod deploy** (spec §6).
- [ ] Do NOT merge/flip without owner sign-off.
