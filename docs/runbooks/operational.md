# Maia — runbook operacional

Cenários comuns + ações concretas. Fluxo: detecte (alerta? log? métrica?) → diagnostique → mitigue → registre.

> **Antes de qualquer ação destrutiva**, snapshot do DB: `npm run backup` (ou aguardar o `nightly_backup` 03:00 BRT — ver `src/workers/backup.ts`).

---

## 1. WhatsApp pareou? Como verificar / re-parear

**Sinal**: `/health/whatsapp` retorna `{ ok: false }`, métrica `maia_baileys_connected=0`, ou audit `whatsapp_disconnected` repetido.

**Diagnóstico rápido**:

```bash
ssh maia 'tail -50 /var/log/maia.log | grep baileys'
# Procurar: 'baileys.connection_closed', 'baileys.logged_out', 'setup.recovery_*'
```

**Caso 1 — disconnect transiente** (Wi-Fi/celular caiu): processo religa sozinho em ~5s. Espere 30s e cheque de novo. Se persistir, vá pro Caso 2.

**Caso 2 — LoggedOut**: o auto-recovery deveria ter rotacionado o token e mandado alerta. Se você não recebeu o alerta:

```bash
ssh maia 'cat .baileys-auth/setup-token.txt'   # NOVO token (já rotacionado pelo recovery)
# Browser → https://maia.SEU-DOMINIO.com/setup?token=<TOKEN>
# Clique "QR" ou "Código de 8 dígitos"
```

**Caso 3 — recovery travou**: verifique no `audit_log` se `pairing_recovery_started` apareceu sem `pairing_recovery_completed`:

```sql
SELECT acao, created_at FROM audit_log
WHERE acao IN ('pairing_recovery_started', 'pairing_recovery_completed')
ORDER BY created_at DESC LIMIT 10;
```

Se travou, SSH manual:

```bash
ssh maia
sudo systemctl stop maia
rm -rf /opt/maia/.baileys-auth
sudo systemctl start maia
# Aguarde 'setup.bootstrap_token_ready' no log, depois fluxo normal de /setup.
```

**Audit log relacionado**: `pairing_recovery_started`, `pairing_recovery_completed`, `pairing_logged_out`, `setup_token_rotated`.

> Quando a PR #24 (audit_watcher) for mergeada, a regra `pairing_recovery_stuck` dispara alerta automático após 1 min sem `_completed`.

---

## 2. WhatsApp rate-limit (banimento temporário do número Maia)

**Sinal**: erros `too many requests` ou `connection refused` repetidos do socket Baileys, mensagens não saem.

**Mitigação**:

1. **Reduzir tráfego de saída imediatamente**: `FEATURE_OUTBOUND_VOICE=false`, `FEATURE_PDF_REPORTS=false`, `FEATURE_PROACTIVE_MESSAGES=false` no `.env`, restart.
2. **Pausar workers que mandam mensagem**: edite `src/workers/index.ts`, pule `briefing_*` e qualquer worker que faça `sendOutbound*`.
3. **Espere 24-48h** sem tráfego de saída. WhatsApp não publica curva de unban; fica observando.
4. **Re-pareie** quando voltar (provável que o número precise re-parear).

**Prevenção**: hard limit em `RATE_LIMIT_MSGS_PER_HOUR` (default 30) já protege incoming. Pra outgoing não há limit estruturado — se ficar vendo padrões, criar `OUTBOUND_RATE_LIMIT_PER_HOUR` é um bom follow-up.

---

## 3. LLM provider down (Anthropic, OpenAI, Voyage)

**Sinal**: audit `llm_circuit_opened` aparecendo, métrica `maia_llm_calls_total{status="error"}` crescendo, mensagens demorando ou falhando.

**Diagnóstico**:

```sql
-- Ver quantos circuit breakers abriram nas últimas horas:
SELECT acao, count(*), max(created_at) FROM audit_log
WHERE acao IN ('llm_circuit_opened', 'llm_circuit_closed')
  AND created_at > NOW() - INTERVAL '6 hours'
GROUP BY acao;
```

**Mitigação**:

1. **Confirmar é o provider**: `curl -i https://api.anthropic.com/v1/health` (sem auth).
2. **Se for Anthropic**: ative `FEATURE_OLLAMA_FALLBACK=true` no `.env` se você tem Ollama configurado, restart.
3. **Se não tem fallback**: o circuit breaker já está aberto, agente responde "estou processando, volte em alguns minutos" (graceful). Aguarde provider voltar.
4. **Cost spike** durante outage (retries): o `cost-monitor` cron pega no dia seguinte (alerta `Daily LLM cost USD…above…`).

**Audit log relacionado**: `llm_circuit_opened`, `llm_circuit_closed`.

> Quando a PR #24 (audit_watcher) for mergeada, a regra `llm_circuit_long_open` dispara alerta após 5 min sem `_closed`.

---

## 4. DB connection lost / Postgres down

**Sinal**: `/health/db` em down, log `pg pool error`, queries falhando em massa.

**Mitigação**:

1. **Identificar a causa**: `ssh maia 'sudo systemctl status postgresql'`. OOM? Disk full?
2. **Restart simples**: `sudo systemctl restart postgresql`. App reconecta sozinho via pool.
3. **Disk full**: `df -h /var/lib/postgresql`. Limpe: `vacuum full` em tabelas grandes (`audit_log`, `mensagens`). Cuidado — bloqueia acesso durante o vacuum.
4. **Restore se corrompido**: ver §6.

> Não há gauge `maia_db_connected` registrado hoje (`src/server.ts` só registra `maia_redis_connected` e `maia_baileys_connected`). Use `/health/db` ou observação dos logs `pg pool error`. Adicionar o gauge é um follow-up trivial se quiser alarme automático.

---

## 5. DLQ — jobs no dead-letter queue

**Sinal**: alerta de `dlq_job_added`, log `agent.job.failed` repetido.

**Inspeção**:

```bash
ssh maia 'cd /opt/maia && npm run dlq -- list'
# Lista até 50 entradas abertas com id, queue, attempts, error, created_at.
```

**Resolução**:

- **Erro determinístico** (parsing inválido, dado corrompido): registre o `id` da DLQ, depois marque resolvido (não re-enfileira):
  ```bash
  npm run dlq -- resolve <id>
  ```
- **Erro transient** (timeout LLM, rede): re-enfileira no agent queue + marca resolvido:
  ```bash
  npm run dlq -- retry <id>
  ```
- **Padrão recorrente**: investigue o código — provavelmente um bug, não um job ruim.

**Audit log relacionado**: `dlq_job_added`, `dlq_job_resolved`.

---

## 6. Restore de backup (drill ou recuperação real)

**Drill** (sem afetar produção):

```bash
ssh maia 'cd /opt/maia && npm run restore:test'
# Pega o backup mais recente, restaura num DB efêmero, valida count(pessoas), drop.
# Audit: 'restore_test_passed' ou 'restore_test_failed'.
```

**Recuperação real** (DB original perdido/corrompido):

1. **Pare o app**: `sudo systemctl stop maia`.
2. **Identifique o dump**: `ls -la /opt/maia/backups/maia-*.dump | tail`.
3. **Recrie o DB**: `sudo -u postgres dropdb maia && sudo -u postgres createdb maia`.
4. **Restore**: `sudo -u postgres pg_restore --no-owner -d maia /opt/maia/backups/maia-2026-XX-XX-XX-XX-XX.dump`.
5. **Migrações em cima** (se mudou schema entre backup e agora): `npm run db:migrate`.
6. **Inicie**: `sudo systemctl start maia`. Confira `/health/db`.

**Janela de perda**: até 24h (backup é nightly). Pra perda menor: snapshots EBS / volume cloud = follow-up.

---

## 7. Setup token rotation manual

**Quando**: você suspeita que o token vazou (auditoria mostra `setup_unauthorized_access` repetido — ou, depois da PR #23, `setup_csrf_mismatch`).

```bash
ssh maia 'cd /opt/maia && rm -f .baileys-auth/setup-token.txt && sudo systemctl restart maia'
# Próximo boot: ensureToken() recria o arquivo + audit 'setup_token_rotated reason=cold_start'.
ssh maia 'cat /opt/maia/.baileys-auth/setup-token.txt'   # NOVO token
```

**Importante**: o token da sessão (Baileys) é diferente do bootstrap token (`/setup`). Rotacionar o bootstrap NÃO desconecta o WhatsApp.

> Quando a PR #24 (audit_watcher) for mergeada, as regras `setup_unauthorized_farm` (3+ em 5min) e `setup_csrf_attack` (5+ em 5min) disparam alerta automático.

---

## 8. Métricas pra ficar de olho

```bash
curl -s http://localhost:3000/metrics | grep -E "maia_(baileys|redis|llm|audit)_"
```

| Métrica (registrada hoje) | Tipo | Alerta se |
|---|---|---|
| `maia_baileys_connected` | gauge | =0 por > 2min |
| `maia_redis_connected` | gauge | =0 por > 30s |
| `maia_llm_calls_total{status="error"}` | counter | rate alto |
| `maia_llm_tokens_total{kind=...}` | counter | rate alto = custo |
| `maia_llm_latency_ms` | histogram | p99 > 30s |
| `maia_audit_events_total{action=...}` | counter | crescimento súbito em ações sensíveis |

**Health endpoints** (em `src/server.ts`): `/health`, `/health/db`, `/health/redis`, `/health/whatsapp`. Não há `/health/llm` — use `maia_llm_calls_total{status}` no Prometheus.

> Adicionar `maia_db_connected` e `maia_llm_circuit_state` é um follow-up trivial (uma linha cada em `src/server.ts` via `setGaugeProvider`). Se quiser alertas baseados nessas, abre uma PR.

---

## 9. Restart limpo (zero data loss)

```bash
sudo systemctl stop maia          # SIGTERM → finaliza jobs em flight
# Aguarde 'maia.shutting_down' no log
sleep 5
sudo systemctl start maia
# Aguarde 'http.listening' + 'baileys.connected'
```

O shutdown handler em `src/index.ts` chama `stopWorkers()` + `shutdownPools()` + audit `system_stopped`. Restart preserva: sessão Baileys (`.baileys-auth/`), backups, audit log, jobs (BullMQ persiste em Redis).

---

## 10. Checklist de deploy novo (cold start)

- [ ] `.env` preenchido (todas as obrigatórias do `envSchema` em `src/config/env.ts`)
- [ ] Postgres + Redis up (`/health/db` + `/health/redis`)
- [ ] `npm run db:migrate` rodado
- [ ] `npm run build` clean
- [ ] App started → log mostra `setup.bootstrap_token_ready` (cold start, sem `creds.json`)
- [ ] SSH cat `.baileys-auth/setup-token.txt` → `/setup?token=…` no browser → escolher QR ou código → parear com WhatsApp do número da Maia
- [ ] Audit log mostra `system_started`, `pairing_qr_displayed` (ou `pairing_code_requested`), `pairing_completed`
- [ ] `/health/whatsapp` ok
- [ ] Mande mensagem teste pro número Maia → log mostra `baileys.message.enqueued` → resposta do agente em ~3-8s
- [ ] (Opcional) Configurar nginx (uma vez que a PR #23 land, ver `docs/runbooks/setup-nginx.md`): IP whitelist, TLS, fail2ban

---

## Apêndice — referências cruzadas

- **`docs/runbooks/setup-nginx.md`** — IP whitelist, TLS, fail2ban (PR #23, ainda não mergeada na escrita deste runbook).
- **`audit_watcher`** — regras automáticas de detecção de anomalia (PR #24, ainda não mergeada). Mencionado em §1, §3, §7.
- **`scripts/restore-test.ts`** — drill de restore (já no main).
- **`src/workers/backup.ts`** — backup nightly (já no main).
- **`src/workers/cost-monitor.ts`** — alerta de custo LLM diário acima de `DAILY_LLM_USD_THRESHOLD` (já no main).
- **`src/workers/health-monitor.ts`** — vigilância dos health checks (já no main).

Quando #23 e #24 mergearem, este runbook continua válido — as referências forward (marcadas com `>`) viram links concretos sem alterar nenhum comando.
