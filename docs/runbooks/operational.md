# Maia — runbook operacional

Cenários comuns + ações concretas. Fluxo: detecte (alerta? log? métrica?) → diagnostique → mitigue → registre.

> **Antes de qualquer ação destrutiva**, snapshot do DB: `bash scripts/backup.sh` (ou aguardar o `nightly_backup` 03:00 BRT).

---

## 1. WhatsApp pareou? Como verificar / re-parear

**Sinal**: `/health/whatsapp` retorna `{ ok: false }`, métrica `maia_baileys_connected=0`, ou alerta do `audit_watcher` regra `pairing_recovery_stuck`.

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

**Caso 3 — recovery travou** (alerta `pairing_recovery_stuck`): SSH manual:

```bash
ssh maia
sudo systemctl stop maia
rm -rf /opt/maia/.baileys-auth
sudo systemctl start maia
# Aguarde 'setup.bootstrap_token_ready' no log, depois fluxo normal de /setup.
```

**Audit log relacionado**: `pairing_recovery_started`, `pairing_recovery_completed`, `pairing_logged_out`, `setup_token_rotated`.

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

**Sinal**: alerta `audit_watcher: llm_circuit_long_open` (urgent), métrica `maia_llm_circuit_state=open`, ou `health/llm` em down.

**Mitigação**:

1. **Confirmar é o provider**: `curl -i https://api.anthropic.com/v1/health` (sem auth).
2. **Se for Anthropic**: ative `FEATURE_OLLAMA_FALLBACK=true` no `.env` se você tem Ollama configurado, restart.
3. **Se não tem fallback**: o circuit breaker já está aberto, agente responde "estou processando, volte em alguns minutos" (graceful). Aguarde provider voltar.
4. **Cost spike** durante outage (retries): o `cost-monitor` cron pega no dia seguinte (alerta `Daily LLM cost USD…above…`).

**Audit log relacionado**: `llm_circuit_opened`, `llm_circuit_closed`.

---

## 4. DB connection lost / Postgres down

**Sinal**: `/health/db` em down, métrica `maia_db_connected=0`, alerta do `health-monitor` se persistir > 2min.

**Mitigação**:

1. **Identificar a causa**: `ssh maia 'sudo systemctl status postgresql'`. OOM? Disk full?
2. **Restart simples**: `sudo systemctl restart postgresql`. App reconecta sozinho via pool.
3. **Disk full**: `df -h /var/lib/postgresql`. Limpe: `vacuum full` em tabelas grandes (`auditoria`, `mensagens`). Cuidado — bloqueia acesso durante o vacuum.
4. **Restore se corrompido**: ver §6.

---

## 5. DLQ — jobs no dead-letter queue

**Sinal**: alerta de `dlq_job_added`, log `agent.job.failed` repetido.

**Inspeção**:

```bash
ssh maia 'cd /opt/maia && npm run dlq'   # lista entradas + payloads
```

**Resolução**:

- **Erro determinístico** (parsing inválido, dado corrompido): registre o `id` da DLQ, edite o job se possível, ou simplesmente delete (`npm run dlq -- --delete <id>`).
- **Erro transient** (timeout LLM, rede): `npm run dlq -- --retry <id>` reenfileira no agent queue.
- **Padrão recorrente**: investigue o código — provavelmente um bug, não um job ruim.

**Audit log relacionado**: `dlq_job_added`, `dlq_job_resolved`.

---

## 6. Restore de backup (drill ou recuperação real)

**Drill** (sem afetar produção):

```bash
ssh maia 'cd /opt/maia && npx tsx scripts/restore-test.ts'
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

**Quando**: você suspeita que o token vazou (alerta `audit_watcher: setup_unauthorized_farm` ou `setup_csrf_attack`).

```bash
ssh maia 'cd /opt/maia && rm -f .baileys-auth/setup-token.txt && sudo systemctl restart maia'
# Próximo boot: ensureToken() recria o arquivo + audit 'setup_token_rotated reason=cold_start'.
ssh maia 'cat /opt/maia/.baileys-auth/setup-token.txt'   # NOVO token
```

**Importante**: o token da sessão (Baileys) é diferente do bootstrap token (`/setup`). Rotacionar o bootstrap NÃO desconecta o WhatsApp.

---

## 8. Métricas pra ficar de olho

```bash
curl -s http://localhost:3000/metrics | grep -E "maia_(baileys|redis|db|llm)_"
```

| Métrica | Alvo | Alerta se |
|---|---|---|
| `maia_baileys_connected` | 1 | =0 por > 2min |
| `maia_db_connected` | 1 | =0 por > 30s |
| `maia_redis_connected` | 1 | =0 por > 30s |
| `maia_llm_circuit_state` | 0 (closed) | =1 por > 5min |
| `maia_audit_events_total{action="setup_unauthorized_access"}` | baixo | crescimento súbito |

O `audit_watcher` (PR #24) já cobre os principais; `/metrics` é pra deep-dive.

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
- [ ] (Opcional) Configurar nginx (ver `docs/runbooks/setup-nginx.md`): IP whitelist, TLS, fail2ban
