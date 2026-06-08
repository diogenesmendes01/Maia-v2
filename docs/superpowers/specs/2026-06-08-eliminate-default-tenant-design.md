# Maia v2 — Eliminate the `'default'` tenant from runtime — Design Spec

**Date:** 2026-06-08
**Status:** Draft — approved in brainstorming, pending spec review
**Issue refs:** #323 (flip `MAIA_REJECT_DEFAULT_LITERAL` default-ON), #345 (worker sweep), #355 (flip-readiness hardening), #411 (single-tenant catch-all), #282/#296/#315 (the `'default'` rejection machinery)
**Invariant locks:** Tenant isolation is inviolable (AGENTS.md §4.1); fail-closed in security (§4.2); migrations append-only with `_up`/`_down` (§4.6). This spec respects all — it does not alter them, it completes them.

---

## 0. Purpose

### 0.1 What the audit found (the starting point)

A read-only audit of the tenant-isolation epic (#323/#345/#355) found that **almost all of the code work is already in `main`** — the issue checkboxes are stale:

- **#355 hardening (H1–H5):** all ~24 repo mutations are scoped (`tenant_id`+`agent_id` predicate, fail-loud or documented best-effort, mutation-isolation tests). H5 dead-code already removed in #368.
- **#355 structural:** `lockdown.ts` already migrated to per-tenant; scheduling Spec-18 tables already got tenant columns + backfill + indexes (migrations 071/072/073) and all ~20 mutations are scoped.
- **#345 worker sweep:** the worker fleet already fans out over real tenant tuples or uses `runWithSystemContext`. `cost-monitor` is the only worker still on the literal.

The `'default'`-rejection guard itself is **100% implemented** (`assertNotDefaultLiteral` in `src/db/tenant-context.ts`); `MAIA_REJECT_DEFAULT_LITERAL` is read at access time and currently defaults OFF (meters only).

### 0.2 The one real blocker

Flipping `MAIA_REJECT_DEFAULT_LITERAL=true` today **fails-closed on three live paths** that still carry `'default'`:

1. **`src/agent/core.ts` (the single-tenant request path, #411)** — the dominant blocker. The channel resolver's single-tenant catch-all maps every unknown sender to the seeded `default/default` channel, so **every inbound message runs its whole turn under `runWithTenantContext({tenant_id:'default', agent_id:'default'})`** (`core.ts:410`). With the flag ON, the first `getCurrentTenant()` inside the turn throws `DefaultLiteralRejectedError` → BullMQ job failure → DLQ. The flip is mutually exclusive with the #411 catch-all as implemented.
2. **`src/workers/cost-monitor.ts:26`** — runs under the literal.
3. **`scripts/p8e-seed-policies.ts:225`** — runs under the literal.

The prerequisite #323 itself names — *"the single-tenant fallback is replaced with a real resolved tenant"* — was never satisfied; #411 re-introduced the fallback under `'default'`.

### 0.3 The goal

Give the single-tenant runtime a **real reserved tenant** so `'default'` disappears from every runtime path, then the flip becomes safe and unconditional. Per the brainstorming decisions:

- **Approach A:** reserved `primary` tenant + data rebind migration.
- **Delete `'default'` entirely** (after this impact audit, which confirmed viability + the required remediations).
- **Drop the `tenant_id DEFAULT 'default'` column-default** on the 27 legacy tables → INSERT without a tenant fails NOT NULL instead of silently bucketing into `'default'` (closes the #282 silent fall-through).

---

## 1. File structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/0NN_seed_primary_tenant.sql` + `_down` | Create | Seed reserved `primary`/`primary` tenant+agent (idempotent `ON CONFLICT`). |
| `migrations/0NN_rehome_default_to_primary.sql` + `_down` | Create | `UPDATE … SET tenant_id='primary'[, agent_id='primary'] WHERE tenant_id='default'` across every tenant-scoped table (dynamic loop over `information_schema`). |
| `migrations/0NN_drop_default_column_default.sql` + `_down` | Create | `ALTER TABLE … ALTER COLUMN tenant_id/agent_id DROP DEFAULT` on the 27 legacy tables. |
| `migrations/0NN_delete_default_tenant.sql` + `_down` | Create | Delete the now-orphaned `default` rows (typed seeds → agent → tenant), in FK-safe order. |
| `src/db/tenant-context.ts` | Modify | Add `PRIMARY_TENANT_ID`/`PRIMARY_AGENT_ID`/`PRIMARY_CONTEXT` constants + `isPrimaryContext` helper. |
| `src/db/repositories.ts` | Modify | `findDefaultCatchAllChannel`: discriminator `ne(tenant_id,'default')` → `ne(tenant_id,'primary')`; catch-all lookup `eq(…, 'default')` → `'primary'`. Rename helper to `findPrimaryCatchAllChannel`. The `default/default` adoption lookup (`repositories.ts:~1215`) → `primary`. |
| `src/gateway/channel-resolver.ts` | Modify | Catch-all comments + single-tenant branch → `primary`. |
| `src/agent/core.ts` | Modify | `resolved` initial value + adoption discriminator (`!== 'default'`) → `primary`. |
| `scripts/setup.ts` | Modify | Wrap seed writes in `runWithTenantContext(PRIMARY_CONTEXT, …)`. |
| `src/workers/cost-monitor.ts` | Modify | `runWithTenantContext({…'default'})` → `PRIMARY_CONTEXT`. |
| `scripts/p8e-seed-policies.ts` | Modify | `default/default` → `primary/primary`. |
| `src/config/env.ts` | Modify | Add `MAIA_REJECT_DEFAULT_LITERAL` to the schema, default **`true`** (Phase 6 flip). |
| `migrations/035_*`, `037_*`, `039_*`, `075_*`, `077_*`, `079_*` | **NOT edited** | Append-only — the typed seeds stay as written; the rehome+delete migrations supersede them. New deployments seed `primary` via the new migrations (see §3.4). |
| `tests/**` (~28 files) | Modify | See §5. |

> Migration numbers (`0NN`) assigned at implementation time against the current `migrations/` max. The four SQL steps MAY be authored as one migration file with ordered statements, but are described separately for clarity and reversibility.

---

## 2. The reserved `primary` tenant

```ts
// src/db/tenant-context.ts
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

**Semantics — `primary` is an ordinary tenant, not a sentinel.** Unlike `system` (which is exception-permitted for global no-owner work), `primary` is a real single-tenant home: it passes `assertNotDefaultLiteral`/`assertTruthyContext` with no special-casing. The guard's reject-set stays `{ 'default' }`; the permit-exception stays `{ 'system' }`. We do **not** add `primary` to either.

**Why not reuse `system`?** `system` is documented as "ONLY for work that is global by NATURE (no per-tenant row)". An agent turn answering a user is per-tenant work; parking it on `system` would re-create the cross-tenant collapse the epic exists to kill. (`tenant-context.ts:71-75`.)

**Forward compatibility (multi-tenant).** When a real second tenant is later onboarded, `primary` is just one tenant among many; the single-tenant catch-all auto-disables the moment a channel of any tenant `!= 'primary'` exists (see §4.1). No further change to `primary` is needed.

---

## 3. Migration sequence (append-only, each reversible)

Ordered so the DB is never in a state where a FK target is missing. `migrate.ts` already wraps each file in a transaction (no `BEGIN/COMMIT` in the file).

### 3.1 Seed `primary` (step 1)
```sql
INSERT INTO tenants (id, nome, status)
  VALUES ('primary', 'Primary (single-tenant runtime)', 'active') ON CONFLICT (id) DO NOTHING;
INSERT INTO agents (id, tenant_id, nome, status)
  VALUES ('primary', 'primary', 'Maia', 'active') ON CONFLICT (id) DO NOTHING;
```
`_down`: delete the `primary` agent then tenant (only safe before any rehome; see overall rollback §8).

### 3.2 Rehome data `default` → `primary` (step 2)
Dynamic loop over every table that has a `tenant_id` column FK-referencing `tenants` (≈71 tables), excluding `tenants`/`agents` themselves:
```sql
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'tenant_id' AND table_schema = 'public'
      AND table_name NOT IN ('tenants','agents')
  LOOP
    EXECUTE format('UPDATE %I SET tenant_id=''primary'' WHERE tenant_id=''default''', t);
    -- agent_id only where the column exists
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name=t AND column_name='agent_id' AND table_schema='public') THEN
      EXECUTE format('UPDATE %I SET agent_id=''primary'' WHERE agent_id=''default''', t);
    END IF;
  END LOOP;
END $$;
```
This carries the typed seeds (catch-all channel, role/policy, biases, baseline skills) along, since they live in these tenant-scoped tables. `_down`: same loop, `primary` → `default`.

> **Note on the catch-all channel:** the row's `external_id='default-channel'` is an inert placeholder (the resolver finds the catch-all by `channel_type` + tenant, not by this string). The rehome only changes `tenant_id`/`agent_id`; `external_id` need not change. The resolver discriminator change (§4.1) is what re-points "which tenant is the catch-all".

### 3.3 Drop the column-default (step 3)
On the 27 tables from migration 009 (`entidades, contas_bancarias, categorias, transacoes, transferencias_internas, recorrencias, contrapartes, pessoas, permission_profiles, permissoes, conversas, mensagens, agent_facts, learned_rules, agent_memories, self_state, entity_states, workflows, workflow_steps, pending_questions, idempotency_keys, system_health_events, dead_letter_jobs, dashboard_sessions, import_runs, import_entries, audit_log`):
```sql
ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE %I ALTER COLUMN agent_id  DROP DEFAULT;
```
`_down`: `SET DEFAULT 'default'` (restores 009's behaviour).

### 3.4 Delete `default` rows (step 4)
After rehome, no child rows reference `default` (FK RESTRICT now permits deletion). Delete the typed seeds first, then agent, then tenant:
```sql
-- typed seeds under default (channels, role_policies, soul_biases, …) are already
-- rehomed by 3.2, so 'default' owns zero rows here; these deletes are defensive no-ops
DELETE FROM agents  WHERE id='default';
DELETE FROM tenants WHERE id='default';
```
`_down`: re-INSERT the `default` tenant+agent (the typed seeds are NOT restored by `_down` — rollback restores the sentinel rows enough for FK targets; a full data rollback uses 3.2's `_down`).

---

## 4. Code changes

### 4.1 The catch-all discriminator (the correctness-critical change)
`findDefaultCatchAllChannel` (`repositories.ts:~8386`) decides "is this deployment multi-tenant?" by looking for any active channel whose `tenant_id != 'default'`. After rehome, the single-tenant home is `primary`, so:
- discriminator: `ne(channels.tenant_id, 'default')` → `ne(channels.tenant_id, 'primary')`
- catch-all lookup: `eq(channels.tenant_id, 'default')` → `eq(channels.tenant_id, 'primary')`
- rename helper → `findPrimaryCatchAllChannel` (and its callers in `channel-resolver.ts`).

Behaviour preserved: an unknown sender resolves to `primary/primary` **iff** no channel of any other tenant exists; the instant a real tenant is added, misses fail-loud (#268 preserved).

### 4.2 Request path (`core.ts`)
- `resolved` initial value `{tenant_id:'default', agent_id:'default'}` → `{…'primary'}`.
- adoption discriminator `if (resolved.tenant_id !== 'default' || resolved.agent_id !== 'default')` → compare against `primary` (use `!isPrimaryContext(resolved)`).
- The cross-tenant adoption CAS (`adoptToResolvedTenantCrossTenant`) keeps its semantics; only the "still-unclaimed" baseline changes from `default` to `primary` (the gateway now ingests inbound under `primary` — see §4.5).

### 4.3 `cost-monitor`
`runWithTenantContext({tenant_id:'default', agent_id:'default'}, …)` → `runWithTenantContext(PRIMARY_CONTEXT, …)`. (The daily LLM cost is per-`(tenant,agent)` under the `'global'` key scope; in single-tenant that is `primary`. The `allowlist` option from #355 is moot once `default` is deleted.)

### 4.4 `scripts/p8e-seed-policies.ts` & `scripts/setup.ts`
Both run their seed writes under `runWithTenantContext(PRIMARY_CONTEXT, …)` instead of the `default` literal. `setup.ts` currently writes with no ALS at all (relying on the dropped column-default); after §3.3 it MUST wrap writes in `PRIMARY_CONTEXT` or they fail NOT NULL — this is the intended fail-closed behaviour and the canonical example for the test remediation.

### 4.5 Baileys ingress
The gateway persists inbound rows before the resolver runs. Today it stamps `default/default` (via the column-default / explicit literal). After §3.3 the column-default is gone, so the ingress write MUST stamp `primary` explicitly (or `runWithTenantContext(PRIMARY_CONTEXT)`), matching the adoption baseline in §4.2. Verify `src/gateway/baileys.ts` + `jid-tenant-resolver.ts` stamp `primary`.

### 4.6 The flip (`env.ts`)
Add `MAIA_REJECT_DEFAULT_LITERAL` to the zod env schema, default `true`. Keep `shouldThrowOnDefaultLiteral()` reading the same name so an operator can set `=false` for an emergency rollback without a redeploy.

---

## 5. Test strategy (TDD; the leak suite is the gate)

Per the impact audit, three buckets:

| Bucket | Count | Action |
|---|---|---|
| `'default'` as a string in mocks/in-memory stores | ~127 | None required (still pass). Optionally normalize to `primary` for hygiene — **not** in this scope. |
| Catch-all / discriminator **behaviour** tests (mocked) | ~13 | Update expected triplet `default/default` → `primary/primary` and the discriminator literal. Files incl. `channel-resolver.spec.ts`, `gateway/channel-resolver-discriminator.spec.ts`, `gateway/channel-resolver-fail-loud.spec.ts`, `agent-core-channel-resolution.spec.ts`, `baileys-tenant-context.spec.ts`, `gateway/jid-tenant-resolver.spec.ts`, `channels-repo.spec.ts`, `p6-channel-role-policy.spec.ts`. |
| **Real-DB** tests depending on the `default` seed / column-default | ~15 | Migrate to `primary` or bespoke tenants. Testcontainer specs (`channel-catch-all-cross-tenant-real-db`, `mensagens-adopt-cross-tenant-real-db`, `baseline-skills-seed-real-db`, `skills-usage-policy-real-db`, `boleto-proposta-role-seed-real-db`) + `TEST_DB_URL` specs (`leak`, `repos-leak`, `debounce-flow`, `issue-73-anchoring`, `pending-gate-concurrency`, `p84-create-or-find-active`, `cognitive-module-log`, `p9c-risk-scoring`, `agent-tool-grants-leak`, `agent-audience-profiles-leak`). |

**New tests (write first, red → green):**
1. **Rehome correctness** (real-DB or migration test): a row seeded under `default` lands under `primary`; zero rows remain under `default` post-migration.
2. **Fail-closed INSERT** (real-DB): an INSERT omitting `tenant_id` on a 009 table now raises NOT NULL (was silently `default`).
3. **Resolver single-tenant** (unit): unknown sender → `primary/primary`; with a second tenant's channel present → fail-loud.
4. **Flip safety** (integration, `MAIA_REJECT_DEFAULT_LITERAL=true`): a full inbound turn under `primary` succeeds end-to-end; a synthetic `default` context throws `DefaultLiteralRejectedError`.

Gate before requesting review: `npm run typecheck` + `npm run lint` + `npm test` + `npm run test:leak` (and integration where Docker/`TEST_DB_URL` available).

---

## 6. Sequence to the flip (deploy)

1. Land migrations §3 + code §4 + tests §5 **in one coordinated deploy** (migration runs, then the app restarts on the new code). Single-tenant runtime = one process, so the migrate→restart window is a normal deploy restart, not a live mixed-version window.
2. Run full suite + `test:leak` green in CI.
3. **Owner sign-off**, then confirm `MAIA_REJECT_DEFAULT_LITERAL` default-ON is in effect (Phase 6). Watch `maia_tenant_id_default_literal_total` — it must stay flat at 0.

> If a live mixed-version window is a concern later (multi-instance), an expand/contract variant (code tolerates both `default` and `primary` first, migrate, then remove `default` tolerance) is the fallback — out of scope for the current single-process runtime.

---

## 7. Out of scope (YAGNI)

- **Root-fix of #411** (resolving by the bot's own line/`external_id` instead of the sender) — the catch-all stays; we only re-point it to `primary`.
- **Per-tenant cost ledger** — `cost-monitor` simply moves to `primary`.
- **Slug-derived tenant ids** (Approach C) — `primary` is a fixed reserved id.
- **Normalizing the ~127 string-only test fixtures** to `primary`.
- **Closing #355/#345 as issues** — tracked separately as hygiene (the code is already done); this spec is about the flip blocker.

---

## 8. Risks & rollback

| Risk | Mitigation |
|---|---|
| Rehome misses a table (orphan rows under `default`) | Dynamic `information_schema` loop covers every `tenant_id` column; new test #1 asserts zero `default` rows post-migration. |
| Deleting `default` breaks a path that still emits it | The flip (`=true`) + counter `maia_tenant_id_default_literal_total` surface any straggler before/after; CI leak suite + flip-safety test gate it. |
| Column-default drop breaks a code INSERT that relied on it | Production repos already stamp via `applyTenantGuard`; audit covered `setup.ts`/baileys ingress (§4.4/4.5). Any missed site fails loudly (NOT NULL), not silently. |
| Coordinated deploy window | Single process → migrate-then-restart; emergency rollback = `MAIA_REJECT_DEFAULT_LITERAL=false` (no redeploy) + migration `_down`. |
| FK RESTRICT blocks `default` delete | Delete ordered after rehome (children re-pointed first); typed-seed deletes are defensive no-ops. |

**Rollback:** set `MAIA_REJECT_DEFAULT_LITERAL=false` (instant, env-only). For a full revert, run the migration `_down` chain (re-seed `default`, rehome `primary`→`default`, restore column-defaults) and redeploy the prior code.

---

## 9. Open questions

None blocking. Migration file numbers and the exact tenant-scoped table count (≈71) are resolved at implementation time against `main`.
