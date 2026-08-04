# Runbook — saga de onboarding (issue #519)

Como retomar, diagnosticar, cancelar e reverter uma run de provisionamento.
Contexto e desenho: [`docs/architecture/modules/onboarding.md`](../architecture/modules/onboarding.md).

Três tabelas: `onboarding_runs` (estado corrente), `onboarding_events`
(histórico append-only) e `onboarding_step_results` (ledger de idempotência).
Nenhuma delas guarda segredo, telefone, e-mail ou QR — se você precisa desses
dados para diagnosticar, você está olhando o lugar errado (veja
`channel_line_state` para pareamento, `admin_audit_log` para quem fez o quê).

## 1. "Onde está a run?"

```sql
SELECT id, kind, tenant_id, agent_id, state, current_step, version,
       last_error_code, created_by, expires_at
  FROM onboarding_runs
 WHERE state NOT IN ('active','cancelled','failed_terminal')
 ORDER BY updated_at DESC;
```

O histórico de UMA run, na ordem em que aconteceu:

```sql
SELECT created_at, step, event_type, from_state, to_state, actor_id, summary
  FROM onboarding_events
 WHERE run_id = :run_id
 ORDER BY created_at;
```

Leitura dos `event_type`:

| Evento | Significa |
|---|---|
| `step_completed` | o passo commitou (recurso + ledger + evento + auditoria, juntos) |
| `step_replayed` | retry com a MESMA chave; o resultado veio do ledger, nada re-executou |
| `step_denied` | o BACKEND recusou (readiness reprovado, papel ausente, escopo divergente). Não é bug |
| `step_failed` | falha de infraestrutura |
| `run_expired` | a varredura de TTL encerrou a run |

## 2. Retomar

Uma run é retomável por construção: o estado está no banco, não em memória.
Reinício de API, de worker ou de deploy não perde nada.

Para retomar, o operador precisa de **três coisas**: o `run_id`, a `version`
atual e o próximo passo legal. Os passos legais a partir do estado corrente
vêm do backend — `getOnboardingRun` devolve `allowed_steps`. Não deduza a lista
lendo esta página; ela pode ficar velha, o backend não.

```
executeOnboardingStep({ run_id, step, payload, idempotency_key, expected_version, actor })
```

**A chave de idempotência é conservada até um resultado conclusivo.** Se você
não sabe se o comando anterior commitou, repita com a MESMA chave: ou ele roda
(nada tinha commitado) ou volta `replayed: true` com o resultado persistido.
Gerar uma chave nova nessa situação é o erro clássico — você recebe
`invalid_transition` e fica sem saber o que aconteceu.

### Sintomas e o que fazer

| Sintoma | Causa | Ação |
|---|---|---|
| `version_conflict` | outro operador (ou outra aba) avançou a run | Releia a run, confira o estado e refaça com a `version` nova |
| `idempotency_payload_mismatch` | a mesma chave foi reusada com outro payload | Gere uma chave nova **para a nova intenção**. Se o payload antigo era o certo, repita-o com a chave antiga |
| `invalid_transition` | o passo não é legal a partir do estado atual | Leia `allowed_steps`. Normalmente o passo já commitou |
| `run_expired` | passou de `expires_at` | Cancele e abra uma run nova. Os recursos já criados permanecem |
| `readiness_blocked` | checks bloqueantes vermelhos | Cada check traz `remediation`. Corrija e rode `evaluate_readiness` de novo |
| `run_terminal` | `active` / `cancelled` / `failed_terminal` | Runs terminais não são retomadas. Abra uma nova |

## 3. Readiness reprovado

`evaluate_readiness` leva a run a `readiness_failed` e devolve o relatório com
`code` + `message` + `remediation` por check. É o MESMO relatório que o
`maia doctor` mostra e que a ativação reavalia — não existe um segundo critério.

Os vermelhos mais comuns num onboarding novo:

| Check | Remediação |
|---|---|
| `profile_active` | aprove e ative a versão do profile (o passo `configure_profile` faz isso) |
| `default_role_resolved` | exatamente UM papel `is_default` + `active`. Dois papéis default é ambiguidade, não redundância |
| `channel_policy_role_active` | o papel padrão da política foi desativado. Reative-o ou reaponte a política |
| `channel_ownership_proven` | a linha não concluiu o pareamento. Veja `channel_line_state.state` |
| `schema_ready` | `npm run db:migrate` |
| `governance_no_blocking_pending` | há alerta de drift `critical` sem `resolved_at` para o agente |

Depois de corrigir, rode `evaluate_readiness` novamente — é um passo repetível
e é assim que o ciclo corrigir→reavaliar funciona.

## 4. Cancelar

```
cancelOnboardingRun({ run_id, expected_version, actor, reason_code })
```

O que o cancelamento faz: encerra a run em `cancelled`, grava o motivo em
`last_error_code` e registra evento + auditoria.

O que ele **não** faz: desprovisionar. Isso é deliberado. Nenhum recurso criado
pela saga é exclusivo dela — o tenant, o agente ou a linha podem já estar em uso
por outro caminho — e a issue proíbe compensação cega sobre recurso
compartilhado. Para remover um recurso, use a superfície própria dele (suspender
o tenant, desativar o canal), com a auditoria daquele caminho.

Auditoria e eventos **nunca** são apagados: `onboarding_events` tem
`ON DELETE RESTRICT` sobre a run justamente para tornar impossível apagar uma
run com histórico.

Uma run cancelada não volta. Abra uma nova — o índice parcial de "uma run viva
por (tenant, agente)" só considera estados não terminais, então isso é
permitido.

## 5. Runs abandonadas

`onboardingRunsRepo.expireStale()` marca `cancelled` com
`last_error_code='expired'` toda run passada de `expires_at`. Ela continua
legível e diagnosticável — nunca é apagada. O TTL default é 7 dias
(`DEFAULT_RUN_TTL_MS`).

Não há worker agendado chamando isso ainda; hoje é invocação manual ou por
tarefa operacional.

## 6. Rollback

A ordem importa.

1. **Pare as runs novas.** Não há feature flag ainda: bloqueie a superfície que
   chama `startOnboardingRun`.
2. **Verifique se alguma run ficou em `activating`** — é a checagem que a issue
   exige antes de qualquer rollback:

   ```sql
   SELECT id, tenant_id, agent_id, updated_at FROM onboarding_runs WHERE state = 'activating';
   ```

   Uma run aí significa ativação commitada parcialmente. Investigue
   `admin_audit_log` e `agents.status` antes de prosseguir.
3. **Não apague tabelas nem eventos.** Runs existentes continuam legíveis e
   podem ser concluídas ou canceladas normalmente — o módulo não altera nenhum
   caminho de provisionamento anterior.
4. **Só então**, se realmente necessário, `migrations/109_onboarding_runs_down.sql`.
   Ele derruba as três tabelas e **não** desprovisiona nada: tenants, agentes,
   profiles, papéis, políticas e canais criados por uma run permanecem. O
   sistema volta ao provisionamento manual router-a-router.

O readiness canônico **não** precisa de rollback: ele é somente-leitura e não
substituiu nenhum cálculo anterior — o dashboard e o go-live checklist do
console continuam com a lógica que já tinham.
