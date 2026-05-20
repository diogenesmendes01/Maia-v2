# Maia v2 — P9a Skill Abstraction — Design Spec

**Date:** 2026-05-15
**Status:** Draft — derivado do master Runtime Architecture v3.1.1 (`docs/superpowers/specs/2026-05-15-runtime-architecture-v3-final.md`)
**Master refs:** §0.3 (Glossary "Skill Contract"), §2.4 (Skill Registry — schema completo), §2.5 (Knowledge State Machine, runtime_hints), §3.4 (Agent Runtime + runtime_hints), §6 (SkillSlice type), §9 (Admin UI integration), §13 (plano de execução).
**Architecture Locks:** Precedence Pyramid, Knowledge lifecycle, Policy enforcement, Identity/Soul boundaries, Approval classes (§0.1). P9a respeita todos — não os altera.

---

## 0. Purpose

Hoje a Maia tem 4 conceitos "skill-like" coexistindo sem unificação:

| Conceito atual | Onde mora | O que representa |
|---|---|---|
| **Tool** (23 no registry) | `src/tools/_registry.ts` | Função executável com I/O contract |
| **Procedure** (P3a/b/c) | `procedure_definitions` | Sabedoria multi-passo, stateful, event-sourced |
| **Cognitive module** (P7) | `src/cognition/*` + `cognitive_module_log` | Unidade auditável de raciocínio (classifier, reflector, drift detector, etc.) |
| **Role/Channel policy** (P6) | `role_policies` | Modo operacional por canal |

Cada um governa **um aspecto** de "o que a Maia sabe fazer". Nenhum captura **a capacidade operacional reutilizável e contratada** — ex.: "detectar risco jurídico em mensagem livre" não é nem tool (LLM-only), nem procedure (não é multi-passo), nem cognitive module (não é interna ao harness), nem role.

**P9a introduz o conceito unificado: `Skill Contract`.**

> *"Skill é artefato declarativo (linha em `skills`) + executor estável (`SkillRunner` no código). Skill orquestra; Tool age; Procedure conduz estado; Cognitive module é a camada de audit."*  
> (Master §0.3, §0.4 princípio 3)

**Frase-mãe inviolável:**

> *"A Maia aprende com a experiência, mas só evolui dentro de governança, escopo e evidência."* — uma skill nova **nunca nasce active**. Sempre `proposed → approved → active` com partial unique "one active" + version monotônica.

### Por que skill é declarativa em DB, não código?

- Owners precisam aprovar e auditar mudança de comportamento → DB versionado é o único caminho com diff visível
- LLM pode **propor** skills via `capability-proposer` (P5 estendido) → precisa de schema padronizado
- Skill referencia outros artefatos governados (`policy_descriptors`, `allowed_tools`, success criteria) → resolução dinâmica em runtime
- `runtime_hints` (master §2.5 CORREÇÃO #14) declara token budget → harness orquestra cap por execução

### Por que executor estável em código?

- `prompt_only` / `procedure_adapter` / `tool_mediated` / `evaluator` são 4 modos com lógicas distintas e cada um precisa de validação de tipo, retry, fallback, tracing
- Owners NÃO devem editar lógica de execução; só o **contrato** (input, output, constraints, prompt template, success criteria)
- Mudança no executor passa por PR de código (revisão técnica); mudança no contrato passa por approval no Admin UI

---

## 1. File structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/036_p9a_skills.sql` + down | Create | Tabela `skills` v3.1.1 com 15 colunas + `runtime_hints` |
| `migrations/037_p9a_extend_capability_proposal_type.sql` + down | Create | Estende CHECK de `capability_proposals.capability_type` pra incluir `'skill'` (e `'soul_bias'`, `'policy_rule'` antecipando P8e/P9b) |
| `src/db/schema.ts` | Modify | `skills` table + types `SkillRow`, `SkillExecutionMode`, `SkillCategory` |
| `src/db/repositories.ts` | Modify | `skillsRepo` export |
| `src/control-plane/skill-registry/skills-repo.ts` | Create | Métodos `findActive`, `listByCategory`, `propose`, `activate`, `deprecate`, `rollback`, `getById`, `getByDescriptor` |
| `src/control-plane/skill-registry/index.ts` | Create | Barrel export |
| `src/types/enums.ts` | Modify | `SkillStatus`, `SkillExecutionMode`, `SkillCategory`, `FeatureFlagName.SKILL_REGISTRY_V1` |
| `src/config/env.ts` | Modify | `FEATURE_SKILL_REGISTRY_V1` |
| `src/config/feature-flags.ts` | Modify | Registrar singleton |
| `src/skills/skill-runner.ts` | Create | Roteador entre 4 execution_modes; wrapper `runCognitiveModule`; resolve `policy_descriptors` antes de executar |
| `src/skills/modes/prompt-only.ts` | Create | Modo 1: LLM call simples com `skill.procedure` como system prompt |
| `src/skills/modes/procedure-adapter.ts` | Create | Modo 2: adapta `skill.procedure` para `procedure_executions` (P3) — multi-step state |
| `src/skills/modes/tool-mediated.ts` | Create | Modo 3: dispatcher com `skill.allowed_tools` + resolução de policy_descriptors por tool |
| `src/skills/modes/evaluator.ts` | Create | Modo 4: skill consome output de outra skill e retorna `{ score, verdict, reasons }` |
| `src/skills/skill-slice-builder.ts` | Create | Builder paralelizável (master §3.3); produz `SkillSlice` |
| `src/skills/types.ts` | Create | `SkillContract`, `SkillRuntimeHints`, `SkillSlice`, `SkillExecutionInput`, `SkillExecutionOutput` |
| `src/cognition/skill-proposer.ts` | Create | Detector dialógico (similar `procedure-builder`): detecta "skill candidate" em conversa e gera draft |
| `src/cognition/capability-proposer.ts` | Modify | Branch para `proposal_type='skill'` — popula `proposed_spec` no shape `SkillContract` |
| `src/cognition/capability-test-runner.ts` | Modify | Strategy `skill_evaluator` — executa skill evaluator vs baseline antes de aprovar |
| `src/agent/capability-revert.ts` | Modify | Branch skill: marca skill `rolled_back`, libera versão anterior, abre gap técnico |
| `src/admin-ui/proposals/skill-diff.tsx` | Create | View Diff & Approval (master §9 Tela 2) — skill-specific |
| `src/admin-ui/versions/skill-history.tsx` | Create | Version History & Rollback (master §9 Tela 3) |
| `tests/unit/skills/skill-runner.spec.ts` | Create | Testa que `policy_descriptors` é resolvido antes de execução |
| `tests/unit/skills/mode-prompt-only.spec.ts` | Create | Modo 1 |
| `tests/unit/skills/mode-procedure-adapter.spec.ts` | Create | Modo 2 |
| `tests/unit/skills/mode-tool-mediated.spec.ts` | Create | Modo 3 |
| `tests/unit/skills/mode-evaluator.spec.ts` | Create | Modo 4 |
| `tests/unit/skills/skill-slice-builder.spec.ts` | Create | Slice cache + max_items |
| `tests/unit/skills/skills-repo.spec.ts` | Create | Partial unique "one active" + version monotônica |
| `tests/unit/skills/skill-proposer.spec.ts` | Create | Detector dispara só em padrão observado |
| `tests/integration/p9a-skill-lifecycle.spec.ts` | Create | E2E: propose → test → approve → activate → execute → drift → rollback |
| `scripts/p9a-acceptance-gates.sh` | Create | Bateria de gates |
| `docs/runbooks/p9a-skill-abstraction.md` | Create | Runbook |

**Convenção:** `src/control-plane/` é o namespace de **Sources of Truth offline + Admin UI** (master §1). `src/skills/` é o namespace **runtime** (executor + slice builder). Os dois não cruzam: skills-repo NUNCA importa skill-runner; skill-runner SEMPRE consome via skillsRepo + cache.

---

## 2. Migration SQL — `skills` table

**Tipo de `tenant_id`:** master spec usa `UUID`. Schema atual da Maia (`capability_proposals`, etc.) usa `TEXT`. P9a segue v3.1.1: **`UUID`** para alinhar com o resto do Control Plane que está sendo introduzido em P8/P9. Migration adicional pode normalizar pré-existentes em P11.

### 2.1 `036_p9a_skills.sql`

```sql
-- P9a: skills — Skill Contracts versionados (Source of Truth)
-- Master spec v3.1.1 §2.4 + §2.5 (runtime_hints).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE skills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  agent_id            UUID NULL REFERENCES agents(id),     -- NULL = tenant-wide skill

  -- Identificação
  skill_descriptor    TEXT NOT NULL,                       -- ex.: 'detect_legal_risk', 'collect_missing_cpf'
  category            TEXT NOT NULL CHECK (category IN (
                        'classify', 'extract', 'compose',
                        'decide', 'tool_mediated',
                        'diagnose', 'plan', 'evaluator'
                      )),
  execution_mode      TEXT NOT NULL CHECK (execution_mode IN (
                        'prompt_only', 'procedure_adapter', 'tool_mediated', 'evaluator'
                      )),

  -- Contrato semântico
  goal                TEXT NOT NULL,                       -- objetivo em uma frase
  when_to_use         TEXT NOT NULL,                       -- condição de aplicabilidade
  procedure           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- system prompt / steps / template
  constraints         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array de restrições declaradas

  -- Contratos I/O
  input_schema        JSONB NOT NULL,                      -- JSONSchema do input esperado
  output_schema       JSONB NOT NULL,                      -- JSONSchema do output garantido

  -- Recursos
  allowed_tools       TEXT[] NOT NULL DEFAULT '{}',        -- só relevante para tool_mediated
  policy_descriptors  TEXT[] NOT NULL DEFAULT '{}',        -- resolvidos via PolicyDescriptorResolver

  -- Qualidade
  success_criteria    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- tipados (machine_check/llm_judge/etc.)
  failure_modes       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- modos de falha conhecidos

  -- Orçamento runtime (master §2.5 CORREÇÃO #14)
  runtime_hints       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Versionamento + lifecycle
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                        'proposed', 'active', 'deprecated', 'rolled_back'
                      )),
  version             INTEGER NOT NULL,
  proposed_by         TEXT NOT NULL,                       -- 'founder' | 'agent' | 'human:<id>'
  proposed_reason     TEXT,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  activated_at        TIMESTAMPTZ,
  deprecated_at       TIMESTAMPTZ,
  rolled_back_at      TIMESTAMPTZ,
  rollback_reason     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index 1: lookup rápido por descriptor active (hot path)
CREATE INDEX idx_skills_tenant_active
  ON skills(tenant_id, status, skill_descriptor)
  WHERE status = 'active';

-- Index 2: listagem por categoria (slice builder / Admin UI)
CREATE INDEX idx_skills_tenant_category_active
  ON skills(tenant_id, category, status)
  WHERE status = 'active';

-- Index 3: version monotônica obrigatória (não pode haver v2 antes de v1)
CREATE UNIQUE INDEX idx_skills_version_uq
  ON skills(tenant_id, COALESCE(agent_id::text, 'tenant_wide'), skill_descriptor, version);

-- Index 4: "ONE ACTIVE" — partial unique, invariante crítico
CREATE UNIQUE INDEX idx_skills_one_active_uq
  ON skills(tenant_id, COALESCE(agent_id::text, 'tenant_wide'), skill_descriptor)
  WHERE status = 'active';

-- Index 5: proposals pendentes (Admin UI Tela 1 Proposal Inbox)
CREATE INDEX idx_skills_proposed
  ON skills(tenant_id, status, created_at DESC)
  WHERE status = 'proposed';

COMMENT ON TABLE skills IS
  'Skill Contracts versionados. DEFAULT status=proposed (nunca nasce active). Partial unique "one active" garante invariante. Master spec v3.1.1 §2.4.';
```

### 2.2 `036_p9a_skills_down.sql`

```sql
DROP TABLE IF EXISTS skills CASCADE;
```

### 2.3 `037_p9a_extend_capability_proposal_type.sql`

```sql
-- P9a: estende CHECK de capability_proposals.capability_type para 'skill'.
-- Antecipa P8e ('soul_bias') e P9b ('policy_rule') também, sem ativar uso.

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN (
    'tool', 'knowledge', 'procedure', 'integration', 'other',
    'skill', 'soul_bias', 'policy_rule', 'holiday'
  ));
```

### 2.4 Invariantes de schema (validados em testes)

| Invariante | Como é garantido |
|---|---|
| DEFAULT proposed | `DEFAULT 'proposed'` na coluna |
| Nunca duas active simultâneas | `idx_skills_one_active_uq` parcial |
| Versão monotônica | `idx_skills_version_uq` único por descriptor |
| Tenant isolation | NOT NULL + tenant_guard em todo repo |
| Lifecycle CHECK | 4 status enumerados |
| Categoria CHECK | 8 categorias enumeradas |
| Execution mode CHECK | 4 modos enumerados |

---

## 3. `skillsRepo` — control-plane methods

### 3.1 Interface (`src/control-plane/skill-registry/skills-repo.ts`)

```typescript
import { applyTenantGuard } from '@/db/tenant-guard.js';
import type { SkillRow, SkillStatus, SkillCategory } from '@/db/schema.js';

export interface SkillsRepo {
  /** Hot path: resolve descriptor → versão active. Lê via cache (5-10min TTL). */
  findActive(descriptor: string): Promise<SkillRow | null>;

  /** Slice builder: lista categoria active para Context Assembly. */
  listByCategory(category: SkillCategory): Promise<SkillRow[]>;

  /** Cria nova versão `proposed`. NUNCA cria active diretamente. */
  propose(input: ProposeSkillInput): Promise<SkillRow>;

  /** Transita proposed → active. Falha se já existe active para o descriptor (DB enforced). */
  activate(id: string, approver: string, reason?: string): Promise<SkillRow>;

  /** Transita active → deprecated. Permite que próxima versão proposed ative. */
  deprecate(id: string, deprecator: string, reason: string): Promise<SkillRow>;

  /** Transita active → rolled_back. Reativa versão anterior se existir (best-effort, log warning se não). */
  rollback(id: string, reason: string, rolledBackBy: string): Promise<SkillRow>;

  /** Fetch direto por id (Admin UI). */
  getById(id: string): Promise<SkillRow | null>;

  /** Fetch por descriptor + versão exata (history view). */
  getByDescriptor(descriptor: string, version?: number): Promise<SkillRow | null>;

  /** Lista versões de um descriptor (Tela Version History). */
  listVersions(descriptor: string): Promise<SkillRow[]>;
}

export interface ProposeSkillInput {
  skill_descriptor: string;
  category: SkillCategory;
  execution_mode: SkillExecutionMode;
  goal: string;
  when_to_use: string;
  procedure: Record<string, unknown>;
  constraints: Array<Record<string, unknown>>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  allowed_tools?: string[];
  policy_descriptors?: string[];
  success_criteria?: Array<SuccessCriterion>;
  failure_modes?: Array<FailureMode>;
  runtime_hints?: SkillRuntimeHints;
  proposed_by: string;
  proposed_reason?: string;
  agent_id?: string;
}
```

### 3.2 Implementação chave: `propose` + `activate`

```typescript
async propose(input: ProposeSkillInput): Promise<SkillRow> {
  // Determina próxima versão
  const latest = await this.getLatestVersion(input.skill_descriptor, input.agent_id);
  const version = (latest?.version ?? 0) + 1;

  const guarded = applyTenantGuard({
    ...input,
    version,
    status: 'proposed', // DEFAULT redundante, explícito por documentação
  });

  return await db.insert(skills).values(guarded).returning().then(rows => rows[0]);
}

async activate(id: string, approver: string, reason?: string): Promise<SkillRow> {
  return await db.transaction(async (tx) => {
    const skill = await tx.select().from(skills).where(eq(skills.id, id)).then(r => r[0]);
    if (!skill) throw new Error('skill_not_found');
    if (skill.status !== 'proposed') {
      throw new Error(`cannot_activate_from_${skill.status}`);
    }

    // Deprecate versão active anterior (se houver). Partial unique força isso.
    await tx.update(skills)
      .set({ status: 'deprecated', deprecated_at: new Date() })
      .where(and(
        eq(skills.tenant_id, skill.tenant_id),
        eq(skills.skill_descriptor, skill.skill_descriptor),
        eq(skills.status, 'active'),
      ));

    // Promove proposed → active. Se outro thread já promoveu, partial unique vai falhar.
    const [activated] = await tx.update(skills)
      .set({
        status: 'active',
        activated_at: new Date(),
        approved_by: approver,
        approved_at: new Date(),
      })
      .where(eq(skills.id, id))
      .returning();

    return activated;
  });
}
```

### 3.3 Cache (master §3.3)

`SkillSlice` cache: 5-10min TTL. Invalidação por evento:
- `skill_activated` → invalidate `skill:{tenant}:{descriptor}` + lista de categoria
- `skill_deprecated` → invalidate
- `skill_rolled_back` → invalidate

Eventos emitidos no `activate` / `deprecate` / `rollback` via `governance-emitter` (P7) ou subscription Postgres LISTEN/NOTIFY (cluster-wide).

---

## 4. `SkillRunner` — 4 execution_modes

### 4.1 Interface (`src/skills/skill-runner.ts`)

```typescript
import { runCognitiveModule } from '@/cognition/runner.js';
import { skillsRepo } from '@/db/repositories.js';
import { policyDescriptorResolver } from '@/control-plane/policy/policy-descriptor-resolver.js';
import { promptOnlyMode } from './modes/prompt-only.js';
import { procedureAdapterMode } from './modes/procedure-adapter.js';
import { toolMediatedMode } from './modes/tool-mediated.js';
import { evaluatorMode } from './modes/evaluator.js';

export interface SkillExecutionInput {
  skill_descriptor: string;
  input: Record<string, unknown>;
  conversa_id?: string;
  turno_id?: string;
  triggered_by: 'user_message' | 'tool_loop' | 'async_event' | 'evaluator_pipeline';
}

export interface SkillExecutionOutput {
  ok: boolean;
  output?: Record<string, unknown>;
  reason?: 'flag_off' | 'skill_not_found' | 'policy_blocked' | 'budget_exceeded' | 'invalid_input' | 'invalid_output' | 'executor_error' | 'timeout';
  message?: string;
  latency_ms: number;
  resolved_policies: string[];  // policy_ids aplicados
  trace: {
    mode: SkillExecutionMode;
    skill_version: number;
    skill_id: string;
    tools_called?: string[];
    tokens_in?: number;
    tokens_out?: number;
  };
}

export async function runSkill(input: SkillExecutionInput): Promise<SkillExecutionOutput> {
  const startTime = Date.now();

  // Gate 1: feature flag
  if (!featureFlags.isEnabled(FeatureFlagName.SKILL_REGISTRY_V1)) {
    return { ok: false, reason: 'flag_off', latency_ms: Date.now() - startTime, resolved_policies: [], trace: {} as never };
  }

  // Gate 2: lookup
  const skill = await skillsRepo.findActive(input.skill_descriptor);
  if (!skill) {
    return { ok: false, reason: 'skill_not_found', latency_ms: Date.now() - startTime, resolved_policies: [], trace: {} as never };
  }

  // Gate 3: validação de input contra input_schema (Ajv ou similar)
  const inputValidation = validateAgainstSchema(input.input, skill.input_schema);
  if (!inputValidation.valid) {
    return { ok: false, reason: 'invalid_input', message: inputValidation.errors.join('; '), latency_ms: Date.now() - startTime, resolved_policies: [], trace: {} as never };
  }

  // Gate 4: resolve policy_descriptors ANTES de executar (master §0.4 princípio 3)
  const policiesResolved = await policyDescriptorResolver.resolveDescriptors({
    tenant_id: getCurrentTenant(),
    agent_id: getCurrentAgent(),
    descriptors: skill.policy_descriptors,
    scope: { skill_category: skill.category },
  });
  const resolvedPolicyIds = policiesResolved.resolved.map(p => p.policy_id);

  // Gate 5: aplica policies que sejam relevantes a "skill execution"
  const policyDecision = await applyPoliciesPreSkill({ skill, policies: policiesResolved.resolved, input });
  if (policyDecision.decision === 'block') {
    return { ok: false, reason: 'policy_blocked', message: policyDecision.reason, latency_ms: Date.now() - startTime, resolved_policies: resolvedPolicyIds, trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id } };
  }

  // Gate 6: wrap em runCognitiveModule (master invariante #2; P7 audit gate)
  const result = await runCognitiveModule<SkillExecutionOutput>(
    {
      name: `skill:${skill.skill_descriptor}`,
      version: `v${skill.version}`,
      timeoutMs: skill.runtime_hints?.timeout_ms ?? 30000,
      triggered_by: input.triggered_by,
      conversa_id: input.conversa_id,
      turno_id: input.turno_id,
      fallback: { ok: false, reason: 'executor_error', latency_ms: 0, resolved_policies: resolvedPolicyIds, trace: {} as never },
    },
    async () => {
      // Dispatch por modo
      const mode = MODE_DISPATCH[skill.execution_mode];
      const output = await mode({ skill, input: input.input, resolvedPolicies: policiesResolved.resolved });

      // Gate 7: validação de output contra output_schema
      const outputValidation = validateAgainstSchema(output, skill.output_schema);
      if (!outputValidation.valid) {
        return { ok: false, reason: 'invalid_output', message: outputValidation.errors.join('; '), latency_ms: Date.now() - startTime, resolved_policies: resolvedPolicyIds, trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id } };
      }

      return { ok: true, output, latency_ms: Date.now() - startTime, resolved_policies: resolvedPolicyIds, trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id } };
    },
  );

  return result.output ?? { ok: false, reason: 'executor_error', latency_ms: Date.now() - startTime, resolved_policies: resolvedPolicyIds, trace: {} as never };
}

const MODE_DISPATCH = {
  prompt_only: promptOnlyMode,
  procedure_adapter: procedureAdapterMode,
  tool_mediated: toolMediatedMode,
  evaluator: evaluatorMode,
} as const;
```

### 4.2 Modo 1: `prompt_only` (`src/skills/modes/prompt-only.ts`)

**Quando usar:** classificação, extração, sumarização — skill stateless que só precisa do LLM com prompt curado.

```typescript
export async function promptOnlyMode(ctx: ModeContext): Promise<Record<string, unknown>> {
  const { skill, input } = ctx;
  const hints = skill.runtime_hints as SkillRuntimeHints;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: hints.preferred_model ?? defaultModelByCategory(skill.category),
    max_tokens: hints.max_output_tokens ?? defaultMaxTokensByCategory(skill.category),
    system: skill.procedure.system_prompt as string,
    messages: [
      { role: 'user', content: JSON.stringify(input) },
    ],
  });

  return parseJsonStrict(extractText(response));
}
```

**Budget:** `runtime_hints.max_output_tokens` é tetô; harness corta se exceder.

### 4.3 Modo 2: `procedure_adapter` (`src/skills/modes/procedure-adapter.ts`)

**Quando usar:** skill envolve múltiplos passos com estado entre turnos. Skill mapeia para `procedure_definitions` (P3) e o runner se torna um adaptador.

```typescript
export async function procedureAdapterMode(ctx: ModeContext): Promise<Record<string, unknown>> {
  const { skill, input } = ctx;
  const procedureDefId = skill.procedure.procedure_definition_id as string;
  if (!procedureDefId) throw new Error('procedure_adapter_missing_definition_id');

  // Cria nova procedure_execution (P3b) — runtime stateful
  const execution = await procedureExecutionsRepo.start({
    definition_id: procedureDefId,
    conversa_id: ctx.conversa_id!,
    initial_state: input,
  });

  // Executa primeiro step. Subsequent steps avançam via mensagens do usuário.
  const stepOutcome = await stepEvaluator.evaluate({
    execution_id: execution.id,
    step_id: execution.current_step_id!,
  });

  return {
    procedure_execution_id: execution.id,
    current_step: execution.current_step_id,
    outcome: stepOutcome,
  };
}
```

**Important:** modo 2 NÃO bloqueia esperando todo procedimento completar. Retorna referência da execução; o agent_runtime continua a conversa nos próximos turnos.

### 4.4 Modo 3: `tool_mediated` (`src/skills/modes/tool-mediated.ts`)

**Quando usar:** skill precisa orquestrar ferramentas (chamadas externas). LLM decide qual tool chamar **dentro do conjunto declarado em `allowed_tools`**. Out-of-set blocked.

```typescript
export async function toolMediatedMode(ctx: ModeContext): Promise<Record<string, unknown>> {
  const { skill, input, resolvedPolicies } = ctx;
  const hints = skill.runtime_hints as SkillRuntimeHints;
  const maxToolCalls = hints.max_tool_calls ?? 5;

  // Filtra registry para apenas allowed_tools
  const allowedTools = toolRegistry.list().filter(t =>
    skill.allowed_tools.includes(t.name),
  );

  // Por tool, resolve seus policy_descriptors (Tool Manifest §7)
  const toolsWithResolvedPolicies = await Promise.all(allowedTools.map(async tool => {
    const toolPolicies = await policyDescriptorResolver.resolveDescriptors({
      tenant_id: getCurrentTenant(),
      descriptors: tool.policy_descriptors,
    });
    return { tool, policies: toolPolicies.resolved };
  }));

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let conversation = [{ role: 'user' as const, content: JSON.stringify(input) }];
  let toolCalls = 0;
  let finalOutput: Record<string, unknown> | null = null;

  while (toolCalls < maxToolCalls) {
    const response = await anthropic.messages.create({
      model: hints.preferred_model ?? 'claude-sonnet-4-6',
      max_tokens: hints.max_output_tokens ?? 4000,
      system: skill.procedure.system_prompt as string,
      tools: allowedTools.map(t => t.manifest),
      messages: conversation,
    });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      finalOutput = parseJsonStrict(extractText(response));
      break;
    }

    for (const toolUse of toolUses) {
      const tool = allowedTools.find(t => t.name === toolUse.name);
      if (!tool) {
        conversation.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, is_error: true, content: 'tool_not_allowed' }] });
        continue;
      }

      // Late PEP por tool: aplica policies do tool antes da chamada
      const toolPolicies = toolsWithResolvedPolicies.find(t => t.tool.name === tool.name)?.policies ?? [];
      const toolDecision = await applyPoliciesPreTool({ tool, policies: toolPolicies, input: toolUse.input });
      if (toolDecision.decision === 'block') {
        conversation.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, is_error: true, content: `policy_blocked:${toolDecision.reason}` }] });
        continue;
      }

      const toolResult = await tool.execute(toolUse.input as never);
      conversation.push({ role: 'assistant', content: response.content });
      conversation.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) }] });
      toolCalls++;
    }
  }

  if (!finalOutput) throw new Error('tool_mediated_max_iterations');
  return finalOutput;
}
```

**Cumulative budget:** soma de tokens das chamadas ≤ `hints.max_prompt_tokens`; soma de output ≤ `hints.max_output_tokens`. Estouro → fallback `budget_exceeded`.

### 4.5 Modo 4: `evaluator` (`src/skills/modes/evaluator.ts`)

**Quando usar:** uma skill cuja função é **validar output de outra skill** (ou de um pipeline). Retorna `{ score, verdict, reasons }`. Usada por `capability-test-runner` para auto-test pós-ativação.

```typescript
export interface EvaluatorOutput {
  score: number;          // 0..1
  verdict: 'pass' | 'fail' | 'inconclusive';
  reasons: string[];
  evidence: Array<{ field: string; expected: unknown; actual: unknown }>;
}

export async function evaluatorMode(ctx: ModeContext): Promise<EvaluatorOutput> {
  const { skill, input } = ctx;
  // input.candidate_output = output da skill avaliada
  // input.baseline = expected output ou ground truth
  // input.context = contexto de execução

  const hints = skill.runtime_hints as SkillRuntimeHints;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: hints.preferred_model ?? 'claude-sonnet-4-6',
    max_tokens: hints.max_output_tokens ?? 2000,
    system: skill.procedure.system_prompt as string,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  });

  const parsed = parseJsonStrict(extractText(response)) as EvaluatorOutput;
  if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 1) {
    throw new Error('evaluator_invalid_score');
  }
  return parsed;
}
```

**Constraint:** evaluator skill **nunca tem `allowed_tools`** (não age, só julga). Validado em `skillsRepo.propose`.

---

## 5. `PolicyDescriptorResolver` integration (P8e dependency)

P9a **depende** de `PolicyDescriptorResolver` (master §2.2, CORREÇÃO #4) entregue em P8e/P8 Foundation. Se P8e ainda não está em prod, P9a ships com **stub resolver** que sempre retorna `{ resolved: [], unresolved: descriptors }` e logs warning.

**Skill execution sem resolver real:**
- `policy_descriptors=[]` → executa normalmente
- `policy_descriptors=['lgpd_strict']` + stub → loga `policy_descriptor_unresolved` + bloqueia execução com `reason='policy_blocked'`

Quando P8e ativa: troca import `policyDescriptorResolverStub` por `policyDescriptorResolver`. Feature flag `FEATURE_POLICY_RESOLVER_V1` (master §14) controla.

**Regra inviolável:** *"Skill não pode bypass policies. Se o resolver não consegue resolver descriptor declarado, skill falha em vez de executar sem proteção."*

---

## 6. Token budget por category (master §2.5)

`runtime_hints` declarado pelo proposer (humano ou LLM). Defaults aplicados se não declarado:

| Category | Default max_prompt_tokens | Default max_output_tokens | Default model | Default max_tool_calls |
|---|---|---|---|---|
| `classify` | 1500 | 1000 | claude-haiku | 0 |
| `extract` | 2000 | 1500 | claude-haiku | 0 |
| `compose` | 3000 | 3000 | claude-haiku | 0 |
| `decide` | 4000 | 4000 | claude-sonnet | 3 |
| `tool_mediated` | 6000 | 4000 | claude-sonnet | 5 |
| `diagnose` | 8000 | 8000 | claude-sonnet | 5 |
| `plan` | 10000 | 10000 | claude-sonnet | 0 |
| `evaluator` | 4000 | 2000 | claude-sonnet | 0 |

**Caps são teto, não defaults pretendidos.** Proposer **deve** declarar `runtime_hints` quando a skill foge do default. `SkillRunner` enforce via `max_tokens` no SDK call.

**Excedeu budget:** behavior fallback (master §3.8) — para tool loop, gera resposta curta, ou escala. `SkillExecutionOutput.reason='budget_exceeded'`.

---

## 7. `SkillSlice` + builder

### 7.1 Type (`src/skills/types.ts`)

```typescript
export interface SkillSlice {
  selected?: SkillSummary;        // se DecisionPacket.routing.selected_skill_id está set
  candidates: SkillSummary[];     // candidates relevantes ao intent/category
  total_active_in_tenant: number;
  builder_metadata: {
    cache_hit: boolean;
    cached_at?: string;
    ttl_seconds: number;
  };
}

export interface SkillSummary {
  id: string;
  skill_descriptor: string;
  category: SkillCategory;
  execution_mode: SkillExecutionMode;
  goal: string;
  when_to_use: string;
  version: number;
  runtime_hints: SkillRuntimeHints;
  // intencionalmente SEM procedure/input_schema/output_schema completos — slice é pra LLM ver "que skills existem", não pra executar
}
```

### 7.2 Builder (`src/skills/skill-slice-builder.ts`)

```typescript
export async function buildSkillSlice(ctx: {
  tenant_id: string;
  agent_id?: string;
  decision: DecisionPacket;
}): Promise<SkillSlice> {
  const { decision } = ctx;
  const cacheKey = `skill_slice:${ctx.tenant_id}:${ctx.agent_id ?? 'tenant_wide'}:${decision.routing.selected_skill_id ?? 'none'}:${decision.intent.label}`;

  const cached = await sliceCache.get<SkillSlice>(cacheKey);
  if (cached) return { ...cached, builder_metadata: { ...cached.builder_metadata, cache_hit: true } };

  let selected: SkillSummary | undefined;
  if (decision.routing.selected_skill_id) {
    const row = await skillsRepo.getById(decision.routing.selected_skill_id);
    if (row) selected = toSummary(row);
  }

  // Candidates: max 5 por default (DecisionPacket.context_requirements.skill se quer mais)
  const candidateIds = decision.routing.candidate_skill_ids ?? [];
  const candidates = await Promise.all(candidateIds.slice(0, 5).map(id => skillsRepo.getById(id)));
  const candidateSummaries = candidates.filter((r): r is SkillRow => r !== null).map(toSummary);

  const total = await skillsRepo.countActive();

  const slice: SkillSlice = {
    selected,
    candidates: candidateSummaries,
    total_active_in_tenant: total,
    builder_metadata: { cache_hit: false, ttl_seconds: 600 },
  };

  await sliceCache.set(cacheKey, slice, 600);
  return slice;
}
```

**Invalidação:** subscriber a eventos `skill_activated|deprecated|rolled_back` flusha cache por tenant.

---

## 8. Skill proposer detector (cognitive module)

### 8.1 Conceito

Análogo ao `procedure-builder` (P3a) e `calendar-pattern-detector` (Calendar v2). Roda em **batch async** sobre `cognitive_module_log` + `reflection_records` e detecta padrões que sugerem skill candidate:

- N conversas em que LLM precisou raciocinar pattern X → sugerir skill `classify_X`
- N falhas de tool dispatcher por ausência de capability orquestrada → sugerir skill `tool_mediated`
- N respostas com mesma estrutura → sugerir skill `compose_X`

### 8.2 `src/cognition/skill-proposer.ts`

```typescript
import { runCognitiveModule } from './runner.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';

export async function detectAndProposeSkill(args: {
  tenant_id: string;
  agent_id: string;
  window_days?: number;
}): Promise<{ proposed: number; skipped: number }> {
  return await runCognitiveModule(
    { name: 'skill_proposer_detector', triggered_by: 'async_event', timeoutMs: 60000 },
    async () => {
      // 1. Determinístico: scaneia cognitive_module_log + reflection_records
      const patterns = await scanForSkillPatterns({ tenant_id: args.tenant_id, agent_id: args.agent_id, days: args.window_days ?? 7 });

      let proposed = 0;
      let skipped = 0;

      for (const pattern of patterns) {
        // 2. Determinístico: já existe skill com descriptor similar?
        const existing = await skillsRepo.findActive(pattern.suggested_descriptor);
        if (existing) { skipped++; continue; }

        // 3. LLM Sonnet (único call): gera draft SkillContract
        const draft = await generateSkillDraftWithLLM(pattern);
        if (!draft) { skipped++; continue; }

        // 4. Persiste como capability_proposal (capability_type='skill', proposed_spec=SkillContract shape)
        await capabilityProposalsRepo.create({
          capability_type: 'skill',
          title: draft.skill_descriptor,
          description: draft.goal,
          proposed_spec: draft,           // shape de SkillContract
          motivation: pattern.evidence_summary,
          expected_impact: draft.when_to_use,
          test_scenarios: draft.test_scenarios ?? [],
        });
        proposed++;
      }

      return { proposed, skipped };
    },
  ).then(r => r.output ?? { proposed: 0, skipped: 0 });
}
```

**Gate:** roda só se `FEATURE_SKILL_REGISTRY_V1` está on. Sem flag, detector retorna `{proposed:0, skipped:0}`.

---

## 9. Capability proposer + test runner + revert (P5 estendido)

### 9.1 `capability-proposer.ts` branch para skill

Adicionar em `capability-proposer.ts` (P5 task 7):

```typescript
// Branch novo para proposal_type='skill'
if (gap.suggested_capability_type === 'skill') {
  const llmDraft = await generateSkillDraft(args);
  return await capabilityProposalsRepo.create({
    capability_type: 'skill',
    title: llmDraft.skill_descriptor,
    description: llmDraft.goal,
    proposed_spec: llmDraft,             // mesmo shape de SkillContract
    motivation: llmDraft.motivation,
    expected_impact: llmDraft.expected_impact,
    test_scenarios: llmDraft.test_scenarios,
  });
}
```

LLM prompt instrui que `proposed_spec` deve ter campos do `SkillContract`: `category`, `execution_mode`, `goal`, `when_to_use`, `procedure`, `input_schema`, `output_schema`, `allowed_tools` (se tool_mediated), `policy_descriptors`, `success_criteria`, `failure_modes`, `runtime_hints`.

### 9.2 `capability-test-runner.ts` strategy `skill_evaluator`

```typescript
TEST_STRATEGIES.skill_evaluator = async (scenario, opts) => {
  const evaluatorSkillId = opts?.evaluator_skill_id;
  if (!evaluatorSkillId) return { passed: false, observed: 'no_evaluator_skill', reason: 'config_error' };

  // Executa skill candidata em modo "dry_run"
  const candidateResult = await runSkill({
    skill_descriptor: scenario.given,    // descriptor da skill que está sendo testada
    input: scenario.when_input,
    triggered_by: 'evaluator_pipeline',
  });
  if (!candidateResult.ok) return { passed: false, observed: candidateResult.reason ?? 'candidate_failed' };

  // Executa evaluator
  const evalResult = await runSkill({
    skill_descriptor: opts.evaluator_descriptor,
    input: {
      candidate_output: candidateResult.output,
      baseline: scenario.then_expected,
      context: scenario,
    },
    triggered_by: 'evaluator_pipeline',
  });

  if (!evalResult.ok) return { passed: false, observed: 'evaluator_error', reason: evalResult.reason };
  const verdict = (evalResult.output as EvaluatorOutput).verdict;
  return { passed: verdict === 'pass', observed: verdict, reason: (evalResult.output as EvaluatorOutput).reasons.join('; ') };
};
```

### 9.3 `capability-revert.ts` branch skill

```typescript
// Em revertCapability — branch para proposals onde capability_type='skill'
if (args.proposal.capability_type === 'skill') {
  const skillId = args.proposal.delivery_artifact_ref;  // skill id salvo no delivery
  if (skillId) {
    await skillsRepo.rollback(skillId, args.reason, 'capability-revert');
  }
  // Cria gap técnico normal
  const newGap = await capabilityGapsRepo.create({
    capability_description: `[técnica] skill ${args.proposal.title} falhou pós-ativação`,
    tipo: 'technical',
    contexto: args.reason,
  });
  return { technical_gap_id: newGap.id };
}
```

---

## 10. Admin UI integration (master §9)

### Tela 1: Proposal Inbox
- Filtro `type=skill` mostra `skills WHERE status='proposed'` + `capability_proposals WHERE capability_type='skill'` (unificado por timeline)
- Badge: count de skills pending
- Bulk reject: marca múltiplas como `rolled_back` com motivo padrão

### Tela 2: Proposal Diff & Approval (skill-specific view)
- Painel "Skill Contract" mostra:
  - `category` + `execution_mode` (chips)
  - `goal` / `when_to_use` (prose)
  - `procedure` (collapsible JSON or rendered prompt)
  - `input_schema` / `output_schema` (JSONSchema preview com exemplos válidos/inválidos gerados)
  - `allowed_tools` (lista clicável)
  - `policy_descriptors` (cada um com link pra `policy_rules` resolvido)
  - `success_criteria` (table)
  - `failure_modes` (table)
  - `runtime_hints` (token budget + model)
- Diff vs versão active anterior (side-by-side)
- Test results de `capability_test_results` se rodaram
- Approve/Reject com comentário obrigatório (audit)
- **Approval class** (master §9 matriz): skill `runtime_hints.has_tool_calls=true` ou `allowed_tools` não vazio → "owner + technical reviewer" (dual)

### Tela 3: Version History & Rollback
- Por `skill_descriptor`, lista todas versões com status + timestamps
- Diff entre quaisquer 2 versões
- Botão "Rollback to v_n" com motivo obrigatório → chama `skillsRepo.rollback`
- Sidebar "quem usa esta skill": agents/roles + recent execution count

### Tela 4: Drift & Incidents
- Skill metric matview (master §4.1 `skill_metrics`): success rate, latência p95, budget compliance
- Alert se p95 latência > `runtime_hints.timeout_ms * 0.8` consistente
- Alert se success rate < 80% em janela 7d
- Skill drift detector (P9b) anota aqui

### Tela 5: Audit & Trace Explorer
- Trace mostra qual skill foi executada por turno
- Link pra versão da skill (audit imutável)
- `resolved_policies` aparecem inline

---

## 11. Testing

### 11.1 Unit tests (por modo)

`tests/unit/skills/mode-prompt-only.spec.ts`:
- Mocked Anthropic SDK
- Verifica que `runtime_hints.max_output_tokens` é passado ao SDK
- Verifica que output passa validação contra `output_schema`
- Verifica que output inválido retorna `reason='invalid_output'`

`tests/unit/skills/mode-procedure-adapter.spec.ts`:
- Skill com `procedure.procedure_definition_id` válido → cria `procedure_execution`
- Skill sem `procedure_definition_id` → throw `procedure_adapter_missing_definition_id`

`tests/unit/skills/mode-tool-mediated.spec.ts`:
- Tool fora de `allowed_tools` → `tool_result.is_error=true` content `tool_not_allowed`
- Policy blocked tool → `policy_blocked:{reason}`
- Excede `max_tool_calls` → throw `tool_mediated_max_iterations`

`tests/unit/skills/mode-evaluator.spec.ts`:
- Score fora de [0,1] → throw `evaluator_invalid_score`
- `verdict='pass'` → `outcome.passed=true` quando chamado via `skill_evaluator` strategy

### 11.2 Unit tests (skill-runner)

`tests/unit/skills/skill-runner.spec.ts`:
- Flag off → `reason='flag_off'`
- Skill não encontrada → `reason='skill_not_found'`
- Input inválido vs `input_schema` → `reason='invalid_input'`
- `policy_descriptors` não resolvidos → `reason='policy_blocked'`
- `runCognitiveModule` é chamado com `name=skill:<descriptor>` e `version=v<N>`
- Output validado contra `output_schema` antes de retornar `ok:true`

### 11.3 Unit tests (repo)

`tests/unit/skills/skills-repo.spec.ts`:
- `propose` com versão duplicada → DB throw (unique violation)
- `propose` cria com `status='proposed'` mesmo se input pedir `active`
- `activate` move proposed→active e deprecate active anterior em transação
- Tentativa de criar segunda active → partial unique violation
- `rollback` move active→rolled_back e reativa anterior (se houver)
- Tenant guard: lookup de outro tenant retorna null

### 11.4 Integration

`tests/integration/p9a-skill-lifecycle.spec.ts`:
1. Setup: tenant + agent + 2 mock tools
2. Detector propõe skill `classify_legal_risk` (capability_proposal `capability_type='skill'`)
3. Owner aprova proposal no Admin UI → `skillsRepo.propose` + `activate` chained
4. Skill é executável: `runSkill({descriptor: 'classify_legal_risk', input: {...}})` retorna `ok:true`
5. Drift detector marca p95 alto
6. Owner clica rollback → `skillsRepo.rollback` → skill volta a `rolled_back`
7. Versão anterior (se houver) reativa
8. Capability-revert cria gap técnico

### 11.5 Skill samples (fixtures de teste)

#### Sample A — `detect_legal_risk` (`prompt_only`)

```json
{
  "skill_descriptor": "detect_legal_risk",
  "category": "classify",
  "execution_mode": "prompt_only",
  "goal": "Detectar se mensagem do usuário contém risco jurídico (litígio, ameaça, requerimento formal)",
  "when_to_use": "Mensagens livres recebidas no canal whatsapp ou email, antes de roteamento de intent.",
  "procedure": {
    "system_prompt": "Você é um classificador. Recebe mensagem do usuário. Retorne JSON {risk: 'none'|'low'|'medium'|'high', evidence: string[], category: 'litigation'|'threat'|'formal_demand'|null}. Critério..."
  },
  "constraints": [
    { "type": "no_external_calls", "rationale": "classificação puramente textual" }
  ],
  "input_schema": { "type": "object", "properties": { "message": {"type":"string"}, "channel": {"type":"string"} }, "required": ["message"] },
  "output_schema": { "type": "object", "properties": { "risk": {"enum":["none","low","medium","high"]}, "evidence": {"type":"array"}, "category": {"type":["string","null"]} }, "required": ["risk","evidence"] },
  "allowed_tools": [],
  "policy_descriptors": ["lgpd_classification"],
  "success_criteria": [
    { "type": "machine_check", "expr": "output.risk in ['none','low','medium','high']" }
  ],
  "failure_modes": [
    { "mode": "false_positive_threat", "mitigation": "score < 0.7 → marcar low" }
  ],
  "runtime_hints": {
    "max_prompt_tokens": 1500,
    "max_output_tokens": 800,
    "max_tool_calls": 0,
    "preferred_model": "claude-haiku"
  }
}
```

#### Sample B — `collect_missing_cpf` (`procedure_adapter`)

```json
{
  "skill_descriptor": "collect_missing_cpf",
  "category": "decide",
  "execution_mode": "procedure_adapter",
  "goal": "Coletar CPF do usuário em uma conversa de N turnos com validação",
  "when_to_use": "Workflow de cadastro requer CPF e usuário não forneceu.",
  "procedure": { "procedure_definition_id": "<uuid>" },
  "constraints": [
    { "type": "sensitive_data", "rule": "CPF é PII; salvar sob memory_type='cpf_pii' com sensitivity='high'" }
  ],
  "input_schema": { "type": "object", "properties": { "user_id": {"type":"string"} }, "required": ["user_id"] },
  "output_schema": { "type": "object", "properties": { "procedure_execution_id": {"type":"string"}, "outcome": {"type":"object"} } },
  "allowed_tools": [],
  "policy_descriptors": ["lgpd_strict", "pii_handling"],
  "success_criteria": [
    { "type": "user_signal", "criterion": "usuário confirma CPF correto" },
    { "type": "machine_check", "expr": "isValidCpf(state.cpf)" }
  ],
  "failure_modes": [
    { "mode": "user_abandona_apos_3_tentativas", "mitigation": "escalar humano" }
  ],
  "runtime_hints": {
    "max_prompt_tokens": 4000,
    "max_output_tokens": 1500,
    "max_tool_calls": 0,
    "preferred_model": "claude-haiku"
  }
}
```

#### Sample C — `resolve_billing_dispute` (`tool_mediated`)

```json
{
  "skill_descriptor": "resolve_billing_dispute",
  "category": "tool_mediated",
  "execution_mode": "tool_mediated",
  "goal": "Investigar disputa de cobrança consultando dados e propor reembolso/correção",
  "when_to_use": "Usuário reporta cobrança duplicada/incorreta. Risk medium.",
  "procedure": {
    "system_prompt": "Você investiga disputa. Use tools list_transactions e cancel_transaction. NUNCA proponha reembolso sem confirmar duplicidade. Devolva JSON {verdict, proposed_action, evidence}."
  },
  "constraints": [
    { "type": "max_refund_brl", "value": 5000, "rationale": "policy financeira" }
  ],
  "input_schema": { "type":"object", "properties": { "dispute_id": {"type":"string"}, "user_id": {"type":"string"} }, "required": ["dispute_id","user_id"] },
  "output_schema": { "type":"object", "properties": { "verdict": {"enum":["confirmed_duplicate","not_duplicate","inconclusive"]}, "proposed_action": {"type":"object"}, "evidence": {"type":"array"} }, "required": ["verdict","evidence"] },
  "allowed_tools": ["list-transactions", "cancel-transaction"],
  "policy_descriptors": ["financial_action_dual_approval", "lgpd_strict"],
  "success_criteria": [
    { "type": "llm_judge", "evaluator_skill": "validate_dispute_resolution" }
  ],
  "failure_modes": [
    { "mode": "valor_acima_limite", "mitigation": "escalar humano" }
  ],
  "runtime_hints": {
    "max_prompt_tokens": 6000,
    "max_output_tokens": 4000,
    "max_tool_calls": 5,
    "preferred_model": "claude-sonnet-4-6"
  }
}
```

#### Sample D — `validate_skill_output` (`evaluator`)

```json
{
  "skill_descriptor": "validate_skill_output",
  "category": "evaluator",
  "execution_mode": "evaluator",
  "goal": "Validar se output de outra skill bate com baseline esperado",
  "when_to_use": "Pipeline de teste pós-ativação (capability-test-runner).",
  "procedure": {
    "system_prompt": "Você compara candidate_output com baseline. Retorne JSON {score: 0..1, verdict: 'pass'|'fail'|'inconclusive', reasons: string[], evidence: [{field, expected, actual}]}. Score >= 0.85 = pass."
  },
  "constraints": [
    { "type": "no_tool_calls", "rationale": "evaluator não age" }
  ],
  "input_schema": { "type":"object", "properties": { "candidate_output": {"type":"object"}, "baseline": {"type":"object"}, "context": {"type":"object"} }, "required": ["candidate_output","baseline"] },
  "output_schema": { "type":"object", "properties": { "score": {"type":"number","minimum":0,"maximum":1}, "verdict": {"enum":["pass","fail","inconclusive"]}, "reasons": {"type":"array"}, "evidence": {"type":"array"} }, "required": ["score","verdict","reasons"] },
  "allowed_tools": [],
  "policy_descriptors": [],
  "success_criteria": [
    { "type": "machine_check", "expr": "output.score >= 0 && output.score <= 1" }
  ],
  "failure_modes": [],
  "runtime_hints": {
    "max_prompt_tokens": 4000,
    "max_output_tokens": 2000,
    "max_tool_calls": 0,
    "preferred_model": "claude-sonnet-4-6"
  }
}
```

---

## 12. Acceptance gates

| # | Gate | Como verifica |
|---|---|---|
| G1 | Migration cria tabela `skills` com 15 colunas + runtime_hints | `psql -c "\d skills"` |
| G2 | DEFAULT `status='proposed'` | Insert sem status → row tem `'proposed'` |
| G3 | Partial unique "one active" | Insert active com mesmo descriptor → DB throw |
| G4 | Version monotônica | Insert duplicada (mesmo descriptor, mesma versão) → DB throw |
| G5 | `skillsRepo.propose` aplica tenant_guard | Insert sem tenant_context → MissingTenantContextError |
| G6 | `runSkill` falha com flag off | Retorna `reason='flag_off'` |
| G7 | `runSkill` valida input contra schema | Input inválido → `reason='invalid_input'` |
| G8 | `runSkill` resolve `policy_descriptors` ANTES de executar | Mock resolver chamado; sem resolução → `policy_blocked` |
| G9 | `runSkill` wrapado em `runCognitiveModule` | `cognitive_module_log` recebe row com `module_name='skill:<descriptor>'` |
| G10 | Modo `prompt_only` honra `max_output_tokens` | Mock SDK recebe `max_tokens` certo |
| G11 | Modo `procedure_adapter` cria `procedure_execution` | DB tem row em `procedure_executions` |
| G12 | Modo `tool_mediated` bloqueia tool fora de `allowed_tools` | Tool dispatch retorna `tool_not_allowed` |
| G13 | Modo `tool_mediated` enforce `max_tool_calls` | Loop excede → throw |
| G14 | Modo `evaluator` valida score 0..1 | Score 1.5 → throw |
| G15 | `evaluator` skill com `allowed_tools` rejeita propose | `skillsRepo.propose` throw `evaluator_cannot_have_tools` |
| G16 | Output validado contra `output_schema` | Output inválido → `reason='invalid_output'` |
| G17 | `activate` deprecate anterior em transação | Antes: 1 active. Depois `activate`: nova active, anterior `deprecated`, timestamp coerente |
| G18 | `rollback` reativa anterior | Cenário com v1 deprecated + v2 active. Rollback v2 → v2 rolled_back, v1 reactivated |
| G19 | `capability_proposals.capability_type='skill'` aceito | Migration 037 permite valor `'skill'` |
| G20 | Detector `skill_proposer` cria capability_proposal | Run com mock pattern → row em capability_proposals |
| G21 | `capability-test-runner` strategy `skill_evaluator` executa evaluator | Mock skill + mock evaluator → outcome correto |
| G22 | `capability-revert` chama `skillsRepo.rollback` para skill | Mock proposal `capability_type='skill'` → rollback chamado |
| G23 | Slice builder cache 5-10min + evento invalida | Set cache, emit `skill_activated`, get cache → miss |
| G24 | Admin UI Tela 2 mostra Skill Contract completo | E2E playwright/cypress (placeholder) |

`scripts/p9a-acceptance-gates.sh` orquestra G1-G23 (G24 manual ou via test UI). Falha em qualquer um → exit non-zero.

---

## 13. Feature flag

**Nome:** `FEATURE_SKILL_REGISTRY_V1`

**Env:** `FEATURE_SKILL_REGISTRY_V1=false` (default off — invariante #3 master §15)

**Comportamento off:**
- `runSkill` retorna `reason='flag_off'` imediatamente (sem custo Anthropic)
- `skill-proposer` detector pula execução
- `capability-proposer` branch skill não dispara (cai em outras branches)
- `capability-test-runner` strategy `skill_evaluator` retorna `{passed:false, observed:'flag_off'}`
- `skill-slice-builder` retorna slice vazio `{candidates: [], total_active_in_tenant: 0}`
- Migration **roda** (cria tabela), mas tabela fica vazia (skill registry dormante)

**Comportamento on:**
- Tudo acima ativo
- Owners podem criar skills via Admin UI ou via `skillsRepo.propose` direto
- Cognitive graph (P7) pode chamar `runSkill` quando intent matchear

**Promoção:**
- Canary: 1 tenant interno por 7 dias
- Métrica de promoção: success rate ≥ 90% + p95 latency dentro de `runtime_hints` declarado para 100% das skills active
- Rollback: flag off + skills active congelam (`runSkill` retorna `flag_off`)

---

## 14. Risks + mitigations

| Risco | Mitigação |
|---|---|
| Skill mal-definida bypassa policy ao executar tool | `SkillRunner` resolve `policy_descriptors` **antes** de invocar modo; modo tool_mediated re-resolve por tool. Duplo gate |
| LLM ativa skill perigosa propondo `runtime_hints` exagerado | Default caps por category aplicam; proposer não pode sobrescrever via prompt sem aprovação humana |
| Skill `evaluator` ganha capacidade de agir | Schema rejeita `allowed_tools.length > 0` quando `execution_mode='evaluator'` (validação no `propose`) |
| Múltiplos workers ativam mesma skill simultaneamente | Partial unique no DB; transação no `activate`; race → 1 ganha, outros falham com unique violation |
| Skill ativa quando policy descriptor não resolve | Stub resolver bloqueia; resolver real falha com `unresolved.length > 0` → `policy_blocked` |
| `runtime_hints.allow_deep_context=true` indiscriminado | Default false; ativação requer aprovação humana com justificativa |
| Detector cria spam de proposals | Determinístico antes do LLM: só propõe se padrão N vezes em janela X + sem skill similar active |
| Skill drift não detectado | P9b drift detector + matview `skill_metrics` + alerts em Admin UI Tela 4 |
| Migration falha em tenant existente sem UUID | TEXT vs UUID — P9a usa UUID (master spec). Se tenant_id atual é TEXT, migration aux em P11 normaliza. P9a ships com **migration condicional** ou flag pra ambiente |
| Procedure adapter perde execução | `procedure_executions` já tem TTL (P3); abandon reflection cobre |
| `capability_proposals.proposed_spec` shape diverge de SkillContract | Validação JSON schema no Admin UI Tela 2 antes de aprovar |
| Cache stale após rollback | Invalidação por evento + TTL curto; pior caso 10min de stale (aceitável; skill rolled_back ainda passa por validação) |
| Audit gap se runner falha antes do runCognitiveModule | Gate flag-off retorna early com `reason='flag_off'` sem log (intencional); demais gates fail dentro do wrapper |

---

## 15. Done criteria

- [ ] Migration 036 + 037 aplicadas em staging
- [ ] `skillsRepo` com 9 métodos + testes unit cobrindo `propose`/`activate`/`rollback`
- [ ] `SkillRunner` com 4 modos implementados + testes por modo
- [ ] `policyDescriptorResolver` integration (stub ou real conforme P8e)
- [ ] `runCognitiveModule` wrap aplicado a todo runSkill — gate G9 passa
- [ ] `SkillSlice` builder com cache + invalidação por evento
- [ ] `skill-proposer` detector roda em batch async; gate flag-off respeitado
- [ ] `capability-proposer` branch `'skill'` + `capability-test-runner` strategy `skill_evaluator` + `capability-revert` branch
- [ ] Admin UI: Tela 1 lista skills proposed; Tela 2 mostra Skill Contract diff; Tela 3 version history + rollback
- [ ] 24 acceptance gates passam (script `scripts/p9a-acceptance-gates.sh`)
- [ ] 4 sample skills (A/B/C/D) executáveis em ambiente de teste
- [ ] Runbook `docs/runbooks/p9a-skill-abstraction.md` publicado
- [ ] Feature flag `FEATURE_SKILL_REGISTRY_V1` em `feature-flags.ts` e default off
- [ ] Canary em 1 tenant por 7 dias com success rate ≥ 90% antes de promoção
- [ ] Memória de design atualizada (`project_skill_abstraction_design.md`) sintetizando decisões e referenciando esta spec

---

## 16. Architecture Lock check

Esta spec **NÃO altera**:
- Precedence Pyramid (Skill segue nível 5; Tool nível 6; Policy nível 1-2)
- Knowledge lifecycle (skills não passam pelo KSM; têm seu próprio lifecycle)
- Policy enforcement model (skills consumem policies via resolver; nunca bypass)
- Identity/Soul boundaries (skills não modulam identity; Soul inclina skill execution via bias)
- Approval classes (skill change segue matriz master §9)

Qualquer mudança nesses 5 itens requer founder approval (master §0.1).

---

**End of P9a Skill Abstraction Design.**
