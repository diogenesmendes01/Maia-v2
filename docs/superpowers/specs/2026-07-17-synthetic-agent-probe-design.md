# Synthetic Agent Probe — Teste real de interação, automatizado — Design Spec

**Date:** 2026-07-17 (v2: 2026-07-18)
**Status:** Draft v2 — incorpora o review de design do owner (PR #501). Mudanças vs. v1: **[Crítico] §1.2/§4** o catch-all NÃO resolve o tráfego da sonda em `shadow` e um canal de sonda ATIVO degrada o ingresso REAL (flip de `findPrimaryCatchAllChannel` para `multi_tenant:true`) mesmo com a flag off → `exact_first`/`strict` validado vira pré-requisito e o canal da sonda nasce/permanece INATIVO até lá; **[Alta] §1.1** worker phase 2 NUNCA é agendado (`startWorkers(1)` ignora `phase>1`) → registrar em phase 1 atrás da flag default-off; **[Alta] §1.3** sink escopado só por `tenant_id` silencia todo o outbound de um tenant real se mal configurado → marcador sintético IMUTÁVEL + triplete completo + validação fail-fast no boot; **[Média] §1.4** enumerar todos os fixtures do cenário de tool (entidade, conta, permission profile, permissão da pessoa, grant `domain.finance`); **[Média] §1.4/§1.5** cenário fixado em `status: 'pendente'` (sem mutação de `contas.saldo_atual`), correlação por `mensagem_id`, cleanup só após estado terminal/TTL, audit/trace preservados; **[Média] §1.6** `sendAlert` engole falhas (allSettled) → sinal primário no gauge + estado `alert_pending` com retry; **[Média] §1.5** estado durável em Postgres (`synthetic_probe_runs`/`_state`) para `last_ok`/K-falhas/transição/single-flight/dedup sobreviverem a restart.
**Scope:** Uma **sonda sintética** que exercita o agente de ponta a ponta pelo **caminho de produção real** (ingresso → resolução de tenant → fila de agente → LLM → tools → persistência → fronteira de saída), continuamente e sem intervenção humana, e falha ALTO quando a Maia para de responder ou responde errado. Fecha a parte B da issue #472 (fase 1 do blueprint `2026-06-10-learnable-workforce-vision.md` §4) e a lacuna de "E2E do agente" que as duas specs de 2026-07-09 deixaram como não-automatizável no sandbox.

**Referências (verificadas no runtime do base da PR):**
- `src/gateway/baileys.ts` — `ingressUpsertMessage(msg, line?)` (`:572`): ponto de ingresso ÚNICO (resolve tenant → `handleIncoming` sob `runWithTenantContext` → enfileira em `agentQueue`). Retorna `'handled' | 'dropped' | 'skipped'`.
- `src/gateway/channel-resolver.ts` (`:137-185`) — em `shadow` (default de `MAIA_CHANNEL_ROUTING_MODE`) `resolveChannel` computa o exact-match mas RETORNA `resolveLegacy` (catch-all). Só `exact_first`/`strict` usam o exact-match como resultado.
- `src/db/repositories/channel-repos.ts` — `findPrimaryCatchAllChannel` (`:239-250`): a **mera existência** de QUALQUER canal ativo de tenant ≠ `PRIMARY_TENANT_ID` retorna `{ multi_tenant: true, channel: null }` (fail-closed) — e o miss pelo telefone lança `channel_resolution_failed`.
- `src/index.ts` (`:66`) `startWorkers(1)` + `src/workers/index.ts` `startWorkers`: `if (job.phase > currentPhase) continue` — **phase 2 nunca é agendado** hoje.
- `src/gateway/line-output.ts` — `buildOutput`: a **fronteira única de saída** (#496); ponto do sink da sonda.
- `src/tools/register-transaction.ts` — inputs obrigatórios `entidade_id` (uuid, deve estar em `ctx.scope.entidades`), `conta_id` (uuid), `natureza`, `valor`, `data_competencia`, `status ∈ {pendente,agendada,paga,recebida}`; tool no pack `domain.finance` (visível só com grant). `status ∈ {paga,recebida}` muta `contas.saldo_atual` (`:149`); `pendente`/`agendada` não.
- `src/agent/playground-turn.ts` — o playground roda DE PROPÓSITO fora do pipeline (tools deny-all, sem persistência de negócio): prova que o LLM responde em personagem, **não** que a tool persistiu.
- `src/lib/alerts.ts` — `sendAlert({subject, body})` usa `Promise.allSettled` e cada canal engole a própria falha (o caller não sabe se entregou). `src/lib/metrics.ts` — `incCounter`/`observeHistogram`/`setGaugeProvider` (in-memory, não sobrevivem a restart).

**Architecture Locks tocados:** nenhum. A sonda não altera o pipeline; o único acoplamento no código de produção é um guard aditivo e fail-safe no topo de `buildOutput` (sink por triplete sintético). O guard de `channel-resolver`/`findPrimaryCatchAllChannel` **não** é alterado — a sonda se ADAPTA a ele (canal inativo até `exact_first`/`strict`).

**Depends on:** #496 (fronteira única `LineOutput`), `agentQueue` + worker cron runner. **Blocks:** desligar "cliente reclamando" como detector de outage; ponto de extensão para o Nível 1 (cassetes VCR no CI).

---

## §0. Purpose & problema

Hoje **nada** prova, de forma automática e contínua, que "uma mensagem entra e a Maia responde certo". Unit/integração exercitam pedaços com o LLM mockado; o playground exercita o LLM sem o pipeline. O detector de "a Maia parou" é o cliente reclamando — e uma regressão de fiação (as de #496/#500) só apareceria quando um humano notasse silêncio.

A parte **difícil** não é injetar a mensagem — é **assertar** sobre uma resposta que o LLM gera de forma não-determinística. O design gira em torno de asserção por **efeito colateral verificável**, não por igualdade de string.

**Não-objetivos** (explícitos): transporte WhatsApp literal (segundo número — "Nível 3", smoke noturno futuro); regressão determinística no CI com cassetes VCR do LLM ("Nível 1", spec própria — o harness deixa o ponto de extensão pronto); substituir `test:leak`/integração.

---

## §1. Design

### §1.1 O loop, a cada tick — e a fase do worker

Worker cron `synthetic_probe`, **phase 1** (correção do review: `startWorkers(1)` ignora `phase>1`, logo phase 2 nunca roda), **inerte enquanto `MAIA_SYNTHETIC_PROBE=false`** (default). A flag — não a fase — é o gate de comportamento; registrar em phase 1 é seguro porque o worker é no-op com a flag off. Cadência default `*/10 * * * *`. Por tick:

1. **Guards de entrada.** Flag off, ou pré-requisitos de roteamento não satisfeitos (§1.2), ou config inválida (validação de boot §1.3), ou um run em voo (lease de single-flight, §1.5) ⇒ no-op silencioso.
2. **Escolhe um cenário** (§1.4), determinístico por tick (índice derivado do `now` que o runner injeta — sem `Date.now()` na lógica testável).
3. **Injeta** um inbound sintético via `ingressUpsertMessage(synthMsg, probeLineCtx)` — o caminho real (resolver + dedup + tenant-ctx + `handleIncoming` + `agentQueue`).
4. **Espera pelo efeito** (poll com deadline = SLO, default 30 s), correlacionando por `mensagem_id` estável do run: a(s) row(s) de efeito colateral do cenário + a `mensagens direcao='out'`.
5. **Classifica**: `ok` | `slow` (asserção ok mas > SLO_warn) | `wrong` (respondeu, efeito ausente/errado) | `silent` (sem resposta em SLO) | `error`.
6. **Persiste o desfecho** em `synthetic_probe_runs`/`_state` (§1.5) e **emite sinal** (§1.6): métricas sempre; alerta só na transição, com estado durável.
7. **Cleanup** só após estado terminal do run ou TTL (§1.5) — nunca no meio de um job em voo.

### §1.2 Injeção pelo caminho real + **pré-requisito de roteamento** (correção crítica)

A sonda injeta em `ingressUpsertMessage` (não `enqueueAgent`) para exercitar resolver + dedup — o que regrediu em #496/#500. Mas o modo de roteamento importa e o v1 estava errado:

- Em **`shadow`** (default) o resultado é sempre o `resolveLegacy`/catch-all. Pior: um canal de sonda **ATIVO** (tenant `__probe__` ≠ `primary`) faz `findPrimaryCatchAllChannel` retornar `multi_tenant:true` para TODO o runtime — e aí o inbound REAL de qualquer telefone desconhecido passa a lançar `channel_resolution_failed`. **Isto derruba o ingresso de produção mesmo com `MAIA_SYNTHETIC_PROBE=false`**, só pela existência do canal ativo.
- **Correção:** `MAIA_CHANNEL_ROUTING_MODE ∈ {exact_first, strict}`, validado e operante, é **pré-requisito duro** da sonda. Enquanto o runtime estiver em `shadow`, o canal da sonda permanece **INATIVO** (a migração o cria inativo; ele só é ativado no pareamento, quando o exact-match já resolve o tráfego da sonda pelo canal certo sem tocar o catch-all). Com a flag da sonda on e o modo em `shadow`, o worker **falha fechado** (no-op + audit `synthetic_probe_prereq_unmet`), nunca ativa o canal.
- **Invariante novo (§1.7.7):** a existência/estado do canal da sonda **nunca** degrada o ingresso real — garantido por manter o canal inativo fora de `exact_first`/`strict`.

O `synthMsg` é um `IWebMessageInfo` mínimo (key.remoteJid = cliente de teste, `message.conversation` = texto do cenário, `messageTimestamp` do `now`, `id` estável por run). O `probeLineCtx.botLineE164` = a linha do canal de sonda (exact-match).

**Fila real, não inline:** o inbound segue pela `agentQueue` e roda em `runAgentForMensagem` — é o que prova que o worker de agente está vivo e dá a latência honesta. A sonda só faz polling do resultado.

### §1.3 Neutralização do outbound — **triplete + marcador imutável + fail-fast** (correção alta)

Risco (v1): no default mono-linha, `LineOutput` envia pela sessão global — um reply da sonda sairia pela linha real. E o sink escopado só por `tenant_id` tinha blast radius: se `MAIA_PROBE_TENANT_ID` apontasse por engano para `primary`/um tenant real, **todo** o outbound daquele tenant seria silenciado.

**Correção — sink estreito e fail-safe:**
- O canal da sonda carrega um **marcador sintético IMUTÁVEL** (coluna `is_synthetic boolean not null default false`, setada no seed por migração, nunca por config de runtime).
- Em `buildOutput(scope)`, o sink ativa **só** quando o **triplete completo** (`tenant_id + agent_id + channel_id`) casa a sonda **E** o canal carrega `is_synthetic=true`. Nunca por `tenant_id` sozinho — o blast radius fica no canal exato, coerente com o invariante `tenant_id + agent_id` (aqui, + `channel_id`).
- **Validação fail-fast no boot** (`src/index.ts`, quando `MAIA_SYNTHETIC_PROBE=true`): o `(tenant, agent, channel)` configurado DEVE existir, ser exclusivamente sintético (`is_synthetic=true`, tenant ≠ `PRIMARY_TENANT_ID`, agente/canal dedicados) — senão o boot **falha** (nunca sobe silenciando um tenant real).
- Assim, por construção, é impossível a sonda (a) enviar ao WhatsApp real ou (b) silenciar outbound de um recurso não-sintético.

**Prova de resposta** = a row `mensagens direcao='out'` persistida (não a entrega física, que é o Nível 3).

### §1.4 Cenários, fixtures completos e asserção por efeito colateral

Cenário = `{ id, prompt, assert(ctx), terminalWhen(ctx) }`. Asserção do mais robusto ao mais frouxo:

- **(a) Efeito colateral de tool (primário).** Cenário `register_transaction_pendente` — prompt "registre uma despesa de R$ 50 de almoço hoje". **Fixtures obrigatórios** (correção média — sem eles a tool é negada ou faltam UUIDs): tenant/agente de sonda; **entidade** de sonda; **conta** de sonda (`conta_id`); **permission profile/audience** ativo da pessoa de teste expondo a entidade em `ctx.scope.entidades`; **grant do pack `domain.finance`** no agente (senão a tool nem é visível); role/policy/channel default conforme o go-live checklist. O `assert` = existe `transacoes` com `entidade_id`/`conta_id` de sonda, `valor=50`, `natureza='despesa'`, **`status='pendente'`**, correlacionada ao `mensagem_id` do run.
  - **Fixado em `status='pendente'`** (correção média): `pendente`/`agendada` NÃO mutam `contas.saldo_atual` — o cleanup vira um simples delete idempotente, sem compensação de saldo.
- **(b) Liveness (sempre).** Existe `mensagens direcao='out'` para a conversa do run.
- **(c) LLM-as-judge (opcional, sub-flag `MAIA_PROBE_LLM_JUDGE=false`).** Nota de um modelo barato "a resposta satisfez a intenção?" para cenários sem efeito determinístico. Off por default (custo/ruído).

v1: 1 cenário de tool `(a)` + liveness `(b)`. Perfil do agente de sonda **pinado numa versão fixa** (asserção estável).

### §1.5 Estado durável, isolamento e limpeza

- **Estado em Postgres** (correção média — os contadores/gauges são in-memory e as rows do run são limpas; um restart esqueceria o outage ou duplicaria runs):
  - `synthetic_probe_runs` (`id`, `tenant_id`, `agent_id`, `mensagem_id`, `scenario`, `started_at`, `outcome`, `latency_ms`, `terminal_at`) — histórico correlacionável.
  - `synthetic_probe_state` (escopado por `tenant_id + agent_id`: `last_ok_at`, `consecutive_failures`, `health ∈ {healthy,degraded}`, `alert_pending`, `lease_until` para single-flight) — sobrevive a restart; `lease_until` impede runs concorrentes.
- **Tenant/agente/canal de sonda dedicados**, semeados por migração `_up`/`_down` (canal whatsapp E.164 **inativo** com `is_synthetic=true`, agente com perfil ativo pinado, pessoa "cliente de teste", entidade+conta+permissão+grant do §1.4). Isolamento por `tenant_id + agent_id` é o invariante da plataforma — a sonda só adiciona um tenant.
- **Cleanup só após terminal/TTL** (correção média): um job BullMQ que estourou o SLO pode persistir DEPOIS; então o cleanup espera `terminalWhen` (estado terminal do run) ou o TTL, e é correlacionado por `mensagem_id`/`run.id`. **Audit e trace do run são PRESERVADOS** (mesmo tráfego de teste deixa trilha). Sweep de TTL recolhe órfãos (padrão do `unrouted-recovery`).
- **Fora das métricas de negócio:** tenant de sonda namespaced e filtrado de dashboards/analytics. `test:leak` ganha asserção de zero vazamento nos dois sentidos (aceite §3).
- **Custo limitado:** 1 cenário/tick, output bounded, cadência configurável, kill-switch por flag, auto-silêncio por N falhas de custo consecutivas.

### §1.6 Métrica e alerta — **sinal durável, não fire-and-forget** (correção média)

- `incCounter('synthetic_probe_runs_total', {outcome})`, `observeHistogram('synthetic_probe_latency_ms', dt, {scenario})`, `setGaugeProvider('synthetic_probe_seconds_since_last_ok', …)` lido de `synthetic_probe_state.last_ok_at` (durável, não in-memory).
- **Sinal primário = o gauge `seconds_since_last_ok`** (alertável externamente pela stack de métricas): não depende de uma única entrega de `sendAlert`. Um gauge que cresce É o outage, sobrevive a restart.
- **`sendAlert` é secundário e best-effort com retry durável:** como `sendAlert` usa `allSettled` e engole falhas de canal, a transição saudável→degradado grava `alert_pending=true` em `synthetic_probe_state`; um retry com backoff (no próprio worker) tenta reentregar até confirmar, e só então zera `alert_pending`. Sem isso, uma falha de entrega + dedup por transição suprimiria o alerta até uma nova recuperação+degradação.
- **Contrato "log only"** (rollout §4): emite log estruturado + métrica, NÃO chama `sendAlert` — explícito, para o baseline em staging.

### §1.7 Invariantes (stop conditions)

1. **A sonda NUNCA envia ao WhatsApp real** — sink por triplete + marcador imutável, na fronteira `LineOutput`.
2. **A sonda NUNCA silencia outbound de recurso não-sintético** — o sink exige `is_synthetic=true` + triplete completo; boot fail-fast valida exclusividade.
3. **A sonda NUNCA afeta tráfego real** — worker phase 1 mas inerte por flag; exceção contida; sem locks compartilhados; 1 msg/tick.
4. **Zero vazamento cross-tenant** (both ways) — `test:leak`.
5. **Fail-closed de pré-requisito** — sob `shadow`, canal inativo e worker no-op+audit; nunca degrada o ingresso real.
6. **Toda execução auditada e correlacionável** (`mensagem_id`/`run.id`); audit/trace preservados no cleanup.
7. **A existência do canal da sonda nunca degrada o ingresso real** (§1.2).
8. **Sinal de outage sobrevive a restart** — estado durável em Postgres; gauge como sinal primário.
9. **Determinismo da asserção** — primário por efeito colateral (`status='pendente'`, sem mutação de saldo); perfil pinado; LLM-judge secundário/opt-in.

---

## §2. Alternativas descartadas

- **Injeção via `enqueueAgent`:** pula resolver/dedup — o que regrediu em #496/#500. Descartado.
- **Rodar o agente inline:** não prova o worker vivo nem mede latência de fila. Descartado.
- **Reusar o playground:** sem-efeitos por design; não prova a cadeia real. (Útil como Nível 1.5.)
- **Ativar o canal da sonda em `shadow`:** derruba o catch-all real (`multi_tenant:true`). Descartado — canal inativo até `exact_first`/`strict`.
- **Sink por `tenant_id`:** blast radius sobre um tenant real inteiro. Substituído por triplete + marcador imutável + fail-fast.
- **Cenário `paga`/`recebida`:** muta `contas.saldo_atual`, exigindo compensação. Substituído por `pendente`.
- **Alerta só via `sendAlert`:** engole falhas (allSettled). Substituído por gauge durável primário + `alert_pending` com retry.
- **Estado só in-memory:** esquece o outage num restart. Substituído por `synthetic_probe_runs`/`_state`.
- **Segundo número WhatsApp real já nesta fase:** flaky/ToS/custo — vira Nível 3.
- **Asserção por string:** frágil. Substituída por efeito colateral + liveness + judge opcional.

---

## §3. Aceite (stop conditions verificáveis)

- Unit: harness monta `IWebMessageInfo` válido e chama `ingressUpsertMessage` (mockado) com `probeLineCtx`; **boot fail-fast** rejeita config apontando para tenant/canal não-sintético ou `primary`; sink intercepta o outbound SÓ quando triplete casa + `is_synthetic=true` e NÃO chama nenhuma primitiva de envio; guard de pré-requisito no-op+audit sob `shadow`; classificação de outcome; transição de health com `alert_pending` + retry; single-flight via lease; auto-silêncio por N falhas.
- Integração (DB-gated): run completo do cenário cria a `transacoes` `status='pendente'` esperada (entidade/conta de sonda, correlacionada por `mensagem_id`) e a `mensagens direcao='out'` em ≤ SLO; cleanup só após terminal remove as rows do run mas **preserva audit/trace**; sweep de TTL recolhe um órfão; `synthetic_probe_state` reflete `last_ok`/`consecutive_failures`/transição e sobrevive a "restart" (releitura).
- `test:leak`: zero vazamento sonda↔real (both ways).
- Segurança: com `MAIA_MULTI_LINE=false` e um `telefone` real plantado, **nenhuma** primitiva de envio físico é chamada (sink pega); com canal de sonda ATIVO sob `shadow`, o teste prova que o worker recusa (fail-closed) — e o rollout garante que a migração o cria inativo.
- Regressão do ingresso real: teste de que a existência do canal de sonda **inativo** não altera `findPrimaryCatchAllChannel` (`multi_tenant` permanece `false` num runtime single-tenant).

---

## §4. Rollout

0. **Migração** (`_up`/`_down`): tenant/agente/canal (**inativo**, `is_synthetic=true`)/pessoa/entidade/conta/permissão/grant `domain.finance` de sonda; coluna `channels.is_synthetic`; tabelas `synthetic_probe_runs`/`_state`. Flag `MAIA_SYNTHETIC_PROBE=false`. Sink aditivo em `buildOutput` + validação fail-fast no boot (inertes enquanto a flag off).
1. **Worker em phase 1 atrás da flag** (default off): registra `synthetic_probe` com 1 cenário de tool; guard de pré-requisito (`exact_first`/`strict`); métricas ligadas; alerta em **log-only**.
2. **Pré-requisito de roteamento:** só ligar a sonda em ambiente já em `exact_first`/`strict` validado (o rollout do roteamento multi-linha, spec 2026-07-09 §4). Pareamento ATIVA o canal da sonda; a partir daí o exact-match resolve o tráfego da sonda sem tocar o catch-all.
3. **Staging:** flag on, medir latência baseline, calibrar SLO/SLO_warn e o K do dedup.
4. **Produção, alerta real:** flag on com cenário de tool + liveness; gauge como sinal primário + `sendAlert` com `alert_pending`/retro.
5. **Expansão opcional:** cenário semântico com LLM-judge (sub-flag); ponto de extensão para o Nível 1 (cassetes VCR no CI).

## §5. Riscos

- **Custo de LLM contínuo:** cadência baixa, 1 cenário/tick, output bounded, kill-switch, auto-silêncio.
- **Falso-positivo por lentidão do provedor:** outcome `slow` separa "degradado" de "quebrado"; alerta exige K consecutivos.
- **Acoplamento ao rollout do roteamento:** a sonda depende de `exact_first`/`strict` — é um pré-requisito, não uma limitação (documentado no §4.2).
- **Poluição de métricas/dados:** tenant namespaced e filtrado; `test:leak` como guard-rail.
- **Deriva do agente de sonda:** perfil pinado; asserção primária por efeito colateral.
