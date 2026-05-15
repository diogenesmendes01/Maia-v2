# Runbook — P3a Procedures: Definição + Modo ENSINO

> Como criar/inspecionar/aprovar procedimentos na Maia v2.

## Quando usar

- Owner quer ensinar procedimento novo
- Inspecionar drafts pendentes de aprovação
- Aprovar/rejeitar/rollback de procedure
- Worker `procedure_candidate_consumer` falhando

## Estrutura

```
procedure_definitions (versionado, imutável quando active)
  ├── draft (criado por ENSINO ou consumer worker)
  ├── proposed (owner propôs pra aprovação)
  ├── active (aprovado, em uso)
  ├── frozen (active mas pausado — drift detector ou unfreeze manual)
  └── rolled_back (terminal — versão anterior pode estar ativa)

procedure_assignments
  └── Vincula definitions ativas a agents/roles com customizations
```

## Modo ENSINO — criar procedure manualmente

> **Nota (P83-L4):** o uso de `tenant_id: 'default'` / `agent_id: 'default'` nos
> exemplos abaixo é um **shim do P0** — útil em scripts manuais e em ambientes
> single-tenant. A partir do P6 (fan-out multi-tenant) toda chamada deve passar
> os identificadores reais do tenant/agent do owner. Não copie este padrão para
> código de produção que rode com múltiplos tenants.

```typescript
import { teachProcedure } from '@/cognition/procedure-builder.js';
import { procedureDefinitionsRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
  const draft = await teachProcedure({
    nome: 'qualificar-lead-ingles-adulto',
    descricao_livre: 'Quando entra lead novo de inglês adulto, primeiro descobre motivo real...',
    scope: 'tenant',
  });

  if (draft) {
    await procedureDefinitionsRepo.create({
      ...draft,
      version_number: 1,
      status: 'draft',
      proposed_by: null,
      approved_by: null,
    });
  }
});
```

## Inspecionar drafts pendentes

```sql
SELECT id, nome, version_number, intencao, created_at
FROM procedure_definitions
WHERE status = 'draft'
ORDER BY created_at DESC;
```

## Aprovar draft → proposed → active

```typescript
import { procedureDefinitionsRepo } from '@/db/repositories.js';
import { transitionProcedureStatus } from '@/cognition/procedure-status.js';

const draft = await procedureDefinitionsRepo.findById('uuid-here');
await transitionProcedureStatus({ definition: draft, to: 'proposed', actor: 'owner-email' });

const proposed = await procedureDefinitionsRepo.findById('uuid-here');
await transitionProcedureStatus({ definition: proposed, to: 'active', actor: 'owner-email' });
```

Ao ativar, versão anterior (mesmo nome) é automaticamente movida pra `frozen`.

## Rollback de procedure

```typescript
const active = await procedureDefinitionsRepo.findActiveByName('nome-aqui');
await transitionProcedureStatus({ definition: active, to: 'rolled_back', actor: 'owner-email' });

// Pra reativar versão anterior:
const previousVersion = (await procedureDefinitionsRepo.listAllVersionsByName('nome-aqui'))
  .find(d => d.status === 'frozen');
if (previousVersion) {
  await transitionProcedureStatus({ definition: previousVersion, to: 'active', actor: 'owner-email' });
}
```

## Worker `procedure_candidate_consumer`

Cron diário 02h UTC. Consome `cognitive_candidates` tipo `procedimento` (gerados por P1 reflection pipeline) → cria drafts em `procedure_definitions`.

Forçar manualmente:
```typescript
import { runProcedureCandidateConsumer } from '@/workers/procedure-candidate-consumer.js';
await runProcedureCandidateConsumer();
```

## Métricas a observar

- `count(*) WHERE status='draft'` cresce conforme reflection gera candidates
- `count(*) WHERE status='active' GROUP BY nome` — quantos procedimentos únicos ativos
- Latência p95 de `procedure-builder.ensino` em cognitive_module_log
- Worker `procedure_candidate_consumer` last run + drafted/failed counts

## Próximas fases

- **P3b**: execução stateful (procedure_executions, selector, step evaluator)
- **P3c**: métricas + tests + reaper (TTL pra execuções zumbi)

## Validação completa

```bash
bash scripts/p3a-acceptance-gates.sh
```

Se verde:
```bash
git tag p3a-procedures-done
git push origin p3a-procedures-done
```
