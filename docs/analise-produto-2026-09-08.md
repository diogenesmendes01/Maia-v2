# Maia — o que existe hoje no código

> Análise de produto feita por leitura do código em `main` (HEAD `9dc7ef7`, 2026-09-08).
> Método: 14 mapeadores leram um subsistema cada, verificadores adversariais tentaram
> refutar as afirmações mais consequentes, e as contagens foram reconferidas à mão.
> **Código é a fonte da verdade aqui. Onde doc e código divergem, o código venceu** —
> as divergências estão na seção 11.

---

## 1. Resumo executivo

A Maia é uma plataforma de agente único operando por WhatsApp, com uma máquina de
governança grande e bem construída em volta dela. O que funciona de ponta a ponta hoje,
num deploy com os defaults do repositório:

- **Um turno completo de conversa**: mensagem chega pelo Baileys, é deduplicada,
  persistida, vira um turno durável em `agent_turns` com claim atômico, lease com
  heartbeat e fencing token; passa pelo Decision Engine, monta prompt, roda um loop
  ReAct de até 5 iterações com Claude Sonnet 4.6, e a resposta é gravada num outbox
  transacional antes de tocar o canal.
- **Governança de execução**: 65 tools tipadas em Zod com classe de efeito, checagem
  constitucional, autorização financeira por faixa de valor (1.000 / 20.000 / 50.000 BRL),
  aprovação dupla com evidência persistida e resposta determinística `aprova AP-xxxxxxxx`,
  idempotência com chave escopada por tenant.
- **Console de governança** (Next.js 16, 21 routers tRPC, 21 telas) com aprovação de
  propostas, rollback de perfil, explorador de traces, pareamento de linha WhatsApp e
  triagem de pedidos de ferramenta.
- **Operações**: backup verificável com manifesto assinado, drill de restore horário,
  49 jobs de cron, contrato de configuração de 212 variáveis com boot fail-closed,
  924 arquivos de teste e um CI de 9 jobs todos bloqueantes.

Os cinco fatos que mudam a leitura do produto:

1. **O agente nasce sem as ferramentas financeiras.** `BASE_AGENT_PACKS` é
   `['baseline.core', 'domain.calendar']` (`src/tools/base-agent-packs.ts:9`). O pack
   `domain.finance` precisa ser concedido à mão pelo console. Sem isso, "R$ 50 mercado"
   não vira lançamento — a tool nem é visível ao modelo.
2. **19 dos 49 workers nunca sobem.** Os grupos `console`, `cognition`, `procedures`,
   `proactive` e `governance` nascem desligados (`src/workers/job-contract.ts:142-162`).
   Isso derruba, no default: briefings proativos, detector de drift, escalada de gaps,
   promotor do Knowledge State Machine, work loop de objetivos e o playground.
   Mais 5 dos 30 ligados são no-op na primeira linha por flag.
3. **Toda a camada de aprendizado está fora do ar por default.** Reflexão pós-turno roda
   (é grafo cognitivo, não worker), mas o que transforma reflexão em mudança de
   comportamento — drift, gap-escalation, capability proposer, promotor do KSM — está nos
   grupos desligados. E não existe caminho humano para tirar uma linha de
   `pending_review`: nenhum chamador de `KnowledgeStateMachine.transition` com aprovação
   humana, e o console devolve `NOT_IMPLEMENTED`.
4. **Há uma camada substancial de código sem chamador.** Context Packet inteiro (~4.160
   linhas, 20 de 21 arquivos), Late PEP (o PEP 3/3 que validaria a saída do LLM),
   `activateLockdown`, 3 das 5 fachadas de memória (working/episodic/procedural),
   skill-proposer, capability-test-runner, `soul-bias-activator`, o test-runner de
   procedures. Nada disso está quebrado — está desconectado.
5. **O README mente sobre o básico.** Ele diz `tenant_id='default'` (o runtime usa
   `'primary'` e rejeita `'default'` fail-closed desde a #323), diz "152 migrations · 33
   workers · 16 routers · Next.js 14 · 392 specs" (são 145 · 49 · 21 · 16.3.2 · 924), e
   marca os pilares 3 e 7 como 🔴 por causa das issues #229/#230 — **fechadas há três
   meses, com o código hoje escopado corretamente** (conferido em
   `src/memory/vector.ts:60,95-97` e nos mutators de `rulesRepo`).

Onde está o risco: o vertical de cobrança/boleto (#416) tem 11 das 19 tools como stubs
honestos sem backend; o piloto de cobrança do ADR 0006 não tem uma linha de código; e o
fluxo LGPD de exclusão nunca foi executado contra um banco real.

---

## 2. Números do código

| Dimensão | Valor real | O que o README diz |
|---|---|---|
| Versão | 3.1.0 (release 2026-05-20; 65 entradas em `[Unreleased]`) | — |
| Arquivos `.ts`/`.tsx` em `src/` | 763 em 30 subdiretórios | — |
| Tabelas no schema Drizzle | **106** `pgTable` + 2 matviews | — |
| Migrations forward | **145** (`+145 _down` = 290 `.sql`); prefixo máx. 138 | 152 |
| Workers (jobs de cron) | **49** registrados, 46 módulos, 12 grupos | 33 |
| Tools no registry | **65** (64 fixas + `generate_report` sob flag) | — |
| Routers tRPC | **21** montados (22 arquivos) | 16 |
| Telas do console | 21 (+2 auth, +2 redirects) = 25 `page.tsx` | — |
| Variáveis no contrato de config | **212** (24 grupos, 23 segredos, 5 tombstones) | — |
| Feature flags `FEATURE_*` | 33 declaradas (11 ON / 22 OFF) + 5 tombstones | — |
| Arquivos de teste | **924** (unit 698 · integration 163 · admin-ui 41 · reliability 15 · e2e 1 · property 1 · benchmark 1) | 392 |
| Casos `it()` (aprox.) | unit ≈7.863 · integration ≈1.202 · admin-ui ≈503 | — |
| Jobs de CI | 9, todos bloqueantes, sem `needs:` | "typecheck + lint + build + unit + integration + e2e + gitleaks" |
| Admin UI | Next.js **16.3.2** + React 19.2.8 + next-auth 5.0.0-beta.32 | Next.js 14 |

Linhas por subsistema (`.ts`/`.tsx`, sem `node_modules`):

| Subsistema | Arquivos | Linhas | | Subsistema | Arquivos | Linhas |
|---|---:|---:|---|---|---:|---:|
| `src/db/` | 42 | 31.354 | | `src/gateway/` | 17 | 7.028 |
| `src/admin-ui/` | 122 | 23.191 | | `src/observability/` | 18 | 6.335 |
| `src/runtime/` | 81 | 21.949 | | `src/onboarding/` | 11 | 5.046 |
| `src/ops/` | 46 | 12.847 | | `src/governance/` | 19 | 4.970 |
| `src/tools/` | 79 | 11.492 | | `src/migrations/` | 11 | 3.511 |
| `src/workers/` | 48 | 11.080 | | `src/scheduling/` | 10 | 3.539 |
| `src/lib/` | 48 | 10.203 | | `src/config/` | 20 | 8.293 |
| `src/agent/` | 27 | 9.826 | | `src/skills/` | 10 | 2.274 |
| `src/cognition/` | 55 | 9.165 | | `src/setup/` | 13 | 2.348 |
| `src/control-plane/` | 27 | 7.274 | | `src/memory/` | 5 | 720 |
| `src/cognitive-graph/` | 6 | 608 | | `src/procedures/` | 2 | 624 |
| `src/identity/` | 9 | 1.186 | | `src/import/` | 3 | 222 |

---

## 3. O caminho de uma mensagem

```
WhatsApp (Baileys)
  └─ src/gateway/baileys.ts  ~1.659 linhas
     ├─ resolveChannel: JID → (tenant, agent, channel)   [MAIA_CHANNEL_ROUTING_MODE=shadow]
     ├─ descarta grupos e fromMe
     ├─ dedup Redis 24h + UNIQUE no Postgres
     ├─ bot-detection (>50 msg/min bloqueia a pessoa)
     ├─ extrai texto/áudio/imagem/documento (caps + magic bytes)
     ├─ INSERT em `mensagens` + `agent_turns` (stream_key, ingress_seq)
     └─ enqueue BullMQ fila `agent` (concurrency 1)
        │
        └─ src/index.ts:310 startAgentWorker → src/runtime/turns/job-consumer.ts
           └─ src/agent/core.ts  runAgentForMensagem  (1.933 linhas — o pipeline inteiro)
              ├─ ensureTurnHandle / beginTurnExecution
              │     claim atômico + lease 60s (heartbeat 15s) + fencing por claim_token
              │     head-of-line: turno só roda se for a cabeça da conversa
              ├─ resolveIdentity → unknown / blocked / quarantined / ok
              ├─ rate-limit por pessoa (30/h)
              ├─ parseApprovalReply  ("aprova AP-xxxxxxxx" resolve ANTES do LLM)
              ├─ checkPendingFirst   [FEATURE_PENDING_GATE=false → no-op]
              ├─ resolveScope (permissões) + audiência
              ├─ grafo pré-turno: procedure-selector (5s) ‖ role-selector (3s)
              ├─ computeRuntimeVisibleTools  (grant ∩ role ∩ skill ∩ permissão)
              ├─ Decision Engine (2.500ms, 9 passos, fail-closed)
              │     resolver → Early PEP → intent → risco → workflow → agente → skill → Mid PEP → ação
              ├─ buildPrompt: loadTurnContext (13 statements, semáforo 6) + renderTurnPrompt
              ├─ runReActLoop  ≤5 iterações
              │     callLLM(workload 'reasoner', Sonnet 4.6, 30s, max_tokens 1024)
              │     tools em série via dispatchTool (constitucional → canAct → confirmação
              │                                      → idempotência → efeito → audit)
              ├─ safeDispatchOutput → commitOutboundIntent (tx: outbox + turno → outbound_pending)
              │                     → sendText no canal → recordInlineDelivery
              ├─ decideTurnAction → completed / retryable (3 tentativas) / dead_letter
              └─ grafo pós-turno (fire-and-forget): step-evaluator, correction-reflection,
                                                   success-reflection
```

Duas coisas importantes sobre esse caminho:

- **O envio é inline, não pela fila.** O outbox durável (`outbound_messages`) está ligado
  e grava a intenção numa transação antes de qualquer chamada ao canal, mas o consumidor
  BullMQ (`FEATURE_OUTBOUND_DELIVERY_WORKER`) e o sweeper de recovery
  (`FEATURE_OUTBOUND_RECOVERY`) nascem **OFF**. Uma linha que falhe depois do commit fica
  parada até `npm run dlq outbound-rearm`.
- **Falha do reasoner é silenciosa.** Timeout ou erro do LLM → turno vira `retryable`,
  tenta 3 vezes com espera de ~60s e ~120s, e vai para `dead_letter/retry_exhausted`
  **sem mandar nada ao usuário**. Só o fail-closed do Decision Engine responde
  ("Esta ação requer aprovação adicional" / "Sistema indisponível").

---

## 4. Inventário por subsistema

### 4.1 Entrada e gateway (`src/index.ts`, `src/server.ts`, `src/gateway/`, `src/runtime/lifecycle/`)

Boot em 10 passos ordenados sob um controlador de ciclo de vida
(`starting → ready → draining → stopped/failed`), com `MAIA_PROCESS_ROLE` decidindo o que
sobe (`all` | `api` | `worker` | `scheduler` | `session-owner`; default `all`, o único
deployment funcional hoje). Shutdown em 11 passos.

| Componente | Status | Nota |
|---|---|---|
| Entrypoint + 10 passos de startup | ligado | exit codes 90–98 para falha de schema |
| Contrato de process roles (5 papéis × 10 componentes) | ligado | `api` não possui a sessão WhatsApp |
| `least privilege` por role (`role-config.ts`) | parcial | tabela pura, **sem consumidor em runtime** |
| Probes `/livez` `/startupz` `/readyz` | ligado | `/readyz` é role-aware e fail-closed |
| `/health*` (4 rotas) + `/metrics` | ligado | health é diagnóstico, sempre 200 |
| 10 rotas `/setup*` (pareamento) | ligado | token + cookie + CSRF + rate-limit 30/min |
| Baileys: sessão primária, QR, código 8 dígitos | ligado | reconexão 5 tentativas, cap 30s |
| Linhas adicionais (multi-linha) | desligado por flag | `MAIA_MULTI_LINE=false`; lease + fencing em `channel_line_state` |
| Dedup / bot-detection / extração de mídia | ligado | dedup Redis 24h; >50 msg/min bloqueia |
| Debounce, presença, one-tap, edição, view-once | desligado por flag | 7 flags OFF no default |
| Fronteira de egresso `LineOutput` + trava ALS | ligado | qualquer `send*` fora de escopo lança `DirectSendViolationError` |

**Adapters de canal concretos: 1.** `telegram | email | sms | web | api | other` existem
só como literais de tipo. Não há envio de imagem ou vídeo — as primitivas de saída são
texto, documento, voz (PTT), poll e reação.

### 4.2 O turno (`src/agent/`, `src/runtime/turns/`)

A máquina de estados durável do turno é o subsistema mais maduro do repositório: 10
estados, 16 outcomes, CAS por `state_version`, fence por `claim_token`, retry com backoff,
poison policy que interdita a conversa quando um efeito já foi cometido. Ligada por
default (`FEATURE_TURN_STATE_MACHINE`, `_AUTHORITATIVE`, `_CLAIM`, `_STREAM_KEY`,
`_HEAD_OF_LINE`, `_STREAM_PROMOTION` — todas `true`).

Parâmetros que valem conhecer:

- ReAct: **5 iterações**, `max_tokens` 1.024, sem streaming, **sem prompt caching**
- Contexto: **10 mensagens de histórico / 24 KB**, orçamento de **13 statements** por turno
- Lease: TTL 60s, heartbeat 15s, aborta na 2ª falha
- Retry: 3 tentativas (esperas reais de ~60s e ~120s)
- LLM: deadline 120s por chamada, 30s por tentativa, 3 tentativas

Gaps concretos: `tool_result` entra na conversa como `JSON.stringify(out)` **sem teto de
bytes** (as tools MCP têm teto de 32 KiB; as nativas não); o cache de contexto está OFF e
só cobre `identity`; `prompt-builder.ts:148` lê `process.env` direto, contornando o
contrato de config.

### 4.3 Decisão, guardrails e egresso (`src/runtime/decision/`, `guardrails/`, `outbound/`, `src/governance/`)

O Decision Engine roda em **todo turno**, always-on e fail-closed, com orçamento de
2.500ms e 9 sub-passos. Mas a fatia de política que efetivamente executa é menor do que
parece:

| Camada | Status real |
|---|---|
| Early PEP | **nunca avalia política DSL** — o adapter não preenche `applies_to_peps` e `getBodySync` devolve `null`; só os 2 short-circuits de lockdown rodam, e o de canal é inerte (`is_locked_down` é sempre `false`) |
| Mid PEP | **o único** que roda o evaluator P9d |
| Late PEP | **código morto** — a saída do LLM não passa por nenhuma política |
| Políticas resolvidas por turno | **2** (`confirm_before_write_policy`, `human_confirmation_policy`) — os hard-limits da migration 037 são deliberadamente excluídos até serem convertidos para o DSL |
| `agent-selector` | **no-op confirmado** — devolve `channel_policies.agent_id`. `MULTI_AGENT_SELECTOR_V2` **não existe no contrato**, é só um comentário |
| `validatePolicyRuleBody`, `enforce()`, `activateLockdown` | código morto |

A governança **síncrona** no dispatcher de tools, essa sim, é real e ligada: 9 regras
constitucionais, 10 regras de dual approval, avaliador financeiro em centavos com
`Decimal`, `approval_requests` com hash canônico e claim CAS, idempotência com
`payload_hash` versionado.

O egresso tem 5 camadas de não-duplicidade (unique `logical_dedupe_key`,
`provider_idempotency_key` nativo do Baileys, jobId determinístico, claim com lease/fence,
política que nunca reenvia `delivery_unknown` sem chave nativa). Restam **6 rotas de envio
como exceções declaradas** fora do outbox do turno, com prazo e teste estático que reprova
o CI quando vencerem.

### 4.4 Cognição, grafo e identidade (`src/cognition/`, `cognitive-graph/`, `identity/`, `user-layer/`)

O grafo cognitivo é o único caminho de orquestração turn-time (a `FEATURE_COGNITIVE_GRAPH`
foi removida de fato — é tombstone no contrato). São 5 nós: 2 pré-turno síncronos
condicionais e 3 pós-turno assíncronos.

O que roda no turno: reflector → classifier → persister (correção, sucesso, gap interno),
com 25 call sites nomeados de `runCognitiveModule`.

O que **não** roda no default (grupos de scheduler desligados): drift (9 detectores,
7 com LLM), gap-escalation, capability-proposer, tool-request proposer, relayer/closure de
issues, reflection batch, pattern detector, confidence recompute, consumidor de candidatos
de procedimento, promotor do KSM.

Sem chamador em `src/`: `skill-proposer`, `capability-test-runner`,
`calendar-pattern-detector`, `procedure-status`, `ModuleRegistry`, `latency-budget`,
`identity/proposal-generator`, `identity/duplicate-detection`, e praticamente toda a
fachada `src/user-layer/` (o `UserSliceBuilder` de produção está ligado a um
`stubUserPort` que devolve `null`/`[]`).

Nuances que corrigem a narrativa dos docs:

- O "self-model em 3 camadas" é, no código, **1 domínio (`'general'`) com uma fórmula
  de confiança**. `agent_capabilities_skill` nunca é tocada.
- `learned_voice_modifiers` é só tipo + schema Zod: não há produtor nem consumidor que
  aplique o delta à voz.
- Os placeholders `{{ }}` de `maia-prompt.md` **nunca são substituídos** — o arquivo entra
  cru em `self_state` e só serve como fallback quando não há perfil operacional v2.
- Aprovar uma proposta de tipo `tool`/`knowledge`/`procedure`/`integration`/`other` é
  no-op (`logger.warn('handler_not_implemented')`). Só `holiday` tem handler real.

O subsistema **tool-request** (agente pede uma ferramenta que não existe) é o mais completo
e determinístico da camada: proposta inerte → agregação por Dice 0.85 → aceite no console
reserva uma issue → relayer abre no GitHub → closure fecha o gap por fato (tool registrada
**e** concedida). O guardrail é explícito: *o agente especifica, o humano instala.*

### 4.5 Control-plane, skills, procedures, workflows (`src/control-plane/`, `skills/`, `procedures/`, `workflows/`, `objectives/`)

| Peça | Status | O que falta |
|---|---|---|
| Knowledge State Machine (9 estados, 20 transições) | parcial | **nenhuma saída de `pending_review`**: sem chamador humano de `transition`/`revoke`; a tabela `knowledge_pending_review` que o admin espera **não existe** |
| Auto-promoter do KSM (6 transições) | desligado (grupo `cognition`) | sem guard de concorrência |
| Policy resolver (descriptor → policy_id) + cache Redis | ligado | só 2 chamadores reais (dos 6 que o doc declara) |
| Policy DSL evaluator (10 operadores, tri-state) | ligado | só o Mid PEP o consome |
| `policy_rules` writes (propose/activate/rollback) | sem chamador | políticas só nascem por migration seed |
| Runtime trace (envelope HMAC v2 + outbox + 3 workers) | desligado por flag | `FEATURE_RUNTIME_TRACE_V1=false` em todos os fixtures ⇒ **não há trace de compliance em produção** |
| Skill registry + `runSkill` (7 gates) | ligado | — |
| Modos `prompt_only` / `evaluator` | ligados | — |
| Modos `tool_mediated` / `procedure_adapter` | inalcançáveis | `ActionDecider` os exclui e `setToolDispatcher` nunca é chamado ⇒ **8 das 11 baseline skills nunca executam** |
| Procedures engine (event-sourced, 9 eventos) | ligado | — |
| Procedures test-runner + gate de testes | código morto | `runProcedureTest` e `recordRun` sem chamador ⇒ `proposed→active` só destrava com `procedure_tests` preenchida à mão |
| Soul layer (`soul_biases`) | parcial | único caminho de escrita (`soul-bias-activator`) **não tem chamador**; só existem os 3 seeds da migration 039 |
| Workflows (`start_workflow`) | stub | `tickEngine` só expira; retorna `processed: 0` sempre — workflows criados pelo LLM nunca avançam |
| Work loop de objetivos | desligado (grupo `console`) | **1 kind** (`manual`, sem `perceive`); o doc admite que nunca rodou em produção |

### 4.6 Workers e agendamento

49 jobs, todos `node-cron` em `America/Sao_Paulo`, em 12 grupos. **Nenhum consumidor
BullMQ vive em `src/workers/`** — os 3 (`agent`, `unrouted-replay`, `outbound-delivery`)
estão em `src/gateway/queue.ts`.

| Grupo | Default | Jobs |
|---|---|---:|
| `turn-pipeline` | ON | 7 |
| `monitoring` | ON | 7 |
| `ops-backup` | ON | 4 |
| `scheduling` | ON | 3 |
| `channel` | ON | 3 |
| `outbound` | ON | 3 |
| `housekeeping` | ON | 3 |
| `cognition` | **OFF** | 7 |
| `proactive` | **OFF** | 4 |
| `governance` | **OFF** | 3 |
| `console` | **OFF** | 3 |
| `procedures` | **OFF** | 2 |

**30 agendados no default, dos quais 5 são no-op na primeira linha por flag**
(`stream_debounce_closer`, `pending_reminder`, `mcp_sync`, `synthetic_probe`,
`outbound_recovery`) — **25 fazem trabalho real.**

O agendamento é `series → occurrences → tasks → outbox_messages`, com 3 tipos de série
(lembrete único, outreach recorrente, pagamento recorrente), claim por `FOR UPDATE SKIP
LOCKED`, backpressure em Redis (2/s, 120/h, 2s por destinatário, fail-closed) e RRULE com
extensão de dia útil brasileiro.

A **sonda sintética** está completa (tenant `__probe__`, canal marcado `is_synthetic`,
injeção pelo caminho real, judge LLM opcional, sink sempre ativo no boot) mas exige três
condições fora do default para injetar.

### 4.7 Banco e migrations

106 tabelas + 2 materialized views. **Sem `pgEnum`**: todo vocabulário de status é `text`
+ `CHECK` escrito em SQL, então tipos TS e constraints podem divergir sem erro de
compilação.

O runner de migrations é uma biblioteca fail-closed com advisory lock global, ledger v2
com checksum SHA-256, três modos de transação, bloqueio por índice inválido e protocolo
running-first. **Quem aplica é só `scripts/migrate.ts`**; o app em boot apenas verifica
(exit codes 90–98) e `/readyz` reusa o mesmo veredito.

Isolamento: `AsyncLocalStorage` + `applyTenantGuard`. 21 dos 34 módulos de repositório
passam pelo ALS; 8 recebem `tenant_id`/`agent_id` explícitos por desenho; 5 são helpers
SQL puros. **60 arquivos fora de `src/db/` importam o client direto** e montam queries
próprias — a doc diz que "os repositórios são a única interface sancionada".

Não há executor de rollback: os 145 `_down.sql` existem e são exigidos pela descoberta,
mas reversão é manual por `psql`.

Tabelas mortas: `transferencias_internas` e `recorrencias` (declaradas, sem leitor nem
escritor), mais duas tabelas de backup criadas por migration que ninguém lê.

### 4.8 Memória e biblioteca

**Das 5 "camadas de memória", 2 estão ligadas.** `working.ts` (509 linhas, Lua atômico,
TTL, 5 métricas, 6 specs), `episodic.ts` e `procedural.ts` **não têm nenhum chamador em
`src/`** — o runtime vai direto a `rulesRepo`/`factsRepo`/`mensagensRepo`. As métricas
`working_memory_*` medem nada.

**Os gaps #229 e #230 que o README lista como abertos estão fechados no código.** Conferido:

- `src/memory/vector.ts:60` — `INSERT INTO agent_memories (tenant_id, agent_id, …)`
- `src/memory/vector.ts:95-97` — `WHERE tenant_id = … AND agent_id = … AND escopo = ANY(…)`
- `rulesRepo.incrementAcerto` / `incrementErro` / `setStatus` — todos pinam tenant+agent e
  lançam `rule_not_in_scope` em 0 linhas

O **LLM Gateway** (`src/lib/llm/`, 15 arquivos) é a fronteira única, com lint gate que
proíbe o SDK fora de `providers/`: 20 workloads, 3 tiers, 2 providers (Anthropic direto;
OpenRouter via SDK `openai`), model-resolver com cache de 30s lendo `global_settings`,
telemetria em todo desfecho, custo em `agent_facts`.

Desligados por default: orçamento diário (`LLM_DAILY_BUDGET_USD=0`) e disjuntor
(`LLM_CIRCUIT_MODE=shadow` — mede mas nunca recusa). Ou seja, **em produção com defaults
nenhuma chamada é recusada por custo nem por queda de provider.**

Outras integrações: Whisper (áudio, ligado), Claude Vision (imagem, ligado), TTS OpenAI e
PDF e MCP (todos atrás de flag OFF), embeddings Voyage/OpenAI/Cohere (`VECTOR(1024)`),
alertas por SMTP + Telegram, métricas Prometheus caseiras (sem `prom-client`) e um exporter
OTLP próprio (inerte sem endpoint).

Detalhes de custo: Whisper, TTS e embeddings **nunca entram no ledger**; os preços dos
modelos Anthropic são hardcoded — o custo em USD é estimativa, não fatura.

### 4.9 Admin UI

Next.js 16.3.2 em processo separado (porta 4000), 122 arquivos, 21 routers com 83
procedures (47 queries, 36 mutations, zero públicas), 6 delas restritas a `founder`.
Autenticação por OIDC genérico (obrigatório em staging/produção; boot falha sem ele) mais
um `magic-link` de dev fora de produção. **Não existe superfície para criar `app_users`** —
provisionamento de operadores é por SQL.

Funciona de verdade: inbox unificado de propostas com rejeição em massa, aprovação dual com
architecture locks, rollback de perfil operacional, wizard de agente em 5 passos, canais/
papéis/políticas com pareamento de linha por QR, MCP (registro/test/sync/decisão), skills
lifecycle, objetivos com fila de exceções, playground (LLM real, executado pelo worker do
runtime, sem tools nem memória), traces com integridade HMAC, catálogo de 65 tools, LLM
settings com controle otimista, e triagem de pedidos de ferramenta.

Stub ou parcial:

- **Router `drift` devolve `[]` hardcoded** — a tela `/drift` sempre mostra "nenhum
  alerta", mesmo com linhas em `agent_drift_alerts` (o dashboard conta certo)
- `proposals.approve` só transiciona 2 das 6 fontes; as outras dão `NOT_IMPLEMENTED`
- `versions` cobre só `agent_operational_profile_versions`
- Diff de proposta é JSON bruto exceto para perfil operacional
- 3 flags `FEATURE_ADMIN_UI_*` declaradas no contrato **sem nenhum leitor**

### 4.10 Configuração, onboarding e operações

O contrato de configuração é o artefato mais rigoroso do repositório: 212 variáveis numa
tabela única, 50 regras cross-field, boot fail-closed que reporta **todos** os problemas de
uma vez, geração de `.env.example` + docs + JSON Schema + manifest + fixtures, e um
preflight que reconstrói o ambiente efetivo de cada container do compose **antes** do `up`.

A **saga de onboarding** (17 estados, 11 passos, readiness canônico com 17 códigos) está
implementada e testada, mas **só 2 passos são alcançáveis em runtime** (via
`POST /setup/bootstrap`). Os outros 9 só rodam em teste, e **não existe comando que emita a
credencial de bootstrap** — a única forma é SQL ad hoc.

**Backup** é o subsistema operacional mais completo: `pg_dump` → catálogo → checksum →
envelope AES-256-GCM → upload S3 com verificação por checksum do provedor → manifesto v2
assinado em HMAC-SHA256, mais drill de restore horário com teardown provado e RPO/RTO
expostos em `/metrics`. Ressalvas: `BACKUP_ENCRYPTION_MODE` default é `'none'` (produção é
forçada pelo gate de boot), o RPO real é **24h** (um dump noturno; não há PITR/WAL
archiving), e a chave que assina manifestos é derivada do mesmo master secret do
runtime-trace.

**Privacidade/LGPD**: o workflow existe (tombstone antes da exclusão, export cifrado com
TTL de 7 dias varrido por cron, reconciliação pós-restore que bloqueia o tráfego se um
tombstone foi adulterado), mas **nenhuma linha de código cria ou aprova `privacy_requests`
nem `legal_holds`** — só `UPDATE`. 7 das 14 classes de dado são recusadas pelo executor, e
a matriz de retenção é **DRAFT pendente de DPO**: nenhuma classe é purgável e não existe
job de purga por classe. A execução de exclusão nunca foi exercida contra banco real.

### 4.11 Importação, infra, CI e testes

**Importação OFX/CSV existe só como CLI.** Dois parsers regex (OFX 1.x/2.x genérico; CSV
com 2 perfis hardcoded — Inter e Itaú), um reconciliador que pontua contra `transacoes`
(≥0.9 casado, ≥0.6 candidato) e grava em `pending_review`. **Nenhum tool, worker, router ou
fluxo WhatsApp lê essas tabelas** — mas a CLI imprime "abra o app e revise pelo WhatsApp".
CSV com header desconhecido produz 0 lançamentos em silêncio.

**Deploy**: `compose.prod.yml` com 6 serviços, todos uid 1001, rootfs read-only, `cap_drop
ALL`, **sem porta publicada** (proxy externo, não versionado no repo). O job `migrate` é
one-shot, recebe só o subset `migrator` do contrato, e app/admin-ui dependem dele com
`service_completed_successfully` — não existe passo manual de migration no deploy.

**CI**: 9 jobs, todos bloqueantes, sem `needs:`. Além do óbvio: gate de corpo de PR (8
seções obrigatórias), gate de trailers de coautoria de IA, ledger de exceções do `npm
audit` (hoje vazio), smoke da imagem real do `migrate`, `promtool` nas regras de alerta,
round-trip do `drizzle-kit` e build + Playwright do console. Pisos de volume por lane
(`--min`, `--max-pulados 0`) — exceto a lane unit, que **não tem piso**.

`monitoring/` traz 47 alertas + 22 recording rules e 3 dashboards Grafana versionados,
validados no CI. Nenhum compose sobe Prometheus/Grafana — a carga é externa.

Os **18 scripts de acceptance gates por fase não rodam no CI** e ao menos `p10b` e `p9a`
reprovam hoje, porque fazem `grep` por identificadores que já saíram do código.

---

## 5. Catálogo completo de tools (65)

Legenda de efeito: `none` (sem efeito) · `read` · `write` · `communication`.
"Pack" é o que decide a visibilidade: o agente só vê a interseção do seu grant com o papel
ativo, o escopo da skill e a permissão humana.

### Finanças PF/PJ — `domain.finance` (9)

| Tool | O que faz | Efeito | Confirmação |
|---|---|---|---|
| `register_transaction` | Registra receita/despesa/movimentação; dedup trigram, saldo e audit na mesma tx | write / compensável | por faixa de valor + dual em PIX/TED |
| `cancel_transaction` | Marca `cancelada` (nunca apaga) | write / idempotente | sim |
| `query_balance` | Saldo das contas de uma entidade | read | — (marcada `sensitive`) |
| `list_transactions` | Lista com filtros | read | — |
| `classify_transaction` | Sugere categoria por regras aprendidas + trigram | read | — |
| `identify_entity` | Resolve qual entidade o usuário mencionou | read | — |
| `compare_entities` | Comparativo entre entidades num período | read | — (`sensitive`) |
| `start_recurring_payment` | Série recorrente com pergunta sim/não/adiar | write | — |
| `generate_report` | Extrato/comparativo em PDF | read | — (**só com `FEATURE_PDF_REPORTS`**) |

### Baseline — `baseline.core`, todo agente tem (10)

| Tool | O que faz | Efeito |
|---|---|---|
| `read_turn_context` | Lê mensagens recentes do turno | none |
| `remember_safe_fact` | Registra fato seguro sobre o interlocutor | write / idempotente |
| `request_confirmation` | Pede "sim" explícito sem executar | none |
| `handoff_to_owner` | Escala ao dono (**só audita — não notifica ninguém**) | communication |
| `audit_decision` | Registra a decisão na auditoria | none |
| `explain_limitation` | Explica o que não pode fazer | none |
| `recall_memory` | Busca memórias por similaridade semântica | read |
| `risk_signal_classify` | Risco heurístico do turno, sem LLM | none |
| `conversation_summary_compose` | Resumo estruturado sem persistir | none |
| `conversation_state_update` | Merge atômico de `metadata.agent_state` | write / idempotente |

### Agenda e feriados — `domain.calendar` (7 + 1 admin)

`calendar_is_business_day`, `calendar_next_holiday`, `calendar_list_holidays`,
`calendar_business_days_between`, `calendar_add_business_days` (5 leituras),
`schedule_reminder`, `cancel_reminder`, `set_interlocutor_timezone` (writes).
`register_custom_holiday` fica no pack `domain.calendar.admin`, concedido à parte.

### Conversa, pendências, workflow — `domain.support` / `domain.operations` (3)

`list_pending`, `ask_pending_question` (cria pergunta persistida com 2–12 opções),
`start_workflow` (**cria workflows que nunca avançam**).

### Proativo e vendas — `domain.sales` (3)

`send_proactive_message` (dual approval sempre, exceto para dono; único caso com
`extractEffect` — vai ao outbox de efeitos e é entregue exatamente uma vez),
`start_recurring_outreach`, `identify_entity`.

### Vertical cobrança/boleto/reembolso — 6 packs (19)

| Tool | Status | Nota |
|---|---|---|
| `company_identity_resolver` | **real** | lê `contrapartes` |
| `company_search` | **real** | lê `contrapartes` |
| `conversation_attachment_lookup` | **real** | lista anexos da conversa |
| `receipt_validate` | **real** | delega OCR a `parse_receipt` |
| `bank_account_validate` | **real** | checksum CPF/CNPJ/PIX, sem banco |
| `conversation_summary_generate` | **real** | sumarizador compartilhado |
| `legal_intent_detect` | **real** | léxico determinístico |
| `case_risk_classify` | **real** | scorer compartilhado |
| `company_history_lookup` | **stub** | devolve listas vazias |
| `company_blacklist_check` | **stub** | sempre `unknown`, nunca `clear` |
| `boleto_search` | **stub** | `{ boletos: [] }` |
| `boleto_cancel` | **stub** | `executed=false` (write, dual approval) |
| `dda_lookup` | **stub** | `unknown` |
| `payment_verification` | **stub** | `paid=null` |
| `campaign_status_lookup` | **stub** | `unknown` |
| `company_campaign_remove` | **stub** | `executed=false` (write, dual approval) |
| `refund_create` | **stub** | `executed=false` (write, dual approval) |
| `refund_lookup` | **stub** | `found=false` |
| `operational_ticket_create` | **stub** | `created=false` |

**11 de 19 são stubs honestos (#432).** Não há integração real com provedor de boleto, DDA,
reconciliação de pagamento, blocklist, campanhas, reembolsos ou ticketing.

### Fora de qualquer pack — invisíveis no caminho WhatsApp (13)

Este é um achado consequente. Estas 13 tools estão registradas, mas **não pertencem a
nenhum pack**, e a UI do console só edita `granted_packs`/`denied_tools`. Na prática são
invisíveis ao modelo e recusadas pelo dispatcher com `tool_not_granted`:

`parse_boleto` · `parse_receipt` · `parse_image` · `transcribe_audio` ·
`save_fact` · `save_rule` (deprecated) · `propose_fact` · `propose_rule` ·
`propose_memory` · `propose_hint` · `approve_capability_proposal` ·
`reject_capability_proposal` · `list_pending_proposals`

Ou seja: **todo o grupo de OCR e áudio, e todo o grupo de proposição de conhecimento
(Knowledge State Machine), estão fora do alcance do agente pelo caminho normal de grants.**

### MCP bridge

Servidores MCP externos viram tools `mcp:<server>:<tool>`: o worker `mcp_sync` descobre,
o dono aprova no console e concede o pack `mcp.<server>`. Limites: máximo 10 tools
visíveis, resultado truncado em 32 KiB, timeout 15s, **só read-only**, guard anti-SSRF.
Atrás de `FEATURE_MCP_TOOLS=false` e **proibido em produção** por regra de boot.

### Divisão

**31 tools do vertical financeiro** (9 finanças + 3 OCR + 19 cobrança) contra
**34 de plataforma**.

---

## 6. Catálogo completo de workers (49)

### Ligados por default (30)

| Worker | Cron | O que faz |
|---|---|---|
| `health_monitor` | `*/1 * * * *` | snapshot de saúde dos componentes + alerta down/degraded |
| `audit_watcher` | `*/1 * * * *` | regras de anomalia sobre `audit_log`, throttle 30min |
| `dlq_monitor` | `*/5 * * * *` | conta `dead_letter_jobs` e alerta (dedup Redis 1h) |
| `cost_monitor` | `30 2 * * *` | custo LLM do dia anterior vs `DAILY_LLM_USD_THRESHOLD` |
| `trace_body_writer` | `* * * * *` | drena `runtime_trace_body_outbox` |
| `trace_body_recoverer` | `*/5 * * * *` | recupera corpos de trace órfãos |
| `trace_matview_refresh` | `*/5 * * * *` | `REFRESH` de `unified_trace_events` |
| `pending_expirer` | `*/1 * * * *` | expira `pending_questions` e dual approvals |
| `message_recovery` | `*/2 * * * *` | re-enfileira turnos presos; reconcilia projeção legada |
| `stream_debounce_closer` | `* * * * *` | **no-op** (`FEATURE_MESSAGE_DEBOUNCE=false`) |
| `pending_reminder` | `*/30 * * * *` | **no-op** (`FEATURE_PENDING_REMINDER=false`) |
| `unrouted_recovery` | `* * * * *` | expira staging de inbound não-roteado (TTL 72h) |
| `workflow_engine_tick` | `*/30s` | expira `approval_requests` por tenant |
| `audit_mode_expirer` | `*/15 * * * *` | zera preferência de audit-mode vencida |
| `scheduling_tick` | `* * * * *` | avança ocorrências (claim 20/tick, lease 300s) |
| `outbox_drain` | `* * * * *` | entrega `outbox_messages` (50 rows, 5 passes, rate gate) |
| `series_next_scheduler` | `*/10 * * * *` | backfill da próxima ocorrência de séries ativas |
| `mcp_sync` | `* * * * *` | **no-op** (`FEATURE_MCP_TOOLS=false`) |
| `channel_pairing` | `*/5s` | executa a `PairingSession` Baileys pedida pelo console |
| `synthetic_probe` | `*/10 * * * *` | **no-op** (`MAIA_SYNTHETIC_PROBE=false`) |
| `outbound_messages_sweeper` | `*/5 * * * *` | housekeeping do ledger legado |
| `outbound_recovery` | `* * * * *` | **no-op** (`FEATURE_OUTBOUND_RECOVERY=false`) |
| `idempotency_outbox_relayer` | `*/1 * * * *` | despacha efeitos externos exatamente uma vez |
| `onboarding_expirer` | `*/5 * * * *` | cancela runs de onboarding vencidas |
| `idempotency_cleanup` | `0 4 * * *` | DELETE por idade em `idempotency_keys` |
| `inactivity_sweep` | `0 3 * * *` | revoga permissões inativas |
| `nightly_backup` | `0 3 * * *` | `pg_dump` + cifra + upload + manifesto |
| `backup_retention` | `0 4 * * 0` | planeja deleções (**dry-run por default**) |
| `privacy_export_sweep` | `50 * * * *` | TTL dos pacotes de export LGPD |
| `restore_drill` | `40 * * * *` | dispara drill quando a evidência está a 75% do intervalo |

### Desligados por default (19)

**`cognition` (7)**: `conversation_summarizer`, `reflection_batch`, `pattern_detector`,
`legacy_memory_reclassifier`, `confidence_recompute`, `procedure_candidate_consumer`,
`knowledge_state_promoter`.

**`proactive` (4)**: `briefing_morning` (08:00), `briefing_evening` (21:00),
`briefing_weekly` (seg 08:00), `drift_monitor` (dom 03:00).

**`governance` (3)**: `gap_escalation_monitor`, `tool_request_issue_relayer`,
`tool_request_closure_monitor`.

**`console` (3)**: `playground_turn_drain`, `objective_perceive`, `objective_execute`.

**`procedures` (2)**: `procedure_execution_reaper`, `procedure_metrics_refresh`.

### Fora do registro

3 consumidores BullMQ em `src/gateway/queue.ts` (`agent`, `unrouted-replay`,
`outbound-delivery` — o último sob flag). `behavioral-hint-validator.ts` mora em
`src/workers/` mas é biblioteca, não job. `soul-bias-activator.ts` é **código morto**.

**9 jobs side-effectful não têm claim nem lock** (todos em grupos default-off) — com duas
réplicas de scheduler, duplicam efeito. Rastreado na #513.

---

## 7. Modelo de dados (106 tabelas)

| Domínio | Tabelas |
|---|---|
| **Tenancy, agentes, canais, pessoas** (13) | `tenants`, `agents`, `channels`, `channel_line_state`, `roles`, `channel_policies`, `role_selector_decisions`, `inbound_unrouted`, `pessoas`, `agent_audience_profiles`, `agent_tool_grants`, `permission_profiles`, `permissoes` |
| **Conversas e turnos** (7) | `conversas`, `mensagens`, `agent_turns` (38 colunas), `agent_turn_inputs`, `agent_stream_sequences`, `agent_stream_blocks`, `pending_questions` |
| **Memória e conhecimento** (8) | `agent_facts`, `learned_rules`, `memory_entry`, `behavioral_hint`, `agent_memories` (pgvector 1024), `cognitive_candidates`, `cognitive_module_log`, `self_state` |
| **Identidade e drift** (3) | `agent_operational_profile_versions`, `soul_biases`, `agent_drift_alerts` |
| **Capacidades, skills, procedures** (19 + 1 mv) | `agent_capabilities_domain`, `agent_capabilities_skill`, `agent_capability_gaps`, `agent_capability_gap_observations`, `gap_escalation_rules`, `capability_proposals`, `capability_test_results`, `tool_request_aggregates`, `tool_request_aggregate_members`, `tool_request_issues`, `tool_request_notifications`, `skills`, `procedure_definitions`, `procedure_assignments`, `procedure_status_events`, `procedure_executions`, `procedure_execution_events`, `procedure_selector_decisions`, `procedure_tests`, `procedure_metrics` (mv) |
| **Governança, admin, idempotência** (13) | `audit_log`, `admin_audit_log`, `approval_requests`, `approval_decisions`, `proposal_approvals`, `policy_rules`, `app_users`, `app_sessions`, `debug_snapshot_grants`, `global_settings`, `idempotency_keys`, `workflows`, `workflow_steps` |
| **Finanças e calendário** (12) | `entidades`, `contas_bancarias`, `categorias`, `transacoes`, `transferencias_internas` (morta), `recorrencias` (morta), `contrapartes`, `import_runs`, `import_entries`, `entity_states`, `holidays`, `holiday_entidades` |
| **Agendamento e objetivos** (5) | `series`, `occurrences`, `tasks`, `agent_objectives`, `objective_tasks` |
| **Saída** (3) | `outbound_messages`, `outbox_messages`, `idempotency_effect_outbox` |
| **Onboarding e bootstrap** (5) | `onboarding_runs`, `onboarding_events`, `onboarding_step_results`, `bootstrap_credentials`, `bootstrap_completions` |
| **Operações** (11) | `backup_runs`, `backup_manifests`, `restore_drills`, `legal_holds`, `privacy_requests`, `data_tombstones`, `retention_runs`, `system_health_events`, `dead_letter_jobs`, `synthetic_probe_runs`, `synthetic_probe_state` |
| **Console** (4) | `playground_sessions`, `playground_turns`, `mcp_servers`, `mcp_server_tools` |
| **Traces** (3 + 1 mv) | `runtime_trace_envelopes`, `runtime_trace_bodies`, `runtime_trace_body_outbox`, `unified_trace_events` (mv) |

Só no SQL, fora do Drizzle: `schema_migrations` (ledger), mais duas tabelas de backup de
migration (063, 091) que nenhum código lê.

---

## 8. O produto para quem usa

**A persona.** `src/identity/maia-prompt.md` (153 linhas) define a Maia como assistente
financeira pessoal de um dono e suas 8 empresas: separação PF/PJ acima de tudo, confirmar
antes de agir, direta e sem floreio, aprender com correções, nunca apagar (só cancelar),
nunca lançar acima de R$ 10.000 sem confirmação. **O arquivo é seed, não runtime**: entra
cru em `self_state` e só é usado como fallback quando não há perfil operacional v2. Os
thresholds reais do código são outros (1.000 / 20.000 / 50.000) e o registry tem 65 tools,
não as 13 que o prompt lista.

**Jornadas que funcionam de ponta a ponta hoje** (com o pack `domain.finance` concedido):

1. **"R$ 50 mercado"** → `register_transaction` com dedup semântico, saldo creditado e
   audit na mesma transação → confirmação com o `transacao_id` real. Coberto por teste E2E.
2. **"R$ 25 mil para o fornecedor"** → abre `approval_request AP-xxxxxxxx` e **não lança**;
   o dono responde `aprova AP-xxxxxxxx` e o parser determinístico resolve antes do LLM.
   Coberto por teste E2E com controle positivo.
3. **Número desconhecido escreve** → quarentena, mensagem de espera ao contato e pergunta
   ao dono; o dono libera ou bloqueia. Coberto por teste E2E.
4. **Foto de boleto ou comprovante** → `conversation_attachment_lookup` →
   `parse_image`/`parse_boleto`/`parse_receipt` (Claude Vision, com cache por tenant).
   ⚠️ Sem teste E2E, e as tools de OCR **não estão em nenhum pack**.
5. **Áudio** → `transcribe_audio` (Whisper). Não há transcrição automática pré-LLM: o
   modelo precisa chamar a tool. ⚠️ Mesma questão de pack.
6. **Lembrete e pagamento recorrente** → série + ocorrência + outbox, entregue pelo
   `outbox_drain`. ⚠️ A resposta "sim/não/adiar" só é resolvida deterministicamente com
   `FEATURE_PENDING_GATE=true` (default `false`).

**O modelo de negócio do vertical**: entidades (PF/PJ) com cidade/UF para feriados
regionais, contas bancárias, 25 categorias seedadas, contrapartes, e **7 perfis de
permissão**: `dono_total` (`*`), `co_dono` (entra no 4-eyes), `contador_leitura` (limite 0),
`operador_basico` (R$ 200), `operador_avancado` (R$ 1.000), `leitor`, `contato`.
Calendário brasileiro completo (9 feriados fixos + 5 móveis por Páscoa, seed 2025–2035,
regionais e custom por entidade).

**O que não existe:** tela de administração financeira. Entidades, contas, pessoas e
permissões só entram por CLI (`npm run setup`, `npm run pessoa:add`). O console não tem
router de transações.

**Briefings proativos** (matinal, noturno, semanal) estão implementados com dedup por
período+dia+pessoa — e **nunca disparam no default**, porque vivem no grupo `proactive`.

**O piloto de cobrança (ADR 0006): zero código.** Existe o work loop v1 com lease, fencing
e reaper, mas o único kind é `manual`. Faltam: vínculo contraparte→telefone, `data_vencimento`
em `transacoes`, opt-out durável, gate de horário para saída, cadência, holdout, ledger de
liquidação. A spec está marcada "IMPLEMENTAÇÃO BLOQUEADA" por 3 perguntas sem assinatura.

---

## 9. Feature flags — o que está desligado

**33 flags `FEATURE_*` no contrato: 11 ON, 22 OFF.** Mais 5 tombstones (setar reprova o
boot) e 3 flags declaradas **sem nenhum leitor no código**.

### Ligadas por default (11)

`FEATURE_TURN_STATE_MACHINE` · `FEATURE_TURN_STATE_AUTHORITATIVE` · `FEATURE_TURN_CLAIM` ·
`FEATURE_TURN_STREAM_KEY` · `FEATURE_TURN_HEAD_OF_LINE` · `FEATURE_TURN_STREAM_PROMOTION` ·
`FEATURE_TURN_STREAM_DEBOUNCE` (inerte, ver abaixo) · `FEATURE_OUTBOUND_DURABLE_COMMIT` ·
`FEATURE_STRICT_TOOL_SCHEMAS` · `FEATURE_PROCEDURE_RUNTIME` (**sem leitor**) ·
`FEATURE_ADMIN_UI_BULK_REJECT` (**sem efeito**).

### Desligadas — e o que cada uma custa

| Flag | O que fica de fora |
|---|---|
| `FEATURE_PENDING_GATE` | resposta digitada a uma pergunta pendente vira comando novo |
| `FEATURE_MESSAGE_DEBOUNCE` | mensagens picotadas viram turnos separados; **torna inerte o debounce transacional (que está ON) e seu worker** |
| `FEATURE_PDF_REPORTS` | `generate_report` some do registry (mas o pack `domain.finance` continua prometendo) |
| `FEATURE_MCP_TOOLS` | tools MCP externas; **proibida em produção** por regra de boot |
| `FEATURE_RUNTIME_TRACE_V1` | **não há trace de compliance**; 3 workers rodam vazios |
| `FEATURE_OUTBOUND_DELIVERY_WORKER` | ninguém consome a fila de entrega; envio é inline |
| `FEATURE_OUTBOUND_RECOVERY` | nada rearma uma entrega presa (só `npm run dlq`) |
| `FEATURE_TURN_CONTEXT_CACHE` | cache de identidade por turno (custo de latência) |
| `FEATURE_TURN_JOB_V2` | payload de job com `turn_id` |
| `FEATURE_ONE_TAP`, `FEATURE_PRESENCE`, `FEATURE_MESSAGE_UPDATE`, `FEATURE_VIEW_ONCE_SENSITIVE`, `FEATURE_OUTBOUND_VOICE`, `FEATURE_PENDING_REMINDER` | UX do WhatsApp: reação/enquete, typing, edição, resposta efêmera, voz, lembrete |
| `MAIA_MULTI_LINE` | uma sessão Baileys por canal |
| `MAIA_SYNTHETIC_PROBE` | sonda sintética ponta a ponta |
| `LLM_DAILY_BUDGET_USD=0` | **nenhuma chamada é recusada por custo** |
| `LLM_CIRCUIT_MODE=shadow` | disjuntor mede mas **nunca recusa** |
| `RETENTION_DRY_RUN=true` | retenção conta, não apaga |
| `BACKUP_ENCRYPTION_MODE=none` | backup em claro fora de produção |
| `MAIA_SCHEDULER_GROUPS=''` | **19 dos 49 workers** |

### Flags sem leitor (ruído de configuração)

`FEATURE_PROACTIVE_MESSAGES` · `FEATURE_OFX_IMPORT` · `FEATURE_PROCEDURE_RUNTIME` ·
`FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS` · `FEATURE_ADMIN_UI_BULK_REJECT` ·
`FEATURE_ADMIN_UI_REDECIDE`.

### Não existem (apesar de citadas)

`MULTI_AGENT_SELECTOR_V2` (só comentário em `agent-selector.ts:6,28`),
`FEATURE_DECISION_ENGINE_V1`, `FEATURE_SOUL_LAYER_V1`, `FEATURE_POLICY_RESOLVER_V1`,
`FEATURE_SKILL_REGISTRY_V1`, `FEATURE_KNOWLEDGE_STATE_MACHINE_V1`, `FEATURE_CALENDAR_V2`.
Todos viraram caminhos always-on.

---

## 10. Drift entre documentação e código

| Afirmação | Onde | Realidade |
|---|---|---|
| `tenant_id='default'` | `README.md:16,22,25,42,150,431`; `AGENTS.md:96` | `'primary'` desde a #323; `'default'` é **rejeitado fail-closed** (`MAIA_REJECT_DEFAULT_LITERAL` default ON). `ARCHITECTURE.md:9` já diz certo — **os dois docs raiz se contradizem** |
| "152 migrations" | `README.md:121,382` | **145** forward (+145 down); prefixo máx. 138 |
| "33 workers" | `README.md`; `ARCHITECTURE.md:137` | **49** jobs em 46 módulos, 12 grupos |
| "16 tRPC routers" | `README.md:104,121`; `ARCHITECTURE.md:80,112` | **21** montados; faltam `channelLines`, `mcp`, `objectives`, `playground`, `toolRequests` |
| "Next.js 14" | `README.md:102,222`; `CONTRIBUTING.md:133` | **16.3.2** |
| "392 test/spec files" | `README.md:121` | **924** |
| **"Gaps #229 e #230 abertos" — pilares 3 e 7 🔴** | `README.md:25,42,414,437-438` | **Fechados em 2026-05-28** (PRs #237/#232). `vector.ts` escopa no INSERT e no WHERE; `rulesRepo` pina tenant+agent nos mutators |
| "P3c parcial (matview, test runner, step-evaluator)" | `README.md:45,393,447` | A matview existe com worker; `runProcedureTest` existe; o step-evaluator trata os 5 tipos. **O gap é de wiring, não de implementação** |
| "MULTI_AGENT_SELECTOR_V2 reservado" | `README.md:16,26,445` | **Não existe no contrato.** O multi-agente real é `MAIA_CHANNEL_ROUTING_MODE` (shadow/exact_first/strict), que o README não menciona |
| "Provisionamento de tenants pela UI em iteração" | `README.md:162` | `tenants.create` e a tela `/setup/tenants` existem e funcionam. O que **não** existe é criação de `app_users` |
| "Drift: alertas, resolução, histórico" | `README.md:237` | Router devolve `[]` hardcoded |
| "Dashboard: execuções, drift, custo" | `README.md:241` | Sem custo e sem execuções |
| "Versions via `react-diff-viewer-continued`" | `README.md:238` | Dependência removida; diff é JSON bruto |
| "5 camadas de memória são fachadas do runtime" | `memory.md`; `ARCHITECTURE.md:124` | **3 das 5 não têm chamador**; `agent_episodes` e `agent_rules` não existem no schema |
| "Context packet remontado por turno" | `runtime.md:5` | **Não é montado em turno nenhum** |
| "Late PEP roda na Camada 5" | `decision-engine.ts:6-8`; `p9d-policy-dsl.md` | Código morto |
| "Decision Engine gated por flag, budget 400ms" | `p9b-decision-engine.md:31,33` | Always-on, budget **2.500ms** |
| "Auth de produção não implementada" | `p8.5-admin-ui.md` | OIDC existe e é **obrigatório** em staging/produção |
| "Repositórios são a única interface sancionada" | `db.md:152` | **60 arquivos** fora de `src/db/` importam o client direto |
| "24 subdiretórios em `src/`, um doc cada" | `AGENTS.md:56` | **30 subdirs**, 28 docs; `src/observability/` e `src/probe/` sem doc |
| "Last verified 2026-05-28 / revalidar em 30 dias" | `ARCHITECTURE.md`, `AGENTS.md`, 20 docs de módulo | **103 dias.** 29 de 36 docs de arquitetura estão vencidos pela regra deles mesmos |

---

## 11. Gaps e riscos, por severidade

### Alto

1. **Nenhum trace de compliance em produção.** `FEATURE_RUNTIME_TRACE_V1=false` em todos
   os fixtures. O envelope HMAC existe, os 3 workers rodam — vazios.
   `src/config/generated/fixtures/production.env:156`
2. **A saída do LLM não passa por nenhuma política.** Late PEP é código morto; Early PEP
   nunca avalia DSL; só 2 descriptors chegam ao Mid PEP.
   `src/runtime/guardrails/late-pep.ts:24` (sem importador)
3. **Conhecimento proposto pelo LLM fica preso para sempre.** Toda regra entra em
   `pending_review` e não há caminho humano de saída; o console devolve
   `source_not_supported`. `src/db/repositories/admin-repos.ts:788`
4. **Sem recusa por custo nem por queda de provider.** `LLM_DAILY_BUDGET_USD=0` e
   `LLM_CIRCUIT_MODE=shadow`. Redis fora do ar = fail-open no orçamento.
5. **Exclusão LGPD nunca foi executada contra banco real** e não há código que crie ou
   aprove `privacy_requests`/`legal_holds`. 7 de 14 classes são recusadas pelo executor.
6. **Falha do reasoner é silenciosa para o usuário** — 3 tentativas e dead-letter sem
   nenhuma mensagem.

### Médio

7. **13 tools fora de qualquer pack** (todo o OCR/áudio e todo o KSM) são invisíveis e
   recusadas com `tool_not_granted`.
8. **`domain.finance` não é concedido por default** — o vertical inteiro depende de uma
   ação manual no console.
9. **8 das 11 baseline skills nunca executam** (`tool_mediated` é inalcançável).
10. **Envio inline sem worker de recovery**: falha depois do commit exige intervenção
    manual (`npm run dlq outbound-rearm`).
11. **`tool_result` sem teto de bytes** nas tools nativas.
12. **9 workers side-effectful sem lock** duplicam efeito com 2 réplicas (#513).
13. **RPO real de 24h** — um dump noturno, sem PITR/WAL archiving.
14. **A mesma chave** assina manifestos de backup e o ledger de tombstones.
15. **Credencial de bootstrap sem comando de emissão** — a rota `/setup/bootstrap` é
    inutilizável sem SQL ad hoc.

### Baixo, mas vale registrar

16. Byte NUL literal commitado em `src/db/repositories/cognitive-repos.ts` faz `rg`/`grep`
    tratarem o arquivo como binário e **pularem-no silenciosamente** em buscas.
17. A lane unit do CI não tem piso de volume — um `describe.skip` global passaria verde.
18. 18 scripts de acceptance gate não rodam no CI e ao menos 2 reprovariam hoje.
19. `npm run db:seed` é um placeholder que só imprime uma linha.
20. Sem release desde 2026-05-20: 65 entradas em `[Unreleased]`, várias marcadas
    "MUDANÇA DE COMPORTAMENTO".
21. Fault injection cobre 14 de 25 cenários.

---

## 12. Entregas recentes (2026-08-29 → 09-08 e `[Unreleased]`)

O clone é raso (50 commits), então isto vem do CHANGELOG cruzado com o git log.

**Governança e isolamento de tenant**
`#738/#744` `resolveScope` sem teto de 500 profiles · `#720/#728/#758` `import:ofx`
escopada por tenant (estava morta desde a migration 083) · `#536/#732/#737` matriz de
retenção ratificada + trava de homologação no boot · `#691` expiração de dual approval
manda uma mensagem, não duas.

**Egresso durável (#506, fatias A–F)**
`#630` outbox durável · `#631` commit antes do canal · `#632` dono da entrega ·
`#633` consumidor + recovery + DLQ · `#634` trava de envio direto · `#635` histórico
idempotente · `#688` seis auditorias transacionais · `#692/#731` inventário de exceções
de egresso com prazo.

**Ordenação e confiabilidade do turno (#505, fatias B–F)**
`#625` um turno ativo por conversa · `#626` head-of-line · `#627` promoção do sucessor ·
`#628` debounce transacional · `#629` poison/DLQ (fecha a épica) · `#504` claim/lease/
fencing · `#696` lease e reaper do work loop · `#513` grupos de scheduler explícitos.

**Migrations e boot**
`#733/#759` guard `no-transaction` imposto na descoberta · `#658` índice `CONCURRENTLY` ·
`#516` boot mata com exit code específico · `#565` subset `migrator` · `#705/#730` bancada
do drill sem tocar staging.

**Observabilidade e desempenho**
`#535` spans reais + A/B de overhead OTLP + margem de 10% como orçamento de regressão ·
`#525/#700/#760` gate do turno medindo `resolveScope` acima do teto antigo.

**Testes e CI**
`#510` fault injection no CI · `#703/#729/#701` 3 jornadas E2E de backend (rodavam zero até
31/08) · `#623` console fora da quarentena · `#727` teto de pulados · `#735` gate de
coautoria de IA.

**Dependências**
`#757` Dependabot desligado · `#734` audit com zero exceções · `#746` majors de Node e
TypeScript viram migração própria (`#743` Node 26, `#745` TS 7) · zod 4.5.4 no console.

---

## 13. Planejado, sem código

- **Piloto de cobrança** (`docs/superpowers/specs/2026-07-31-collections-work-loop-design.md`)
  — marcado "IMPLEMENTAÇÃO BLOQUEADA"; ADR 0006 tem 12 decisões abertas, 3 sem assinatura.
- **Multi-agente por turno** — não há flag; o `agent-selector` é no-op.
- **Gateways não-WhatsApp** — só literais de tipo.
- **DAG topológico e paralelização ampla** no grafo cognitivo — hoje só paraleliza nós
  marcados `parallelizable` no batch `SYNC_CONDITIONAL`.
- **UI da saga de onboarding** — backend entregue (#519), sem console.
- **Purga por classe de dado** — a matriz é DRAFT e não existe job.
- **PITR / WAL archiving** — o RPO é um dump noturno.
- **`tool_mediated` no caminho de produção** — falta injetar o `ToolDispatcher`.
- **Aprovação humana no KSM** — falta a tabela e o caminho no console.

---

## 14. Como confirmar cada afirmação

Todos os números desta análise saem de comandos reproduzíveis:

```bash
grep -c 'pgTable(' src/db/schema.ts                    # 106
ls migrations/*.sql | grep -v _down | wc -l            # 145
grep -cE "^\s+name: '" src/workers/index.ts            # 49
grep -cE "^  [A-Z][A-Z0-9_]+: \{" src/config/contract.ts  # 212
find tests -name '*.spec.ts*' | wc -l                  # 924
grep -cE '^  [a-zA-Z]+: [a-zA-Z]+Router,' src/admin-ui/trpc/routers/_app.ts  # 21
grep -cE '^  FEATURE_[A-Z0-9_]+: \{' src/config/contract.ts  # 33 (+5 tombstones)
grep -c 'MULTI_AGENT_SELECTOR_V2' src/config/contract.ts  # 0
grep -n 'BASE_AGENT_PACKS' src/tools/base-agent-packs.ts  # baseline.core + domain.calendar
grep -n 'tenant_id' src/memory/vector.ts               # #229 fechada
```

Uma ressalva de método: o clone desta análise é raso (50 commits, 2026-08-29 em diante),
então a seção 12 vem do CHANGELOG cruzado com o log disponível, e os HEADs citados nos
rodapés "Last verified" dos docs não são alcançáveis para conferência.
