# Runbook — P1 Reflexão Expandida

> Como operar e debugar a pipeline de reflexão da Maia v2.

## Quando usar este runbook

- Reflexão não gerando candidatos esperados
- Falha de classifier (zod parse error)
- Padrões não sendo detectados pelo worker batch
- Acumulação inesperada de `cognitive_candidates` pendentes
- Debug de cost/latência de chamadas LLM em reflexão

## Pipeline de reflexão (overview)

```
Evento (correction/success/conversation_closed/pattern/gap)
  ↓
Reflector (LLM call via runCognitiveModule) → insight bruto
  ↓
Classifier (LLM call) → ClassifiedCandidate (6 tipos)
  ↓
Persister → destino tipado:
  - fato → agent_facts (existente)
  - regra → learned_rules (existente)
  - procedimento/lacuna/tool_request → cognitive_candidates (queue)
  - descarte → log only
```

## Triggers e sua origem

| Trigger | Onde dispara |
|---|---|
| USER_CORRECTION | `src/agent/reflection.ts` (detectCorrection) |
| SUCCESS_EXPLICIT | `src/agent/core.ts` (detectSuccess no inbound) |
| CONVERSATION_CLOSED | `src/workers/conversation-summarizer.ts` (após close) |
| PATTERN_DETECTED | `src/workers/pattern-detector.ts` (cron diário 04h UTC) |
| INTERNAL_GAP | `src/agent/react-loop.ts` (detectGap na resposta) |

## Inspecionar reflexão em runtime

```sql
-- Eventos de cada módulo cognitivo
SELECT module_name, status, count(*), avg(latency_ms)::int AS avg_ms
FROM cognitive_module_log
WHERE created_at >= now() - interval '1 hour'
GROUP BY module_name, status
ORDER BY count DESC;

-- Candidates pendentes na queue
SELECT candidate_type, count(*), max(created_at) AS most_recent
FROM cognitive_candidates
WHERE status = 'pending'
GROUP BY candidate_type;

-- Últimas regras aprendidas
SELECT created_at, contexto, acao
FROM learned_rules
ORDER BY created_at DESC
LIMIT 10;
```

## Debugar classifier falhando

Classifier retorna `null` quando:
1. LLM não retornou JSON parseável (`text.match(/\{[\s\S]*\}/)` falhou)
2. Zod schema rejeitou (campos faltando ou tipo errado)

Inspecionar:
```sql
SELECT * FROM cognitive_module_log
WHERE module_name = 'classifier' AND status != 'success'
ORDER BY created_at DESC LIMIT 20;
```

Soluções comuns:
- Ajustar prompt do classifier (`src/cognition/classifier.ts`) pra forçar JSON mais consistente
- Verificar se o `temperature: 0.0` continua sendo respeitado
- Considerar fallback: se classifier falha 3x seguidas pro mesmo insight, marca como 'descarte'

## Acumulação de candidates pendentes

`cognitive_candidates` é queue pra P2-P5 consumirem. Se acumula:
- procedimento → P3 consumirá
- lacuna → P2/P5 consumirão  
- tool_request → P5 consumirá

Durante a vida do P1 (antes de P2 começar), a queue cresce — esperado.

## Pattern detector não detectando

Verificar:
1. Cron `pattern_detector` está rodando? (`SELECT * FROM cognitive_module_log WHERE module_name = 'reflector.pattern_detected' ORDER BY created_at DESC LIMIT 5;`)
2. `MIN_OCCURRENCES = 3` — se padrões repetem menos, não dispara
3. Janela é 24h — padrões antigos não contam

## Métricas a observar

- Latência p95 de `reflector.*` (não deve ser > 10s)
- Latência p95 de `classifier` (não deve ser > 8s)
- % de candidatos `descarte` (alto = classifier conservador demais? prompt ruim?)
- Cost diário em `reflector.*` + `classifier` (controlar budget)

## Validação completa de P1

```bash
bash scripts/p1-acceptance-gates.sh
```

Se todos os gates passarem:

```bash
git tag p1-reflection-done
git push origin p1-reflection-done
```
