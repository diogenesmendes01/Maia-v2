# Maia

> **Plataforma multi-agente governada via WhatsApp.**
> Agentes configuráveis, cada um com papel, ferramentas e procedimentos
> aprovados para assumir uma função operacional humana — com governança,
> escopo e evidência.

[![Node](https://img.shields.io/badge/node-22%2B-green)]()
[![TypeScript](https://img.shields.io/badge/typescript-5%2B-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🧭 **Frase-mãe**
> _"Agentes na Maia aprendem com a experiência, mas só evoluem
> dentro de governança, escopo e evidência."_

> ⚠️ **Status do produto.** Plataforma em construção. O schema é multi-tenant + multi-agente, mas o runtime opera hoje com `tenant_id='default'` e `agent-selector` no-op (`MULTI_AGENT_SELECTOR_V2` reservado pro futuro). Pilares marcados 🔴 têm gap conhecido (issues abertas). Detalhes em [Estado atual & gaps conhecidos](#estado-atual--gaps-conhecidos).

---

## O que é

**Maia é a plataforma** — não um agente. O **objetivo arquitetural** é que cada tenant (pessoa ou empresa) opere seus próprios agentes dentro dela, conversando por WhatsApp, com identidade versionada e capacidades que crescem sob aprovação. Hoje opera em modo single-tenant (`'default'`) com 1 agente Maia atendendo via channel policy; a infra multi-tenant/multi-agente está no schema, gated por feature flag no runtime.

- **Maia é o projeto / a plataforma.** Os agentes têm nome próprio, definido pelo tenant.
- **Multi-tenant por design, single-tenant em produção hoje** — schema, índices e tenant-guard nas queries principais; runtime ainda opera com `tenant_id='default'`. Isolamento é o **objetivo** com 2 gaps rastreados ([#229](https://github.com/diogenesmendes01/Maia-v2/issues/229), [#230](https://github.com/diogenesmendes01/Maia-v2/issues/230)).
- **Multi-agente por design** — `Agent ≠ Channel ≠ Role`; `channel_policies` define qual agente atende qual canal. Hoje: 1 agente por canal via policy (`agent-selector` é no-op). Seleção dinâmica reservada pra `MULTI_AGENT_SELECTOR_V2`.
- **Agentes aprendem habilidades e ferramentas** — `capability-proposer` / `skill-proposer` em produção; owner aprova via admin-ui antes de qualquer evolução.
- **Papéis substituem funções humanas específicas** — cada agente nasce com um `role_descriptor`, ferramentas autorizadas e procedimentos versionados para operar como assistente financeiro, vendedor, consultor, suporte, backoffice ou outro papel configurado pelo tenant.
- **Pessoal e corporativo** — o primeiro pacote de ferramentas em produção cobre finanças PF + PJ do owner; isso é um vertical inicial, não o posicionamento do produto.
- **WhatsApp como canal habilitado, multi-canal por design** — texto, áudio e foto via Baileys; tabelas `channels` / `channel_policies` / `roles` no schema, gateways adicionais não implementados ainda.

---

## Os 9 pilares

> **Legenda:** ✅ implementado e em produção · 🚧 parcial / em iteração · 🔴 implementado **com gap conhecido** (issue aberta) · ⏳ roadmap.

| #   | Pilar                                            | O que faz                                                                                                                                                                                                                                                                                                                                                                                            | Status |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **Agentes que aprendem**                         | `capability-proposer`, `skill-proposer`, aquisição dialógica em 4 níveis (silent → dashboard → mentionable → proposed). A plataforma propõe; owner decide.                                                                                                                                                                                                                                           | ✅     |
| 2   | **Governança versionada**                        | Identidade operacional em 4 camadas (núcleo imutável / perfil aprendido / episódica / backlog). Toda evolução tem aprovação e versão.                                                                                                                                                                                                                                                                | ✅     |
| 3   | **Isolamento como objetivo (com gaps)**          | `tenant_id`/`agent_id` NOT NULL nas tabelas centrais, tenant-guard middleware no caminho principal de queries. **Gaps em vector memory ([#229](https://github.com/diogenesmendes01/Maia-v2/issues/229)) e procedural memory ([#230](https://github.com/diogenesmendes01/Maia-v2/issues/230))** — recall/mutações sem escopo. Runtime opera single-tenant via `'default'`.                            | 🔴     |
| 4   | **Cognitive graph**                              | Orquestração como grafo leve: pre-turn + post-turn, com `runWhen`/`timeout`/`fallback`/`model`/`version` por node. É o **único** caminho de orquestração turn-time (P7 / #412 — `FEATURE_COGNITIVE_GRAPH` removida, paridade de side-effects provada). DAG topológico/paralelização ampla seguem no roadmap.                                                                                          | ✅     |
| 5   | **Self-model + reflexão tipada**                 | Modelo de si em 3 camadas (domínio/skill/gap), confiança determinística sobre evidência. Toda reflexão vira candidato classificado em fato / regra / procedimento / lacuna / tool-request / descarte.                                                                                                                                                                                                | ✅     |
| 6   | **Skills + Procedures executáveis**              | O que um agente aprende vira artefato versionado, event-sourced, com success criteria tipados e métricas derivadas. P3a/b em produção; P3c (test runner completo, view materializada) parcial.                                                                                                                                                                                                       | 🚧     |
| 7   | **Memória escopada (com gaps)**                  | 6 controles por memória (`type` / `scope` / `sensitivity` / `proactive_use` / `mention_allowed` / `ttl_days`). Memória sensível influencia cuidado, nunca é verbalizada. **Vector e procedural sem guard runtime** ([#229](https://github.com/diogenesmendes01/Maia-v2/issues/229), [#230](https://github.com/diogenesmendes01/Maia-v2/issues/230)); working memory (Redis) **é** namespaced por `tenant:agent:conversa` (ver [runbook Redis](docs/runbooks/redis.md)). | 🔴     |
| 8   | **WhatsApp como canal (multi-canal por design)** | Gateway Baileys com texto, áudio (Whisper) e imagem (Claude Vision). Separação por interlocutor; auditoria por mensagem. Tabelas `channels` / `channel_policies` / `roles` no schema; resolução de canal sempre ativa (catch-all single-tenant + fail-loud cross-tenant, #411). Gateways adicionais (SMS/Telegram/web) não implementados.                                                                | ✅     |
| 9   | **Primeiro vertical: finanças PF + PJ**          | Caso de uso concreto com ferramentas pré-configuradas: lançamentos, classificação, fluxo de caixa, briefing, conversas separadas com contadores e funcionários. É a **prova** de que um agente pode assumir uma função operacional — não a definição do produto.                                                                                                                                     | ✅     |

---

## Stack

- **Runtime:** Node.js 22+ + TypeScript 5+
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

> **Nota sobre TTL no Redis (assimetria).** Nem toda chave Redis da Maia carrega TTL — não assuma "tudo no Redis expira". A **working memory ✅ carrega TTL** (dados + marker, `MESSAGES_TTL_SECONDS`). Os **jobs do BullMQ ⚠️ historicamente NÃO tinham TTL** (acumulavam até intervenção manual); hoje a retenção é **limitada via defaults `removeOnComplete` / `removeOnFail`** nos produtores/consumidor (`src/gateway/debouncer.ts`, `src/gateway/queue.ts`), não por TTL de chave. Detalhes e implicações operacionais (DLQ pile × cache leak) no [runbook Redis](docs/runbooks/redis.md).

> **Estado do código.** 152 migrations · 33 workers · 16 tRPC routers no admin-ui · 392 test/spec files · pgvector + Redis + BullMQ + Baileys em produção.

---

## Setup local (dev)

```bash
# Pré-requisitos
# - Docker + Docker Compose
# - Node 22+ (linha única do repo: .nvmrc, package.json engines, imagens Docker)
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

Produção usa **`compose.prod.yml`** — NÃO o `docker-compose.yml`, que é o
compose de **dev** (publica Postgres/Redis no host com credencial fallback e
injeta o `.env` inteiro em todos os containers).

```bash
# 1. Env files POR SERVIÇO (nunca comite os reais)
cp .env.app.prod.example .env.app       # segredos do app (LLM, WhatsApp, HMAC)
cp .env.admin.prod.example .env.admin   # segredos do admin-ui (NextAuth/OIDC)
chmod 600 .env.app .env.admin
# edite ambos — os placeholders __SET_ME__ são REJEITADOS no boot de propósito

# 2. Credenciais da infra (interpolação do compose; não é injetado em container)
cat > .env.infra <<'EOF'
POSTGRES_USER=maia_prod
POSTGRES_PASSWORD=troque__openssl_rand_hex_24__url_safe
POSTGRES_DB=maia
REDIS_PASSWORD=troque__openssl_rand_hex_24
EOF
chmod 600 .env.infra

# 3. Suba (sem as vars acima o compose ABORTA — não há fallback maia/maia)
#    O `up` aplica as migrations ANTES de app/admin-ui: o job one-shot
#    `migrate` roda entre "postgres healthy" e a subida dos serviços, e
#    app/admin-ui dependem dele com `service_completed_successfully`
#    (issue #516). Se o job falhar — inclusive por blocker de migration
#    (dirty, checksum, missing_file) — o `up` sai != 0 e NENHUM serviço de
#    aplicação sobe. Não existe mais passo manual de migration no deploy.
docker compose --env-file .env.infra -f compose.prod.yml up -d
docker compose --env-file .env.infra -f compose.prod.yml logs migrate
docker compose --env-file .env.infra -f compose.prod.yml logs -f app
```

Postgres/Redis **não publicam porta no host** (rede interna `data`); app
(`:3000`) e admin-ui (`:4000`) só são alcançáveis pelo reverse proxy conectado
à rede `web` do projeto. Todos os containers rodam **non-root** com rootfs
read-only. Verificação pós-deploy (portas, non-root), migração de volumes de
deployments antigos e rollback:
[`docs/runbooks/deploy-prod.md`](docs/runbooks/deploy-prod.md).

**Não é por Compose?** A infraestrutura real (Coolify) tem um **recurso de
migration separado**, e ele recebe só o subset `migrator` do contrato — nenhum
segredo de aplicação. O arquivo é
[`.env.migrator.prod.example`](.env.migrator.prod.example) e o passo a passo
(inclusive a ordem do deploy, que fora do Compose é disciplina e não aresta)
está em [`docs/runbooks/deploy-prod.md`](docs/runbooks/deploy-prod.md) §7.5.
Aqui no Compose não há o que copiar: o serviço `migrate` não tem `env_file` de
propósito.

---

## Admin UI

Painel web em **Next.js 14 + tRPC + NextAuth + Drizzle**, em `src/admin-ui/` — porta **`4000`** em dev.

```bash
cd src/admin-ui
npm install
npm run dev          # → http://localhost:4000
```

É o **plano de governança** da plataforma — onde o owner aprova evolução, audita comportamento e administra a operação.

> **Redesign 2026-06 (PR #460):** UI reconstruída com design system próprio (`src/admin-ui/components/ui/`), navegação agent-first em pt-BR e a experiência central em `/agents` → `/agents/new` (wizard) → `/agents/[agentId]` (perfil editável + aprovação de versões). Routers tRPC inalterados.

| Área                  | O que faz                                                                           | Router tRPC                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Aprovações**        | Capability proposals, identity proposals, dual-approval flow                        | `proposals`, `capabilities`                                                                    |
| **Drift & incidents** | Alertas de deriva (7 tipos × 4 severidades), resolução, histórico                   | `drift`                                                                                        |
| **Trace explorer**    | Runtime traces, cognitive module logs, audit por turno                              | `traces`, `audit`                                                                              |
| **Versions**          | Diff + rollback de identity profiles (via `react-diff-viewer-continued`)            | `versions`                                                                                     |
| **Gestão**            | Tenants, agentes, skills, procedures, tools-catalog, channel policies, LLM settings | `tenants`, `agents`, `skills`, `procedures`, `tools-catalog`, `channelPolicies`, `llmSettings` |
| **Inbox & knowledge** | Propostas pendentes, base de conhecimento por tenant                                | `inbox`, `knowledge`                                                                           |
| **Dashboard**         | KPIs por tenant/agente — execuções, drift, custo                                    | `dashboard`                                                                                    |

Lista completa de routers: [`src/admin-ui/trpc/routers/`](src/admin-ui/trpc/routers/).

---

## Testes de integração

Testes de integração tocam Postgres real e (em alguns casos) Redis real. Eles
skipam automaticamente quando `TEST_DB_URL` não está definida — então `npm test`
sempre passa sem infra.

```bash
# 1. Sobe Postgres + Redis via Docker Compose (idempotente — ver abaixo)
npm run test:integration:setup

# 2. Roda a suíte — cria o banco, aplica as migrations e roda
npm run test:integration

# ...ou só um arquivo
npm run test:integration -- tests/integration/leak.spec.ts

# 3. Para os serviços e remove volumes — DESTRÓI A INFRA DE TODAS AS ÁRVORES
TEST_INFRA_TEARDOWN=yes npm run test:integration:teardown
```

#### A infra física é COMPARTILHADA — um Postgres, um Redis, um coordenador

Esta é uma escolha, e ela está registrada aqui porque a alternativa é
igualmente defensável. **Modelo (a): uma pilha só para o host inteiro.** O
`docker-compose.yml` fixa o nome do projeto (`name: maia-v2`), então
`npm run test:integration:setup` de QUALQUER worktree fala com a MESMA pilha —
antes, o Compose derivava o nome do projeto do diretório, e cada árvore pedia
uma pilha própria com `container_name` e portas globais: a segunda worktree
batia em *"container name already in use"*.

O que **não** escolhemos foi (b), projeto/containers/portas por worktree: ela
obriga a propagar a porta escolhida para `DATABASE_URL`, `TEST_DB_URL`,
`REDIS_URL`, o `.env`, o runner de migrations e o `psql` de cada árvore,
multiplica por dezenas o consumo de memória e disco da máquina de dev, e
resolve um problema que já está resolvido — duas worktrees não se enxergam por
causa do **banco e do db lógico** por árvore (seção seguinte), não por causa do
container.

Consequências práticas, e elas são o contrato:

| Comando | Contrato |
|---|---|
| `npm run test:integration:setup` | **Idempotente e seguro em concorrência.** Roda sob mutex em disco (`$TMPDIR/maia-test-infra.lock`); a segunda árvore encontra a pilha de pé e sai 0. |
| `npm run test:integration:teardown` | **Operação de coordenador.** Recusa por padrão: `docker compose down -v` apaga o Postgres e o Redis de TODAS as árvores, inclusive das que estão rodando. Exige `TEST_INFRA_TEARDOWN=yes`. |

Os dois passam por [`scripts/test-infra.ts`](scripts/test-infra.ts), que é onde
a decisão está escrita por extenso.

Não existe mais o passo de exportar `TEST_DB_URL` à mão: `npm run test:integration`
a preenche sozinho (`scripts/test-integration.ts`) e o banco é criado e migrado
antes do primeiro worker subir (`tests/globalSetup.ts`). `npm test` continua
passando sem infra nenhuma — sem `TEST_DB_URL` os specs de integração seguem
dando `describe.skip`.

Se um spec falhar com erro de conectividade, o helper em
`tests/helpers/integrationSetup.ts` imprime mensagem acionável dizendo qual
serviço está inalcançável e qual comando rodar.

### Isolamento por worktree (issue #571)

**Uma `git worktree` roda contra um Postgres e um db do Redis EXCLUSIVOS dela.**
Nada a exportar, nada a lembrar — a derivação é automática e vale para
`npm test`, `npm run test:integration` e `npm run test:leak`.

| Eixo | O que a worktree ganha | Onde |
|---|---|---|
| Postgres | banco próprio, `<base>_wt_<pasta>_<hash>`, criado e migrado sozinho | `tests/globalSetup.ts` |
| Ledger de migrations | vem junto: `schema_migrations` é uma tabela DENTRO do banco da worktree | idem |
| Redis | um db lógico próprio (`redis://…/N`), limpo no início da rodada | `tests/helpers/worktree-scope.ts` |
| `node_modules` | resolvido pela subida de diretórios até a raiz — a worktree **não** instala nada | `tests/helpers/pkg-path.ts` |

Como saber qual é o seu: `psql -l | grep maia_test_wt_` e
`cat .git/maia-redis-slots/[0-9]*` (o arquivo do slot contém o caminho da
worktree dona; o `.reciclagem.lock` ao lado é o mutex, não um slot). O escopo
desliga com `TEST_WORKTREE_SCOPE=off`, e no checkout principal e no CI ele já é
inativo por construção — lá `.git` é um diretório, não um arquivo `gitdir:`, e o
comportamento é o de sempre.

**Uma base, um destino.** `REDIS_URL` e `TEST_DB_URL` do ambiente são
respeitadas e escopadas: host, porta, credencial e esquema seguem intactos, só
o índice do db (Redis) e o nome do banco (Postgres) mudam. A derivação é UMA
função (`resolveTestEnv`), chamada tanto pelo setup global — que cria o banco e
limpa o Redis — quanto por cada worker. Elas não podem apontar para endpoints
diferentes porque não existem duas derivações. E se a limpeza do Redis falhar
numa rodada que pediu infra real (`TEST_DB_URL` definida), a rodada **reprova**
com o destino e o remédio na mensagem: seguir seria ler resíduo da rodada
anterior como resultado desta.

**Posse do slot: mutex e batimento.** Reciclar um slot abandonado é uma
sequência (observar o dono → apagar → reivindicar), e o `open(…, 'wx')` só
protege o último passo. Dois processos que concluíssem "abandonado" a partir da
mesma leitura acabavam com o MESMO db. A reciclagem roda sob um mutex de
diretório e confirma, antes de apagar, que ainda está removendo a geração
observada (inode + mtime). Enquanto um processo vive, ele reafirma a posse a
cada 5 min — é isso que faz as 6h de validade significarem "abandonado" e não
"começou faz tempo". Desliga com `TEST_WORKTREE_SCOPE_HEARTBEAT=off`.

**Limite conhecido, e é de infraestrutura:** um Redis de fábrica tem 16 dbs
lógicos, e o 0 fica reservado para quem não é worktree — ou seja, 15 worktrees
simultâneas. Os slots são reciclados quando a worktree some do disco ou fica 6h
sem rodar nada, então o teto é de worktrees ATIVAS, não de worktrees existentes.
Se ele apertar, suba o Redis com mais dbs e diga ao alocador:

```bash
redis-server --databases 64          # ou `--databases 64` no comando do compose
export TEST_REDIS_DATABASES=64
```

Sem isso, a 16ª worktree ativa falha com mensagem nomeando o remédio — em vez de
silenciosamente compartilhar o db de outra.

As variáveis desta seção NÃO levam o prefixo `MAIA_` de propósito: o contrato de
configuração reprova qualquer chave `MAIA_*`/`FEATURE_*` não declarada
(`src/config/validate.ts:248`), e o runner de migrations disparado pelo
`globalSetup` herda o ambiente inteiro — uma `MAIA_TEST_*` derrubaria a própria
provisão que ela configura.

CI roda esses testes automaticamente em job dedicado (`integration` em
`.github/workflows/ci.yml`), com `postgres` e `redis` como service containers.

---

## Documentação

- [`docs/runbooks/`](docs/runbooks/) — operação e debug por subsistema (P0–P10b, setup, migrações)
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design specs por feature
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — planos de implementação faseados
- [`migrations/`](migrations/) — schema versionado
- [`src/identity/maia-prompt.md`](src/identity/maia-prompt.md) — seed operacional do agente financeiro atual; não é a identidade da plataforma

---

## Roadmap (histórico de fases)

> ⚠️ **Esta é a sequência original de planejamento.** O código já avançou: temos **152 migrations** (com fases `p3a`, `p2`, `p4`, `p10b` etc.), **33 workers** e o admin-ui completo — boa parte do que está marcado como ✅ aqui já foi shipped há iterações. As durações listadas são **estimativas originais** do plano, não cronograma futuro. Para o estado real por subsistema, ver [`docs/runbooks/`](docs/runbooks/).

> **Legenda:** ✅ em código (migrations e módulos presentes) · 🚧 parcial / em iteração · ⏳ planejado.

| Fase    | Entrega                                                                                                                                                                                                                                          | Estimativa original | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------ |
| **P0**  | **Foundation** — `tenant_id`/`agent_id` NOT NULL forçado, tenant-guard middleware, índices, tabelas dormentes (migrations `007_p0`–`015_p0`)                                                                                                     | 2 sem               | ✅     |
| **P1**  | **Reflexão expandida + Classificador + Cognitive Wrapper** — `cognition/reflector.ts`, `classifier.ts`, `runCognitiveModule({timeout, fallback, audit})`, novos triggers (conversation_closed, success_explicit, pattern_detected, internal_gap) | 2–3 sem             | ✅     |
| **P2**  | **Memory scoping + Self-model** — tabela `memory_entry` com 6 controles, migração conservadora (legacy → `unknown`/`restricted`/`needs_review`), `agent_capabilities_*`, confiança determinística                                                | 3–4 sem             | ✅     |
| **P3a** | **Procedures: definição** — `procedure_definitions`, `procedure_assignments`, modo ENSINO funcional (owner ensina, agente armazena)                                                                                                              | 2 sem               | ✅     |
| **P3b** | **Procedures: execução runtime** — `procedure_executions`, `procedure_execution_events`, `selector_decisions`, `procedure-selector`, `step-evaluator` (machine_check + tool_result), engine stateful                                             | 2–3 sem             | ✅     |
| **P3c** | **Procedures: governança operacional** — `procedure_metrics` (view materializada), `procedure_tests` + test runner, TTL pra execuções zumbis, `step-evaluator` completo (llm_judge, user_signal, human_confirmed)                                | 2 sem               | 🚧     |
| **P4**  | **Identidade operacional versionada** — `agent_operational_profile_versions`, `agent_drift_alerts`, detector (7 tipos × 4 severidades), proposal generator semanal, paralelo ao legado com feature flag                                          | 3 sem               | ✅     |
| **P5**  | **Aquisição dialógica de capacidades** — `gap_escalation_rules`, `capability_proposals`, `capability_test_results`, 4 níveis de escalada, dashboard de gaps + propostas, loop de teste pós-aquisição                                             | 3 sem               | ✅     |
| **P6**  | **Channel / Role / Policy** — tabelas de canais, roles, policies; `role-selector` (sugere) + `role-engine` (decide via policy); multi-channel Baileys; resolução de canal sempre ativa (catch-all single-tenant #411, fail-loud cross-tenant #268); estado atual = 1 agent / 1 channel / 1 role default                             | 5–7 sem             | ✅     |
| **P7**  | **Grafo cognitivo** — orquestração declarativa turn-time (pre/post-turn) com `runWhen`/`timeout`/`fallback`/`version` por node; todos os módulos turn-time migrados pro formato node, `FEATURE_COGNITIVE_GRAPH` removida (#412), paridade de side-effects provada. Sem mudança user-facing. _(DAG topológico + paralelização ampla = roadmap.)_                                            | 2–3 sem             | ✅     |
| **P8+** | **Iterações posteriores** — admin-ui (P8.5), unified trace events matview (P10b), calendar/holidays, profile body consolidation, e demais refinamentos pós-MVP da plataforma                                                                     | —                   | ✅     |

**Sequência de valor:**

| Etapa                 | Fases   | Valor                                                           |
| --------------------- | ------- | --------------------------------------------------------------- |
| Quick wins            | P0–P2   | Reflexão expandida, sem alucinação de confiança, memória segura |
| Salto qualitativo     | P3a–P3c | Procedures funcionando = "agentes aprendem qualquer profissão"  |
| Segurança operacional | P4, P5  | Identidade governada + evolui via diálogo                       |
| Expansão              | P6      | Multi-channel / multi-role                                      |
| Governança            | P7      | Orquestração formal                                             |

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
- **Working memory (Redis): namespaced por tenant — sem gap.** As chaves do buffer de mensagens são totalmente escopadas por tenant+agent+conversa: dados em `working:{tenant_id}:{agent_id}:conv:{conversa_id}:messages` e o marker de TTL/colisão em `nx_ttl:{tenant_id}:{agent_id}:conv:{conversa_id}:messages` (`workingMessagesKey`/`workingMarkerKey` em `src/memory/working.ts`). O prefixo deriva do `runWithTenantContext` e falha alto (`MissingTenantContextError`) se o contexto estiver ausente, então não há colisão cross-tenant possível na estrutura da chave. Detalhes operacionais no [runbook Redis](docs/runbooks/redis.md). _(Correção de doc drift — [#343](https://github.com/diogenesmendes01/Maia-v2/issues/343).)_

Esses gaps **violam o princípio de isolamento inviolável** e são tratados como prioridade de produto, não dívida aceitável.

### Reservado para o futuro

- `MULTI_AGENT_SELECTOR_V2` — seleção dinâmica de agente por turno.
- Multi-tenant runtime + admin-ui de provisionamento de tenants.
- P3c — procedure governance ops (`procedure_metrics` view materializada, test runner completo, step-evaluator com `llm_judge`/`user_signal`/`human_confirmed`).
- P7 (grafo cognitivo) — turn-time **concluído** (#412: todos os módulos turn-time migrados pro formato node, `FEATURE_COGNITIVE_GRAPH` removida). Roadmap remanescente: DAG topológico explícito + paralelização ampla além do batch sync_conditional atual.
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
