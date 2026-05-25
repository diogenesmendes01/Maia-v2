# Spec — Admin UI: Tools Catalog + Skills Management

Status: **draft / proposed** · Surface: `src/admin-ui/` (Next.js App Router + tRPC v11 + NextAuth) · Deploy: `maia-admin-ui` container (separate from `maia-app`).

This spec defines two new admin-ui screens:

1. **Tools Catalog** (`/tools`) — read-only. Surfaces every tool the LLM can call, with description, side-effect, whether it's currently enabled, and its inputs. Answers the operator question "what can Maia do, and how?".
2. **Skills Management** (`/skills`) — read + lifecycle mutations. Lists/views/proposes/activates/deprecates/rolls back rows in the `skills` table, replacing hand-written SQL.

The two are intentionally coupled: the Skills editor's `allowed_tools` picker is fed by the Tools Catalog data.

---

## 0. Principles & constraints

- **Follow existing patterns.** Routers mirror `llmSettings`/`tenants`; pages mirror `app/setup/llm-settings/page.tsx`; tenant scoping mirrors `capabilities`.
- **Auth model.** Roles: `founder` (super, cross-tenant) > `compliance_officer` > `owner` > `analyst` > `viewer`. Context built in `src/admin-ui/trpc/context.ts` from the NextAuth session (`auth()`), exposing `userRole`, `tenantId`, and guards `assertRole(...)` / `assertTenant(...)`.
- **Tenant isolation.** Non-founders are pinned to their own `tenant_id`. Tenant-scoped reads/writes run inside `runWithTenantContext({ tenant_id, agent_id }, ...)` (see `capabilities.ts`). Tools are **global** (code, not tenant-scoped) → the Tools Catalog needs no tenant scoping; Skills **are** tenant/agent scoped.
- **Audit.** Every mutation writes an audit row (same posture as `tenants.updateStatusAtomic` / `llmSettings.update`).
- **Feature flags.** `FEATURE_SKILL_REGISTRY_V1` gates skill **execution** at runtime (`SkillRunner` gate 1), NOT skill data management. The Skills screen can manage rows even when the flag is off, but must warn that skills won't execute until it's on.
- **Each feature ships as its own PR**, branched from `main`, deployed to `maia-admin-ui`.

---

## 1. Feature 1 — Tools Catalog (`/tools`)

### 1.1 Goal & scope
Read-only catalog of every registered tool. No mutations (tools are defined in code, `src/tools/_registry.ts`). Visible to **all authenticated roles** (viewer+).

### 1.2 The import-cost problem (critical design point)
`import { REGISTRY } from '@/tools/_registry.js'` **pulls in every tool handler** and, transitively, the DB repos / LLM clients they import. The admin-ui must NOT import the registry into client code.

**Decision:** expose tool metadata via a **server-only tRPC procedure** that imports the registry at request time (the tRPC server already runs backend code). The client only ever receives a serialized JSON array.

The existing `getToolSchemas()` (`_registry.ts:188`) is close but returns a stubbed `input_schema: { type:'object', additionalProperties:true }` — it does **not** expand the input fields. For a useful "how to use" view we need the field list, so the procedure builds a richer payload (see 1.3).

### 1.3 Backend — `toolsCatalogRouter`
New file: `src/admin-ui/trpc/routers/tools-catalog.ts`. Register in `_app.ts` as `toolsCatalog`.

```ts
// listCatalog: protectedProcedure (read-only; any authenticated role)
listCatalog: protectedProcedure.query(async () => {
  const { REGISTRY, isToolEnabled } = await import('@/tools/_registry.js');
  return Object.values(REGISTRY).map((t) => ({
    name: t.name,
    description: t.description,
    side_effect: t.side_effect,           // none | read | write | communication
    operation_type: t.operation_type,
    sensitive: t.sensitive ?? false,      // view-once outputs (balances etc.)
    feature_flag: t.feature_flag ?? null,
    required_actions: [...t.required_actions],
    enabled: isToolEnabled(t.name),       // false when its feature flag is off
    inputs: describeZodObject(t.input_schema), // [{ name, type, optional, description? }]
  }));
}),
```

- `describeZodObject` — small server-side helper (new, e.g. `src/tools/describe-schema.ts`) that introspects the Zod input schema into a flat field list `{ name, type, optional }`. Avoids shipping zod to the client. If `zod-to-json-schema` is already a dep, use it; otherwise a ~30-line introspector over `ZodObject.shape` covers the common cases (string/number/boolean/enum/optional/array).
- Returns the **full set** of tools with an `enabled` flag (so operators see disabled-but-existing tools and which flag turns them on). Do **not** filter by `getToolSchemas` permission logic here — this is a catalog, not the LLM tool exposure.

### 1.4 Frontend — `/tools` page
New: `src/admin-ui/app/tools/page.tsx` (`'use client'`), pattern from `app/setup/llm-settings/page.tsx`.

- `const q = trpc.toolsCatalog.listCatalog.useQuery();`
- **Search box** (filter by name/description) + **filters**: side-effect, enabled-only, sensitive-only.
- **Grouping**: by `side_effect` (read / write / communication / none) — read-heavy at top.
- **Row/card** per tool:
  - Title: `name` + badges → `side_effect`, `enabled` (green) / `disabled` (gray, show `feature_flag` that gates it), `sensitive` (amber).
  - `description`.
  - Collapsible **Inputs** section: the `inputs` field list (name · type · optional).
- Empty/loading/error states like the llm-settings page.

### 1.5 Navigation
`src/admin-ui/app/layout.tsx` nav (after the `|` divider): `<Link href="/tools">Tools</Link>`.

### 1.6 Acceptance criteria
- [ ] `/tools` lists all ~40 registered tools with description + side-effect.
- [ ] Tools gated by an off feature flag render as **disabled** and name the flag.
- [ ] `sensitive` tools are visually marked.
- [ ] Each tool's input fields are listed.
- [ ] No tool **handler** code is bundled into the client (verify the page chunk size / no DB imports).
- [ ] Visible to `viewer` role.

---

## 2. Feature 2 — Skills Management (`/skills`)

### 2.1 Goal & scope
Manage the `skills` table (P9a Skill Registry) through the UI: **list, view, propose, activate, deprecate, rollback** — versioned, tenant/agent-scoped, audited. Replaces raw SQL.

### 2.2 Authoring path decision (operator vs agent)
Two creation paths exist:
- **Direct `skillsRepo.propose` → `activate`** — for **operator-authored** skills. Simpler; no test loop.
- **`capability_proposals` (capability_type='skill') → proposals approval → delivery** — for **agent-proposed** skills (dialogical acquisition, `FEATURE_DIALOGICAL_ACQUISITION`).

**Decision for v1:** the Skills screen uses the **direct `skillsRepo` path** with role-based separation of duties (propose ≠ activate). The agent-proposed `capability_proposals` flow stays as-is and is surfaced (read-only) on the existing `/capabilities` screen. Document the seam so the two can converge later.

### 2.3 Skill data model (from `src/db/schema.ts:1894`)
Key fields the UI must handle: `skill_descriptor`, `category` (classify|extract|compose|decide|tool_mediated|diagnose|plan|evaluator), `execution_mode` (prompt_only|procedure_adapter|tool_mediated|evaluator), `goal`, `when_to_use`, `procedure` (jsonb), `constraints` (jsonb[]), `input_schema`/`output_schema` (jsonb), `allowed_tools` (text[]), `policy_descriptors` (text[]), `success_criteria`/`failure_modes` (jsonb[]), `runtime_hints` (jsonb: max_prompt_tokens, max_output_tokens, max_tool_calls, timeout_ms, preferred_model), `status` (proposed|active|deprecated|rolled_back), `version`, proposer/approver/timestamps.

Validation rule to mirror from the repo: **evaluator-mode skills must have empty `allowed_tools`** (`skills-repo.ts` validation) — enforce in the form + server input schema.

### 2.4 Backend — `skillsRouter`
New file: `src/admin-ui/trpc/routers/skills.ts`. Register in `_app.ts` as `skills`. All procedures resolve tenant via `resolveTenantId(ctx, input.tenantId)` and wrap repo calls in `runWithTenantContext({ tenant_id, agent_id }, ...)`.

| Procedure | Type | Role gate | Backing call |
|---|---|---|---|
| `list` | query | any auth (viewer+) | `skillsRepo.listByCategory` / a new `listAll(status?)` |
| `getById` | query | any auth | `skillsRepo.getById` |
| `listVersions` | query | any auth | `skillsRepo.listVersions(descriptor)` |
| `propose` | mutation | `owner`, `founder` | `skillsRepo.propose(input)` |
| `activate` | mutation | `compliance_officer`, `founder` | `skillsRepo.activate(id, approver, reason)` |
| `deprecate` | mutation | `owner`, `founder` | `skillsRepo.deprecate(id, by, reason)` |
| `rollback` | mutation | `founder` | `skillsRepo.rollback(id, reason, by)` |

- **Separation of duties:** the proposer roles (`owner`) cannot activate; activation requires `compliance_officer`/`founder`. Enforce with `ctx.assertRole(...)` at the top of each mutation (pattern from `proposals.ts`).
- **Input schemas (zod):** a `SkillContractInputSchema` mirroring `SkillContract` (schema.ts:1988) with enum guards on `category`/`execution_mode` and the evaluator/`allowed_tools` cross-field refinement. `activate`/`deprecate`/`rollback` take `{ id, reason }` (+ `tenantId?`, `agentId?`).
- **Audit:** each mutation writes an audit row (action e.g. `skill_proposed`, `skill_activated`). The repo's `activate`/`rollback` are already transactional; wrap the audit insert in the same `withTx` where the repo exposes it, otherwise audit immediately after.
- **Feature-flag awareness:** add a `meta` field to `list` output (or a tiny `skills.runtimeStatus` query) returning `FEATURE_SKILL_REGISTRY_V1` so the UI can render the "won't execute until enabled" banner. Mutations are allowed regardless of the flag (managing data ≠ executing).

### 2.5 Frontend — `/skills` page
New: `src/admin-ui/app/skills/page.tsx` (`'use client'`) + `app/skills/_components/skill-form.tsx`. Reuse the agent-selector + status-tabs pattern from `app/capabilities/page.tsx`.

- **Header controls:** agent selector (`trpc.agents.list`), status tabs (active / proposed / deprecated / rolled_back).
- **Flag banner:** if `FEATURE_SKILL_REGISTRY_V1` is off → amber banner: "Skills are managed here but won't execute until FEATURE_SKILL_REGISTRY_V1 is enabled on maia-app."
- **Table:** descriptor · category · execution_mode · version · status · activated_at · actions.
- **Detail drawer/modal:** full contract (goal, when_to_use, schemas pretty-printed, allowed_tools, policy_descriptors, runtime_hints, success/failure). "Versions" tab via `listVersions`.
- **Propose form** (`skill-form.tsx`) — gated to `owner`/`founder`:
  - descriptor (text), category (select), execution_mode (select), goal/when_to_use (textarea), proposed_reason (textarea, min 10 — mirror existing audited-reason inputs).
  - input_schema / output_schema: JSON textarea with parse validation (v1); a structured builder is future work.
  - **allowed_tools**: multi-select **populated from `trpc.toolsCatalog.listCatalog`** (the coupling). Disabled when execution_mode = evaluator (matches repo rule).
  - policy_descriptors, success_criteria, failure_modes: tag inputs / JSON.
  - runtime_hints: numeric fields.
- **Lifecycle actions** (role-gated, each requires a reason): Activate / Deprecate / Rollback. Mirror llm-settings mutation UX (mutateAsync + invalidate + error surfacing via `error.data.code`).

### 2.6 Acceptance criteria
- [ ] `/skills` lists skills for the selected agent, filterable by status; founders can switch tenant.
- [ ] Propose creates a `proposed` row (version auto-increments); `owner`/`founder` only.
- [ ] Activate flips proposed→active and deprecates the prior active atomically; `compliance_officer`/`founder` only; proposer role (`owner`) is rejected from activating.
- [ ] Deprecate / Rollback enforce their role gates and require a reason; each writes audit.
- [ ] Evaluator-mode skill with non-empty `allowed_tools` is rejected (form + server).
- [ ] Flag-off banner renders; mutations still work; reads still work.
- [ ] Tenant isolation: non-founder cannot read/mutate another tenant's skills.

---

## 3. Cross-cutting

- **Role matrix summary**

  | Action | viewer | analyst | owner | compliance_officer | founder |
  |---|---|---|---|---|---|
  | View tools / skills | ✓ | ✓ | ✓ | ✓ | ✓ |
  | Propose skill | | | ✓ | | ✓ |
  | Activate skill | | | | ✓ | ✓ |
  | Deprecate skill | | | ✓ | | ✓ |
  | Rollback skill | | | | | ✓ |

- **Tenant scoping:** Tools = global (no scoping). Skills = `resolveTenantId` + `runWithTenantContext`.
- **Audit actions (new):** `skill_proposed`, `skill_activated`, `skill_deprecated`, `skill_rolled_back`.
- **No new migrations** — `skills` table already exists (schema.ts:1894). Only a possible `listAll(status?)` addition to `skillsRepo` if not present.

---

## 4. Delivery phases (each = its own PR off `main`)

- **Phase 1 — Tools Catalog.** `toolsCatalogRouter` + `describeZodObject` helper + `/tools` page + nav. No flag dependency, read-only, low risk. Ship first.
- **Phase 2 — Skills read.** `skillsRouter.list/getById/listVersions` + `/skills` page (list + detail, no mutations) + flag banner.
- **Phase 3 — Skills mutations.** `propose/activate/deprecate/rollback` + `skill-form.tsx` + role gates + audit. Reuses Phase-1 tools data for `allowed_tools`.

---

## 5. Out of scope (future)
- Editing/creating tools from the UI (tools are code).
- Running skill tests / evaluator loops from the UI.
- Structured JSON-schema builder for skill input/output (v1 uses JSON textareas).
- Converging operator-authored and agent-proposed (capability_proposals) skill flows.

---

## 6. Open decisions for the owner
1. **Route placement:** top-level `/tools` & `/skills`, or under `/setup/*`? (Spec assumes top-level, grouped with capabilities/procedures.)
2. **Skill authoring path:** confirm v1 uses the **direct `skillsRepo`** path (not the capability_proposals approval matrix). 
3. **Activation duties:** confirm `compliance_officer`/`founder` for activation (proposer `owner` cannot self-activate). If you want solo operation, allow `founder` to both propose and activate.
4. **Input-schema serializer:** add `zod-to-json-schema` dep, or hand-roll the ~30-line introspector? (Spec leans hand-rolled to avoid a new dep.)

---

## Appendix — file map

| Concern | File | Action |
|---|---|---|
| Root router | `src/admin-ui/trpc/routers/_app.ts` | add `toolsCatalog`, `skills` |
| Tools router | `src/admin-ui/trpc/routers/tools-catalog.ts` | **new** |
| Zod field introspector | `src/tools/describe-schema.ts` | **new** |
| Skills router | `src/admin-ui/trpc/routers/skills.ts` | **new** |
| Tools page | `src/admin-ui/app/tools/page.tsx` | **new** |
| Skills page | `src/admin-ui/app/skills/page.tsx` (+ `_components/skill-form.tsx`) | **new** |
| Nav | `src/admin-ui/app/layout.tsx` | add 2 links |
| Skills repo | `src/control-plane/skill-registry/skills-repo.ts` | maybe add `listAll(status?)` |
| Context/guards (reuse) | `src/admin-ui/trpc/context.ts` (`assertRole`), `trpc/tenant-resolver.ts` | none |

### Reference templates
- Router + role gating: `src/admin-ui/trpc/routers/llmSettings.ts`, `tenants.ts`, `proposals.ts`
- Context/guards: `src/admin-ui/trpc/context.ts:18`, `server.ts` (`protectedProcedure`/`founderProcedure`)
- Tenant scoping: `src/admin-ui/trpc/routers/capabilities.ts:35`, `tenant-resolver.ts:24`
- Page/mutation UX: `src/admin-ui/app/setup/llm-settings/page.tsx`
- Tool metadata: `src/tools/_registry.ts:55` (type), `:104` (REGISTRY), `:188` (`getToolSchemas`)
- Skills: `src/db/schema.ts:1894` (table), `:1988` (SkillContract), `src/control-plane/skill-registry/skills-repo.ts:31`
