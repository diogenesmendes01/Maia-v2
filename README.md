# Maia

> **Plataforma multi-agente governada via WhatsApp.**
> Agentes que aprendem habilidades e ferramentas — para pessoas e empresas —
> dentro de governança, escopo e evidência.

[![Node](https://img.shields.io/badge/node-20%2B-green)]()
[![TypeScript](https://img.shields.io/badge/typescript-5%2B-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🧭 **Frase-mãe**
> *"Agentes na Maia aprendem com a experiência, mas só evoluem
>  dentro de governança, escopo e evidência."*

> ⚠️ **Status do produto.** Plataforma em construção. O schema é multi-tenant + multi-agente, mas o runtime opera hoje com `tenant_id='default'` e `agent-selector` no-op (`MULTI_AGENT_SELECTOR_V2` reservado pro futuro). Pilares marcados 🔴 têm gap conhecido (issues abertas). Detalhes em [Estado atual & gaps conhecidos](#estado-atual--gaps-conhecidos).

---

## O que é

**Maia é a plataforma** — não um agente. O **objetivo arquitetural** é que cada tenant (pessoa ou empresa) opere seus próprios agentes dentro dela, conversando por WhatsApp, com identidade versionada e capacidades que crescem sob aprovação. Hoje opera em modo single-tenant (`'default'`) com 1 agente Maia atendendo via channel policy; a infra multi-tenant/multi-agente está no schema, gated por feature flag no runtime.

- **Maia é o projeto / a plataforma.** Os agentes têm nome próprio, definido pelo tenant.
- **Multi-tenant por design, single-tenant em produção hoje** — schema, índices e tenant-guard nas queries principais; runtime ainda opera com `tenant_id='default'`. Isolamento é o **objetivo** com 2 gaps rastreados ([#229](https://github.com/diogenesmendes01/Maia-v2/issues/229), [#230](https://github.com/diogenesmendes01/Maia-v2/issues/230)).
- **Multi-agente por design** — `Agent ≠ Channel ≠ Role`; `channel_policies` define qual agente atende qual canal. Hoje: 1 agente por canal via policy (`agent-selector` é no-op). Seleção dinâmica reservada pra `MULTI_AGENT_SELECTOR_V2`.
- **Agentes aprendem habilidades e ferramentas** — `capability-proposer` / `skill-proposer` em produção; owner aprova via admin-ui.
- **Pessoal e corporativo** — vertical único hoje (finanças PF + PJ do owner); arquitetura genérica.
- **WhatsApp como canal habilitado, multi-canal por design** — texto, áudio e foto via Baileys; tabelas `channels` / `channel_policies` / `roles` no schema, gateways adicionais não implementados ainda.

---

## Os 9 pilares

> **Legenda:** ✅ implementado e em produção · 🚧 parcial / em iteração · 🔴 implementado **com gap conhecido** (issue aberta) · ⏳ roadmap.

| # | Pilar | O que faz | Status |
|---|---|---|---|
| 1 | **Agentes que aprendem** | `capability-proposer`, `skill-proposer`, aquisição dialógica em 4 níveis (silent → dashboard → mentionable → proposed). A plataforma propõe; owner decide. | ✅ |
| 2 | **Governança versionada** | Identidade operacional em 4 camadas (núcleo imutável / perfil aprendido / episódica / backlog). Toda evolução tem aprovação e versão. | ✅ |
| 3 | **Isolamento como objetivo (com gaps)** | `tenant_id`/`agent_id` NOT NULL nas tabelas centrais, tenant-guard middleware no caminho principal de queries. **Gaps em vector memory ([#229](https://github.com/diogenesmendes01/Maia-v2/issues/229)) e procedural memory ([#230](https://github.com/diogenesmendes01/Maia-v2/issues/230))** — recall/mutações sem escopo. Runtime opera single-tenant via `'default'`. | 🔴 |
| 4 | **Cognitive graph** | Orquestração como grafo leve: pre-turn + post-turn, com `runWhen`/`timeout`/`fallback`/`model`/`version` por node. P7 refactor total ainda parcial. | 🚧 |
| 5 | **Self-model + reflexão tipada** | Modelo de si em 3 camadas (domínio/skill/gap), confiança determinística sobre evidência. Toda reflexão vira candidato classificado em fato / regra / procedimento / lacuna / tool-request / descarte. | ✅ |
| 6 | **Skills + Procedures executáveis** | O que um agente aprende vira artefato versionado, event-sourced, com success criteria tipados e métricas derivadas. P3a/b em produção; P3c (test runner completo, view materializada) parcial. | 🚧 |
| 7 | **Memória escopada (com gaps)** | 6 controles por memória (`type` / `scope` / `sensitivity` / `proactive_use` / `mention_allowed` / `ttl_days`). Memória sensível influencia cuidado, nunca é verbalizada. **Vector e procedural sem guard runtime** ([#229](https://github.com/diogenesmendes01/Maia-v2/issues/229), [#230](https://github.com/diogenesmendes01/Maia-v2/issues/230)); working memory (Redis) sem namespace de tenant. | 🔴 |
| 8 | **WhatsApp como canal (multi-canal por design)** | Gateway Baileys com texto, áudio (Whisper) e imagem (Claude Vision). Separação por interlocutor; auditoria por mensagem. Tabelas `channels` / `channel_policies` / `roles` no schema; gateways adicionais não implementados. | 🚧 |
| 9 | **Primeiro vertical: finanças PF + PJ** | Caso de uso concreto: lançamentos, classificação, fluxo de caixa, briefing, conversas separadas com contadores e funcionários. É a **prova** do produto — não a definição dele. | ✅ |

---

## Stack

- **Runtime:** Node.js 20+ + TypeScript 5+
- **Banco:** PostgreSQL 16 + pgvector
- **Cache / Fila:** Redis + BullMQ
- **WhatsApp:** Baileys
- **LLM:** Anthropic Claude (Sonnet 4.6 + Haiku 4.5)
- **Áudio:** OpenAI Whisper
- **OCR / Vision:** Claude Vision
- **ORM:** Drizzle
- **HTTP:** Fastify
- **Validação:** Zod

---

## Estrutura do projeto

```
maia/
├── docs/
│   ├── runbooks/                   # Operação (P0–P10b, setup, migrações)
│   └── superpowers/                # Design specs + planos de implementação
├── migrations/                     # Schema versionado
├── src/
│   ├── agent/                      # Loop ReAct + tool use
│   ├── cognition/                  # Reflector, classifier, self-model,
│   │                               # capability/skill proposer, drift,
│   │                               # gap-escalation, procedure/role selector,
│   │                               # step-evaluator (LLM judge + user signal)
│   ├── cognitive-graph/            # Orchestrator, pre/post-turn graphs,
│   │                               # registry, latency budget
│   ├── control-plane/              # Knowledge state machine, policy,
│   │                               # runtime-trace, skill-registry, soul
│   ├── identity/                   # Resolver, quarantine, voice modifier,
│   │                               # proposal generator, profile renderer
│   ├── skills/                     # Runner, slice-builder, modes, cache
│   ├── procedures/                 # Engine + test runner (event-sourced)
│   ├── memory/                     # 5 camadas (working/episodic/semantic/
│   │                               # procedural/vector) — fachadas sobre
│   │                               # Postgres+pgvector e Redis
│   ├── governance/                 # Regras, auditoria, dual-approval
│   ├── gateway/                    # Baileys (WhatsApp in/out) + BullMQ wiring
│   ├── tools/                      # Ferramentas que agentes chamam
│   ├── workflows/                  # Tarefas multi-passo
│   ├── workers/                    # Cron + event-driven (proatividade)
│   ├── scheduling/                 # Agendamento e recorrência
│   ├── runtime/                    # Execução
│   ├── user-layer/                 # Camada de usuário / interlocutor
│   ├── import/                     # Importadores (OFX etc.)
│   ├── setup/                      # Bootstrap (owner, entidades, permissões)
│   ├── admin-ui/                   # Next.js 14 + tRPC + NextAuth —
│   │                               # governance, approvals, audit, trace
│   │                               # exploration (16 routers: agents, audit,
│   │                               # capabilities, channelPolicies, drift,
│   │                               # inbox, knowledge, llmSettings, procedures,
│   │                               # proposals, skills, tenants, tools-catalog,
│   │                               # traces, versions, dashboard)
│   ├── config/                     # Validação de envs (Zod)
│   ├── db/                         # Drizzle, repositories
│   ├── lib/                        # Wrappers (Claude, Whisper, Redis)
│   ├── shared/                     # Tipos e utilidades compartilhadas
│   └── types/                      # Tipos globais
└── tests/
```

> **Nota sobre memória.** As 5 camadas (`episodic`, `semantic`, `procedural`, `working`, `vector`) são fachadas finas sobre Postgres+pgvector e Redis. Eviction, TTL e ranking ficam delegados ao banco/Redis, não à camada de memória. Expansão (LRU em `working`, ranking ponderado em `semantic`) fica como evolução futura.

> **Estado do código.** 152 migrations · 33 workers · 16 tRPC routers no admin-ui · 392 test/spec files · pgvector + Redis + BullMQ + Baileys em produção.

---

## Setup local (dev)

```bash
# Pré-requisitos
# - Docker + Docker Compose
# - Node 20+
# - Conta Anthropic com API key
# - Conta OpenAI com API key
# - Um chip WhatsApp dedicado por agente que você for operar

# 1. Instale dependências
npm install

# 2. Configure
cp .env.example .env
# edite .env com suas chaves

# 3. Suba a infra (Postgres + Redis)
docker compose up -d postgres redis

# 4. Aplique migrations (ordem alfabética)
npm run db:migrate

# 5. Wizard de bootstrap (cria self_state + owner; opcional: entidades, contas, permissões, co-dona)
npm run setup
# Tenant e agente padrão (`'default'`) são seedados pelas migrations P0 — o wizard
# não os cria.

# 6. Inicie em dev
npm run dev
# escaneie o QR code do WhatsApp com o número do agente

# Adicionar pessoa nova depois (CLI):
npm run pessoa:add -- --nome="Joana" --telefone="+55..." \
  --profile=contador_leitura --entidades=E1,E3

# Gerir agentes / tenants existentes: via Admin UI em src/admin-ui
# (routers `agents`, `tenants`). Provisionamento de novos tenants via UI ainda
# em iteração — multi-tenant runtime está gated.
```

---

## Setup produção (VPS)

```bash
# Configure `.env` com chaves antes (compose lê `.env` automaticamente)
docker compose up -d
docker compose logs -f app
```

---

## Admin UI

Painel web em **Next.js 14 + tRPC + NextAuth + Drizzle**, em `src/admin-ui/` — porta **`4000`** em dev.

```bash
cd src/admin-ui
npm install
npm run dev          # → http://localhost:4000
```

É o **plano de governança** da plataforma — onde o owner aprova evolução, audita comportamento e administra a operação.

| Área | O que faz | Router tRPC |
|---|---|---|
| **Aprovações** | Capability proposals, identity proposals, dual-approval flow | `proposals`, `capabilities` |
| **Drift & incidents** | Alertas de deriva (7 tipos × 4 severidades), resolução, histórico | `drift` |
| **Trace explorer** | Runtime traces, cognitive module logs, audit por turno | `traces`, `audit` |
| **Versions** | Diff + rollback de identity profiles (via `react-diff-viewer-continued`) | `versions` |
| **Gestão** | Tenants, agentes, skills, procedures, tools-catalog, channel policies, LLM settings | `tenants`, `agents`, `skills`, `procedures`, `tools-catalog`, `channelPolicies`, `llmSettings` |
| **Inbox & knowledge** | Propostas pendentes, base de conhecimento por tenant | `inbox`, `knowledge` |
| **Dashboard** | KPIs por tenant/agente — execuções, drift, custo | `dashboard` |

Lista completa de routers: [`src/admin-ui/trpc/routers/`](src/admin-ui/trpc/routers/).

---

## Testes de integração

Testes de integração tocam Postgres real e (em alguns casos) Redis real. Eles
skipam automaticamente quando `TEST_DB_URL` não está definida — então `npm test`
sempre passa sem infra.

```bash
# 1. Sobe Postgres + Redis via Docker Compose
npm run test:integration:setup

# 2. Aplica migrations
TEST_DB_URL=postgres://maia_test:test1234@localhost:5432/maia_test npm run db:migrate

# 3. Roda a suíte (TEST_DB_URL liga os specs de DB ao vivo)
TEST_DB_URL=postgres://maia_test:test1234@localhost:5432/maia_test npm run test:integration

# 4. Para os serviços (remove volumes)
npm run test:integration:teardown
```

Se um spec falhar com erro de conectividade, o helper em
`tests/helpers/integrationSetup.ts` imprime mensagem acionável dizendo qual
serviço está inalcançável e qual comando rodar.

CI roda esses testes automaticamente em job dedicado (`integration` em
`.github/workflows/ci.yml`), com `postgres` e `redis` como service containers.

---

## Documentação

- [`docs/runbooks/`](docs/runbooks/) — operação e debug por subsistema (P0–P10b, setup, migrações)
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design specs por feature
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — planos de implementação faseados
- [`migrations/`](migrations/) — schema versionado
- [`src/identity/maia-prompt.md`](src/identity/maia-prompt.md) — system prompt-base de agentes

---

## Roadmap (histórico de fases)

> ⚠️ **Esta é a sequência original de planejamento.** O código já avançou: temos **152 migrations** (com fases `p3a`, `p2`, `p4`, `p10b` etc.), **33 workers** e o admin-ui completo — boa parte do que está marcado como ✅ aqui já foi shipped há iterações. As durações listadas são **estimativas originais** do plano, não cronograma futuro. Para o estado real por subsistema, ver [`docs/runbooks/`](docs/runbooks/).

> **Legenda:** ✅ em código (migrations e módulos presentes) · 🚧 parcial / em iteração · ⏳ planejado.

| Fase | Entrega | Estimativa original | Status |
|------|---------|---------------------|--------|
| **P0** | **Foundation** — `tenant_id`/`agent_id` NOT NULL forçado, tenant-guard middleware, índices, tabelas dormentes (migrations `007_p0`–`015_p0`) | 2 sem | ✅ |
| **P1** | **Reflexão expandida + Classificador + Cognitive Wrapper** — `cognition/reflector.ts`, `classifier.ts`, `runCognitiveModule({timeout, fallback, audit})`, novos triggers (conversation_closed, success_explicit, pattern_detected, internal_gap) | 2–3 sem | ✅ |
| **P2** | **Memory scoping + Self-model** — tabela `memory_entry` com 6 controles, migração conservadora (legacy → `unknown`/`restricted`/`needs_review`), `agent_capabilities_*`, confiança determinística | 3–4 sem | ✅ |
| **P3a** | **Procedures: definição** — `procedure_definitions`, `procedure_assignments`, modo ENSINO funcional (owner ensina, agente armazena) | 2 sem | ✅ |
| **P3b** | **Procedures: execução runtime** — `procedure_executions`, `procedure_execution_events`, `selector_decisions`, `procedure-selector`, `step-evaluator` (machine_check + tool_result), engine stateful | 2–3 sem | ✅ |
| **P3c** | **Procedures: governança operacional** — `procedure_metrics` (view materializada), `procedure_tests` + test runner, TTL pra execuções zumbis, `step-evaluator` completo (llm_judge, user_signal, human_confirmed) | 2 sem | 🚧 |
| **P4** | **Identidade operacional versionada** — `agent_operational_profile_versions`, `agent_drift_alerts`, detector (7 tipos × 4 severidades), proposal generator semanal, paralelo ao legado com feature flag | 3 sem | ✅ |
| **P5** | **Aquisição dialógica de capacidades** — `gap_escalation_rules`, `capability_proposals`, `capability_test_results`, 4 níveis de escalada, dashboard de gaps + propostas, loop de teste pós-aquisição | 3 sem | ✅ |
| **P6** | **Channel / Role / Policy** — tabelas de canais, roles, policies; `role-selector` (sugere) + `role-engine` (decide via policy); multi-channel Baileys; migração: estado atual = 1 agent / 1 channel / 1 role default | 5–7 sem | 🚧 |
| **P7** | **Grafo cognitivo completo** — DAG topológico, paralelização, `runWhen` condicional; refactor de todos os módulos pro formato node. Sem mudança user-facing — só governança formal. | 2–3 sem | 🚧 |
| **P8+** | **Iterações posteriores** — admin-ui (P8.5), unified trace events matview (P10b), calendar/holidays, profile body consolidation, e demais refinamentos pós-MVP da plataforma | — | ✅ |

**Sequência de valor:**

| Etapa | Fases | Valor |
|---|---|---|
| Quick wins | P0–P2 | Reflexão expandida, sem alucinação de confiança, memória segura |
| Salto qualitativo | P3a–P3c | Procedures funcionando = "agentes aprendem qualquer profissão" |
| Segurança operacional | P4, P5 | Identidade governada + evolui via diálogo |
| Expansão | P6 | Multi-channel / multi-role |
| Governança | P7 | Orquestração formal |

---

## Princípios não-negociáveis

1. **Isolamento entre tenants é objetivo inviolável** — `tenant_id`/`agent_id` NOT NULL nas tabelas centrais e tenant-guard no caminho principal de queries. Gaps em camadas específicas (vector/procedural memory — [#229](https://github.com/diogenesmendes01/Maia-v2/issues/229), [#230](https://github.com/diogenesmendes01/Maia-v2/issues/230)) são tratados como bugs de produção a fechar, não como design aceitável.
2. **Governança antes de evolução** — agentes geram evidências; comportamento só muda quando policy + owner aprovam.
3. **Evidência > opinião** — confiança vem de fórmula determinística sobre evidência, nunca do LLM.
4. **Audit log de tudo** — qualquer ação, decisão ou mudança de identidade é rastreável.
5. **Confirmação de ações relevantes** — agentes não movem dinheiro, não modificam acessos e não tomam ações irreversíveis sem confirmação humana.
6. **Aprendizado dentro de escopo** — toda capacidade aprendida nasce escopada (tenant, agente, canal, role); sem vazamento por construção.
7. **Fail-closed em segurança (em construção)** — queries pelo tenant-guard falham sem `tenant_id`/`agent_id`; memória nova entra como `restricted`/`needs_review`; capacidade não aprovada não executa. **Cobertura do guard não é total** — ver [Estado atual & gaps conhecidos](#estado-atual--gaps-conhecidos).

---

## Estado atual & gaps conhecidos

A plataforma está em construção contínua. Resumo honesto do estado vs objetivo arquitetural:

### Em produção hoje

- **1 agente Maia** atendendo via `channel_policies` — `src/runtime/decision/agent-selector.ts` é no-op e retorna `default_agent_id` do policy.
- **1 tenant ativo** (`tenant_id='default'`). Schema, índices e tenant-guard já comportam múltiplos; runtime de provisionamento não.
- **WhatsApp** como canal habilitado via Baileys; texto/áudio (Whisper) / imagem (Claude Vision).
- Cognition (reflector, classifier, self-model, capability/skill proposers, drift, gap-escalation), memory layers, identity (com versioning e drift), skills, procedures, governance, control-plane e admin-ui — todos rodando.

### Gaps conhecidos (issues abertas)

- **[#229](https://github.com/diogenesmendes01/Maia-v2/issues/229) — Vector memory cross-tenant.** `src/memory/vector.ts` faz INSERT/recall em `agent_memories` sem `tenant_id`/`agent_id`; o filtro é apenas por `escopo`. Bucket compartilhado de fato — recall pode cruzar tenants.
- **[#230](https://github.com/diogenesmendes01/Maia-v2/issues/230) — Procedural memory sem guard.** Mutações `incrementAcerto` / `incrementErro` / `setStatus` em `rulesRepo` usam `WHERE id = ?` sem `tenant_id`/`agent_id`.
- **Working memory (Redis):** chaves usam `conversa_id`/`pessoa_id` sem namespace de tenant — defense-in-depth ausente, exploitabilidade depende da unicidade global dos IDs.

Esses gaps **violam o princípio de isolamento inviolável** e são tratados como prioridade de produto, não dívida aceitável.

### Reservado para o futuro

- `MULTI_AGENT_SELECTOR_V2` — seleção dinâmica de agente por turno.
- Multi-tenant runtime + admin-ui de provisionamento de tenants.
- P3c — procedure governance ops (`procedure_metrics` view materializada, test runner completo, step-evaluator com `llm_judge`/`user_signal`/`human_confirmed`).
- P7 — refactor completo do grafo cognitivo (orchestrator existe; nem todos os módulos foram migrados pro formato node).
- Gateways adicionais (não-WhatsApp).

---

## Contribuindo

- **Runbooks por subsistema:** [`docs/runbooks/`](docs/runbooks/) — operação e debug por fase (P0–P10b) e tópicos transversais (setup, migrações).
- **Design specs por feature:** [`docs/superpowers/specs/`](docs/superpowers/specs/) e [`docs/superpowers/plans/`](docs/superpowers/plans/).
- **Testes:** `npm test` (sem infra) ou `npm run test:integration` (Postgres + Redis ao vivo).
- **CI:** typecheck + lint + build + unit + integration + e2e + gitleaks em cada PR (`.github/workflows/ci.yml`).
- **Convenção de PR:** mudanças aditivas ou com feature flag + rollback; toda mudança de schema acompanha migration `_up` + `_down`.

---

## Licença

MIT — veja [LICENSE](LICENSE).
