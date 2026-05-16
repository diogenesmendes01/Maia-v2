# P9a Skill Abstraction — Runbook

## Visão geral

P9a unifica 4 conceitos "skill-like" (Tool, Procedure, Cognitive Module, Role/Channel
Policy) em um único contrato declarativo: **Skill Contract**. Cada skill vive como
linha em `skills` (Source of Truth, control-plane); cada execução passa pelo
`SkillRunner` (executor estável em `src/skills/skill-runner.ts`) que dispara um
de 4 modos (`prompt_only`, `procedure_adapter`, `tool_mediated`, `evaluator`).

**Princípio inviolável (frase-mãe):** *"A Maia aprende com a experiência, mas só
evolui dentro de governança, escopo e evidência."* Uma skill NUNCA nasce ativa.
Sempre `proposed → approved → active`.

---

## Quick start

- **Feature flag:** `FEATURE_SKILL_REGISTRY_V1` (default OFF). Set
  `FEATURE_SKILL_REGISTRY_V1=true` no `.env` para habilitar `runSkill`.
- **Migrações:** `036_p9a_skills.sql`, `037_p9a_extend_capability_proposal_type.sql`.
- **Source of Truth:** tabela `skills` (15 cols + lifecycle metadata).
- **Executor:** `src/skills/skill-runner.ts` + 4 modes em `src/skills/modes/`.
- **Proposer:** `src/cognition/skill-proposer.ts` (batch async).
- **Slice builder:** `src/skills/skill-slice-builder.ts` (cache 10 min TTL).

---

## Operações

### Propor uma skill (CLI / repl)

```ts
import { skillsRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
  await skillsRepo.propose({
    skill_descriptor: 'detect_legal_risk',
    category: 'classify',
    execution_mode: 'prompt_only',
    goal: 'Detectar risco jurídico em mensagens',
    when_to_use: 'Quando a mensagem contém termos contratuais',
    procedure: { system_prompt: 'You are a legal risk classifier.' },
    input_schema: { type: 'object', required: ['msg'], properties: { msg: { type: 'string' } } },
    output_schema: {
      type: 'object',
      required: ['risk_level'],
      properties: {
        risk_level: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
    runtime_hints: { max_output_tokens: 500, timeout_ms: 5000 },
    proposed_by: 'founder',
    proposed_reason: 'Recorrente em pedidos de owner',
  });
});
```

### Aprovar / ativar uma skill

```ts
await skillsRepo.activate(skill_id, 'owner@maia', 'looks good');
```

A função é **transacional**: se já existir uma versão ativa para o mesmo
descriptor, ela vira `deprecated` no mesmo passo.

### Rollback (active → rolled_back, reativa anterior)

```ts
await skillsRepo.rollback(skill_id, 'too aggressive', 'admin@maia');
```

A versão anterior (v-1) é reativada **automaticamente** se estava em
`deprecated`. Sem versão anterior, não há reativação — o sistema fica sem
skill ativa para o descriptor.

### Executar uma skill em runtime

```ts
import { runSkill } from '@/skills/skill-runner.js';

const result = await runSkill({
  skill_descriptor: 'detect_legal_risk',
  input: { msg: 'O contrato menciona penalidade por atraso' },
  triggered_by: 'user_message',
  conversa_id: 'conv-123',
  turno_id: 'turn-456',
});
// result.ok=true → result.output = { risk_level: 'medium', confidence: 0.78 }
// result.ok=false → result.reason in
//   'flag_off' | 'skill_not_found' | 'invalid_input' | 'policy_blocked' |
//   'invalid_output' | 'executor_error' | 'timeout'
```

---

## Troubleshooting

### `result.reason === 'flag_off'`

`FEATURE_SKILL_REGISTRY_V1` está OFF. Set no env.

### `result.reason === 'skill_not_found'`

Não existe skill ativa com o descriptor + tenant_id correntes. Verifique:

```sql
SELECT id, status, version FROM skills
 WHERE tenant_id = $1 AND skill_descriptor = $2;
```

Se a skill estava ativa ontem, alguém pode ter feito rollback ou ativado uma
v+1 sem a v atual ainda estar pronta.

### `result.reason === 'invalid_input'`

`result.message` contém os erros do schema. Em produção, o gate falha cedo
sem custo LLM. O input do caller não bate com `skill.input_schema` declarado.

### `result.reason === 'policy_blocked'`

Algum `policy_descriptor` da skill resolveu para `effect=block`. `result.message`
contém o motivo. Verifique:

- A descrição do policy resolvido em `policy_descriptors`
- Em P8e (PR #93), o evaluador de policy conferirá; até lá, o stub apenas
  retorna `unresolved` para tudo (allow por padrão).

### `result.reason === 'invalid_output'`

A saída do mode handler não bate com `skill.output_schema`. Provavelmente o LLM
mudou o formato (após upgrade de modelo) ou o schema está mais estrito do que
o necessário. Verifique:

```bash
npm test -- tests/unit/skills/skill-runner.spec.ts -t "invalid_output"
```

### `result.reason === 'timeout'`

Execução excedeu `runtime_hints.timeout_ms` (default 30s). Possíveis causas:

- LLM lento (rede, modelo carregado)
- Tool dispatcher demorou
- `max_tool_calls` em mode `tool_mediated` muito alto

Tune `runtime_hints` na skill via Admin UI.

### `result.reason === 'executor_error'`

`result.message` contém o erro original. Para `prompt_only`, geralmente é JSON
inválido na resposta do LLM. Para `procedure_adapter`, é falta de
`procedure_definition_id` ou descriptor não encontrado. Para `tool_mediated`,
pode ser `tool_dispatcher_not_configured` (chame
`setToolDispatcher()` no boot).

---

## Convenções de código

- `src/control-plane/skill-registry/` é a **Source of Truth offline + Admin UI** —
  apenas operações de governança (propose, activate, rollback). Não importa
  o runtime.
- `src/skills/` é o **runtime executor + slice builder** — apenas consome o
  skillsRepo, nunca escreve nele (exceto via callbacks para proposer).
- `tenant_id` em `skills` é TEXT (slug, padrão Maia atual). Master spec menciona
  UUID; alinhamento em P11.
- `agent_id NULL` = skill tenant-wide; `agent_id != NULL` = skill específica do
  agente.

---

## Rollout & rollback

### Rollout

1. Aplicar migrations 036 + 037 em ambiente
2. Verificar: `bash scripts/p9a-acceptance-gates.sh` → todos os gates verdes
3. Setar `FEATURE_SKILL_REGISTRY_V1=true` no canary
4. Após 7 dias estável, ativar em produção

### Rollback runtime (sem reverter migrations)

```bash
unset FEATURE_SKILL_REGISTRY_V1   # ou setar 'false'
# restart workers
```

`runSkill` retorna `flag_off` em todos os calls; nada quebra.

### Rollback de migrations

```bash
psql "$DATABASE_URL" -f migrations/037_p9a_extend_capability_proposal_type_down.sql
psql "$DATABASE_URL" -f migrations/036_p9a_skills_down.sql
```

A `down` de 037 restaura o CHECK antigo de `capability_type` — atenção: se
houver `capability_proposals.capability_type='skill'` no banco, o `down` falhará
até esses registros serem removidos.

---

## Testes

- **Unit:** `tests/unit/skills/` (~75 testes — schema, repo, runner, modes,
  slice, proposer)
- **Integration:** `tests/integration/p9a-skill-lifecycle.spec.ts` (6 cenários
  end-to-end mockados)
- **Acceptance gates:** `scripts/p9a-acceptance-gates.sh` (18 gates)

```bash
npx vitest run tests/unit/skills/
npx vitest run tests/integration/p9a-skill-lifecycle.spec.ts
bash scripts/p9a-acceptance-gates.sh
```

---

## Dependências futuras

- **P8e PolicyDescriptorResolver (PR #93):** o stub atual em
  `src/control-plane/policy/policy-descriptor-resolver.ts` apenas marca
  descriptors como `unresolved`. Quando P8e for mergeado, substituir o
  conteúdo pelo evaluador real (mesma forma de `resolveDescriptors`).
- **P8a Context Packet (PR #96):** o tipo `SkillSlice` é definido localmente
  em `src/skills/types.ts`. Pode ser substituído pelo tipo canônico do P8a
  quando o PR for mergeado.
- **P9b Decision Engine:** vai consumir `SkillSlice` do builder e disparar
  `runSkill` com routing decisions.
- **Admin UI Telas 1-3 (P9a Phase 4):** Proposal Inbox / Diff & Approval /
  Version History — placeholders previstos no plano; implementação real em
  P10/P11 (post Admin UI v1 do P8.5).

---

## Architecture locks (não alterar sem aprovação do founder)

1. **Skill nunca nasce active** — DEFAULT 'proposed' + partial unique "one
   active". Mudança de estado só por governança (skillsRepo.activate).
2. **Executor estável, contrato declarativo** — lógica de execução só muda por
   PR de código (4 modes em `src/skills/modes/`); contrato muda por approval no
   Admin UI.
3. **runCognitiveModule wrapper obrigatório** — toda execução de skill audita
   em `cognitive_module_log` (P1 invariant). Bypass = bug.
4. **Tenant guard implícito** — todo método do skillsRepo lê
   `getCurrentTenant()`; chamadas fora de `runWithTenantContext` lançam
   `MissingTenantContextError`.

---

**Owner:** Founder + plataforma. **Última atualização:** 2026-05-15.
