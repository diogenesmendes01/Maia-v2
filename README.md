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
│   ├── agent/                  # Loop ReAct + tool use
│   ├── tools/                  # Ferramentas que o agente chama
│   ├── memory/                 # 5 camadas de memória
│   ├── identity/
│   │   └── maia-prompt.md      # System prompt v0 da Maia
│   ├── workflows/              # Tarefas multi-passo
│   ├── governance/             # Regras e auditoria
│   ├── workers/                # Cron + event-driven (proatividade)
│   └── lib/                    # Wrappers (Claude, Whisper, etc.)
└── tests/
```

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

# 4. Rode migrations
npm run db:migrate

# 5. Rode seeds (categorias globais)
npm run db:seed

# 6. Inicie em dev
npm run dev
# escaneie o QR code do WhatsApp com o número da Maia
```

## Setup produção (VPS)

```bash
docker compose up -d
docker compose logs -f app
```

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
