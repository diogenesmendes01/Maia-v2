# P10a — Knowledge State Machine — Design Spec

**Date:** 2026-05-15
**Status:** Draft v1 — implementável após merge de **P8c** (lifecycle_status column + visibility predicate), **P8.5** (Proposal Inbox UI), **P9c** (KnowledgeRiskScorer).
**Scope:** Implementação completa da máquina de estados de 9 estados para `memory_entry`, `agent_facts`, `learned_rules`, `behavioral_hint`. Substitui as escritas "diretas" (`save_fact`, `save_rule`) por um **propose pattern** governado, com transições determinísticas auditáveis (`KnowledgeStateMachine.propose / transition / revoke`) e um **auto-promoter worker** que matura conhecimento por evidência/tempo. Cobre invariantes #9 ("knowledge nunca nasce active por acidente") e a regra `proposed/pending_review/revoked/deprecated` **nunca visíveis ao LLM**.

**Master spec:** [`docs/superpowers/specs/2026-05-15-runtime-architecture-v3-final.md`](./2026-05-15-runtime-architecture-v3-final.md)
**Seções de referência:**
- §0.1 Architecture Locks (mudança em **Knowledge lifecycle** requer aprovação do founder).
- §0.2 Non-goals (auto-active proibido para `learned_rules`).
- §0.4 Princípio 2 ("agente propõe conhecimento, harness decide autoridade") e Princípio 4 ("Source of Truth versionada nunca nasce active por acidente").
- §2.6 Knowledge State Machine (9 estados + `KnowledgeStateMachine.propose` regras).
- §4.2 Evolution Pipeline (`proposal_type='knowledge'`).
- §8 Knowledge State Machine — visibility rules.
- §16 Precedence Pyramid (Knowledge = nível 8 — input, não autoridade).
- §15 invariantes #5 (`DEFAULT 'proposed'`), #9 (knowledge propose ≠ active).

**Architecture Locks tocados:** **Knowledge lifecycle** (§0.1) — qualquer alteração nas 9 transições, no `propose()` initial-state rules, no auto-promoter thresholds, ou no predicado `knowledgeIsVisible` requer aprovação explícita do founder.

**Depends on:**
- **P8c** — `lifecycle_status` column (DEFAULT `'active'`), `evidence_count`, `confidence`, `lifecycle_transitions JSONB` em 4 tabelas; predicate `isVisibleLifecycle`.
- **P8.5** — Proposal Inbox UI (`/inbox`), endpoints `inbox.listProposals` / `inbox.counters`.
- **P9c** — `KnowledgeRiskScorer.score()` com no-downgrade rule (§5 do master).
- **P1** — `runCognitiveModule` wrap para tudo LLM-backed (invariante 2).

**Blocks:** P10b (TraceEnvelope/Body — emite `knowledge_proposals_emitted` no body), P11 (cleanup `save_fact`/`save_rule` aliases).

---

## §0. Purpose

O P8c entregou a infraestrutura física da máquina de estados (coluna `lifecycle_status` + visibility predicate), mas com **DEFAULT `'active'`** para preservar backward-compat: todo conhecimento legado e todo novo `save_fact` continuou caindo direto em `active`. Isso viola por construção a **regra-mãe da governança de conhecimento** (master §0.4 princípio 2):

> *"O agente pode propor conhecimento. O harness decide quando esse conhecimento ganha autoridade operacional."*

P10a fecha esse hiato. A partir do canary do `FEATURE_KNOWLEDGE_STATE_MACHINE_V1`:

1. **Conhecimento novo nunca nasce em `active` por inferência do LLM.** O `KnowledgeStateMachine.propose()` recebe a entrada, consulta `KnowledgeRiskScorer` (P9c), e decide o estado inicial entre `ephemeral` (baixo risco corroborado) ou `pending_review` (qualquer dúvida → humano decide).
2. **`learned_rules.kind='rule'` sempre cai em `pending_review`** — regra operacional **nunca** é auto-ativada (master §2.6 + §0.2 non-goal).
3. **Maturação por evidência é determinística e auditável.** Um worker (`knowledge-state-promoter`) roda a cada 1h, conta `evidence_count` e idade, e promove transições `ephemeral → observed → reinforced → verified`, OU rebaixa para `deprecated` por desuso.
4. **Revogação é short-circuit.** Qualquer estado → `revoked` em um único `transition`, com `revoked` agindo como antimemória (contraevidência: este fato é FALSO).
5. **LLM nunca vê `proposed`, `pending_review`, `revoked` nem `deprecated`.** Os slice builders já filtram via `isVisibleLifecycle` (P8c §7); P10a adiciona a função canônica `knowledgeIsVisible(k, context) → { visible, weight, label }` que inclui weight para ranking dentro dos visíveis.
6. **Toda transição é registrada** em `lifecycle_transitions JSONB` (append-only, com `at`, `from`, `to`, `reason`, `evidence_id?`, `decided_by`).

Frase-mãe aplicada: a Maia **aprende com a experiência** (proposals nascem do reflection batch + tool callbacks + user_explicit) **mas só evolui dentro de governança** (propose → review → matura) **e evidência** (`evidence_count` + janelas temporais determinam promoção, não o LLM).

---

## §1. File structure

### Created

```
src/control-plane/knowledge-state-machine/
├── index.ts                                  # barrel re-export
├── state-machine.ts                          # NEW — KnowledgeStateMachine class
├── transitions.ts                            # NEW — table allowedTransitions + assertion
├── visibility.ts                             # NEW — knowledgeIsVisible(k, ctx)
├── repos.ts                                  # NEW — facade para 4 tabelas via user-layer (P8c)
├── risk-scorer.ts                            # P9c — re-export (mesmo arquivo, não duplicar)
├── types.ts                                  # NEW — KSM types (KnowledgeKind, Proposal, Transition, etc.)
└── __tests__/
    ├── state-machine.spec.ts
    ├── transitions.spec.ts
    ├── visibility.spec.ts
    ├── no-path-revoked-to-active.property.spec.ts
    └── acceptance-gates.spec.ts

src/workers/
└── knowledge-state-promoter.ts               # NEW — cron worker (every 1h)

src/tools/
├── propose-fact.ts                           # NEW
├── propose-rule.ts                           # NEW
├── propose-memory.ts                         # NEW
├── propose-hint.ts                           # NEW
├── save-fact.ts                              # MODIFIED — agora wrapper para propose-fact (deprecation TTL)
├── save-rule.ts                              # MODIFIED — wrapper para propose-rule (deprecation TTL)
└── recall-memory.ts                          # P8c já refatorou; nenhuma mudança em P10a

src/db/migrations/
└── 0XX_p10a_ksm_indexes_and_check.sql        # NEW — pending_review_idx + auto_promoter_eligible_idx + transition CHECK

src/config/feature-flags.ts                   # FEATURE_KNOWLEDGE_STATE_MACHINE_V1

docs/superpowers/runbooks/
└── p10a-knowledge-state-machine.md           # operacional (criado no fechamento da fase)

tests/integration/
└── p10a-knowledge-lifecycle.spec.ts          # fluxo end-to-end (propose→transitions→approval→active)
```

### Touched (não criado)

- `src/user-layer/internal/visibility.ts` (P8c) — **mantido**. `knowledgeIsVisible` em §7 estende, não substitui.
- `src/tools/_registry.ts` — registra 4 novos tools `propose_*`.
- `src/workers/index.ts` — registra `knowledge_state_promoter` no `JOBS[]`.
- `src/admin/proposal-inbox/` (P8.5) — endpoint `inbox.listProposals` já lista knowledge `status='pending_review'`; P10a injeta `risk_score` no payload (lê de `lifecycle_transitions[0].reason`).

---

## §2. Migration SQL

Arquivo: `src/db/migrations/0XX_p10a_ksm_indexes_and_check.sql`

P8c já criou os pré-requisitos físicos. P10a adiciona apenas (a) índices para o auto-promoter e Admin UI Proposal Inbox, e (b) um **CHECK constraint declarativo** que restringe transições válidas — defesa em profundidade, mesmo que a aplicação seja o único caminho de escrita.

```sql
-- 0XX_p10a_ksm_indexes_and_check.sql
-- P10a — Knowledge State Machine indexes + transition CHECK constraint.
-- Pré-requisito: P8c (030_p8c_lifecycle_status.sql) já criou as colunas.

BEGIN;

-- ============================================================
-- Índices: Admin UI Proposal Inbox (rápido WHERE lifecycle_status='pending_review')
-- ============================================================
CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_memory
  ON memory_entry (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_facts
  ON agent_facts (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_rules
  ON learned_rules (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_hints
  ON behavioral_hint (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

-- ============================================================
-- Índices: auto-promoter eligibility (rápido SELECT WHERE evidence_count >= N AND status = ...)
-- ============================================================
CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_memory
  ON memory_entry (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_facts
  ON agent_facts (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_rules
  ON learned_rules (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_hints
  ON behavioral_hint (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

-- ============================================================
-- CHECK declarativo: lifecycle_transitions JSONB shape (defesa em profundidade)
-- Cada elemento deve ter from/to/at/reason/decided_by. Aplica a tabelas que recebem proposals.
-- ============================================================
ALTER TABLE memory_entry
  ADD CONSTRAINT memory_entry_lifecycle_transitions_shape
  CHECK (
    jsonb_typeof(lifecycle_transitions) = 'array'
  );

ALTER TABLE agent_facts
  ADD CONSTRAINT agent_facts_lifecycle_transitions_shape
  CHECK (
    jsonb_typeof(lifecycle_transitions) = 'array'
  );

ALTER TABLE learned_rules
  ADD CONSTRAINT learned_rules_lifecycle_transitions_shape
  CHECK (
    jsonb_typeof(lifecycle_transitions) = 'array'
  );

ALTER TABLE behavioral_hint
  ADD CONSTRAINT behavioral_hint_lifecycle_transitions_shape
  CHECK (
    jsonb_typeof(lifecycle_transitions) = 'array'
  );

COMMIT;
```

**Nota sobre o CHECK de transição válida:** o CHECK declarativo no DB **não impõe a tabela completa de transições válidas** — Postgres não permite subquery em CHECK. A enforcement real fica em `transitions.ts` (§4.3) com `assertAllowedTransition()` antes de cada UPDATE, e backed por property test (§11.3). O CHECK acima só garante o **shape JSONB** (array).

**Down migration:** `DROP INDEX` / `DROP CONSTRAINT` reverso. Forward-only após canary.

---

## §3. The 9-state lifecycle

### §3.1 State table (master §2.6 + §8)

| # | Estado | Visível ao LLM? | Visibility weight | Label exposto à slice | Entry condition | Exit conditions |
|---|---|---|---|---|---|---|
| 1 | `proposed` | ❌ | 0.0 | — (oculto) | `KnowledgeStateMachine.propose()` cria. Auto-routed para `pending_review` ou `ephemeral` em <1s no mesmo `propose()` call. Estado de **trânsito apenas**. | → `pending_review` (default conservador) ou → `ephemeral` (low risk + confidence ≥ 0.6 + kind ≠ 'rule'). |
| 2 | `pending_review` | ❌ | 0.0 | — (oculto) | (a) `kind='rule'` sempre, (b) risk='high' ou 'critical', (c) sensitivity='high', (d) risk='medium', (e) default fallback. | → `active`/`verified` (humano aprova) ou → `revoked` (humano rejeita). |
| 3 | `ephemeral` | ✅ | 0.3 | `[novo, baixa confiança]` | risk='low' AND confidence ≥ 0.6 AND kind ∈ {'fact','memory','behavioral_hint','procedure_hint'}. | → `observed` (evidence_count ≥ 1 in 24h), → `deprecated` (TTL expirou: 30 dias sem uso), → `revoked` (incidente). |
| 4 | `observed` | ✅ | 0.5 | `[observado]` | evidence_count ≥ 1 dentro de janela de 24h após `ephemeral`. | → `reinforced` (evidence_count ≥ 3 in 30d), → `deprecated`, → `revoked`. |
| 5 | `reinforced` | ✅ | 0.7 | `[reforçado]` | evidence_count ≥ 3 in 30d (auto-promoter) OR aprovação humana intermediária. | → `verified` (evidence_count ≥ 7 OR human approval), → `deprecated`, → `revoked`. |
| 6 | `verified` | ✅ | 0.9 | `[verificado]` | evidence_count ≥ 7 in 90d (auto) OR human approval (any stage). | → `deprecated` (90d sem uso), → `revoked`. NUNCA volta para níveis inferiores (no-downgrade). |
| 7 | `active` | ✅ | 1.0 | `[ativo]` | Legacy backfill (P8c DEFAULT) OR aprovação humana direta de `pending_review` para regras estáveis OR migration de `verified` declarada idempotente. | → `deprecated` (90d sem uso), → `revoked`. |
| 8 | `deprecated` | ❌ | 0.0 | — (oculto) | TTL expirou (ephemeral: 30d, observed/reinforced/verified/active: 90d sem `evidence_count++` ou referência) OR substituído por versão mais recente (entity-key shadow). | → `revoked` (humano explicitamente confirma falso). Estado **terminal silencioso**: não exclui registro (audit). |
| 9 | `revoked` | ❌ | 0.0 | — (oculto, mas **conta como antimemória**) | Qualquer estado → revoked via `KnowledgeStateMachine.revoke(args)`. Incidente, contraevidência, ou rejeição humana de proposal. | **Terminal absoluto.** Nenhuma transição saída. Property test garante. |

### §3.2 ASCII state diagram

```
                          ┌─────────────┐
                          │  proposed   │  (estado de trânsito)
                          └──────┬──────┘
                       ┌─────────┴─────────┐
                       │                   │
              risk=low+conf≥0.6    risk=med/high/critical
              kind ≠ 'rule'        OR kind='rule'
              OR sensitivity='high'
                       │                   │
                       v                   v
                ┌─────────────┐    ┌──────────────────┐
                │  ephemeral  │    │  pending_review  │
                └──────┬──────┘    └────────┬─────────┘
       evidence≥1 in 24h│                   │ human approval
                       │                   ├──────────────┐
                       v                   │              v
                ┌─────────────┐            │      ┌──────────────┐
                │  observed   │            │      │   revoked    │ <── (rejection)
                └──────┬──────┘            │      └──────────────┘
       evidence≥3 in 30d│                   │
                       v                   │
                ┌─────────────┐            │
                │ reinforced  │            │
                └──────┬──────┘            │
       evidence≥7 in 90d│                   │
       OR human approve │                   │
                       v                   v
                ┌─────────────┐    ┌──────────────────┐
                │  verified   │    │     active       │
                └──────┬──────┘    └────────┬─────────┘
                       │                   │
        ┌──────────────┴───────────────────┴──────────────┐
        │                                                 │
        │ 90d no usage                       Incident/Drift/
        │                                    Counterevidence
        v                                                 v
   ┌─────────────┐                                  ┌──────────────┐
   │ deprecated  │                                  │   revoked    │  <── (terminal)
   └──────┬──────┘                                  └──────────────┘
          │
          │ explicit human → revoke
          v
   (revoked)

Legend:
  - Sólido = transição automática por auto-promoter ou propose()
  - "Humano" = via Admin UI Proposal Inbox approval/rejection
  - Revoke = short-circuit (any state except revoked → revoked)
```

### §3.3 No-downgrade invariant

Master §2.6 + §15 invariante #10 (no-downgrade do scorer) extende para o lifecycle:

> *Uma vez `verified` (ou `active`), o registro **nunca** volta para `reinforced`, `observed`, ou `ephemeral`. Só pode degradar para `deprecated` (desuso) ou `revoked` (contraevidência explícita).*

Enforced em `transitions.ts` (§4.3) via `allowedTransitions` table + `assertAllowedTransition()` + property test (§11.3) `no path from verified → reinforced`.

---

## §4. `KnowledgeStateMachine` class

### §4.1 Public API — `src/control-plane/knowledge-state-machine/state-machine.ts`

```typescript
import { KnowledgeRiskScorer } from './risk-scorer.js'; // P9c
import { assertAllowedTransition, ALLOWED_TRANSITIONS } from './transitions.js';
import { knowledgeRepos } from './repos.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { logger } from '@/lib/logger.js';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeProposalInput,
  KnowledgeProposeResult,
  KnowledgeTransitionInput,
  KnowledgeTransitionResult,
  KnowledgeRevokeInput,
  KnowledgeRevokeResult,
} from './types.js';

export class KnowledgeStateMachine {
  /**
   * Propõe knowledge novo. Decide estado inicial entre 'ephemeral' e 'pending_review'
   * via KnowledgeRiskScorer (P9c) e regras determinísticas (master §2.6).
   *
   * NUNCA cria registro em 'active' por este caminho. 'active' só por:
   *   - P8c backfill legacy
   *   - human approval via Admin UI
   *   - auto-promoter em 'verified' que migra para 'active' (idempotente)
   */
  static async propose(input: KnowledgeProposalInput): Promise<KnowledgeProposeResult> {
    return runCognitiveModule({
      module: 'knowledge-state-machine',
      submodule: 'propose',
      trace_id: input.trace_id,
      tenant_id: input.tenant_id,
      agent_id: input.agent_id,
      timeout_ms: 300, // risk-scorer pode rodar Haiku em medium; budget ~250ms
      fallback: { initial_status: 'pending_review' as const, reason: 'fallback:scorer_timeout' },
      run: async () => {
        // 1. Risk score (P9c) — NO-DOWNGRADE rule já enforced internamente
        const risk = await KnowledgeRiskScorer.score({
          trace_id: input.trace_id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          kind: input.kind,
          scope: input.scope,
          content_text: input.content_text,
          confidence: input.confidence,
          origin: input.origin,
          proposer_sensitivity_hint: input.sensitivity_hint,
        });

        // 2. Decide initial state — master §2.6 rules em ordem
        const initial_status = decideInitialStatus({
          kind: input.kind,
          risk_level: risk.level,
          sensitivity: risk.sensitivity ?? 'low',
          confidence: input.confidence,
        });

        // 3. Persist row em initial_status + lifecycle_transitions[0]
        const proposal_id = await knowledgeRepos.create({
          ...input,
          lifecycle_status: initial_status,
          lifecycle_transitions: [{
            from: 'proposed',
            to: initial_status,
            at: new Date().toISOString(),
            reason: `risk=${risk.level};kind=${input.kind};confidence=${input.confidence}`,
            decided_by: 'state_machine_propose',
            risk_score: {
              level: risk.level,
              sensitivity: risk.sensitivity,
              reasons: risk.reasons,
              source: risk.source,
            },
          }],
          confidence: input.confidence,
          evidence_count: input.origin === 'user_explicit' || input.origin === 'human_approved' ? 1 : 0,
        });

        return {
          proposal_id,
          initial_status,
          visible_to_llm: VISIBLE_STATES.includes(initial_status),
          reason: `risk=${risk.level} | kind=${input.kind} | conf=${input.confidence}`,
        };
      },
    });
  }

  /**
   * Transição explícita (auto-promoter, human approval, etc.).
   * Valida via assertAllowedTransition. Append-only em lifecycle_transitions.
   */
  static async transition(args: KnowledgeTransitionInput): Promise<KnowledgeTransitionResult> {
    const { kind, proposal_id, to, reason, decided_by, evidence_id } = args;
    const current = await knowledgeRepos.findById(kind, proposal_id);
    if (!current) throw new Error(`knowledge_not_found:${kind}:${proposal_id}`);

    // No-downgrade + valid transition table
    assertAllowedTransition(current.lifecycle_status, to);

    const at = new Date().toISOString();
    const transition = { from: current.lifecycle_status, to, at, reason, decided_by, evidence_id };

    await knowledgeRepos.update(kind, proposal_id, {
      lifecycle_status: to,
      lifecycle_transitions: [...current.lifecycle_transitions, transition],
      // updated_at também atualiza
    });

    logger.info(
      { proposal_id, kind, from: current.lifecycle_status, to, reason },
      'knowledge_state_machine.transition',
    );

    return transition;
  }

  /**
   * Revoga — short-circuit, qualquer estado → 'revoked'.
   * 'revoked' é terminal absoluto. Contraevidência: este conhecimento é FALSO.
   */
  static async revoke(args: KnowledgeRevokeInput): Promise<KnowledgeRevokeResult> {
    const { kind, proposal_id, reason, decided_by } = args;
    const current = await knowledgeRepos.findById(kind, proposal_id);
    if (!current) throw new Error(`knowledge_not_found:${kind}:${proposal_id}`);
    if (current.lifecycle_status === 'revoked') {
      // Idempotent: revoking an already-revoked is no-op
      return { from: 'revoked', to: 'revoked', at: current.updated_at, reason: 'already_revoked' };
    }

    const at = new Date().toISOString();
    const transition = { from: current.lifecycle_status, to: 'revoked' as const, at, reason, decided_by };

    await knowledgeRepos.update(kind, proposal_id, {
      lifecycle_status: 'revoked',
      lifecycle_transitions: [...current.lifecycle_transitions, transition],
    });

    logger.warn(
      { proposal_id, kind, from: current.lifecycle_status, reason },
      'knowledge_state_machine.revoked',
    );

    return transition;
  }
}

const VISIBLE_STATES: KnowledgeLifecycleStatus[] = [
  'ephemeral', 'observed', 'reinforced', 'verified', 'active',
];

function decideInitialStatus(args: {
  kind: KnowledgeKind;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  sensitivity: 'low' | 'medium' | 'high';
  confidence: number;
}): KnowledgeLifecycleStatus {
  // Master §2.6 — ordem de avaliação
  if (args.kind === 'rule') return 'pending_review';                     // (a) rules sempre
  if (args.risk_level === 'high' || args.risk_level === 'critical') return 'pending_review';
  if (args.sensitivity === 'high') return 'pending_review';
  if (args.risk_level === 'medium') return 'pending_review';
  if (args.risk_level === 'low' && args.confidence >= 0.6) return 'ephemeral';
  return 'pending_review'; // default conservador
}
```

### §4.2 `KnowledgeProposalInput` shape — `types.ts`

```typescript
export type KnowledgeKind = 'fact' | 'rule' | 'memory' | 'behavioral_hint' | 'procedure_hint';
export type KnowledgeScope = 'turn' | 'session' | 'user' | 'agent' | 'tenant' | 'global';
export type KnowledgeLifecycleStatus =
  | 'proposed' | 'pending_review' | 'ephemeral' | 'observed'
  | 'reinforced' | 'verified' | 'active' | 'deprecated' | 'revoked';

export interface KnowledgeProposalInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  scope_value?: string;             // ex: pessoa_id quando scope='user'
  key: string;                      // chave operacional
  content: unknown;                 // valor estruturado
  content_text: string;             // representação textual para risk scorer
  confidence: number;               // 0–1, do proposer (LLM ou regra)
  origin: 'llm_inference' | 'user_explicit' | 'tool_callback' | 'human_approved';
  source: string;                   // ex: 'reflection_batch', 'recall_callback', 'manual'
  sensitivity_hint?: 'low' | 'medium' | 'high';
  ttl_days?: number;                // se ausente, usa default por kind (§5.3)
}

export interface KnowledgeProposeResult {
  proposal_id: string;
  initial_status: KnowledgeLifecycleStatus;
  visible_to_llm: boolean;
  reason: string;
}

export interface KnowledgeTransitionInput {
  kind: KnowledgeKind;
  proposal_id: string;
  to: KnowledgeLifecycleStatus;
  reason: string;
  decided_by:
    | 'state_machine_propose'
    | 'auto_promoter:evidence_threshold'
    | 'auto_promoter:ttl_expired'
    | 'auto_promoter:no_usage_90d'
    | 'human_approval'
    | 'human_rejection'
    | 'incident_response'
    | 'drift_decision';
  evidence_id?: string;
}

export interface KnowledgeTransitionResult {
  from: KnowledgeLifecycleStatus;
  to: KnowledgeLifecycleStatus;
  at: string;                       // ISO timestamp
  reason: string;
  evidence_id?: string;
}

export interface KnowledgeRevokeInput {
  kind: KnowledgeKind;
  proposal_id: string;
  reason: string;
  decided_by: 'human_rejection' | 'incident_response' | 'drift_decision' | 'contraevidence';
}

export type KnowledgeRevokeResult = KnowledgeTransitionResult;
```

### §4.3 Allowed transitions table — `transitions.ts`

```typescript
import type { KnowledgeLifecycleStatus } from './types.js';

/**
 * Tabela canônica de transições válidas. Qualquer mudança aqui é
 * Architecture Lock (master §0.1) — exige aprovação do founder.
 */
export const ALLOWED_TRANSITIONS: Record<KnowledgeLifecycleStatus, KnowledgeLifecycleStatus[]> = {
  // 'proposed' é trânsito; só sai para os 2 estados que decideInitialStatus produz
  proposed:        ['pending_review', 'ephemeral'],

  // 'pending_review' espera humano
  pending_review:  ['active', 'verified', 'revoked'],

  // 'ephemeral' matura por evidência ou expira
  ephemeral:       ['observed', 'deprecated', 'revoked'],

  // 'observed' matura, expira, ou é revogado
  observed:        ['reinforced', 'deprecated', 'revoked'],

  // 'reinforced' matura, expira, ou é revogado (NUNCA volta para observed)
  reinforced:      ['verified', 'deprecated', 'revoked'],

  // 'verified' só sai para deprecated/revoked (no-downgrade)
  verified:        ['active', 'deprecated', 'revoked'],

  // 'active' (legacy + post-verify) só sai para deprecated/revoked
  active:          ['deprecated', 'revoked'],

  // 'deprecated' pode ser revogado explicitamente. NUNCA volta para active.
  deprecated:      ['revoked'],

  // 'revoked' é terminal absoluto
  revoked:         [],
};

export class IllegalTransitionError extends Error {
  constructor(public readonly from: KnowledgeLifecycleStatus, public readonly to: KnowledgeLifecycleStatus) {
    super(`Illegal knowledge lifecycle transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertAllowedTransition(
  from: KnowledgeLifecycleStatus,
  to: KnowledgeLifecycleStatus,
): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) throw new IllegalTransitionError(from, to);
}
```

---

## §5. Auto-promoter worker

### §5.1 Worker file — `src/workers/knowledge-state-promoter.ts`

```typescript
import { runCognitiveModule } from '@/cognition/runner.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import { db } from '@/db/connection.js';
import { logger } from '@/lib/logger.js';
import { FEATURE_KNOWLEDGE_STATE_MACHINE_V1 } from '@/config/feature-flags.js';

export async function runKnowledgeStatePromoter(): Promise<void> {
  if (!FEATURE_KNOWLEDGE_STATE_MACHINE_V1) return;

  return runCognitiveModule({
    module: 'knowledge-state-machine',
    submodule: 'auto-promoter',
    trace_id: `auto-promoter:${Date.now()}`,
    tenant_id: 'system',
    timeout_ms: 60_000,
    fallback: undefined, // worker; falha = log + retry no próximo tick
    run: async () => {
      const stats = {
        ephemeral_to_observed: 0,
        observed_to_reinforced: 0,
        reinforced_to_verified: 0,
        verified_to_active: 0,
        ephemeral_to_deprecated: 0,
        active_to_deprecated: 0,
      };

      // 1. ephemeral → observed (evidence_count ≥ 1 dentro de 24h)
      stats.ephemeral_to_observed = await promote({
        from: 'ephemeral',
        to: 'observed',
        condition: `evidence_count >= 1 AND updated_at >= NOW() - INTERVAL '24 hours'`,
        reason: 'evidence_threshold:1_in_24h',
      });

      // 2. observed → reinforced (evidence_count ≥ 3 dentro de 30d)
      stats.observed_to_reinforced = await promote({
        from: 'observed',
        to: 'reinforced',
        condition: `evidence_count >= 3 AND updated_at >= NOW() - INTERVAL '30 days'`,
        reason: 'evidence_threshold:3_in_30d',
      });

      // 3. reinforced → verified (evidence_count ≥ 7 dentro de 90d)
      stats.reinforced_to_verified = await promote({
        from: 'reinforced',
        to: 'verified',
        condition: `evidence_count >= 7 AND updated_at >= NOW() - INTERVAL '90 days'`,
        reason: 'evidence_threshold:7_in_90d',
      });

      // 4. verified → active (idempotente; happens once after verified)
      //    Política conservadora: só promove se confidence ≥ 0.9 + evidence ≥ 10
      stats.verified_to_active = await promote({
        from: 'verified',
        to: 'active',
        condition: `confidence >= 0.9 AND evidence_count >= 10`,
        reason: 'maturity_threshold:conf_0.9_evidence_10',
      });

      // 5. ephemeral → deprecated (TTL expirou: 30 dias sem updated_at refresh)
      stats.ephemeral_to_deprecated = await promote({
        from: 'ephemeral',
        to: 'deprecated',
        condition: `updated_at < NOW() - INTERVAL '30 days'`,
        reason: 'ttl_expired:30d_no_update',
      });

      // 6. active/verified → deprecated (90d sem uso — last_recall_at coluna existente)
      //    Atenção: requires last_recall_at to be maintained; fallback to updated_at if absent
      stats.active_to_deprecated = await promote({
        from: 'active',
        to: 'deprecated',
        condition: `(COALESCE(last_recall_at, updated_at) < NOW() - INTERVAL '90 days')`,
        reason: 'no_usage_90d',
      });

      logger.info(stats, 'knowledge_state_promoter.tick.done');
    },
  });
}

/**
 * Helper genérico — itera as 4 tabelas (memory, facts, rules, hints) e aplica
 * a transição via KnowledgeStateMachine.transition (que valida ALLOWED_TRANSITIONS).
 *
 * Implementação: SELECT row id + lifecycle_status + transitions, depois loop
 * de transitions individuais (não bulk UPDATE) para preservar lifecycle_transitions
 * append-only e audit completo.
 */
async function promote(args: {
  from: KnowledgeLifecycleStatus;
  to: KnowledgeLifecycleStatus;
  condition: string;
  reason: string;
}): Promise<number> {
  let total = 0;
  for (const kind of ['memory', 'fact', 'rule', 'behavioral_hint'] as const) {
    const table = kindToTable(kind); // ex: 'memory_entry'
    // Batch de 100 por tick por tabela
    const rows = await db.unsafe(`
      SELECT id, tenant_id, agent_id, lifecycle_status, lifecycle_transitions
      FROM ${table}
      WHERE lifecycle_status = '${args.from}'
        AND ${args.condition}
      LIMIT 100
    `);
    for (const row of rows) {
      try {
        await KnowledgeStateMachine.transition({
          kind,
          proposal_id: row.id,
          to: args.to,
          reason: args.reason,
          decided_by: args.to === 'deprecated' ? 'auto_promoter:ttl_expired' : 'auto_promoter:evidence_threshold',
        });
        total++;
      } catch (err) {
        // IllegalTransitionError ou DB error — log e continua
        logger.error({ err, kind, id: row.id, from: args.from, to: args.to }, 'auto_promoter.transition_failed');
      }
    }
  }
  return total;
}
```

### §5.2 Cron registration — `src/workers/index.ts`

Acrescentar em `JOBS[]`:

```typescript
{ name: 'knowledge_state_promoter', cron: '0 * * * *', fn: runKnowledgeStatePromoter, phase: 2 },
//                                  ^^^^^^^^^^^^^^^^
//                                  every hour, minute 0
```

**Cron schedule:** every 1h (`0 * * * *`). Phase 2 (mesma fase do `reflection_batch` e `conversation_summarizer`).

### §5.3 Default TTL by kind

| Kind | Default TTL (ephemeral → deprecated) | Default TTL (verified/active → deprecated) |
|---|---|---|
| `memory` | 30d | 90d |
| `fact` | 30d | 90d |
| `rule` | n/a (rules nunca caem em ephemeral) | 90d |
| `behavioral_hint` | 14d | 60d |
| `procedure_hint` | 14d | 60d |

Override via `input.ttl_days` no `propose()`. Worker consulta `expires_at` (já existente em memory_entry) e usa `updated_at + ttl_days` para hints/facts/rules.

### §5.4 Idempotência

O worker é **idempotente por construção**:
- Cada `SELECT ... WHERE lifecycle_status = 'X'` retorna apenas linhas que ainda não foram promovidas.
- `transition()` valida com `assertAllowedTransition()` — se row já foi promovida em tick paralelo, transição volta a falhar com `IllegalTransitionError` (não é from='X', é from='Y'), capturada no try/catch.
- Múltiplas chamadas no mesmo tick produzem o mesmo end state (property test §11.4 valida).

### §5.5 Wrapped em `runCognitiveModule` (P1 invariante)

Todo o tick está dentro de `runCognitiveModule({ module: 'knowledge-state-machine', submodule: 'auto-promoter', ... })`. Registra em `cognitive_module_log`:
- `outcome`: `success` / `partial` (se alguns transitions falharam) / `errored`
- `duration_ms`
- `stats`: counts por transição
- `severity`: `info` (success) / `warn` (partial) / `error` (full failure)

---

## §6. New `propose_*` tools

### §6.1 Princípio: tools "save_*" viram thin wrappers para `propose_*`

P10a entrega 4 tools novos:
- `propose_fact` → `KnowledgeStateMachine.propose({ kind: 'fact', ... })`
- `propose_rule` → `KnowledgeStateMachine.propose({ kind: 'rule', ... })` (sempre cai em `pending_review`)
- `propose_memory` → `KnowledgeStateMachine.propose({ kind: 'memory', ... })`
- `propose_hint` → `KnowledgeStateMachine.propose({ kind: 'behavioral_hint', ... })`

E **modifica** os 2 existentes:
- `save_fact` → deprecated alias que internamente chama `propose_fact`, com log `deprecation_warning_save_fact`. TTL: até P11.
- `save_rule` → deprecated alias para `propose_rule`. TTL: até P11.

**Razão da deprecation com TTL:** evita quebra de prompts/skills que já usam `save_fact`/`save_rule`. O wrapper continua funcional, mas o registro nasce em `ephemeral`/`pending_review` (não mais `active`) — o que pode "esconder" do LLM um conhecimento que antes era visível imediatamente. Isso é correto pelo design (master §15 invariante #9), mas owner deve auditar callers durante o canary.

### §6.2 Tool schema example — `propose_fact`

```typescript
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';

const inputSchema = z.object({
  escopo: z.string().regex(/^(global|tenant|pessoa:[0-9a-f-]+|entidade:[0-9a-f-]+)$/),
  chave: z.string().min(1).max(120),
  valor: z.unknown(),
  texto: z.string().min(1).max(2000),       // representação textual para risk scorer
  fonte: z.enum(['configurado', 'aprendido', 'inferido']).default('aprendido'),
  confianca: z.number().min(0).max(1).default(0.6),
  sensibilidade: z.enum(['low', 'medium', 'high']).optional(),
});

const outputSchema = z.object({
  proposal_id: z.string(),
  initial_status: z.enum(['pending_review', 'ephemeral']),
  visible_to_llm: z.boolean(),
  reason: z.string(),
});

export const proposeFactTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'propose_fact',
  description:
    'Propõe um fato operacional. O harness decide via Knowledge State Machine se nasce ephemeral (visível) ou pending_review (humano decide).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'knowledge_proposed',
  handler: async (args, ctx) => {
    // Escopo enforcement (igual save_fact atual)
    enforceScopeAgainstCallerScope(args.escopo, ctx);

    const result = await KnowledgeStateMachine.propose({
      trace_id: ctx.trace_id,
      tenant_id: ctx.tenant_id,
      agent_id: ctx.agent_id,
      kind: 'fact',
      scope: mapEscopoToScope(args.escopo),
      scope_value: extractScopeValue(args.escopo),
      key: args.chave,
      content: args.valor,
      content_text: args.texto,
      confidence: args.confianca,
      origin: args.fonte === 'configurado' ? 'human_approved'
            : args.fonte === 'aprendido' ? 'llm_inference'
            : 'tool_callback',
      source: ctx.tool_caller ?? 'unknown',
      sensitivity_hint: args.sensibilidade,
    });

    return result;
  },
};
```

### §6.3 `propose_rule` — kind sempre força `pending_review`

```typescript
// propose_rule chama propose com kind='rule'. decideInitialStatus retorna 'pending_review'
// independente de risk/confidence — invariante master §2.6.
// Output sempre tem initial_status='pending_review' e visible_to_llm=false.
```

### §6.4 Deprecation aliases

```typescript
// save-fact.ts (modificado)
export const saveFactTool: Tool<...> = {
  name: 'save_fact',
  description: '[DEPRECATED até P11] Use propose_fact. save_fact agora propõe via Knowledge State Machine — pode cair em pending_review.',
  // ... mesmo schema
  handler: async (args, ctx) => {
    logger.warn({ tool: 'save_fact', caller: ctx.tool_caller }, 'deprecation_warning_save_fact');
    return proposeFactTool.handler(args, ctx);
  },
};
```

---

## §7. LLM visibility logic — `knowledgeIsVisible`

### §7.1 Function — `src/control-plane/knowledge-state-machine/visibility.ts`

```typescript
import type { KnowledgeLifecycleStatus } from './types.js';

export interface KnowledgeVisibilityContext {
  // Reservado para futuras decisões context-aware (ex: skill exige strict)
  context_mode?: 'normal' | 'strict' | 'debug';
}

export interface KnowledgeVisibilityResult {
  visible: boolean;
  weight: number;                   // 0.0–1.0 para ranking dentro dos visíveis
  label: string | null;             // label exibido para LLM (null = oculto)
}

const VISIBILITY_TABLE: Record<KnowledgeLifecycleStatus, KnowledgeVisibilityResult> = {
  proposed:       { visible: false, weight: 0.0, label: null },
  pending_review: { visible: false, weight: 0.0, label: null },
  ephemeral:      { visible: true,  weight: 0.3, label: '[novo, baixa confiança]' },
  observed:       { visible: true,  weight: 0.5, label: '[observado]' },
  reinforced:     { visible: true,  weight: 0.7, label: '[reforçado]' },
  verified:       { visible: true,  weight: 0.9, label: '[verificado]' },
  active:         { visible: true,  weight: 1.0, label: '[ativo]' },
  deprecated:     { visible: false, weight: 0.0, label: null },
  revoked:        { visible: false, weight: 0.0, label: null },
};

export function knowledgeIsVisible(
  k: { lifecycle_status: KnowledgeLifecycleStatus },
  ctx?: KnowledgeVisibilityContext,
): KnowledgeVisibilityResult {
  const result = VISIBILITY_TABLE[k.lifecycle_status];
  // Em strict mode, ephemeral também é oculto (ex: skill de alta criticidade)
  if (ctx?.context_mode === 'strict' && k.lifecycle_status === 'ephemeral') {
    return { visible: false, weight: 0.0, label: null };
  }
  return result;
}
```

### §7.2 Visibility table verbatim (master §8)

| Estado | `visible` | `weight` | `label` |
|---|---|---|---|
| `proposed` | `false` | `0.0` | `null` |
| `pending_review` | `false` | `0.0` | `null` |
| `ephemeral` | `true` | `0.3` | `[novo, baixa confiança]` |
| `observed` | `true` | `0.5` | `[observado]` |
| `reinforced` | `true` | `0.7` | `[reforçado]` |
| `verified` | `true` | `0.9` | `[verificado]` |
| `active` | `true` | `1.0` | `[ativo]` |
| `deprecated` | `false` | `0.0` | `null` |
| `revoked` | `false` | `0.0` | `null` |

### §7.3 Integração com slice builder (P8c)

P8c já filtra via `isVisibleLifecycle()` no `WHERE` do SQL (defesa em DB-level). P10a estende:

```typescript
// P8c (mantido): SELECT ... WHERE lifecycle_status IN ('ephemeral','observed','reinforced','verified','active')
// P10a (novo): após fetch, slice builder enriquece com weight + label:
const annotated = rows.map(row => {
  const v = knowledgeIsVisible(row);
  return { ...row, _visibility: { weight: v.weight, label: v.label } };
});
// Slice builder ordena por weight DESC quando há limite (max_items/max_facts)
annotated.sort((a, b) => b._visibility.weight - a._visibility.weight);
```

Resultado: quando `KnowledgeSlice` está limitado por `max_facts=10`, os 10 facts retornados são os de maior weight (active/verified primeiro, ephemeral por último).

---

## §8. Anti-feedback-loop guards

Cinco invariantes que P10a enforce, todos testados via property tests (§11):

| Invariante | Enforcement | Test |
|---|---|---|
| `pending_review` **nunca** visível ao LLM | `VISIBILITY_TABLE.pending_review.visible = false` literal | property: `∀ k. k.status='pending_review' → ¬knowledgeIsVisible(k).visible` |
| `proposed` **nunca** atinge slice (estado de trânsito) | `decideInitialStatus()` retorna `ephemeral`/`pending_review` em <1s no mesmo call | property: nenhum row persistido com `lifecycle_status='proposed'` |
| `revoked` **nunca** volta a active | `ALLOWED_TRANSITIONS.revoked = []` (terminal absoluto) | property: BFS de `revoked` em `ALLOWED_TRANSITIONS` não atinge `active`/`verified`/`reinforced`/`observed`/`ephemeral` (§11.3) |
| `learned_rules` **sempre** começa em `pending_review` | `decideInitialStatus({ kind: 'rule' })` retorna `pending_review` antes de qualquer outro check | property: `∀ p. p.kind='rule' → propose(p).initial_status='pending_review'` |
| `verified`/`active` **não regridem** para `reinforced`/`observed`/`ephemeral` | `ALLOWED_TRANSITIONS.verified = ['active','deprecated','revoked']` (no-downgrade) | property: para todos `s ∈ {verified,active}`, BFS de `s` em `ALLOWED_TRANSITIONS` não atinge níveis inferiores exceto `deprecated`/`revoked` |

**`revoked` como antimemória.** Diferente de `deprecated` (substituído/sem uso), `revoked` carrega contraevidência: este conhecimento é FALSO. O User Layer slice builder (P8c) **deve** consultar `revoked` rows em modo "negação" quando a chave operacional retornaria um fato `revoked` — para evitar que o LLM proponha novamente a mesma asserção. Implementação:

```typescript
// knowledge-slice-builder.ts (P8c, extended em P10a)
const revokedKeys = await db.select({ key: agentFacts.key })
  .from(agentFacts)
  .where(and(
    eq(agentFacts.tenant_id, tenant_id),
    eq(agentFacts.lifecycle_status, 'revoked'),
  ))
  .limit(max_revoked_hints);

// Inject em system prompt como "knowledge_known_to_be_false":
prompt.append(`Os seguintes facts foram revogados (sabemos que são FALSOS): ${revokedKeys.join(', ')}.`);
```

(Este injection é opcional em P10a; pode ser deferido para P10b/P11 se budget apertado. O guard hard de **não-vazamento** é o mais importante.)

---

## §9. Admin UI integration (P8.5)

### §9.1 Proposal Inbox — knowledge proposals

P8.5 Tela 1 já lista proposals com filtro `Type=knowledge` e `Status=pending_review` (P8.5 §3.1). P10a injeta dois enriquecimentos:

1. **Risk score visível na lista** — coluna `Risk` lê de `lifecycle_transitions[0].risk_score.level`. P8.5 já tem coluna Risk; só precisamos garantir que o resolver de inbox extrai da JSONB corretamente:

```typescript
// trpc/routers/inbox.ts — adicionar no projection knowledge:
risk: row.lifecycle_transitions?.[0]?.risk_score?.level ?? 'unknown',
risk_reasons: row.lifecycle_transitions?.[0]?.risk_score?.reasons ?? [],
```

2. **Evidence count + age na tela 2 (Diff & Approval)** — P8.5 §3.2 mostra "Rationale + evidência". P10a injeta:

```
┌─ Knowledge Proposal: agent_facts/cliente_prefers_email ──────┐
│  Kind: fact                                                  │
│  Scope: pessoa:UUID-...                                      │
│  Current status: pending_review                              │
│  Risk: medium (sensitivity=low)                              │
│  Reasons:                                                    │
│    - heuristic: confidence_below_threshold (0.55)            │
│    - llm_elevated: ambiguous_evidence                        │
│  Evidence count: 0 (proposed via reflection_batch)           │
│  Age: 2h                                                     │
│                                                              │
│  [ Approve → active ]  [ Approve → verified ]  [ Reject ]    │
└──────────────────────────────────────────────────────────────┘
```

### §9.2 Approval actions

- **Approve → active** chama `KnowledgeStateMachine.transition({ kind, proposal_id, to: 'active', reason: 'human_approval', decided_by: 'human_approval' })`.
- **Approve → verified** mesma coisa com `to: 'verified'`. (Caminho rápido se o aprovador quer expor que foi humano-aprovado).
- **Reject** chama `KnowledgeStateMachine.revoke({ kind, proposal_id, reason: comment, decided_by: 'human_rejection' })`.

Todos exigem **comment obrigatório** no modal (P8.5 §2.3 audit rule).

### §9.3 Bulk reject lock

P8.5 §3.1 já trava: "bulk reject NUNCA é permitido para `kind='rule'`". P10a confirma — `propose_rule` cai em `pending_review` e exige decisão individual.

---

## §10. Architecture Lock — Knowledge lifecycle definition changes

Master §0.1 lista **"Knowledge lifecycle"** como Architecture Lock. Em P10a, isso significa **qualquer alteração** em:

1. **Os 9 estados** (`ALLOWED_TRANSITIONS` keys).
2. **A tabela de transições válidas** (`ALLOWED_TRANSITIONS` values).
3. **`decideInitialStatus()` rules** (ordem ou conteúdo).
4. **Thresholds do auto-promoter** (1 in 24h / 3 in 30d / 7 in 90d / TTL 30d/90d).
5. **`VISIBILITY_TABLE`** (estado → visible/weight/label).

**Workflow obrigatório:**

- PR que toca qualquer um dos 5 itens acima **deve** ter aprovação do founder no GitHub review.
- CODEOWNERS rule: `src/control-plane/knowledge-state-machine/transitions.ts @founder`, `src/control-plane/knowledge-state-machine/visibility.ts @founder`, `src/control-plane/knowledge-state-machine/state-machine.ts (apenas decideInitialStatus + thresholds) @founder`.
- CI gate: pre-commit hook que detecta diff em `ALLOWED_TRANSITIONS` ou `VISIBILITY_TABLE` e exige label `architecture-lock-approved`.

P10a adiciona o CODEOWNERS entry no `.github/CODEOWNERS` (se ainda não existe).

---

## §11. Testing

### §11.1 Unit tests

#### §11.1.1 `state-machine.spec.ts`

- `propose()` com `kind='rule'` → SEMPRE `initial_status='pending_review'`, mesmo com `risk='low'` e `confidence=0.99`.
- `propose()` com `risk='high'` → SEMPRE `pending_review`.
- `propose()` com `risk='medium'` → SEMPRE `pending_review`.
- `propose()` com `risk='low' AND confidence>=0.6 AND kind='fact'` → `ephemeral`.
- `propose()` com `risk='low' AND confidence<0.6` → `pending_review` (default conservador).
- `propose()` retorna `visible_to_llm: false` para `pending_review`, `true` para `ephemeral`.
- `transition()` válida (`ephemeral → observed`) sucede, append ao `lifecycle_transitions`.
- `transition()` inválida (`ephemeral → verified`) lança `IllegalTransitionError`.
- `transition()` no-downgrade: `verified → reinforced` lança `IllegalTransitionError`.
- `revoke()` de `ephemeral`/`active`/`verified` → sucede, append transition.
- `revoke()` de `revoked` → no-op idempotente, retorna `from: 'revoked', to: 'revoked', reason: 'already_revoked'`.
- `revoke()` em row inexistente → throws `knowledge_not_found`.

#### §11.1.2 `transitions.spec.ts`

- Cada estado da `ALLOWED_TRANSITIONS` table tem o set de transições documentadas no §4.3.
- `assertAllowedTransition` aceita só os pares declarados.
- `assertAllowedTransition('revoked', 'active')` throws.
- `IllegalTransitionError` carrega `from`/`to` para audit.

#### §11.1.3 `visibility.spec.ts`

- Cada estado retorna o triple correto (`visible`, `weight`, `label`) da tabela §7.2.
- `context_mode='strict'` torna `ephemeral` invisível.
- Sem contexto, `ephemeral` é visível com weight 0.3.

### §11.2 Integration tests — `tests/integration/p10a-knowledge-lifecycle.spec.ts`

Cenários end-to-end com DB real, `KnowledgeRiskScorer` real, `callHaiku` mockado:

1. **Full happy path** — `propose_fact({ risk='low', conf=0.7 })` → row em `ephemeral`, slice mostra com label `[novo, baixa confiança]`. Worker tick (forçado) com `evidence_count=1` → `observed`. 3 ticks com `evidence_count++` → `reinforced`. 7 ticks → `verified`. Final state: `verified`, visible com weight 0.9, label `[verificado]`.

2. **Pending review approval** — `propose_rule({ ... })` → row em `pending_review`, NÃO visível na slice. Admin UI approve via `transition({ to: 'active' })` → row em `active`, agora visível.

3. **Revocation** — `propose_fact` → `ephemeral`. Slice mostra. `revoke({ reason: 'incident_response' })` → `revoked`, slice **não** mostra mais. Property: nenhuma chamada à `transition` consegue tirar de `revoked`.

4. **Auto-promoter idempotência** — Rodar worker 2× consecutivos: stats do 2º run = `{ all: 0 }` (todos já promovidos).

5. **TTL expiration** — `propose_fact` em `ephemeral`, manipular `updated_at` para 31 dias atrás → worker tick → row em `deprecated`. Slice não mostra mais.

6. **No-downgrade enforced via auto-promoter** — Inserir manualmente row em `verified`. Worker tick: nenhuma transição. Tentar `transition({ to: 'reinforced' })` direto → throws `IllegalTransitionError`.

7. **Deprecated `save_fact` continua funcional** — Chamar `save_fact({ risk='low', conf=0.7 })` → log de deprecation, mas resultado idêntico a `propose_fact` (row em `ephemeral`).

### §11.3 Property tests

#### §11.3.1 No path from `revoked` to `active`

```typescript
// no-path-revoked-to-active.property.spec.ts
import { ALLOWED_TRANSITIONS } from '../transitions.js';

function bfsReachable(start: KnowledgeLifecycleStatus): Set<KnowledgeLifecycleStatus> {
  const reached = new Set<KnowledgeLifecycleStatus>([start]);
  const queue: KnowledgeLifecycleStatus[] = [start];
  while (queue.length) {
    const node = queue.shift()!;
    for (const next of ALLOWED_TRANSITIONS[node]) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}

describe('property: no path from revoked → visible state', () => {
  it('BFS from revoked reaches no visible state', () => {
    const reachable = bfsReachable('revoked');
    expect(reachable).toEqual(new Set(['revoked']));
  });

  it('BFS from verified reaches only verified/active/deprecated/revoked', () => {
    const reachable = bfsReachable('verified');
    // verified → active → deprecated → revoked
    expect(reachable).toEqual(new Set(['verified', 'active', 'deprecated', 'revoked']));
    expect(reachable.has('reinforced')).toBe(false);
    expect(reachable.has('observed')).toBe(false);
    expect(reachable.has('ephemeral')).toBe(false);
  });

  it('BFS from active never reaches reinforced/observed/ephemeral', () => {
    const reachable = bfsReachable('active');
    expect(reachable.has('reinforced')).toBe(false);
    expect(reachable.has('observed')).toBe(false);
    expect(reachable.has('ephemeral')).toBe(false);
  });
});
```

#### §11.3.2 Visibility property

```typescript
describe('property: pending_review and proposed never visible', () => {
  it('pending_review is never visible regardless of context', () => {
    for (const mode of ['normal', 'strict', 'debug', undefined] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: 'pending_review' },
        mode ? { context_mode: mode } : undefined,
      );
      expect(result.visible).toBe(false);
      expect(result.label).toBeNull();
    }
  });

  it('proposed is never visible (transit state)', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'proposed' }).visible).toBe(false);
  });

  it('revoked is never visible', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'revoked' }).visible).toBe(false);
  });
});
```

#### §11.3.3 `decideInitialStatus` exhaustive

```typescript
describe('property: decideInitialStatus rules', () => {
  it('kind=rule always returns pending_review', () => {
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      for (const conf of [0.1, 0.5, 0.9, 0.99]) {
        expect(decideInitialStatus({
          kind: 'rule', risk_level: risk, sensitivity: 'low', confidence: conf,
        })).toBe('pending_review');
      }
    }
  });

  it('risk=high/critical always returns pending_review', () => {
    for (const kind of ['fact', 'memory', 'behavioral_hint', 'procedure_hint'] as const) {
      for (const risk of ['high', 'critical'] as const) {
        expect(decideInitialStatus({
          kind, risk_level: risk, sensitivity: 'low', confidence: 1.0,
        })).toBe('pending_review');
      }
    }
  });

  it('risk=low AND confidence >= 0.6 AND kind != rule returns ephemeral', () => {
    for (const kind of ['fact', 'memory', 'behavioral_hint', 'procedure_hint'] as const) {
      expect(decideInitialStatus({
        kind, risk_level: 'low', sensitivity: 'low', confidence: 0.6,
      })).toBe('ephemeral');
      expect(decideInitialStatus({
        kind, risk_level: 'low', sensitivity: 'low', confidence: 0.99,
      })).toBe('ephemeral');
    }
  });

  it('default (low conf < 0.6) returns pending_review', () => {
    expect(decideInitialStatus({
      kind: 'fact', risk_level: 'low', sensitivity: 'low', confidence: 0.5,
    })).toBe('pending_review');
  });
});
```

### §11.4 Auto-promoter idempotency

```typescript
it('running promoter twice yields same end state', async () => {
  // Setup: insert 10 rows em ephemeral com evidence_count=2
  await seedEphemeralRows({ count: 10, evidence_count: 2 });

  // Tick 1
  await runKnowledgeStatePromoter();
  const after1 = await fetchAllStatuses();

  // Tick 2 (no new evidence)
  await runKnowledgeStatePromoter();
  const after2 = await fetchAllStatuses();

  expect(after1).toEqual(after2);
});
```

---

## §12. Acceptance gates

Antes do canary do `FEATURE_KNOWLEDGE_STATE_MACHINE_V1`:

- [ ] **Gate 1 — `proposed`/`pending_review`/`revoked`/`deprecated` NUNCA visíveis ao LLM.** `grep -E "proposed|pending_review|revoked|deprecated" src/user-layer/internal/visibility.ts | grep -v "//.*"` retorna nada (literal strings em comentários OK; em código não). Plus property test §11.3.2 verde.
- [ ] **Gate 2 — `learned_rules` SEMPRE em `pending_review` ao propor.** Integration test §11.2 cenário 2 verde. Plus property test §11.3.3.
- [ ] **Gate 3 — Auto-promoter idempotente.** Property test §11.4 verde.
- [ ] **Gate 4 — Cron registrado a cada 1h.** `grep "knowledge_state_promoter" src/workers/index.ts` retorna entry com `cron: '0 * * * *'`.
- [ ] **Gate 5 — `revoked` é terminal.** Property test §11.3.1 verde (BFS de `revoked` retorna `{revoked}`).
- [ ] **Gate 6 — `verified`/`active` no-downgrade.** Property test §11.3.1 segundo bloco verde.
- [ ] **Gate 7 — Architecture Lock CODEOWNERS configurado.** `transitions.ts`, `visibility.ts`, e `state-machine.ts`/`decideInitialStatus` marcados como `@founder` em `.github/CODEOWNERS`.
- [ ] **Gate 8 — `propose_*` tools registrados em `_registry.ts`.** Smoke test do agent loop consegue invocar `propose_fact`.
- [ ] **Gate 9 — Deprecation aliases funcionam.** Chamada legacy a `save_fact` retorna `proposal_id` + log de deprecation.
- [ ] **Gate 10 — `runCognitiveModule` wrap em propose + auto-promoter.** Cada tick emite row em `cognitive_module_log` com `module='knowledge-state-machine'`.
- [ ] **Gate 11 — Admin UI mostra risk score.** Visual sanity via Playwright (P8.5 testing skill).
- [ ] **Gate 12 — Migration aplicada sem downtime.** Migration `0XX_p10a_ksm_indexes_and_check.sql` rodou em staging + canary; queries do auto-promoter executam em <100ms p95.

Script de acceptance:

```bash
#!/usr/bin/env bash
# scripts/acceptance/p10a-knowledge-state-machine.sh
set -euo pipefail

echo "Gate 1: invisible states never in visibility WHERE clauses"
! grep -E "lifecycle_status\s*=\s*'(proposed|pending_review|revoked|deprecated)'" \
  src/user-layer/internal/visibility.ts src/user-layer/resolvers/*.ts

echo "Gate 2-6: property tests"
pnpm test src/control-plane/knowledge-state-machine/__tests__/ -- --run

echo "Gate 4: cron scheduled every 1h"
grep "knowledge_state_promoter.*'0 \* \* \* \*'" src/workers/index.ts

echo "Gate 7: CODEOWNERS"
grep -E "knowledge-state-machine/(transitions|visibility|state-machine)" .github/CODEOWNERS

echo "Gate 8: tools registered"
grep "proposeFactTool\|proposeRuleTool\|proposeMemoryTool\|proposeHintTool" src/tools/_registry.ts

echo "Gate 10: runCognitiveModule wraps"
grep -c "runCognitiveModule" src/control-plane/knowledge-state-machine/state-machine.ts | \
  awk '$1 >= 1 { exit 0 } { exit 1 }'

echo "All P10a gates passed"
```

---

## §13. Feature flag

```typescript
// src/config/feature-flags.ts
export const FEATURE_KNOWLEDGE_STATE_MACHINE_V1 =
  process.env.FEATURE_KNOWLEDGE_STATE_MACHINE_V1 === 'true';
```

**Comportamento por modo:**

| Flag | `propose_*` tools | `save_fact`/`save_rule` | Auto-promoter |
|---|---|---|---|
| `false` (default) | Não registrados em `_registry.ts` | Mantém comportamento legado: insere em `active` direto | Worker registrado mas early-return imediato |
| `true` (canary) | Registrados, retornam `proposal_id`/`initial_status` | Wrapper para `propose_*`, log deprecation | Roda a cada 1h |

**Canary plan:**

1. **Semana 1 — staging only.** Flag on em staging. Reflection batch e tools de skill começam a propor. Validar que nenhum row antigo (`active` backfill) é tocado, e que novos vão para `ephemeral`/`pending_review`.
2. **Semana 2 — 1 tenant canary em prod.** Flag on para 1 tenant via overrides. Monitorar Admin UI Proposal Inbox count + Drift Detector (P4) para `papel_drift`/`procedure_drift` anomalias.
3. **Semana 3 — 10% prod.** Rollout gradual.
4. **Semana 4 — 100% prod.** Flag default `true`.
5. **P11 cleanup** — remover deprecation aliases `save_fact`/`save_rule`.

---

## §14. Risks + mitigations

| Risco | Severidade | Mitigação |
|---|---|---|
| Tenants existentes "perdem visibilidade" de conhecimento novo enquanto canary | Alta | Backfill: P8c DEFAULT `'active'` mantém legacy visível. Novos proposals do reflection_batch caem em `ephemeral`/`pending_review` — owner pode aprovar batch via Admin UI Proposal Inbox. Documentar no runbook que primeira semana exige babá. |
| Admin UI Inbox cresce demais (proposals acumulam) | Média | Bulk reject habilitado para `risk='low'` (P8.5 §3.1). Auto-promoter mata `ephemeral` órfão por TTL (30d). Alerta em Inbox >500 pending. |
| `KnowledgeRiskScorer` LLM Haiku timeout em propose hot path | Média | `runCognitiveModule.fallback: { initial_status: 'pending_review' }` — fail safe é o estado mais conservador. Cache (P9c) reduz hit em propose repetitivos. |
| Auto-promoter compete com escrita do reflection batch (lock contention) | Baixa | Worker tick LIMIT 100/tabela/ciclo. Cron a cada 1h (não a cada minuto). Cada `transition()` é UPDATE single-row. |
| Property test não cobre transição rara | Baixa | Property test §11.3.1 cobre exhaustivamente via BFS — qualquer adição em `ALLOWED_TRANSITIONS` é varrida. |
| Founder approval gate vira fricção sobre legítimos refactors | Média | CODEOWNERS aplica apenas em arquivos com decisões (`transitions.ts`/`visibility.ts`/`decideInitialStatus`). Refactor de implementação sem mudar contrato passa só por technical reviewer. |
| `revoked` antimemória cresce demais (false-positive rejections) | Baixa | Auto-promoter NÃO expira `revoked` — terminal absoluto. Admin UI v2 (futuro) pode oferecer "unrevoke" via founder approval. Documentar como Architecture Lock. |
| Migration adiciona índice em prod com tabelas grandes | Média | `CREATE INDEX CONCURRENTLY` se tabela >1M rows; rodar fora de pico. Plano de canary inclui `EXPLAIN ANALYZE` antes/depois. |
| Slice builder ordering por weight muda ranking percebido pelo agent | Média | Documentar mudança no runbook. Snapshot tests do KnowledgeSlice ordering. Canary detecta mudanças via `papel_drift` (P4). |

---

## §15. Done criteria

- [ ] Migration `0XX_p10a_ksm_indexes_and_check.sql` aplicada em staging + 1 tenant canary + 100% prod.
- [ ] `src/control-plane/knowledge-state-machine/` namespace completo (state-machine.ts, transitions.ts, visibility.ts, repos.ts, types.ts) + tests.
- [ ] `KnowledgeStateMachine.propose / transition / revoke` operacionais, wrapped em `runCognitiveModule`.
- [ ] `knowledge-state-promoter` worker registrado, rodando a cada 1h em prod.
- [ ] 4 tools `propose_fact`/`propose_rule`/`propose_memory`/`propose_hint` registrados em `_registry.ts` e operacionais.
- [ ] 2 tools `save_fact`/`save_rule` redirecionando para `propose_*` com log de deprecation.
- [ ] Admin UI Proposal Inbox (P8.5) mostrando knowledge proposals com risk score visível.
- [ ] Todos os 12 acceptance gates verdes.
- [ ] Property tests verdes: §11.3.1, §11.3.2, §11.3.3, §11.4.
- [ ] Integration tests verdes: §11.2 cenários 1–7.
- [ ] CODEOWNERS configurado com founder approval para `transitions.ts`/`visibility.ts`/`decideInitialStatus`.
- [ ] Runbook `docs/runbooks/p10a-knowledge-state-machine.md` publicado.
- [ ] Feature flag `FEATURE_KNOWLEDGE_STATE_MACHINE_V1=true` rolled out 100%.
- [ ] Memórias de design atualizadas se houver desvio do master spec.
- [ ] Cognitive module log mostra `module='knowledge-state-machine'` rows com p95 latency <300ms para `propose`, <60s para `auto-promoter`.

---

## §16. Dependencies

| Fase | O que entrega | P10a depende disso para |
|---|---|---|
| **P1** | `runCognitiveModule` runner | Wrap obrigatório em `propose()` + auto-promoter (invariante 2). |
| **P4** | Drift detectors | Detecção de `papel_drift`/`procedure_drift` durante canary (sinalizando quando lifecycle decisions vazam para agent behavior). |
| **P8c** | Coluna `lifecycle_status` (DEFAULT `'active'`), `evidence_count`, `confidence`, `lifecycle_transitions JSONB`. Predicate `isVisibleLifecycle` no slice builder. Resolver `agent_id` opt-out. | P10a opera **sobre** essas colunas; visibility predicate já filtra `proposed`/`pending_review`/`revoked`/`deprecated` no SQL. |
| **P8.5** | Admin UI Proposal Inbox (`/inbox`), endpoints `inbox.listProposals` + `inbox.counters` com filtro `Type=knowledge`. | Aprovação/rejeição humana de `pending_review` proposals. |
| **P9c** | `KnowledgeRiskScorer.score()` com no-downgrade rule (§5 do master). | Consultado pelo `propose()` para decidir initial status. |
| **P10b** *(próximo)* | TraceEnvelope/Body schema (`runtime_trace_bodies.knowledge_proposals_emitted`). | P10a apenas emite `proposal_id` via return — P10b liga o trace. |
| **P11** *(cleanup)* | Drop dos aliases `save_fact`/`save_rule`. Drop de `agent_id` colunas (P8c roadmap). | Limpa débito de deprecation TTL. |

---

## §17. Open questions / follow-ups

1. **Evidence model formal.** Como exatamente `evidence_count` é incrementado? P10a assume que **tool callbacks** + **reflection_batch corroborations** chamam um método `KnowledgeStateMachine.markEvidence(proposal_id, evidence_id)`. Implementação detalhada de `markEvidence` (idempotência por `evidence_id`, locking, etc.) fica em ticket separado P10a.1. Hoje, assumir que `evidence_count` é gerenciado pelo caller (worker reflection_batch faz `UPDATE ... SET evidence_count = evidence_count + 1`). Reconciliar antes do canary.

2. **`last_recall_at` coluna.** Auto-promoter §5.1 usa `COALESCE(last_recall_at, updated_at)` para detectar "no usage". Validar se `last_recall_at` está sendo populado pelo `recall-memory` tool (P8c). Se não, P10a precisa adicionar update no recall path.

3. **Antimemória injection no system prompt.** §8 menciona injetar `revoked` keys como "knowledge_known_to_be_false" no prompt. Deixar deferido para P10b ou trazer já no P10a? Decisão de prompt budget — defer to canary observation.

4. **Procedure_hint kind.** Não tem tabela dedicada hoje (memory_entry serve). Validar com P3b se procedure execution gera `procedure_hint` proposals via `propose_hint(kind='procedure_hint', ...)`.

5. **Tenant override do TTL default.** Tabela §5.3 dá defaults; deveria existir `tenant_settings.knowledge_ttl_overrides`? Defer to v2.

---

**End of P10a spec.**
