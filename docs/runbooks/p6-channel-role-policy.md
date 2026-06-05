# Runbook — P6 Channel / Role / Policy

> Como operar, debugar e dar rollback rapido na camada de canal e role com policy: separacao estrutural Tenant -> Agent -> Channel -> Channel Policy -> Role, com selector hibrido (LLM suggester + deterministic + policy decider deterministico).

## O que e P6

Refactor estrutural que separa **identidade (Agent) != unidade de entrada (Channel) != modo operacional (Role)**, governado por **Channel Policy**. O agent pode atender multiplos canais, cada canal com sua propria policy, e a policy decide deterministicamente como roles podem (ou nao) mudar dentro de uma conversa.

Componentes:

- 4 migrations (031 channels, 032 roles, 033 channel_policies, 034 role_selector_decisions) + 1 seed (035 default channel/role/policy).
- 4 repositorios tipados (`channelsRepo`, `rolesRepo`, `channelPoliciesRepo`, `roleSelectorDecisionsRepo`).
- 1 channel resolver (`src/gateway/channel-resolver.ts`) — entrada bruta -> channel + policy + default role.
- 1 role selector engine hibrido com 4 submodulos:
  - `llm-suggester.ts` — sugere candidate role baseado em texto (LLM, opcional).
  - `deterministic-classifier.ts` — fallback por regex/keyword sobre roles.
  - `policy-decider.ts` — **deterministico, zero LLM** — aplica switch_behavior + by_context_guards e decide.
  - `oscillation-tracker.ts` — conta switches por conversa e bloqueia oscilacao excessiva.
- Integracao com prompt-builder (secao "Modo operacional" injetada com base no role decidido; **omitida para o role default**).
- Resolucao de canal **sempre ativa** — `FEATURE_MULTI_CHANNEL` foi removida no #411 (ver secao "Resolucao de canal").

## Escopo

- Multi-channel: 1 tenant pode ter N agents; cada agent pode ter N channels; cada channel tem 1 policy ativa.
- Multi-role por agent: roles operacionais (ex: vendas, suporte, agendamento) modeladas em DB com `prompt_addendum`.
- Selecao de role por turno: hibrida (LLM sugere, deterministic classifier fallback, policy decider sempre decide).
- Auditoria total: **toda** decisao gravada em `role_selector_decisions` (inclusive `keep_current`).
- Defesa em profundidade contra LLM autoritativo: **`decided_by` NUNCA pode ser `llm_classifier`** (DB CHECK + runtime guard + spec).

## Dependencias

P6 depende de P0/P1/P2/P3/P4/P5 ja aplicados:

- P0: tenant context base.
- P1: cognitive module wrapper (`runCognitiveModule`) usado pelo LLM suggester.
- P2: memoria/self-model (referenciados ao construir prompt do role).
- P3: procedures (roles podem referenciar procedures permitidos).
- P4: identidade operacional (perfil/policy de identidade nao bloqueada).
- P5: aquisicao dialogica (capability gaps podem motivar criacao de novo role).

Compatibilidade legacy preservada no runtime single-tenant: o channel resolver resolve qualquer remetente para o default channel/role seedado em 035 (catch-all #411), e o prompt-builder injeta apenas a secao basica de identidade quando o role decidido eh o default — comportamento identico ao P5.

## Resolucao de canal (issue #411 — `FEATURE_MULTI_CHANNEL` removida)

A flag `FEATURE_MULTI_CHANNEL` foi **removida** no #411; a resolucao de canal eh **sempre ativa**. Um canal WhatsApp representa a **linha do bot** (o numero em que as mensagens chegam), nao o remetente. O `channel-resolver.ts` resolve em dois estagios:

1. **Exact match** em `(channel_type, external_id)` via `channelsRepo.findByExternalCrossTenant`. Canal ativo encontrado -> `(tenant_id, agent_id, channel_id)` reais.
2. **Miss / inativo** -> `channelsRepo.findDefaultCatchAllChannel`:
   - **runtime single-tenant** (nenhum canal ativo de tenant != `'default'`) -> resolve para o canal `default/default` semeado. **Catch-all** (#411): o bot responde a qualquer remetente sem dropar mensagens.
   - **deployment multi-tenant** (existe canal ativo de outro tenant) -> **throw** `channel_resolution_failed`. Fail-loud do #268: um remetente desconhecido NAO colapsa no bucket compartilhado `maia:ratelimit:default:default:*`. Ambiguidade (2+ ativos cross-tenant) tambem lanca.

No runtime single-tenant atual nao existe knob de runtime para desligar a resolucao — ela sempre cai no catch-all default/default, identico ao comportamento legacy. O role selector e o prompt-builder seguem rodando; o prompt-builder so omite a secao "Modo operacional" quando o role decidido eh o default.

## Schema overview

4 tabelas + 1 seed:

| Tabela | Funcao |
|---|---|
| `channels` | Canais de entrada por agent (external_id, channel_type, display_name, active) |
| `roles` | Modos operacionais por agent (role_key, display_name, prompt_addendum, is_default, active) |
| `channel_policies` | Politica ativa por channel (default_role_id, switch_behavior, announce_mode, by_context_guards JSONB) |
| `role_selector_decisions` | Audit log de decisoes do selector (suggested_by, decided_by, action, switch_count, candidates JSONB) |

Seed default tenant (`035_p6_seed_default_channel_role_policy.sql`):

- 1 default channel (display_name = "Default").
- 1 default role (`is_default=true`, prompt_addendum vazio).
- 1 policy `switch_behavior='free_with_trigger'`, `announce_mode='affects_user'` — preserva comportamento Maia atual (sem role switching obrigatorio).

## Como cadastrar novo channel manualmente

```sql
INSERT INTO channels (tenant_id, agent_id, external_id, channel_type, display_name, active)
VALUES ('mytenant', 'myagent', '5511999999999', 'whatsapp', 'WhatsApp Comercial', true);
```

`external_id` precisa ser unico por `(tenant_id, channel_type)`. Apos inserir, configurar policy (proxima secao) para esse channel.

## Como cadastrar novo role

```sql
INSERT INTO roles (tenant_id, agent_id, role_key, display_name, description, prompt_addendum, is_default, active)
VALUES ('mytenant', 'myagent', 'suporte', 'Suporte', 'Atendimento tecnico', 'Voce e o suporte tecnico. Foque em problemas e solucoes.', false, true);
```

`role_key` unique por `(tenant_id, agent_id)`. Apenas **1** role com `is_default=true` por agent (constraint enforced).

## Como configurar policy

```sql
INSERT INTO channel_policies (tenant_id, agent_id, channel_id, default_role_id, switch_behavior, announce_mode)
VALUES ('mytenant', 'myagent', '<channel_uuid>', '<role_uuid>', 'by_context', 'affects_user');
```

`switch_behavior` controla como roles podem mudar; `announce_mode` controla se a troca eh anunciada ao user (`affects_user`) ou silenciosa (`silent`).

## Switch behaviors explicados

- **`locked`**: role fixo; selector sempre retorna `current` independente do candidate.
- **`prefer_handoff`**: candidate diferente -> sinaliza handoff (decided_role permanece current; emite sinal pro pipeline de transferencia humana).
- **`free_with_trigger`**: troca se candidate veio com `strength=strong` ou `strength=medium`. Comportamento padrao da seed (preserva Maia legacy).
- **`by_context`**: troca governada por travas no `by_context_guards` (proxima secao).

## Travas `by_context_guards` (defaults)

JSONB no `channel_policies.by_context_guards`. Defaults aplicados quando campos ausentes:

- `min_confidence_to_switch`: 0.7 — candidate precisa de confianca minima.
- `cooldown_turns`: 3 — turnos minimos entre switches consecutivos (futuro).
- `required_strength_delta`: 0.2 — diferenca de strength minima vs current (futuro).
- `max_switches_per_conversation`: 3 — anti-oscilacao; depois disso, selector forca `keep_current`.

Modificar por tenant:

```sql
UPDATE channel_policies
SET by_context_guards = '{"min_confidence_to_switch":0.85,"max_switches_per_conversation":5}'::jsonb
WHERE id = '<policy_uuid>';
```

Updates parciais sao suportados — campos nao informados continuam com default.

## Como inspecionar decisoes

```sql
SELECT
  decided_at,
  action,
  suggested_by,
  decided_by,
  suggested_role_id,
  decided_role_id,
  switch_count_in_conversation,
  reason
FROM role_selector_decisions
WHERE conversa_id = '<uuid>'
ORDER BY decided_at DESC;
```

`action` ∈ `{keep_current, switch, handoff}`. `suggested_by` ∈ `{llm_classifier, deterministic, none}`. `decided_by` ∈ `{policy_default, policy_rule, owner_override, fallback_rule}` — **nunca `llm_classifier`**.

## Auditar conformidade spec §9 P6 done criterion #2 (decided_by NEVER llm_classifier)

```sql
-- Esta query DEVE retornar 0 rows. Se retornar > 0, alguma defesa falhou.
SELECT DISTINCT decided_by FROM role_selector_decisions WHERE decided_by = 'llm_classifier';
```

Defesa em 3 camadas:

1. **Spec**: documentado em `spec/p6-channel-role-policy.md` §9.
2. **DB CHECK**: `decided_by IN ('policy_default', 'policy_rule', 'owner_override', 'fallback_rule')` em `034_p6_role_selector_decisions.sql` — INSERT com valor proibido falha imediatamente.
3. **Runtime guard**: `role-selector-decisions-repo.ts` valida antes do INSERT; engine.ts gera apenas valores permitidos.

## Rollback (incidente)

> A flag `FEATURE_MULTI_CHANNEL` foi removida no #411, entao nao ha mais kill-switch de runtime para a camada de canal/role. O caminho de rollback agora opera no **estado** (DB), nao na flag.

Se o **role selector** estiver decidindo errado, faca a policy do canal voltar ao comportamento legacy (sem troca de role) — efeito imediato, sem restart (a `policy-cache` invalida via pubsub por tenant):

```sql
-- Trava o role no default: selector sempre retorna keep_current no default role.
UPDATE channel_policies SET switch_behavior = 'locked' WHERE channel_id = '<channel_uuid>';
```

Se um **canal real multi-tenant** recem-cadastrado estiver causando problema (ex.: roteando errado), desative-o — o resolver volta a tratar o tenant como single-tenant (catch-all) ou fail-loud conforme os demais canais:

```sql
UPDATE channels SET active = false WHERE id = '<channel_uuid>';
```

Para reverter o comportamento da camada por completo (voltar ao P5), faca o rollback das migrations (proxima secao). Nao ha como "desligar" so a resolucao de canal sem dropar as tabelas, porque ela passou a ser parte incondicional do pipeline.

## Rollback de migrations

Ordem reversa (FK-safe): 035 -> 034 -> 033 -> 032 -> 031.

```bash
psql "$DATABASE_URL" -f migrations/035_p6_seed_default_channel_role_policy_down.sql
psql "$DATABASE_URL" -f migrations/034_p6_role_selector_decisions_down.sql
psql "$DATABASE_URL" -f migrations/033_p6_channel_policies_down.sql
psql "$DATABASE_URL" -f migrations/032_p6_roles_down.sql
psql "$DATABASE_URL" -f migrations/031_p6_channels_down.sql
```

**CUIDADO** — rollback drop tables; auditoria em `role_selector_decisions` eh perdida. Se houver investigacao em curso, exportar antes:

```bash
psql "$DATABASE_URL" -c "\COPY role_selector_decisions TO 'p6-decisions-backup.csv' CSV HEADER"
```

Apos rollback, garantir que codigo nao referencia mais as tabelas (desativar feature flag em build se necessario) e sistema volta a comportamento P5.

## Troubleshooting

| Sintoma | Diagnostico | Acao |
|---|---|---|
| Role nao muda mesmo com candidate strong | switch_behavior provavelmente `locked` ou `prefer_handoff` | UPDATE policy para `by_context` ou `free_with_trigger` |
| Switches em loop | `max_switches_per_conversation` baixo demais ou oscillation tracker bugado | Aumentar via UPDATE em `by_context_guards`; conferir log `cognitive_module_log` para `role-selector.engine` |
| Channel resolver sempre default | runtime single-tenant (catch-all #411) ou channel nao cadastrado | Esperado em single-tenant. Para roteamento real, cadastrar channel via SQL com `external_id` = a **linha do bot** + tenant != `'default'` |
| `channel_resolution_failed` / DLQ num deployment multi-tenant | remetente sem channel ativo, ou ambiguidade (2+ ativos cross-tenant) | Cadastrar/reativar o channel correto; resolver ambiguidade desativando o lado errado (fail-loud do #268 — esperado) |
| Prompt sem "Modo operacional" | role decidido eh o **default** (omitido por design), role sem prompt_addendum/description, ou role==null | Verificar role via SQL + revisar prompt-builder logs (`buildRoleSection` omite role default) |
| Decisao queue_human errada | Role selector engine nao tem essa action; verificar logs cognitive_module_log | Checar se chamada esta vindo de outro modulo (ex: gap-escalation-monitor) |
| audit row tem decided_by='llm_classifier' | NUNCA deveria ocorrer (defesa em 3 camadas) | Bug critico; investigar repo runtime guard + DB CHECK + spec; abrir incidente sev-1 |
| LLM suggester nao roda | sem channel_id resolvido, sem policy/roles, ou modulo cognitivo desligado | Conferir `cognitive_module_log` para `role-selector.llm-suggester`; channel/policy cadastrados + Sonnet status |

## Validacao pos-deploy

```bash
bash scripts/p6-acceptance-gates.sh
```

Exit 0 esperado. Smoke test adicional (runtime single-tenant):

1. Mandar mensagem de um numero qualquer -> conferir que a mensagem eh processada (sem `channel_resolution_failed`, sem DLQ) e resolve para `default/default` via catch-all.
2. Conferir que o role selector loga decisao em `role_selector_decisions`.
3. Cadastrar um role NAO-default com `prompt_addendum` + policy `free_with_trigger`, mandar mensagem que dispare a troca -> conferir que o prompt gerado tem secao "Modo operacional" com o `prompt_addendum` do role decidido.
4. (multi-tenant) Cadastrar um channel de tenant != `'default'`; mandar de um numero sem channel -> conferir `channel_resolution_failed` fail-loud (#268).

## Proxima fase

- **P7 (Grafo cognitivo formal)** — orquestracao via grafo declarativo de modulos cognitivos (descriptors com runWhen, timeout, fallback, model, version). Ultima fase do roadmap.
