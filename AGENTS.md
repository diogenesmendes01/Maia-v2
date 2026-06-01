# AGENTS.md — Maia Development Manual

> Operating manual for AI development agents (Claude Code, Codex, Gemini CLI). Read this first; then read [`ARCHITECTURE.md`](ARCHITECTURE.md) before touching any non-trivial code.

## 0. Reading order

1. **This file** — conventions and commands
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — mental model, pillars, invariants
3. For non-trivial AI-assisted work, [`docs/ai/agent-operating-model.md`](docs/ai/agent-operating-model.md)
4. The **concern** doc most relevant to your task — [`docs/architecture/concerns/`](docs/architecture/concerns/)
5. The **module** doc(s) for files you'll edit — [`docs/architecture/modules/`](docs/architecture/modules/)
6. **Source code is the source of truth.** Docs guide; code decides.

## 1. Instruction priority

When instructions conflict, follow this order:

1. **User's explicit instructions** in the current session — highest
2. **This `AGENTS.md`** + project docs under `docs/architecture/`
3. **superpowers skills** if available (overriding default agent behaviors)
4. **Default model behavior** — lowest

If a project instruction conflicts with a skill, the project wins. If the user says "skip TDD here", you skip TDD here.

## 2. What this project is (in 10 lines)

**Maia is a multi-agent platform governed via WhatsApp.** Tenants own agents; agents learn skills and procedures under owner approval; every behavior change is audited. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full model.

| Layer | Tech |
|---|---|
| Runtime | Node 20+, TypeScript 5+, ESM |
| Server | Fastify (`src/server.ts`) |
| DB | PostgreSQL 16 + pgvector via Drizzle ORM |
| Cache / Queue | Redis + BullMQ (`ioredis`) |
| Channel | WhatsApp via Baileys; multi-channel schema present |
| LLM | Anthropic Claude (Sonnet 4.6 + Haiku 4.5); OpenAI Whisper (audio); Claude Vision (images) |
| Admin UI | Next.js 14 + tRPC + NextAuth (`src/admin-ui/`) |
| Validation | Zod everywhere |
| Tests | Vitest (unit/integration/e2e) + Playwright (admin-ui) |
| Migrations | Versioned SQL in `migrations/` |

## 3. Where things live

### Concerns (cross-cutting invariants)

| Concern | Doc |
|---|---|
| Tenant isolation invariant | [`concerns/tenant-isolation.md`](docs/architecture/concerns/tenant-isolation.md) |
| Cognitive layer (think / reflect / learn) | [`concerns/cognitive-stack.md`](docs/architecture/concerns/cognitive-stack.md) |
| Action layer (decide / execute) | [`concerns/action-layer.md`](docs/architecture/concerns/action-layer.md) |
| Channels, roles, policies | [`concerns/channel-policy.md`](docs/architecture/concerns/channel-policy.md) |
| Governance, audit, observability | [`concerns/governance-observability.md`](docs/architecture/concerns/governance-observability.md) |

### Subsystems (one module doc per `src/` subdir)

24 subdirectories in [`src/`](src/), one doc each under [`docs/architecture/modules/`](docs/architecture/modules/). See the **Code map** in [`ARCHITECTURE.md`](ARCHITECTURE.md#5-code-map) for the table.

### Other documentation

| What | Where |
|---|---|
| Operational runbooks (debug + rollback) | [`docs/runbooks/`](docs/runbooks/) |
| Per-feature design specs | [`docs/superpowers/specs/`](docs/superpowers/specs/) |
| Implementation plans | [`docs/superpowers/plans/`](docs/superpowers/plans/) |
| AI engineering agent workflows | [`docs/ai/`](docs/ai/) |
| Architecture decisions | [`docs/architecture/decisions/`](docs/architecture/decisions/) |
| Versioned schema | [`migrations/`](migrations/) |
| Current financial agent seed | [`src/identity/maia-prompt.md`](src/identity/maia-prompt.md) — not the platform identity |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |

### AI engineering workflows

| Workflow | Doc |
|---|---|
| Operating model | [`docs/ai/agent-operating-model.md`](docs/ai/agent-operating-model.md) |
| Coding agent playbook | [`docs/ai/coding-agent-playbook.md`](docs/ai/coding-agent-playbook.md) |
| Review agent playbook | [`docs/ai/review-agent-playbook.md`](docs/ai/review-agent-playbook.md) |
| Task spec template | [`docs/ai/task-spec-template.md`](docs/ai/task-spec-template.md) |
| Maia invariant checklist | [`docs/ai/maia-invariants-checklist.md`](docs/ai/maia-invariants-checklist.md) |

## 4. Conventions agents MUST follow

| # | Rule | Where enforced |
|---|---|---|
| 1 | **Every stateful boundary scopes by `tenant_id + agent_id`** | DB queries, Redis keys, cache keys, ALS context. See [`concerns/tenant-isolation.md`](docs/architecture/concerns/tenant-isolation.md). |
| 2 | **Fail-closed in security** | Missing `tenant_id`/`agent_id` → reject. Unmatched policy → reject. Unresolved channel → reject. Never fall back to `'default'` in production paths. |
| 3 | **Backend decides, LLM proposes** | LLM emits typed intents (Zod). Backend validates against state + rules. Backend executes (or denies). See [`concerns/action-layer.md`](docs/architecture/concerns/action-layer.md). |
| 4 | **Audit every decision** | Side-effect or governance decision → `audit()` row in `audit_logs` with action label and tenant context. |
| 5 | **Confidence is computed** | Confidence values come from deterministic formulas over evidence counts. The LLM never declares its own confidence. |
| 6 | **Migrations are append-only** | New migration file with `_up` + `_down`. Never edit a merged migration. |
| 7 | **Branch before commit** | `git checkout -b claude/<short-purpose>` off `main`. Never commit to `main` directly. |
| 8 | **No `'default'` literal in dynamic paths** | Schema seeds `tenant_id='default'`/`agent_id='default'` for single-tenant runtime, but production code rejects the literal when it appears in resolver/context-builder paths. |

## 5. Conventions agents SHOULD follow

| # | Rule | Notes |
|---|---|---|
| 1 | **TDD for new behavior** | Failing test → minimum code → passing test → refactor. Relax for trivial typo fixes or pure-docs commits. |
| 2 | **Follow existing patterns** | Before introducing a new pattern, find a similar case in `src/` and follow it. |
| 3 | **Keep files small** | Past ~500 lines without clear reason = refactor signal. |
| 4 | **Cite `path/file.ts:line`** | In commit messages, PR bodies, and docs — clickable + greppable. |
| 5 | **Verify references at write time** | Line numbers drift. Re-check before citing. |

## 6. Commands

```bash
# Install
npm install

# Dev (single process, watch mode via tsx)
npm run dev

# Tests
npm test                          # unit (vitest run)
npm run test:watch                # unit, watch mode
npm run test:integration          # integration (needs Postgres + Redis)
npm run test:e2e                  # e2e
npm run test:leak                 # cross-tenant leak suite (critical, run before any tenant-related change)

# Static checks (run before every commit)
npm run docs:ai:check             # AI engineering docs governance
npm run typecheck                 # tsc --noEmit
npm run lint                      # eslint src tests scripts
npm run format                    # prettier --write src

# Build
npm run build                     # tsc + tsc-alias

# DB
npm run db:migrate                # apply migrations in order
npm run db:seed                   # seed dev data

# Bootstrap
npm run setup                     # wizard: self_state + owner + (optionally) entities + accounts + permissions

# Admin UI (separate Next.js app)
npm run admin:install
npm run admin:dev                 # port 4000
npm run admin:build
npm run admin:typecheck
npm run test:admin-ui:unit
npm run test:admin-ui:e2e         # Playwright

# Operational
npm run dlq                       # dead-letter queue inspection
npm run embeddings:rebuild        # regenerate vector embeddings
npm run import:ofx                # OFX file import flow
npm run backup                    # DB backup
```

## 7. Integration test setup

`npm run test:integration` requires real Postgres + Redis:

```bash
npm run test:integration:setup    # docker compose up -d redis postgres
npm run test:integration          # vitest run tests/integration --no-coverage
npm run test:integration:teardown # docker compose down -v
```

CI runs these automatically in `.github/workflows/ci.yml` with service containers. Integration tests with `continue-on-error: true` do not block merge but should still pass locally.

## 8. PR rules

| Rule | Detail |
|---|---|
| **Conventional commits** | `<type>(<scope>): <subject>` — types in use: `feat`, `fix`, `docs`, `test`, `ops`, `chore`, `refactor`. See `git log --oneline -20` for examples. |
| **Branch off `main`** | `git checkout -b claude/<purpose>` — never commit on `main` directly |
| **Never push without ask** | Owner authorizes each push explicitly |
| **Schema changes need `_up` + `_down`** | Migrations are reversible by default |
| **Tests stay green** | typecheck + lint + unit + integration must pass before requesting review |
| **Co-author trailer** | End commits with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` |
| **PR body trailer** | End PR descriptions with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` |

## 9. Out-of-scope for this file

- **Operational debug + rollback** — see [`docs/runbooks/`](docs/runbooks/)
- **Per-feature design specs** — see [`docs/superpowers/specs/`](docs/superpowers/specs/)
- **End-user docs** — not in this repo (this repo is the platform itself, not its end-user surface)

## 10. Verification

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
| Re-verify when | This stamp is older than 30 days, or `package.json` scripts change. |

To re-verify: read `package.json` (commands), `git log -25 origin/main` (recent work), `gh pr list --state open` (in-flight), and the source files referenced in §4 and §6.
