# Spec 02 — Data Model

**Status:** Foundation • **Phase:** 1 • **Depends on:** 00, 01

---

## 1. Purpose

Define the canonical data model for Maia. This spec is authoritative — when the SQL migrations and this document disagree, the document wins (open a PR to align migrations). The model supports financial bookkeeping for one owner across N entities, the agent's persistent memory in five layers, governance and audit, and operational state machines.

## 2. Goals

- Enforce **strict separation between entities**: every table that holds entity-scoped data has `entidade_id NOT NULL`.
- Make multi-entity queries explicit (joins or `IN` lists), never accidental.
- Give the agent durable state — workflows, learned rules, semantic facts, vector recall — survives any restart.
- Provide hooks for the governance layer (audit log, idempotency, dual approval).
- Stay **single-tenant**: there is no `tenant_id` column anywhere.

## 3. Non-goals

- Multi-tenancy. Adding a tenant column later is a deliberate migration with full review.
- Soft deletion as a generic mechanism. Specific tables use status enums (`'cancelada'`, `'inativa'`) instead.
- ORM-driven schema. Migrations are hand-written SQL; Drizzle infers types from the live DB.

## 4. Architecture

The data model is partitioned into six logical groups:

1. **Entities & Finance** — `entidades`, `contas_bancarias`, `categorias`, `transacoes`, `transferencias_internas`, `recorrencias`, `contrapartes` (new).
2. **People & Access** — `pessoas`, `permissoes` (extended), `permission_profiles` (new), `conversas`, `mensagens`.
3. **Agent Memory** — `agent_facts`, `agent_memories`, `learned_rules`, `self_state`, `entity_states` (new).
4. **Workflows** — `workflows`, `workflow_steps`.
5. **Operational State** — `pending_questions` (new), `idempotency_keys` (new).
6. **Audit & Health** — `audit_log`, `system_health_events` (new), `dead_letter_jobs` (new).

## 5. Schema delta — what migration `002_specs_v1.sql` must add

The current `001_initial.sql` already creates groups 1–4 (without `contrapartes`, `entity_states`, and `permission_profiles`). The next migration adds groups 5–6 and the new tables in 1–3.

### 5.1 New table — `contrapartes`

```sql
CREATE TABLE contrapartes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entidade_id     UUID NOT NULL REFERENCES entidades(id) ON DELETE RESTRICT,
  nome            TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('fornecedor', 'cliente', 'funcionario_externo', 'orgao_publico', 'outro')),
  documento       TEXT,
  chave_pix       TEXT,
  banco_padrao    TEXT,
  observacoes     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'inativa')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entidade_id, documento)
);

CREATE INDEX idx_contrapartes_entidade ON contrapartes (entidade_id);
CREATE INDEX idx_contrapartes_nome_trgm ON contrapartes USING gin (nome gin_trgm_ops);

ALTER TABLE transacoes
  ADD COLUMN contraparte_id UUID REFERENCES contrapartes(id) ON DELETE SET NULL;
-- Existing transacoes.contraparte (TEXT) is kept for legacy/free-form mentions
```

Per spec 03, creating a new `contraparte` is a **dual-approval** action.

### 5.2 New table — `permission_profiles`

```sql
CREATE TABLE permission_profiles (
  id              TEXT PRIMARY KEY,                       -- 'contador_leitura', 'operador_basico', ...
  nome            TEXT NOT NULL,
  acoes           TEXT[] NOT NULL,
  limite_default  NUMERIC(15,2) NOT NULL DEFAULT 0,
  descricao       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO permission_profiles (id, nome, acoes, limite_default, descricao) VALUES
  ('dono_total',         'Dono — acesso total',
     ARRAY['*'],                                    999999999.00,
     'Owner. Bypasses single-signature limits but not 4-eyes critical actions.'),
  ('co_dono',            'Co-dono — acesso total com 4-eyes',
     ARRAY['*'],                                    999999999.00,
     'Spouse-equivalent. Same as dono_total but always counts toward 4-eyes.'),
  ('contador_leitura',   'Contador (leitura)',
     ARRAY['read_balance','read_transactions','read_reports','read_recurrences'],
     0.00,
     'Read-only on assigned entities; can request reports.'),
  ('operador_basico',    'Operador básico',
     ARRAY['read_balance','read_transactions','create_transaction'],
     200.00,
     'Can register low-value transactions on assigned entities.'),
  ('operador_avancado',  'Operador avançado',
     ARRAY['read_balance','read_transactions','create_transaction','schedule_reminder','correct_transaction'],
     1000.00,
     'Can register and correct transactions; lower frequency oversight.'),
  ('leitor',             'Leitor',
     ARRAY['read_balance'],
     0.00,
     'Read-only minimal: balance only.'),
  ('contato',            'Contato (sem acesso a dados)',
     ARRAY[]::TEXT[],
     0.00,
     'May converse with Maia but cannot read any entity data.');
```

The LLM **chooses** a profile id; it never composes the `acoes` array. New profiles only via migration.

### 5.3 Extension — `permissoes`

```sql
ALTER TABLE permissoes
  ADD COLUMN profile_id TEXT REFERENCES permission_profiles(id),
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ativa'
    CHECK (status IN ('ativa', 'suspensa', 'revogada', 'pendente'));

-- Backfill profile_id from existing rows where possible (one-shot migration step)
UPDATE permissoes SET profile_id = 'dono_total' WHERE papel = 'dono';
UPDATE permissoes SET profile_id = 'contador_leitura' WHERE papel = 'contador';
-- ... etc; remaining rows must be reviewed manually before NOT NULL
ALTER TABLE permissoes ALTER COLUMN profile_id SET NOT NULL;

CREATE INDEX idx_permissoes_status ON permissoes (status) WHERE status != 'revogada';
```

Status separation enables: *person stays active, but a specific access is suspended*. See spec 03.

### 5.4 New table — `entity_states`

```sql
CREATE TABLE entity_states (
  entidade_id     UUID PRIMARY KEY REFERENCES entidades(id) ON DELETE CASCADE,
  workflow_atual  UUID REFERENCES workflows(id),
  contexto        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ultima_reconciliacao TIMESTAMPTZ,
  ultimo_briefing TIMESTAMPTZ,
  proximo_vencimento DATE,
  saldo_consolidado NUMERIC(15,2),
  saldo_atualizado_em TIMESTAMPTZ,
  flags           JSONB NOT NULL DEFAULT '{}'::jsonb,    -- e.g. { "fechamento_em_andamento": true }
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This is the *operational live state* per entity — what's "in flight" right now. Distinct from `agent_facts` (stable facts) and `learned_rules` (behavioral).

### 5.5 New table — `pending_questions`

For the confirmation state machine (spec 11). Short-TTL questions live in `conversas.metadata` for speed; multi-party or long-running pendencies use this table.

```sql
CREATE TABLE pending_questions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversa_id     UUID REFERENCES conversas(id) ON DELETE CASCADE,
  pessoa_id       UUID REFERENCES pessoas(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,                          -- 'simple_choice', 'amount_confirmation', 'dual_approval_request', ...
  pergunta        TEXT NOT NULL,
  opcoes_validas  JSONB NOT NULL DEFAULT '[]'::jsonb,     -- closed schema for the answer
  acao_proposta   JSONB NOT NULL,                         -- the intent that will execute on positive answer
  expira_em       TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'respondida', 'expirada', 'cancelada')),
  resposta        JSONB,
  resolvida_em    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_open ON pending_questions (status, expira_em) WHERE status = 'aberta';
CREATE INDEX idx_pending_pessoa ON pending_questions (pessoa_id, status);
```

### 5.6 New table — `idempotency_keys`

See spec 09 for the key formula.

```sql
CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,
  tool_name       TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  pessoa_id       UUID NOT NULL REFERENCES pessoas(id),
  entity_id       UUID NOT NULL REFERENCES entidades(id),
  payload_hash    TEXT NOT NULL,
  file_sha256     TEXT,                                   -- nullable; non-null for attachment-based ops
  resultado       JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_idempotency_created ON idempotency_keys (created_at);
CREATE INDEX idx_idempotency_pessoa ON idempotency_keys (pessoa_id, created_at DESC);

-- Nightly worker: DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days';
```

### 5.7 New table — `system_health_events`

```sql
CREATE TABLE system_health_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  component       TEXT NOT NULL,                          -- 'db','redis','whatsapp','llm','whisper','embedding'
  status          TEXT NOT NULL CHECK (status IN ('ok','degraded','down')),
  duration_ms     INT,
  error           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_health_component_time ON system_health_events (component, created_at DESC);
```

### 5.8 New table — `dead_letter_jobs`

```sql
CREATE TABLE dead_letter_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  queue_name      TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  payload         JSONB NOT NULL,
  error           TEXT NOT NULL,
  attempts        INT NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL,
  last_failed_at  TIMESTAMPTZ NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dlq_unresolved ON dead_letter_jobs (resolved, created_at DESC) WHERE resolved = FALSE;
```

### 5.9 Audit log — taxonomy enforcement

`audit_log.acao` is loose TEXT today. Add a CHECK using a constants list defined in code; failure to match raises an error in the application layer (we do not enforce in DB to allow phased rollout). The full taxonomy is in spec 17.

## 6. Multi-tenant rules (single-tenant discipline)

Every query against an entity-scoped table **must** carry `entidade_id` either as a filter or as part of a join condition tied to the resolved scope of the current `pessoa`. The repository layer enforces this:

```typescript
class TransacaoRepository {
  list(scope: EntityScope, filters: TransacaoFilter): Promise<Transacao[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    return db.select().from(transacoes)
      .where(inArray(transacoes.entidade_id, scope.entidades))
      .where(/* additional filters */);
  }
}
```

A repository method that omits `entidade_id` is a **bug** and is caught by:

- code review (PR template asks "is this entity-scoped?")
- spec 16 — the leak test suite, which asserts every scoped table cannot leak between entities

## 7. LLM Boundaries

The LLM never executes SQL. The LLM never receives raw rows from any table other than what is shaped by repositories into typed DTOs. The LLM is unaware of `idempotency_keys`, `dead_letter_jobs`, `system_health_events`, `audit_log`, or `permission_profiles.acoes`. It sees only:

- The user's profile **id** (e.g., `contador_leitura`) — never the action list.
- Filtered, scoped data via repository return types.
- A summary of the audit/health state if explicitly asked by the owner.

## 8. Behavior & Rules

### 8.1 `escopo_entidades` in `conversas` is a derived cache

The column `conversas.escopo_entidades UUID[]` is *not* the source of truth for what a person can access. It is a denormalized cache, computed at conversation start from `permissoes WHERE pessoa_id = ? AND status = 'ativa'`. It is **invalidated** whenever:

- A `permissoes` row is created, updated to status `ativa`/`suspensa`/`revogada`.
- The `pessoa.status` changes.

Cache invalidation strategy: any change above triggers `UPDATE conversas SET escopo_entidades = NULL` for matching conversations; the next message recomputes.

### 8.2 Foreign key behaviors

| Relationship | ON DELETE | Rationale |
|---|---|---|
| `transacoes.entidade_id` | RESTRICT | Cannot delete entity with transactions |
| `transacoes.conta_id` | RESTRICT | Same |
| `transacoes.conversa_id` | SET NULL | Conversation may be closed; transaction must persist |
| `transacoes.contraparte_id` | SET NULL | Counterpart may be deleted; preserve the transaction |
| `permissoes.pessoa_id` | CASCADE | Removing a person removes their grants |
| `audit_log.*` | RESTRICT (no FK to person, soft ref) | Never lose audit |

### 8.3 Embedding dimension is fixed in the schema

`agent_memories.embedding` is `VECTOR(1024)` to match Voyage. Switching providers to OpenAI 1536-dim requires:

```sql
ALTER TABLE agent_memories DROP COLUMN embedding;
ALTER TABLE agent_memories ADD COLUMN embedding VECTOR(1536);
DROP INDEX idx_memories_embedding;
CREATE INDEX idx_memories_embedding ON agent_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
-- Then: npm run embeddings:rebuild
```

This is a deliberate, audited operation. See spec 08.

### 8.4 Audit triggers

`updated_at` is auto-maintained on entities, accounts, transactions, people, agent_facts, learned_rules, contrapartes, entity_states (extend the existing `trg_set_updated_at` trigger).

## 9. Error cases

| Failure | Behavior |
|---|---|
| Repository called without scope on entity-scoped table | Throws `EmptyScopeError` |
| `permissoes` row inserted with profile_id not in `permission_profiles` | FK constraint violation |
| Transaction inserted with mismatched `entidade_id` and `conta.entidade_id` | Application-layer check raises `EntityScopeMismatch` |
| Pending question expired but worker did not GC | Read path treats as `'expirada'` and does not act |

## 10. Acceptance criteria

- [ ] Migration `002_specs_v1.sql` adds every table and alteration in §5.
- [ ] Every entity-scoped repository method requires a `scope` argument typed as `EntityScope`.
- [ ] `conversas.escopo_entidades` is recomputed (not trusted) on every cold conversation start.
- [ ] Inserting a `permissoes` row without `profile_id` fails (NOT NULL).
- [ ] Leak test (spec 16) passes for every scoped table.

## 11. References

- Spec 03 — permissions (`permission_profiles`, statuses, 4-eyes triggers)
- Spec 08 — memory (embedding rebuild)
- Spec 09 — governance (audit log taxonomy)
- Spec 11 — workflows (pending_questions, dual_approval)
- Spec 16 — testing (entity-leak suite)
- Spec 17 — observability (`system_health_events`, `dead_letter_jobs`)
