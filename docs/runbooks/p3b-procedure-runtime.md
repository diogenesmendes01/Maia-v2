# Runbook — P3b Procedures: Runtime Execution

> Como operar e debugar runtime stateful de procedimentos.

## Quando usar

- Selector escolhendo procedure errada (ou nenhuma quando deveria)
- Execução travada em algum passo
- Step evaluator não avançando quando deveria
- Replay reconstrói state errado a partir de events

## Arquitetura

```
turn start → selector decide → engine.startExecution (se start)
                              → execution_state persiste entre turnos
                              ↓
   ReAct loop normal com prompt builder injetando state ativo
                              ↓
turn end → evaluator checa critério atual
        → engine.advanceStep (se passou) ou nada (espera próximo turno)
        → engine.completeExecution (se passou último step)
```

## Inspecionar execução ativa

```sql
-- Executions ativas
SELECT id, conversa_id, definition_id, current_step_id, last_activity_at
FROM procedure_executions
WHERE status = 'in_progress'
ORDER BY last_activity_at DESC;

-- Events de uma execution específica
SELECT event_type, step_id, created_at, payload
FROM procedure_execution_events
WHERE execution_id = '<uuid>'
ORDER BY created_at;

-- Selector decisions recentes
SELECT decided_at, decision, selected_procedure_id, reason, candidates
FROM procedure_selector_decisions
WHERE conversa_id = '<uuid>'
ORDER BY decided_at DESC LIMIT 20;
```

## Debugar selector escolhendo errado

1. Veja `procedure_selector_decisions.candidates` — confidence de cada candidate
2. Confidence threshold = 0.6 (em `src/cognition/procedure-selector.ts`)
3. Se confidence consistentemente baixa: melhorar `when_apply` tags/conditions na definition
4. Se LLM falha: verifique `cognitive_module_log` por errors em `procedure-selector.*`

## Debugar step não avançando

1. Veja `procedure_execution_events` — qual foi o último `criterion_checked` event?
2. P3b avalia APENAS `machine_check` (regex/substring) e `tool_result`. Outros tipos (llm_judge, user_signal, human_confirmed) viram em P3c — pra esses, step NÃO avança automaticamente.
3. Workaround: forçar advance via SQL ou esperar P3c.

## Reset execução zumbi

```sql
UPDATE procedure_executions 
SET status = 'aborted', notes = 'manual abort - stale', ended_at = now()
WHERE id = '<uuid>';

INSERT INTO procedure_execution_events (tenant_id, agent_id, execution_id, event_type, payload)
VALUES ('default', 'default', '<uuid>', 'execution_aborted', '{"reason":"manual_abort_stale"}'::jsonb);
```

P3c adiciona worker reaper que faz isso automaticamente após TTL.

## Replay state

```typescript
import { replayState } from '@/procedures/engine.js';
const state = await replayState('<execution_id>');
console.log(state); // { current_step_id, completed_steps, status }
```

Útil pra debug de divergência entre `procedure_executions.execution_state` (corrente) e o que events dizem.

## Próximas fases

- **P3c**: métricas + reaper TTL + step evaluator completo (llm_judge, user_signal, human_confirmed)

## Validação completa

```bash
bash scripts/p3b-acceptance-gates.sh
```

Se verde:
```bash
git tag p3b-procedure-runtime-done
git push origin p3b-procedure-runtime-done
```
