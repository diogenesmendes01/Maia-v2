# Maia — Arquitetura do Sistema

> Assistente financeira inteligente para gerir PF + 8 PJs via WhatsApp.  
> Versão inicial do documento — vai evoluir junto com o projeto.

---

## 1. Visão geral

A Maia é um **agente de IA** (não um chatbot) com:
- Identidade própria (número WhatsApp dedicado)
- Memória persistente em camadas
- Ferramentas reais que executam ações
- Comportamento proativo (briefings, alertas, follow-ups)
- Aprendizado contínuo a partir de correções
- Separação rígida entre 9 entidades (PF + 8 PJs) e múltiplos interlocutores com permissões granulares

A inteligência **não está no LLM** (que é stateless). Está no **sistema ao redor** — memória estruturada, regras aprendidas, identidade persistente, governance, planejamento. O Claude é o motor de raciocínio.

---

## 2. Topologia (alto nível)

```
┌────────────────────────────────────────────────────────────┐
│  Mendes  │  Esposa  │ Contadores │ Funcionários │ Outros   │
└──────┬───┴────┬─────┴────┬───────┴──────┬───────┴────┬─────┘
       │ WhatsApp (cada um na sua conversa, com a Maia)        │
       └────────────────────────┬─────────────────────────────┘
                                │
                ┌───────────────▼───────────────┐
                │  Gateway Baileys              │
                │  (1 sessão, número da Maia)    │
                └───────────────┬───────────────┘
                                │  fila (BullMQ)
                ┌───────────────▼───────────────┐
                │  Identificador de pessoa      │
                │  → permissões, escopo,        │
                │    conversa, contexto         │
                └───────────────┬───────────────┘
                                │
                ┌───────────────▼───────────────┐
                │  AGENTE (Claude + tool use)   │
                │  loop: Pensa → Age → Observa  │
                └─┬───────┬──────────┬─────────┬┘
                  │       │          │         │
        ┌─────────▼┐  ┌──▼──────┐ ┌─▼──────┐ ┌▼─────────────┐
        │ Memória  │  │ Tools   │ │Workflws│ │ Identidade   │
        │ (5 cama- │  │ (CRUD,  │ │ (multi-│ │ (self-prompt │
        │  das)    │  │ consul- │ │  step) │ │  + modelos   │
        │          │  │ ta, OCR)│ │        │ │  mentais)    │
        └──────────┘  └─────────┘ └────────┘ └──────────────┘
                  ▲       ▲          ▲
                  └───────┴──────────┘
                          │
              ┌───────────▼────────────┐
              │ Postgres (+ pgvector)  │
              │ Redis (fila + cache)   │
              └────────────────────────┘
                          ▲
                          │
              ┌───────────▼────────────┐
              │ Workers proativos      │
              │ (cron + event-driven)  │
              └────────────────────────┘
```

---

## 3. Os 7 pilares da inteligência

### 3.1 Memória em camadas

| Camada | Função | Onde mora |
|--------|--------|-----------|
| **Trabalho** | Conversa atual, últimas N mensagens | Redis (TTL curto) |
| **Episódica** | Eventos, transações, decisões com timestamp | Postgres (`mensagens`, `transacoes`, `audit_log`) |
| **Semântica** | Fatos sobre o mundo da Maia (entidades, pessoas, padrões) | Postgres (`agent_facts`) |
| **Procedural** | Regras aprendidas (como classificar, como reagir) | Postgres (`learned_rules`) |
| **Vetorial** | Recall por similaridade ("já vi algo parecido?") | Postgres + pgvector (`agent_memories`) |

A função `buildContext(conversa, escopo)` monta o prompt **selecionando dinamicamente** o que importa de cada camada.

### 3.2 Loop de raciocínio (ReAct + Reflexão)

```
recebeMensagem() →
  carregaContexto() →
  loop:
    Claude.pensa(prompt) →
    Se decidiu chamar ferramenta:
      executa(ferramenta) →
      observa(resultado) →
      continua loop
    Senão:
      responde() →
      sai do loop
  ↓
  Após workflow significativo:
    Reflexão → atualiza learned_rules
```

### 3.3 Modelo mental dos interlocutores

Cada `pessoa` tem um perfil:
- Quem é (papel, vínculo)
- Como prefere ser tratada (tom, formalidade)
- O que pode ver e fazer (permissões)
- Histórico resumido de interação

Quando a Maia vai responder, o system prompt é **montado** com o perfil do interlocutor injetado.

### 3.4 Planejamento hierárquico

Tarefas grandes (`workflows`) são árvores de tarefas (`workflow_steps`). Estado persiste em banco. Maia retoma de onde parou mesmo após reinício.

### 3.5 Auto-supervisão (governance)

Regras hard-coded de quando NÃO agir sozinha:
- Transações > limite → confirmação humana
- Mensagem proativa para terceiro → aprovação prévia (fase inicial)
- Anomalia detectada → alerta, não corrige
- Interlocutor desconhecido → escopo zero, formalidade

### 3.6 Antecipação proativa

Workers rodando em background:
- Cron: briefing matinal, fechamento, semanal
- Event-driven: vencimento próximo, anomalia, follow-up pendente
- Pattern-driven: "todo dia X o Mendes pergunta Y → preparo antes"

### 3.7 Continuidade de identidade

`self_state` — arquivo vivo com a identidade da Maia, atualizado conforme aprende. Lido em toda conversa.

---

## 4. Stack técnica

| Camada | Tecnologia | Motivo |
|--------|-----------|--------|
| Linguagem | Node.js 20+ + TypeScript 5+ | Histórico do Mendes, ecossistema WhatsApp |
| Framework HTTP | Fastify | Leve, rápido, schema validation nativa |
| WhatsApp | Baileys (`@whiskeysockets/baileys`) | Sem Chromium, leve, estável |
| LLM | Anthropic Claude (Sonnet 4.6 + Haiku 4.5) | Tool use nativo, qualidade, custo |
| Áudio | OpenAI Whisper API | Padrão do mercado |
| OCR | Claude Vision (boletos/comprovantes) | Já vem junto, sem infra extra |
| Banco | PostgreSQL 16 + pgvector | ACID, SQL maduro, vetor sem infra extra |
| Fila | Redis + BullMQ | Confiável, simples |
| Validação | Zod | Schemas TS-first |
| Logging | Pino | Performance, JSON estruturado |
| Agendamento | node-cron | Simples para o que precisamos |
| ORM | Drizzle | TS-first, leve, SQL transparente |
| Testes | Vitest | Rápido, moderno |
| Container | Docker + Compose | Padrão para VPS |

---

## 5. Estrutura de pastas

```
maia/
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── migrations/
│   └── 001_initial.sql
├── src/
│   ├── index.ts                # entry point (orchestrator)
│   ├── config/
│   │   └── env.ts              # validação de env vars (Zod)
│   ├── db/
│   │   ├── client.ts           # conexão Postgres (Drizzle)
│   │   ├── schema.ts           # tipos derivados das tabelas
│   │   └── repositories/       # acesso por domínio
│   ├── gateway/
│   │   ├── baileys.ts          # cliente WhatsApp
│   │   └── handlers.ts         # in/out handlers
│   ├── agent/
│   │   ├── core.ts             # loop ReAct + tool use
│   │   ├── prompt-builder.ts   # monta prompt dinâmico
│   │   └── reflection.ts       # auto-reflexão
│   ├── tools/                  # ferramentas (cada uma um arquivo)
│   │   ├── _registry.ts        # exporta lista de tools
│   │   ├── register-transaction.ts
│   │   ├── query-balance.ts
│   │   ├── list-transactions.ts
│   │   ├── classify-transaction.ts
│   │   ├── identify-entity.ts
│   │   ├── parse-boleto.ts
│   │   ├── transcribe-audio.ts
│   │   ├── schedule-reminder.ts
│   │   ├── send-proactive-message.ts
│   │   └── compare-entities.ts
│   ├── memory/
│   │   ├── working.ts          # Redis
│   │   ├── episodic.ts         # Postgres queries
│   │   ├── semantic.ts         # agent_facts
│   │   ├── procedural.ts       # learned_rules
│   │   └── vector.ts           # pgvector
│   ├── identity/
│   │   ├── maia-prompt.md       # system prompt vivo
│   │   ├── load.ts             # carrega + injeta perfil interlocutor
│   │   └── update.ts           # evolui identidade
│   ├── workflows/
│   │   ├── engine.ts           # state machine
│   │   ├── close-month.ts
│   │   ├── request-balance-sheet.ts
│   │   └── follow-up.ts
│   ├── governance/
│   │   ├── rules.ts            # regras de não-agir-sozinha
│   │   └── audit.ts
│   ├── workers/
│   │   ├── briefing.ts         # cron 8h
│   │   ├── due-date-watch.ts   # vencimentos
│   │   └── anomaly-detect.ts
│   └── lib/
│       ├── claude.ts           # wrapper Anthropic SDK
│       ├── whisper.ts
│       └── utils.ts
└── tests/
```

---

## 6. Modelo de dados (visão geral)

Detalhe completo no arquivo `schema.sql`. Núcleo:

**Entidades / financeiro:**
- `entidades` (PF + 8 PJs)
- `contas_bancarias`
- `categorias`
- `transacoes`
- `transferencias_internas`
- `recorrencias`

**Pessoas / acesso:**
- `pessoas`
- `permissoes`
- `conversas`
- `mensagens`

**Inteligência:**
- `agent_facts` (memória semântica)
- `agent_memories` (memória vetorial)
- `learned_rules` (memória procedural)
- `self_state` (identidade evolutiva)
- `workflows` + `workflow_steps`

**Auditoria:**
- `audit_log`

---

## 7. Fases de entrega

### Fase 0 — Inventário (paralelo, sem código)
Mendes + esposa preenchem `inventario.md`. **Não bloqueia o desenvolvimento.**

### Fase 1 — MVP (3 a 4 semanas)
- Gateway Baileys conectado
- Agente com loop ReAct + 5 ferramentas (registrar/consultar/listar/classificar/identificar entidade)
- Memória episódica + semântica + procedural funcionando
- Identidade da Maia v0
- Conversa só com Mendes (testar antes de abrir para esposa/terceiros)
- Governance básica (limites, confirmações)

### Fase 2 — Multimídia + esposa (2 semanas)
- Transcrição de áudio (Whisper)
- OCR de boleto e comprovante (Claude Vision)
- Esposa cadastrada e ativa
- Memória vetorial (pgvector) + recall por similaridade

### Fase 3 — Ecossistema (2 a 3 semanas)
- Contadores e funcionários cadastrados
- Mensagens proativas (cobrar balancete, follow-up)
- Workflows (fechamento do mês, etc.)
- Aquecimento gradual do número

### Fase 4 — Importação + briefings (2 semanas)
- Parser OFX/CSV
- Reconciliação automática
- Briefing matinal, fechamento diário, resumo semanal
- Detecção de anomalia

### Fase 5 — Inteligência analítica (contínuo)
- Projeção de caixa
- Comparação entre empresas
- Dashboard web (Next.js)
- Aprendizado avançado de padrões

---

## 8. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Banimento WhatsApp | Aquecimento gradual, comportamento humano, backup de número |
| Erro de classificação | Confirmação na fase inicial, aprendizado com correção |
| Vazamento entre escopos | Filtros obrigatórios por `entidade_id` em toda query, testes específicos |
| Custo de API explodir | Haiku para tarefas simples, cache de respostas, rate limit |
| Maia agir errado em algo crítico | Governance hard-coded, audit log, modo "dry run" no início |
| VPS cair | Backup diário do Postgres, restart automático via systemd/docker |

---

## 9. Custos estimados

| Item | Mensal |
|------|--------|
| VPS (já tem) | R$ 0 |
| Domínio (já tem) | R$ 0 |
| Claude API (estimativa 100-300 transações/dia) | US$ 15-40 |
| Whisper API | US$ 5 |
| **Total** | **~R$ 100-250/mês** |

---

## 10. Próximos passos

**Imediato (esta entrega):**
- [x] Arquitetura documentada
- [x] Schema do banco
- [x] System prompt da Maia v0
- [x] Template de inventário
- [x] Estrutura do projeto + dependências
- [x] Docker compose

**Próxima entrega:**
- [ ] Gateway Baileys funcional
- [ ] Loop do agente com tool use
- [ ] 5 ferramentas básicas
- [ ] Migrations rodando
- [ ] Smoke test ponta a ponta
