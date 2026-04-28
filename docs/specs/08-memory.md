# Spec 08 — Memory: Five Layers, Embeddings & Self-State

**Status:** MVP Core • **Phase:** 1 • **Depends on:** 00, 01, 02, 06

---

## 1. Purpose

Maia's intelligence is in the system, not in the LLM. This spec defines the five memory layers, the rules for what goes where, the multi-provider embedding abstraction, and the hybrid evolution of `self_state`.

## 2. Goals

- Five distinct memory layers, each with a precise role.
- Memory queries return scoped, typed DTOs — never raw rows to the LLM.
- Multi-provider embeddings with a fixed-dimension schema and a documented re-embed path.
- Hybrid `self_state`: owner controls the system prompt; Maia maintains `resumo_aprendizados` automatically.
- Predictable token budget for context injection.

## 3. Non-goals

- A general-purpose RAG framework. The specific layered design beats generic RAG here.
- Cross-tenant memory. Single-tenant.
- Online fine-tuning of embeddings.

## 4. Architecture — the five layers

| # | Layer | Storage | Retention | What lives here |
|---|---|---|---|---|
| 1 | **Working** | Redis (TTL 1h–24h) | hours | Active conversation buffer, last N messages, in-flight token counters |
| 2 | **Episodic** | Postgres tables: `mensagens`, `transacoes`, `audit_log`, `workflows` | indefinite | Time-stamped events |
| 3 | **Semantic** | `agent_facts` | indefinite | Stable facts about the world ("Empresa 3 closes balance on day 5") |
| 4 | **Procedural** | `learned_rules` | until banned | If-then rules: classification, behavior |
| 5 | **Vector** | `agent_memories` (pgvector) | indefinite | Embedding-indexed text for similarity recall |

### 4.1 Cross-layer routing

When the agent observes a new fact, the layer is chosen by **kind**:

```
Time-bound event       → Episodic (insert into the relevant table)
Stable fact ("X is Y") → Semantic (agent_facts)
Behavioral rule        → Procedural (learned_rules)
Free-form recall hook  → Vector (agent_memories)
```

A single observation may write to multiple layers. Example: a user correction creates both a `learned_rules` row (procedural) and an `agent_memories` row with the conversation text (vector) for future recall.

## 5. Layer 1 — Working memory (Redis)

Keys (prefix `maia:`):

```
working:conv:<conversa_id>:messages   List<{role,content,timestamp}> — last N (default 20), TTL 24h
working:conv:<conversa_id>:tokens     Counter — input/output tokens consumed in the active turn
working:turn:<request_id>:plan        JSON — planning state during a workflow turn, TTL 30min
working:dedup:whatsapp:<id>           '1' — message dedup, TTL 24h
working:rate:<pessoa_id>:hour         sliding window counter, TTL 1h
```

When Redis is unavailable (per spec 17 Redis-down policy), the working memory falls back to:

- `mensagens` table for message history (slower but durable).
- An in-memory counter for tokens (lost on crash but acceptable).
- Disabled rate limiting (allowed for owners only).

## 6. Layer 2 — Episodic memory (Postgres)

This is the Postgres tables themselves. The agent reads via repositories with the canonical filters: `entidade_id IN scope`, optional date range, type filter. The repository returns a typed DTO. Examples:

```typescript
async function recentMessages(scope: ConversaScope, n = 10): Promise<Mensagem[]>;
async function recentTransactions(scope: EntityScope, n = 20): Promise<Transacao[]>;
async function auditTrail(filter: AuditFilter): Promise<AuditEntry[]>;
```

Episodic memory is **never** vectorized in bulk — that would explode storage. Specific events (a user correction, a workflow result) are *also* written to `agent_memories` selectively.

## 7. Layer 3 — Semantic memory (`agent_facts`)

Schema (per spec 02): `id`, `escopo`, `chave`, `valor` (JSONB), `confianca`, `fonte`, `ultima_validacao`, `created_at`, `updated_at`. UNIQUE on `(escopo, chave)`.

### 7.1 Escopo grammar

```
'global'                   — facts that apply to everyone
'entidade:<UUID>'          — facts about a specific entity
'pessoa:<UUID>'            — facts about a specific person (preferences, mental model)
```

### 7.2 Common fact keys (registered, validated)

| Chave | Escopo | Valor shape | Example |
|---|---|---|---|
| `preferencia.briefing.horario` | `pessoa:UUID` | `{ horario: 'HH:MM' }` | `{ horario: '08:00' }` |
| `preferencia.tom` | `pessoa:UUID` | `{ tom: string }` | `{ tom: 'direto' }` |
| `entidade.fechamento.dia` | `entidade:UUID` | `{ dia: number }` | `{ dia: 5 }` |
| `entidade.contador.contato` | `entidade:UUID` | `{ pessoa_id: UUID }` | |
| `cost.daily.<pessoa>.<YYYY-MM-DD>` | `pessoa:UUID` | `{ tokens: number; usd_cents: number }` | (counter) |

The `chave` schema is a registered TypeScript type; `save_fact` tool validates against it. Unknown keys are accepted but flagged as `fonte='inferido'` for owner review.

## 8. Layer 4 — Procedural memory (`learned_rules`)

### 8.1 Rule types

```
'classificacao'           — descricao pattern → categoria
'identificacao_entidade'  — descricao pattern → entidade
'tom_resposta'            — context → tone (formal/casual/etc.)
'recorrencia'             — repeated pattern → recurrence proposal
```

### 8.2 Rule lifecycle (probationary)

| Phase | Status | confiança | Behavior |
|---|---|---|---|
| Birth | `probatoria` | 0.50 | Applied with explicit "I'm using rule R-042" message |
| Promotion | `ativa_firme` | ≥ 0.80 | Applied silently |
| Demotion | `desativada` | ≤ 0.30 | Not applied; can be reactivated by owner |
| Ban | `banida` | n/a | Permanently inactive; owner-only command |

Promotion conditions (whichever fires first):

- 4 consecutive `acertos` (no errors in between)
- 10 days elapsed since creation with at least 1 acerto and no `erros`

Demotion conditions:

- 2 `erros` during probation (immediate)
- More general: `confianca < 0.30`

### 8.3 Owner override commands

```
"Maia, marca essa regra como firme"     → status='ativa_firme', confianca=1.00
"Maia, desativa essa regra pra sempre"  → status='banida', ativa=false
"Maia, esquece o que aprendeu hoje"     → bulk demote rules created in last 24h
```

Implemented as meta-commands handled by the agent loop dispatcher (spec 06).

### 8.4 Rule application

Before classifying or identifying, the agent reads applicable rules from `learned_rules`:

```sql
SELECT * FROM learned_rules
WHERE ativa = TRUE
  AND tipo = 'classificacao'
  AND contexto_jsonb @> jsonb_build_object('entidade_id', $entidade_id)
ORDER BY confianca DESC, updated_at DESC
LIMIT 50;
```

Top matches are passed to the LLM; backend records which rules influenced the answer (`mensagens.metadata.rules_applied`). User corrections decrement matched rules' `confianca`.

## 9. Layer 5 — Vector memory (`agent_memories` + pgvector)

### 9.1 Schema

Per spec 02. Column `embedding VECTOR(EMBEDDING_DIMENSIONS)`. ivfflat index with cosine distance.

### 9.2 What gets vectorized

```
write_to_vector?(item):
  if item.tipo == 'mensagem' && (
       item.is_correction || item.has_attachment_parsed || item.workflow_completion
     ): yes
  if item.tipo == 'transacao' && item.was_corrected: yes
  if item.tipo == 'reflexao': yes
  if item.tipo == 'briefing_response': no  (too many)
  default: no
```

Selective vectorization keeps the table at ~10k rows/year.

### 9.3 Embedding provider abstraction

```typescript
interface EmbeddingProvider {
  name: 'voyage' | 'openai' | 'cohere';
  modelId: string;
  dimensions: number;
  costPer1kTokens: number;

  embed(texts: string[]): Promise<number[][]>;
}
```

Selection:

```typescript
function getEmbeddingProvider(): EmbeddingProvider {
  switch (config.EMBEDDING_PROVIDER) {
    case 'voyage': return new VoyageProvider(config.VOYAGE_API_KEY!, config.EMBEDDING_MODEL);
    case 'openai': return new OpenAIEmbeddingProvider(config.OPENAI_API_KEY!, config.EMBEDDING_MODEL);
    case 'cohere': /* ... */
  }
}
```

The provider's `dimensions` **must equal** `config.EMBEDDING_DIMENSIONS`. Startup check:

```typescript
if (provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
  throw new Error(`Embedding provider dimensions ${provider.dimensions} mismatch config ${config.EMBEDDING_DIMENSIONS}`);
}
```

### 9.4 Switching provider — the rebuild path

1. Decide new dimensions (e.g., 1536 for OpenAI).
2. Author migration `XXX_resize_embedding.sql` to drop column and recreate with new dimension; recreate index.
3. Update `.env` (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`).
4. Run `npm run embeddings:rebuild` — script reads all `agent_memories`, embeds in batches, `UPDATE` row by row.
5. During rebuild: read path serves vector recall with degraded results (top-K may be incomplete) but does not fail.

### 9.5 Recall

```sql
SELECT id, conteudo, tipo, escopo, metadata, ref_tabela, ref_id,
       1 - (embedding <=> $1) AS score
FROM agent_memories
WHERE escopo = ANY($2)
  AND ($3::TEXT IS NULL OR tipo = ANY($3))
ORDER BY embedding <=> $1
LIMIT $4;
```

`<=>` is cosine distance; `1 - distance` is similarity. Default K=5; max K=20 to bound prompt size.

### 9.6 Cost monitoring

Every embed call increments `agent_facts['cost.daily.embedding.<YYYY-MM-DD>']`. Spec 17 alerts when daily exceeds $1.

## 10. Self-state — hybrid evolution

### 10.1 Two columns, two owners

| Column | Owner | Update path |
|---|---|---|
| `self_state.system_prompt` | The human owner | PR + commit + migration that bumps `versao` |
| `self_state.resumo_aprendizados` | Maia (automated) | Append-only via reflection trigger B (workflow completion) |

The LLM **never** writes `system_prompt`. Migration script for a new version:

```sql
INSERT INTO self_state (versao, system_prompt, resumo_aprendizados, ativa)
VALUES (
  (SELECT COALESCE(MAX(versao), 0) + 1 FROM self_state),
  $new_prompt_text,
  '',
  TRUE
);
UPDATE self_state SET ativa = FALSE WHERE versao < (SELECT MAX(versao) FROM self_state);
```

The active row drives the system prompt block in the prompt builder (spec 06 §6.1).

### 10.2 `resumo_aprendizados` content

Append-only, time-stamped lines:

```
[2026-04-12] Aprendi que o Mendes prefere consultar saldo antes de lançar despesas > R$ 1k.
[2026-04-15] Empresa 3 fecha balancete dia 5; Carlos é o contador responsável.
[2026-04-22] PIX para "GLOBAL FOO LTDA" tem aparecido com vírgula em outras descrições — uniformizei.
```

Cap: 50 lines (older are truncated). The text is injected into the prompt as a small block under `Resumo de aprendizados desta versão`.

### 10.3 Rollback

To roll back to a previous version:

```sql
UPDATE self_state SET ativa = TRUE WHERE versao = $target;
UPDATE self_state SET ativa = FALSE WHERE versao != $target;
```

Audit logged with reason. Reversible.

## 11. LLM Boundaries

The LLM may:

- Read its own system prompt (ambient).
- Read scoped facts, rules, and recent vector matches as injected.
- Propose new facts (`save_fact`), new rules (reflexion), and embeddings (write transparent to LLM).

The LLM may not:

- Edit `self_state` directly.
- Read `agent_facts` for escopos outside the current scope.
- Issue raw SQL or vector queries; only via repositories.
- Demote or ban a rule on its own — owner override required.

## 12. Behavior & Rules

### 12.1 Memory injection budget

Per spec 06 §6.2, blocks 8–11 collectively are 2500 tokens. Distribution policy:

- Recent learned rules (relevance score sorted): 800 tokens
- Semantic facts (relevant to scope): 600 tokens
- Entity states (in-scope only): 600 tokens
- World snapshot (balances, dues): 500 tokens

Truncation marker emitted when exceeded. The LLM can call `recall_memory` to pull more if needed.

### 12.2 Rule announcement on first probationary use

When the agent applies a probationary rule, it includes a transparent line:

```
"Vou aplicar a regra R-042 (descricao 'aluguel'→categoria Aluguel),
 aprendida em 03/04. Se estiver errado, me corrige."
```

After promotion to `ativa_firme`, the announcement stops.

### 12.3 Vector memory write timing

Async, never on the critical path. After a turn completes, a job is enqueued: `embedQueue.add('embed', { memory_id })`. If embedding fails, the row stays with `embedding=NULL` and is retried by a worker.

## 13. Error cases

| Failure | Behavior |
|---|---|
| Embedding provider returns wrong dimensions | Hard error at startup; refuse to begin |
| Vector index corrupted | Recall returns empty (no error to LLM); alert; rebuild offline |
| `save_fact` call with chave outside known list | Accepted with `fonte='inferido'`; surfaced in nightly review |
| Rule promotion ambiguity (acertos == errors == 0 for 30 days) | Auto-archive with `desativada` |

## 14. Acceptance criteria

- [ ] Five layers exist with documented entry points.
- [ ] Switching `EMBEDDING_PROVIDER` from voyage to openai requires only env + migration + rebuild script; no code edit.
- [ ] A correction increments rule `erros` and decreases `confianca` by 0.20.
- [ ] Promotion fires after 4 consecutive acertos.
- [ ] System prompt cannot be modified at runtime by any code path other than the migration.
- [ ] Vector recall returns top-5 in < 100ms p95 on 10k rows.

## 15. References

- Spec 02 — schemas
- Spec 06 — prompt builder consumption of memory blocks
- Spec 09 — rule lifecycle and owner overrides
- Spec 12 — nightly batch reflection (writes to procedural & vector)
- Spec 17 — cost monitoring on embed
