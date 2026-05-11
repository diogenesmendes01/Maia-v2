# Maia v2 — Arquitetura Cognitiva — Design

**Date:** 2026-05-11
**Status:** Approved in brainstorm, pending spec review and user review.
**Scope:** Transformação arquitetural da Maia de assistente financeiro single-tenant em entidade cognitiva multi-tenant capaz de aprender qualquer profissão. Cobre 8 decisões arquiteturais e roadmap de 10 fases de implementação.
**Depends on:** Maia atual (ReAct loop, 5-layer memory, narrow reflection, workflows, audit log, governance, dashboard, 25+ tools) — todas as fundações são reaproveitadas, não reescritas.

---

## 1. Purpose

A Maia hoje é um assistente financeiro single-tenant com:
- ReAct loop (max 5 iter, `src/agent/react-loop.ts`)
- 5 camadas de memória (working/episodic/semantic/procedural/vector)
- Reflexão narrow — apenas sobre correções explícitas do usuário (`src/agent/reflection.ts`)
- Identidade estática em arquivo (`src/identity/maia-prompt.md`)
- `self_state` tabela usada como configuração, não autobiografia
- 16 workers, dashboard Fastify, sistema de tools com 25+ ferramentas

O objetivo da Maia v2 não é "Maia melhor". É **transformá-la numa entidade cognitiva** que:
1. Aprende com toda experiência (não só correções)
2. Sabe o que sabe e o que não sabe (self-model)
3. Tem identidade governada que evolui sob controle
4. Adquire procedimentos como objetos operacionais executáveis
5. Pode assumir múltiplos papéis através de canais distintos
6. Pede capacidades novas dialogicamente
7. Respeita integridade contextual da informação
8. Tem todas as suas decisões cognitivas auditáveis

**Frase-mãe do sistema:**

> *"A Maia aprende com a experiência, mas só evolui dentro de governança, escopo e evidência."*

Toda decisão arquitetural passa por 3 filtros: **governança** (quem aprova), **escopo** (onde aplica), **evidência** (em quê se baseia).

## 2. Goals

- Maia v2 reaproveita ao máximo a infraestrutura existente da Maia atual, evitando reescrita desnecessária — alguns componentes (gateway multi-channel, agent/core orchestration, prompt builder, identity resolution) recebem refactor significativo em fases específicas (notadamente P6)
- Cada fase de implementação é entregável testável independentemente
- Nenhuma fase quebra comportamento atual em produção (toda mudança aditiva ou com feature flag)
- Multi-tenant first-class desde o dia 1, com fail-closed em isolamento (NOT NULL forçado)
- Toda decisão cognitiva tem log auditável
- Memória sensível **influencia** comportamento mas **nunca é verbalizada** entre contextos
- Sistema suporta os 3 cenários (1 chip multi-papel, N chips setoriais, uso pessoal) como **configurações da mesma arquitetura**, não arquiteturas distintas

## 3. Non-goals

- Reescrever Baileys, governance, audit, ou qualquer infraestrutura existente
- Substituir `workflows` (multi-step tasks) — coexistem com procedures (sabedoria de domínio)
- Adotar framework de orquestração externo (LangGraph etc.) no curto prazo
- Self-service de criação de tools por end-user (fica pra fase muito posterior, fora do escopo)
- Cross-tenant data sharing (proibido inviolavelmente)
- Substituir a Maia atual abruptamente — migração é gradual e feature-flagged

## 4. Architectural Decisions

### 4.1 Loop de reflexão expandido + classificador tipado

A reflexão hoje só dispara em correções. Pra Maia v2, expande pra 4+1 gatilhos:

| Trigger | Frequência | Custo |
|---|---|---|
| Correção explícita (existente) | Imediata | Leve |
| Sucesso explícito (a) | Imediata | Leve |
| Conversa encerrada (b) | On-trigger (inatividade) | Médio |
| Padrão detectado (c) | Batch diária | Pesado |
| Auto-reconhecimento de lacuna pela Maia (d) | Imediata | Leve |

**Regra crítica:** trigger gera **candidato**, não regra direta. Um **classificador** decide o destino tipado:

```
trigger fires
   ↓
Reflector gera CANDIDATO (insight bruto + contexto)
   ↓
Classifier decide tipo:
   ├─ FATO          → agent_facts
   ├─ REGRA         → learned_rules
   ├─ PROCEDIMENTO  → procedure_definitions (status='draft')
   ├─ LACUNA        → agent_capability_gaps
   ├─ TOOL REQUEST  → capability_proposals (tipo=tool)
   └─ DESCARTE      → cognitive_module_log, nada salvo
```

Ver §6.1 pra schema completo.

### 4.2 Self-model: capacidades, gaps, confiança por evidência

A Maia ganha representação interna de **o que sabe**:

```
agent_capabilities_domain
├── domain: "fluxo de caixa de PJ"
├── confidence: 0.82 (DERIVED from evidence, NEVER from LLM)
├── evidence_count, last_success, last_failure
└── failure_modes (jsonb)

agent_capabilities_skill
├── skill: "classificar despesa CLT"
├── confidence: 0.92
├── evidence_count: 256
└── ...

agent_capability_gaps
├── capability: "consultar Pipefy"
├── tipo: 'tool' | 'knowledge' | 'procedure'
├── current_level: silent | dashboard | mentionable | proposed
├── frequency_score, severity_score
└── owner_decision
```

**Fórmula determinística (anti-alucinação):**

```
confidence = success_rate × maturity_factor × recency_factor
  success_rate = sucessos / (sucessos + falhas)
  maturity_factor = min(1, sqrt(evidence_count / N_min))
  recency_factor = exp(-days_since_last_failure / λ)
```

Granularidade controlada por 4 travas: threshold de evidências pra criar skill nova, clustering periódico, cap por domínio, hierarquia obrigatória.

### 4.3 Identidade operacional versionada (não autobiografia)

Internamente NÃO é "identidade narrativa" (humanizado, risco de drift). É **governança de comportamento**.

**4 camadas:**

1. **NÚCLEO IMUTÁVEL** — definido pelo owner. Imutável pelo agente.
2. **PERFIL OPERACIONAL APRENDIDO** — parâmetros calibrados por evidência (tom, vocabulário, thresholds). Não é prosa.
3. **MEMÓRIA EPISÓDICA TEMPORÁRIA** — contexto recente com TTL obrigatório. Antes de expirar, destilação extrai padrões.
4. **BACKLOG DE CRESCIMENTO APROVADO** — capacidades a desenvolver, aprovadas pelo owner.

**Regra dura inviolável:**

> *"A Maia pode gerar evidências sobre como está performando, mas não pode alterar sozinha quem ela é."*

`agent_operational_profile_versions` é append-only com status `{proposed, active, frozen, rolled_back}`. Status `proposed` NUNCA entra em runtime.

**Drift detector** monitora 7 tipos × 4 severidades:

| Tipo | Detecção |
|---|---|
| Tom | LLM-as-judge contra descritor de voz do núcleo |
| Valores | LLM verifica proposta vs valores do núcleo |
| Confiança | Cross-check com self-model real |
| Viés | Regex + LLM busca generalizações |
| Escopo | Promete o que não tem em `agent_capabilities`? |
| Linguagem | Vocabulário vs corpus de referência |
| Procedimento | Procedimento novo de 1-2 evidências = drift |

Severidades: `BAIXO` (auto-aprova) / `MÉDIO` (fila humana) / `ALTO` (congela proposta) / `CRÍTICO` (rollback automático).

### 4.4 Procedimentos como objetos operacionais executáveis

Procedimento ≠ regra. Regra é if-then atômico. Procedimento é **manual de comportamento profissional** com gatilhos, passos, decisões, tools, critérios de sucesso, falhas comuns, versão.

**Frase-chave inviolável:**

> *"Procedimento não é memória. Procedimento é runtime stateful de uma habilidade profissional."*

**Schema (event-sourced):**

```
procedure_definitions       -- sabedoria, versionada, imutável quando active
procedure_assignments       -- definitions vinculadas a agents/roles (sem duplicar)
procedure_executions        -- estado atual (derivado de events)
procedure_execution_events  -- VERDADE (event sourcing)
procedure_metrics           -- view materializada
procedure_tests             -- cenários
procedure_selector_decisions -- log de TODA decisão do procedure selector
```

**Success criteria são TIPADOS** — não toda verificação é igual:
- `machine_check` (regex, validação programática)
- `llm_judge` (subjetivo, com threshold)
- `tool_result` (status externo)
- `user_signal` (acordo do usuário)
- `human_confirmed` (operator aprova)

**Runtime stateful:** procedure_execution persiste entre turnos. Conversa retomada 3 dias depois continua o passo onde parou.

**Aquisição em 3 modos coexistentes:**
- ENSINO (owner ensina explicitamente)
- OBSERVAÇÃO (shadowing — agente assiste owner em casos reais)
- PRÁTICA (agente tenta, reflexão consolida após N evidências)

Todos passam por `propose → validate → approve → active`.

### 4.5 Agent ≠ Channel ≠ Role + Channel Policy

Separação ortogonal de 4 conceitos:

```
Tenant
  └── Agent (1+ por tenant — limite de identidade/memória/governança)
       └── Channel (N por agent — entrada de mensagem)
            └── Channel Policy (governa como roles operam aqui)
                 └── Role (modo operacional — comercial/suporte/...)
```

**Princípio:**

> *"A Maia deve ser uma identidade única com papéis operacionais configuráveis, e cada canal define se esses papéis serão dinâmicos, fixos ou híbridos."*

**Role Engine** aplica policy (executa a decisão, não é fonte dela):
- LLM **sugere** role: `suggested_by ∈ {llm_classifier, deterministic_classifier, none}`
- Policy **decide**: `decided_by ∈ {policy_default, policy_rule, owner_override, fallback_rule}` — o Role Engine é o **executor** dessas regras, nunca aparece como decisor (auditoria limpa)
- `switch_behavior` ∈ `{locked, prefer_handoff, free_with_trigger, by_context}`
- Quando `by_context`: travas anti-oscilação (min_confidence_to_switch, cooldown, required_strength_delta)
- Anúncio de troca: `{always, never, affects_user}` — não artificial, natural quando relevante

**Cenários como configurações de policy (não arquiteturas distintas):**
- Empresa pequena, 1 chip → 1 channel, policy=free_with_trigger
- Empresa grande, N chips setoriais → N channels, policy=locked ou prefer_handoff
- Uso pessoal multi-área → policy=by_context com travas
- Holding multi-marca → múltiplos agents, cada com channels próprios

### 4.6 Aquisição dialógica de capacidades

Quando Maia identifica gap, ela **participa** da resolução — mas com governança rigorosa.

**Princípio:**

> *"A Maia deve participar da própria evolução, mas não comandar a evolução."*

**4 níveis de escalada determinísticos (não julgamento LLM):**

Valores canônicos em string: `silent`, `dashboard`, `mentionable`, `proposed` (snake_case por §10.10 naming convention).

| Nível | Trigger | Ação |
|---|---|---|
| `silent` | 1ª ocorrência | Só registra |
| `dashboard` | frequency_score ≥ threshold | Dashboard, ainda silenciosa ao usuário |
| `mentionable` | severity_score alto | Maia autorizada a mencionar limitação |
| `proposed` | padrão claro (freq + sev + contexto) | Maia gera capability_proposal formal |

**Maia PODE:** propor specs, testar capacidade entregue, dar feedback.
**Maia NÃO PODE:** decidir prioridade, criar tool sozinha, ativar capacidade crítica sem aprovação.

**Loop fechado:**
```
gap detectado → escalada → proposta (nível 4) → owner decide → capability entregue
→ event "capability_acquired" → Maia testa → passa? gap resolved + retenta cenário original
```

### 4.7 Memória escopada por utilidade, sensibilidade e permissão

**Princípio:**

> *"A Maia pode lembrar para não ser inconveniente, mas não para puxar assunto pessoal do nada."*

**6 controles + flag de revisão + escopo rico:**

```
memory_entry
├── memory_type ∈ {operational, preference, personal, sensitive, unknown}
│                       -- "unknown" só durante migração legada (P2)
├── scope_type ∈ {conversation, interlocutor, channel, role, agent, tenant}
├── subject_id (string)  -- id da entidade escopada (conversa_id, pessoa_id, channel_id, ...)
├── sensitivity ∈ {low, medium, high}
├── proactive_use (bool)
├── mention_allowed (bool)
├── needs_review (bool, default false)
│                       -- true durante migração até classifier processar;
│                          enquanto true, BLOQUEIA uso no prompt builder
└── ttl_days (nullable)
```

`scope_type` mais rico evita jogar memória de interlocutor no agent-wide por falta de granularidade. Ex: "Marina prefere atendimento de manhã" tem `scope_type=interlocutor, subject_id=marina_id`, não `scope=agent`.

**Memória sensível tem CAMADA DERIVADA — bruta nunca entra no prompt:**

```
memory_entry (raw)
├── ... (sensitive, mention_allowed=false, proactive_use=false)
└── PROTEGIDA — prompt builder NUNCA injeta diretamente

behavioral_hint (derivado pelo memory classifier + worker)
├── id, scope_type, subject_id
├── hint_text ("usar tom mais paciente" / "evitar pressão neste turno" / "não insistir em pagamento")
├── derived_from_memory_id (FK opcional pra rastreio interno)
├── derived_sensitivity ∈ {low, medium, high}  -- sensibilidade da memória origem
├── ttl_days (default: igual à memória origem; extensão requer campos abaixo)
├── extension_reason (text, REQUIRED quando ttl > memória origem)
├── extension_approved_by (FK user, REQUIRED quando ttl > memória origem)
├── extension_approved_at
├── expires_at
└── revoked_at
```

**Regras invioláveis do `hint_text`:**

1. NUNCA referencia o fato sensível original direta ou indiretamente. O texto do hint não pode revelar o conteúdo bruto da memória mesmo por inferência.

   - ❌ Ruim: "evitar falar de doença da filha" — revela tema sensível
   - ❌ Ruim: "não mencionar divórcio" — revela fato bruto
   - ✅ Bom: "usar tom mais paciente neste relacionamento"
   - ✅ Bom: "evitar pressão por decisão rápida neste contexto"
   - ✅ Bom: "ser flexível com prazos quando possível"

2. Worker `behavioral-hint-validator` (sync ao criar, antes de persistir) verifica via LLM se o hint passa o teste de não-revelação. Hints que falham são rejeitados ou reescritos.

3. Auditoria: toda criação de hint loga `derived_from_memory_id` (com ACL pra ver bruto), `hint_text`, e resultado do validator.

**Extensão de TTL além da memória origem:**

Default: hint expira junto com memória bruta. Tenant pode estender até 30d, MAS:
- Requer `extension_reason` declarado explicitamente
- Requer `extension_approved_by` (não auto-aprovação)
- `derived_sensitivity=high` requer aprovação dupla (4-eyes)
- Extensão é re-validada periodicamente — worker checa se reason ainda se aplica

Útil em contextos onde a sensibilidade permanece relevante (ex: situação familiar contínua), mas com auditoria forte pra justificar carregar efeito comportamental de informação já apagada.

**Defaults por type:**

| memory_type | scope | proactive_use | mention_allowed | ttl_days |
|---|---|---|---|---|
| operational | agent | ✅ | ✅ | — |
| preference | **interlocutor** (default) — `channel`/`agent` só com classificação explícita | ✅ | ✅ | — |
| personal | role | ❌ | ❌ até usuário trazer | 30 |
| sensitive | conversation | ❌ (só influência) | **nunca** | 7 |

**Influência indireta sem citação:** memória sensível **modula comportamento** (paciência, ritmo, ausência de pressão) mas conteúdo nunca aparece literal no prompt.

Exemplo: Marina abre sobre filha doente com vendedora. Pedagógico depois não sabe. Mesmo se a memória chegasse ao prompt, `mention_allowed=false` impede verbalização. Default é certo. Evita "creepy effect".

### 4.8 Orquestração: grafo cognitivo leve

Módulos cognitivos como **nodes** num grafo interno (não LangGraph — caseiro de ~200 linhas):

```ts
{
  name: "critic",
  required: false,
  runWhen: ["risk_high", "low_confidence", "sensitive_topic"],
  timeoutMs: 1500,
  fallback: "skip_and_log",
  model: "haiku",
  audit: true,
  parallelizable: true,
  version: "v3"
}
```

**Regra-mãe:**

> *"O atendimento não pode travar por módulo periférico. Mas toda decisão cognitiva precisa ser rastreável."*

**3 camadas de execução:**

1. **SYNC OBRIGATÓRIO** — caminho crítico: Perceiver, Selector, Memory Retriever, Prompt Builder, Reasoner, Safety Check
2. **SYNC CONDICIONAL** — Critic, Step Evaluator, Memory Classifier (rodam só se trigger)
3. **ASYNC** — Reflector, Insight Classifier, Pattern Detector, Drift Detector, Memory Distillation, Capability Escalation

**Modelo certo pro trabalho:**
- Haiku: classificadores, selectors, evaluators, critics
- Sonnet: reasoner principal, reflector, drift detector
- Opus: decisões críticas raras
- Determinístico (sem LLM): capability escalation, TTL workers

`cognitive_module_log` registra TODA execução: módulo, versão, prompt versão, modelo usado, tokens, latência, fallback?, status.

## 5. Cross-cutting Principles

### 5.1 Isolamento entre tenants (inviolável)

Maias de tenants diferentes **nunca** se comunicam, compartilham dados, ou herdam aprendizado. Sem exceção.

**Modelo de 3 círculos de confiança:**
1. **Intra-tenant**: Agents do mesmo tenant podem colaborar por **handoff explícito**, **memória escopada** e **policies de canal**, sempre com `role_selector_decisions` e audit. **Não é colaboração livre** — cada interação cross-agent passa por policy e respeita visibilidade de memória (§4.7). Mesmo dentro do tenant pode haver marcas distintas, setores sensíveis, IP separado.
2. **Plataforma curada**: sabedoria genérica anonimizada, com opt-in duplo (contribuir + receber), curada pelo owner da plataforma
3. **Cross-tenant direto**: nunca

`tenant_id` é invariante de código (igual `entidade_id` que já existe). Toda query passa por tenant_guard middleware.

### 5.2 Propagação segura de aprendizado

Cross-tenant wisdom (quando opt-in) passa por pipeline:

```
Maia gera evidência → classificador local-vs-global → validador de risco
→ fila de aprovação (auto-aprova condições estritas, humano revisa resto)
→ platform_wisdom (anonimizada, versionada, revogável)
```

Auto-aprova só se: risco < 0.15 + classificador > 0.85 + tópico em allow-list + similar a outra já aprovada.

### 5.3 Governança como filtro contínuo

Toda mudança proposta a:
- Núcleo de identidade → owner direto, confirmação dupla
- Perfil operacional → drift detector + aprovação por severidade
- Procedure ativa → propose → validate → approve → active
- Capability → escalation + capability_proposal + owner
- Memory scope promotion → aprovação explícita

Nada cresce no agente sem passar por um gate.

## 6. Schema Overview

### 6.1 Tabelas novas (10 fases)

**P0 — Foundation:**
- Colunas `tenant_id`, `agent_id` adicionadas em toda tabela relevante
- `tenants`, `agents` (com row default pra Maia atual)

**P1 — Reflexão + Cognitive Wrapper:**
- `cognitive_module_log`

**P2 — Memory + Self-model:**
- `memory_entry` (6 controles)
- `agent_capabilities_domain`, `agent_capabilities_skill`
- `agent_capability_gaps`

**P3a — Procedures: definição:**
- `procedure_definitions`, `procedure_assignments`

**P3b — Procedures: execução:**
- `procedure_executions`, `procedure_execution_events`
- `procedure_selector_decisions`

**P3c — Procedures: governança:**
- `procedure_metrics` (view materializada)
- `procedure_tests`

**P4 — Identidade versionada:**
- `agent_operational_profile_versions`
- `agent_drift_alerts`

**P5 — Capability acquisition:**
- `gap_escalation_rules`
- `capability_proposals`, `capability_test_results`

**P6 — Channel/Role/Policy:**
- `channels`, `roles`, `channel_policies`
- `role_selector_decisions`

**P7 — Grafo cognitivo:**
- Sem novas tabelas (reuso de `cognitive_module_log`)

### 6.2 Tabelas existentes reaproveitadas

- `agent_facts`, `learned_rules`, `agent_memories`, `self_state` — continuam, com migration conservadora pra `memory_entry`
- `audit_log` — fonte primária de eventos pra reflexão
- `workflows`, `workflow_steps` — coexistem com procedures (concepts distintos)
- `pessoas`, `conversas`, `mensagens` — base
- `pending_questions`, `idempotency_keys`, `permissoes` — governance existente

## 7. Implementation Roadmap (10 entregas em 8 marcos)

**Nomenclatura padrão:** P0, P1, P2, P3a, P3b, P3c, P4, P5, P6, P7 — **10 entregas** organizadas em 8 marcos (P3 é entregue em 3 marcos: P3a/P3b/P3c). Issues, milestones, migrations e tracking usam essa nomenclatura.

| Fase | Conteúdo | Duração | Risco |
|---|---|---|---|
| **P0** | Foundation: `tenants` + `agents` + tenant/agent_id em tabelas relevantes + `tenant_guard` + `cognitive_module_log` + enums base + feature flag framework + NOT NULL forçado. **Schemas dormentes de fases futuras NÃO entram aqui — vêm no início da fase proprietária.** | 2 sem | baixo |
| **P1** | Reflexão expandida + classifier tipado + cognitive module wrapper básico | 2-3 sem | baixo-médio |
| **P2** | Memory scoping (6 controles, migration conservadora) + self-model (confidence determinística) | 3-4 sem | médio |
| **P3a** | Procedures: schema + definitions + assignments + modo ENSINO | 2 sem | médio |
| **P3b** | Procedures: execution runtime + selector + step evaluator básico | 2-3 sem | médio-alto |
| **P3c** | Procedures: metrics + tests + reaper + step evaluator completo | 2 sem | médio |
| **P4** | Identidade operacional versionada + drift detector (paralelo a self_state, feature flag) | 3 sem | médio |
| **P5** | Aquisição dialógica: 4-level escalation + proposals + test loop | 3 sem | médio |
| **P6** | Channel/Role/Policy + Role Engine + multi-channel Baileys | 5-7 sem | alto |
| **P7** | Grafo cognitivo completo + orquestração formal | 2-3 sem | médio |

**Total: 26-32 semanas (~6-7,5 meses) de dev focado.**

### 7.1 Sub-faseamento de P0 (fail-closed em isolamento)

```
P0.1 — adiciona colunas nullable com default 'default'
P0.2 — backfill em batch (rows existentes ganham 'default')
P0.3 — cria índices em (tenant_id, agent_id, *)
P0.4 — tenant_guard middleware em todas queries dos repos
P0.5 — flip NOT NULL constraint
```

Critério "P0 done": qualquer query sem tenant_id explícito **falha** em runtime.

### 7.2 Memory migration conservadora (P2)

```sql
INSERT INTO memory_entry (..., memory_type, proactive_use, mention_allowed, needs_review)
SELECT ..., 'unknown', false, false, true
FROM agent_facts;
```

Worker `legacy-memory-reclassifier` reprocessa em batch via memory_classifier. Enquanto `needs_review=true`, prompt builder **não injeta** essas memórias. Fail-closed.

### 7.3 Identity migration paralela (P4)

```
P4.1 — cria agent_operational_profile_versions vazia
P4.2 — proposal generator gera primeira versão active a partir de self_state + maia-prompt.md
P4.3 — flag FEATURE_OPERATIONAL_PROFILE_V2 (default off)
P4.4 — prompt-builder lê do novo schema quando flag on
P4.5 — após 2+ semanas estável, flag default on
P4.6 — self_state legado vira read-only, depois deprecated em release seguinte
```

Rollback é trivial (flip da flag).

### 7.4 Sequência de valor

| Etapa | Fases | Duração | Valor entregue |
|---|---|---|---|
| Quick wins | P0–P2 | ~7-9 sem | Reflexão expandida, sem alucinação de confiança, memória segura |
| Salto qualitativo | P3a–P3c | ~6-7 sem | Procedures funcionando = "aprende qualquer profissão" |
| Segurança operacional | P4, P5 | ~6 sem | Identidade governada + evolui via diálogo |
| Expansão arquitetural | P6 | ~5-7 sem | Multi-channel/multi-role |
| Governança final | P7 | ~2-3 sem | Orquestração formal e auditável |

### 7.5 Pontos de bifurcação

1. **Schema-only mais agressivo em P0** — adiantar SQL até P5 já no P0 (todas tabelas vazias). Trade: P0 fica 50% maior, P1-P5 saem mais rápido.
2. **P4 antes de P3** — consolidar governança antes de adicionar grande novo subsistema. Trade: atrasa o "salto qualitativo".
3. **P6 adiantado** — só se caso de uso real demandar. Risco alto adiantar refactor grande.

## 8. Module Map

### 8.1 Módulos cognitivos (após P7)

| Módulo | Origem (fase) | Quando roda | Modelo |
|---|---|---|---|
| Perceiver / Intent Classifier | P1 | Sync, por turno | Haiku |
| Role Selector | P6 | Sync, por turno | Haiku |
| Memory Retriever | P2 | Sync, por turno | Determinístico |
| Memory Classifier | P2 | Sync ao extrair + async batch | Haiku |
| Prompt Builder | Existente, expandido | Sync, por turno | Determinístico |
| Reasoner (ReAct) | Existente | Sync, por turno | Sonnet |
| Step Evaluator | P3b | Sync, em procedure | Haiku |
| Critic | P1 (estrutura) + P7 (uso) | Sync condicional | Haiku |
| Safety Check | Existente | Sync, por turno | Determinístico |
| Risk Assessor | P1 (estrutura) + P2 (uso real) | Sync — determinístico sempre + LLM condicional só em ambíguos | Determinístico + Haiku (quando necessário) |
| Reflector | P1 | Async, gatilhos | Sonnet |
| Insight Classifier | P1 | Async, após Reflector | Haiku |
| Drift Detector | P4 | Async, semanal | Sonnet |
| Memory Distillation | P2 | Async, antes do TTL | Haiku |
| Capability Escalation | P5 | Async, worker | Determinístico |
| Capability Proposer | P5 | Async, em escalada nível 4 | Sonnet |

### 8.2 Workers

Existentes reaproveitados: `reflection-batch`, `conversation-summarizer`, `audit-watcher`, etc.

Novos: `pattern-detector`, `confidence-recompute`, `legacy-memory-reclassifier`, `procedure-execution-reaper`, `procedure-metrics-refresh`, `identity-proposal-generator`, `drift-monitor`, `gap-escalation`, `behavioral-hint-validator` (sync na criação de hint, rejeita hints que revelam fato bruto), `hint-extension-revalidator` (worker periódico checa se reason de extensão ainda se aplica).

## 9. Acceptance Gates

Cada entrega só é considerada "done" quando os critérios abaixo são provados por teste/observação, não por declaração.

### P0 — Foundation done quando:
- Toda query sem `tenant_id` explícito **falha em runtime** (tenant_guard middleware aplicado)
- `tenant_id` e `agent_id` são **NOT NULL** em todas as tabelas relevantes
- Teste de integração prova isolamento (tenant A não consegue ler dados de tenant B mesmo via injeção)
- Backfill cobre 100% das rows existentes
- Rollback testado (revert da migration NOT NULL volta a nullable sem perda)
- `cognitive_module_log` schema criada e ativa (já registra eventos de Reflector existente)
- `src/types/enums.ts` com enums base (TenantStatus, AgentStatus, CognitiveEventType inicial)
- Feature flag framework funcional (pelo menos uma flag testável com kill switch)

### P1 — Reflexão expandida + Cognitive Wrapper done quando:
- 4 triggers novos (sucesso, conversa_encerrada, padrão_detectado, gap_interno) geram candidatos; correção existente continua funcionando — todos passam pelo classifier
- Classifier tipa output em 6 destinos (fato/regra/procedimento/lacuna/tool_request/descarte)
- `runCognitiveModule()` wrapper aplicado em pelo menos Reflector e Classifier
- `cognitive_module_log` registra TODAS as execuções desses módulos
- Reflexão sobre correção (existente) continua funcionando idêntico

### P2 — Memory + Self-model done quando:
- Memória `needs_review=true` **nunca** entra no prompt builder (teste prova)
- Memória sensível raw **nunca** aparece verbalizada na saída do agente (teste de regressão de N cenários)
- `behavioral_hint` modula tom em conversa sensível sem revelar origem
- `confidence` calculada pela fórmula determinística (não LLM) — auditável no dashboard
- Self-awareness aparece no prompt quando skill < threshold ("isso eu ainda estou aprendendo")

### P3a — Procedures: definição done quando:
- Owner consegue criar procedure via modo ENSINO end-to-end
- Procedure tem `status=draft` → `proposed` → `active` → `frozen`/`rolled_back`
- Versionamento imutável (active não é editável; mudança = nova versão)
- Procedure assignments funcionam (mesma definition em N agents/roles via customizations)

### P3b — Procedures: execução done quando:
- `procedure_execution` persiste estado entre turnos (teste: conversa retomada 24h+ depois continua do passo certo)
- `procedure_execution_events` permite **reconstruir** toda execução do zero
- Selector decide entre procedures concorrentes via confidence + conflict
- Step evaluator avança passo só quando critério (machine_check, tool_result) é cumprido
- Rollback de execução em andamento funciona (abort → status=aborted, audit)

### P3c — Procedures: governança done quando:
- `procedure_metrics` view recalculável do zero a partir de events
- `procedure_tests` rodam em CI antes de promover proposed → active
- Worker reaper força `status=abandoned` após 7d de inatividade
- Step evaluator suporta TODOS os 5 tipos de criteria (machine, tool, llm_judge, user_signal, human_confirmed)

### P4 — Identidade operacional versionada done quando:
- `agent_operational_profile_versions` ativa com `status=proposed` NUNCA entra em runtime
- Drift detector classifica em 7 tipos × 4 severidades, com decisões auditadas
- Rollback via feature flag funciona em < 1 minuto (sem deploy)
- self_state legado continua funcional em paralelo (não foi quebrado)

### P5 — Aquisição dialógica done quando:
- Gap em nível SILENT não notifica owner
- Gap atinge nível PROPOSED só por critério determinístico (freq + sev + contexto), nunca por LLM
- `capability_acquired` event dispara teste automatizado antes de ativar
- Tool falha pós-ativação abre novo gap técnico, agente reverte uso

### P6 — Channel/Role/Policy done quando:
- LLM **apenas sugere** role (`suggested_by=llm_classifier` em todas as decisões)
- Policy **decide** role (`decided_by` jamais é `llm_classifier`)
- Toda troca de role registrada em `role_selector_decisions` (mesmo "manter atual")
- `by_context` com travas anti-oscilação previne mais de 3 trocas por conversa (default)
- Maia atual migra pra (1 agent / 1 channel / 1 role / policy=free_with_trigger) sem mudança visível

### P7 — Grafo cognitivo done quando:
- Falha de qualquer módulo periférico (Critic, Step Evaluator, etc.) **não derruba resposta**
- Comportamento user-facing idêntico ao pré-P7 (refactor sem regressão)
- `cognitive_module_log` cobre 100% das execuções de módulo
- Latência **p95** do sync path ≤ baseline pré-P7 **+ 20%** (configurável por tenant; default 20%). Métrica mensurável em vez de "manter igual" — realista após adição de Risk Assessor, Critic condicional, Step Evaluator, Role Selector etc.

---

## 10. Implementation Contracts

Decisões de implementação que devem ser **invariantes** ao longo de todo o desenvolvimento. Servem pra evitar "interpretação livre" na hora de virar código.

### 10.1 Enums oficiais

**CognitiveEventType** (usado por workers, reflection-batch, audit):

```ts
type CognitiveEventType =
  | "user_correction"
  | "success_explicit"
  | "conversation_closed"
  | "pattern_detected"
  | "internal_gap"
  | "procedure_completed"
  | "procedure_aborted"
  | "capability_acquired"
  | "drift_alert"
```

Outros enums críticos (definição completa nos schemas):
- `MemoryType`, `MemoryScopeType`, `SensitivityLevel`
- `ProcedureStatus`, `ExecutionStatus`, `OutcomeType`
- `DriftType`, `DriftSeverity`
- `GapLevel`, `ProposalStatus`
- `SwitchBehavior`, `SelectorStrength`, `AnnounceMode`
- `SuccessCriteriaType`

Cada enum vive em `src/types/enums.ts`, é a única fonte de verdade. Não há strings literais espalhadas no código.

### 10.2 Model tiers (não hardcoded)

```ts
type ModelTier = "fast" | "reasoning" | "critical" | "deterministic"
```

Mapeamento real em config (env-overridable):
- `fast` → atualmente `claude-haiku-4-5-20251001`
- `reasoning` → atualmente `claude-sonnet-4-6`
- `critical` → atualmente `claude-opus-4-7`
- `deterministic` → não-LLM (regras, cálculos)

Módulos declaram tier, não modelo. Troca de modelo = mudança de config, zero refactor.

### 10.3 Idempotência de workers

Todo worker que processa eventos segue contrato:

- Cada evento tem `event_id` único (uuid v7 ou similar)
- Worker mantém `worker_event_processed (worker_name, event_id)` com unique constraint
- Antes de processar: INSERT ... ON CONFLICT DO NOTHING; se NOTHING → skip
- Após processar: commit junto com o trabalho (mesma transação)
- Falha de retry não cria duplicata (idempotency garantida)
- Workers concorrentes usam `SELECT FOR UPDATE SKIP LOCKED` ou advisory locks

Candidatos de reflexão são deduplicados por `(agent_id, content_hash)` antes de classificar.

### 10.4 Budget de custo e latência

Limites declarados como config por agent/tenant:

```ts
type RuntimeBudget = {
  max_tokens_per_turn: number       // default: 8000
  max_cost_per_conversation: number // default: $0.50
  max_latency_sync_path_ms: number  // default: 8000
  max_latency_periphery_ms: number  // default: 1500
  fallback_when_budget_exceeded: "skip_periphery" | "use_fast_tier" | "escalate_human"
}
```

Módulos `runWhen` checam budget antes de rodar. Periféricos podem ser pulados quando budget aperta. Reasoner principal nunca é pulado, **mas degradação de tier é condicional ao risk_level (§10.11):**

- `risk_level=low`: Reasoner pode cair pra `fast` tier em modo degradado
- `risk_level=medium` ou superior: Reasoner **NUNCA degrada de tier**. Em vez disso:
  - reduz contexto (memórias menos relevantes saem)
  - pula periféricos não-essenciais
  - se ainda estourar: **escala pra humano**

Casos sensíveis (jurídico, financeiro, saúde, decisões críticas) NUNCA são respondidos por modelo fraco só por economia.

### 10.5 Retenção e redação de logs

| Log | Retenção | Conteúdo |
|---|---|---|
| `audit_log` | 5 anos (LGPD-aware) | Eventos rotulados; conteúdo bruto **redigido** após 90d |
| `cognitive_module_log` | 90 dias | Input/output **hash** (não bruto) por padrão. Debug com `debug_payload_id` (FK opcional pra `cognitive_debug_payloads`) — TTL curto (7d), acesso requer `role=admin` + `audit_reason` registrado. Redação automática de PII no `redacted_payload` é alternativa intermediária. |
| `mensagens` | conforme política tenant | Conteúdo bruto sujeito a redação automática (PII detector) após X dias |
| `behavioral_hint` | TTL próprio | Conteúdo é hint genérico, não dado pessoal |
| `memory_entry` (sensitive) | TTL curto (7d default) | Bruto protegido — NUNCA exportável |

ACL no dashboard: visualização de logs sensíveis exige `role=admin + audit_reason` registrado.

### 10.6 Separação de selector_decisions

Não há tabela `selector_decisions` genérica. Há duas:

- `procedure_selector_decisions` — decisões do procedure selector (item 4)
- `role_selector_decisions` — decisões do role selector (item 5)

Ambas seguem a estrutura `candidates / conflicts / decision / decided_by / suggested_by`. Não compartilham tabela física pra evitar acoplamento conceitual.

### 10.7 Regra de precedência

Quando múltiplas fontes geram contexto/instrução que poderiam entrar no prompt, a ordem de precedência é:

```
1. NÚCLEO IMUTÁVEL (valores, voz, limites éticos)
2. CHANNEL POLICY (regras do canal + role atual)
3. PROCEDURE ATIVA (se houver execução em andamento)
4. LEARNED_RULES (regras aprendidas relevantes)
5. MEMORY_ENTRY operacional (visibilidade permite)
6. BEHAVIORAL_HINT (modulação derivada de memória sensível)
```

Conflito entre níveis: **nível superior sempre ganha**. Prompt builder resolve no momento de assembly (não confia o LLM pra reconciliar). Conflitos detectados são logados em `cognitive_module_log` com `flag=conflict_resolved`.

### 10.8 Definição de "schemas dormentes"

Tabela "dormente" é definida por 3 critérios:

1. **Schema completo na criação** — todas as colunas, tipos, constraints, índices. Não nasce parcial.
2. **`write_disabled` flag em config** — código pode `SELECT` mas não `INSERT/UPDATE` até a fase responsável ativar.
3. **Trigger ou check constraint** valida que nenhum write acontece antes da ativação (defensa em profundidade).

**Quando schemas dormentes são criados:** no **início da fase proprietária**, NÃO todos em P0 (evita inflar P0 e mantém migrations escopadas).

**P0 cria apenas (não-dormente):**
- `tenants`, `agents`
- Colunas `tenant_id`/`agent_id` em tabelas existentes
- `cognitive_module_log` (ativa imediatamente)
- Enums base em `src/types/enums.ts`
- Feature flag framework

**Schemas criados (e inicialmente dormentes) por fase proprietária:**
- P2 cria: `memory_entry`, `behavioral_hint`, `agent_capabilities_domain`, `agent_capabilities_skill`, `agent_capability_gaps`
- P3a cria: `procedure_definitions`, `procedure_assignments`
- P3b cria: `procedure_executions`, `procedure_execution_events`, `procedure_selector_decisions`
- P3c cria: `procedure_tests` (`procedure_metrics` é view materializada — criada junto)
- P4 cria: `agent_operational_profile_versions`, `agent_drift_alerts`
- P5 cria: `gap_escalation_rules`, `capability_proposals`, `capability_test_results`
- P6 cria: `channels`, `roles`, `channel_policies`, `role_selector_decisions`
- P7 não cria tabelas novas (reuso de `cognitive_module_log`)

Cada fase ativa suas tabelas (remove `write_disabled`) junto com flip da feature flag correspondente.

### 10.9 Feature flags obrigatórias

| Flag | Default em prod | Fase que ativa | Rollback |
|---|---|---|---|
| `FEATURE_EXPANDED_REFLECTION` | off | P1 → on | flip |
| `FEATURE_MEMORY_SCOPING_V2` | off | P2 → on | flip + worker re-injeta legado |
| `FEATURE_OPERATIONAL_PROFILE_V2` | off | P4 → on após 2sem stable | flip + volta self_state legado |
| `FEATURE_PROCEDURE_RUNTIME` | off | P3b → on | flip (procedures em execução são abortadas com outcome=feature_flag_revert) |
| `FEATURE_DIALOGICAL_ACQUISITION` | off | P5 → on | flip |
| `FEATURE_MULTI_CHANNEL` | off | P6 → on | flip + roteamento volta pro chip default |
| `FEATURE_COGNITIVE_GRAPH` | off | P7 → on | flip + volta orquestração ad-hoc |

Flags vivem em `config/feature_flags.ts` + override em `.env`/dashboard. Cada flag tem owner (humano responsável) e janela de avaliação documentada.

### 10.10 Naming conventions

- Tabelas: `snake_case` plural (`procedure_definitions`)
- Colunas: `snake_case` (`current_step_id`)
- Enums TypeScript: `PascalCase` (`ProcedureStatus`)
- Valores de enum: `snake_case` em string (`"in_progress"`)
- Eventos: `snake_case` (`"procedure_completed"`)
- Workers: `kebab-case` em filename (`pattern-detector.ts`)
- Módulos cognitivos: `kebab-case` em filename, `camelCase` em código (`procedure-selector.ts` → `procedureSelector`)

### 10.11 Risk Levels (oficiais)

Enum oficial usado pra modular Critic, model tier, tool use, escalation e budget. Define com precisão o que cada nível significa pra evitar interpretação livre por módulo.

```ts
type RiskLevel = "low" | "medium" | "high" | "critical"
```

**Quem calcula:** módulo `risk-assessor` em **dois estágios** pra controlar custo:

```
Stage 1: Determinístico (sempre, cheap, sem LLM)
  - Tópico da conversa via keyword/regex (saúde, jurídico, financeiro, decisão crítica → sobe)
  - Tipo de tool a ser usada (write externo, transferência, ações irreversíveis → sobe)
  - Self-model confidence (skill abaixo de threshold no domínio → sobe)
  - Memória sensível ativa (presence de behavioral_hint derivado de sensitive → sobe)
  - Procedure ativa com passos marcados `critical_step` → sobe
  - Risk override declarado pelo owner → trava ou sobe
  
  Output: { level, confidence, ambiguous: bool }

Stage 2: LLM-as-judge (CONDICIONAL — só se Stage 1 detectou ambíguo ou risco potencial)
  - Roda apenas se: ambiguous=true OU possible_sensitive_topic detectado mas pouco claro
  - Modelo: fast tier (Haiku)
  - Pode subir o nível mas NUNCA pode baixar (monotônico)
```

Conversa claramente simples (operacional, sem sinais) não dispara LLM — fica em `low` por construção. Isso preserva o princípio "sync mínimo" do §8.

**Defaults iniciais:** `low` em conversas casuais e operacionais simples.

**Efeitos por nível (invariantes do sistema):**

| RiskLevel | Critic | Model tier (Reasoner) | Budget fallback | Escalation |
|---|---|---|---|---|
| **low** | opcional (só se `low_confidence`) | pode cair pra `fast` em modo degradado | pular periféricos OK | não |
| **medium** | **obrigatório** | NUNCA cai de tier | reduzir contexto, pular periféricos | considerar se confidence < 0.6 |
| **high** | **obrigatório + cooldown entre tools** | `reasoning` fixo, considerar `critical` em ramo sensível | NÃO economiza — gasta full | escalar se confidence < 0.7 |
| **critical** | **obrigatório + double-check (2 passadas)** | `critical` tier obrigatório | NÃO economiza, jamais | escalar **SEMPRE** ao operador antes de qualquer ação irreversível |

**Transição — dois escopos coexistentes (resolve "risco grudando demais"):**

WhatsApp tem conversas longas com tópicos mistos. Um único `risk_level` global gruda no nível alto e contamina interações simples posteriores. Solução: **dois escopos paralelos**:

```
global_risk_level (por conversa)
  - Monotonicamente crescente dentro da conversa
  - Captura "essa conversa entrou em território sensível em algum momento"
  - Reset só por: nova conversa OU operador marca resolvido OU > N dias de inatividade

local_risk_level (por tópico/procedure ativa)
  - Recalculado quando active_topic muda
  - Captura "esse turno específico está tratando do quê"
  - Pode estar low mesmo com global high
```

**Regra de uso:**
- Ações **operacionais simples** checam apenas `local_risk_level`
- Ações **sensíveis** (escrita externa, decisões críticas, tools irreversíveis) checam `max(global, local)` — ambos precisam permitir
- **Critic + model tier**: usam `max(global, local)` pra modular (conservador)

**Reset:**
- **Nova conversa**: novo `conversa_id` no schema, OU gap de inatividade > `conversation_reset_hours` (default: 24h, configurável por tenant)
- **Operador marca como resolvido**: action explícita no dashboard com `audit_reason`
- **Active topic muda**: `local_risk_level` é recalculado pelo risk-assessor; `global_risk_level` não muda

Isso permite que uma conversa que entrou em território sensível volte a tratar coisa operacional simples (com tom de cuidado mantido pelo `global_risk_level`, mas sem bloquear ações operacionais legítimas).

**Auditoria:** toda mudança de risk_level vira evento em `cognitive_module_log` com:
- `from_level`, `to_level`
- `triggers` (lista de fatores que somaram)
- `confidence` do risk-assessor
- `enforced_actions` (Critic ativado? Tier travado? Etc.)

---

## 11. Glossary

- **Agent**: unidade de isolamento de identidade/memória/governança. 1+ por tenant.
- **Channel**: entrada de mensagem (chip WhatsApp, handle Instagram, email). N por agent.
- **Role**: modo operacional do agent (comercial, suporte, pedagógico, ...). Catalogado no tenant.
- **Channel Policy**: governança de como roles operam num canal específico.
- **Procedure**: objeto operacional executável — habilidade profissional com schema, execução stateful, métricas, versão. Diferente de regra (if-then atômico) e de workflow (multi-step task).
- **Skill**: termo coloquial; tecnicamente é `procedure` ou `domain` no self-model. Não usar em código.
- **Núcleo**: porção imutável da identidade. Definido pelo owner.
- **Perfil operacional**: parâmetros calibrados do agent (não-narrativa).
- **Drift**: mudança da identidade contra núcleo/limites/comportamento desejado. ≠ evolução saudável.
- **Capability Gap**: lacuna do agent — tool, knowledge, ou procedure faltante.
- **Tenant isolation**: regra inviolável — Maias de tenants diferentes nunca interagem.
- **Behavioral hint**: modulador derivado de memória sensível. Entra no prompt como instrução genérica ("ser mais paciente"), sem expor conteúdo bruto da memória.
- **Schema dormente**: tabela criada com schema completo **no início da fase proprietária** (não em P0), com `write_disabled` flag até ativação da feature flag correspondente. Permite preparação do terreno sem código que use.
- **Model tier**: abstração de modelo (`fast`/`reasoning`/`critical`/`deterministic`) que módulos declaram. Mapping pra modelo real fica em config (substituível sem refactor).
- **Schemas dormentes vs schemas ativos**: dormentes têm writes bloqueados; ativos têm writes liberados. Ativação acontece junto com flip de feature flag.
- **Idempotency contract**: todo worker que processa eventos deduplica via `worker_event_processed (worker_name, event_id)`, garantindo que retry não cria duplicata.
- **CognitiveEventType**: enum oficial de eventos cognitivos consumidos por workers de reflexão. Vive em `src/types/enums.ts`.
- **Precedence rule**: ordem de precedência em conflitos: núcleo > channel policy > procedure ativa > learned_rules > memory_entry > behavioral_hint.
- **Risk level**: enum oficial (`low`/`medium`/`high`/`critical`) calculado por `risk-assessor` (determinístico + LLM condicional). Modula Critic, model tier, budget fallback e escalation. Tem **dois escopos coexistentes**: `global_risk_level` (por conversa, monotonicamente crescente) e `local_risk_level` (por tópico/procedure, recalculado). Ações sensíveis checam `max(global, local)`; operacionais simples checam só `local`.

## 12. Open Questions / Future Work

- **Tool builder visual** (low-code editor pra clientes criarem tools) — fora do escopo das 10 fases. Considerar depois de P7 + N tenants reais.
- **Marketplace de procedures e tools** — possível evolução pós-plataforma estável.
- **WhatsApp Business API (Meta Cloud) adapter** — abstração de gateway já preparada (interface `WhatsAppGateway`), implementação adicional sob demanda.
- **Multi-region / sharding** — escala 100+ tenants, fora do escopo atual.

---

**Final note:** este design consolida 8 decisões arquiteturais validadas iterativamente. A frase-mãe — *"A Maia aprende com a experiência, mas só evolui dentro de governança, escopo e evidência"* — é o filtro de toda decisão futura. Qualquer proposta que viole governança, escopo ou evidência está fora do espírito do sistema.
