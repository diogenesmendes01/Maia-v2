# Runbook — P2 Memory Scoping + Self-Model

> Como operar e debugar memória contextual e self-model da Maia v2.

## Quando usar

- Memória sensível aparecendo literal no prompt (vazamento!)
- Self-model com confidence travado em 0
- Acumulação grande de `needs_review=true` em memory_entry
- Behavioral hints sendo rejeitados pelo validator
- Worker `legacy-memory-reclassifier` ou `confidence-recompute` falhando

## Estrutura de memória (P2)

```
memory_entry (todas as memórias com 6 controles)
  ├── operational  → scope=agent, mention=true, proactive=true
  ├── preference   → scope=interlocutor, mention=true, proactive=true
  ├── personal     → scope=role, mention=false até user trazer, ttl=30
  ├── sensitive    → scope=conversation, mention=NUNCA, ttl=7
  └── unknown      → needs_review=true (legacy migrado, aguarda reclassifier)

behavioral_hint (derivado de memórias sensíveis)
  └── Único derivado de sensitive que entra no prompt; nunca revela conteúdo
```

## Self-model (capabilities)

```
agent_capabilities_domain
  └── Por domínio (general, comercial, financeiro, ...): success/failure/confidence

agent_capabilities_skill
  └── Por skill específico (preview pra P3+)

agent_capability_gaps
  └── Lacunas observadas; consome 'lacuna' candidates do P1 pipeline
```

## Inspecionar memória em runtime

```sql
-- Memórias ativas por interlocutor
SELECT memory_type, scope_type, mention_allowed, expires_at, count(*)
FROM memory_entry
WHERE needs_review = false
GROUP BY memory_type, scope_type, mention_allowed, expires_at
ORDER BY count DESC;

-- Hints ativos (não revogados, não expirados)
SELECT scope_type, subject_id, hint_text, expires_at
FROM behavioral_hint
WHERE revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
ORDER BY created_at DESC;

-- Capabilities atuais
SELECT domain, confidence, success_count, failure_count, last_failure
FROM agent_capabilities_domain
ORDER BY confidence DESC;

-- Gaps por nível
SELECT current_level, count(*), array_agg(capability_description ORDER BY frequency_score DESC)
FROM agent_capability_gaps
GROUP BY current_level;
```

## Debugar memória sensível vazando

Se você ver conteúdo sensível literal no prompt:
1. Verifique `memory_entry.mention_allowed` da memória — deve ser `false`
2. Verifique `src/agent/prompt-builder.ts` — filtro `mentionableMemories = usableMemories.filter((m) => m.mention_allowed)` está aplicado?
3. Veja se o conteúdo está vindo via `behavioral_hint` (que SIM entra) — mas o hint_text não deve revelar conteúdo

## Debugar self-model travado

Se `confidence` está em 0 ou não atualiza:
1. Verifique `agent_capabilities_domain.evidence_count > 0` (zero → confidence = 0 sempre)
2. Roda manualmente o `confidence-recompute` worker pra forçar atualização
3. Cheque se `recordSuccess`/`recordFailure` estão sendo chamados (logs `capability_tracker.*`)

## Migration de legacy facts

A migration 017 (`017_p2_migrate_legacy_facts.sql`) move `agent_facts` antigo pra `memory_entry` com:
- `memory_type = 'unknown'`
- `needs_review = true`
- `mention_allowed = false` + `proactive_use = false` (bloqueado até reclassifier)

O worker `legacy-memory-reclassifier` (cron 03h UTC) processa em batches de 100, chama `memory-classifier` LLM, atualiza com classificação real.

Pra forçar reclassificação:
```bash
# Aplica manualmente via worker (cron diário também roda)
node -e "import('./dist/workers/legacy-memory-reclassifier.js').then(m => m.runLegacyMemoryReclassifier())"
```

## Métricas a observar

- `count(*) WHERE needs_review=true` deve cair com tempo (worker processando)
- `count(*) WHERE memory_type='sensitive'` — quantas memórias sensíveis ativas
- `count(*) FROM behavioral_hint WHERE revoked_at IS NULL` — hints ativos
- Latência p95 de `memory-classifier` e `behavioral-hint-deriver` em `cognitive_module_log`
- Capabilities confidence trending (sobe com sucessos, cai com falhas recentes)

## Validação completa de P2

```bash
bash scripts/p2-acceptance-gates.sh
```

Se todos os gates passarem, tag:

```bash
git tag p2-memory-self-model-done
git push origin p2-memory-self-model-done
```
