# Maia

> Assistente financeira inteligente via WhatsApp.
> Gerencia PF + 8 PJs com separação rígida, memória persistente e ferramentas reais.

[![Node](https://img.shields.io/badge/node-20%2B-green)]()
[![TypeScript](https://img.shields.io/badge/typescript-5%2B-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## O que ela faz

- Lança entradas e saídas via texto, áudio ou foto de boleto/comprovante
- Classifica transações automaticamente e aprende com correções
- Mantém saldo e fluxo de caixa por entidade
- Envia briefing matinal, alertas de vencimento, resumo semanal
- Conversa com contadores e funcionários em conversas separadas
- Mantém escopo por interlocutor (cada um vê só o que pode)
- Audita tudo

## Stack

- **Runtime:** Node.js 20+ + TypeScript 5+
- **Banco:** PostgreSQL 16 + pgvector
- **Cache/Fila:** Redis + BullMQ
- **WhatsApp:** Baileys
- **LLM:** Anthropic Claude (Sonnet 4.6 + Haiku 4.5)
- **Áudio:** OpenAI Whisper
- **OCR:** Claude Vision
- **ORM:** Drizzle
- **HTTP:** Fastify
- **Validação:** Zod

## Estrutura do projeto

```
maia-v2/
├── docs/
│   ├── arquitetura.md          # Desenho completo do sistema
│   └── inventario.md           # Template de entidades/pessoas/permissões
├── migrations/
│   └── 001_initial.sql         # Schema inicial
├── scripts/                    # Migrations, seeds, utilitários
├── src/
│   ├── config/                 # Validação de envs (Zod)
│   ├── db/                     # Drizzle, repositories
│   ├── gateway/                # Baileys (WhatsApp in/out)
│   │   └── queue.ts            # BullMQ wiring (filas de mensagens)
│   ├── agent/                  # Loop ReAct + tool use
│   ├── tools/                  # Ferramentas que o agente chama
│   ├── memory/                 # 5 camadas de memória (fachadas finas)
│   ├── identity/
│   │   └── maia-prompt.md      # System prompt v0 da Maia
│   ├── workflows/              # Tarefas multi-passo
│   ├── governance/             # Regras e auditoria
│   ├── workers/                # Cron + event-driven (proatividade)
│   ├── setup/                  # Bootstrap inicial (owner, entidades, permissões, self_state)
│   ├── dashboard/              # Admin web Fastify
│   └── lib/                    # Wrappers (Claude, Whisper, etc.)
│       └── redis.ts            # Wrapper ioredis
└── tests/
```

> Nota: as 5 "camadas" de memória (`episodic`, `semantic`, `procedural`, `working`, `vector`) são fachadas finas sobre Postgres+pgvector e Redis. Eviction, TTL e ranking ficam delegados ao banco/Redis, não à camada de memória. Expansão (LRU em working, ranking ponderado em semantic) fica como evolução futura.

## Setup local (dev)

```bash
# Pré-requisitos
# - Docker + Docker Compose
# - Node 20+
# - Conta Anthropic com API key
# - Conta OpenAI com API key
# - Chip WhatsApp dedicado para a Maia

# 1. Instale dependências
npm install

# 2. Configure
cp .env.example .env
# edite .env com suas chaves

# 3. Suba a infra (Postgres + Redis)
docker compose up -d postgres redis

# 4. Rode todas as migrations em `migrations/`
npm run db:migrate
# `npm run db:migrate` aplica em ordem alfabética

# 5. Wizard de bootstrap (cria owner + entidades + permissões + self_state)
npm run setup

# 6. Inicie em dev
npm run dev
# escaneie o QR code do WhatsApp com o número da Maia

# Adicionar pessoa nova depois (CLI):
npm run pessoa:add -- --nome="Joana" --telefone="+55..." --profile=contador_leitura --entidades=E1,E3
```

## Setup produção (VPS)

```bash
# Configure `.env` com chaves antes (compose lê `.env` automaticamente)
docker compose up -d
docker compose logs -f app
```

## Running integration tests

Integration tests hit a live Postgres and (for some specs) a live Redis. They
skip automatically when `TEST_DB_URL` is unset, so the plain `npm test` lane
always passes without infrastructure.

To run integration specs locally:

```bash
# 1. Start Postgres + Redis via Docker Compose
npm run test:integration:setup

# 2. Apply DB migrations so the schema is up to date
TEST_DB_URL=postgres://maia_test:test1234@localhost:5432/maia_test npm run db:migrate

# 3. Run the suite (TEST_DB_URL enables the live-DB specs)
TEST_DB_URL=postgres://maia_test:test1234@localhost:5432/maia_test npm run test:integration

# 4. Stop services when done (removes volumes)
npm run test:integration:teardown
```

If a spec fails immediately with a connectivity error, the helper in
`tests/helpers/integrationSetup.ts` prints an actionable message telling you
which service is unreachable and which command to run.

CI runs these automatically in the dedicated `integration` job (see
`.github/workflows/ci.yml`), which spins up `postgres` and `redis` service
containers before executing the suite.

## Documentação

- [`docs/arquitetura.md`](docs/arquitetura.md) — desenho do sistema, os 7 pilares, fases
- [`docs/inventario.md`](docs/inventario.md) — template a preencher (Mendes + esposa)
- [`migrations/001_initial.sql`](migrations/001_initial.sql) — schema completo
- [`src/identity/maia-prompt.md`](src/identity/maia-prompt.md) — identidade da Maia v0

## Roadmap

| Fase | O que entrega | Status |
|------|---------------|--------|
| 0 | Inventário (paralelo) | em andamento |
| 1 | MVP — agente + 5 tools + memória básica | próxima entrega |
| 2 | Multimídia (áudio + imagem) + esposa ativa | |
| 3 | Ecossistema — contadores e funcionários | |
| 4 | Importação OFX + briefings proativos | |
| 5 | Inteligência analítica + dashboard web | |

## Princípios não-negociáveis

1. **Separação rígida entre entidades** — toda query passa por `entidade_id`
2. **Permissões explícitas** — interlocutor só vê o que pode
3. **Audit log de tudo** — qualquer ação é rastreável
4. **Confirmação de ações relevantes** — IA não move dinheiro sozinha
5. **Aprendizado com correção** — corrigiu uma vez, ela acerta da próxima

## Licença

MIT — veja [LICENSE](LICENSE).
