# Runbook — P9b Decision Engine

> **Este é o componente central do Hot Path em Runtime v3.1.1.** Todo turno passa
> pelo Decision Engine. Quando um turno se comporta de forma inesperada, **o primeiro
> lugar a olhar é o `DecisionPacket`** produzido por este componente.

---

## O que é P9b

P9b entregou o Decision Engine (orquestrador da Camada 2) e os 2 PEPs inline
(Early/Mid). O Late PEP (3/3) roda na Camada 5 (Guardrails) e anota no mesmo
array `policy_decisions` via `PepAudit`.

Componentes entregues:

- `src/runtime/decision/decision-engine.ts` — orquestrador principal (9 steps + fallback)
- `src/runtime/decision/early-pep.ts` — Early PEP: bloqueia por lockdown/policies de entrada
- `src/runtime/decision/mid-pep.ts` — Mid PEP: bloqueia/reduz por intent/risk/skill
- `src/runtime/decision/action-decider.ts` — decide `action_mode` + `tool_permissions`
- `src/runtime/decision/types.ts` — todos os contratos de interface (DI)
- `src/runtime/decision/budget-tracker.ts` — deadline total de 400ms
- `src/runtime/decision/pep-audit.ts` — acumula `policy_decisions` para o packet
- `src/runtime/feature-flags/decision-engine-flag.ts` — `FEATURE_DECISION_ENGINE_V1`

Fixes do round-2 (Codex review #103):
- **Tool reductions enforced:** Mid PEP `reduce_tool_set` é aplicado pelo ActionDecider
  antes de emitir o packet; agente não pode readicionar tools removidas por policy.
- **AbortController por step:** cada step recebe um deadline real (não "best-effort").
  Resolver, PEP evaluator ou repo lentos não podem travar o hot path além de 400ms.
- **Skill scoping no SkillSelector:** todos os lookups de skill são escopados por
  `tenant_id + agent_id`; lookup não-escopado foi removido.

---

## Lugar no Hot Path

```
[Camada 1] BaseContextPacket (P8a)
      ↓
[Camada 2] DecisionEngine.run()
      ├─ Step 0: PolicyDescriptorResolver (P8e) — resolve policies ativas
      ├─ Step 1: Early PEP — lockdown + policies de entrada
      ├─ Step 2: IntentClassifier — classifica intent + confidence
      ├─ Step 3: RiskScorer — risk_profile (stub P9b; real P9c)
      ├─ Step 4: WorkflowSelector — detecta procedure ativa
      ├─ Step 5: AgentSelector — routing de agente (no-op P9b)
      ├─ Step 6: SkillSelector — skill + tool_permissions (escopado)
      ├─ Step 7: Mid PEP — block/reduce/dual_approval por intent+risk+skill
      └─ Step 8: ActionDecider — emite DecisionPacket final
      ↓
[Camada 3] ExecutionContextPacket (Context Assembly)
      ↓
[Camada 5] Late PEP (Guardrails) — anota em policy_decisions
      ↓
[Camada 4] Agent Runtime
```

O `DecisionPacket` é a **única fonte de verdade** para `action_mode`, `risk_profile`,
`tool_permissions` e `policy_decisions` usados downstream.

---

## DecisionPacket — shape completo

```typescript
interface DecisionPacket {
  trace_id: string;                    // = BaseContextPacket.trace_id

  intent: {
    label: string;                     // ex: 'respond' | 'plan' | 'blocked' | 'unknown'
    confidence: number;                // 0.0–1.0
    top3?: string[];
  };

  risk_profile: {
    level: 'low' | 'medium' | 'high'; // derivado por RiskScorer (P9c)
    reasons: string[];
    requires_human_review: boolean;
  };

  routing: {
    workflow_id?: string;              // procedure ativa (P3b)
    agent_id: string;                  // agente roteado (pode diferir de base.agent_id)
    selected_skill_id?: string;
    candidate_skill_ids: string[];
  };

  action_mode: ActionMode;             // ver tabela abaixo

  tool_permissions: {
    allowed_tools: string[];           // APÓS aplicar Mid PEP tool_reductions
    blocked_tools: string[];           // inclui tools removidas por policy
    requires_confirmation: string[];
  };

  context_requirements: ContextRequirements;    // depth de slices para Camada 3

  evaluation_plan: {
    validators: string[];
    llm_judge_required: boolean;
    human_review_required: boolean;
  };

  policy_decisions: PolicyDecisionRecord[];     // auditoria por PEP (Early+Mid+Late)

  rationale: string;                   // string de debug (ex: 'call_tool:skill-uuid')
}
```

### `action_mode` — valores possíveis

| Valor | Quando |
|---|---|
| `respond` | Fluxo normal sem tool use |
| `call_tool` | Skill `tool_mediated` ou `decide` com tools disponíveis |
| `ask_clarification` | Skill ausente OU confidence < 0.6 OU tools reduzidas a zero |
| `escalate` | Dual approval, lockdown, human review, budget fallback em tenant sensitivo |
| `continue_workflow` | Procedure ativa em modo `continue` |

---

## Os 3 PEPs — disciplina e timings

### Early PEP (`src/runtime/decision/early-pep.ts`)
**Budget target: <30ms**

Avalia APENAS informações da Camada 1 (BaseContextPacket). Não vê intent, skill, tools.

Verificações, em ordem:
1. `base.channel.is_locked_down` → `block` imediato (sem DB hit)
2. `lockdownReader.isTenantInGlobalLockdown` → `block` se em lockdown global
3. Policies com `applies_to_peps: ['early']` (opt-in explícito — padrão é `['mid', 'late']`)

Pode retornar: `BlockDecision` (short-circuit) ou `ContinueDecision` (com warnings).

### Mid PEP (`src/runtime/decision/mid-pep.ts`)
**Budget target: <150ms**

Avalia após intent/risk/skill serem conhecidos. Processa policies com `applies_to_peps`
contendo `'mid'` (default: qualquer policy sem `applies_to_peps` explícito roda aqui).

Pode retornar:
- `BlockDecision` — short-circuit com `action='block'` ou `'escalate'`
- `RequireDualApprovalDecision` — requer dual approval (surface no packet como `escalate`)
- `ContinueDecision` com `tool_reductions` — lista de tools a remover (enforced pelo ActionDecider)

**Round-2 fix crítico:** Mid PEP recebe o objeto `Skill` completo (com `allowed_tools`,
`blocked_tools`, `runtime_hints`) para que predicados de tool policy avaliem contra a
superfície real — antes recebia preview vazio, aprovando tools que apareciam depois.

### Late PEP (Camada 5 — Guardrails)
**Não implementado em P9b.** Roda na Camada 5 e anota resultados no mesmo
`policy_decisions` via `PepAudit`. Não há implementação em `src/runtime/decision/`.

**Invariante 14:** PEPs rodam independente da feature flag. O flag controla apenas
se o Decision Engine v1 produz o DecisionPacket; PEPs nunca são bypassados.

---

## Budget e AbortController

O engine tem budget total de **400ms** (`TOTAL_BUDGET_MS = 400`).

Cada step é envolto em `withDeadline(promise, remainingMs, stepName)`:
- Se `remainingMs <= 0` ao iniciar, rejeita imediatamente com `BudgetExhaustedError`
- Se o step exceder o tempo, o `AbortController` interno é acionado (`.abort()`)
- O `AbortSignal` é propagado para todos os dependencies (resolver, PEPs, repos, Haiku client)
- Caller externo pode fornecer `input.signal` — abort externo também dispara o controller interno

**Budget fallback:**
- Se tenant tem contexto sensível (`lockdownReader.tenantHasSensitiveContext`): `action_mode='escalate'`
- Caso contrário: `action_mode='ask_clarification'`
- O check de sensitividade tem deadline próprio de 50ms (fail-closed se timeout)

Sub-steps e budgets nominais (tracker acumula tempo real):

| Step | Nome | Budget nominal |
|---|---|---|
| `resolver` | Policy resolution | ~20ms |
| `early_pep` | Early PEP | <30ms |
| `intent` | Intent classifier | ~80ms |
| `risk` | Risk scorer | ~30ms |
| `workflow` | Workflow selector | ~10ms |
| `agent` | Agent selector | ~10ms |
| `skill` | Skill selector | ~30ms |
| `mid_pep` | Mid PEP | <150ms |
| `action` | Action decider | <30ms |

---

## Tool reductions — invariante enforced

**Agente não pode readicionar tools removidas pelo Mid PEP.**

Fluxo de enforcement em `ActionDecider`:

1. `collectReductions(midPepOutcome)` — agrega todos os `tool_reductions` do `ContinueDecision`
2. `applyToolReductions(buildToolPerms(skill), reductions)`:
   - Remove os tools de `allowed_tools`
   - Adiciona-os em `blocked_tools` (para audit trail)
   - Remove-os de `requires_confirmation`
3. Se todas as tools de uma skill `tool_mediated` foram removidas → fallback para `ask_clarification`
   (nunca emite `call_tool` com `allowed_tools: []`)

O packet emitido tem `tool_permissions.blocked_tools` contendo todas as tools retiradas por
policy. Qualquer código downstream que tente adicionar de volta uma tool de `blocked_tools`
está violando o invariante.

---

## Feature flag

```env
FEATURE_DECISION_ENGINE_V1=true             # global ON (default OFF)
FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true # força OFF independente de override
```

Ordem de resolução:
1. Kill switch (`FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true`) → sempre `false`
2. Tenant override via `TenantFeatureFlagsRepo` (canary rollout — P11)
3. `FEATURE_DECISION_ENGINE_V1=true` → `true`
4. Default `false`

Kill switch (emergência):

```bash
# Setar no env e reiniciar workers
FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true
```

Com kill switch ativo, o hot path cai para o legacy path que ainda executa Early/Mid/Late
PEPs mas não produz `DecisionPacket` v1.

**Tenant override** (canary parcial, disponível P11):

```typescript
await tenantFeatureFlagsRepo.setOverride('tenant-x', 'decision_engine_v1', true);
```

---

## Invariantes

1. **`action_mode` nunca downgrade de `escalate`** — uma vez que Early ou Mid PEP
   retornam `BlockDecision`, o engine retorna imediatamente sem processar steps restantes.

2. **Tool reductions de PEP não são reversíveis pelo agente** — `blocked_tools` no packet
   é authoritative. Qualquer tentativa de readicionar uma tool de `blocked_tools` é violação.

3. **AbortController cascateia para todos os awaits** — deadline de um step aborta o
   controller compartilhado, que propaga `AbortSignal` para todos os dependentes ativos.
   Um step lento não pode travar os demais além do budget.

4. **Deadline real (não best-effort)** — `withDeadline` usa `setTimeout` real; BudgetTracker
   rastreia tempo elapsed. Steps não podem "ignorar" o deadline.

5. **Skill lookup sempre escopado** — `SkillSelector.select` e o fallback em `ActionDecider.find`
   passam `{ tenant_id, agent_id }`. Um skill de outro agente ou tenant nunca vaza para o packet.

6. **`tool_reductions.removed_tools` ⊆ input tool set** — tools listadas como removidas
   que não existiam em `allowed_tools` são ignoradas no merge (não causam erro, mas não
   aparecem em `blocked_tools`).

7. **PEPs rodam independente da flag** — `FEATURE_DECISION_ENGINE_V1` controla apenas a
   produção do DecisionPacket v1; PEPs (Early/Mid/Late) não têm flag própria (Invariante 14).

---

## Troubleshooting

### "Agente não fez nada na mensagem do usuário"

1. Recuperar o `trace_id` da conversa.
2. Verificar `DecisionPacket.action_mode`:
   - `blocked` / `escalate` → olhar `policy_decisions` no packet para o policy_id e rule_descriptor que disparou.
   - `ask_clarification` → skill ausente ou `intent.confidence < 0.6`. Ver `rationale`.
3. Verificar se Early PEP bloqueou: `channel.is_locked_down` ou tenant em lockdown global.

```sql
-- Verificar lockdown do tenant
SELECT * FROM tenant_lockdowns WHERE tenant_id = $1 AND active = true;
```

### "Tool X foi bloqueada inesperadamente"

1. Verificar `DecisionPacket.tool_permissions.blocked_tools` — se a tool está lá, foi
   removida por policy.
2. Ver `policy_decisions` no packet: procurar entrada com `action='reduce_tool_set'` e
   `rule_descriptor` correspondente.
3. Ver `tool_reductions.reasons` no `ContinueDecision` do Mid PEP (auditado em trace).

```typescript
// Debug: inspecionar o packet via trace
const packet = await traceRepo.getDecisionPacket(trace_id);
console.log(packet.tool_permissions.blocked_tools);
console.log(packet.policy_decisions.filter(d => d.action === 'reduce_tool_set'));
```

### "Decision Engine deu timeout / budget exhausted"

1. Ver `DecisionPacket.rationale`: `budget_fallback:<step>` indica qual step estourou.
2. Verificar o step lento:
   - `resolver` → PolicyDescriptorResolver lento; checar cache TTL e Redis pub/sub.
   - `intent` → HaikuClient lento; checar latência da API Anthropic.
   - `mid_pep` → PolicyEvaluator lento; checar P9d (Policy DSL).
   - `risk` → RiskScorer lento; checar P9c.
3. Considerar aumentar budget ou otimizar o step. Budget de 400ms é configurado em
   `TOTAL_BUDGET_MS` em `decision-engine.ts`.

### "Late PEP short-circuited"

Late PEP roda na Camada 5 (fora do engine P9b). Correlacionar `policy_hits` via
`policy_decisions` no packet com o PolicyDescriptorResolver cache (P8e):

```bash
# Checar policies ativas para o tenant/descriptor que disparou o Late PEP
SELECT * FROM policy_rules
WHERE tenant_id = $1 AND rule_descriptor = $2 AND status = 'active';
```

### "`require_dual_approval` aparece no packet"

Mid PEP retornou `RequireDualApprovalDecision`. O packet terá `action_mode='escalate'`
e `rationale='require_dual_approval:<approval_class>'`.

O operador precisa abrir o Admin UI (`/inbox` → `/proposals/[id]`) e completar a
aprovação dual antes do turno ser executado.

---

## Testes críticos

```bash
# Unit tests do decision engine (~130 testes incluindo round-2 fixes)
npx vitest run tests/unit/runtime/decision/

# Testes específicos por invariante
npx vitest run tests/unit/runtime/decision/tool-reductions.spec.ts    # tool_reductions enforced
npx vitest run tests/unit/runtime/decision/abort-controller.spec.ts   # AbortController cascata
npx vitest run tests/unit/runtime/decision/budget-tracker.spec.ts     # deadline enforcement
npx vitest run tests/unit/runtime/decision/action-decider.spec.ts     # agent override discipline

# Property tests (transições de estado)
npx vitest run tests/unit/runtime/decision/state-transitions.spec.ts
```

---

## Migrations

Nenhuma. Decision Engine consome tabelas existentes:
- `policy_rules` (P8e) — via PolicyDescriptorResolver
- `capability_proposals` — via Inbox/Proposals router
- `skills` (P9a) — via SkillSelector

---

## Rollout e rollback

### Ativar o Decision Engine v1

```bash
# 1. Validar acceptance gates
bash scripts/p9b-acceptance-gates.sh

# 2. Ativar para um tenant canário (P11 tenant overrides)
# (ou globalmente em staging)
FEATURE_DECISION_ENGINE_V1=true

# 3. Monitorar métricas
# decision_engine.duration_ms (p50, p99)
# decision_engine.budget_fallback (contador)
# decision_engine.pep_evaluated { pep, decision }
# decision_engine.packet_emitted { action_mode }
```

### Rollback runtime (sem reverter migrations)

```bash
# Kill switch imediato (sem restart se env é lido em runtime)
FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true

# Ou desativar globalmente
unset FEATURE_DECISION_ENGINE_V1  # ou setar 'false'
# Reiniciar workers
```

Com kill switch ativo: todos os turnos caem para o legacy path. Nenhuma quebra
funcional — legacy path ainda executa PEPs mas não produz DecisionPacket v1.

### Tenant override (canary)

```bash
# Ativar para tenant específico (via P11 canary repo — disponível P11)
await tenantFeatureFlagsRepo.setOverride('tenant-canary', 'decision_engine_v1', true);

# Desativar para tenant específico (rollback seletivo)
await tenantFeatureFlagsRepo.setOverride('tenant-canary', 'decision_engine_v1', false);
```

---

## Issues conhecidas

Nenhuma ativa.

---

## Dependências futuras

- **P9c Risk Scorer** — substitui o stub `RiskScorer` por scoring real. Hoje `risk_profile.level`
  é calculado por heurísticas simples.
- **P9d Policy DSL Evaluator** — substitui `AllowAllPolicyEvaluator` (stub) pelo evaluador de
  DSL/AST real. Hoje PEPs aprovam tudo salvo lockdown e duplicatas de hard-block.
- **P8e PolicyDescriptorResolver** (já mergeado) — substitui o resolver stub. Policies
  são resolvidas do cache/DB real com TTL 5min + invalidação Redis.
- **P10 Trace Writer** — persiste `DecisionPacket.policy_decisions` para auditoria offline.

---

**Owner:** Founder + plataforma. **Última atualização:** 2026-05-20.
