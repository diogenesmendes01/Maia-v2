# P8c User Layer — Runbook

## Overview

P8c entrega o **namespace `user-layer`** (`src/user-layer/`): uma fachada
estruturada sobre os dados de usuário (memórias, fatos, regras, hints) com
separação `internal/` vs `resolvers/` e boundary de tenant fail-closed.

**Problema que resolve:** antes de P8c, slice builders chamavam repos
diretamente sem enforcement de isolamento de agent; um agente B no mesmo
tenant podia ler memórias do agente A. P8c fecha esse vetor via
`enforceTenantBoundary` e predicados `(tenant_id, agent_id)` em todos os
resolvers.

**Sempre ligado — sem feature flag.** P8c é estrutural: o namespace existir
ou não existir é tudo ou nada. Não há rollback granular por flag.

## Arquivos relevantes

- `src/user-layer/internal/tenant-boundary.ts` — `enforceTenantBoundary`,
  `MissingTenantContextError`, `TenantBoundaryViolation`
- `src/user-layer/resolvers/memory-resolver.ts` — facade sobre `memory_entry`
- `src/user-layer/resolvers/facts-resolver.ts` — facade sobre `agent_facts`
- `src/user-layer/resolvers/rules-resolver.ts` — facade sobre `learned_rules`
- `src/user-layer/resolvers/hints-resolver.ts` — facade sobre `behavioral_hint`
- `src/cognition/persister.ts` — persiste `lifecycle_transitions` como JSONB `[]`
- `migrations/041_p8c_lifecycle_status.sql` — colunas KSM nas 4 tabelas

## Boundary fail-closed

`enforceTenantBoundary` é o único chokepoint que todos os slice builders
DEVEM chamar na entrada. Comportamento:

| Situação | Resultado |
|---|---|
| ALS context ausente (sem `runWithTenantContext`) | lança `MissingTenantContextError` |
| `input.tenant_id` ≠ `ctx.tenant_id` | lança `TenantBoundaryViolation` |
| `input.agent_id` passado e ≠ `ctx.agent_id` | lança `TenantBoundaryViolation` |
| Tudo confere | retorna `{ tenant_id, agent_id }` efetivos do ALS |

Não existe "bootstrap path" silencioso. Callers fora de um contexto ALS
(admin, worker fan-out) DEVEM envolver cada chamada em
`runWithTenantContext({ tenant_id, agent_id })`, um por tenant.

## Resolvers — predicados SQL obrigatórios

Cada resolver exige **ambos** os predicados quando `agent_id` é fornecido.
Nunca filtre apenas por `tenant_id`:

| Resolver | Tabela | Predicado agent |
|---|---|---|
| `memoryResolver.list` | `memory_entry` | `eq(memory_entry.agent_id, agent_id)` |
| `factsResolver.list` | `agent_facts` | `AND af.agent_id = $agent_id` (SQL raw) |
| `rulesResolver.list` | `learned_rules` | `eq(learned_rules.agent_id, agent_id)` |
| `hintsResolver.list` | `behavioral_hint` | predicado equivalente |

O `agent_id` passado ao resolver DEVE ser o retornado por
`enforceTenantBoundary`, nunca o `agent_id` bruto do input do caller.

## JSONB lifecycle_transitions — formato correto

`lifecycle_transitions` é uma coluna JSONB com CHECK
`jsonb_typeof(lifecycle_transitions) = 'array'`. O valor persistido deve
ser um array JS nativo passado ao Drizzle — **nunca** `JSON.stringify([])`:

```ts
// CORRETO — Drizzle serializa para JSONB
lifecycle_transitions: []

// ERRADO — cria string JSON, não JSONB array; quebra no CHECK
lifecycle_transitions: JSON.stringify([])
```

O persister (`src/cognition/persister.ts`) deixa as colunas de lifecycle
para o DEFAULT do banco na criação (`'[]'::jsonb`). Atualizações
subsequentes (P10a KSM) também devem passar arrays nativos.

## Invariantes

1. `enforceTenantBoundary` lança `MissingTenantContextError` quando ALS
   ausente. Não existe fallback silencioso ou caller-supplied tenant_id.
2. Resolvers SEMPRE filtram por `(tenant_id, agent_id)` — nunca apenas
   `tenant_id`. Omitir `agent_id` desabilita o filtro de agente (restrito
   a paths admin explicitamente privilegiados).
3. `lifecycle_transitions` persiste como JSONB array `[]`, nunca como
   string. O CHECK `jsonb_typeof = 'array'` rejeita qualquer outro formato
   no banco.

## Troubleshooting

### "Agente B vê fatos/memórias do agente A no mesmo tenant"

1. Verificar se o resolver recebeu `agent_id` (retorno de
   `enforceTenantBoundary`). Se `agent_id` for `undefined`, o filtro de
   agente é omitido — o slice builder está com bug.
2. Confirmar que o SQL gerado inclui tanto `tenant_id` quanto `agent_id`.
   Em `facts-resolver` (raw SQL), procurar `AND af.agent_id = $agent_id`.
3. Verificar que `enforceTenantBoundary` foi chamado na entrada do builder,
   não depois da query.

### "MissingTenantContextError inesperado"

O callsite não está dentro de `runWithTenantContext`. Verificar a pilha de
chamadas; o error sempre indica que o ALS (`AsyncLocalStorage`) estava vazio.
Workers/admins devem envolver cada operação de tenant em um
`runWithTenantContext` separado.

### "TenantBoundaryViolation: input.tenant_id does not match context"

O caller passou `tenant_id` diferente do que está no ALS. Em fan-out de
tenant, criar um `runWithTenantContext` por tenant — não reutilizar o mesmo
contexto com tenant_ids diferentes.

### "INSERT failed CHECK jsonb_typeof = 'array'"

Outro callsite está passando `JSON.stringify([])` (string) em vez de `[]`
(array). Buscar no código por `JSON.stringify` combinado com campos de
lifecycle (memória, fatos, regras, hints).

### p95 lento no slice de user/knowledge

Verificar índices `idx_memory_entry_tenant_lifecycle`,
`idx_agent_facts_tenant_lifecycle`, `idx_learned_rules_tenant_lifecycle`,
`idx_behavioral_hint_tenant_lifecycle` — todos partial indexes em lifecycle
ativo. Confirmar que as queries usam esses índices via `EXPLAIN`.

## Testes críticos

- `tests/unit/user-layer/tenant-boundary.spec.ts` — 14 testes; cobre
  fail-closed (sem ALS), violation de tenant, violation de agent, path feliz
- `tests/unit/user-layer/rules-resolver.spec.ts` — 14 testes (resolvers)
- `tests/unit/user-layer/knowledge-slice-builder.spec.ts` — 21 testes
- `tests/unit/user-layer/user-slice-builder.spec.ts` — 22 testes
- `tests/unit/user-layer/cross-tenant-isolation.spec.ts` — 45 testes de
  isolamento cross-tenant

## Migrations

**`migrations/041_p8c_lifecycle_status.sql`** — adiciona colunas KSM às 4
tabelas de user-layer: `lifecycle_status`, `evidence_count`, `confidence`,
`lifecycle_transitions`. DEFAULT `'active'` preserva backward compat. CHECK
`jsonb_typeof = 'array'` protege contra double-stringify.

### Rollback — DESTRUTIVO e BLOQUEADO após P10a (migration 050)

> **PARE ANTES DE CONTINUAR.** O script abaixo dropa colunas de lifecycle
> (`lifecycle_status`, `evidence_count`, `confidence`, `lifecycle_transitions`)
> de todas as 4 tabelas de user-layer. Se a migration `050_p10a_ksm_lifecycle_and_indexes`
> já foi aplicada neste ambiente, essas colunas contêm histórico de transições
> KSM e scores de risco gravados pelo P10a. Dropar sem coordenação **destrói
> esse histórico e quebra leituras/escritas KSM**.

**Pré-condições obrigatórias — verifique todas antes de rodar qualquer DROP:**

> **Forma da tabela `schema_migrations`:** a coluna é `id TEXT PRIMARY KEY`
> e contém o **nome completo do arquivo** (ex:
> `050_p10a_ksm_lifecycle_and_indexes.sql`). Não existe coluna `version` nem
> chave numérica curta.

1. **Confirmar se P10a (050 + 051) foi aplicado.**
   ```sql
   SELECT id FROM schema_migrations
   WHERE id IN (
     '050_p10a_ksm_lifecycle_and_indexes.sql',
     '051_p10a_enforce_lifecycle_transition.sql'
   );
   ```
   - Se retornar 1 ou 2 linhas: **P10a está aplicado. Siga o fluxo coordenado abaixo.**
   - Se não retornar linhas: você pode prosseguir direto para o passo 3.

2. **Fluxo coordenado (P10a aplicado):**
   a. Faça rollback de P10a em **ordem reversa** (051 primeiro, depois 050):
      ```bash
      psql -v ON_ERROR_STOP=1 $DATABASE_URL \
        -f migrations/051_p10a_enforce_lifecycle_transition_down.sql
      psql -v ON_ERROR_STOP=1 $DATABASE_URL \
        -f migrations/050_p10a_ksm_lifecycle_and_indexes_down.sql
      ```
   b. Remova os registros de `schema_migrations` para que um futuro
      `npm run db:migrate` os re-aplique corretamente:
      ```sql
      DELETE FROM schema_migrations
      WHERE id IN (
        '051_p10a_enforce_lifecycle_transition.sql',
        '050_p10a_ksm_lifecycle_and_indexes.sql'
      );
      ```
      Confirme que 0 linhas permanecem:
      ```sql
      SELECT id FROM schema_migrations
      WHERE id IN (
        '050_p10a_ksm_lifecycle_and_indexes.sql',
        '051_p10a_enforce_lifecycle_transition.sql'
      );
      -- deve retornar 0 linhas
      ```
   c. **Exporte backup das colunas de lifecycle antes de dropar:**
      ```sql
      \COPY (
        SELECT id, lifecycle_status, evidence_count, confidence, lifecycle_transitions
        FROM memory_entry
      ) TO 'backup_memory_entry_lifecycle.csv' CSV HEADER;
      -- Repetir para agent_facts, learned_rules, behavioral_hint
      ```
   d. Guarde os CSVs em local seguro. Eles são o único ponto de recuperação.

3. **Rodar o down-script P8c (somente após as pré-condições acima):**
   ```bash
   psql $DATABASE_URL -f migrations/041_p8c_lifecycle_status_down.sql
   ```
   O script é idempotente (`DROP COLUMN IF EXISTS`); pode ser re-executado
   com segurança se interrompido.

4. **Plano de reparo se dados forem necessários novamente:**
   Re-apply P8c forward → re-apply P10a forward → restaure os CSVs via
   `COPY ... FROM`. Não há replay automático de transições históricas;
   o KSM reconstruirá scores a partir das próximas escritas.

Nota de numeração: o issue menciona `037_p8c_*` mas a migration real que
aterrou é `041_p8c_lifecycle_status.sql` (numeração coordenada em review
2026-05-15 após colisão com P8b/P8e).

## Rollout

Sem flag. P8c aterrou diretamente via PR #94 round-2. A falha é fail-closed
(MissingTenantContextError), não fail-open, portanto não há risco de
rollout gradual: ou o contexto ALS existe e a chamada passa, ou não existe
e falha ruidosamente para o caller consertar.

## Próximas integrações

- **P10a** — KSM lifecycle transitions: as colunas `lifecycle_transitions`
  adicionadas aqui serão preenchidas pelas transições reais (promoted,
  deprecated, etc.).
- **P8a** — user-slice-builder consome `memoryResolver` e
  `hintsResolver` via este namespace.

## Known issues

Nenhum ativo.
