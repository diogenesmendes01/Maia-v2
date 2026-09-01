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
| Runtime | Node 22+ (`.nvmrc`, `package.json` engines e imagens Docker na mesma linha), TypeScript 5+, ESM |
| Server | Fastify (`src/server.ts`) |
| DB | PostgreSQL 16 + pgvector via Drizzle ORM |
| Cache / Queue | Redis + BullMQ (`ioredis`) |
| Channel | WhatsApp via Baileys; multi-channel schema present |
| LLM | Anthropic Claude (Sonnet 4.6 + Haiku 4.5); OpenAI Whisper (audio); Claude Vision (images) |
| Admin UI | Next.js 16 + React 19 + tRPC + NextAuth (`src/admin-ui/`) |
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
| Capability taxonomy (roles · skills · tools · packs · policies) | [`concerns/capability-taxonomy.md`](docs/architecture/concerns/capability-taxonomy.md) |
| Data retention, legal hold, tombstones (**DRAFT — pending DPO**) | [`concerns/data-retention-matrix.md`](docs/architecture/concerns/data-retention-matrix.md) |

### Subsystems (one module doc per `src/` subdir)

24 subdirectories in [`src/`](src/), one doc each under [`docs/architecture/modules/`](docs/architecture/modules/). See the **Code map** in [`ARCHITECTURE.md`](ARCHITECTURE.md#5-code-map) for the table.

### Other documentation

| What | Where |
|---|---|
| Configuração (contrato de env vars, profiles, comandos) | [`docs/configuration.md`](docs/configuration.md) — **gerado** por `npm run config:generate` |
| Boot falhando por config, e o rollback | [`docs/runbooks/config-contract.md`](docs/runbooks/config-contract.md) |
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
| 1 | **Every stateful boundary scopes by `tenant_id + agent_id`** | DB queries, Redis keys, cache keys, ALS context. See [`concerns/tenant-isolation.md`](docs/architecture/concerns/tenant-isolation.md). **One bounded exception:** health of a *shared external dependency* is `system` operational state, not tenant state — see [`concerns/tenant-isolation.md` §1.1](docs/architecture/concerns/tenant-isolation.md#11-the-one-bounded-exception-system-operational-state) and [ADR 0002](docs/architecture/decisions/0002-external-dependency-health-is-system-state.md). It has four required conditions and a closed membership list; joining it needs an ADR, not a code comment. |
| 2 | **Fail-closed in security** | Missing `tenant_id`/`agent_id` → reject. Unmatched policy → reject. Unresolved channel → reject. Never fall back to `'default'` in production paths. |
| 3 | **Backend decides, LLM proposes** | LLM emits typed intents (Zod). Backend validates against state + rules. Backend executes (or denies). See [`concerns/action-layer.md`](docs/architecture/concerns/action-layer.md). |
| 4 | **Audit every decision** | Side-effect or governance decision → `audit()` row in `audit_logs` with action label and tenant context. |
| 5 | **Confidence is computed (self-model) / gated (routing)** | **Self-model & governance confidence** comes from deterministic formulas over evidence counts — the LLM never declares it. **Decision-engine *routing* confidence** (intent / pending-gate / procedure-selector) MAY be LLM-proposed, but a backend threshold always decides ("LLM proposes, backend decides"). Canonical: [`docs/ai/maia-invariants-checklist.md` § Deterministic Confidence](docs/ai/maia-invariants-checklist.md#deterministic-confidence). See `src/agent/pending-gate.ts:277` (`resolution.confidence >= CONFIDENCE_THRESHOLD`), `src/cognition/procedure-selector.ts:109` (`top.confidence < threshold`), `src/runtime/decision/intent-classifier.ts:126` (`confidence: haiku.confidence`). |
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
npm run test:leak                 # cross-tenant leak suite (critical, run before any tenant-related change)

# Static checks (run before every commit)
npm run check:node                # guard de versão do Node (.mjs puro, roda com `node` direto — o mesmo que o `preinstall` dispara)
npm run docs:ai:check             # AI engineering docs governance
npm run config:check:drift        # config contract: generated artifacts up to date? (#515)
npm run typecheck                 # tsc --noEmit
npm run lint                      # eslint src tests scripts
npm run format                    # prettier --write src
npm run audit:exceptions:check    # todo advisory do npm audit está corrigido ou tem exceção com dono e prazo? (#526)

# Configuração (contrato único — src/config/contract.ts)
npm run config:generate           # regenera .env.example, docs/configuration.md, schema, manifest, fixtures
npm run config:check -- --profile production --env-file .env
npm run config:init -- --profile development
npm run config:preflight          # ambiente EFETIVO de cada serviço do compose
                                  # (env_file + environment: interpolado),
                                  # validado ANTES do `up` (#572)

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
npm run test:admin-ui:e2e         # Playwright, projeto `smoke` (exige console no ar)
npm run test:admin-ui:e2e:ci      # semeia as fixtures das jornadas, monta o artefato
                                  # standalone (o mesmo do Dockerfile), sobe DOIS
                                  # processos — `node src/admin-ui/server.js` e um
                                  # runtime `scheduler`/grupo `channel` com adapter de
                                  # canal FALSO —, roda o smoke e derruba. Exige
                                  # MAIA_STAGING_KEYRING (efêmero) nos dois.
npm run test:admin-ui:e2e:pendentes  # quarentena (#623): hoje VAZIA — 0 testes. O
                                  # projeto continua armado para o dia em que algo
                                  # precise voltar para lá, num diff visível.

# Operational
npm run doctor                    # diagnóstico READ-ONLY do ambiente (#517) — offline por default
npm run doctor -- --online        # + liveness de Postgres/Redis; --format json, --strict, --only
npm run dlq                       # dead-letter queue inspection
npm run embeddings:rebuild        # regenerate vector embeddings
                                  # exige --tenant e --agent (#239)

# Importação de extrato (OFX/CSV) — escopo DECLARADO e VERIFICADO (#720).
# `--tenant` e `--agent` são OBRIGATÓRIOS e não têm default: ausentes → exit 2.
# A conta e a pessoa são resolvidas DENTRO do escopo declarado; se não
# pertencerem a ele, a CLI recusa (exit 3) sem escrever nada. Runs de outro
# escopo não são visíveis nem aplicáveis. Ver o cabeçalho de
# `scripts/import-ofx.ts` para a decisão de desenho por trás disso.
npm run import:ofx   -- --tenant=<id> --agent=<id> --pessoa=<id|apelido> \
                        --conta=<id|apelido> --file=extrato.ofx
npm run import:list  -- --tenant=<id> --agent=<id>
npm run import:show  -- --tenant=<id> --agent=<id> --run=<id>
npm run import:apply -- --tenant=<id> --agent=<id> --run=<id> \
                        [--candidates=accept|reject]

npm run backup                    # DB backup
```

## 7. Integration test setup

`npm run test:integration` requires real Postgres + Redis:

```bash
npm run test:integration:setup    # sobe a pilha COMPARTILHADA (idempotente)
npm run test:integration          # cria/migra o banco da worktree e roda
# O teardown apaga o Postgres e o Redis de TODAS as árvores — inclusive das
# que estão rodando agora. Ele recusa sem consentimento explícito:
TEST_INFRA_TEARDOWN=yes npm run test:integration:teardown
```

**A infra física é COMPARTILHADA por decisão registrada** (modelo (a): um
Postgres, um Redis, um coordenador — `scripts/test-infra.ts`). O que isola sua
árvore não é o container: é o banco e o db lógico do Redis por worktree. Nunca
derrube a pilha para "limpar" a sua rodada — o que limpa a sua rodada é o
`globalSetup`, que já cria o seu banco e limpa o SEU db do Redis.

**Você está numa `git worktree`? Então seu Postgres e seu Redis já são só
seus** (issue #571): banco `<base>_wt_<pasta>_<hash>` criado e migrado
automaticamente, `schema_migrations` dentro dele, e um db lógico do Redis
exclusivo. Não exporte `TEST_DB_URL` à mão — se você exportar, ela é reescrita
para o banco da SUA árvore. O contrato inteiro (como descobrir qual é o seu, o
teto de 15 worktrees ativas imposto pelos 16 dbs do Redis, e como desligar)
está num lugar só: [README § Isolamento por worktree](README.md#isolamento-por-worktree-issue-571).

CI runs these automatically in `.github/workflows/ci.yml` with service containers. The integration job is blocking: integration + e2e failures fail the run.

**Sem `TEST_DB_URL`, as specs de integração fazem `describe.skip` em silêncio.** Nunca reporte "0 falhas" a partir de uma rodada sem banco — reporte quantos testes **executaram** e quantos ficaram `skipped`. O bloco de diagnóstico impresso no fim de toda rodada (§7.1) traz os três números.

### 7.1 Lendo o vermelho — orçamento de tempo e corpo órfão (#545)

O `await import()` do grafo de módulos de produção custa de 1.9s a 6.8s (medido: `@/gateway/baileys.js` 5.77–6.83s, `@/agent/core.js` 6.38–6.60s, `@/db/repositories.js` 1.92–2.47s). Isso é **infraestrutura**, não o teste — o trabalho real desses casos fica entre 1ms e 43ms. Três consequências que todo agente precisa saber:

| Fato | O que fazer com ele |
|---|---|
| `testTimeout` é **20000ms** e `hookTimeout` é **20000ms** (`vitest.config.ts`, com a medição no comentário). | Não abaixe sem medir. Não suba "por precaução": o prazo largo já cega regressão de desempenho abaixo de 20s, e o que devolve essa visibilidade é a lista de mais lentos, não o prazo. |
| **O timeout do vitest NÃO aborta o corpo async.** A tentativa estourada continua rodando e disputa mocks, linhas no banco e estado de módulo com o que vier depois. | Num arquivo com prazo estourado, a segunda mensagem de erro é quase sempre consequência (`expected "vi.fn()" to be called 1 times, but got 2 times`, `duplicate key ...`). **Leia o prazo primeiro.** O bloco `PRAZOS ESTOURADOS` do reporter existe para isso. |
| Spec nova que carrega grafo de produção deve carregá-lo em `beforeAll`, não no `it()`. | Use `moduloDeProducao()` de [`tests/helpers/modulo-de-producao.ts`](tests/helpers/modulo-de-producao.ts). Um `beforeAll` que estoura reprova o arquivo **sem executar os casos** e **sem retentar o corpo do teste** — some a segunda tentativa, que é de onde vinha a mensagem secundária. O que o hook **não** faz é cancelar o `import()`: ele continua até o fim e, se o módulo tiver efeito de topo (singleton, conexão, timer), esse efeito ainda aterrissa depois da reprovação. Exceção: quando a spec recarrega o módulo por caso (`vi.resetModules()` / `vi.doMock()` variando), o import é parte do teste e fica no corpo. |

Toda rodada termina com um bloco `RESUMO DE DIAGNÓSTICO DOS TESTES` ([`tests/reporters/diagnostico-reporter.ts`](tests/reporters/diagnostico-reporter.ts)): executados/falharam/pulados, prazos estourados (inclusive os que a rodada absorveu e ficou verde), os mais lentos e as falhas com a mensagem de **cada tentativa**. Com `VITEST_SUMMARY_FILE` setado ele grava o mesmo bloco em arquivo — é assim que o CI o reimprime num passo próprio, fora do dump dos service containers.

## 8. PR rules

| Rule | Detail |
|---|---|
| **Conventional commits** | `<type>(<scope>): <subject>` — types in use: `feat`, `fix`, `docs`, `test`, `ops`, `chore`, `refactor`. See `git log --oneline -20` for examples. |
| **Branch off `main`** | `git checkout -b claude/<purpose>` — never commit on `main` directly |
| **Never push without ask** | Owner authorizes each push explicitly |
| **Schema changes need `_up` + `_down`** | Migrations are reversible by default |
| **Tests stay green** | typecheck + lint + unit + integration must pass before requesting review |
| **PR body sections** | Non-bot PR bodies MUST carry the 8 `##` sections + the `Residual risk:` field — see [PR body](#pr-body) below. Enforced in CI by [`scripts/check-pr-body.ts`](scripts/check-pr-body.ts) (blocking). |
| **Não inventar coautoria** | Só acrescente `Co-Authored-By:` quando a identidade e o e-mail do coautor estiverem **verificados**. Assistência de IA vai em `Task Context` ou `Reviewer Notes` da PR, não num trailer com identidade fabricada — ver [Coautoria](#coautoria) |
| **PR body trailer** | End PR descriptions with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` |

### Coautoria

A regra anterior mandava encerrar todo commit com
`Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`. Ela foi removida por
duas razões independentes, e a segunda é a que importa.

**Envelhece.** Um nome de modelo fixo no manual fica obsoleto na versão
seguinte, e ninguém volta para atualizá-lo. O trailer passa a atribuir trabalho
a um modelo que não o fez.

**Um trailer `Co-Authored-By:` é uma afirmação verificável.** Ele entra no
histórico do git e é lido por ferramentas como atribuição de autoria real, com
e-mail. Preenchê-lo com uma identidade que ninguém pode verificar não é
formalidade: é registrar no histórico uma coautoria que não existe. Trocar o
nome do modelo por outro — ou por um endereço inventado de qualquer assistente —
não conserta isso, só muda a fabricação.

Então:

- **Coautor humano, identidade e e-mail conhecidos** → `Co-Authored-By:` normal.
- **Assistência de IA** → registre em `Task Context` ou `Reviewer Notes` da PR,
  onde o contexto cabe e ninguém confunde com autoria verificada. O rodapé
  automático da PR já sinaliza a ferramenta.
- **Na dúvida** → não escreva o trailer. Ausência é honesta; identidade
  fabricada não.

### PR body

The CI step **PR body governance** ([`scripts/check-pr-body.ts`](scripts/check-pr-body.ts), wired as `npm run pr:body:check`) runs inside the blocking `typecheck + test + lint + build` job, *before* the typecheck step. If a non-bot PR body is missing any required heading or field, the **whole job fails** — typecheck, build, and tests never run. [`scripts/check-pr-body.ts`](scripts/check-pr-body.ts) is the source of truth; the list below mirrors it.

**Required headings** (exact text, level-2 `##`):

`## Summary` · `## Task Context` · `## Scope` · `## Maia Invariants` · `## Validation` · `## Docs Impact` · `## Risk and Rollback` · `## Reviewer Notes`

**Required field:** a visible line starting with `Residual risk:` (or `- Residual risk:`), conventionally placed under `## Risk and Rollback`.

How the checker reads the body:

- Headings inside fenced code blocks and `<!-- … -->` comments are ignored — only visible level-2 headings count, so the template's helper comments are fine.
- **Bot-authored PRs are skipped** (`user.type === "Bot"` or login ending in `[bot]`). PRs opened under a human account are checked — always include every section.
- `gh pr create --body "…"` does **not** apply the GitHub template, so build the body yourself from the skeleton below. The GitHub web UI pre-fills the same sections from [`.github/pull_request_template.md`](.github/pull_request_template.md) — the full annotated version, with the invariant and validation checklists.

Copyable skeleton — the minimum that passes the check; fill each section in (use [`.github/pull_request_template.md`](.github/pull_request_template.md) for the full checklists):

```markdown
## Summary

What changed and why, in 1–3 lines.

## Task Context

- Task spec / issue:
- Agent role:
- Context read:

## Scope

Files changed:
-

In scope / Out of scope:
-

## Maia Invariants

- [ ] Tenant/agent isolation considered
- [ ] Fail-closed behavior considered
- [ ] Backend decides, LLM proposes
- [ ] Audit/observability impact considered
- [ ] Not applicable; why:

## Validation

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- Skipped checks and reason:

## Docs Impact

- [ ] Docs not needed; reason:

## Risk and Rollback

Risk:
-

Residual risk:
-

Rollback:
-

## Reviewer Notes

-

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

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
