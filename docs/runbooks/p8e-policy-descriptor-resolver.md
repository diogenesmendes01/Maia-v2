# Runbook — P8e PolicyDescriptorResolver

> Como operar, propor, ativar, deprecar e rollback de policies em runtime, ate o Admin UI (P8.5) ficar pronto. O resolver e a unica forma autorizada de mapear `string descriptor -> active (policy_id, version)` nos 6 call sites (master spec §0.3, §2.2).

## O que e P8e

P8e cria a **Source of Truth versionada** para regras de governanca (`policy_rules`) e o **resolver unico** (`PolicyDescriptorResolver`) que todos os call sites do hot path usam para consultar quais policies estao ativas para um conjunto de descriptors.

Componentes:

- 2 migrations:
  - `036_p8e_policy_rules.sql` — tabela com DEFAULT 'proposed', partial unique 'one active', constraints de sanidade.
  - `037_p8e_seed_default_hard_limits.sql` — 5 policies seed (4 hard_limit + 1 lockdown_trigger) para tenant=default.
- Modulo `src/control-plane/policy/`:
  - `types.ts` — `PolicyRule`, `PolicyRuleKind`, `PolicyRuleStatus`, `PolicySourceOfTruth`, `PolicyRuleScope`, `ResolvedPolicy`, eventos de lifecycle.
  - `policy-rules-repo.ts` — 9 metodos (read + write side). Tenant guard em todas as escritas. Eventos publicados em Redis pub/sub.
  - `policy-cache.ts` — TTL 5min + LRU 10k + negative cache + subscriber Redis para invalidacao.
  - `policy-descriptor-resolver.ts` — loop por descriptor: cache -> repo -> scope filter -> cache write.
  - `index.ts` — barrel export.
- Feature flag `FEATURE_POLICY_RESOLVER_V1` (default OFF).
- 1 script de seed programatico (`scripts/p8e-seed-policies.ts`) e 1 script de acceptance gates (`scripts/p8e-acceptance-gates.sh`).

## O que P8e NAO faz (limites explicitos)

- **Nao avalia `rule_body`** — em P8e e JSONB opaco. P9d entrega o avaliador de DSL/AST.
- **Nao bloqueia turnos** — nao e um PEP. Apenas resolve "qual policy_id esta active para esse descriptor?". Os PEPs (P9b/d) consomem o resultado.
- **Nao auto-ativa `rule_kind='hard_limit'`** — invariante master §0.2. Activate de hard_limit exige `dual_approval_evidence`; runtime real de dual approval (2 aprovadores distintos do Admin UI) chega em P8.5.
- **Nao popula 100% das policies** — apenas 5 hard_limit/lockdown_trigger seed para tenant default. Tenants reais vao propor suas proprias policies via Admin UI (P8.5).

## Dependencias

P8e depende de P0/P1/P2/P3/P4/P5/P6/P7 ja aplicados:

- P0: tenants, agents, tenant-guard, getCurrentTenant/Agent. As FKs `policy_rules.tenant_id -> tenants(id)` e `agent_id -> agents(id)` (nullable) sao enforced.
- P4: padrao de partial unique index + state machine para Source of Truth versionada (P8e replica o padrao).
- Redis (lib `src/lib/redis.ts`) para pub/sub de invalidacao de cache.

## Architecture Lock

`src/control-plane/policy/` vive no Control Plane. **NAO pode ser importado direto** por codigo em `src/agent/` ou `src/cognition/`. Os 6 call sites do hot path consomem via:

- `policy-slice-builder.ts` (P8d) — para o Context Packet.
- Early/Mid/Late PEP (P9b/d) — para o Decision Engine.
- Trace writer (P10) — para auditoria de policy_id + version aplicados.

A gate 4 do acceptance script falha se algum import direto vazar para `src/agent/` ou `src/cognition/`.

## Feature flag

`FEATURE_POLICY_RESOLVER_V1` (default OFF). Ativar:

```env
FEATURE_POLICY_RESOLVER_V1=true
```

P8e em si **nao consulta a flag**. O resolver sempre funciona quando importado. Quem consulta a flag:

- `policy-slice-builder.ts` (P8d): com OFF, retorna PolicySlice vazio.
- PEPs (P9b/d): com OFF, fazem fast-path "block nothing" (modo permissivo legacy).
- Admin UI (P8.5): com OFF, esconde a tela de policy management.

Kill switch (emergencia): `featureFlags.killSwitch(FeatureFlagName.POLICY_RESOLVER_V1)` forca `false` independente de override / config.

## Cache TTL e LRU

Configuraveis via env:

```env
POLICY_RESOLVER_CACHE_TTL_MS=300000     # default 5min
POLICY_RESOLVER_CACHE_MAX_ENTRIES=10000 # default 10k
```

Invalidacao por evento Redis pub/sub no canal **per-tenant**
`policy_rule_lifecycle:{tenant_id}` (issue #249 round-2):

| Evento | Origem | Acao no cache |
|---|---|---|
| `policy_rule_activated` | `repo.activate()` ok | Remove entries do `{tenant, agent, descriptor}` |
| `policy_rule_deprecated` | `repo.deprecate()` ok | Idem |
| `policy_rule_rolled_back` | `repo.rollback()` ok | Idem |
| (TTL natural) | `Date.now() > expireAt` | Tratado como miss; re-fetch + re-cache |

**Subscriber lifecycle (lazy per-tenant SUBSCRIBE):** ao boot o subscriber conecta no Redis
SEM nenhuma subscription ativa. Na primeira escrita do cache para um tenant (`set` ou
`setUnresolved`), o hook `onTenantTouched(tenant_id)` dispara `SUBSCRIBE policy_rule_lifecycle:<tenant_id>`
exatamente uma vez por (processo, tenant). Isso garante que o BROKER soh entrega eventos
dos tenants que este processo de fato cacheia — substitui o antigo `PSUBSCRIBE
policy_rule_lifecycle:*` que recebia eventos cross-tenant e dependia do handler para filtrar.

Se Redis cai: TTL natural (5min) bound a janela de staleness. Workers e API continuam servindo do cache local. Master §11 risco "cache stale".

## Como propor / ativar / deprecar / rollback policies (sem Admin UI)

Ate o P8.5 ficar pronto, operadores usam o repo direto.

### Propor uma nova policy

```typescript
import { policyRulesRepo } from '@/control-plane/policy';
import { runWithTenantContext } from '@/db/tenant-context';

await runWithTenantContext(
  { tenant_id: 'tenant-x', agent_id: 'default' },
  async () => {
    const proposed = await policyRulesRepo.propose({
      agent_id: null, // tenant-wide (use agent_id-specific overrides quando necessario)
      rule_kind: 'soft_guidance', // hard_limit | dual_approval | lockdown_trigger
      rule_descriptor: 'no_send_after_22h',
      rule_body: {
        predicate: { all: [/* DSL P9d */] },
        effect: { action: 'block', severity: 'medium' },
      },
      scope: { channel: 'whatsapp' },
      source_of_truth: 'founder_explicit',
      proposed_by: 'op@example.com',
      proposed_reason: 'Politica de horario noturno',
    });
    // proposed.status === 'proposed' (sempre)
    console.log(`proposed v${proposed.version} id=${proposed.id}`);
  },
);
```

### Ativar uma policy proposed

```typescript
const now = new Date().toISOString();
const result = await policyRulesRepo.activate({
  id: proposed.id,
  approved_by: 'executor@example.com',
  // hard_limit + lockdown_trigger OBRIGAM dual_approval_evidence STRUCTURED;
  // outros kinds podem omitir. Post review #93: o shape antigo
  // `{ second_approver: ... }` NAO funciona mais — rejeitado com
  // reason='invalid_dual_approval_evidence'.
  dual_approval_evidence: {
    approvers: ['owner@example.com', 'compliance@example.com'],
    approved_at: [now, now],
    context: { ticket_id: 'INC-1234' }, // opcional
  },
});

if (!result.ok) {
  // reason: 'not_found' | 'invalid_transition' | 'already_has_active'
  //       | 'hard_limit_requires_dual_approval'
  //       | 'invalid_dual_approval_evidence'  // NEW post review #93
  console.error(`activate failed: ${result.reason}`);
} else {
  console.log(`active v${result.updated.version}`);
}
```

**Regras de dual_approval_evidence (post review #93):**

- `approvers`: array com >= 2 IDs distintos, todos non-empty.
- `approved_at`: array paralelo de ISO-8601 timestamps (1 por approver).
- `approved_by` (executor) NAO pode ser um dos `approvers` (separation of duties).
- Aplica-se a `rule_kind = 'hard_limit'` E `'lockdown_trigger'`. O kill-switch global agora tem a mesma defesa.
- Helper exportado: `isValidDualApprovalEvidence(ev): ev is DualApprovalEvidence`.

**Importante:** apenas 1 active simultaneo por `(tenant, agent_or_wide, descriptor)`. Se ja existe um active, `activate()` retorna `reason='already_has_active'`. Para substituir, deprecate o ativo antes.

### Deprecar a versao active corrente

```typescript
const result = await policyRulesRepo.deprecate({
  id: activeId,
  deprecated_by: 'op@example.com',
});
// result.ok=true frees o slot do descriptor para uma nova versao active.
```

### Rollback

`rollback()` aceita qualquer status nao-terminal e gravita para terminal `rolled_back`. Use quando uma policy proposed/active causou incidente:

```typescript
const result = await policyRulesRepo.rollback({
  id: anyId,
  rolled_back_by: 'incident-response@example.com',
  rollback_reason: 'caused 5% block rate spike, INC-5678',
});
```

`rollback` ja invalida o cache. Cache local em outras instancias recebe o evento Redis e tambem invalida.

### Substituir uma versao active por uma nova (propose + activate)

Padrao seguro: deprecate o ativo PRIMEIRO, depois propose+activate o novo:

```typescript
await policyRulesRepo.deprecate({ id: activeId, deprecated_by: 'op' });
const next = await policyRulesRepo.propose({/* ... */});
await policyRulesRepo.activate({
  id: next.id,
  approved_by: 'compliance',
  dual_approval_evidence: {/* se hard_limit */},
});
```

## Como rodar o seed inicial

Duas opcoes:

### Opcao 1 — migrations (recomendado, ja roda em CI/prod)

```bash
npm run db:migrate
# Aplica 036_p8e_policy_rules.sql + 037_p8e_seed_default_hard_limits.sql.
# Idempotente: re-run nao duplica via NOT EXISTS guard.
```

### Opcao 2 — script programatico (dev / re-seed sem migration)

```bash
tsx scripts/p8e-seed-policies.ts
# Usa repo.propose() + repo.activate(). Idempotente via findActiveByDescriptor.
# Post review #93: o script usa 2 principals sinteticos
# (seed_owner_bootstrap, seed_compliance_bootstrap), com executor
# distinto (p8e_seed_executor). O shape antigo
# `{ script_bootstrap: true }` foi rejeitado pelo novo guard.
```

## Como o resolver funciona

`PolicyDescriptorResolver.resolveDescriptors({tenant_id, agent_id?, descriptors, scope?})` retorna `{resolved: ResolvedPolicy[], unresolved: string[], failures: UnresolvedDescriptor[]}`:

1. Para cada descriptor, tenta cache (`tenant|agent|descriptor|scope` key).
2. Hit positive → empurra para `resolved`. Hit negative (`'unresolved'`) → empurra para `unresolved` + `failures` com `reason='not_found'`.
3. Miss → bate em `repo.findActiveByDescriptor()`. Precedencia: agent_id-specific antes de tenant-wide.
4. Aplica `matchesScope(rule.scope, input.scope)`:
   - Rule scope `{}` (vazio) → universal (match any input).
   - Rule scope set → todas as keys de rule.scope precisam casar com input.scope.
   - Mismatch → `failures` com `reason='scope_mismatch'`.
5. Escreve no cache (positive ou `'unresolved'`). **Excecao:** `db_error` NAO e cacheado (transient outage nao deve fixar "no policy" por ttl_ms).

**Invariante:** `resolved.length + unresolved.length === input.descriptors.length === resolved.length + failures.length`.

### Contrato fail-closed (post review #93)

O resolver distingue 4 motivos de falha (`ResolverFailureReason`):

| reason | Quando | Caller MUST block? |
|---|---|---|
| `not_found` | Nenhuma row active para o descriptor | NAO (caller decide pelo descriptor) |
| `scope_mismatch` | Row existe, mas scope nao bate | NAO |
| `db_error` | Repo lancou exception (DB outage, etc) | **SIM** (RESOLVER_FAILURE_DEFAULT='block') |
| `tenant_mismatch` | input.tenant_id != active tenant context | **SIM** (programmer error) |

Helper exportado:

```typescript
import { hasBlockingFailure, RESOLVER_FAILURE_DEFAULT } from '@/control-plane/policy';

const out = await resolver.resolveDescriptors({...});
if (hasBlockingFailure(out)) {
  // RESOLVER_FAILURE_DEFAULT === 'block' — caller MUST default to BLOCK.
  // Nunca auto-allow nesse caminho.
  return { decision: 'block', reason: 'policy_store_unavailable' };
}
```

A constante `RESOLVER_FAILURE_DEFAULT` esta pinada como `'block'` por teste de unidade — qualquer flip dispara falha em CI.

## Acceptance gates

Antes de mergear qualquer PR que mude `policy_rules` ou o resolver, rode:

```bash
bash scripts/p8e-acceptance-gates.sh
```

10 gates obrigatorios:

1. Migrations 036+037 (UP + DOWN) + DEFAULT 'proposed' + one-active partial unique.
2. Seed inclui as 5 descriptors esperados + NOT EXISTS idempotency.
3. vitest passa para todas as 4 policy specs.
4. Architecture Lock: zero imports de `@/control-plane/policy/` em `src/agent/` ou `src/cognition/`. Tambem enforced como regra ESLint `no-restricted-imports` (`eslint.config.js`).
5. `FEATURE_POLICY_RESOLVER_V1` registrada + default off.
6. `rule_body` opacity: sem `PolicyPredicate.evaluate` em P8e.
7. Os 9 metodos do repo presentes.
8. (Post review #93) Resolver fail-closed: `RESOLVER_FAILURE_DEFAULT='block'` + `reason='db_error'` + log estruturado.
9. (Post review #93) Cache invalidation subscriber wired em `src/index.ts` (gated na flag).
10. (Post review #93) Structured `DualApprovalEvidence` + DB CHECK `policy_rules_active_requires_approval`.

## Troubleshooting

### Resolver sempre retorna `unresolved`

- Confira que a flag esta ligada NO CALLER (slice builder / PEP). P8e em si nao depende da flag.
- Confira que a migration 036 + 037 rodou. `SELECT COUNT(*) FROM policy_rules WHERE status='active' AND tenant_id='default'` deve retornar 5.
- Confira o scope: a policy `no_action_outside_business_hours_high_risk` tem `scope={"channel":"whatsapp"}`. Sem `input.scope.channel='whatsapp'` o resolver descarta como unresolved.

### `activate` retorna `already_has_active`

- Significa que o partial unique index `idx_policy_rules_one_active_uq` blocked o segundo active simultaneo. Deprecate o ativo corrente antes ou rollback o novo.

### `activate` para hard_limit retorna `hard_limit_requires_dual_approval` ou `invalid_dual_approval_evidence`

- `hard_limit_requires_dual_approval`: nenhum `dual_approval_evidence` passou. Passe um objeto valido.
- `invalid_dual_approval_evidence` (post review #93): o shape e invalido. Confira:
  - `approvers: string[]` com >= 2 ids distintos non-empty
  - `approved_at: string[]` paralelo, todos ISO-8601 parseaveis
  - `approved_by` (executor) NAO esta em `approvers` (separation of duties)
- Mesmo guard aplica a `rule_kind='lockdown_trigger'` (kill-switch global).

### Cache stale apos `activate` em multi-instancia

- Confira que Redis pub/sub esta funcionando (`redis-cli MONITOR | grep policy_rule_lifecycle`).
  Espera-se mensagens em `policy_rule_lifecycle:<tenant_id>` (issue #249 — canal per-tenant).
- Verifique que o subscriber deste processo deu `SUBSCRIBE` no canal do tenant em questao.
  No log procure por `policy_cache.tenant_channel_subscribed_issue_249` apos a primeira
  escrita do cache para esse tenant. Se nao aparecer, o cache nunca cacheou nada desse
  tenant (lazy subscribe). Force uma resolucao para acionar a inscricao.
- TTL natural de 5min limita a janela. Para forcar invalidacao global imediata, faca `policyResolverCache.invalidateAll()` em cada instancia (kill switch local).
- P9d adicionara read-after-write strict mode para hard_limit.

### Migration 036 falha em DB com schema parcial

- Confira que `tenants` e `agents` (P0, migrations 007+) ja foram aplicadas. As FKs `tenant_id REFERENCES tenants(id)` e `agent_id REFERENCES agents(id)` sao requisitos.

## Rollback de emergencia

### Rollback do schema (migration 036/037 down)

Em ordem reversa:

```bash
psql -f migrations/037_p8e_seed_default_hard_limits_down.sql  # DELETE 5 seed rows
psql -f migrations/036_p8e_policy_rules_down.sql              # DROP table + indexes
```

### Kill switch do feature flag

```typescript
import { featureFlags } from '@/config/feature-flags';
import { FeatureFlagName } from '@/types/enums';

featureFlags.killSwitch(FeatureFlagName.POLICY_RESOLVER_V1);
```

Forca callers (slice builder, PEPs, Admin UI) a fall-back para o comportamento legacy. Resolver continua funcional mas nao e consumido.

## Master spec touchpoints

- §0.3: 6 call sites do resolver.
- §2.1: schema do `policy_rules` (P8e implementa verbatim).
- §2.2: interface `PolicyDescriptorResolver` (P8e implementa verbatim).
- §3.3: cache TTL 5-10min (P8e usa 5min default).
- §6: cache implementation + invalidation events.
- §15 invariantes #5 (DEFAULT 'proposed'), #6 (partial unique 'one active'), #13 (audit policy_id+version no trace).
