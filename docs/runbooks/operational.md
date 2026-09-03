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
ssh maia 'cat .baileys-auth/control/setup-token.txt'   # NOVO token (já rotacionado pelo recovery)
# Browser → https://maia.SEU-DOMINIO.com/setup
# A página pede o token: COLE no formulário (o token vai no corpo do POST).
# Clique "QR" ou "Código de 8 dígitos"
```

> **Issue #518 — o token NÃO vai mais na URL.** `/setup?token=…` não autentica
> mais: a URL ficava no histórico do navegador, no header `Referer` e no
> access log do nginx. O token é colado uma vez no formulário e trocado por um
> cookie de sessão `httpOnly` + `SameSite=Strict` válido por 30 minutos.
> Rotacionar o token revoga as sessões abertas.
>
> Break-glass para automação/curl (sem browser), com o token em HEADER:
>
> ```bash
> TOKEN=$(ssh maia 'cat .baileys-auth/control/setup-token.txt')
> curl -s -H "x-maia-setup-token: $TOKEN" https://maia.SEU-DOMINIO.com/setup/status
> ```

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

## 1b. Linhas ADICIONAIS: parear, cancelar, re-parear (Admin, issue #518)

A linha primária continua no `/setup`. Toda linha **adicional** é operada pelo
console autenticado — sem shell, sem curl, sem token:

**Console → Setup → Canais.** Cada linha mostra:

| Estado | Significado | Próxima ação |
|---|---|---|
| `declared` | Número registrado; ninguém provou a posse. Não roteia | **Parear** |
| `pairing` | Sessão aberta; QR/código na tela | Acompanhar ou **Cancelar** |
| `aborting` | Cancelamento pedido; aguardando o runtime confirmar | Aguardar (segundos) |
| `verified_offline` | Posse provada, mas **não roteia**: falta readiness | Criar a política com papel padrão ativo — o backend ativa sozinho |
| `connected` | Sessão viva: envia e recebe | — |
| `recovering` | Queda transitória; o runtime reconecta sozinho | Aguardar |
| `logged_out` | O WhatsApp encerrou a sessão — a posse acabou | **Re-parear** |
| `failed` | Última tentativa não completou (mismatch, TTL, restart) | **Repetir** |
| `disabled` | Desligada pelo operador | **Parear** quando quiser religar |

**Pré-requisito de deploy**: `MAIA_STAGING_KEYRING` + `MAIA_STAGING_ACTIVE_KEY_ID`
configurados no runtime **e** no console. O QR/código só trafegam cifrados; sem
keyring a tela mostra os estados mas o botão de parear fica desabilitado com a
explicação.

**Como funciona por baixo** (útil quando algo trava): o console NÃO fala com o
Baileys. Ele grava um comando em `channel_line_state` com o ator administrativo;
o worker `channel_pairing` (a cada 5s, no processo do runtime) reivindica,
executa e devolve o estado.

Com **mais de uma réplica**, dois conceitos de posse convivem na tabela:
`owner_instance` (+ `owner_lease_expires_at`) é quem está executando a ORDEM;
`session_owner_instance` (+ `session_owner_lease_expires_at`) é quem segura o
SOCKET. `disable` e `repair` são endereçados (`target_instance`) à réplica dona
do socket — só ela consegue derrubá-lo. Lease vencida do alvo libera o comando
para qualquer réplica (o processo morreu e levou o socket junto).

```sql
-- Quem segura o socket de cada linha, e a ordem endereçada a quem.
SELECT channel_id, session_owner_instance, session_owner_lease_expires_at,
       command, target_instance
  FROM channel_line_state WHERE session_owner_instance IS NOT NULL OR command IS NOT NULL;

-- Comando pendente que ninguém reivindicou ⇒ o worker do runtime está parado.
SELECT channel_id, command, command_requested_at, command_claimed_at, owner_instance
  FROM channel_line_state WHERE command IS NOT NULL;

-- Tentativas presas em pairing (o sweep de 1min deveria zerar isto).
SELECT channel_id, state, reason_code, pairing_expires_at
  FROM channel_line_state WHERE state = 'pairing';
```

**Restart durante o pareamento**: a sessão vivia em memória e morreu junto. O
worker marca a tentativa como `failed` com `reason_code = interrupted_retryable`
e audita `pairing_session_expired`. Nunca vira `verified`. O operador clica em
"Repetir pareamento".

**Mismatch de número**: se o WhatsApp que leu o QR não for a linha declarada, o
pareamento falha com `line_mismatch` e o canal NÃO é ativado. Digitar um número
nunca dá posse.

**Pareou mas não responde?** Provavelmente é o gate de readiness (issue #518
§4): posse provada **não** é permissão de rotear. Uma linha só é ativada quando
o backend revalida, deterministicamente, a mesma sequência do go-live checklist:

1. o **agente** tem perfil operacional **ativo**;
2. o canal tem política de canal;
3. o papel padrão dessa política está **ativo**.

Até lá a linha fica `verified_offline` e o audit registra
`channel_activation_deferred` com o motivo (`missing_active_profile`,
`missing_policy` ou `default_role_inactive`).

Não é preciso re-parear: o worker revalida a cada minuto e emite
`channel_activated` assim que a política ficar pronta.

```sql
-- Linhas com posse provada esperando readiness.
SELECT s.channel_id, s.reason_code, c.external_id, c.active
  FROM channel_line_state s JOIN channels c ON c.id = s.channel_id
 WHERE s.state = 'verified_offline' AND c.active = false;
```

**Audit log relacionado**: `channel_pairing_requested`, `pairing_session_started`,
`pairing_session_verified`, `pairing_session_failed`, `pairing_session_aborted`,
`pairing_session_expired`, `line_session_transition`, `channel_disabled`,
`channel_repair_requested`, `channel_activation_deferred`, `channel_activated`.
Nenhum deles carrega QR, código, token ou auth state.

**Break-glass** (console fora do ar), sem token em query string:

```bash
TOKEN=$(ssh maia 'cat .baileys-auth/control/setup-token.txt')
curl -s -X POST -H "x-maia-setup-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"method":"qr"}' https://maia.SEU-DOMINIO.com/setup/channels/<CHANNEL_ID>/pair
curl -s -H "x-maia-setup-token: $TOKEN" \
  https://maia.SEU-DOMINIO.com/setup/channels/<CHANNEL_ID>/pair/status
```

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

**Sinal**: audit `llm_circuit_opened` aparecendo, mensagens demorando ou
falhando, e `maia_llm_requests_total{status=~"error|timeout"}` crescendo — o
`timeout` do SDK é status PRÓPRIO e é uma das três falhas que abrem o disjuntor,
então olhar só `status="error"` esconde metade do incidente. Para saber QUAL par
está sofrendo, agrupe por `(provider, workload)`: a série legada
`maia_llm_calls_total` não carrega `workload`.

**Diagnóstico**:

```sql
-- Ver quantos circuit breakers abriram nas últimas horas:
SELECT acao, count(*), max(created_at) FROM audit_log
WHERE acao IN ('llm_circuit_opened', 'llm_circuit_closed')
  AND created_at > NOW() - INTERVAL '6 hours'
GROUP BY acao;
```

**Mitigação**:

1. **Confirmar é o provider**: `curl -i https://api.anthropic.com/v1/health` (Anthropic) ou `curl -i https://openrouter.ai/api/v1/health` (OpenRouter), sem auth.
2. **Workaround imediato (LLM_PROVIDER=openrouter)**: troque o modelo no admin-ui em `/setup/llm-settings` (requer role `founder` — model switch é high-blast-radius, audited atomicamente). Se o main estava num provider down (ex: `anthropic/...`), pula pra outro (ex: `openai/gpt-5`, `google/gemini-2.5-pro`, `x-ai/grok-4.1-fast`). Próxima mensagem usa o modelo novo, sem restart, **para TODOS os tenants e agents** — o pick fica em `global_settings` (process-wide, não escopado por tenant/agent; ver migration 062). A mudança aparece em `admin_audit_log` com `action='llm_model_changed'` e o `change_summary` carrega `{ before, after, comment }` que o operador forneceu. Concurrent founders são serializados via `SELECT ... FOR UPDATE` na linha de `global_settings`, garantindo que `before` no audit reflete o que realmente persistiu sob o lock (não um snapshot stale).
3. **Workaround imediato (LLM_PROVIDER=anthropic)**: edite `LLM_PROVIDER=openrouter` no `.env` + setup `OPENROUTER_API_KEY`, restart. Funcionalmente equivalente ao circuit breaker, mais flexível.
4. **Sem fallback configurado**: o circuit breaker já está aberto, agente responde "estou processando, volte em alguns minutos" (graceful). Aguarde provider voltar.
4. **Cost spike** durante outage (retries): o `cost-monitor` cron pega no dia seguinte (alerta `Daily LLM cost USD…above…`).

**Audit log relacionado**: `llm_circuit_opened`, `llm_circuit_closed`.

> Quando a PR #24 (audit_watcher) for mergeada, a regra `llm_circuit_long_open` dispara alerta após 5 min sem `_closed`.

---

## 3.1 Disjuntor de LLM — postura, kill switch e promoção

O disjuntor tem TRÊS posturas. **Em produção o default é `shadow`**: ele observa
e mede, mas não recusa nada. Promover para `enforce` é uma decisão com número na
mão, e este é o procedimento.

| Postura | O caller vê | Estado guardado |
|---|---|---|
| `off` | nada muda | nenhum |
| `shadow` (default) | nada muda — **nunca recusa** | sim, e mede |
| `enforce` | recusa com `circuit_open` | sim |

### Qual é a postura AGORA

```bash
curl -s http://localhost:3000/metrics | grep maia_llm_circuit_mode
# maia_llm_circuit_mode{state="off"} 0
# maia_llm_circuit_mode{state="shadow"} 1     ← esta é a que vale
# maia_llm_circuit_mode{state="enforce"} 0
```

Par de séries, exatamente uma valendo `1` — nunca leia por valor numérico. Se
nenhuma das três aparecer, o processo ainda não fez chamada de LLM alguma (as
séries são registradas na primeira leitura da postura).

### Alerta `llm_circuit_long_open` — como ler

O watcher de auditoria (`src/workers/audit-watcher.ts`) acusa `llm_circuit_opened`
sem `llm_circuit_closed` correspondente há mais de 5 min. Desde a revisão da PR
#541 o par é correlacionado por **`provider` / `workload` / `replica`**, e o
corpo do alerta NOMEIA cada circuito preso:

```
2 instance(s) with `llm_circuit_opened` older than 5 min and no matching `llm_circuit_closed`.
Identity is `provider/workload/replica`:
  - anthropic/reasoner/maia-app-7d9f:1#a1b2c3d4 (3 event(s), oldest 2026-08-09T00:11:54Z)
```

Antes disso a regra casava QUALQUER fechamento posterior com QUALQUER abertura:
um circuito que abriu e fechou normalmente desarmava o alerta de outro que
continuava preso. O estado do disjuntor é por `(provider, workload)` **e por
réplica** — a janela de amostras vive na memória de cada processo —, então
correlacionar por menos que isso cega o alerta exatamente no caso que ele existe
para pegar.

**`replica` é `<hostname>:<pid>#<boot>`.** O sufixo de boot é sorteado por
processo: sem ele, um container que reinicia (hostname estável, PID 1) herdaria
a identidade do processo morto e fecharia o par que ele deixou pendurado.

**Falso positivo conhecido: réplica que morreu com o circuito aberto.** Ela nunca
emite o `closed`, e a abertura órfã alerta enquanto estiver na janela de 24 h do
watcher. É o preço deliberado de não deixar o boot seguinte fechar o par.
Como distinguir em 10 segundos:

```bash
# A réplica citada ainda existe? `maia_llm_circuit_state` só existe em processo
# VIVO — se o par não aparece em lugar nenhum da frota, o alerta é o rastro de
# um processo que já morreu.
curl -s http://localhost:3000/metrics | grep 'maia_llm_circuit_state.*state="open"'
```

Se nenhuma réplica viva reporta `state="open"` para aquele par, o incidente já
passou junto com o processo — anote e siga. Se alguma reporta, o circuito está
preso de verdade: vá para a seção 3 (LLM provider down).

### KILL SWITCH — desligar durante um incidente, sem restart e sem deploy

Use quando **o disjuntor é o incidente**: recusando tráfego que o provider ainda
serviria, preso em `open` por um falso positivo, ou abrindo em brownout.

```bash
# 1. Monte o payload. `actor` e `reason` são OBRIGATÓRIOS — um override sem eles
#    é RECUSADO (e a recusa também é contada). Não há como virar esta chave
#    anonimamente, de propósito.
#    A validade vai como `expires_at` ABSOLUTO (epoch ms), NUNCA como `ttl_ms`:
#    ver a caixa "duas regras" logo abaixo.
EXP=$(( ($(date +%s) + 1800) * 1000 ))    # 30 min a partir de agora
PAYLOAD="{\"mode\":\"off\",\"actor\":\"sre:seu-usuario\",\"reason\":\"INC-1234 disjuntor abrindo em brownout\",\"expires_at\":$EXP}"

# 2. Chave durável PRIMEIRO (réplica que subir no meio do incidente adota o
#    resto do arrendamento), depois o broadcast. O `PX` tem que casar com o
#    `expires_at` do payload.
redis-cli SET  maia:llm:circuit:override "$PAYLOAD" PX 1800000
redis-cli PUBLISH maia:llm:circuit:override "$PAYLOAD"

# 3. Confirme que a chave REALMENTE expira. `-1` aqui significa chave eterna:
#    aborte e regrave com PX antes de seguir.
redis-cli PTTL maia:llm:circuit:override

# 4. Confirme em TODAS as réplicas.
curl -s http://localhost:3000/metrics | grep 'maia_llm_circuit_mode{state="off"} 1'
```

> **Duas regras da chave durável — as duas são o que faz o kill switch poder ser
> esquecido sem virar configuração permanente (revisão da #541).**
>
> 1. **Sempre `PX`.** Uma chave sem TTL vive para sempre. `PTTL` retornando `-1`
>    é o sinal.
> 2. **Sempre `expires_at` absoluto no payload, nunca `ttl_ms`.** Validade
>    relativa numa chave durável é reinterpretada contra o relógio de cada boot:
>    toda réplica que reiniciasse ressuscitaria o arrendamento inteiro, e o
>    override atravessaria deploys. Uma chave assim é **recusada na adoção**
>    (`maia_llm_circuit_mode_overrides_total{reason="rejected"}`), então o
>    sintoma é a frota não adotar o override — não é falha silenciosa, mas
>    também não é o que você quer no meio de um incidente.
>
> Quem publica pelo código (`publishCircuitOverride`) já recebe as duas de
> graça: ele normaliza `ttl_ms` para absoluto, valida os limites antes de tocar
> no Redis e sempre grava com `PX`. As regras acima existem para o caminho do
> `redis-cli` na mão.
>
> **Relógio:** `expires_at` é resolvido no relógio de quem publica e comparado
> no de quem recebe. Assume-se skew NTP de ordem de segundos, o que é ruído
> contra um arrendamento de 30min. Réplica adiantada volta cedo para a postura
> versionada (direção segura); réplica atrasada estica o arrendamento pelo skew
> e só nela. Skew grosseiro não passa: vira `rejected` por "já vencido na
> chegada" ou pelo teto de 24h.

**Reverter antes do TTL:**

```bash
CLEAR="{\"clear\":true,\"actor\":\"sre:seu-usuario\",\"reason\":\"INC-1234 encerrado\"}"
redis-cli DEL maia:llm:circuit:override
redis-cli PUBLISH maia:llm:circuit:override "$CLEAR"
```

**Se o Redis estiver fora**, o override não propaga. Segunda alavanca, com o
custo honesto de um restart: `LLM_CIRCUIT_MODE=off` no `.env` +
`docker compose up -d --no-deps app`. É por isso que a variável é declarada
`restartRequired: true` no contrato — vendê-la como quente seria mentira.

**Restrições que o código impõe** (e por que existem):

- `actor` e `reason` vazios ⇒ recusado. Um kill switch anônimo não é auditável,
  e a objeção original da #534 a toggles de runtime era exatamente essa.
- TTL acima de 24h ⇒ recusado, não truncado. Desligar o disjuntor por mais de um
  dia é decisão de deploy, não de plantão.
- Sem TTL declarado ⇒ 30 min. Ele **expira sozinho** e volta para a postura do
  contrato; o retorno também é um evento contado.
- Chave durável sem `expires_at` absoluto ⇒ recusada na adoção. Ver a caixa
  "duas regras" acima.

**Réplica que sobe durante a virada.** Uma réplica nova só lê a chave durável
depois que a inscrição no canal está CONFIRMADA pelo Redis. Isso fecha a janela
em que ela leria a chave antes do seu `SET` e perderia o `PUBLISH` por ainda não
estar inscrita — o modo de falha em que metade da frota atravessa o incidente na
postura antiga.

**Réplica que RECONECTA durante a virada.** Pub/sub é at-most-once e não tem
replay: a mensagem publicada enquanto o socket estava caído está perdida. Desde
o gate 4 da #534, toda volta da conexão do subscriber (o segundo `ready` do
ioredis em diante) dispara uma RELEITURA do estado autoritativo — chave presente
⇒ adota o que sobrou do arrendamento; chave ausente ⇒ limpa o override local e
volta à postura do contrato. Não é preciso republicar nem esperar TTL. Para
confirmar que uma réplica específica passou por isso:

```bash
curl -s http://localhost:3000/metrics | grep 'reason="resync'
# maia_llm_circuit_mode_overrides_total{state="off",reason="resynced"} 1
journalctl -u maia | grep llm_gateway.circuit_override_resync
```

A releitura tem **retry limitado** (decisão do owner na #534): tentativa
imediata + 3 retries, com backoff exponencial, jitter e deadline por tentativa
(`RESYNC_RETRY`, `src/lib/llm/cache-invalidation.ts`). Uma tentativa
intermediária que falha sai só como `llm_gateway.circuit_override_resync_retry`
(WARN, com `attempt` e o erro) e **não** entra na série de convergência — a
falha típica aqui é um `LOADING` de failover, e desistir dela marcaria a réplica
como divergente por causa de um soluço.

O deadline vale para a tentativa INTEIRA — ack de re-inscrição e `GET` dividem
o mesmo orçamento —, então o pior caso de uma releitura que esgota é **~10,1s**:
4 × 2 000 ms + 300 + 600 + 1 200 ms de backoff no pior jitter
(`resyncWorstCaseMs()`).

`resync_failed` (log de ERRO `llm_gateway.circuit_override_resync_failed`, campo
`attempts`) é a saída ruim, é **terminal** e cobre TODA releitura que não pôde
afirmar consistência com o Redis. Terminal por dois caminhos: **esgotamento das
falhas retentáveis** (`attempts=4`) **ou recusa determinística** do payload lido
(`attempts=1` — retentar daria o mesmo veredito). É a série que os alertas
`MaiaLlmCircuitResyncFailedEnforcing` (crítico) e `MaiaLlmCircuitResyncFailed`
(warning) observam, por réplica; leitura do alerta em
[`observability-slo.md` §4.9.3](observability-slo.md). O campo `outcome` do log
diz qual:

| `outcome` | O que aconteceu |
|---|---|
| `failed` | `GET` falhou (ou estourou o deadline), chave ilegível, ou re-inscrição sem ack — não houve leitura defensável em nenhuma das 4 tentativas |
| `rejected` | a chave FOI lida e foi recusada (sem `expires_at` absoluto, sem ator, vencida, acima do teto) — terminal na primeira leitura |

**Réplica drenando não é divergência.** Se o subscriber for fechado (deploy,
scale-in, restart) com a releitura em voo, ela é **cancelada** e sai como
`reason="resync_cancelled"` + log **INFO**
`llm_gateway.circuit_override_resync_cancelled` — fora dos dois alertas. Um drain
deliberado não acorda o plantão (achado 2 da review da PR #561). A linha traz
`cancel_reason` (por que foi cancelado) e `channels` (qual subscriber fechou);
INFO, e não WARN, porque um subscriber que para é operação normal (decisão 16).

Nos dois o estado local é **preservado** — fail-closed, porque concluir "não há
override" a partir de um Redis mudo (ou de um payload que não passa na
governança) desligaria o kill switch sozinho. Uma réplica nesse estado pode
estar divergente da frota: republique o `SET` + `PUBLISH` (é idempotente); se
o `outcome` for `rejected`, olhe o payload da chave antes (`redis-cli GET
maia:llm:circuit:override`), porque republicar não conserta payload inválido —
e é por isso que a recusa NÃO é retentada: o veredito é determinístico sobre o
conteúdo da chave, e retentar só encheria a trilha durável de linhas
`_rejected` idênticas. Se persistir, trate como Redis fora do ar — segunda
alavanca.

`superseded` **não** é falha: ali a releitura perdeu para uma mensagem do canal,
que é sempre pelo menos tão nova quanto o que o `GET` leu — o estado final é o
do Redis, e sai como `resynced`.

### Auditoria — como saber que alguém mexeu

```bash
# Métrica (é onde o alerta deve morar):
curl -s http://localhost:3000/metrics | grep maia_llm_circuit_mode_overrides_total
# maia_llm_circuit_mode_overrides_total{state="off",reason="applied"} 1

# Log estruturado (carrega ator e motivo — texto livre não vai para label):
journalctl -u maia | grep llm_gateway.circuit_mode_override
```

`reason` ∈ `applied` · `expired` · `cleared` · `rejected` · `adopted` ·
`resynced` · `resync_failed` · `resync_cancelled`. Um `rejected` no gráfico
significa que alguém TENTOU virar a chave e não conseguiu — vale investigar
tanto quanto um `applied`.

Os **três últimos** são a releitura de reconexão, uma linha por releitura, e
eles não querem dizer a mesma coisa:

| `reason` | O que aconteceu | O que fazer |
|---|---|---|
| `resynced` | a releitura CONVERGIU — leu o estado autoritativo e o aplicou (inclusive quando não mudou nada) | nada; é o caminho feliz |
| `resync_failed` | a releitura DIVERGIU — esgotou as tentativas sem conseguir ler | investigar Redis/rede; é o único dos três que alerta |
| `resync_cancelled` | a releitura foi ABANDONADA porque o subscriber parou (shutdown) | nada, se houve deploy/restart. Se aparecer sem restart, a pergunta é por que a réplica está reiniciando |

`resync_cancelled` não é falha: o estado local é preservado e nenhuma postura
é aplicada, limpa ou recusada. Por isso ele fica fora de `DIVERGENT_OUTCOMES`
e nenhum alerta o seleciona.

> **Série histórica.** Até 2026-08-17 este balde saía como
> `reason="resync_aborted"`. O rename **quebra a continuidade da série** — uma
> query que cubra a virada precisa somar os dois rótulos
> (`reason=~"resync_aborted|resync_cancelled"`) até o dado velho sair da
> retenção. Detalhe em [`observability-slo.md`](observability-slo.md).

**A fonte DURÁVEL é `audit_log`** (revisão da PR #541). Métrica expira na
retenção do Prometheus e log expira na do coletor — é a trilha que responde
"quem virou a chave em março?". Toda virada, limpeza, expiração e recusa vira
linha, sob `tenant_id='system'` (a postura é da frota, não de um tenant):

```sql
SELECT created_at, acao,
       metadata->>'actor'  AS actor,
       metadata->>'reason' AS motivo,
       metadata->>'mode'   AS postura,
       metadata->>'expires_at' AS validade,
       metadata->>'source' AS origem,   -- 'adopted' = chave durável no boot; 'resynced' = releitura de reconexão
       metadata->>'error'  AS erro      -- só nas recusas
  FROM audit_log
 WHERE acao LIKE 'llm_circuit_mode_override_%'
   AND created_at > NOW() - INTERVAL '30 days'
 ORDER BY created_at DESC;
```

Ações: `llm_circuit_mode_override_applied` · `_cleared` · `_expired` ·
`_rejected`. A adoção da chave durável no boot entra como `applied` com
`metadata.source = 'adopted'`, e a releitura de reconexão com
`metadata.source = 'resynced'` — é o mesmo desfecho de governança (a postura
mudou), com procedência diferente. Uma limpeza vinda da releitura aparece como
`_cleared` com `actor = 'system:llm_circuit_resync'`: não houve humano, o que
mudou a postura foi a convergência com o Redis.

Se a métrica registrar um `applied` e a trilha não tiver a linha, o suspeito é
a escrita: cheque `maia_audit_write_failed_total{action=...}` e o log
`llm_gateway.circuit_audit_failed`.

### Promoção `shadow` → `enforce`

> **A postura é GLOBAL.** `LLM_CIRCUIT_MODE` vale para o processo inteiro —
> `effectiveMode()` em `src/lib/llm/circuit-mode.ts` não recebe `provider` nem
> `workload`. **Não existe promoção seletiva por workload.** Ou TODOS os
> workloads ativos passam nos critérios abaixo, ou não se promove: promover
> "porque o `reasoner` está limpo" liga o `enforce` para `summarizer`,
> `vision`, `skill` e todo o resto junto. Se a promoção parcial for mesmo o que
> se quer, o trabalho é implementar postura POR WORKLOAD primeiro — não
> promover mesmo assim e torcer.

> **PRÉ-REQUISITO — a lacuna de reconexão do pub/sub: FECHADA (gate 4 da #534).**
> O kill switch (`maia:llm:circuit:override`) chega por pub/sub do Redis, que é
> **at-most-once**. A chave durável cobria a réplica que **SOBE** no meio do
> incidente (`adoptPersistedOverride`, depois do `SUBSCRIBE` confirmado), mas
> **não** cobria a que **RECONECTA** nele: uma queda de socket entre a
> confirmação e a mensagem perdia a notificação para sempre, e aquela réplica
> continuava na postura antiga até o TTL do arrendamento. Em `shadow` isso era
> divergência de medição; em `enforce` seria uma réplica **recusando tráfego
> depois de o plantão ter desligado o disjuntor**.
>
> Hoje `resyncAuthoritativeState` (`src/lib/llm/cache-invalidation.ts`) é
> encadeada no `ready` do ioredis a partir da SEGUNDA vez: re-inscreve nos dois
> canais, espera o ack, solta o cache de settings e **relê** a chave durável.
> Chave presente ⇒ adota o **arrendamento restante** (o payload carrega
> `expires_at` absoluto, então não há como reiniciar a contagem); chave ausente
> ⇒ **limpa o override local** e volta à postura do contrato. Falha de leitura
> não vira "não há override": o estado é preservado e sai `resync_failed`.
>
> Provas: `tests/integration/llm-circuit-reconnect-resync.spec.ts` (socket
> morto de verdade, mensagem comprovadamente perdida) e
> `tests/unit/lib/llm-circuit-resync.spec.ts` (fail-closed e a corrida entre a
> releitura em voo e uma mensagem do canal). **Verificação antes de promover:**
> derrube o socket de uma réplica, vire a chave nesse intervalo e confirme
> `maia_llm_circuit_mode_overrides_total{reason="resynced"}` subindo naquela
> réplica com a postura convergida — o passo 4 desta seção, com a queda no
> meio.

#### Janela mínima de observação

Nada abaixo disto conta como evidência:

| Requisito | Valor | Por quê |
|---|---|---|
| Ambiente | **staging** | Não se aprende a recusar tráfego em produção. |
| Duração | **7 dias completos** | Menos que isso não pega o ciclo semanal (segunda de manhã ≠ sábado de madrugada), e o limiar do disjuntor é sensível ao volume da janela. |
| Volume | **≥ 1.000 chamadas por `(provider, workload)`** | `MIN_SAMPLES` é 10 numa janela de 30 s; abaixo de mil chamadas no período, um par sequer exercitou a máquina e "não abriu" não é informação. |
| Falhas | **outage, brownout e recovery INJETADOS** | Esperar um incidente natural em staging é esperar para sempre. Os três cenários existem prontos em `scripts/llm-benchmark.ts`. |

```promql
# Volume por par — todo par ATIVO precisa cruzar 1.000 no período.
# `maia_llm_requests_total` é a série que carrega `workload`; a legada
# `maia_llm_calls_total` só tem provider/model/status e NÃO responde isto.
sum by (provider, workload) (increase(maia_llm_requests_total[7d]))
```

Injeção das falhas — é o mesmo harness que produziu as constantes do disjuntor,
e ele já compara as três posturas lado a lado:

```bash
npm run llm:bench -- --scenario outage   --workload reasoner --requests 300 --concurrency 20
npm run llm:bench -- --scenario brownout --workload reasoner --failure-rate 0.6
npm run llm:bench -- --scenario recovery --workload reasoner --outage-ms 12000 --think-ms 50
```

#### Critérios de ida (todos, não algum)

**Todas as consultas abaixo agrupam por `(provider, workload)` e usam
`maia_llm_requests_total`.** A série legada `maia_llm_calls_total` carrega
apenas `provider`, `model` e `status` (`src/lib/llm/telemetry.ts`): agrupar por
`workload` nela devolve UM grupo com tudo somado, e `status="error"` **não
inclui `timeout`** — que é justamente um dos desfechos que abrem o disjuntor
(`PROVIDER_FAULT_KINDS` = `provider_5xx` · `network` · `timeout`). Por isso todo
seletor de falha aqui é `status=~"error|timeout"`.

**1. Zero `would_open` fora de erro elevado.** Um falso positivo bloqueia a
promoção — em `enforce` ele seria carga recusada sem provider quebrado.

```promql
# Taxa de falha REAL do par (inclui timeout do SDK).
sum by (provider, workload) (rate(maia_llm_requests_total{status=~"error|timeout"}[5m]))
  /
clamp_min(
  sum by (provider, workload) (rate(maia_llm_requests_total{status=~"ok|error|timeout"}[5m])),
  1e-9
)

# Aberturas simuladas SEM falha elevada por trás = falso positivo.
# `TARGET_CALL_FAILURE_RATE` é 0.5; abaixo disso o disjuntor não deveria abrir.
(sum by (provider, workload) (increase(maia_llm_circuit_would_open_total[5m])) > 0)
  unless
(
  sum by (provider, workload) (rate(maia_llm_requests_total{status=~"error|timeout"}[5m]))
    /
  clamp_min(
    sum by (provider, workload) (rate(maia_llm_requests_total{status=~"ok|error|timeout"}[5m])),
    1e-9
  ) > 0.5
)
```

Critério: **vazio** durante os 7 dias. Qualquer série que sobre é um par que
teria aberto sem motivo.

**2. Abertura em até 30 s / 10 amostras durante a falha.** A janela do disjuntor
é de 30 s com `MIN_SAMPLES=10`: se a falha injetada tem volume, a abertura tem
que aparecer dentro dela.

```promql
# Plote os dois no MESMO gráfico, step 15s, sobre o intervalo da injeção.
# O critério é a distância horizontal entre a primeira subida de cada um.
sum by (provider, workload) (increase(maia_llm_requests_total{status=~"error|timeout"}[1m]))
sum by (provider, workload) (increase(maia_llm_circuit_would_open_total[1m]))
```

Não há PromQL honesta para "quantos segundos entre A e B" num painel de
plantão; o número exato sai do harness, que carimba a transição no relatório do
cenário `outage`.

**3. Recuperação em até 60 s.** Depois de o provider voltar, o par tem que
fechar. `MAX_OPEN_MS` é 60 s, então mais que isso significa que a sonda não está
rodando (falta de tráfego) ou que o cooldown geométrico ficou preso.

```promql
# Exatamente uma das três séries vale 1 — nunca leia por valor numérico.
maia_llm_circuit_state{state="closed"}
# Cruze com o instante em que a falha parou:
sum by (provider, workload) (increase(maia_llm_requests_total{status=~"error|timeout"}[1m]))
```

No cenário `recovery` do harness isso é medido direto: ele espaça a carga
justamente para a sonda chegar a rodar.

**4. `would_reject` limitado à falha mais o cooldown.** Recusa simulada
sobrando DEPOIS de o provider voltar é cooldown longo demais — em `enforce`
seria tráfego bom recusado.

```promql
sum by (provider, workload) (increase(maia_llm_circuit_would_reject_total[5m]))
```

Critério: a série zera dentro de `MAX_OPEN_MS` (60 s) após a última falha do
par. Sobrar depois disso bloqueia a promoção.

**5. ≥ 90% de redução das TENTATIVAS contra o provider numa indisponibilidade
total.** É o único critério que mede o BENEFÍCIO; sem ele a promoção paga o
risco de recusar tráfego e não compra nada.

Tentativa ≠ chamada. `maia_llm_requests_total` conta CHAMADAS; quem conta o que
o provider realmente comeu é `maia_llm_attempts_total`, incrementada uma vez por
tentativa e **só depois de `provider.call()` ter rodado**
(`recordAttempt` em `src/lib/llm/gateway.ts`) — uma chamada recusada pelo
disjuntor não gera tentativa nenhuma. Num workload com retry + fallback a
diferença entre as duas é o multiplicador que o disjuntor corta.

```promql
# A carga REAL contra o provider, por par. É esta série que precisa cair.
sum by (provider, workload) (increase(maia_llm_attempts_total[5m]))

# Baseline: a mesma série durante a queda injetada AINDA em `shadow` — é o que
# o provider come quando o disjuntor não recusa nada.
# Critério: numa queda equivalente sob `enforce`, esta soma tem que ficar
# em <= 10% do baseline para o mesmo par.

# Cruze com as recusas, que são o outro lado da mesma moeda:
sum by (provider, workload) (increase(maia_llm_requests_total{status="circuit_open"}[5m]))
  /
clamp_min(sum by (provider, workload) (increase(maia_llm_requests_total[5m])), 1e-9)
```

O veredicto formal continua saindo do harness, que roda os três braços sobre a
MESMA sequência de falhas — em staging não dá para ter `off` e `enforce` ao
mesmo tempo:

```bash
# `provider_calls` do relatório é a mesma grandeza de `maia_llm_attempts_total`.
npm run llm:bench -- --scenario outage --workload reasoner --requests 300 --concurrency 20
# Critério: enforce.provider_calls <= 0.10 * off.provider_calls
```

**6. A recusa simulada não concentra num tenant só.** O estado do disjuntor é
global de propósito, mas a evidência é escopada: se um tenant come 95% das
recusas simuladas, entenda por quê antes de ligar.

```promql
topk(5, sum by (tenant_id) (increase(maia_llm_circuit_would_reject_total[24h])))
```

#### Checklist final

- [ ] A lacuna de reconexão do pub/sub foi corrigida (pré-requisito bloqueante acima).
- [ ] 7 dias completos em staging, com outage + brownout + recovery injetados.
- [ ] Todo par `(provider, workload)` ATIVO com ≥ 1.000 chamadas na janela.
- [ ] Critério 1 vazio: zero `would_open` fora de erro elevado.
- [ ] Critério 2: abertura dentro de 30 s / 10 amostras na falha injetada.
- [ ] Critério 3: recuperação em até 60 s.
- [ ] Critério 4: `would_reject` limitado à falha + cooldown.
- [ ] Critério 5: `enforce.provider_calls ≤ 10%` de `off.provider_calls` no `outage`.
- [ ] Critério 6: distribuição por tenant explicada.
- [ ] TODOS os workloads ativos passaram — a postura é global.

**Como promover:** `LLM_CIRCUIT_MODE=enforce` no `.env` do ambiente + restart.
É deploy-time de propósito — promover é decisão versionada, não de plantão.


### Rollback da promoção

| Sintoma | Ação | Custo |
|---|---|---|
| `circuit_open` subindo sem queda de provider correspondente | kill switch para `off` (acima) | segundos, sem restart |
| Quer manter a medição mas parar de recusar | mesmo procedimento, `"mode":"shadow"` | segundos, sem restart |
| Redis fora, ou o incidente vai durar mais que 24h | `LLM_CIRCUIT_MODE=shadow`/`off` + restart | um restart |

Depois de estabilizar: **deixe o override expirar sozinho e reverta a env var no
código**. Um kill switch renovado indefinidamente vira configuração escondida —
que é como um controle morre de vez, sem ninguém perceber.

> **Nota de honestidade.** A #534 defendeu por escrito que política de
> degradação é código versionado, não toggle de runtime. Esta seção existe
> porque o owner overruled aquilo, e a razão é boa: o argumento vale para
> AJUSTAR limiares e não vale para DESLIGAR um controle que virou o incidente.
> A parte certa da objeção ("sem deixar rastro") foi endereçada — o override é
> obrigatoriamente identificado, contado, logado, **auditado em `audit_log`** e
> temporário. O "auditado" só passou a ser verdade na revisão da PR #541: até
> ali o rastro vivia só em métrica e log, os dois com retenção curta, e
> `grep -rn "audit(" src/lib/llm/` devolvia zero.

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

> **Movido para [`backup-restore.md`](backup-restore.md)** (issue #520). O procedimento abaixo ficou incorreto em dois pontos que importam:
>
> - escolher o dump por `ls | tail` ignora se o artefato foi verificado, se está cifrado e se existe cópia off-site — `backup_runs` responde isso;
> - restaurar e subir o app direto **ressuscita** dados excluídos depois do snapshot. A reconciliação de tombstones é obrigatória antes de liberar tráfego.

Resumo rápido (detalhes e SQL de diagnóstico no runbook dedicado):

```bash
ssh maia 'cd /opt/maia && npm run backup'        # exit 0 ok · 2 DEGRADED · 1 failed
ssh maia 'cd /opt/maia && npm run restore:test'  # drill em DB efêmero
```

Recuperação real: pare o app → escolha o artefato **por evidência** em `backup_runs` → verifique checksum e assinatura do manifesto → decifre → `pg_restore` → `npm run db:migrate` → **reconcilie tombstones** → reconcilie mídia/Redis/sessão Baileys → só então inicie.

**Janela de perda**: até 24h (backup é nightly). RPO menor exige PITR/WAL archiving — sub-escopo planejado, não prometido.

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
| `maia_llm_requests_total{status=~"error\|timeout"}` | counter | rate alto — inclui o timeout do SDK, que `status="error"` sozinho não pega |
| `maia_llm_calls_total{status="error"}` | counter | legada (só provider/model/status); mantida para dashboards antigos |
| `maia_llm_tokens_total{kind=...}` | counter | rate alto = custo |
| `maia_llm_latency_ms` | histogram | p99 > 30s |
| `maia_audit_events_total{action,tenant_id,agent_id}` | counter | crescimento súbito em ações sensíveis (filtrável por tenant) |
| `maia_llm_circuit_state{provider,workload,state}` | gauge | `{state="open"} == 1` por > 2min |
| `maia_llm_circuit_transitions_total{provider,workload,state,reason}` | counter | qualquer transição com `state="open"` |
| `maia_llm_circuit_short_circuited_total{provider,workload,state}` | counter | rate alto = carga sendo recusada |
| `maia_llm_requests_total{status="circuit_open"}` | counter | separa carga recusada por nós de erro do provider |
| `maia_llm_circuit_mode{state}` | gauge | `{state="off"} == 1` por > 1h (kill switch esquecido ligado) |
| `maia_llm_circuit_mode_overrides_total{state,reason}` | counter | **qualquer** incremento — é o kill switch sendo usado |
| `maia_llm_circuit_would_open_total{provider,workload,reason}` | counter | em `shadow`: abertura simulada. Cruze com a taxa de erro real antes de promover |
| `maia_llm_circuit_would_reject_total{provider,workload,state}` | counter | em `shadow`: carga que SERIA recusada. Carrega `tenant_id`/`agent_id` |

O gauge é um **par de séries**, uma por estado, exatamente uma valendo `1` —
mesmo formato de `maia_lifecycle_state{role,state}`. Alerte em
`maia_llm_circuit_state{state="open"} == 1`, nunca num valor numérico. O mesmo
vale para `maia_llm_circuit_mode{state}`.

**Leia `maia_llm_circuit_state` junto com `maia_llm_circuit_mode`.** Um disjuntor
marcando `open` na postura `shadow` **não está recusando nada** — ele está
medindo. Alertar em `state="open"` sem qualificar a postura produz plantão
acordado por um incidente que não existe:

```promql
# "o disjuntor está REALMENTE recusando":
maia_llm_circuit_state{state="open"} == 1 and on() maia_llm_circuit_mode{state="enforce"} == 1
```

Em `off` a série de estado vira `NaN` (amostra ausente), nunca `0` — `0` diria
"fechado e saudável" sobre um disjuntor que não está observando coisa alguma.

`would_open` e `would_reject` só existem em `shadow`; `short_circuited` só em
`enforce`. Procedimento de promoção e rollback: §3.1.

Ele é registrado pelo próprio disjuntor (`src/lib/llm/circuit-breaker.ts`), sob
demanda, na primeira vez que um par `(provider, workload)` é exercitado — não há
nada a ligar em `src/server.ts`. **Um par que nunca recebeu tráfego não tem
série alguma**, o que é diferente de ter série em `0`: a primeira coisa a checar
quando um alerta não dispara é se aquele workload chegou a rodar.

### 8.1 Probes — qual endpoint usar onde (issues #512 e #613)

Quatro superfícies com **contratos diferentes**. **Três são probes; a quarta
não é.** Apontar o probe errado para o endpoint errado transforma queda de
dependência em restart loop — ou, no caso do `/health`, em um health check que
nunca reprova nada.

| Endpoint | Pergunta que responde | Faz I/O? | Veredito no status HTTP? | Usar em |
|---|---|---|---|---|
| `/livez` | o processo está vivo? | **não** (nenhum) | **sim** — 200 sempre que o processo responde | liveness do orquestrador / `healthcheck` do compose |
| `/startupz` | a inicialização terminou? | não | **sim** — 503 até `ready` | startup probe |
| `/readyz` | o load balancer deve mandar tráfego? | sim, read-only e cacheado | **sim** — 503 fail-closed | readiness probe / pool do LB |
| `/health`, `/health/{db,redis,whatsapp}` | qual componente está ruim? | sim, read-only e cacheado | **NÃO — 200 sempre** (issue #613) | diagnóstico humano, dashboards. **Nunca como probe** |

> **`/health` responde 200 mesmo dizendo `"status":"down"`, e isso é a decisão,
> não o defeito** — [ADR 0003](../architecture/decisions/0003-health-is-diagnostic-livez-readyz-are-the-probes.md),
> issue #613. O 200 ali afirma *"produzi o relatório"*, não *"o sistema está
> bem"*; o veredito é o corpo. O motivo de ele não virar 503 é `checkAll()`
> (`src/lib/healthcheck.ts`): ele é **role-blind e chapado** — não conhece
> `MAIA_PROCESS_ROLE`, não separa componente obrigatório de observado e não tem
> política de degradação, então `whatsapp: down` derruba o agregado para `down`,
> que é o **estado normal** de um processo `api`, `worker` ou `scheduler`. Um LB
> apontado para lá tiraria de rotação instâncias corretas. O gate role-aware é
> o `/readyz`, e é o único.
>
> Como reconhecer o endpoint em campo: toda resposta de `/health*` traz o header
> `x-maia-endpoint-kind: diagnostic`, e o corpo do agregado traz
> `"probe": false` mais o mapa `probes` com `/livez`, `/startupz` e `/readyz`.
>
> **Se o seu health check aponta para `/health`, ele nunca detectou nada.**
> Troque: `/livez` se o campo decide **restart**, `/readyz` se decide
> **roteamento de tráfego**.

Não há `/health/llm` — use `maia_llm_requests_total{status}` no Prometheus (a
legada `maia_llm_calls_total` não separa por workload).

Regras que o código garante (`src/runtime/lifecycle/`):

- **`/livez` nunca toca DB, Redis, WhatsApp ou disco.** Um `/health` como
  liveness fazia o container ser reiniciado quando o Postgres caía — o
  processo estava perfeitamente vivo.
- **`/readyz` é role-aware** (`MAIA_PROCESS_ROLE`, ver §8.2) e **fail-closed**:
  503 enquanto `starting`, `draining`, `failed` ou `stopped`, e 503 se um
  componente obrigatório do papel estiver `down`/`unknown` (DB, Redis,
  pressão de memória do Redis, schema, fila/worker, sessão).
- **`/readyz` vira 503 no primeiro request depois do SIGTERM** — o estado é
  checado antes (e fora) do cache.
- **Nenhum probe escreve.** Antes do #512 cada chamada de `/health` inseria 3
  linhas em `system_health_events`; a série histórica agora é escrita pelo cron
  `health_monitor` (1×/min).
- **Nenhum probe devolve texto cru de driver** (`details` é removido na borda
  HTTP; a mensagem completa vai só para o log).
- **`/health*` nunca reprova** (issue #613): o `reply.code(200)` é explícito no
  handler (`asDiagnostic()`, `src/server.ts`) e
  `tests/unit/server/health-probe-contract.spec.ts` reprova se alguém torná-lo
  condicional — ou se remover a marcação que declara o endpoint como
  diagnóstico.

> **Cold start / pareamento.** Nos papéis que exigem a sessão (`all`,
> `session-owner`), o primeiro `connection.update = open` real — e não o
> retorno de `startBaileys()` — é o marco de "subiu". Até ele acontecer:
>
> - `whatsapp_session` fica `starting`;
> - o lifecycle fica em `starting` (não vai para `ready`);
> - **`system_started` NÃO é auditado** — a trilha não pode dizer que o sistema
>   subiu num instante em que ele não atendia;
> - `/startupz` e `/readyz` respondem **503**;
> - `/livez` responde 200 (o processo está vivo) e o log emite
>   `lifecycle.still_waiting_for_component` a cada 30s.
>
> O `/setup` continua acessível (é rota HTTP, fora dos gates), então o fluxo de
> QR/código funciona normalmente — acesse o host diretamente, não pelo pool do
> load balancer. **Não** aponte um startup probe com `failureThreshold` curto
> para `/startupz` num host que ainda vai ser pareado: o probe mataria o pod
> antes de alguém conseguir escanear o QR. Use `/livez` para liveness (é o que
> o `compose.prod.yml` faz).
>
> A espera é interrompível: um SIGTERM durante o pareamento aborta o boot e
> drena limpo (`maia.startup_aborted_by_shutdown`).
>
> Depois do primeiro `open`, uma queda de socket vira `degraded` e a instância
> **permanece** em rotação (anti-flapping); um `loggedOut` vira `failed` e tira
> de rotação, porque aí a sessão realmente acabou e exige novo pareamento.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/livez     # 200 sempre que o processo responde
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/startupz  # 503 → boot ainda em andamento
curl -s http://localhost:3000/readyz | jq '.ready, .state, .role, (.checks[] | select(.required))'
```

#### O componente `schema` do `/readyz` (issue #516)

Desde a #516 o componente `schema` **é o veredito canônico de migrations**
(`getSchemaReadiness()`, `src/migrations/readiness.ts`), e não mais a
comparação "id mais novo do ledger × arquivo mais novo em disco". O check
antigo (`checkSchemaVersion()`, removido na ADR 0004) não enxergava checksum
divergente, linha `dirty`/`running` órfã nem migration aplicada que o build não
empacota — e reportava "banco à frente do artefato" como saudável.

Cada uma destas condições responde **HTTP 503** e mantém a instância fora de
rotação:

| Condição | `state` | `checks[].detail` contém | Como sair |
|---|---|---|---|
| Linha `dirty` no ledger | `blocked` | `dirty_migration` | Inspeção + `migrate repair` — ver [`migrations.md`](migrations.md) |
| Checksum do artefato ≠ checksum do ledger | `blocked` | `checksum_mismatch` | Um arquivo já aplicado foi editado, ou o build errado subiu. Reverta o deploy ou corrija o artefato |
| Ledger cita migration que este build não empacota | `blocked` | `missing_file` | O banco está num schema que este release não verifica: suba o release novo, não este |
| Migration aplicada sem checksum registrado | `blocked` | `checksum_unknown` | Rode `npm run db:migrate` uma vez (o runner faz o backfill) |
| Head esperado não aplicado | `blocked` | `schema_below_minimum` | `npm run db:migrate` |
| Migration `running` (migrator em voo ou que morreu) | `blocked` | `running_migration` | Espere o migrator; se ninguém está rodando, é debris — `migrate up` promove para `dirty` |
| Banco fora, ledger ausente ou `migrations/` ilegível | `unknown` | `ledger_unavailable` / `ledger_missing` | **`unknown` também é 503** — nunca "não consegui ler ⇒ pronto" |

Diagnóstico:

```bash
curl -s http://localhost:3000/readyz | jq '.checks[] | select(.component=="schema")'
npm run db:migrate -- status      # mesmo veredito, com o relatório completo
```

O corpo do `/readyz` carrega apenas literais nossos (`kind` do blocker + o
texto do blocker). Mensagem de driver, SQL e `DATABASE_URL` **nunca** saem —
uma mensagem de erro do pg embute a DSN com senha.

**Custo e cache.** `getSchemaReadiness()` relê e faz SHA-256 de todas as
migrations empacotadas e lê o ledger inteiro (~50-100 ms medidos neste repo).
O veredito é cacheado por **10 s** (`SCHEMA_READINESS_TTL_MS` em
`src/runtime/lifecycle/schema-readiness.ts`) e chamadas concorrentes são
coalescidas, então o custo é ~uma avaliação por 10 s por réplica,
independentemente da frequência do LB.

**Não confunda "uma avaliação por 10 s" com "obsoleto por até 10 s".** São
números diferentes, e o segundo é o que importa durante um incidente. O
`/readyz` passa por DOIS caches: este TTL de 10 s e o cache composto de
`evaluateComponents()`, que memoiza o conjunto inteiro de componentes por
`READINESS_CACHE_MS` (2 s no default). Uma entrada composta preenchida um
milissegundo antes do TTL interno expirar continua servindo aquele veredito até
ELA expirar. Então:

| pergunta | número |
|---|---|
| com que frequência o schema é REAVALIADO | uma vez por 10 s por réplica |
| por quanto tempo um 200 obsoleto pode sobreviver | **`SCHEMA_READINESS_TTL_MS + READINESS_CACHE_MS`** — 12 s nos defaults |
| e se eu subir o `READINESS_CACHE_MS` | a janela cresce junto, **sem teto no contrato de config hoje** |

Consequência operacional: depois que o schema fica incompatível a instância
ainda pode responder 200 por até 12 s — dentro da janela em que o próprio load
balancer ainda não declarou o alvo unhealthy — e depois que o `migrate up`
conserta, ela leva até 12 s a mais para voltar à rotação.

A soma está fixada em `tests/unit/runtime/lifecycle-schema-readiness.spec.ts`:
mexer em qualquer um dos dois valores reprova o teste com o número novo, para
esta tabela não apodrecer.

**Ordem de deploy.** O migrator precisa rodar **antes** da aplicação. Um banco
com ledger v1 (linhas sem checksum) deixa o `/readyz` em 503 com
`checksum_unknown` até o `migrate up` adotar os checksums empacotados.

**`READINESS_SCHEMA_CHECK=false` é inválido em production.** A validação de
configuração **recusa o boot** (`lifecycle/schema-check-disabled`, severidade
`error`, escopo `boot` — vale inclusive sob
`MAIA_CONFIG_STRICT_BOOT=false`). Em `staging` continua permitido, com aviso;
em `development` é silencioso. Desligar o flag faz o componente `schema`
reportar `ok` sem consultar nada — é exatamente a porta que a #516 fechou para
produção.

#### O gate de BOOT: o mesmo veredito, mas o processo MORRE (issue #516, ADR 0004)

Desde a decisão do owner na #516 ([ADR 0004](../architecture/decisions/0004-boot-fails-closed-on-the-canonical-schema-verdict.md))
o passo `schema` do boot (`src/index.ts`) consulta **o mesmo
`getSchemaReadiness()`** e **encerra o processo** quando o veredito não é
`ready`. O check fraco anterior (`checkSchemaVersion()`) foi REMOVIDO — não
existe mais um segundo, mais permissivo, veredito de schema em lugar nenhum.

O exit code diz **qual invariante quebrou**, antes de qualquer log ser lido:

| Exit | Invariante | O que fazer |
|---|---|---|
| `90` | ledger `dirty` (ou `running` órfão): schema possivelmente parcial | Inspecione e repare: `tsx scripts/migrate.ts repair --id <id> --as applied\|pending --reason "..."` |
| `91` | **checksum divergente** — migration aplicada foi editada, ou o build é outro | Restaure o arquivo / publique a release certa. Migrations são append-only |
| `92` | checksum **ausente** (ledger v1 nunca backfillado) | `npm run db:migrate` uma vez (adota o checksum empacotado) |
| `93` | o banco aplicou migration que **este build não empacota** | Release velha contra banco novo: publique a release nova |
| `94` | **migration obrigatória ausente** — schema abaixo do mínimo | `npm run db:migrate` (ou `npm run release:migrate` no pré-deploy) |
| `95` | schema **acima** do máximo suportado por este build | Publique a release nova; não sirva tráfego desta |
| `96` | migration `running` — migrator em voo, ou morto | Aguarde o job; se não há migrator, é entulho (`migrate status`) |
| `97` | veredito `unknown` — ledger ausente/ilegível, banco fora do ar | `npm run doctor -- --online`; confirme DSN e permissões |
| `98` | **índice `indisvalid = false`** — DDL `CONCURRENTLY` reprovou, e um índice único inválido **não impõe nada** | `DROP INDEX CONCURRENTLY <schema>.<indice>`, resolva a duplicata, reaplique. NÃO reaplique antes de dropar: o `IF NOT EXISTS` devolve sucesso sobre o índice inválido ([runbook de migrations](migrations.md#índice-inválido-deixado-por-ddl-concurrently)) |
| `1` | qualquer OUTRA falha de boot (Redis, keyring, config…) | Ver `maia.fatal` no log |

```bash
docker inspect --format '{{.State.ExitCode}}' <container>   # 90-98 ⇒ é schema
docker logs <container> 2>&1 | grep maia.schema_boot_refused
```

A linha `maia.schema_boot_refused` carrega, em campos estruturados:
`exit_code`, `blocker`, `blockers` (todos os presentes), `verdict`,
`migration_id`, `expected_checksum` (arquivo empacotado), `found_checksum`
(linha do ledger), `expected_head`, `applied_head` e `remediation`. A mensagem
do erro (`maia.fatal`) traz o mesmo em bloco legível, começando por
`SCHEMA BOOT REFUSED`. **Nada disso carrega SQL, texto de driver ou DSN.**

##### Árvore de decisão do operador — exit code OU readiness, nunca os dois

Coerente com a [ADR 0003](../architecture/decisions/0003-health-is-diagnostic-livez-readyz-are-the-probes.md):
o `/readyz` continua sendo o **único** gate de roteamento, role-aware e
fail-closed. O que mudou é que existe agora um estado anterior a ele — o
processo pode nem chegar a escutar HTTP.

```text
O container está de pé?
├─ NÃO (crash loop)  → o sinal é o EXIT CODE. /readyz nunca respondeu.
│                      90-98 ⇒ schema (tabela acima). 1 ⇒ outra dependência.
│                      Log: maia.schema_boot_refused → maia.fatal.
│                      NÃO existe instância para inspecionar: leia o log do
│                      container morto, não o endpoint.
└─ SIM               → o sinal é o /readyz (503 com o componente nomeado).
   ├─ 503 com checks[].component=="schema"
   │     ⇒ o schema mudou DEBAIXO de um processo que já tinha subido
   │       (deploy de migration com o app no ar). O app sai de rotação e
   │       fica inspecionável. Mesmas condições, mesma remediação.
   └─ 503 em outro componente ⇒ §8.1, tabela de probes.
```

Por que as duas posturas coexistem sem se contradizer: o boot pergunta **"posso
existir?"** e a readiness pergunta **"posso receber tráfego?"**. Um processo que
NASCE sobre um schema que não pode verificar não tem trabalho legítimo a fazer —
morrer é mais honesto (e mais visível) do que ficar de pé eternamente 503. Um
processo que JÁ ESTAVA servindo e vê o schema mudar sai de rotação e continua
inspecionável, que é o comportamento certo para um deploy em andamento.

**O crash loop não deveria acontecer no caminho normal.** Quem o impede é o gate
de migration: o job one-shot do `compose.prod.yml` (`depends_on:
service_completed_successfully`) ou `npm run release:migrate` no pré-deploy do
painel (#565). Se o app está em crash loop por schema, ou o gate não rodou, ou
ele rodou e falhou sem bloquear o rollout — verifique isso ANTES de mexer no
banco.

**Dev e teste morrem igual, de propósito.** Não há variável nova nem exceção por
ambiente: a única alavanca é a que já existe no contrato,
`READINESS_SCHEMA_CHECK=false` — silenciosa em `development`, aviso em
`staging`, **recusada no boot em `production`**. Use-a apenas onde código e
schema são publicados fora de banda de propósito (ex.: `npm run dev` contra um
banco de outra branch). O CI não é afetado: nenhuma suíte executa o `main()` de
`src/index.ts` a não ser `tests/unit/runtime/schema-boot-gate.spec.ts`, que
injeta o próprio ledger.

> As variáveis desta seção vivem no contrato de configuração (#515): grupo
> **Lifecycle do processo** em `src/config/contract.ts`, documentadas em
> [`docs/configuration.md`](../configuration.md). As relações entre elas são
> regras executáveis em `src/config/rules.ts` — `npm run config:check` avisa,
> por exemplo, se `SHUTDOWN_STEP_TIMEOUT_MS` ficar maior que
> `SHUTDOWN_GRACE_MS`.

### 8.2 Papel do processo (`MAIA_PROCESS_ROLE`)

Contrato em `src/runtime/lifecycle/roles.ts`. Hoje todo processo roda `all`
(modo compatível). Os demais papéis existem para a separação de topologia
(issue #513) e já mudam o que `/readyz` exige:

| Papel | Inicia | `/readyz` exige |
|---|---|---|
| `all` | tudo | tudo |
| `api` | HTTP + filas (produtor) | config, db, schema, redis, redis_memory, queue, http |
| `worker` | filas + worker BullMQ | config, db, schema, redis, redis_memory, queue, agent_worker |
| `scheduler` | crons | config, db, schema, redis, redis_memory, cron_scheduler |
| `session-owner` | sessões WhatsApp + filas | config, db, schema, redis, redis_memory, queue, whatsapp_session |

Valor desconhecido = erro de boot (fail-closed), nunca fallback permissivo.

### 8.3 Métricas de lifecycle

| Métrica | Tipo | Alerta se |
|---|---|---|
| `maia_lifecycle_state{role,state}` | gauge | `state="failed"`=1, ou `state="draining"`=1 por > grace |
| `maia_lifecycle_transition_total{role,from,to}` | counter | transições para `failed` |
| `maia_readiness_check_total{component,result}` | counter | `result!="ok"` sustentado |
| `maia_readiness_check_duration_ms{component}` | histogram | p99 perto do `READINESS_PROBE_TIMEOUT_MS` |
| `maia_shutdown_total{result,role}` | counter | `result="incomplete"` |
| `maia_shutdown_duration_ms{component}` | histogram | passo perto do `SHUTDOWN_STEP_TIMEOUT_MS` |
| `maia_shutdown_forced_total{reason,role}` | counter | **qualquer** incremento |
| `maia_shutdown_undrained_startup_total{step}` | counter | **qualquer** incremento (fase de boot travada; recurso pode ter ficado aberto) |
| `maia_worker_active_jobs{worker}` | gauge | =1 continuamente (job travado) |
| `maia_worker_last_success_timestamp{worker}` | gauge | idade > 3× a cadência do cron |
| `maia_worker_last_failure_timestamp{worker}` | gauge | recente + sem sucesso depois |
| `maia_worker_tick_skipped_total{worker,reason}` | counter | crescimento (execução anterior não termina no intervalo) |

### 8.4 LLM Gateway (issue #508)

Todas as chamadas de chat/classificação/visão passam por `src/lib/llm/`. A
partir da #508 o gateway emite em **todo** desfecho — sucesso, erro, timeout,
rate limit e cancelamento (antes só o caminho de sucesso era contado, e chamadas
diretas ao SDK não eram contadas de forma alguma):

| Métrica | Tipo | Alerta se |
|---|---|---|
| `maia_llm_requests_total{tenant_id,agent_id,provider,model,tier,workload,status}` | counter | `status!="ok"` subindo |
| `maia_llm_request_duration_ms{provider,model,tier,workload,status}` | histogram | p95 fora do baseline do workload |
| `maia_llm_attempts_total{provider,model,workload,outcome}` | counter | razão attempts/requests > ~1.2 = retry storm |
| `maia_llm_fallback_total{from_model,to_model,workload,reason}` | counter | qualquer taxa sustentada = degradação de qualidade silenciosa |
| `maia_llm_timeouts_total{provider,model,workload}` | counter | rate alto |
| `maia_llm_cancelled_total{provider,model,workload}` | counter | rate alto sem deploy = turnos sendo abortados |
| `maia_llm_settings_cache_total{result}` | counter | `result="error"` sustentado = servindo modelo de env, não o do Admin |
| `maia_llm_scope_missing_total{workload}` | counter | > 0 = chamada sem tenant/agent no ALS (custo não atribuível) |
| `maia_llm_cost_ledger_failures_total` | counter | > 0 = custo sendo perdido |
| `maia_llm_budget_exhausted_total{tenant_id,agent_id,workload}` | counter | quota diária estourada |
| `maia_llm_budget_check_failures_total{workload}` | counter | > 0 = Redis fora, quota degradou ABERTO (não está protegendo) |
| `maia_llm_budget_settle_failures_total` | counter | > 0 = reserva não liquidada; contador fica conservador até o TTL |

Salvo `maia_llm_scope_missing_total` e os counters de falha, todas as métricas
acima carregam `tenant_id` + `agent_id` — inclusive duração, timeout,
cancelamento, fallback, tokens e attempts. Antes só `requests_total` levava o
escopo, e um tenant sozinho estourando latência ficava diluído na média de
todos.

**Como a quota funciona.** Não é uma checagem antes da chamada: é uma RESERVA
atômica (`INCRBYFLOAT` num contador diário por `tenant+agent` no Redis) feita
antes de qualquer I/O de provider, liquidada com o custo real depois da
resposta. Checar-e-seguir deixava N chamadas concorrentes lerem o mesmo valor e
passarem todas — falhava justamente no retry storm. O contador é semeado a
partir do ledger na primeira escrita do dia (restart não zera a quota) e expira
em 36h; a verdade contábil continua no Postgres.

**Erros que o gateway recusa de primeira** (terminais, sem retry e sem
fallback): `authentication`, `permission`, `invalid_request`,
`budget_exhausted`, `response_invalid` (200 sem conteúdo utilizável — antes
virava `status="ok"` com resposta vazia) e `missing_tenant_context` (chamada
sem `tenant_id`/`agent_id` no ALS; trabalho global deve rodar sob
`runWithSystemContext()`).

**Mensagens de erro não carregam corpo do provider.** Só `kind`, `status` e
`request_id`. Um `400` costuma ecoar o input, e o input é conversa de cliente —
leve o `request_id` para o suporte do provider.

`trace_id`, `pessoa_id`, conversa e mensagem **não** são labels (cardinalidade);
aparecem só no log estruturado `llm_gateway.call`.

**Trocar de modelo durante um incidente:** `/dashboard/llm-settings`. A escrita
publica no canal `maia:llm:settings:invalidate` e todas as réplicas soltam o
cache na hora; se o Redis estiver fora, cada réplica converge sozinha pelo TTL
curto do cache (segundos). Confirme pelo log `llm_gateway.settings_cache_invalidated`.

**Fixar provider:** `LLM_PROVIDER` (`anthropic` | `openrouter`) + a chave
correspondente. A partir da #508 o provider é resolvido por chamada, não no
carregamento do módulo, e módulos de cognição não exigem mais
`ANTHROPIC_API_KEY` quando o provider é OpenRouter.

**Cortar gasto:** `LLM_DAILY_BUDGET_USD` (por tenant+agent, USD/dia). `0`
desliga. Estouro rejeita a chamada ANTES de qualquer requisição ao provider,
com erro não retentável. Para zerar a quota de um tenant no meio do dia, apague
a chave `maia:llm:budget:<AAAA-MM-DD>:["<tenant>","<agent>"]` no Redis — ela é
recriada a partir do ledger na chamada seguinte.

**Limitar a duração de uma chamada:** `LLM_TURN_DEADLINE_MS` (default 120000) é
o orçamento wall-clock TOTAL de uma chamada quando o caller não declara um
deadline — cobre todas as tentativas, backoff, fallback e parsing, e não
reinicia a cada retry. `CLAUDE_TIMEOUT_MS` é o teto por TENTATIVA e nunca
excede o que resta do deadline.

**Quando o provider cai:** o disjuntor por `(provider, workload)` para de tentar
depois de uma janela deslizante de 30s com no mínimo 10 tentativas em que a
perda estimada de CHAMADAS passa de 50%, e passa a recusar com erro
`circuit_open` — não retentável, carregando `retry_after_ms`. Ele só conta falha
atribuível ao provider (`provider_5xx`, `network`, `timeout` do SDK): payload
inválido, orçamento estourado ou turno cancelado não abrem o disjuntor de
ninguém. O estado é por réplica e em memória, e o restart o zera.

A conta é por CHAMADA, não por tentativa, e cada classe de falha entra com o
expoente do orçamento que ela realmente gasta: um `provider_5xx` retentável só
perde a chamada quando as 3 tentativas do `reasoner` falham (≈84% por
tentativa), enquanto um `timeout` do SDK mata a chamada na primeira (50%). Na
triagem, `window_terminal_faults` no log `llm_gateway.circuit_transition` (e na
linha de `audit_log`) diz qual dos dois foi. Ver
`docs/architecture/modules/lib.md` para os limiares e o porquê de cada um, e
`docs/runbooks/observability-slo.md` §4.9.1 para a leitura do alerta.

Toda transição para `open`/`closed` também vira linha em `audit_log`
(`llm_circuit_opened` / `llm_circuit_closed`, contexto `system`). É o que
alimenta a regra `llm_circuit_long_open` do audit-watcher — o alerta DURÁVEL de
"aberto há mais de 5 min", que sobrevive ao coletor caído.

**…mas só se a postura for `enforce`.** `LLM_CIRCUIT_MODE` tem default
**`shadow`**: por padrão o disjuntor roda a máquina inteira e mede o que faria,
sem recusar chamada nenhuma. Antes de concluir "o disjuntor recusou", cheque
`maia_llm_circuit_mode{state}`. Para desligar durante um incidente sem restart e
sem deploy, ou para promover para `enforce`, o procedimento inteiro está em
**§3.1**.

> Adicionar `maia_db_connected` é um follow-up trivial (uma linha em `src/server.ts` via `setGaugeProvider`). Se quiser alertas baseados nela, abre uma PR.

---

## 9. Restart limpo (zero data loss)

```bash
sudo systemctl stop maia          # SIGTERM → inicia o drain
# Log esperado, nesta ordem:
#   maia.shutting_down
#   lifecycle.transition            from=ready to=draining
#   queue.workers_paused
#   lifecycle.shutdown_step_done    step=stop_accepting_work
#   lifecycle.shutdown_step_done    step=cron_workers
#   lifecycle.shutdown_step_done    step=bullmq
#   lifecycle.shutdown_step_done    step=background_tasks
#   lifecycle.shutdown_step_done    step=turn_context_subscriber
#   lifecycle.shutdown_step_done    step=llm_settings_subscriber
#   lifecycle.shutdown_step_done    step=line_sessions
#   lifecycle.shutdown_step_done    step=baileys
#   lifecycle.shutdown_step_done    step=http
#   lifecycle.shutdown_step_done    step=pools
#   lifecycle.shutdown_complete     result=clean
sudo systemctl start maia
# Aguarde 'http.listening' → 'maia.ready' e /readyz respondendo 200
```

**O que o shutdown faz de verdade**
(`src/runtime/lifecycle/shutdown-sequence.ts`, `registerShutdownSequence`):

0. transição atômica para `draining` → `/readyz` responde 503 no request
   seguinte, e o guard de trabalho novo (`lifecycle.isAcceptingWork()`) fecha
   no mesmo tick do sinal;
1. **para de aceitar trabalho** (`stop_accepting_work`, primeiro passo, sem
   esperar nada): pausa os dois Workers BullMQ (`pause(true)` — para de
   *buscar*) e para de agendar crons. Um job que já estava sendo entregue ao
   processor é reestacionado como `delayed`, não executado;
2. **espera** o tick de cron em execução (antes ele só chamava `task.stop()` e
   seguia em frente, fechando os pools por baixo do job);
3. fecha BullMQ — `Worker.close()` **espera o job ativo terminar**. Vem
   ANTES do WhatsApp para que um turno em voo ainda consiga responder;
4. espera as tarefas fire-and-forget rastreadas (reflection pós-turno, escrita
   de DLQ, registro de linha) — depois da fila e dos crons, que são quem as
   gera;
5. fecha o subscriber de invalidação do cache de contexto do turno (#511). Ele
   tem conexão ioredis PRÓPRIA (o ioredis proíbe outros comandos num cliente
   inscrito), então o `pools` do passo 9 não a cobre; deixá-la aberta segurava
   o event loop e disparava o backstop de saída a cada deploy limpo;
5b. fecha o subscriber de invalidação das settings de modelo do LLM Gateway
   (#508) — mesma forma, mesma razão e mesmo risco do passo 5: ioredis própria
   que o `pools` não alcança. Roda aqui porque todo caller do gateway (turnos
   BullMQ, prompt builders de cron, sonda sintética, tarefas de fundo) já
   drenou, então ninguém mais vai reler modelo;
6. fecha as linhas adicionais e depois a sessão Baileys primária (cancelando o
   timer de reconexão pendente);
7. fecha o Fastify (dispara os `onClose`: timers do coletor de memória e do probe de DB);
8. audita `system_stopped`;
9. fecha Redis e Postgres **por último** (nenhum consumidor fica com handle fechado);
10. sai naturalmente. Não há `process.exit(0)` prematuro.

**SIGTERM durante o boot** é tratado: cada fase do startup roda sob
`lifecycle.runStartupStep`, que aborta o boot no primeiro checkpoint após o
sinal e serializa contra o shutdown (nada é fechado enquanto ainda está sendo
aberto). O log mostra `maia.startup_aborted_by_shutdown` e **não** há
`system_start_failed` — sinal durante deploy não é incidente.

Se a fase de boot **não ceder** dentro de `SHUTDOWN_STEP_TIMEOUT_MS`, o drain
não espera para sempre — mas também **não** se declara limpo: a fase entra em
`undrained` como `startup:<fase>` (log
`lifecycle.shutdown_startup_step_did_not_yield`, counter
`maia_shutdown_undrained_startup_total{step}`), o outcome vira `incomplete` e
o processo sai com `SHUTDOWN_FORCED_EXIT_CODE`. O motivo é concreto: um
`startServer()`/`startBaileys()` que retorna DEPOIS do passo que o fecharia
deixaria listener ou socket vivo num processo que já se disse parado — a saída
forçada entrega ao SO o que não foi possível fechar.

**Orçamento de tempo** — `SHUTDOWN_GRACE_MS` (default 25s) é o teto do drain
inteiro e `SHUTDOWN_STEP_TIMEOUT_MS` (default 10s) o de cada passo. Ele
**precisa ser menor** que o `TimeoutStopSec` do systemd / `stop_grace_period`
do compose (40s no `compose.prod.yml`), senão o SIGKILL corta o drain.

**Quando o deadline estoura:** os componentes não drenados aparecem em
`lifecycle.shutdown_incomplete` (campo `undrained`), o counter
`maia_shutdown_forced_total{reason="drain_deadline"}` incrementa e o processo
sai com `SHUTDOWN_FORCED_EXIT_CODE` (default 1). Trabalho não concluído
continua recuperável: o job BullMQ volta como stalled e a row de inbound
pendente é re-enfileirada pelo `message_recovery`.

**Segundo SIGTERM/SIGINT** força a saída imediata — é auditado
(`system_shutdown_forced`) e metrificado
(`maia_shutdown_forced_total{reason="second_signal_SIGTERM"}`). Use só se o
drain travou.

**Se o boot falhar** (dependência obrigatória fora): não há readiness, o
lifecycle vai para `failed`, `system_start_failed` é auditado, o que já abriu é
fechado e o processo sai com 1. Redis indisponível **não** é mais um warning
silencioso.

Restart preserva: sessão Baileys (`.baileys-auth/`), backups, audit log, jobs
(BullMQ persiste em Redis).

---

## 10. Checklist de deploy novo (cold start)

- [ ] `.env` preenchido e validado — `npm run config:check` (fonte da verdade: `ENV_CONTRACT` em `src/config/contract.ts`; referência gerada em [`docs/configuration.md`](../configuration.md))
- [ ] Postgres + Redis up (`/health/db` + `/health/redis`)
- [ ] `npm run db:migrate` rodado
- [ ] `npm run build` clean
- [ ] App started → log mostra `setup.bootstrap_token_ready` (cold start, sem `creds.json`)
- [ ] SSH cat `.baileys-auth/control/setup-token.txt` → abrir `/setup` no browser → colar o token no formulário (nunca na URL) → escolher QR ou código → parear com WhatsApp do número da Maia
- [ ] Linhas ADICIONAIS: parear pelo Admin (`/setup/channels`), não pelo `/setup` — o console é autenticado e a auditoria fica com o ator administrativo (issue #518)
- [ ] Audit log mostra `system_started`, `pairing_qr_displayed` (ou `pairing_code_requested`), `pairing_completed`
- [ ] `/health/whatsapp` ok
- [ ] Mande mensagem teste pro número Maia → log mostra `baileys.message.enqueued` → resposta do agente em ~3-8s
- [ ] (Opcional) Configurar nginx (uma vez que a PR #23 land, ver `docs/runbooks/setup-nginx.md`): IP whitelist, TLS, fail2ban

---

## 11. Gate de desempenho da carga de contexto do turno (issue #525)

`npm run turn:bench` roda o gate que o dono fixou para a #525: Postgres real,
pool 10, 50 pares tenant/agente, concorrência 20, escopos de 1/10/100 entidades,
braços `cold` e `warm`. Ele exercita o **turno inteiro** — `resolveScope`
(`src/governance/permissions.ts`) seguido de `buildPrompt`
(`src/agent/prompt-builder.ts`, quem publica
`maia_turn_context_load_duration_ms{phase="loader"}`) —, os dois call sites de
produção, dentro do mesmo relógio.

> ### O que a #700 mudou (e o que continua valendo)
>
> Até a #700 este gate media um orçamento **PARCIAL**: `buildContext` fabricava
> o escopo em memória e a massa não semeava `permissoes` nem
> `permission_profiles`, então uma regressão que morasse no `resolveScope`
> passava sem ser vista. O critério "aceite completo do orçamento do turno"
> saía `n/a` e a corrida reprovava por contenção — `exit 1` significava "não
> demonstrado".
>
> **Agora o escopo é resolvido no Postgres, dentro do relógio.** A massa semeia
> TRÊS pessoas por par — uma com 1, outra com 10, outra com 100 linhas em
> `permissoes`, cada permissão apontando para um `permission_profiles`
> distinto (100 por par, sob o teto de 500 do `profilesRepo.byIds`). A
> cardinalidade 1/10/100 do enunciado passou a ser o tamanho do escopo
> RESOLVIDO, não uma fatia em memória.
>
> Três critérios por braço são a evidência disso, e reprovam a corrida se ela
> sumir: as **2 leituras** do escopo em todo turno, o **escopo resolvido**
> batendo com a massa (1–100), e o **p95 do estágio**. O critério agregado
> ("aceite completo do orçamento do turno") lê esses NÚMEROS — virar a flag
> `COBERTURA_DA_MEDICAO.resolve_scope_medido` sem a medição produz um critério
> avaliado e **reprovado**, não uma aprovação.
>
> **Os números anteriores continuam identificados pela cobertura que os
> produziu.** O fingerprint carimba `cobertura`, então um baseline gravado como
> `buildPrompt-sem-resolveScope` é **RECUSADO** para comparação com uma corrida
> `resolveScope+buildPrompt` — não estimado, não convertido. Na prática: **todo
> baseline anterior à #700 precisa ser re-gravado** (`--mode measure
> --sustain-s 60 --write-baseline`), e até lá o critério relativo sai `n/a` e o
> gate reprova dizendo exatamente isso.
>
> Um número medido sob a cobertura antiga **não pode** ser reapresentado como
> medição do turno completo — nem em PR, nem aqui, nem em relatório arquivado.

Não é um teste de unidade nem roda na suíte padrão: pede um Postgres migrado,
escreve ~40 mil linhas de massa (a massa por pessoa triplicou na #700, mais
`permissoes` e `permission_profiles`) e devolve o veredicto por **exit code**.

### Pré-requisitos

```bash
# Postgres migrado e alcançável. O harness usa o mesmo default de tests/setup.ts
# e qualquer variável já presente no ambiente VENCE sobre esse default.
export DATABASE_URL=postgres://maia_test:test1234@localhost:5432/maia_test
export REDIS_URL=redis://localhost:6379     # o braço `warm` usa o subscriber de invalidação
npm run db:migrate
```

### Medir e barrar são coisas diferentes (`--mode`)

O harness faz as duas, e o modo é DECLARADO — não deduzido de uma flag no meio
do comando:

| `--mode` | o que é | exit code |
|---|---|---|
| `gate` (**default**) | o veredicto. Todo critério obrigatório precisa ter sido AVALIADO | `0` aprovado · `1` reprovado (inclui "não avaliado") · `2` erro de uso/infra |
| `measure` | medição absoluta. **NÃO emite veredicto de gate** e diz isso em caixa alta no relatório | `0` (a medição aconteceu) · `2` erro |
| `self-test` | prova que o gate reprova, sobre valores sintéticos | como `gate` |

A regra que amarra tudo: **um critério `n/a` reprova em modo `gate`**. Não
avaliado deixou de ser sinônimo de aprovado — era essa igualdade que deixava um
checkout limpo, sem baseline registrado, sair com exit 0 como se tivesse passado
pelo critério relativo. Se você quer medir sem ter a evidência completa, o modo
é `measure`, e ali o relatório não se apresenta como gate.

### O comando do gate

```bash
# Perfil canônico: 60 s de carga sustentada por braço (~3 min no total).
# A janela de 60 s é o que torna o critério de saturação do pool FALSIFICÁVEL;
# sem --sustain-s ele sai como "não avaliado" — e "não avaliado" REPROVA.
npm run turn:bench -- --sustain-s 60

echo $?     # 0 = gate passou · 1 = reprovou · 2 = erro de uso/infra
#
# Numa máquina sem baseline da cobertura ATUAL (`resolveScope+buildPrompt`), 1
# é o resultado esperado: o critério relativo sai `n/a` e não avaliado reprova.
# Grave o baseline com o MESMO comando (--mode measure --write-baseline) antes
# de ler o exit code como regressão.
```

Este comando exige um baseline compatível registrado (ver "Baseline" abaixo).
Numa máquina nova ele reprova dizendo que não tem a referência — e isso é o
comportamento correto: o gate promete os critérios relativos (p95/p99 ≤
baseline × 1.10, throughput ≥ baseline × 0.90 — margem nomeada em
`MARGEM_RELATIVA_DEFAULT`, `--relative-margin`) e não pode carimbar
o que não mediu. Para medir sem baseline, use `--mode measure`.

Saída em JSON para uma esteira: `npm run turn:bench -- --sustain-s 60 --json`.
O JSON carrega `mode`, `fingerprint` e `gate_evaluated`.

### Os limites, e o que fazer quando um deles fica vermelho

| veredicto vermelho | leitura | primeiro passo |
|---|---|---|
| `p95 ≤ 600 ms` / `p99 ≤ 1 s` | a carga de contexto passou do orçamento | olhe a tabela "latência por leitura" na própria saída — ela diz QUAL leitura cresceu |
| `zero erros e zero timeouts` | um turno falhou ou passou de `--timeout-ms` (default 5 s, o mesmo `connectionTimeoutMillis` do pool) | a saída traz as duas primeiras mensagens de erro |
| `pico de leituras por turno ≤ 6` | um turno passou a segurar mais que sua parte do pool | alguém mexeu em `TURN_CONTEXT_MAX_CONCURRENT_READS` ou tirou uma leitura de dentro do `ReadGate` (`src/agent/turn-context/concurrency.ts`) |
| `o resolveScope foi EXERCITADO: ≥1 leitura de escopo por turno` | **o instrumento voltou a ser cego** (0 leituras: escopo fabricado em memória, massa sem as tabelas do escopo, ou as leituras fora do `instrumentAll`) | leia o número no detalhe. `0–0` é medição ausente, não desempenho. O número em si é dado medido (2 na `main`, 1 com a fusão da #693) — decisão da #525 |
| `contagem de statements por turno com crescimento O(1)` | a contagem por turno CRESCE com a cardinalidade — um N+1 voltou, no escopo ou em qualquer estágio | o detalhe lista o envelope por N. `N=1: 12–12 · N=100: 12–112` é o `byId` por item que a #511 removeu. O teto absoluto é linha de relatório, não critério |
| `o escopo do turno veio do BANCO, nas cardinalidades 1/10/100` | as leituras aconteceram e devolveram outra coisa: escopo vazio (massa faltando) ou tamanho diferente do semeado | `escopo resolvido=0–0` ⇒ a massa não tem `permissoes`; divergência com escopo cheio ⇒ permissão descartada pelo teto de 500 do `profilesRepo.byIds` |
| `p95 do estágio resolveScope ≤ 600 ms` | a degradação mora no escopo, não no loader | olhe as linhas `scope_permissoes`/`scope_profiles` (ou `scope_permissoes_com_profile`, na árvore da #693) na tabela "latência por leitura" |
| `aceite completo do orçamento do turno` **vermelho** | a flag de cobertura diz que mede e os números dizem que não | é o caso "a flag não prova a si mesma": o detalhe traz os três números medidos. Não vire a flag — conserte a medição |
| `o gate satura (pico alcança 6)` | o oposto: alguém "consertou" a concorrência serializando | procure um `await` que virou sequencial dentro de `loadTurnContext` |
| `≥ 10 tenants concorrentes` | a corrida não foi multi-tenant de verdade | rodou com `--pairs`/`--concurrency` menores que o enunciado |
| `a amostragem do pool observou a corrida` | o amostrador não olhou (zero amostras, ou uma lacuna cega maior que 10× `--sample-ms`) | `--sample-ms` maior que a corrida, ou o event loop travado. **Não é veredicto sobre o pool: é ausência de evidência sobre ele** |
| `o pool drena` (perfil normal) | a fila do pool nunca esvaziou durante a carga | ver "ritmo" abaixo — quase sempre é a carga oferecida, não o código |
| `perfil de SATURAÇÃO: o pool drena depois que o produtor para` | a fila continuou cheia com ninguém pedindo nada | isso é conexão vazando, não carga: procure quem não devolveu o client ao pool |
| `…{phase="loader"} observou todos os turnos` | a métrica do aceite parou de sair | `buildPrompt` deixou de publicar, ou deixou de chamar o loader |
| `p95 ≤ baseline × 1.10` / `p99 ≤ baseline × 1.10` **vermelho** | regressão relativa de latência — o critério PRINCIPAL desde a decisão da #525 | ver "baseline" abaixo antes de culpar o código |
| `throughput ≥ baseline × 0.90` **vermelho** | a vazão caiu além da margem — latência paga com fila | compare a linha `throughput (turnos/s)` dos dois relatórios |
| `latência por cardinalidade ≤ baseline × 1.10` **vermelho** | a regressão mora numa cardinalidade só (tenant "elefante") | o detalhe diz qual N regrediu; olhe a tabela por cardinalidade |
| critérios relativos **`n/a`** | não há baseline, ou o que há foi medido com OUTRA carga (ou formato < v4, sem throughput/cardinalidade) | a saída lista campo a campo o que divergiu. Re-grave com a forma desta corrida |
| `carga conforme o enunciado` | a corrida não tem a forma do gate | use o comando canônico acima |

### Ritmo da carga (`--think-ms`) — leia antes de abrir bug de pool

O gerador é de **malha fechada**: `--concurrency` workers, cada um começando o
turno seguinte assim que o anterior acaba. Com `--think-ms 0` isso mantém 20
turnos sempre em voo; como cada turno pode segurar até 6 conexões de um pool de
10, a fila **não tem como esvaziar** — é aritmética, não defeito. Medido em host
de 4 vCPU com Postgres local, braço `cold`, concorrência 20:

| `--think-ms` | turnos/s | p50 | p95 | amostras saturadas | maior sequência |
|---|---|---|---|---|---|
| 0 | 90,7 | 187,7 ms | 386,8 ms | 142/142 (100%) | a corrida inteira |
| 150 (default) | 102,1 | 28,8 ms | 108,7 ms | 99/145 (68%) | 1,3 s |
| 300 | 60,0 | 14,5 ms | 87,1 ms | 27/149 (18%) | 0,3 s |

Note que o martelo entrega **menos** vazão que o ritmo de 150 ms: passado o
joelho da capacidade, a fila só acrescenta espera.

### Os dois perfis (decisão do dono sobre a #525)

> "Concorrência 20 continua como máximo de requisições em voo, mas o perfil
> normal deve definir ritmo/`think_ms`. O perfil sem ritmo passa a ser **teste de
> saturação**; nele, exige-se zero erros/timeouts e **drenagem depois que o
> produtor para** — não drenagem enquanto 20 turnos são repostos continuamente."

| perfil | como se roda | critério de drenagem |
|---|---|---|
| **normal** | `--think-ms 150` (default), o do gate canônico | a fila esvazia **durante** a carga e nunca fica saturada por 60 s seguidos |
| **saturação** | `--think-ms 0` | a fila esvazia **depois que o produtor para**. Zero erros/timeouts continua valendo |

Cobrar drenagem durante a carga no perfil sem ritmo era pedir o impossível — 20
turnos repostos continuamente, até 6 conexões cada, contra um pool de 10 — e
produzia vermelho que não significava regressão.

Por isso toda corrida tem duas **fases**: carga (produtor emitindo) e escoamento
(produtor parado, `--drain-window-ms`, default 2 s). O amostrador marca a
fronteira por timestamp e conta as amostras de cada lado. Sem essa janela não
existe fase de escoamento para observar: o gerador é de malha fechada, então
quando os workers retornam todo turno já terminou, e o amostrador era parado
nesse mesmo instante — zero amostras do lado que interessa.

**Amostras só da fase de carga não são evidência de drenagem.** Esse caso sai
`n/a` e, em modo `gate`, reprova — pelo mesmo motivo que zero amostras reprova.

Medido neste host, perfil de saturação (`--think-ms 0 --turns 400`, braço
`cold`): 40/40 amostras saturadas na carga — 100 %, como a aritmética manda — e
0/20 na janela de escoamento, com a fila esvaziando **39 ms** depois de o
produtor parar. Exit 0.

### Baseline

```bash
# Grava o p95/p99 medidos como referência. NUNCA acontece como efeito colateral
# de uma corrida de gate: baseline é decisão, e por isso exige --mode measure.
npm run turn:bench -- --mode measure --sustain-s 60 --write-baseline
```

`--write-baseline` em modo `gate` é **recusado com exit 2**. Sem essa trava, a
mesma corrida que julga produziria a referência contra a qual ela seria julgada
depois, e "medição absoluta" e "gate" voltariam a ser a mesma saída.

`scripts/turn-context-baseline.json` carrega `recorded_at`, `host`, um `note`
dizendo se é a PRIMEIRA medição ou uma re-gravação, e — desde a correção dos
achados Medium — o **fingerprint da carga**. O arquivo **não é versionado**
(está no `.gitignore`): é a medição da SUA máquina, e cada host grava o seu na
primeira corrida. Três regras:

1. **O baseline é por host — e por momento do host.** Não é figura de retórica.
   Um baseline gravado neste repositório a p95 67,0 ms (`cold`) / 75,9 ms (`warm`)
   foi reproduzido no MESMO host de 4 vCPU, com o mesmo código e o banco vazio,
   num contêiner posterior: 135,5 / 118,5 ms, e depois 154,1 / 114,9 ms. De 56 %
   a 130 % acima do número gravado, sem que nenhum limite absoluto do gate
   (600 ms / 1 s) chegasse perto de cair. Versionar esse arquivo entregaria um
   gate vermelho na chegada para todo mundo que não fosse a máquina que o gravou.
2. **A variação entre corridas iguais na mesma sessão é de ~10–15 %**; a folga de
   +20 % é dimensionada para isso. Ela NÃO absorve troca de máquina, de contêiner
   nem host ocupado — nesses casos re-grave, não discuta o delta.
3. **Re-gravar é uma decisão de revisão.** A folga existe para absorver ruído, não
   regressão. Se o p95 subiu por um motivo aceito, re-grave no MESMO PR que
   aceitou o motivo — não numa corrida solta.

#### O fingerprint: comparar dois p95 medidos com cargas diferentes não é comparar

O baseline grava a FORMA da corrida que o produziu, e a comparação é **recusada**
— não apenas avisada — quando ela diverge. Comparados:

| campo | por que muda o número medido |
|---|---|
| `pairs` | quantos pares distintos a carga toca: localidade de cache e volume por escopo |
| `concurrency` | é o regime de fila; domina a cauda |
| `think_ms` | **o que mais move o número**: p95 de 28,8 ms com 150 ms contra 187,7 ms com 0 |
| `identity` | `legacy` paga um round-trip a mais por turno |
| `cardinalities` | o tamanho do escopo decide quantas entidades cada turno lê |
| `pool_max` | o denominador da saturação. Pool 10 e pool 20 são dois sistemas |
| `max_concurrent_reads` | `TURN_CONTEXT_MAX_CONCURRENT_READS`, lido do código |
| `turns` · `sustain_s` | a duração amortiza o transiente de aquecimento. Mesmo host, mesmo código, minutos de intervalo: 600 turnos (5,7 s) → p95 **118,6 ms**; 60 s sustentados (7 389 turnos) → p95 **22,4 ms**. 5× de diferença por duração de corrida |
| `cobertura` | **a FRONTEIRA medida** (#700). `buildPrompt-sem-resolveScope` e `resolveScope+buildPrompt` medem coisas diferentes; o delta entre eles não é regressão nem melhoria, é troca de régua. Todo baseline anterior à #700 é recusado por este campo |

Registrados mas **não** comparados, de propósito — um fingerprint que invalida o
baseline a cada corrida vira ruído que o operador aprende a ignorar: `host` e
`node`/`platform` (o baseline já é por máquina), `timeout_ms` (classifica
timeouts, não move latência) e `sample_ms` (observa o POOL, não entra no p95 do
turno).

Consequência prática: **o baseline precisa ser gravado com o mesmo comando com
que o gate roda.** Um baseline de `--turns 600` sem `--sustain-s` comparado
contra o gate canônico não é regressão, é outra corrida — e o harness diz isso
em vez de pintar 342 % de delta.

Um baseline em formato antigo — sem fingerprint — também é recusado: ele não
prova com que carga foi medido, e assumir que foi com a certa é o buraco que
esta trava fecha. Apague o arquivo e re-grave.

Quando um número tem que valer para todo mundo, ele está nos critérios absolutos:
p95 ≤ 600 ms, p99 ≤ 1 s, zero erros, pico ≤ 6, o pool drenando, a métrica cobrindo
todos os turnos e a carga com a forma do enunciado. Leia esses primeiro.

### Provar que o gate reprova

O veredicto é código, e código sem prova de falha é decoração. Sem tocar no
banco:

```bash
npm run turn:bench -- --self-test --inject p95_ms=900              # exit 1
npm run turn:bench -- --self-test --inject peak_reads_per_turn=7   # exit 1
npm run turn:bench -- --self-test --inject cold.errors=1           # exit 1
npm run turn:bench -- --self-test --inject pool_samples=0          # exit 1 — zero amostras não é "drenou"
npm run turn:bench -- --self-test --self-test-baseline missing     # exit 1 — sem baseline não há gate
npm run turn:bench -- --self-test --self-test-baseline incompatible # exit 1 — baseline de outra carga

# O estágio `resolveScope` (#700) — as quatro regressões que o gate tem que ver:
npm run turn:bench -- --self-test --inject scope_reads_per_turn_min=0     # exit 1 — escopo fabricado em memória
npm run turn:bench -- --self-test --inject scope_reads_per_turn_max=101   # exit 1 — N+1 no caminho do escopo
npm run turn:bench -- --self-test --inject scope_cardinality_mismatches=1 # exit 1 — escopo ≠ massa semeada
npm run turn:bench -- --self-test --inject cold.scope_p95_ms=900          # exit 1 — degradação NO resolveScope
```

`--inject` é **recusado** sem `--self-test`, para que não vire a porta dos
fundos que faz qualquer regressão passar. O autoteste usa um baseline SINTÉTICO,
nunca o arquivo da máquina: um gate cujo autoteste muda de resultado conforme o
host não prova nada. A bateria completa (todos os critérios, incluindo pico baixo
demais, pool que nunca drena, amostragem cega e baseline incompatível) vive em
`tests/unit/scripts/turn-context-gate.spec.ts` e roda na suíte normal.

A sonda que prova a MEDIÇÃO — e não o avaliador — é
`tests/unit/scripts/turn-context-resolve-scope-medido.spec.ts`: ela roda um
turno de verdade (`runTurnOnce`) contra o `resolveScope` de produção com os
repositórios dublados, conta as leituras pelo MESMO frame que `runArm` usa e
alimenta o veredicto com o que o contador produziu. Fica vermelha se o escopo
voltar a ser fabricado em memória, se as leituras saírem do `instrumentAll`, ou
se o escopo resolvido deixar de ter a cardinalidade semeada.

Ela também defende a **fronteira do cronômetro**, que é outra coisa: o
`resolveScope` pode estar sendo executado e contado e ainda assim ficar FORA do
número que o gate julga. A duração do turno é calculada num lugar só
(`measureTurn`, no próprio harness), e a sonda cobra a aritmética — com relógio
injetado (`turno = escopo + prompt`, valores exatos) e com relógio real (o
estágio domina o turno; `ms ≥ scope_ms`). Subtrair o estágio do relógio do turno
restauraria a cobertura antiga sem mexer em contador, flag ou cardinalidade — e
é exatamente isso que esses casos pegam.

### Massa e limpeza

Tudo que o harness cria usa `tenant_id` com prefixo `bench525-` e é removido no
`finally` e também em `SIGINT`/`SIGTERM`. Desde a #700 isso inclui `permissoes`
e `permission_profiles` — a segunda é removida DEPOIS da primeira, porque a FK
entre elas não é `ON DELETE CASCADE`. Se uma corrida morreu de um jeito que
não deixou nada rodar:

```bash
npm run turn:bench -- --cleanup-only
```

O harness **nunca roda `ANALYZE`** — num banco compartilhado com a suíte,
`ANALYZE` não é desfeito por `ROLLBACK` e envenenaria o plano dos outros specs.

---

## Apêndice — referências cruzadas

- **`docs/runbooks/redis.md`** — política de memória multi-tenant, sizing, sinais de pressão. Leia ANTES de mexer em `maxmemory*` no compose ou no Redis gerenciado.
- **`docs/runbooks/setup-nginx.md`** — IP whitelist, TLS, fail2ban (PR #23, ainda não mergeada na escrita deste runbook).
- **`audit_watcher`** — regras automáticas de detecção de anomalia (PR #24, ainda não mergeada). Mencionado em §1, §3, §7.
- **`scripts/restore-test.ts`** — drill de restore (já no main).
- **`src/workers/backup.ts`** — backup nightly (já no main).
- **`src/workers/cost-monitor.ts`** — alerta de custo LLM diário acima de `DAILY_LLM_USD_THRESHOLD` (já no main).
- **`src/workers/health-monitor.ts`** — vigilância dos health checks (já no main).

Quando #23 e #24 mergearem, este runbook continua válido — as referências forward (marcadas com `>`) viram links concretos sem alterar nenhum comando.
