# Maia-v2 — Spec de correções dos follow-ups da auditoria

> Resolve as 8 issues abertas que sobraram após a PR #38 (auditoria principal).
> Pacote executável; cada seção é auto-contida — entregável a um subagent.
> Branch: `claude/audit-followups` (derivada de `claude/condescending-fermi-d5d63d`).

## Convenções

- Mudanças mínimas para resolver o ponto.
- Specs novos têm que rodar (`npx vitest run <file>`).
- Não invente abstrações.
- 1 commit por issue.
- #36 (deploy manual no Coolify) é trabalho do dono — fora desta spec.

---

## Wave 1 — Isolada e segura (paralelo)

### Issue #14 — Verificar 3 typecheck errors stale

**Hipótese:** os 3 erros (`db/client.ts:24`, `gateway/queue.ts:31`, `lib/alerts.ts:32`) já foram corrigidos em PRs anteriores. `npx tsc --noEmit` passa em main.

**Ação:**
1. Confirmar com `git checkout main && npx tsc --noEmit`. Se passar limpo: comentar na issue dizendo "verified resolved on main as of <commit>" e pedir fechamento.
2. Se algum dos 3 ainda falhar: aplicar fix mínimo descrito na issue.

**Aceite:** issue comentada com link e proposta de fechamento, OU PR pequena fixando o que sobrou.

---

### Issue #34 — Limpar 8 lint warnings

**Arquivos** (do output do `npm run lint`):
- `src/db/schema.ts:11,13` — imports `primaryKey`, `dirname` não usados
- `src/tools/register-transaction.ts:2,89` — import `contrapartesRepo` não usado, `let contraparte_id` → `const`
- `tests/unit/openrouter-converters.spec.ts:135` — `fromOpenAIResponse` não usado
- `tests/unit/registry-pdf-flag.spec.ts:1` — import `beforeEach` não usado
- `tests/unit/utils.spec.ts:2` — import `canonicalize` não usado
- algum `eslint-disable` morto em `src/agent/dashboard/index.ts` ou similar (verificar)

**Mudanças:**
1. Remover imports não usados (confirmar com `npx tsc --noEmit` que não eram usados implicitamente).
2. `let contraparte_id` → `const contraparte_id` em `register-transaction.ts:89` (auto-fixable, mas manualmente para revisar).
3. Remover `eslint-disable` morto.

**Aceite:** `npm run lint` retorna `0 errors, 0 warnings`.

---

### Issue #22 — Isolar mocks de Redis nos testes Baileys

**Sintoma:** `tests/unit/baileys-handle-incoming.spec.ts`, `baileys-send-document.spec.ts`, `baileys-view-once.spec.ts` passam, mas emitem `ECONNREFUSED ::1:6379` no stderr.

**Investigação:**
1. Identificar via `git grep` qual import dentro desses testes carrega ioredis real (provavelmente cadeia: `gateway/baileys.ts → lib/redis.ts → ioredis.connect`).
2. Cada teste deve `vi.mock('@/lib/redis.js', () => ({ redis: ..., isRedisConnected: () => false }))` no topo OU usar um helper compartilhado em `tests/setup.ts` que faça o mock global apenas para `unit/`.

**Mudança preferida:** mock no nível do spec (não global) para não esconder leaks em outros testes.

**Aceite:** rodar `npx vitest run tests/unit/baileys-handle-incoming.spec.ts tests/unit/baileys-send-document.spec.ts tests/unit/baileys-view-once.spec.ts 2>&1 | grep -i ECONNREFUSED` não retorna nada.

---

### Issue #31 — Gauge `maia_db_connected` no Prometheus

**Arquivos:**
- `src/db/client.ts` — adicionar `isDbConnected(): boolean` baseado em ping cacheado de 5s
- `src/server.ts` — registrar `setGaugeProvider('maia_db_connected', () => isDbConnected() ? 1 : 0)`

**Implementação:** estado interno `let cachedDbHealthy = false` + ping `SELECT 1` a cada 5s via `setInterval` registrado no boot do `client.ts`. Idle quando ninguém pergunta.

**Aceite:** `curl :3000/metrics | grep maia_db_connected` retorna 0 ou 1; gauge cai a 0 ≤ 10s após DB cair (timer + cache).

---

## Wave 2 — Mudanças funcionais (paralelo, mas mesmo subagent para cost-ledger)

### Issue #30 — Backup S3/B2 após pg_dump

**Arquivos:**
- `package.json` — adicionar `@aws-sdk/client-s3@^3` (~500kb gz, suporta endpoint custom para B2/R2/Wasabi)
- `src/config/env.ts` — adicionar `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_S3_REGION` (todos opcionais), e `BACKUP_RETENTION_CLOUD_DAYS` (default 30)
- `src/workers/backup.ts:65-68` — após `pg_dump` ok e antes do audit `backup_completed`:
  - Se `BACKUP_S3_BUCKET` set: upload `s3://${bucket}/maia/${tsName()}.dump`
  - Em sucesso: audit inclui `s3_url`
  - Em falha de upload: audit `backup_completed` (local OK) + audit separado `backup_s3_upload_failed` (não bloqueia)
- `src/workers/backup-rotate.ts` (novo) — cron semanal: lista bucket, deleta dumps > `BACKUP_RETENTION_CLOUD_DAYS`
- `src/workers/index.ts` — registrar `backup-rotate`
- `src/governance/audit-actions.ts` — adicionar `backup_s3_upload_failed`
- `tests/unit/backup-s3-upload.spec.ts` (novo) — mock `@aws-sdk/client-s3`, cobrir upload OK / upload falha (audit emit) / sem bucket configurado (skip silencioso)
- `scripts/restore-test.ts` — flag opcional `--from-s3=<key>` que baixa do bucket antes do restore

**Aceite:** specs novos passam; com `BACKUP_S3_BUCKET=foo BACKUP_S3_ACCESS_KEY=mock` e mock de upload, audit `backup_completed` traz `s3_url`.

---

### Issue #32 + #35 — Cost-ledger: pricing dinâmico + per-pessoa

**Arquivos:**
- `src/lib/openrouter-pricing.ts` (novo) — `getModelPricing(slug: string): Promise<{ input: number; output: number } | null>` lendo do cache existente em `openrouter-models.ts`. Retorna preço em USD/cents per 1k tokens. Fallback `null` se modelo não encontrado.
- `src/lib/cost-ledger.ts:`
  - Função `rateFor(provider, model): Promise<{ input: number; output: number }>` que tenta dinâmico (se model contém `/` → OpenRouter slug → `getModelPricing`), depois cai pra hardcoded local, depois pro fallback genérico.
  - `recordLLMCost` aceita novo param opcional `pessoa_id?: string`.
  - Quando `pessoa_id` set: além do `cost.daily.llm.${day}` global, escreve também `cost.daily.llm.${day}.${pessoa_id}` no escopo `pessoa`.
- Callers: `src/lib/claude.ts` (e qualquer outro caller de `recordLLMCost`) — passar `pessoa_id` quando disponível. `runAgentForMensagem` tem `pessoa.id` em escopo; resto (briefings, reflection) fica só no global.
- `src/dashboard/index.ts` — nova rota `/dashboard/cost-by-pessoa` ou tab nova listando pessoas + tokens + USD do dia (puxa fatos `cost.daily.llm.${day}.*`).
- Tests:
  - `tests/unit/openrouter-pricing.spec.ts` (novo) — slug conhecido, slug local Claude, fallback genérico.
  - `tests/unit/cost-ledger.spec.ts` (novo ou estender existente) — round-trip de `recordLLMCost({ pessoa_id, ... })` produz 2 entries (global + pessoa).

**Aceite:** specs verdes; `cost-monitor.ts` continua funcionando inalterado (lê apenas global); dashboard mostra split por pessoa.

---

## Wave 3 — Type-aware lint (depois que tudo estabilizar)

### Issue #33 — Habilitar `@typescript-eslint/no-floating-promises`

**Arquivo:** `eslint.config.js`

**Mudança no bloco para `src/`, `scripts/`, `tests/`:**
```js
languageOptions: {
  parser: tsParser,
  parserOptions: {
    projectService: true,
    tsconfigRootDir: import.meta.dirname,
  },
},
rules: {
  // ... existing
  '@typescript-eslint/no-floating-promises': 'warn',
},
```

**Procedimento:**
1. Ativar regra como `warn`.
2. Rodar `npm run lint` → contar warnings.
3. Fixar críticos (handlers de queue, gateways, workers cron) — adicionar `await` ou `void` explícito.
4. Não-críticos (specs, scripts utilitários) podem ficar como warn por enquanto.
5. Documentar em `docs/eslint-floating-promises-pending.md` (se ainda houver warnings) ou em comentário no PR.

**Aceite:** `npm run lint` passa em CI (warnings OK); tempo < 30s; documenta as N warnings restantes (se houver).

**Cuidado:** `projectService: true` pode quebrar config se ESLint v9 plus typescript-eslint não suportar. Se quebrar, voltar pra `project: './tsconfig.json'` (mais lento mas compatível).

---

## Verificação final

```bash
npm run typecheck
npm run lint
npm test
npm run build && test -f dist/index.js
```

Cada wave = 1 commit (ou 1 commit por issue, conforme couber).

PR única contra `main`, esperando #38 mergear primeiro (rebase se necessário).
