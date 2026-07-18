# Runbook — Sonda sintética (synthetic agent probe)

Implementa a spec [`docs/superpowers/specs/2026-07-17-synthetic-agent-probe-design.md`](../superpowers/specs/2026-07-17-synthetic-agent-probe-design.md).

## O que é

Um worker cron (`synthetic_probe`) que, continuamente e sem humano, exercita o
agente de ponta a ponta pelo **caminho de produção real** — injeta um inbound
sintético em `ingressUpsertMessage` → resolver → fila de agente → LLM → tools →
persistência → fronteira de saída — e **falha ALTO** quando a Maia para de
responder ou responde errado. A asserção é por **efeito colateral verificável**
(uma `transacoes` com `status='pendente'` correlacionada por `mensagem_id`) +
liveness (a `mensagens direcao='out'`), não por igualdade de string.

Roda num **tenant/agente dedicados** (`__probe__`), isolados dos dados reais.

## Ligar/desligar

- `MAIA_SYNTHETIC_PROBE` (default `false`): gate de comportamento. O worker é
  registrado em **phase 1** mas é NO-OP com a flag off. A flag — não a fase — é
  o kill-switch.
- **Pré-requisito duro (§1.2):** `MAIA_CHANNEL_ROUTING_MODE ∈ {exact_first,
  strict}`. Sob `shadow` o worker **falha fechado** (no-op + audit
  `synthetic_probe_prereq_unmet`) e NUNCA ativa o canal da sonda — um canal
  ativo de tenant ≠ `primary` derrubaria `findPrimaryCatchAllChannel` para
  `multi_tenant:true` e quebraria o ingresso REAL.
- **Guard de prontidão POR TICK:** a cada tick o worker exige que o canal esteja
  **ativo + `is_synthetic`**. Se estiver inativo (antes da ativação ou após uma
  desativação), o `resolveChannel` cairia no catch-all `primary/primary` (tenant
  real) — então o worker **não injeta**, audita `synthetic_probe_prereq_unmet`
  (`reason=channel_not_ready`) e no-opa. O boot fail-fast (que aceita inativo)
  não cobre desativação posterior; o guard por tick cobre.
- **Ativação do canal (NÃO é pareamento Baileys):** a migração 094 semeia o
  canal **INATIVO** (`is_synthetic=true`) com uma linha placeholder
  (`+999000999001`). Essa linha **não pode ser pareada** — nenhuma conta
  WhatsApp real prova posse de `+999...`. A sonda **não precisa** de sessão real
  (inbound injetado + outbound no sink). Ative pelo script dedicado:

  ```
  npm run probe:activate            # ativa
  npm run probe:activate -- --deactivate
  ```

  A ativação é **atômica e auditada**: o UPDATE exige `is_synthetic=true` no
  predicado (nunca liga um canal real, nem por engano), valida o `RETURNING` e
  grava `synthetic_probe_channel_activation` sob o contexto do tenant da sonda.
  **É segura em qualquer modo de roteamento:** `findPrimaryCatchAllChannel`
  **ignora** canais `is_synthetic` — um canal de sonda ativo NUNCA derruba o
  catch-all real (não quebra o ingresso de remetentes desconhecidos). O canal
  sintético também não sobe sessão de linha no boot
  (`listActiveWhatsappLinesCrossTenant` exclui `is_synthetic`). O worker ainda só
  **injeta** sob `exact_first`/`strict` (guard próprio no runtime).

## Boot fail-fast (§1.3)

No boot, o runtime **sempre** carrega o conjunto dos `channels.id`
`is_synthetic=true` no gate do sink (antes do worker de agente) — a
neutralização do outbound de um canal sintético vale **independente da flag** e
sobrevive ao kill-switch/restart (cobre um job antigo ainda na fila que chegue a
`buildOutput`). Adicionalmente, com `MAIA_SYNTHETIC_PROBE=true`, o boot valida no
DB que o triplete de sonda (`tenant+agent+channel`, constantes em
`src/probe/constants.ts`) é **exclusivamente sintético** (`is_synthetic=true`,
tenant ≠ `primary`); se não for, o **boot FALHA**.

O **sink** (em `buildOutput`, `src/gateway/line-output.ts`) intercepta o envio
físico para **qualquer canal `is_synthetic`** (do conjunto carregado no boot),
independente da flag. Devolve um `whatsapp_id` sintético — a
`mensagens direcao='out'` é gravada (prova de liveness), mas **nenhuma**
primitiva de envio real é chamada. Keying por `channel_id` (portador do marcador
imutável) não tem blast radius: só o canal sintético exato é neutralizado. É
impossível, por construção, um reply da sonda sair pela linha real.

## Sinais e alertas

- **Gauge primário (durável):** `synthetic_probe_seconds_since_last_ok` —
  segundos desde o último OK, lido de `synthetic_probe_state.last_ok_at`. Um
  valor que **cresce É o outage** e sobrevive a restart. Alerte por ele na sua
  stack de métricas (ex.: `> 15m`).
- **Alerta secundário (`MAIA_PROBE_ALERT_MODE`):**
  - `log_only` (default, staging): emite log estruturado + métrica, NÃO chama
    `sendAlert`.
  - `alert`: entrega por `sendAlert` (telegram/email) só na **transição**
    saudável→degradado (após `MAIA_PROBE_ALERT_AFTER_K` falhas consecutivas),
    com **retry durável** via `alert_pending` (reentrega até confirmar — o
    `sendAlert` engole falhas, então o gauge é o sinal de verdade).
- **Outcomes:** `ok` | `slow` (efeito ok, mas > `MAIA_PROBE_SLO_WARN_MS`) |
  `wrong` (respondeu, efeito ausente/errado) | `silent` (sem resposta no SLO) |
  `error`. Contados em `synthetic_probe_runs_total{outcome}`; latência em
  `synthetic_probe_latency_ms{scenario}`.

## Rollout (spec §4)

1. Migração 094 aplicada (seed inativo + coluna `is_synthetic` + tabelas de
   estado). Flag off.
2. Ambiente já em `exact_first`/`strict` validado (roteamento por exact-match,
   sem depender do catch-all). Ativar o canal da sonda: `npm run probe:activate`.
3. Staging: `MAIA_SYNTHETIC_PROBE=true`, `MAIA_PROBE_ALERT_MODE=log_only`.
   Medir a latência baseline; calibrar `MAIA_PROBE_SLO_MS` /
   `MAIA_PROBE_SLO_WARN_MS` / `MAIA_PROBE_ALERT_AFTER_K`.
4. Produção: `MAIA_PROBE_ALERT_MODE=alert`. Gauge como sinal primário.
5. Opcional: `MAIA_PROBE_LLM_JUDGE=true` (asserção semântica secundária,
   custo/ruído extra).

## Flags de tuning

| Flag | Default | O que faz |
|------|---------|-----------|
| `MAIA_PROBE_CRON` | `*/10 * * * *` | cadência do tick |
| `MAIA_PROBE_SLO_MS` | `30000` | deadline do efeito; acima ⇒ `silent` |
| `MAIA_PROBE_SLO_WARN_MS` | `15000` | acima (com efeito) ⇒ `slow` |
| `MAIA_PROBE_ALERT_AFTER_K` | `3` | falhas consecutivas p/ degradar + alertar |
| `MAIA_PROBE_AUTOSILENCE_AFTER_N` | `10` | falhas consecutivas p/ auto-silêncio |
| `MAIA_PROBE_SILENCED_BACKOFF_MS` | `3600000` | intervalo de sonda enquanto silenciado |
| `MAIA_PROBE_RUN_TTL_MS` | `300000` | TTL do cleanup de runs órfãos |
| `MAIA_PROBE_LEASE_MS` | `120000` | lease de single-flight |
| `MAIA_PROBE_LLM_JUDGE` | `false` | liga o LLM-as-judge (secundário) |

## Limpeza e retenção

- **Cleanup (§1.5):** no sucesso (`ok`/`slow`) o run é marcado terminal e a
  `transacoes` criada é removida (delete idempotente; `pendente` não mutou
  `contas.saldo_atual`). Em falha, o run fica aberto e o **sweep de TTL** o
  fecha e limpa depois (um job que estourou o SLO pode persistir DEPOIS).
- **Trilha preservada:** `audit_log` referencia `mensagens`/`conversas` por FK
  `NO ACTION`, então essas rows do tráfego de teste **permanecem** (preservar
  audit ⇒ preservar a trilha). Elas se acumulam no tenant `__probe__`, limitadas
  pela janela de retenção de audit; um sweep de retenção de audit acaba
  liberando-as. Filtre o tenant `__probe__` de dashboards/analytics.
- **Auto-silêncio:** após `MAIA_PROBE_AUTOSILENCE_AFTER_N` falhas consecutivas o
  worker para de gastar LLM continuamente (segura o lease de single-flight pelo
  backoff); só re-sonda recuperação a cada `MAIA_PROBE_SILENCED_BACKOFF_MS`. Um
  OK reseta e a cadência normal volta.

## Rollback

`git revert` do PR. Em runtime: `MAIA_SYNTHETIC_PROBE=false` (kill-switch
imediato, sem redeploy). A migração `094_synthetic_probe_down.sql` é
**estrutural-only** e SEMPRE aplicável (inclusive após a sonda rodar o agente
real): desativa o canal, dropa as tabelas de estado + a coluna `is_synthetic`, e
**preserva** o tenant `__probe__` e seus dados (isolados/namespaced — deletá-los
esbarraria em FKs `NO ACTION` de tabelas de runtime como `cognitive_module_log`).
Um expurgo completo do tenant `__probe__`, se desejado, é um passo operacional à
parte.
