# Runbook — wizard de onboarding (issue #519)

Provisionamento administrativo: como retomar, diagnosticar, cancelar e reverter uma jornada.

> Mental model: a saga é DURÁVEL. O estado vive em `onboarding_runs`, não no navegador. Fechar a aba, reiniciar a API, trocar de máquina ou perder a conexão não perde nada — e nenhum comando é executado duas vezes por retry.

## 1. Ligar / desligar

| Variável | Efeito | Default |
|---|---|---|
| `MAIA_ONBOARDING_WIZARD` | Habilita comandos NOVOS e a tela. Desligada, runs existentes continuam LEGÍVEIS e canceláveis | `false` |
| `MAIA_ONBOARDING_BOOTSTRAP` | Abre a rota pública de bootstrap global (primeiro tenant + primeiro admin) | `false` |

As duas exigem restart (`restartRequired: true` no contrato #515). Ver [`docs/configuration.md`](../configuration.md).

## 2. Bootstrap global — a primeira instalação

Substitui o `INSERT INTO app_users (...)` manual.

```bash
# 1. Migrations aplicadas
npm run db:migrate

# 2. Emitir a credencial de uso único (imprime o segredo UMA vez)
npm run bootstrap:credential -- issue --label "deploy inicial" --ttl-hours 2

# 3. Subir o admin-ui com MAIA_ONBOARDING_BOOTSTRAP=true
# 4. Abrir o console e usar o segredo no formulário de bootstrap
# 5. Conferir e DESLIGAR a flag
npm run bootstrap:credential -- status
```

Propriedades que o runbook assume e que os testes travam:

- o segredo nunca chega ao banco em claro — só o SHA-256;
- o consumo é CAS: duas requisições simultâneas com o segredo certo produzem no máximo um bootstrap;
- 5 tentativas erradas trancam a credencial por 15 minutos (o lockout é PERSISTIDO — restart não zera o contador);
- depois do sucesso a porta fecha por construção: passa a existir um `app_users`, e a precondição "nenhuma identidade administrativa" nunca mais é satisfeita.

**Credencial vazada?**

```bash
npm run bootstrap:credential -- revoke --reason "segredo compartilhado em canal errado"
npm run bootstrap:credential -- issue --ttl-hours 1
```

## 3. Diagnóstico de uma run

```sql
-- estado corrente
SELECT id, kind, state, current_step, version, tenant_id, agent_id,
       last_error_code, expires_at, correlation_id
  FROM onboarding_runs
 WHERE id = :run_id;

-- o que a run FEZ, em ordem (append-only)
SELECT created_at, step, event_type, from_state, to_state, error_code, actor_id, summary
  FROM onboarding_events
 WHERE run_id = :run_id
 ORDER BY id;

-- ledger de idempotência: um passo `pending` é uma reivindicação em curso
SELECT step, created_at, result ? '__pending__' AS pendente
  FROM onboarding_step_results
 WHERE run_id = :run_id;

-- a trilha de governança correspondente
SELECT created_at, action, actor_id, actor_role, resource_type, resource_id, change_summary
  FROM admin_audit_log
 WHERE change_summary ->> 'onboarding_run_id' = :run_id
 ORDER BY created_at;
```

## 4. Sintomas e o que fazer

| Sintoma | Causa provável | Ação |
|---|---|---|
| `version_conflict` a cada clique | Duas abas ou dois operadores na mesma run | Recarregue. Nada foi perdido — o CAS impediu o avanço duplo |
| `claim_in_progress` persistente | Uma tentativa anterior morreu no meio | A reivindicação expira sozinha em 2 minutos (`STEP_CLAIM_TTL_MS`) e pode ser tomada. Se persistir, veja se há um processo travado |
| `idempotency_payload_mismatch` | O formulário mudou depois que a tentativa começou | Recarregue a página: a chave é regenerada quando a run avança |
| `readiness_blocked` | Um pré-requisito bloqueante caiu | O painel de prontidão lista o código e a remediação de cada check. Corrija e reavalie — a run volta para `readiness_failed`, que reabre os passos de configuração |
| Run presa em `pairing_pending` | A linha ainda não provou posse | Abra o pareamento e conclua o QR/código. `verified_at` na linha é a prova; nada além dela conta |
| Run presa em `activating` | Interrupção no meio da transição final | Ver §5 |
| Run sumiu da lista | Expirou (`expires_at`) ou terminou | A row NÃO é apagada. Consulte com `include_terminal` ou por SQL |
| `step_out_of_order` | A UI está numa versão antiga da run | Recarregue |

## 5. Run presa em `activating`

`activating` é a INTENÇÃO durável de ativar, gravada antes da reavaliação de prontidão. Uma run presa nesse estado significa que o processo caiu entre `beginActivation` e `finishActivation`.

```sql
SELECT id, tenant_id, agent_id, updated_at
  FROM onboarding_runs
 WHERE state = 'activating';
```

Para cada uma, verifique se o agente chegou a ser ativado:

```sql
SELECT id, tenant_id, status FROM agents WHERE id = :agent_id AND tenant_id = :tenant_id;
```

- **Agente `active`** — a transição completou e a run não foi atualizada (improvável: as duas escritas estão no mesmo commit). Investigue antes de mexer.
- **Agente `paused`** — a ativação NÃO aconteceu. Devolva a run para reavaliação:

```sql
UPDATE onboarding_runs
   SET state = 'readiness_failed', current_step = 'readiness',
       version = version + 1, last_error_code = 'activation_interrupted',
       updated_at = now()
 WHERE id = :run_id AND state = 'activating';
```

Depois disso o operador reavalia a prontidão e ativa de novo pelo console. Não ative por SQL: o `UPDATE agents SET status='active'` à mão pula a reavaliação e não escreve a auditoria com os fingerprints.

## 6. Cancelamento e compensações

O cancelamento é deliberadamente CONSERVADOR:

- **encerra** a sessão de pareamento em curso (recurso efêmero, só desta run) e **revoga** a credencial de bootstrap viva;
- **não apaga** tenant, administrador, agente, papel ou canal — são recursos que podem já estar em uso, e compensação cega sobre recurso compartilhado é proibida pela issue;
- o agente permanece `paused`: existe, é diagnosticável, e não atende;
- eventos e auditoria permanecem, sempre.

Uma run cancelada não é retomada implicitamente. Para continuar, abra outra — os passos já concluídos serão ADOTADOS pelos comandos correspondentes quando a identidade bater.

## 7. Expiração

`expires_at` default: 7 dias. Uma run vencida:

- **recusa comandos** imediatamente (`run_expired`) — isso não depende de sweep;
- é marcada `failed_terminal` pelo sweep preguiçoso, que roda quando alguém tenta abrir uma run nova para o mesmo escopo. Isso libera o índice parcial `onboarding_runs_active_scope_uq` (uma run viva por `tenant_id + agent_id`);
- continua DIAGNOSTICÁVEL: nada é apagado.

## 8. Rollback

1. `MAIA_ONBOARDING_WIZARD=false` + restart — impede runs e comandos NOVOS.
2. Leitura, diagnóstico e cancelamento continuam funcionando (verificado por teste).
3. **Não** apague as tabelas nem os eventos. As migrations 113/114 têm `_down`, mas o down descarta a evidência — use só para reverter um deploy de desenvolvimento.
4. Verifique que nenhuma run ficou em `activating` (§5).
5. Fingerprints e auditoria são preservados: a `admin_audit_log` do `agent_activation_approved` carrega `configuration_fingerprint` e `schema_fingerprint`, que é o que permite provar DEPOIS o que exatamente foi aprovado.

## 9. Métricas

| Métrica | Rótulos | O que observar |
|---|---|---|
| `maia_onboarding_run_started_total` | `kind` | Volume de jornadas |
| `maia_onboarding_step_completed_total` | `step` | Onde as jornadas param (o passo com menos completions é o gargalo) |
| `maia_onboarding_step_failed_total` | `step`, `reason` | `reason=readiness_blocked` concentrado num passo indica configuração faltando |
| `maia_onboarding_idempotency_replay_total` | `step` | Replays altos = cliente perdendo respostas (timeout de proxy?) |
| `maia_agent_readiness_failed_total` | `check_code` | Qual pré-requisito mais bloqueia a frota |
| `maia_bootstrap_attempt_total` | `result` | `result=invalid` repetido = tentativa de força bruta |

Nenhuma delas carrega id de run, nome de tenant, e-mail ou telefone — a política de rótulos de `src/observability/taxonomy.ts` rejeita por construção.

## 10. Referências

- Módulo: [`docs/architecture/modules/onboarding.md`](../architecture/modules/onboarding.md)
- Pareamento de linha: [`docs/runbooks/line-ownership-duplicates.md`](line-ownership-duplicates.md)
- Contrato de configuração: [`docs/runbooks/config-contract.md`](config-contract.md)
- Migrations: `migrations/113_onboarding_runs.sql`, `migrations/114_bootstrap_credentials.sql`
