# Runbook — P6 Channel / Role / Policy

> Como operar, debugar e dar rollback rapido na camada de canal e role com policy: separacao estrutural Tenant -> Agent -> Channel -> Channel Policy -> Role, com selector hibrido (LLM suggester + deterministic + policy decider deterministico).

## O que e P6

Refactor estrutural que separa **identidade (Agent) != unidade de entrada (Channel) != modo operacional (Role)**, governado por **Channel Policy**. O agent pode atender multiplos canais, cada canal com sua propria policy, e a policy decide deterministicamente como roles podem (ou nao) mudar dentro de uma conversa.

Componentes:

- 4 migrations (031 channels, 032 roles, 033 channel_policies, 034 role_selector_decisions) + 1 seed (035 default channel/role/policy).
- 4 repositorios tipados (`channelsRepo`, `rolesRepo`, `channelPoliciesRepo`, `roleSelectorDecisionsRepo`).
- 1 channel resolver (`src/agent/channel-resolver.ts`) — entrada bruta -> channel + policy + default role.
- 1 role selector engine hibrido com 4 submodulos:
  - `llm-suggester.ts` — sugere candidate role baseado em texto (LLM, opcional).
  - `deterministic-classifier.ts` — fallback por regex/keyword sobre roles.
  - `policy-decider.ts` — **deterministico, zero LLM** — aplica switch_behavior + by_context_guards e decide.
  - `oscillation-tracker.ts` — conta switches por conversa e bloqueia oscilacao excessiva.
- Integracao com prompt-builder (secao "Modo operacional" injetada com base no role decidido).
- Feature flag `FEATURE_MULTI_CHANNEL` (default OFF).

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

Compatibilidade legacy preservada com flag OFF: channel resolver retorna o default channel/role seedado em 035, prompt-builder injeta apenas a secao basica de identidade — comportamento identico ao P5.

## Feature flag

`FEATURE_MULTI_CHANNEL` (default OFF). Ativar:

```env
FEATURE_MULTI_CHANNEL=true
```

Com a flag OFF:

- Channel resolver sempre retorna `(default_channel, default_role, default_policy)` do tenant.
- Role selector engine nao executa LLM suggester nem aplica switch behaviors complexos — retorna `keep_current` no default role.
- Prompt-builder injeta a base de identidade sem secao "Modo operacional".

Com a flag ON:

- Channel resolver mapeia `external_id` -> channel real.
- Role selector engine roda pipeline hibrido completo.
- Prompt-builder injeta secao "Modo operacional" com `prompt_addendum` do role decidido.

Kill-switch via REPL no caminho de incidente:

```typescript
import { featureFlags, FeatureFlagName } from '@/config/feature-flags.js';
featureFlags.killSwitch(FeatureFlagName.MULTI_CHANNEL);
// Proxima request volta a single-tenant default/default sem restart.
```

Reverter:

```typescript
featureFlags.unkillSwitch(FeatureFlagName.MULTI_CHANNEL);
```

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

## Rollback < 1min (incidente)

Se selector estiver decidindo errado ou prompt-builder injetando lixo, **NAO** precisa restart.

```typescript
import { featureFlags, FeatureFlagName } from '@/config/feature-flags.js';
featureFlags.killSwitch(FeatureFlagName.MULTI_CHANNEL);
// Proxima request volta a single-tenant default/default sem restart.
```

Efeito imediato:

- Channel resolver volta a `(default, default, default)`.
- Engine retorna `keep_current` no default role.
- Prompt-builder injeta apenas base de identidade.

Reverter:

```typescript
featureFlags.unkillSwitch(FeatureFlagName.MULTI_CHANNEL);
```

## Rollback persistente

Para tornar o rollback permanente entre reinicios:

1. `FEATURE_MULTI_CHANNEL=false` no `.env`
2. Restart processo (`pm2 restart all` ou equivalente, ~30s)

Kill-switch runtime e volatil — so vale para o processo atual.

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
| Channel resolver sempre default | flag OFF, ou channel nao cadastrado | Checar `FEATURE_MULTI_CHANNEL` + cadastrar channel via SQL com `external_id` correto |
| Prompt sem "Modo operacional" | flag OFF, role sem prompt_addendum/description, ou role==null | Verificar role via SQL + estado da flag + revisar prompt-builder logs |
| Decisao queue_human errada | Role selector engine nao tem essa action; verificar logs cognitive_module_log | Checar se chamada esta vindo de outro modulo (ex: gap-escalation-monitor) |
| audit row tem decided_by='llm_classifier' | NUNCA deveria ocorrer (defesa em 3 camadas) | Bug critico; investigar repo runtime guard + DB CHECK + spec; abrir incidente sev-1 |
| LLM suggester nao roda | flag OFF ou modulo cognitivo desligado | Conferir `cognitive_module_log` para `role-selector.llm-suggester`; flag + Sonnet status |

## Validacao pos-deploy

```bash
bash scripts/p6-acceptance-gates.sh
```

Exit 0 esperado. Smoke test adicional:

1. Criar channel mock para tenant de teste via SQL.
2. Ativar `FEATURE_MULTI_CHANNEL=true`.
3. Mandar mensagem -> conferir que role selector loga decisao em `role_selector_decisions`.
4. Conferir prompt gerado tem secao "Modo operacional" com `prompt_addendum` do role decidido.
5. Repetir com flag OFF -> verificar fallback para default/default.

## Proxima fase

- **P7 (Grafo cognitivo formal)** — orquestracao via grafo declarativo de modulos cognitivos (descriptors com runWhen, timeout, fallback, model, version). Ultima fase do roadmap.
