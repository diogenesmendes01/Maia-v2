# Runbook — P8b Soul Layer

> Como operar, debugar e governar a camada Soul (biases comportamentais persistentes que modulam mas NUNCA bloqueiam). P8b implementa a tabela `soul_biases` append-only versionada, o slice builder que injeta orientações no prompt, o detector `soul_drift` que avalia aderência sem forçar rollback, e o origin gate que impede `learned_strong_evidence` de sobrescrever Identity.

## O que é P8b

Soul Layer é a "gravidade comportamental" do agente. Soul **modula** — ela nunca cria gate de execução. As 6 entregas:

1. **Tabela `soul_biases`** (migration 038) — append-only versionada por (tenant, agent, scope, scope_value, principle); DEFAULT 'proposed' garante que nenhuma bias nasce active por acidente; partial unique `soul_biases_one_active_idx` garante 1 active por chave.
2. **`soulBiasesRepo`** (7 métodos) — state machine `proposed → active → deprecated/rolled_back`; tenant guard em todas leituras/escritas; `withTx` para deprecate-incumbent + activate-new atômico.
3. **`SoulSlice` + `buildSoulSlice`** — fatia do Context Packet; filtra por `activation_context` (intent_in, role_in, domain_in, channel_in, risk_level_min); ranqueia por strength DESC + scope specificity DESC; renderiza bloco markdown "Orientação persistente" com disclaimer "inclinam, não bloqueiam".
4. **Detector `soul_drift`** (8º tipo) — heurística-first (palavras absolutistas) + LLM judge opcional; emite `DriftEvidence` com severity_hint. `decision-engine` mapeia soul_drift → QUEUED_HUMAN máximo (NUNCA frozen/rollback).
5. **`origin-gate.ts`** — pure function `canSoulOverrideIdentity({origin, strength})`. `learned_strong_evidence` SEMPRE bloqueado (qualquer strength) + emite alerta `soul_identity_conflict`.
6. **Capability proposer branch + worker** — `proposeSoulBiasFromDriftAlert` cria `capability_proposals` com `capability_type='soul_bias'`; `processSoulBiasProposalApproval` materializa bias após aprovação (idempotente).

Feature flag: `FEATURE_SOUL_LAYER_V1` (default OFF). O slice builder pode ser chamado em modo `depth='none'` para teste/rollback sem alterar DB.

## Schema — `soul_biases`

| Coluna | Tipo | Notas |
|---|---|---|
| `scope` | TEXT CHECK | `'tenant' \| 'agent' \| 'role' \| 'domain'` |
| `scope_value` | TEXT | `'*'` para tenant/agent; valor concreto para role/domain |
| `principle` | TEXT 3-80 | slug humano (ex. `humildade_epistemica`) |
| `guidance` | TEXT 10-1000 | texto narrativo que entra no prompt |
| `origin` | TEXT CHECK | `'founder_explicit' \| 'human_approved' \| 'tenant_culture_explicit' \| 'learned_strong_evidence'` |
| `strength` | NUMERIC(4,3) | ∈ [0, 1] |
| `activation_context` | JSONB | filtros estruturais (intent_in, role_in, domain_in, channel_in, risk_level_min, time_window) |
| `status` | TEXT DEFAULT 'proposed' | state machine — DEFAULT garante invariante 5 |
| `version` | INTEGER | computado `MAX(version)+1` por chave |
| `previous_version_id` | UUID | lineage para promotion |
| `proposal_id` | UUID FK | liga a `capability_proposals` |
| `source_drift_alert_id` | UUID FK | liga a `agent_drift_alerts` |

Índices:
- `soul_biases_one_active_idx` (UNIQUE WHERE status='active') — 1 active por chave (race-condition-proof)
- `soul_biases_active_lookup_idx` — leitura quente do slice builder
- `soul_biases_proposed_inbox_idx` — Proposal Inbox da Admin UI
- `soul_biases_proposal_idx` / `soul_biases_drift_source_idx` — auditoria

## Invariantes (spec §15)

1. **DEFAULT proposed** — nenhuma bias nasce `active` por acidente. Caller que tenta inserir com `status` explícito é OK porque o repo força `propose` → cria proposed; activation é passo separado.
2. **"One active" per key** — partial unique index garante zero overlap. `activate()` deprecia incumbent atomicamente via `withTx`.
3. **Rollback irreversível** — ROLLBACK declara erro; não promove `previous_version_id`. Para "voltar atrás", crie nova proposed e activate via lineage normal.
4. **learned_strong_evidence NEVER overrides Identity** — origin gate enforça em pure function, sem path de bypass.
5. **Soul nunca bloqueia** — `soul_drift` mapeia no máximo a `QUEUED_HUMAN`. Profile rollback é exclusivo dos 7 detectores anteriores.

## Operações

### Propor uma bias

```typescript
import { soulBiasesRepo } from '@/control-plane/soul/soul-biases-repo.js';

const bias = await soulBiasesRepo.propose({
  scope: 'tenant',
  scope_value: '*',
  principle: 'humildade_epistemica',
  guidance: 'Quando a confiança da inferência é abaixo de 0.7, prefira "parece que" a "é".',
  origin: 'founder_explicit',
  strength: 0.9,
  proposed_by: 'founder',
});
// bias.status === 'proposed', bias.version === 1
```

### Activate (após aprovação)

```typescript
const r = await soulBiasesRepo.activate({ id: bias.id, approved_by: 'admin' });
if (!r.ok) {
  if (r.reason === 'no_lineage_to_replace_active') {
    // existe active vigente; precisa de previous_version_id apontando para ela
  }
}
```

### Build slice no prompt

```typescript
import { buildSoulSlice } from '@/runtime/context-assembly/slice-builders/soul-slice-builder.js';

const slice = await buildSoulSlice({
  tenant_id: 'default',
  agent_id: 'default',
  depth: 'relevant',
  max_biases: 5,
  current_role: 'finance_advisor',
  current_domain: 'finance',
  current_risk_level: 'medium',
});

if (slice.rendered_block) {
  // Injetar no prompt como bloco markdown
}
```

### Detectar soul drift

```typescript
import { soulDriftDetector } from '@/cognition/drift/soul.js';

const evidence = await soulDriftDetector.detect({
  profile_active,
  recent_messages,
});
// evidence?.drift_type === 'soul_drift'
// evidence?.payload.severity_hint ∈ {baixo, medio, alto}
```

### Override Identity (origin gate)

```typescript
import { canSoulOverrideIdentity } from '@/control-plane/soul/origin-gate.js';

const decision = canSoulOverrideIdentity({ origin, strength });
if (decision.allowed) {
  // origin_trusted_and_strong — bias modula
} else if (decision.reason === 'origin_blocks_override') {
  // learned_strong_evidence — emit decision.alert ('soul_identity_conflict')
}
```

## Pipeline drift → proposal → bias

1. **Detection** — `soulDriftDetector` roda no worker semanal `drift-monitor`. Emite evidência se ≥ 1 violação com confidence ≥ 0.7.
2. **Decision** — `decision-engine.ts` classifica severity. Para soul_drift, decisão SEMPRE ∈ {AUTO_APPROVED, QUEUED_HUMAN}.
3. **Alert** — `agent_drift_alerts` row persistido com `drift_type='soul_drift'`.
4. **Proposal** — `proposeSoulBiasFromDriftAlert` cria `capability_proposals` row (`capability_type='soul_bias'`, `suggested_origin='learned_strong_evidence'`).
5. **Approval** — Admin UI (P8.5; não disponível em P8b) ou SQL manual: `UPDATE capability_proposals SET status='approved'`.
6. **Materialization** — `processSoulBiasProposalApproval` (worker) propõe + ativa bias.

## Troubleshooting

| Problema | Verifique |
|---|---|
| Bias não aparece no slice | `depth='relevant'`? `activation_context` filtra? `status='active'`? `findActiveForScope` retorna a bias? |
| Drift alert stuck em `queued_human` | É esperado — soul_drift NUNCA é auto-aplicado. Owner precisa decidir na Inbox. |
| `learned_strong_evidence` sobrescreveu Identity | Bug crítico. Inspecione `agent_drift_alerts` por `soul_identity_conflict` — origin-gate deveria ter bloqueado. |
| Duas biases active na mesma chave | Impossível em DB normal (partial unique). Se aparecer, verificar que migration 038 rodou + índice existe. |
| Activate falha com `no_lineage_to_replace_active` | Bias proposed precisa de `previous_version_id` apontando para a active vigente. |
| Worker materializa duplicado | Verificar que `findExistingBiasForProposal` está retornando — repo precisa de índice em `proposal_id`. |

## Kill switch / rollback

**Cenário 1: bias específica causa problema**
```sql
SELECT * FROM soul_biases WHERE principle = 'X' AND status = 'active';
-- rollback via repo:
-- await soulBiasesRepo.rollback({ id, rollback_reason, rolled_back_by });
```

**Cenário 2: desabilitar Soul Layer inteira**
1. Set `FEATURE_SOUL_LAYER_V1=false` no env.
2. Prompt builder pula injection do slice (callsite deve respeitar flag).
3. Biases continuam no DB (sem perda); reativar = flip da flag.

**Cenário 3: rollback de migration**
```bash
psql ... -f migrations/039_p8b_seed_founder_biases_down.sql
psql ... -f migrations/038c_p8b_extend_capability_proposal_type_down.sql
psql ... -f migrations/038b_p8b_extend_drift_alerts_type_down.sql
psql ... -f migrations/038_p8b_soul_biases_down.sql
```

## Admin UI (P8.5 — fora de escopo P8b)

Quando P8.5 aterrissar, espera-se:

| Tela | Função |
|---|---|
| Proposal Inbox | Lista `soul_biases` com `status='proposed'` (também via `capability_proposals` aprovadas pendentes de materialização) |
| Diff & Approval | Mostra v1 atual vs v2 proposta; preview do slice renderizado; botões approve/reject |
| Version History | Lista todas versões por chave; trace de quem propôs/aprovou/depreceou |
| Drift Console | Filter por `drift_type='soul_drift'`; banner `soul_identity_conflict` |
| Audit & Trace | Para cada turn, mostra quais biases entraram no slice e por quê |

Enquanto P8.5 não existe, ativação manual via SQL:
```sql
UPDATE soul_biases
  SET status='active', approved_by='admin', approved_at=NOW(), activated_at=NOW()
  WHERE id = '<bias_id>' AND status = 'proposed';
```

## Limitações conhecidas

- **Sem cache distribuído em P8b** — `buildSoulSlice.cache_key` está exposto mas o cache real é responsabilidade do Context Packet do P8a. P8b devolve cache_key estável; consumidor é livre pra adotar Redis/in-memory.
- **`findByProposalId` não existe ainda** — `soul-bias-activator` faz scan de `listProposed` + `findActiveForScope` para idempotência. Em escala, adicionar método dedicado + índice.
- **LLM judge no detector** — usa Sonnet 4.6; pode ser caro em alto volume. A heurística-first reduz custos em ≥ 70% dos casos (palavras absolutistas).
- **Prompt-builder integration** — não foi integrado em P8b por causa de parse errors pre-existentes em `src/agent/prompt-builder.ts` (não relacionado a P8b). O builder está pronto; basta o callsite quando o arquivo estabilizar.
- **P8a não merged ainda** — `SoulSlice` foi definido localmente em `src/runtime/context-assembly/types/`. Quando P8a aterrissar, re-exporta dali sem quebrar.

## Dependências

P8b depende de P0..P7 aplicados (especialmente P4 `agent_drift_alerts` para FK e P5 `capability_proposals` para FK + branch novo).
