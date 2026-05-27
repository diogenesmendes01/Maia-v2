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

---

## O que é

**Maia é a plataforma** — não um agente. Cada tenant (pessoa ou empresa)
cria e opera **seus próprios agentes** dentro dela, conversando por WhatsApp,
com identidade versionada, capacidades que crescem sob aprovação e isolamento
inviolável entre tenants.

- **Maia é o projeto / a plataforma.** Os agentes têm nome próprio, definido pelo tenant.
- **Multi-tenant com isolamento inviolável** — agentes de tenants diferentes nunca se cruzam, nem por aprendizado.
- **Multi-agente por tenant** — `Agent ≠ Channel ≠ Role`. Um tenant pode ter vários agentes; cada um com seu escopo.
- **Agentes aprendem habilidades e ferramentas** — a plataforma propõe novas skills/tools a partir do uso real; o owner decide.
- **Pessoal e corporativo** — mesma plataforma serve PF e PJ; o que muda é o vertical, não o motor.
- **WhatsApp como canal habilitado hoje, multi-canal por design** — texto, áudio e foto via Baileys; infra de `channels` / `channel_policies` / `roles` já no schema, pronta pra outros canais.

---

## Os 9 pilares

| # | Pilar | O que faz |
|---|---|---|
| 1 | **Agentes que aprendem** | `capability-proposer`, `skill-proposer`, aquisição dialógica em 4 níveis (silent → dashboard → mentionable → proposed). A plataforma propõe; owner decide. |
| 2 | **Governança versionada** | Identidade operacional em 4 camadas (núcleo imutável / perfil aprendido / episódica / backlog). Toda evolução tem aprovação e versão. |
| 3 | **Isolamento inviolável** | Toda query passa por `tenant_id` + `agent_id` (NOT NULL forçado). PF de PJ, tenant de tenant, role de role — sem exceção. |
| 4 | **Cognitive graph** | Orquestração como grafo leve: pre-turn + post-turn, com `runWhen`/`timeout`/`fallback`/`model`/`version` por node. |
| 5 | **Self-model + reflexão tipada** | Modelo de si em 3 camadas (domínio/skill/gap), confiança determinística sobre evidência. Toda reflexão vira candidato classificado em fato / regra / procedimento / lacuna / tool-request / descarte. |
| 6 | **Skills + Procedures executáveis** | O que um agente aprende vira artefato versionado, event-sourced, com success criteria tipados e métricas derivadas. |
| 7 | **Memória escopada** | 6 controles por memória (`type` / `scope` / `sensitivity` / `proactive_use` / `mention_allowed` / `ttl_days`). Memória sensível influencia cuidado, nunca é verbalizada. |
| 8 | **WhatsApp como canal (multi-canal por design)** | Gateway Baileys com texto, áudio (Whisper) e imagem (Claude Vision). Separação por interlocutor; auditoria por mensagem. Tabelas de `channels` / `channel_policies` / `roles` já no schema; `gateway/channel-resolver.ts` e `runtime/decision/agent-selector.ts` em produção. |
| 9 | **Primeiro vertical: finanças PF + PJ** | Caso de uso concreto: lançamentos, classificação, fluxo de caixa, briefing, conversas separadas com contadores e funcionários. É a **prova** do produto — não a definição dele. |

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
│   ├── arquitetura.md              # Desenho do sistema, pilares, fases
│   ├── specs/                      # Specs 00–18 (um por subsistema)
│   ├── runbooks/                   # Operação
│   └── inventario.md               # Template de entidades/pessoas/permissões
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

> **Estado do código.** 152 migrations · 33 workers · 16 tRPC routers no admin-ui · 19 specs em `docs/specs/` · 392 test/spec files · pgvector + Redis + BullMQ + Baileys em produção.

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

# 5. Wizard de bootstrap (cria tenant + owner + 1º agente + entidades + permissões)
npm run setup

# 6. Inicie em dev
npm run dev
# escaneie o QR code do WhatsApp com o número do agente

# Adicionar pessoa nova depois (CLI):
npm run pessoa:add -- --nome="Joana" --telefone="+55..." \
  --profile=contador_leitura --entidades=E1,E3

# Adicionar agente novo a um tenant existente:
# via Admin UI em src/admin-ui (router `agents`)
```

---

## Setup produção (VPS)

```bash
# Configure `.env` com chaves antes (compose lê `.env` automaticamente)
docker compose up -d
docker compose logs -f app
```

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

- [`docs/arquitetura.md`](docs/arquitetura.md) — desenho do sistema, pilares, fases
- [`docs/specs/00-overview.md`](docs/specs/00-overview.md) — visão geral
- [`docs/specs/`](docs/specs/) — specs 00–18 (config, data model, permissões, gateway, identity resolver, agent loop, tools, memory, governance, multimídia, workflows, proactive workers, OFX import, Brazilian domain, dashboard, testing, observability, scheduling)
- [`docs/runbooks/`](docs/runbooks/) — operação
- [`docs/inventario.md`](docs/inventario.md) — template de inventário
- [`migrations/`](migrations/) — schema versionado
- [`src/identity/maia-prompt.md`](src/identity/maia-prompt.md) — system prompt-base de agentes

---

## Roadmap

Implementação faseada, aditiva ou com feature flag + rollback. As **10 fases originais P0–P7** cobrem o núcleo da plataforma. O código já avançou para iterações posteriores (P8–P10, ex. `054_p10b_unified_trace_events_matview`) — `docs/specs/` tem o estado detalhado por subsistema.

> **Legenda:** ✅ em código · 🚧 parcial / em iteração · ⏳ planejado.
> Status reflete presença de migrations e módulos no repo, não garantia de cobertura 100% — auditar via specs e testes.

| Fase | Entrega | Duração | Status |
|------|---------|---------|--------|
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

1. **Isolamento entre tenants é inviolável** — agentes de tenants diferentes nunca se comunicam, compartilham dados ou herdam aprendizado. Sem exceção.
2. **Governança antes de evolução** — agentes geram evidências; comportamento só muda quando policy + owner aprovam.
3. **Evidência > opinião** — confiança vem de fórmula determinística sobre evidência, nunca do LLM.
4. **Audit log de tudo** — qualquer ação, decisão ou mudança de identidade é rastreável.
5. **Confirmação de ações relevantes** — agentes não movem dinheiro, não modificam acessos e não tomam ações irreversíveis sem confirmação humana.
6. **Aprendizado dentro de escopo** — toda capacidade aprendida nasce escopada (tenant, agente, canal, role); sem vazamento por construção.
7. **Fail-closed em segurança** — query sem `tenant_id`/`agent_id` falha; memória nova entra como `restricted`/`needs_review`; capacidade não aprovada não executa.

---

## Contribuindo

- **Specs por subsistema:** `docs/specs/00-overview.md` → `18-scheduling-and-recurring-workflows.md`. Cada subsistema (gateway, identity resolver, agent loop, tools, memory, governance, multimídia, workflows, workers, OFX import, Brazilian domain, dashboard, testing, observability, scheduling) tem seu doc.
- **Runbooks:** [`docs/runbooks/`](docs/runbooks/) — operação e respostas a incidentes.
- **Testes:** `npm test` (sem infra) ou `npm run test:integration` (Postgres + Redis ao vivo).
- **CI:** typecheck + lint + build + unit + integration + e2e + gitleaks em cada PR (`.github/workflows/ci.yml`).
- **Convenção de PR:** mudanças aditivas ou com feature flag + rollback; toda mudança de schema acompanha migration `_up` + `_down`.

---

## Licença

MIT — veja [LICENSE](LICENSE).
