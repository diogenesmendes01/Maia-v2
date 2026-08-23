# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

### ⚠️ BREAKING (operacional) — o console valida o subset `admin-ui` no boot, e o `.env.admin` encolhe ([#596](https://github.com/diogenesmendes01/Maia-v2/issues/596))

> **Um `.env.admin` que sobe hoje pode recusar o boot depois deste release** — e é esse o ponto. Rode `npm run config:preflight` antes do `up`.

1. **O boot do `admin-ui` passou a avaliar o subset `admin-ui` do contrato**, em `src/admin-ui/instrumentation.ts` — o hook que o Next.js aguarda em `BaseServer.prepare()`, antes do primeiro request. Um erro ali impede o container de servir.

   | Condição | Antes | Agora |
   |---|---|---|
   | As quatro `OIDC_*` ausentes em `staging`/`production` | **sobe** e entrega a tela "no providers configured" | **não sobe** (`profile/required`) |
   | `OIDC_TENANT_SLUGS=default` (o slug É o `tenant_id`) | sobe | **não sobe** (`admin-ui/tenant-slugs-default-literal`) |
   | `NEXTAUTH_SECRET` fraco / placeholder | lançava no PRIMEIRO REQUEST | **não sobe** |
   | Chave exclusivamente `runtime` ausente (as seis `BACKUP_*`, `WHATSAPP_*`, `OWNER_*`, chave de LLM, `VOYAGE_API_KEY`) | **não subia** | sobe — o console não as usa |

   O `next build` **não** passa pelo hook (o Next pula instrumentation em `phase-production-build`), então a imagem continua construível sem `.env.admin`.

2. **`.env.admin.prod.example` perdeu o bloco `BACKUP_*` e o bloco "exigidas transitivamente".** A orientação anterior — pôr no `.env.admin` uma credencial S3 separada e sem permissão, e keyring fictício mas válido — **não vale mais**: aquelas variáveis não vão mais para o container do console. Se o seu `.env.admin` as tem, remova-as: elas só aumentam o raio de explosão de um vazamento.

   `RUNTIME_TRACE_HMAC_MASTER_SECRET` **fica**, e agora por direito: o console verifica a integridade dos envelopes de trace, então as três `RUNTIME_TRACE_HMAC_*` passaram a declarar `services: ['runtime', 'admin-ui']` no contrato. Sem ela, o explorador de traces mostraria tudo como "não verificável".

3. **Causa raiz desfeita, e não contornada.** O console importava `src/config/env.ts` — direto em `src/admin-ui/trpc/tool-enablement.ts` e `src/admin-ui/trpc/routers/tools-catalog.ts`, e transitivamente por `@/db/client.ts` — e aquele singleton valida `service: 'runtime'` no import. Os sete módulos **compartilhados** pelos dois containers (`db/client.ts`, `lib/logger.ts`, `lib/llm-settings.ts`, `governance/idempotency.ts`, `control-plane/runtime-trace/lib/hmac.ts`, `gateway/staging-crypto.ts`, `config/feature-flags.ts`) passaram a ler o contrato por `src/config/contract-env.ts` — uma variável por vez, no acesso, com o mesmo schema. `tests/unit/config/admin-import-boundary.spec.ts` reprova se algum caminho de import do console voltar a alcançar o singleton.

   O boot fail-closed do **runtime** não mudou: sete scripts que alcançavam `@/config/env.js` de carona (`import-ofx`, `import-review`, `seed-holidays`, `seed-proposals-fixtures`, `activate-synthetic-probe`, `backfill-agent-turns`, `p8d-migration-priorities`) ganharam o import explícito, e o mesmo teste fixa por nome o conjunto de entrypoints que o alcançam.

4. **`COMPOSE_SERVICE_CONTRACT['admin-ui']` voltou a ser `['admin-ui']`.** `npm run config:preflight` continua sendo o gate que mede os ARQUIVOS antes de existir container; ele deixou de ser a ÚNICA checagem daquele subset.


### ⚠️ BREAKING (operacional) — `/readyz` passa a gatear no veredito canônico de schema ([#516](https://github.com/diogenesmendes01/Maia-v2/issues/516))

> **Duas mudanças que podem tirar instâncias de rotação (ou recusar o boot) num ambiente que sobe hoje.** Rode `tsx scripts/migrate.ts status` contra cada banco **antes** de deployar: se ele não imprimir `readiness: ready`, o `/readyz` do release novo responderá 503. Runbook: [`docs/runbooks/operational.md`](docs/runbooks/operational.md) §8.1.

1. **O componente `schema` do `/readyz` agora é `getSchemaReadiness()`** (`src/migrations/readiness.ts`), não mais a comparação "id mais novo do ledger × arquivo mais novo em disco" (`checkSchemaVersion()`). Passam a responder **503** condições que antes davam 200:

   | Condição | Antes | Agora |
   |---|---|---|
   | Linha `dirty` no ledger | 200 | **503** (`dirty_migration`) |
   | Checksum do artefato ≠ do ledger | 200 | **503** (`checksum_mismatch`) |
   | Migration aplicada sem checksum registrado (ledger v1) | 200 | **503** (`checksum_unknown`) |
   | Ledger cita migration que o build não empacota | 200 | **503** (`missing_file`) |
   | Migration `running` (migrator em voo ou morto) | 200 | **503** (`running_migration`) |
   | Banco à frente do artefato | 200 (explicitamente `ok`) | 503 só se o build declarar `max_supported_migration` |
   | Head esperado não aplicado | 503 | **503** (`schema_below_minimum`) |
   | Banco fora / ledger ausente / `migrations/` ilegível | 503 | **503** (`unknown`, fail-closed) |

   **Ordem de deploy:** o migrator precisa rodar **antes** da aplicação. Um banco com ledger v1 mantém o `/readyz` em 503 com `checksum_unknown` até `npm run db:migrate` adotar os checksums empacotados.

   O veredito é cacheado por **10 s** e chamadas concorrentes são coalescidas, então o custo é ~uma avaliação por 10 s por réplica, independente da frequência do load balancer. Atenção ao número que importa em incidente: o `/readyz` também passa pelo cache composto de `READINESS_CACHE_MS` (2 s no default), então um 200 obsoleto pode sobreviver por `SCHEMA_READINESS_TTL_MS + READINESS_CACHE_MS` — **12 s nos defaults**, e mais se o `READINESS_CACHE_MS` subir.

2. **`READINESS_SCHEMA_CHECK=false` passa a ser inválido no profile `production` e recusa o boot** (regra `lifecycle/schema-check-disabled`, severidade `error`, escopo `boot` — vale inclusive sob `MAIA_CONFIG_STRICT_BOOT=false`). Em `staging` continua permitido, com aviso; em `development`, silencioso. Antes era aviso em todos os profiles fora de `development`.

   **Ação:** remova `READINESS_SCHEMA_CHECK=false` do `.env` de produção (o default é `true`).

O passo de **boot** (`src/index.ts`, etapa `schema`) continua usando `checkSchemaVersion()` de propósito — unificá-lo com o veredito estrito transformaria toda condição que hoje produz uma instância diagnosticável fora de rotação num crash loop, e isso é decisão de política ainda aberta na #516.

### ⚠️ BREAKING (operacional) — o boot passa a falhar fechado por configuração ([#515](https://github.com/diogenesmendes01/Maia-v2/issues/515))

> **Um ambiente que sobe hoje pode parar de subir no primeiro release que contiver esta mudança.** Rode `npm run config:check -- --profile production --env-file .env` contra o `.env` de cada ambiente **antes** de deployar. Runbook completo: [`docs/runbooks/config-contract.md`](docs/runbooks/config-contract.md).

O boot agora valida o contrato inteiro e **aborta em TODOS os profiles — `development` incluído**. Antes, só as regras legadas de boot eram aplicadas e o resto ficava no `maia config check`.

> **Abortar em `development` é decisão deliberada do owner, não descuido.** O rollout descrito na issue #515 (passo 6) previa *aviso* em `development` e erro só em staging/produção. Durante a review da [PR #522](https://github.com/diogenesmendes01/Maia-v2/pull/522) o owner decidiu explicitamente ligar o fail-closed em todos os profiles, ciente da divergência em relação ao texto da issue: um `.env` que sobe no laptop e morre em staging é justamente o drift que o contrato existe para eliminar. Quem for revisitar isso depois: o ponto de revert é único e está documentado no runbook §4.3.

Passam a abortar o boot:

| Situação | Regra | Antes |
|---|---|---|
| `FEATURE_MULTI_CHANNEL`, `FEATURE_COGNITIVE_GRAPH` ou `APROVAR_MENSAGENS_PROATIVAS` no ambiente | `contract/removed` | ignorado em silêncio |
| Qualquer `MAIA_*` / `FEATURE_*` / `BACKUP_*` … fora do contrato | `contract/unknown` | ignorado em silêncio |
| `MAIA_ENV` ausente em staging/produção | `profile/required` | não existia |
| `MAIA_ENV` contradizendo `NODE_ENV` | `profile/node-env-contradiction` | não existia |
| Placeholder (`__SET_ME__`, `sk-ant-...`) em staging/produção | `secret/placeholder` | não existia |
| Valor de fixture sintética de CI em staging/produção | `secret/synthetic-fixture` | não existia |
| Dependência condicional não satisfeita (ex.: `FEATURE_OUTBOUND_VOICE=true` sem `OPENAI_API_KEY`) | `contract/required-when` | não existia |

**Ações necessárias antes de deployar:**

1. **Adicione `MAIA_ENV=production`** (ou `staging`) — `NODE_ENV` nem consegue expressar `staging`.
2. **Remova as variáveis removidas** do `.env` de cada ambiente. O gate real de mensagens proativas é `FEATURE_PROACTIVE_MESSAGES`.
3. **Substitua qualquer `__SET_ME__` remanescente.**

**Rollback de emergência, env-only e sem redeploy:** `MAIA_CONFIG_STRICT_BOOT=false` volta ao loader anterior (schema Zod + regras de boot legadas, com as mensagens históricas preservadas) e desliga a validação de contrato inteira. O boot degradado loga um aviso alto a cada start; é alavanca para destravar um ambiente, não estado estável. Os loaders programáticos (`loadMigrationConfig`, `loadAdminConfig`, `loadBackupConfig`) têm a equivalente `validate: false`. Procedimento em [`docs/runbooks/config-contract.md`](docs/runbooks/config-contract.md) §4.

Namespaces de terceiros (`CLAUDE_*`, `ANTHROPIC_*`, `POSTGRES_*`, `REDIS_*`, `SMTP_*`, `NEXTAUTH_*`, `OPENAI_*`) **nunca** são recusados como desconhecidos — são populados por ferramentas e plataformas de hosting. As variáveis que a Maia possui nesses namespaces estão no contrato pelo nome.

### Added — Contrato único de configuração ([#515](https://github.com/diogenesmendes01/Maia-v2/issues/515))

**Impacto para operadores.** A configuração da Maia passa a ter uma fonte única de verdade tipada e **sem efeitos colaterais no import**: `src/config/contract.ts`. `.env.example`, `docs/configuration.md`, o JSON Schema, o manifest de variáveis por serviço e as fixtures por profile são **gerados** — não edite `.env.example` à mão; rode `npm run config:generate`. O CI falha se os artefatos estiverem desatualizados.

- **Profiles explícitos**: `MAIA_ENV=development|staging|production` decide quais regras são obrigatórias. `NODE_ENV` segue controlando apenas as otimizações da plataforma Node (e nem consegue expressar `staging`); a contradição entre os dois é erro. Em staging/produção `MAIA_ENV` é **obrigatória**.
- **Novos comandos**: `npm run config:generate`, `npm run config:check -- --profile production --env-file .env [--json] [--allow-placeholders] [--allow-fixtures]`, `npm run config:check:drift`, `npm run config:init -- --profile production`. O `check` reporta **todos** os problemas numa execução, com variável + regra + remediação, e **nunca** o valor de um segredo.
- **`config:init` gera um ponto de partida operacional, não uma fixture**: todo valor que pertence ao operador vem como `__SET_ME__` e a validação estrita **falha de propósito** até ser preenchido. As fixtures em `src/config/generated/fixtures/` provam que o contrato é satisfazível e têm valores previsíveis que não autenticam em nada — usá-las como `.env` é recusado fora de development (regra `secret/synthetic-fixture`); só o opt-in `--allow-fixtures` as aceita.
- **Configuração mínima por serviço**: `runtime`, `admin-ui`, `migrator`, `backup` e `maintenance` recebem apenas o subconjunto declarado. O migrator não recebe chave de LLM, sessão do WhatsApp nem credencial de S3.
- **Variáveis removidas viram erro explícito**: `FEATURE_MULTI_CHANNEL` (#411), `FEATURE_COGNITIVE_GRAPH` (#412), `FEATURE_CONTEXT_PACKET_V1(_KILL_SWITCH)` (#406) e `APROVAR_MENSAGENS_PROATIVAS` (sem consumidor) têm *tombstone*. Configurá-las é erro em staging/produção e aviso em development — nunca mais um no-op silencioso. **Ação necessária:** remova-as do `.env` dos ambientes reais.
- **Variáveis Maia desconhecidas** (prefixos `MAIA_`, `FEATURE_`, `BACKUP_`, `OUTBOX_`, …) são erro em staging/produção e aviso em development. Namespaces de plataforma (`POSTGRES_`, `REDIS_`, `SMTP_`, `NEXTAUTH_`, `OPENAI_`) ficam de fora da rejeição por injeção legítima de hosting.
- **Dependências condicionais são executáveis** (`requiredWhen`): o contrato declara a condição como dado (`equals`/`includes`/`truthy`/`present`/`anyOf`/`allOf`) e o validador a **executa** (regra `contract/required-when`); a frase da documentação é derivada da condição, então as duas não podem divergir. Fecha três lacunas reais: `FEATURE_OUTBOUND_VOICE=true` sem `OPENAI_API_KEY`, `RUNTIME_TRACE_DEBUG_S3_BUCKET` sem `RUNTIME_TRACE_DEBUG_AES_KEY` e `ALLOW_DEV_AUTH=true` sem `ADMIN_UI_DEV_LOGIN_TOKEN`.
- **Novas regras cross-field** (validador, ainda não no boot): provider de embeddings × modelo × dimensões, bucket S3 × credenciais, canal de alerta × transporte, `MAIA_MULTI_LINE` × modo de roteamento, `strict` × keyring de staging, dev auth proibido fora de development, https obrigatório fora de development, `OIDC_TENANT_SLUGS` sem o literal `default`, ordenação de janelas (debounce, SLO da sonda, backoff do outbox) e recusa de placeholders em staging/produção.
- **Variáveis que já eram lidas direto de `process.env` agora estão documentadas** no contrato: `MAIA_REJECT_DEFAULT_LITERAL`, `PROCEDURE_TTL_DAYS`, `REAPER_BATCH_SIZE`, `REAPER_GLOBAL_BUDGET`, `CONTRADICTION_OVERLAY_TTL_HOURS`, além das variáveis do Admin UI (`ADMIN_UI_PORT`, `NEXTAUTH_*`, `AUTH_TRUST_HOST`, `NEXT_PUBLIC_API_URL`, `OIDC_*`, `ALLOW_DEV_AUTH`, `ADMIN_UI_DEV_LOGIN_TOKEN`, `FEATURE_ADMIN_UI_*`).

### Changed — Configuração

- `src/config/env.ts` virou um **loader fino**: schema, defaults e regras cross-field vêm do contrato. O comportamento de boot é **idêntico** ao anterior (as mensagens das regras de escopo `boot` foram preservadas literalmente) — as regras novas ficam no `maia config check` até o passo de rollout dedicado.
- `src/admin-ui/lib/env.ts` deixou de manter um **segundo schema Zod** e passou a derivar do contrato (`objectSchemaForService('admin-ui')`). Admin e runtime não podem mais divergir na interpretação da mesma variável.
- `assertSafeAuthDir`/`isReservedRootEntry` migraram para `src/setup/auth-dir-path.ts` (puro, sem import de `config`); `src/setup/auth-dir.ts` os re-exporta — nenhum import site mudou.
- **Node 22 documentado onde já estava pinado**: README e `AGENTS.md` diziam Node 20+ enquanto `.nvmrc`, `package.json` engines e as imagens Docker usam 22. Teste de paridade em `tests/unit/config/parity.spec.ts`.
- **Lint gate**: `no-restricted-properties` recusa novas leituras de `process.env` fora de uma allow-list explícita em `eslint.config.js` (orçamento de migração, não isenção permanente).

### Changed — LLM Gateway governado ([#508](https://github.com/diogenesmendes01/Maia-v2/issues/508))
- **Fronteira única para chamadas de modelo.** Novo módulo `src/lib/llm/` centraliza seleção de provider/modelo, deadline, cancelamento, retry, fallback, orçamento, custo, métricas e correlação de trace. `src/lib/claude.ts` vira facade fino: `callLLM()` delega ao gateway e aceita `workload`/`tier`.
- **Nenhum módulo importa SDK de provider.** Os 13 call sites que instanciavam `@anthropic-ai/sdk` direto (risk gate, role selector, step evaluator, capability proposer, calendar detector, os 7 detectores de drift e a visão) foram migrados; regra ESLint `no-restricted-imports` bloqueia novos bypasses fora de `src/lib/llm/providers/**`, e o grep gate de auditoria passou a cobrir `executeLLM` além de `callLLM`.
- **Visão pelo mesmo caminho.** `src/lib/vision.ts` usa blocos de imagem provider-neutrais; o adapter OpenRouter converte para `image_url`/data URI. Antes, visão só funcionava com Anthropic.
- **OpenRouter deixa de exigir `ANTHROPIC_API_KEY`.** As checagens de chave nos módulos de cognição passaram a consultar o provider ativo (`isLLMConfigured()`).
- **Uma leitura de settings por chamada, cacheada.** `getCurrentMainModel` + `getCurrentFastModel` (duas operações sequenciais por chamada, a cada iteração do ReAct) viraram uma leitura conjunta com cache por `tenant_id + agent_id`, TTL curto e TTL de falha menor.
- **Uma única camada de retry.** Os adapters passam `maxRetries: 0` ao SDK; erro é classificado por *kind* e só transitório retenta; `Retry-After` é respeitado; cancelamento nunca é retentado. O deadline total é absoluto e não reinicia a cada tentativa — `CLAUDE_TIMEOUT_MS` ganhou consumidor no hot path como teto **por tentativa**.
- **Fallback deixa de ser silencioso.** É controlado por política de workload (`src/lib/llm/workloads.ts`) e registrado com origem, destino e razão.

### Added — Governança de custo e propagação de configuração ([#508](https://github.com/diogenesmendes01/Maia-v2/issues/508))
- **Quota diária por tenant+agent** (`LLM_DAILY_BUDGET_USD`, default `0` = desligada): imposta antes de qualquer requisição ao provider, com erro não retentável.
- **Invalidação distribuída do cache de modelos** via Redis pub/sub (`maia:llm:settings:invalidate`): trocar o modelo no Admin passa a valer em todas as réplicas imediatamente, com o TTL curto como rede de segurança.
- **Métricas novas**: `maia_llm_requests_total`, `maia_llm_request_duration_ms`, `maia_llm_attempts_total`, `maia_llm_fallback_total`, `maia_llm_timeouts_total`, `maia_llm_cancelled_total`, `maia_llm_settings_cache_total`, `maia_llm_scope_missing_total`, `maia_llm_cost_ledger_failures_total`, `maia_llm_budget_*`. `maia_llm_calls_total{status}` passou a incrementar também em erro/timeout/rate limit/cancelamento, como o runbook já documentava.

### Fixed — LLM ([#508](https://github.com/diogenesmendes01/Maia-v2/issues/508))
- `src/runtime/decision/prod-env.ts`: o HaikuClientAdapter criava um `AbortController`, encadeava o sinal do caller nele e nunca o passava adiante — cancelar a classificação não cancelava a requisição HTTP.
- Falha ao persistir o ledger de custo deixou de ser engolida (`.catch(() => undefined)`) e passou a emitir counter alertável.
- A seleção de provider deixou de ser congelada no carregamento do módulo.
- **Quota de LLM deixou de ser check-then-act** (review da PR #531): virou reserva atômica por `tenant_id + agent_id` antes de qualquer requisição ao provider, liquidada com o custo real depois. Antes, N chamadas simultâneas liam o mesmo gasto acumulado e passavam todas — a quota falhava exatamente no retry storm.
- **Erro de provider não propaga mais o corpo da resposta.** Um `400` costuma ecoar o input (que é conversa de cliente); truncar em 200 caracteres preservava justamente o começo do eco. A mensagem passa a ser montada só com `kind`, `status` e `request_id`, e `cause` foi removido do erro para não vazar por serializador de log.
- **Chamada sem contexto de tenant no ALS é rejeitada** (`missing_tenant_context`) em vez de executada sem quota. Trabalho genuinamente global declara `runWithSystemContext()`.
- **Deadline absoluto passou a ser derivado** de `LLM_TURN_DEADLINE_MS` quando o caller não declara um: a mecânica existia mas o campo era opcional e ninguém o passava, então na prática o gateway rodava sem teto agregado.
- **`response_invalid` deixou de ser letra morta**: um 200 sem conteúdo utilizável (ex.: `choices: []`) era registrado como `status="ok"` com resposta vazia.
- **Escopo de tenant em todas as métricas tenant-aware** — antes só `maia_llm_requests_total` o carregava.
- **`workload` é obrigatório** e o escape hatch `legacy` foi removido, com gate de CI provando que todo call site declara política.
- **Allow-list de `process.env` encolhida** (#515): a migração dos call sites de LLM removeu as leituras diretas de `ANTHROPIC_API_KEY` em `src/cognition/{calendar-pattern-detector,capability-proposer}.ts`, `src/cognition/drift/**`, `src/cognition/role-selector/llm-suggester.ts` e `src/shared/risk/llm-gate.ts` — as cinco entradas saíram do orçamento de migração em `eslint.config.js` e do espelho em `tests/unit/config/no-direct-env-reads.spec.ts`. A chave passa a entrar pelo `config` tipado num único ponto (`src/lib/llm/providers/**`).

### Fixed — Dependências e supply chain

- **`sharp` deixou de ser implícito, e os binários Linux-musl entraram no lockfile.** `sharp` chegava só como `peerDependency` não-opcional do Baileys (`@whiskeysockets/baileys` declara `"sharp": "*"`); o npm resolvia o pacote JS mas **não** as `optionalDependencies` `@img/sharp-*` dele — o `package-lock.json` da raiz tinha uma única entrada `@img/*` (`@img/colour`) e **nenhum** binário nativo. Como a imagem de produção é Alpine e usa `npm ci`, qualquer caminho de imagem quebrava lá; e quebrava em SILÊNCIO, porque o Baileys carrega a biblioteca com `import('sharp').catch(() => {})` (`lib/Utils/messages-media.js:19`) — sem binário, o thumbnail simplesmente não é gerado. Agora `sharp@^0.35.3` é dependência direta da raiz e o lockfile carrega as 28 entradas `@img/*`, incluindo `@img/sharp-linuxmusl-{x64,arm64}` e os `@img/sharp-libvips-linuxmusl-*` correspondentes. Sonda de runtime: `npm run sharp:smoke` (`scripts/sharp-smoke.ts`) — ela carrega o binário nativo esperado, não só `import('sharp')`, porque o sharp cai em `@img/sharp-wasm32` quando o binário falta e um `import` sozinho fica verde com produção rodando em WASM. Guard de regressão sem Docker: `tests/unit/sharp-lockfile-binaries.spec.ts`.
- **Dependabot passou a cobrir o `src/admin-ui`.** `.github/dependabot.yml` só declarava um bloco npm em `"/"`, e um bloco npm enxerga apenas o manifesto do próprio diretório — o admin-ui, que tem lockfile separado, nunca recebeu PR automática. É o mesmo ponto cego que deixou um `critical` do Next passar no `npm audit` ([#521](https://github.com/diogenesmendes01/Maia-v2/issues/521)) e que o ledger de exceções ([#526](https://github.com/diogenesmendes01/Maia-v2/issues/526)) tornou visível: com o ledger, o próximo advisory do admin-ui **reprova o CI**; sem Dependabot, esse CI reprovado ficaria esperando correção manual. O bloco novo espelha cadência, limite de PRs abertas e agrupamentos do bloco da raiz, com guard anti-drift em `tests/unit/dependabot-admin-ui.spec.ts`.

### Added — Plataforma de funcionários digitais (rodada 2026-06-10)
- **Fase 1 do blueprint** ([#467](https://github.com/diogenesmendes01/Maia-v2/pull/467)): diff de perfil antes de aprovar (#461), aba Atividade (#462), página `/audit` (#463), checklist de ativação (#465), console responsivo (#466), arquétipos no wizard e **rollback real** de `agent_operational_profile_versions` (#468).
- **Playground sandbox** ([#473](https://github.com/diogenesmendes01/Maia-v2/pull/473), #464): aba "Testar" — chat com o perfil ativo ou uma versão proposta, sem outbox/memória/aprendizado; migração 087; Postgres-as-queue + worker `playground_turn_drain`.
- **Packs de arquétipo** ([#474](https://github.com/diogenesmendes01/Maia-v2/pull/474), #470): função escolhida no wizard vira grant de packs (vendedor→`domain.sales` etc.) sobre `BASE_AGENT_PACKS`; `agents.getCapabilities` + card "Capacidades da função".
- **Work loop v1** ([#475](https://github.com/diogenesmendes01/Maia-v2/pull/475), #469): `agent_objectives`/`objective_tasks` (migração 088), registry de kinds, workers perceive/execute, fila de exceções com resolução auditada, aba "Objetivos".
- **Pedidos de ferramenta** ([#476](https://github.com/diogenesmendes01/Maia-v2/pull/476), #471 v1): lacunas `tipo='tool'` viram backlog com geração de issue pré-preenchida.
- **MCP externo v1** ([#480](https://github.com/diogenesmendes01/Maia-v2/pull/480), #478): servers MCP first-party (ERP) com governança completa — migração 089, cliente SDK, bridge no dispatcher, worker `mcp_sync`, tela `/setup/mcp`, flag `FEATURE_MCP_TOOLS` (default OFF).

### Fixed
- **Roteamento de canal para JID `@lid`**: eventos do WhatsApp que chegam como `XXX@lid` sem `senderPn`/`participantPn` deixavam de resolver e eram descartados como `channel_resolution_failed` (risco de perda de mensagem conforme o WhatsApp migra o endereçamento para LID). Agora `resolveScopeForJid` aceita um resolvedor LID→telefone injetado (a *signal LID mapping store* do Baileys, via `socket.signalRepository.lidMapping.getPNForLID`, com *feature-detection*) como terceiro fallback; o telefone recuperado também passa a alimentar a identidade (`tel`) em `handleIncoming`, mantendo roteamento e identidade consistentes. Quando nada resolve, o drop continua *fail-closed* mas é auditado como a ação dedicada `channel_resolution_skipped_lid_unmapped` (separando ruído de sync do WhatsApp de falhas reais de posse cross-tenant). Ver `src/gateway/jid-tenant-resolver.ts` e `src/gateway/baileys.ts`.

### Docs
- Specs versionadas: visão "funcionários digitais", playground, work loop e MCP (`docs/superpowers/specs/2026-06-10-*`); novo doc de módulo `objectives.md`.
- `docs/architecture/modules/gateway.md`: lista `jid-tenant-resolver.ts` e documenta a ordem de recuperação de `@lid`.

### Changed — Admin UI
- **Redesign visual completo da console** ([#460](https://github.com/diogenesmendes01/Maia-v2/pull/460)): camada visual reconstruída do zero sobre design system próprio (`src/admin-ui/components/ui/`) com navegação agent-first em pt-BR (sidebar + badge de aprovações pendentes). Nova experiência de agentes: hub `/agents` em cards, wizard de criação em 4 passos (`/agents/new`) e detalhe por agente com edição de perfil pré-preenchida e aprovação de versões (`/agents/[agentId]`); `/setup/agents` virou redirect. Tela de versões passou a expor o fluxo de rollback (auditado; `NOT_IMPLEMENTED` sinalizado na UI). Routers tRPC preservados como camada de dados.

### Added — Admin UI
- **`agents.getProfileVersions`** ([#460](https://github.com/diogenesmendes01/Maia-v2/pull/460)): procedure read-only que expõe a versão ativa + propostas do perfil operacional (com `profile_body`) para pré-preencher o editor de perfil.

## [3.1.0] - 2026-05-20 — "Hot-path wiring + governance functional"

This release closes the build-then-wire gap from v3.0.0: components that
were implemented in isolation now actually execute in production.

### Added — wiring
- **Context Packet (P8a) — wired to hot path** ([#151](https://github.com/diogenesmendes01/Maia-v2/pull/151)): `agent/core.ts` now builds and renders via `buildContextPacket` when `FEATURE_CONTEXT_PACKET_V1=true`, falling back to legacy on error.
- **Decision Engine (P9b) — wired to hot path** ([#152](https://github.com/diogenesmendes01/Maia-v2/pull/152)): `runDecisionEngineIfEnabled` invoked before every LLM call. Honors all 5 `decision_class` values + applies `tool_reductions`. `engine_error` is **fail-closed by default** (`FEATURE_DECISION_ENGINE_ERROR_FALLBACK=legacy` reverts to pre-P9b behavior).
- **Risk Scoring (P9c) — both callsites wired** ([#153](https://github.com/diogenesmendes01/Maia-v2/pull/153)): `RiskScorerStubImpl` and KSM stub replaced with real `TurnRiskScorer` + `KnowledgeRiskScorer` wrappers (no-downgrade invariant + gate fallback escalation active).

### Added — DecisionEngine real adapters (Camada 2/3)
- **Real deps inside `getDecisionEngine()`** ([#154](https://github.com/diogenesmendes01/Maia-v2/pull/154)): `PolicyDescriptorResolver`, `PolicyRulesRepo`, `PolicyDSLEvaluator`, `SkillsRepo` no longer stubbed.
- **`LockdownReader` real** ([#155](https://github.com/diogenesmendes01/Maia-v2/pull/155)): dual-layer enforcement — channel via `BaseContextPacket.channel.is_locked_down` + entity/permissao via `entity_states.flags['lockdown_snapshot']` + `permissoes.status='suspensa'`.
- **`procedure_domain` real** ([#156](https://github.com/diogenesmendes01/Maia-v2/pull/156)): migration `060_p3a_procedure_definitions_domain.sql` adds `domain TEXT` column; adapter performs JOIN; `WorkflowSelector` no longer falls back to TTL heuristic.
- **`ChannelPoliciesReader` real** ([#157](https://github.com/diogenesmendes01/Maia-v2/pull/157)): drizzle query on `channel_policies` with mandatory `tenant_id` predicate (cross-tenant isolation preserved).
- **`RiskScorerProdAdapter` (engine-internal)** ([#158](https://github.com/diogenesmendes01/Maia-v2/pull/158)): bridges DE's `{intent, base}` interface to P9c's `TurnRiskSignals` + maps 4-level `ScoredRisk` to 3-level `RiskLevel` (CRITICAL caps to HIGH + `requires_human_review=true`).
- **`active_sensitive_memory_count` field** ([#159](https://github.com/diogenesmendes01/Maia-v2/pull/159)): added to `BaseContextPacket`, populated by `buildBaseContextPacketFromTurn` (with agent-isolation preserved), consumed by `RiskScorerProdAdapter` for risk-floor calculation.

### Migrations
- `060_p3a_procedure_definitions_domain.sql` — `ALTER TABLE procedure_definitions ADD COLUMN domain TEXT` with CHECK allowlist (onboarding/support/transfer/cancel/unknown) + partial index.

### Production readiness
With this release, the following can be enabled together in production:
- `FEATURE_CONTEXT_PACKET_V1=true`
- `FEATURE_DECISION_ENGINE_V1=true` (default `FEATURE_DECISION_ENGINE_ERROR_FALLBACK=fail-closed`)
- `FEATURE_SOUL_LAYER_V1=true`
- `FEATURE_POLICY_RESOLVER_V1=true`
- `FEATURE_SKILL_REGISTRY_V1=true`
- `FEATURE_KNOWLEDGE_STATE_MACHINE_V1=true`
- `FEATURE_CALENDAR_V2=true`
- `FEATURE_RUNTIME_TRACE_V1=true` (requires `RUNTIME_TRACE_HMAC_MASTER_SECRET` + `RUNTIME_TRACE_DEBUG_S3_BUCKET` + `RUNTIME_TRACE_DEBUG_AES_KEY`)

### Known limitations
- Admin UI auth (P8.5) still returns `providers=[]` in production until OIDC/SAML/magic-link is wired. Setting `FEATURE_ADMIN_UI_V1=true` does not enable production login.

## [3.0.0] - 2026-05-20 — "Maia v3 Runtime Architecture"

Full Runtime Architecture v3.1.1 cutover: Hot Path stages, Context Packet,
Decision Engine, Policy DSL Evaluator, Skill Abstraction, Knowledge State Machine,
Runtime Trace, Soul Layer, User Layer namespace, Identity Completion,
Admin UI v1, Calendar v2, and all P0–P11 foundation phases.

### Added

#### P0–P7 Foundation Phases
- **P0 Foundation** ([#75](https://github.com/diogenesmendes01/Maia-v2/pull/75)) — multi-tenant isolation + cognitive logging + agent runtime bootstrap
- **P1 Reflection pipeline** ([#81](https://github.com/diogenesmendes01/Maia-v2/pull/81)) — trigger → candidate → classificador → typed destination (fact/rule/procedure/gap/tool_request/discard)
- **P2 Memory + Self-model** ([#82](https://github.com/diogenesmendes01/Maia-v2/pull/82)) — 5-layer scoped memory + 3-layer self-model (domain/skill/gap) with deterministic confidence formula
- **P3a Procedure Definitions** ([#83](https://github.com/diogenesmendes01/Maia-v2/pull/83)) — declarative procedure objects + Modo ENSINO
- **P3b Procedure Runtime** ([#84](https://github.com/diogenesmendes01/Maia-v2/pull/84)) — stateful execution engine with TTL + step audit
- **P3c Procedure Governance** ([#85](https://github.com/diogenesmendes01/Maia-v2/pull/85)) — matview + reaper + step evaluator + CHECK constraints
- **P4 Operational Identity** ([#86](https://github.com/diogenesmendes01/Maia-v2/pull/86)) — 4-layer identity model (core/operational/episodic/backlog) + drift detector (7 types × 4 severities)
- **P5 Dialogical Capability Acquisition** ([#87](https://github.com/diogenesmendes01/Maia-v2/pull/87)) — Maia proposes, owner decides; 4 deterministic escalation levels (silent/dashboard/mentionable/proposed)
- **P6 Channel/Role/Policy separation** ([#88](https://github.com/diogenesmendes01/Maia-v2/pull/88)) — LLM suggests (`suggested_by`), Policy decides (`decided_by`); anti-oscillation lock + `affects_user` announcement
- **P7 Cognitive Graph orchestration** ([#90](https://github.com/diogenesmendes01/Maia-v2/pull/90)) — declarative module descriptors (runWhen/timeout/fallback/model/version) + sync/async/conditional + per-node audit + p95 budget

#### P8 Hot Path Stages
- **P8a Context Packet** ([#96](https://github.com/diogenesmendes01/Maia-v2/pull/96)) — `BaseContextPacket` → `ExecutionContextPacket` + 7 slice builders + Redis cache with TTL + invalidation bus
- **P8b Soul Layer** ([#95](https://github.com/diogenesmendes01/Maia-v2/pull/95)) — persistent behavioral biases with scope enforcement + feature-flag gating + replay-safe materialization (modulates, never blocks)
- **P8c User Layer namespace** ([#94](https://github.com/diogenesmendes01/Maia-v2/pull/94)) — fail-closed tenant boundary + agent-isolated resolvers (memory/facts/rules/hints) + JSONB `lifecycle_transitions` contract
- **P8d Identity Completion** ([#100](https://github.com/diogenesmendes01/Maia-v2/pull/100)) — operational profile v2 (4-layer) + `papel_drift` detector with feature-flag gating + `seedNewActive` atomic transition + audit precedence
- **P8e PolicyDescriptorResolver** ([#93](https://github.com/diogenesmendes01/Maia-v2/pull/93)) — single shared component for policy resolution with structured cache keys + ordered candidate fallback + fail-closed behaviour
- **P8.5 Admin UI v1** ([#101](https://github.com/diogenesmendes01/Maia-v2/pull/101)) — Next.js 14 + tRPC v11 + NextAuth v5 governance console: `/inbox` (proposals), `/drift`, `/traces`, `/versions` screens wired; `/dashboard`, `/identities`, `/capabilities`, `/procedures`, `/knowledge` routes not yet wired + approval matrix + dual founder lockdown

#### P9 Decision & Policy Layer
- **P9a Skill Abstraction** ([#99](https://github.com/diogenesmendes01/Maia-v2/pull/99)) — declarative skill artifacts + `SkillRunner` with 4 execution modes (sync/async/streaming/batch) + tenant-admin guard
- **P9b Decision Engine** ([#103](https://github.com/diogenesmendes01/Maia-v2/pull/103)) — 3 PEPs (Early/Mid/Late) + `DecisionPacket` + per-step deadline enforcement + `AbortController` integration
- **P9c Risk Scoring** ([#97](https://github.com/diogenesmendes01/Maia-v2/pull/97)) — `TurnRiskScorer` + `KnowledgeRiskScorer` with no-downgrade invariant + fail-closed LLM gate
- **P9d Policy DSL Evaluator** ([#98](https://github.com/diogenesmendes01/Maia-v2/pull/98)) — pure, total, ReDoS-safe DSL with bounded literals + order-invariant error detection + runtime fan-out caps

#### P10 Knowledge & Traceability
- **P10a Knowledge State Machine** ([#104](https://github.com/diogenesmendes01/Maia-v2/pull/104)) — 9-state lifecycle + DB-trigger transition enforcement + visibility filters + auto-promoter + `propose_*` tools
- **P10b Runtime Trace** ([#102](https://github.com/diogenesmendes01/Maia-v2/pull/102)) — sync envelope + async body with HMAC versioned keyring + redaction allowlists + matview + S3 idempotency

#### Calendar & Scheduling
- **Calendar v2** ([#105](https://github.com/diogenesmendes01/Maia-v2/pull/105)) — Brazilian holidays + business-day calendar + RRULE extension + cognitive pipeline integration
- **Scheduling v2 (Spec 18)** ([#72](https://github.com/diogenesmendes01/Maia-v2/pull/72)) — series → occurrences → tasks → outbox architecture; 7 production requirements (transactional outbox, 10k backlog drain, month-end policies, missed-run policies, cancel-race safety, multi-pending disambiguation, per-occurrence audit trail); constitutional rules C-006/C-007/C-008; 47 unit specs

#### Test Infrastructure
- `tests/fixtures/factsRepo.ts` shared mock factory ([#116](https://github.com/diogenesmendes01/Maia-v2/pull/116)) — resolves ~64 stale mock specs
- `tests/fixtures/agentProfile.ts` 4-layer profile builder ([#117](https://github.com/diogenesmendes01/Maia-v2/pull/117)) — resolves ~16 schema-mismatch specs
- `tests/fixtures/driftCandidate.ts` typed drift fixture ([#125](https://github.com/diogenesmendes01/Maia-v2/pull/125))
- `docker-compose.yml` + fail-fast integration test setup ([#123](https://github.com/diogenesmendes01/Maia-v2/pull/123))
- `tests/db/repositories-barrel.spec.ts` regression guard ([#127](https://github.com/diogenesmendes01/Maia-v2/pull/127))
- Inline snapshot for `ProposalStatus` enum (7 values) ([#114](https://github.com/diogenesmendes01/Maia-v2/pull/114))

### Changed
- **vitest 2.1.9 → 4.1.6** ([#120](https://github.com/diogenesmendes01/Maia-v2/pull/120)) — constructor mock arrow→function migration, `vi.mock()` hoisting via `vi.hoisted()`; 15 spec files migrated
- **@anthropic-ai/sdk 0.30.1 → 0.97.1** ([#122](https://github.com/diogenesmendes01/Maia-v2/pull/122)) — bump applied; `TextBlock.citations` required-field adjustment across 7 drift detectors ([#126](https://github.com/diogenesmendes01/Maia-v2/pull/126))
- **@fastify/cookie 10.0.1 → 11.0.2** ([#121](https://github.com/diogenesmendes01/Maia-v2/pull/121))
- **next-auth 5.0.0-beta.25 → 5.0.0-beta.31** ([#124](https://github.com/diogenesmendes01/Maia-v2/pull/124)) — v5 stable not yet shipped upstream
- **node-cron v3 → v4** ([#78](https://github.com/diogenesmendes01/Maia-v2/pull/78)) — API migration applied in P8–P10 batch

### Fixed
- `transitionProcedureStatus` CHECK constraint: accepts `auto_abandoned` + `human_confirmation` event types ([#92](https://github.com/diogenesmendes01/Maia-v2/pull/92))
- LLM anchor on fresh state + persisted tool results ([#74](https://github.com/diogenesmendes01/Maia-v2/pull/74))
- 4-layer AgentProfile schema mismatch in ~16 specs ([#117](https://github.com/diogenesmendes01/Maia-v2/pull/117))
- Stale `factsRepo` mocks in ~64 specs ([#116](https://github.com/diogenesmendes01/Maia-v2/pull/116))
- `TextBlock.citations` typecheck after Anthropic SDK 0.97 bump ([#126](https://github.com/diogenesmendes01/Maia-v2/pull/126))
- `ProposalStatus` enum assertion brittleness ([#114](https://github.com/diogenesmendes01/Maia-v2/pull/114))
- 8 of 11 failing specs on main post-P8–P11 integration ([#128](https://github.com/diogenesmendes01/Maia-v2/pull/128))
- WhatsApp privacy IDs (`@lid`): `pessoasRepo.findByPhone` failure + phantom send to invalid JID ([#71](https://github.com/diogenesmendes01/Maia-v2/pull/71))

### Security
- Tenant boundary fails closed when ALS context is missing (P8c, [#94](https://github.com/diogenesmendes01/Maia-v2/pull/94) round-2)
- HMAC versioned keyring for Runtime Trace (P10b, [#102](https://github.com/diogenesmendes01/Maia-v2/pull/102) round-2)
- Capability proposals cannot self-declare low risk (P8.5, [#101](https://github.com/diogenesmendes01/Maia-v2/pull/101) round-2)
- Strict redaction with schema-driven nested allowlists for decision blobs (P10b, [#102](https://github.com/diogenesmendes01/Maia-v2/pull/102) round-2)
- `Secure` flag added to `maia_session` cookie in production ([#58](https://github.com/diogenesmendes01/Maia-v2/pull/58))
- Stored XSS escaped in `pessoa.nome` in title/h1 ([#57](https://github.com/diogenesmendes01/Maia-v2/pull/57))

### Infrastructure
- Tech-debt issues opened and resolved: #109 drift-detector casts (resolved [#125](https://github.com/diogenesmendes01/Maia-v2/pull/125)), #110 next-auth stable (resolved [#124](https://github.com/diogenesmendes01/Maia-v2/pull/124)), #112 docker-compose (resolved [#123](https://github.com/diogenesmendes01/Maia-v2/pull/123)), #113 capabilityProposalsRepo barrel (resolved [#127](https://github.com/diogenesmendes01/Maia-v2/pull/127))
- S3/B2/R2 backup upload + cloud rotation after nightly `pg_dump` ([#65](https://github.com/diogenesmendes01/Maia-v2/pull/65))
- Per-pessoa LLM cost breakdown + per-OpenRouter-model USD pricing ([#63](https://github.com/diogenesmendes01/Maia-v2/pull/63), [#62](https://github.com/diogenesmendes01/Maia-v2/pull/62))
- `maia_db_connected` Prometheus gauge ([#61](https://github.com/diogenesmendes01/Maia-v2/pull/61))
- TS path aliases via `tsc-alias` (Coolify deploy fix) ([#67](https://github.com/diogenesmendes01/Maia-v2/pull/67))
- ESLint `no-floating-promises` (warn) on `src/` ([#64](https://github.com/diogenesmendes01/Maia-v2/pull/64))

### Known issues (open at release)
- **Production bugs tracked for follow-up**: #135 `transitionProcedureStatus` event recording, #136 contradiction TTL, #137 events-block cardinality, #138 pdfmake import
- **Runbook gaps**: #129 P8c, #130 P8.5, #131 P9b, #132 P9c
- **Admin UI**: 3 specs (`proposals-router`, `tenant-resolver`, `versions-router`) fail because `@trpc/server` is not yet installed at the repo root. Fix tracked in #139 (PR #146). **The `v3.0.0` git tag must NOT be cut until PR #146 merges.**
- **next-auth**: still on beta.31 — waiting for v5 stable upstream (#110)

### Notes
- `package.json` bumped to `3.0.0` in this PR to align with the CHANGELOG entry.
- The `v3.0.0` git tag should be cut after both this PR and PR #146 (`@trpc/server` hoist) are merged to `main`.

---

### Scheduling v2 (Spec 18) — detailed notes

#### Added
- **Spec 18 v2.3 — addresses 1 follow-up BLOCKER** raised in PR #72
  review 3:
  - **B1/r3 — `claimInProgressForAdvance()` restricted to
    `recurring_outreach`**: the SQL claim now `JOIN`s on `series` and
    filters `tipo = 'recurring_outreach'`, so `one_shot_reminder`
    occurrences whose outbox row is still pending (rate-limited,
    Baileys disconnected, retry pending) are never picked up by the
    engine's in-progress pass. Previously they could be falsely
    finalized as `completed/fired` while the underlying WhatsApp
    message had never been sent. Completion for `one_shot_reminder`
    now flows exclusively through `outbox-drain`: `markSent` →
    `task.completed` → `occurrence.completed(fired)`, or `markDead`
    → `task.failed` → `occurrence.failed(reason=outbox_dead)`.

    Defence-in-depth: `advanceInProgressOccurrence` now `releaseClaim`s
    when the series tipo is not `recurring_outreach` (instead of marking
    the occurrence `completed`). Even if a future change widens the
    claim filter or a race exposes the wrong tipo, the engine never
    audits a phantom success.
- **Spec 18 v2.2 — addresses 4 follow-up BLOCKERs** raised in PR #72 review 2:
  - **B1/r2 — `payment_due` never audits confirmed on dispatch failure**:
    `resolvePaymentOccurrence` now inspects the `dispatchTool` return
    value. When the dispatcher returns `{ error: ... }` (forbidden /
    requires_dual_approval / invalid_args / etc.) OR throws, the
    occurrence is parked as `failed`, the task is marked `failed`
    with the dispatch error, the operator is alerted via the outbox,
    and the next cycle is NOT scheduled. `payment_due_confirmed`
    only audits on a real success.
  - **B2/r2 — outreach timeout anchor**: `occurrencesRepo.setStatus`
    now sets `started_at` on transitions to `awaiting_third_party`
    and `awaiting_owner` (not just `in_progress`). The
    `listAwaitingTimedOut` query relies on `started_at IS NOT NULL`
    and previously never matched any outreach occurrence.
  - **B3/r2 — forward task gated on `outbox_sent` confirmation**:
    `advanceInProgressOccurrence` enqueues the forward outbox row
    and leaves the task `in_progress`. The outbox-drain marks the
    task `completed` ONLY after a successful send. The occurrence
    finalizes (and the next cycle schedules) on the next engine tick
    that sees `forward.status='completed'`. Dead outbox rows for
    forward / fire_reminder tasks now mark the occurrence `failed`
    instead of leaving a phantom success.
  - **B4/r2 — outbox-drain loops within one cron firing**: the
    worker calls `runOutboxDrain` up to `OUTBOX_DRAIN_LOOP_PASSES`
    times (default 55), sleeping `OUTBOX_DRAIN_LOOP_SLEEP_MS` ms
    (default 1000) between passes when the rate gate denied any
    send. Honours the per-second cadence with a per-minute cron.
    Without this loop, a 10k backlog drained at ~1 msg/minute
    (rate gate denied 49 of 50 attempts per tick).
- **Spec 18 v2.1 — addresses 10 review BLOCKERs** raised on PR #72:
  - **B1 — payment_due never silently dispatches**: pending-resolver
    detects `acao_proposta.scheduling_kind === 'payment_due'` and
    routes to `resolvePaymentOccurrence`. `register_transaction`
    fires ONLY in the `sim` branch — `nao` skips and `adiar`
    postpones. Previously, the generic dispatcher would have
    executed the transaction for any chosen option.
  - **B2 — lease reclaim re-enters the pending queue**: both
    `runSchedulingTick` and `runOutboxDrain` reclaim expired leases
    by resetting rows to `pending` (clearing `claimed_by` /
    `claimed_at`). The subsequent `claimDue` in the same tick picks
    them up naturally. Previously, reclaimed rows stayed `claimed`
    indefinitely.
  - **B3 — recurring_outreach completes the cycle**: engine claims
    `in_progress` occurrences in a dedicated pass to run the
    `forward` step, scans `awaiting_third_party` for
    `wait_response_hours` timeouts and escalates, and inserts the
    next cycle via `insertNextOccurrenceIfActive`. The previous
    cycle could stall after the response was captured.
  - **B4 — engine advances are transactional**: new
    `advanceWithTx(fn)` wraps `tasks.setStatus` +
    `occurrences.setStatus` + `outbox.enqueue` inside one DB
    transaction. Either all three commit or none. Previously the
    three writes were separate calls; a crash between them left
    half-states.
  - **B5 / B6 — feature flag gates the tools**: `schedule_reminder`,
    `cancel_reminder`, `start_recurring_outreach`,
    `start_recurring_payment` only register in the LLM tool
    registry when `FEATURE_SCHEDULING_V2=true`. Prevents the LLM
    from creating series that no worker would execute.
  - **B7 — workers match the spec**: added
    `series_next_scheduler` cron (`*/10 * * * *`) that backfills
    missing next-cycle occurrences for active series whose chain
    broke (crash between complete + reschedule). Spec updated to
    document the in-tick lease reaper.
  - **B8 — exclusive_per_destinatario enforced**: when a series
    has the flag set and the engine claims an outreach occurrence,
    it checks for sibling occurrences already
    `in_progress`/`awaiting_third_party` with the same destinatario
    and defers (releases the claim with a 10-min backoff) if so.
  - **B9 — inbound hook wired**: `agent/core.ts` calls
    `captureInboundForOutreach` on every text inbound when
    scheduling is enabled. Third-party replies now actually advance
    their occurrence.
  - **B10 — integration tests for the 7 critérios**: seven specs
    under `tests/integration/scheduling/` exercise crash recovery,
    backlog drain under backpressure, month-end policy outcomes,
    missed-run policy decisions, cancel-race, multi-pending
    disambiguation, and per-occurrence audit reconstruction.
- **Spec 18 v2 — Scheduling: series → occurrences → tasks → outbox**
  (`docs/specs/18-scheduling-and-recurring-workflows.md`). Operational
  engineering spec for proactive scheduling. Supersedes the v1
  discovery draft. Satisfies seven production requirements:
  1. Outbox never loses a message — transactional outbox table.
  2. 10k-deep backlog drains under per-second + per-hour + per-
     recipient backpressure (`OUTBOX_MAX_*` env).
  3. Monthly series on day 31 follows a documented
     `month_end_policy` (`skip_invalid_month` | `last_day_of_month`
     | `nearest_previous` | `nearest_next`).
  4. Multi-day downtime follows a documented `missed_run_policy`
     (`fire_all` | `fire_latest_only` | `skip_all` |
     `escalate_to_owner`).
  5. Cancelling a series prevents new occurrences even with a
     concurrent engine tick — version-gated INSERT + atomic
     status+occurrence transaction.
  6. Multiple open outreaches with the same destinatario never
     capture each other's response — correlation tokens
     (`_ref: A4F2_`) + disambiguation prompt to the owner.
  7. Every occurrence has an auditable trail from scheduling to
     final outcome in **one SQL query** — `audit_log.occurrence_id`
     populated on every state transition.
- **Migration `007_scheduling.sql`**: four new tables
  (`series`, `occurrences`, `tasks`, `outbox_messages`) +
  `audit_log.occurrence_id`. All indexes for hot paths.
- **`src/scheduling/`** module: `rrule.ts` (RFC 5545 subset +
  month-end policies), `repos.ts` (transactional repos with
  `FOR UPDATE SKIP LOCKED` and optimistic locking),
  `backpressure.ts` (Redis token-bucket per-second/per-hour +
  per-recipient pacing, fail-CLOSED on Redis outage),
  `correlation.ts` (4-hex tokens for outreach disambiguation),
  `policies.ts` (missed-run decision table),
  `disambiguation.ts` (multi-pending owner prompt),
  `engine.ts` (claim + advance per-tipo, never sends directly),
  `outbox-drain.ts` (lease-based claim, polynomial backoff, DLQ).
- **New tools**:
  - `schedule_reminder` (rewritten) — creates a `one_shot_reminder`
    series + initial occurrence + reminder task atomically.
  - `cancel_reminder` (rewritten) — invokes
    `seriesRepo.cancelAtomic` so cancellation pre-empts in-flight
    engine ticks.
  - `start_recurring_outreach` (new) — `recurring_outreach` series
    with C-007 dual-approval gate at creation.
  - `start_recurring_payment` (new) — `recurring_payment` series
    with C-006 hard-limit gate at creation.
- **New workers**: `scheduling_tick` (cron `* * * * *`) and
  `outbox_drain` (cron `* * * * *`). Both register only when
  `FEATURE_SCHEDULING_V2=true`.
- **Constitutional rules**: **C-006** (`start_recurring_payment`
  above `VALOR_LIMITE_DURO` rejected), **C-007**
  (`start_recurring_outreach` requires `dual_approval_granted`),
  **C-008** (defence-in-depth — occurrence rejected at claim if
  `contexto_snapshot.valor` exceeds current `VALOR_LIMITE_DURO`).
- **Env vars**: `FEATURE_SCHEDULING_V2`, `OUTBOX_MAX_PER_SECOND`
  (default 1), `OUTBOX_MAX_PER_HOUR` (default 600),
  `OUTBOX_WORKER_CONCURRENCY` (default 4),
  `OUTBOX_LEASE_TTL_SECONDS` (default 300),
  `OCCURRENCE_LEASE_TTL_SECONDS` (default 300).
- **23 new audit actions** covering series, occurrence, outbox,
  outreach, payment_due lifecycles.
- **47 new unit specs** across 8 files, one per requirement
  (rrule, policies, correlation, backpressure, disambiguation,
  cancel-race, outbox-drain, engine).

## [0.1.0] - 2026-04-27

### Added
- Estrutura inicial do projeto (Node 20 + TypeScript)
- Documentação de arquitetura completa (`docs/arquitetura.md`)
- Schema do banco com 16 tabelas (PostgreSQL 16 + pgvector)
- System prompt da Maia v0 (`src/identity/maia-prompt.md`)
- Template de inventário para preencher (`docs/inventario.md`)
- Docker Compose com Postgres + pgvector + Redis
- Configuração TypeScript strict mode
- `.env.example` documentado
- Licença MIT
