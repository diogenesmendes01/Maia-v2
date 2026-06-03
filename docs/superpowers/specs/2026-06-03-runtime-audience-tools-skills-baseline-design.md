# Runtime Audience · Tool Grants · Skill Usage Policy · Agent Baseline — Design

> Epic de arquitetura que conecta as issues **#407 → #410 → #408 → #409**. Escrito como refino de tech lead para que o agente implementador tenha visão clara, ancorada no código atual. Leia depois de [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) e [`concerns/action-layer.md`](../../architecture/concerns/action-layer.md).

| | |
|---|---|
| Status | Proposta (design) |
| Autor | Tech Lead refino (2026-06-03) |
| Issues | [#407](https://github.com/diogenesmendes01/Maia-v2/issues/407) · [#408](https://github.com/diogenesmendes01/Maia-v2/issues/408) · [#409](https://github.com/diogenesmendes01/Maia-v2/issues/409) · [#410](https://github.com/diogenesmendes01/Maia-v2/issues/410) |
| Premissa | **#406 (P11) integrado a `main`** — caminho novo incondicional, sem toggles legados. Flags remanescentes: `MULTI_CHANNEL` (#411) e `COGNITIVE_GRAPH` (#412). |

---

## 0. Premissa #406 e o que ela muda para este epic

PR **#406 (P11 — cutover 100%)** removeu 13 dos 15 feature toggles de migração e colapsou os caminhos novos como incondicionais (`DECISION_ENGINE_V1`, `SKILL_REGISTRY_V1`, `POLICY_RESOLVER_V1`, `KNOWLEDGE_STATE_MACHINE_V1`, `CONTEXT_PACKET_V1` stub, etc.). Consequências diretas para quem for implementar #407–#410:

1. **Não reintroduzir dependência nos flags removidos.** O decision-engine, o skill-registry e o context-packet são o caminho de produção — sem branch "legado". Código novo que precise de kill-switch cria **um flag novo** (padrão em [`runtime.md`](../../architecture/modules/runtime.md) §How to extend), não reusa os extintos.
2. **`buildPrompt`/context-packet é o único builder.** O stub `CONTEXT_PACKET_V1` saiu; qualquer slice nova (ex.: `audience-slice`) entra no pipeline real de slices ([`src/runtime/context-assembly/slice-builders/`](../../../src/runtime/context-assembly/slice-builders/)).
3. **`MULTI_CHANNEL` continua OFF e é pré-requisito não-resolvido de roteamento real** (#411): `resolveChannel` só casa `external_id` *seeded*, não remetentes reais. **Isso delimita o escopo de #407** (ver §3). O runtime hoje é *single-agent-por-canal via `channel_policy`*.

> ⚠️ **Ao iniciar a implementação, confirme que #406 já está em `main` e faça rebase.** No momento deste design a branch base ainda estava no commit *base* de #406 (`f35dd33`); o `FeatureFlagName` enum ainda continha entradas que #406 remove.

---

## 1. Visão unificada — o problema em uma frase

Hoje o runtime sabe *quem responde* (agente, via `channel_policy`) e *o que o humano pode disparar* (permissões da pessoa via `canAct`). Faltam três eixos ortogonais:

| Eixo | Pergunta que responde | Issue | Existe hoje? |
|---|---|---|---|
| **Audiência** | Quem é essa pessoa **para este agente/canal**? (papel, confiança) | #407 | ❌ `pessoa.tipo` é quase-global; sem `trust_level` |
| **Grant de tools** | Quais ferramentas **este agente** tem instaladas? | #408 | ❌ só `skill.allowed_tools` (por skill, não por agente) |
| **Baseline** | Quais skills/tools **todo agente** nasce tendo? | #410 | ❌ agente nasce vazio ("skill never born active") |
| **Política de skill** | Esta skill pode rodar **para esta audiência/canal/dado/risco**? | #409 | ❌ selector casa só por intenção (`when_to_use`) |

A ordem lógica **#407 → #410 → #408 → #409** existe porque cada um é pré-requisito de dados/contrato do próximo: a política (#409) precisa da audiência (#407) e do escopo de tools por agente (#408+#410).

---

## 2. O modelo de dados unificado (vocabulário compartilhado)

Estes enums passam a ser **vocabulário canônico** compartilhado por #407/#409/#410. Defina-os **uma vez** em `src/shared/` (ex.: `src/shared/audience.ts`) e importe em todo lugar — evita drift entre o enum de audiência de #407 e o `allowed_audience` de #409.

```ts
// src/shared/audience.ts  (NOVO — fonte única de verdade)
export const AUDIENCE_TYPES = [
  'owner', 'manager', 'employee', 'accountant',
  'customer', 'vendor', 'lead', 'system_user', 'unknown',
] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

export const TRUST_LEVELS = [
  'trusted_internal', 'known_external', 'unverified', 'unknown', 'blocked',
] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const DATA_SCOPES = [
  'internal_business_summary', 'financial_summary', 'operations_summary',
  'own_customer_data_only', 'public_info',
] as const;
export type DataScope = (typeof DATA_SCOPES)[number];
```

**Mapeamento do legado `pessoa.tipo` → `audience_type`** (backfill determinístico em migration):

| `pessoas.tipo` (hoje) | `audience_type` (novo) | `trust_level` default |
|---|---|---|
| `dono`, `co_dono` | `owner` | `trusted_internal` |
| `socio` | `manager` | `trusted_internal` |
| `contador` | `accountant` | `trusted_internal` |
| `funcionario` | `employee` | `trusted_internal` |
| `fornecedor` | `vendor` | `known_external` |
| `cliente` | `customer` | `known_external` |
| `outro` / null | `unknown` | `unverified` |

---

## 3. #407 — AudienceContext por agente (a base)

### 3.1 O bloqueio real, em uma linha
`pessoas.telefone_whatsapp` tem **unique GLOBAL** (`src/db/schema.ts:202` — `.notNull().unique()`). Embora `pessoasRepo.findByPhone()` (`src/db/repositories.ts:177-250`) já escope por `(telefone, tenant_id, agent_id)` via ALS, o unique global **impede fisicamente** dois registros com o mesmo telefone — logo "mesma pessoa, papel diferente por agente" é impossível hoje.

### 3.2 Decisão de arquitetura — incremental, não big-bang
`pessoas` **já é** escopada por `(tenant_id, agent_id)`. Há **dois caminhos**:

- **Opção A — Incremental (RECOMENDADA).** Relaxar o unique para composto `(tenant_id, agent_id, telefone_whatsapp)` — mesmo padrão já usado em `channels` (`channels_tenant_type_external_uq`, `src/db/schema.ts:~1690`). Adicionar a relação governada per-agente como **nova tabela `agent_audience_profiles`** referenciando `pessoas` (1:1 por enquanto), carregando `audience_type` + `trust_level` + `status` + `permission_profile_ids` + `labels` + `metadata`. `AudienceContext` é um **tipo derivado em runtime** (não persistido) montado de `pessoa + audience_profile + channel + permissoes`. **Blast radius baixo**: nenhum FK de `pessoas` muda.
- **Opção B — Split completo.** Criar `contact_identities` (global, PII) + `agent_audience_profiles` (per-agente) e migrar `pessoas`, repontando todos os FKs (`permissoes.pessoa_id`, `conversas.pessoa_id`, memórias `subject_id`, …). Separação conceitual melhor, **blast radius alto**, fora do escopo desta issue.

> **Recomendação:** entregar a Opção A nesta issue (satisfaz todos os critérios de aceite com risco baixo e reversível). A `contact_identities` global (linking cross-agente do mesmo humano) vira follow-up explícito — alinhado ao "não objetivo" da própria issue.

### 3.3 Contrato derivado em runtime
```ts
// src/runtime/context-assembly/types  (ou src/shared/audience.ts)
export interface AudienceContext {
  tenant_id: string;
  agent_id: string;
  channel_id: string | null;
  channel_type: string;
  contact_id: string;            // pessoa.id (Opção A)
  audience_profile_id: string;
  audience_type: AudienceType;
  trust_level: TrustLevel;
  permission_profiles: string[]; // ids de permission_profiles
  allowed_entity_ids: string[];  // de resolveScope()
  status: 'active' | 'inactive' | 'quarantined' | 'blocked';
}
```

### 3.4 Onde plugar
- **Resolver:** estender `resolveIdentity()` (`src/identity/resolver.ts:21-60`) para, após resolver `pessoa`, montar e retornar `AudienceContext`. Fail-closed: pessoa sem `agent_audience_profile` ativo → `unknown`/`quarantined` (auditar). Reusa a lógica de status já existente (`blocked`/`quarantined`).
- **Context packet:** nova **`audience-slice-builder.ts`** em `src/runtime/context-assembly/slice-builders/`, com cache key `(tenant_id, agent_id, contact_id)` e TTL em `cache/ttl-policy.ts` (padrão das demais slices). Expor `AudienceContext` em `BaseContextPacket.actor` (hoje `{ user_id, pessoa_id, role, is_authenticated }`, `src/runtime/context-packet/types.ts:18-50`) — adicionar `audience_type` + `trust_level` ao `actor`.
- **Escopo de canal:** `AudienceContext.channel_id`/`channel_type` vêm do `resolveChannel` atual. **Não** depender de `MULTI_CHANNEL` para múltiplos agentes no mesmo número (isso é #411). Single-agent-por-canal é suficiente aqui.

### 3.5 Auditoria
Adicionar a `src/governance/audit-actions.ts` (array `AUDIT_ACTIONS as const`): `audience_resolved`, `audience_blocked_no_profile`, `audience_ambiguous`, `audience_quarantined`. (Já existem `unknown_number_message_received`, `unauthorized_access_attempt` — reusar onde couber.)

---

## 4. #410 — Baseline.core (todo agente nasce com isto)

### 4.1 Estado atual
`agents` (`src/db/schema.ts:907-922`) tem só `id, tenant_id, nome, status, metadata` — **sem `agent_type`/`domain`**. Agente nasce **vazio**; skills seguem `proposed → approved → active` ("a skill never born active"). Não há baseline/core em lugar nenhum (confirmado por varredura).

### 4.2 Decisão — baseline como pacote tenant-wide auto-instalado, respeitando governança
- **Skills baseline** entram como linhas **`agent_id IS NULL` (tenant-wide)**, `status='active'`, `proposed_by='system'`, via **migration de seed idempotente** + helper de bootstrap. Tenant-wide = todo agente do tenant enxerga (o selector já consulta `agent_id IS NULL OR agent_id = $agent`). Isso respeita "one active per descriptor" e mantém a esteira de governança (são *aprovadas pelo sistema*, versionadas, auditáveis), sem cada agente recriar.
- **Tools baseline** entram via o pack `baseline.core` de #408, concedido por um **`AgentToolGrant` default** a todo agente (ver §5). 
- **Diferenciação baseline vs domínio:** packs de domínio (`domain.finance`, …) **só** por grant explícito.

### 4.3 Conteúdo do `baseline.core` (conservador — sem side-effect de domínio)

**Skills (todas `prompt_only` ou leitura):** `safe_conversation`, `ask_clarification`, `request_confirmation`, `handoff_to_owner`, `remember_safe_fact`, `retrieve_context`, `explain_limitation`, `audit_decision`.

**Tools — ATENÇÃO: a maioria NÃO existe ainda.** Varredura confirma que `handoff_to_owner`, `request_confirmation`, `audit_decision`, leitura de contexto do turno **não são tools no `_registry.ts`** (só existe `escalate_to_owner` como *enum* dentro de `start-recurring-*`). Baseline implica **criar tools novas de baixo risco**:

| Tool baseline (nova) | `side_effect` | `required_actions` (nova ActionKey?) | Observação |
|---|---|---|---|
| `read_turn_context` | `none` | — | lê contexto do turno |
| `recall_memory` (existe) | `read` | `read_*` | reuso |
| `remember_safe_fact` | `write` | `save_safe_fact` (nova) | só memória segura por política |
| `request_confirmation` | `none` | — | pede confirmação; não age |
| `handoff_to_owner` | `communication`* | `escalate_to_owner` (nova) | *escalonamento interno, não envio externo arbitrário |
| `audit_decision` | `none` | — | wrapper de `audit()` |
| `explain_limitation` | `none` | — | resposta segura |

> Novas `ActionKey` (`src/governance/audit-actions.ts`, array `ACTION_KEYS`) e novas `AuditAction` precisam ser **append-only** nos `as const`.

### 4.4 Fora do baseline (nunca default)
finanças, cobrança, transferência/pagamento, alteração de cadastro, CRM com mutação, envio proativo externo (`send_proactive_message`), workflows com efeito real, relatórios internos, dados de outros clientes, **qualquer tool `write`/`communication` sem política específica**.

---

## 5. #408 — Tool Catalog → Pack → Grant → Skill Scope → Runtime Filter → Dispatcher

### 5.1 O insight central — grants e permissões são eixos DIFERENTES que se compõem por AND
Hoje `getToolSchemas(byEntity)` (`src/tools/_registry.ts:281-300`) filtra pelo que **o humano** pode (permissão da pessoa). `AgentToolGrant` é sobre o que **o agente** tem instalado. São ortogonais. O conjunto de tools visível ao LLM no turno =

```
VISÍVEL = ( baseline.core ∪ granted_packs ∪ granted_tools  −  denied_tools )   ← #408/#410  (o que o AGENTE tem)
        ∩ ( skill.allowed_tools − skill.denied_tools )                          ← #408/#409  (o que a SKILL precisa)
        ∩ ( required_actions ⊆ permissões da pessoa )                           ← existente   (o que o HUMANO pode)
        ∩ ( skill permitida p/ audiência/canal/data_scope/risco )              ← #409        (se a BEHAVIOR é permitida p/ esta pessoa)
        ∩ ( isToolEnabled / feature flag )                                      ← existente   (kill-switch)
```

…e o **Dispatcher Guard** (`dispatchTool`, `src/tools/_dispatcher.ts:47-453`, sequência de 12+ guards) **revalida tudo no servidor**, independente do que o LLM viu. Grants/scope/audiência são **filtros adicionais ANTES** dos guards existentes (constitutional, `canAct`, idempotência) — **nunca os substituem** (não-objetivo explícito da issue).

### 5.2 Modelo de dados
```ts
// Tool Pack — catálogo reutilizável por finalidade (tabela `tool_packs` OU config versionada)
ToolPack { id; name; domain; tools: string[]; default_for_agent_type?: string[]; risk_level: 'low'|'medium'|'high'; description }

// Agent Tool Grant — o que um agente recebe (tabela `agent_tool_grants`, tenant+agent escopada)
AgentToolGrant { tenant_id; agent_id; granted_packs: string[]; granted_tools: string[]; denied_tools: string[]; granted_by; reason; created_at }

// Skill Tool Scope — estende o que já existe em skills (allowed_tools) com denied + confirm
SkillToolScope { skill_id; allowed_tools: string[]; denied_tools?: string[]; requires_confirmation_for?: string[] }
```
- `tool_packs` pode começar como **constante versionada em código** (`src/tools/packs.ts`) — packs são definição de produto, não dado por-tenant; o `tool-catalog` gerado (`scripts/gen-tool-catalog.ts`) já é precedente de "snapshot derivado do registry".
- `agent_tool_grants` **é** dado por-tenant → tabela com `tenant_id + agent_id` + `_up`/`_down`, default grant = `['baseline.core']`.
- `denied_tools` é **hard**: nunca aparece ao LLM e o dispatcher recusa (defense-in-depth).

### 5.3 Onde plugar
- **Runtime Tool Filter:** estender `tool-slice-builder.ts` (`src/runtime/context-assembly/slice-builders/`) — hoje já há comentário "two agents … different tool grants never collide" (`:58`); transformar o informal em real. Computar a interseção da §5.1. A assinatura de `getToolSchemas` evolui para receber também o grant do agente (ou ganha uma função irmã `getAgentToolSchemas(grant, byEntity, skillScope)`).
- **Dispatcher:** adicionar guard de grant **antes** do guard de permissão (`_dispatcher.ts`): se a tool não está no grant efetivo do agente → `{ error: 'tool_not_granted' }` + auditar.
- **Auditoria de proveniência:** registrar **por que** o conjunto de tools ficou visível (qual pack/grant/skill) — novo `tool_visibility_resolved` em `AUDIT_ACTIONS`.

---

## 6. #409 — SkillUsagePolicy (o gate que fecha o ciclo)

### 6.1 Estado atual e o gap
`skills` (migration `043_p9a_skills.sql`; `src/db/schema.ts:2189-2260`) tem `goal, when_to_use, procedure, constraints (jsonb, DORMENTE), allowed_tools, policy_descriptors, runtime_hints`. O `skill-selector` (`src/runtime/decision/skill-selector.ts:44-131`) casa por `applicable_to_intent` + categoria/prioridade com threshold estrito `>` — **sem nenhum filtro de audiência/canal/data_scope**. O `skill-runner` (`src/skills/skill-runner.ts`) tem 7 gates; gate 4/4.5 resolve `policy_descriptors` (P8e) e bloqueia por `effect='block'`/`hard_limit`. `constraints` **não é avaliado**.

### 6.2 Decisão — política NATIVA tipada que COMPLEMENTA (não substitui) policy_descriptors
- Adicionar coluna **`usage_policy jsonb`** em `skills`, validada por **Zod** (`SkillUsagePolicy`), com a forma da issue (`allowed_audience`, `blocked_audience`, `allowed_channels`, `data_scope`, `exposure_policy`, `requires_auth_level`, `requires_confirmation`, `blocked_when_risk_at_or_above`). `policy_descriptors`/`constraints` continuam como camada complementar (não-objetivo: não removê-los).
- **Dois pontos de enforcement** (defense-in-depth):
  1. **Filtro de candidatas (cedo, conservador):** no `skill-selector`, após ranquear, **remover** candidatas cuja `usage_policy` não permite a `AudienceContext`/canal/`data_scope`/risco do turno — **antes** de qualquer tool ir ao LLM. É o gate que a issue pede ("backend bloqueia antes do LLM receber tools").
  2. **Gate de execução (tarde, fail-closed):** no `skill-runner`, novo gate ~4.6 reavaliando a policy contra a audiência (TOCTOU: a audiência pode ter mudado). Bloqueia com razão tipada.
- **Novas `SkillFailureReason`** (`src/skills/types.ts:61-73`, append ao union): `audience_blocked`, `channel_blocked`, `data_scope_blocked`, `auth_level_insufficient`, `risk_blocked`.

### 6.3 Fluxo runtime desejado (ancorado no pipeline real)
1. `resolveIdentity` → `AudienceContext` (#407).
2. `resolveChannel` → agente/canal ativos (existente).
3. `skill-selector.findActive` → candidatas por intenção (existente).
4. **NOVO:** aplicar `SkillUsagePolicy` a cada candidata vs `AudienceContext`+canal+`data_scope`+risco.
5. Remover não-permitidas; se nenhuma sobrar → `respond` sem skill ou `handoff_to_owner`.
6. Montar tools visíveis **só** da skill aprovada (interseção §5.1).
7. Auditar a decisão (`skill_allowed` / `skill_blocked_by_*`).
8. `dispatchTool` revalida (gate final).

### 6.4 Auditoria
Novas `AUDIT_ACTIONS`: `skill_allowed`, `skill_blocked_by_audience`, `skill_blocked_by_channel`, `skill_blocked_by_data_scope`, `skill_blocked_by_risk`, `skill_blocked_by_auth_level`. **Nota:** hoje a execução de skill em runtime **não** audita (só mutações admin em `skills-repo`); esta issue introduz o primeiro audit de decisão de skill em runtime — bom alinhamento com o invariante #4.

---

## 7. Conformidade com os 6 invariantes invioláveis

| # | Invariante | Como este epic respeita |
|---|---|---|
| 1 | Isolamento por `tenant_id+agent_id` | Toda tabela nova (`agent_audience_profiles`, `agent_tool_grants`) carrega `tenant_id+agent_id`; toda cache key de slice nova inclui tenant+agent; `npm run test:leak` obrigatório. |
| 2 | LLM propõe, backend dispõe | Grants/audiência/policy são **filtros de backend** antes do LLM; dispatcher continua a autoridade final. |
| 3 | Confiança é computada | `trust_level` é derivado de relação/governança, **não declarado pelo LLM**. |
| 4 | Auditar toda decisão | Novas `AUDIT_ACTIONS` para audiência/grant/skill; primeiro audit de decisão de skill em runtime. |
| 5 | Fail-closed | Sem `audience_profile` ativo → bloqueia/quarentena; nenhuma skill segura → responde sem skill; `denied_tools` é hard. |
| 6 | Identidade é governada | Baseline skills entram via seed governado (`proposed_by='system'`, versionado); grants têm `granted_by`+`reason`; agente nunca se auto-concede. |

---

## 8. Sequência de implementação (PRs incrementais, cada um verde)

```
#407  ──►  #410  ──►  #408  ──►  #409
(audiência)  (baseline)  (grants/packs)  (skill policy)
```

1. **#407 fatia 1** — migration: relaxar unique de `telefone` p/ composto + `agent_audience_profiles` (`_up`/`_down`) + backfill `tipo→audience_type`. `test:leak`.
2. **#407 fatia 2** — `AudienceContext` derivado + `audience-slice-builder` + expor em `actor`. Testes: mesmo telefone com papéis distintos em 2 agentes; conhecido sem relação ativa.
3. **#410** — seed baseline skills (tenant-wide) + criar tools baseline novas (+ `ActionKey`/`AuditAction`). Teste: agente sem pack financeiro não vê/executa tool financeira; baseline consegue confirmar/escalar/auditar.
4. **#408 fatia 1** — `tool_packs` (código) + `agent_tool_grants` (migration) + default grant `baseline.core`.
5. **#408 fatia 2** — Runtime Tool Filter (interseção) no `tool-slice-builder` + guard `tool_not_granted` no dispatcher + audit de proveniência.
6. **#409** — coluna `usage_policy` (Zod) + filtro de candidatas no selector + gate 4.6 no runner + novas `SkillFailureReason`/`AUDIT_ACTIONS`. Testes: dono/cliente/desconhecido/canal não autorizado.

---

## 9. Matriz de testes (consolidada)

| Suíte | Cenário-chave |
|---|---|
| `tests/integration/leak.spec.ts` + `npm run test:leak` | nenhuma tabela nova vaza entre tenants/agentes |
| unit `identity/resolver` | mesmo telefone → `customer` no agente X, `employee` no agente Y |
| unit `identity/resolver` | identidade conhecida **sem** `audience_profile` ativo → bloqueio auditado |
| unit `tools/registry+dispatcher` | tool em `denied_tools` nunca aparece e nunca executa |
| unit `tools/registry` | agente só-baseline não vê tools de domínio; agente c/ `domain.finance` vê só financeiras autorizadas |
| unit `skills/selector` | `daily_business_summary` permitida p/ `owner/manager`, bloqueada p/ `customer` |
| unit `skills/selector` | skill de cliente limitada a `own_customer_data_only` |
| unit `skills/runner` | tool de skill bloqueada chamada mesmo assim → dispatcher recusa |
| unit `governance/audit` | emite `skill_blocked_by_audience` / `tool_not_granted` / `audience_resolved` |
| e2e | dono vs cliente vs desconhecido vs canal não autorizado |

---

## 10. Riscos & mitigação

| Risco | Mitigação |
|---|---|
| Migration em `pessoas` (tabela core) | Opção A não muda FKs; `_up`/`_down`; backfill idempotente; `test:leak` antes do merge. |
| Drift de enums entre #407 e #409 | Fonte única em `src/shared/audience.ts`; importar em ambos. |
| Confundir grant-do-agente com permissão-do-humano | §5.1 explicita: eixos AND, não substitutos; dispatcher é guard final. |
| Baseline "burlar" governança ("skill never born active") | Seed governado (`proposed_by='system'`, versionado, auditável), não bypass. |
| Sobreposição com #411 (`MULTI_CHANNEL`) | #407 fica em single-agent-por-canal; roteamento multi-agente no mesmo número é não-objetivo. |

---

## 11. Não-objetivos (epic)

- Roteamento de múltiplos agentes no mesmo número (#411 / `MULTI_CHANNEL`).
- `contact_identities` global para linking cross-agente do mesmo humano (follow-up de #407 Opção B).
- Catálogo completo de skills de negócio por domínio.
- UI completa de marketplace de tools.
- Remoção de `constraints`/`policy_descriptors`/validações do dispatcher existentes.

---

| | |
|---|---|
| Última verificação do código-base | 2026-06-03 |
| Âncoras citadas | `schema.ts:202` (telefone unique), `skills/types.ts:61-73` (SkillFailureReason), `audit-actions.ts` (AUDIT_ACTIONS/ACTION_KEYS `as const`), `_registry.ts:281-300` (getToolSchemas), `_dispatcher.ts:47-453` (guards), `skill-selector.ts:44-131`, `resolver.ts:21-60`, `agents` `schema.ts:907-922` |
| Re-verificar quando | #406 mudar de estado; ou `src/db/schema.ts` alterar `pessoas`/`skills`/`agents`; ou o pipeline de slices/decision mudar |
</content>
