# Synthetic Agent Probe — Teste real de interação, automatizado — Design Spec

**Date:** 2026-07-17
**Status:** Draft v1 — para review de design.
**Scope:** Uma **sonda sintética** que exercita o agente de ponta a ponta pelo **caminho de produção real** (ingresso → resolução de tenant → fila de agente → LLM → tools → persistência → fronteira de saída), continuamente e sem intervenção humana, e falha ALTO quando a Maia para de responder ou responde errado. Fecha a parte B da issue #472 (fase 1 do blueprint `2026-06-10-learnable-workforce-vision.md` §4) e a lacuna de "E2E do agente" que as duas specs de 2026-07-09 deixaram como não-automatizável no sandbox.

**Referências:**
- `src/gateway/baileys.ts` — `ingressUpsertMessage(msg, line?)` (`:572`): ponto de ingresso ÚNICO onde um evento Baileys entra no pipeline (resolve tenant → `handleIncoming` sob `runWithTenantContext` → enfileira em `agentQueue`). Retorna `'handled' | 'dropped' | 'skipped'`.
- `src/agent/core.ts` — `runAgentForMensagem(mensagem_id)` (`:292`): callstack do worker; resolve o tuple e roda o agente real (resolver, adoção, decision engine, tools, memória).
- `src/gateway/line-output.ts` — `forChannel({tenant_id, agent_id, channel_id})` / `buildOutput`: a **fronteira única de saída** (#496). É AQUI que a sonda intercepta o envio físico (sink), reusando o corte que já existe.
- `src/agent/playground-turn.ts` — o playground roda DE PROPÓSITO fora do pipeline (sem pessoa/conversa/gateway/outbox, tools deny-all): prova que o LLM responde em personagem, **não** que a tool persistiu. A sonda é o oposto: caminho real, efeito colateral real, escopado a um tenant de teste.
- `src/workers/index.ts` — registro de workers cron `{ name, cron, fn, phase }` (phase 1 = crítico, phase 2 = não-crítico).
- `src/lib/alerts.ts` — `sendAlert({ subject, body })`. `src/lib/metrics.ts` — `incCounter(name, labels?, by?)`, `observeHistogram(name, value, labels?)`, `setGaugeProvider(name, provider)`.
- `src/config/env.ts` — convenção `MAIA_*` (zod, default seguro).

**Architecture Locks tocados:** nenhum. A sonda não altera o pipeline; ela o EXERCITA por um tenant isolado. O único ponto de acoplamento no código de produção é um guard na fronteira `LineOutput` (sink do outbound da sonda) — aditivo e fail-safe.

**Depends on:** #496 (fronteira única `LineOutput` — mesclado), a fila `agentQueue` e o worker cron runner (existentes). **Blocks:** desligar a dependência de "cliente reclamando" como detector de outage; cobertura de regressão E2E do agente no CI (via Nível 1/cassetes, spec futura).

---

## §0. Purpose & problema

Hoje **nada** prova, de forma automática e contínua, que "uma mensagem entra e a Maia responde certo". Os testes unit/integração exercitam pedaços (resolver, dedup, output boundary) com o LLM mockado; o playground exercita o LLM sem o pipeline. O detector de "a Maia parou" em produção é o cliente reclamando — e uma regressão de fiação (as que #496/#500 corrigiram) só apareceria quando um humano notasse silêncio.

A parte **difícil** de automatizar isso não é injetar a mensagem — é **assertar** sobre uma resposta que o LLM gera de forma não-determinística. O design inteiro gira em torno de asserção por **efeito colateral verificável**, não por igualdade de string.

**Não-objetivos** (explícitos):
- **Não** é o transporte WhatsApp literal (segundo número, cliente Baileys "cliente"). Isso é o "Nível 3" — smoke noturno futuro, fora desta spec.
- **Não** é regressão determinística no CI (o "Nível 1" com cassetes VCR do LLM) — spec própria depois; a sonda e os cassetes compartilham o harness de injeção, então esta spec deixa o ponto de extensão pronto.
- **Não** substitui `test:leak`/integração; complementa com um sinal de produção viva.

---

## §1. Design

### §1.1 O que a sonda faz (loop, a cada tick)

Worker cron `synthetic_probe`, **phase 2** (não-crítico — nunca pode afetar tráfego real), cadência default `*/10 * * * *`, atrás de flag `MAIA_SYNTHETIC_PROBE` (default `false`). Por tick:

1. **Guard de entrada.** Flag off, ou config incompleta (tenant/agente/canal de sonda não resolvíveis), ou um run anterior ainda em voo (lock de execução único) ⇒ no-op silencioso.
2. **Escolhe um cenário** da tabela de cenários (§1.4), determinística por tick (round-robin por índice derivado do minuto — sem `Date.now()` no meio da lógica testável; o worker recebe `now` do runner).
3. **Injeta** um inbound sintético do "cliente de teste" para a "linha de teste" chamando `ingressUpsertMessage(synthMsg, probeLineCtx)` — **exatamente** a função que o gateway chama. Isso exercita resolver + dedup + tenant-ctx + `handleIncoming` + enfileiramento na `agentQueue` REAL.
4. **Espera pelo efeito** (poll com deadline = SLO, default 30 s): o agente real processa pela fila, chama o LLM real, executa a(s) tool(s), persiste. A sonda faz polling da(s) condição(ões) de sucesso do cenário (§1.4) — row de efeito colateral + row de resposta `mensagens direcao='out'`.
5. **Classifica o desfecho**: `ok` (todas as asserções em ≤ SLO), `slow` (asserções ok mas > SLO_warn), `wrong` (respondeu mas efeito colateral ausente/errado), `silent` (nenhuma resposta em SLO), `error` (exceção no harness).
6. **Emite sinal** (§1.6): métricas sempre; alerta só na **transição** saudável→degradado (dedup — nunca spam por tick).
7. **Limpa** as rows que o run criou no tenant de sonda (idempotente; um sweep de TTL cobre runs mortos — §1.5).

O passo 4 medir a latência ponta-a-ponta REAL (incluindo espera de fila) é o próprio SLO que se quer observar.

### §1.2 Injeção pelo caminho real (fidelidade máxima)

A sonda injeta em `ingressUpsertMessage`, **não** em `enqueueAgent` — de propósito: queremos exercitar o resolver de tenant/canal e o dedup, que foram exatamente o que quebrou em #496 e #500. O `synthMsg` é um `proto.IWebMessageInfo` mínimo bem-formado (key com `remoteJid` do cliente de teste, `message.conversation` com o texto do cenário, `messageTimestamp` vindo do `now` do runner, `id` estável por run para idempotência). O `probeLineCtx: LineIngressCtx` carrega `botLineE164` = a linha do canal de sonda, para o exact-match resolver ao canal certo nos modos `exact_first`/`strict` (e o catch-all resolvê-lo em `shadow`/mono-linha).

**Fila real, não inline.** O inbound segue pela `agentQueue` e é processado por `runAgentForMensagem` como qualquer mensagem. A sonda **não** chama o agente inline — rodar pela fila é o que dá o número de latência honesto e prova que o worker de agente está vivo. A sonda apenas faz polling do resultado persistido.

### §1.3 Neutralização do outbound — **fail-safe, na fronteira única** (crítico)

Risco real: no default **mono-linha** (`MAIA_MULTI_LINE=false`), `LineOutput` envia pela sessão Baileys **global** independentemente do canal — um reply da sonda sairia pela linha de produção para o `telefone` do cliente de teste. **Inaceitável.**

Solução, reusando o corte do #496: em `line-output.ts`, `buildOutput(scope)` passa a checar `scope.tenant_id === PROBE_TENANT_ID` (constante derivada da config da sonda) e, se for, retorna um **sink `LineOutput`**: registra o texto/mídia que sairia (para latência e para uma asserção opcional de liveness), devolve um id sintético, e **não faz nenhum envio físico**. Assim, por construção, **é impossível** uma mensagem da sonda chegar ao WhatsApp real — mesmo com flag mal configurada, número real plantado por engano, ou modo de roteamento qualquer. O guard é aditivo (uma ramificação no topo do `buildOutput`) e não toca o caminho de produção de nenhum outro tenant.

Consequência de design: a **prova de resposta** da sonda é a **row persistida** `mensagens direcao='out'` (o agente registra a saída antes/independclui do transporte), não a entrega física. Entrega física é o Nível 3.

### §1.4 Cenários e asserção por efeito colateral

Um cenário é um objeto puro: `{ id, prompt, assert(ctx): Promise<AssertResult>, cleanup(ctx) }`. A asserção é **por efeito colateral verificável**, do mais robusto ao mais frouxo:

- **(a) Efeito colateral de tool (primário).** Ex.: cenário `registrar_despesa` — prompt "registre R$ 50 de almoço hoje" ⇒ `assert` = existe uma `transacoes` row no tenant de sonda com `valor=50`, `tipo` de saída, criada neste run. Prova resolver + agente + decision engine + tool + persistência, de forma determinística mesmo com LLM não-determinístico.
- **(b) Liveness (sempre).** Existe uma `mensagens direcao='out'` para a conversa do run (o agente respondeu algo). Isola "silêncio" de "respondeu errado".
- **(c) LLM-as-judge (opcional, atrás de sub-flag).** Um modelo barato dá nota "a resposta satisfez a intenção do cenário?" contra uma rubrica curta. Bom para cenários semânticos (ex.: `saudacao` sem efeito colateral de tool). Custa uma chamada extra e adiciona ruído — **off por default**; usado só nos cenários sem efeito colateral determinístico.

O conjunto v1 é pequeno e fixo (1–3 cenários) para custo/estabilidade previsíveis: um cenário de tool `(a)`, um de conversa pura `(b)`/`(c)`. O perfil do agente de sonda é **pinado numa versão fixa** para que o comportamento não derive por baixo dos pés da asserção.

### §1.5 Isolamento, tenant de sonda e limpeza

- **Tenant/agente/canal dedicados** (`__probe__` ou config `MAIA_PROBE_TENANT_ID`/`_AGENT_ID`/`_CHANNEL_ID`), semeados por migração `_up`/`_down` (canal whatsapp E.164, agente com perfil ativo pinado, pessoa "cliente de teste"). Isolamento por `tenant_id + agent_id` já é o invariante da plataforma — a sonda não abre exceção, só adiciona um tenant.
- **Cleanup por run** (idempotente) + **sweep de TTL** para rows órfãs de runs que morreram no meio (o mesmo padrão do `unrouted-recovery`). Nada de sonda sobrevive além do necessário para a asserção.
- **Fora das métricas de negócio.** O tenant de sonda é filtrado de dashboards/analytics/relatórios (namespacing explícito), para não poluir números reais. `test:leak` ganha uma asserção de que nenhum dado da sonda vaza para tenants reais e vice-versa (aceite §3).
- **Custo limitado.** 1 cenário por tick, `MAX_OUTPUT_TOKENS` baixo, cadência configurável, kill-switch por flag. Guard de orçamento: se a sonda observar N falhas consecutivas de LLM por custo/limite, ela se auto-silencia e alerta (não fica queimando tokens).

### §1.6 Métrica, alerta e observabilidade

- `incCounter('synthetic_probe_runs_total', { outcome })` a cada run (`outcome ∈ ok|slow|wrong|silent|error`).
- `observeHistogram('synthetic_probe_latency_ms', dt, { scenario })` — a latência ponta-a-ponta real (o SLO que importa).
- `setGaugeProvider('synthetic_probe_seconds_since_last_ok', …)` — idade do último sucesso; um gauge que cresce sem parar É o outage.
- **Alerta com dedup por transição:** `sendAlert` dispara quando o estado passa de saudável→degradado (K falhas/slows consecutivos, K configurável), e um "recuperado" quando volta. Nunca um alerta por tick. O assunto carrega cenário + outcome + latência; o corpo, o link do trace.

### §1.7 Invariantes (stop conditions)

1. **A sonda NUNCA envia ao WhatsApp real.** Garantido por construção na fronteira `LineOutput` (sink por tenant), não por convenção.
2. **A sonda NUNCA afeta tráfego real.** Worker phase 2, exceção contida, sem locks compartilhados, sem consumir capacidade desproporcional da `agentQueue` (1 msg/tick, cadência baixa).
3. **Zero vazamento cross-tenant** entre sonda e tenants reais (both ways) — coberto por `test:leak`.
4. **Toda execução auditada** (o run já passa pelo `audit` do pipeline; a decisão de outcome também audita).
5. **Fail-closed de custo/erro:** falha repetida se auto-silencia e alerta, nunca queima tokens em loop.
6. **Determinismo da asserção:** primário por efeito colateral; perfil do agente de sonda pinado; LLM-judge é secundário e opt-in.

---

## §2. Alternativas descartadas

- **Injeção via `enqueueAgent` (pular o resolver):** mais simples, mas não exercitaria resolução de tenant/canal e dedup — exatamente o que regrediu em #496/#500. Descartado: perde a fidelidade que justifica a sonda.
- **Rodar o agente inline (síncrono) em vez de pela fila:** asserção mais fácil, mas não prova que o worker de agente está vivo nem mede a latência de fila real. Descartado: o número honesto exige a fila.
- **Reusar o playground:** ele é sem-efeitos-colaterais por design (tools deny-all, sem persistência de negócio) — não prova a cadeia real. Serve para liveness do LLM, não para a sonda. (Continua útil como Nível 1.5.)
- **Segundo número WhatsApp real (bot-contra-bot) já nesta fase:** fidelidade máxima, mas flaky, com custo de sessão/ToS e não-determinístico — vira smoke noturno separado (Nível 3), não o canário contínuo.
- **Asserção por igualdade de string da resposta:** frágil contra o LLM. Substituída por efeito colateral + liveness + judge opcional.
- **Payload/estado da sonda no Redis:** o estado durável é Postgres (rows do tenant de sonda), consistente com o resto da plataforma.

---

## §3. Aceite (stop conditions verificáveis)

- Unit: harness de injeção monta um `IWebMessageInfo` válido e chama `ingressUpsertMessage` (mockado) com o `probeLineCtx` certo; sink do `LineOutput` intercepta o outbound quando `tenant_id === PROBE_TENANT` e NÃO chama nenhuma primitiva de envio; classificação de outcome (ok/slow/wrong/silent/error) por combinação de (efeito presente?, resposta presente?, dt vs SLO); alerta dispara só na transição e o "recuperado" na volta; guard de auto-silêncio por N falhas.
- Integração (DB-gated, Postgres real): um run completo do cenário de tool cria a `transacoes` row esperada no tenant de sonda e a `mensagens direcao='out'`, dentro do SLO; cleanup remove tudo; o sweep de TTL recolhe uma row órfã plantada.
- `test:leak`: nenhuma row da sonda visível a um tenant real e nenhuma row real visível ao tenant de sonda.
- Métrica/alerta: contador e histograma emitidos; `seconds_since_last_ok` cresce quando forçamos silêncio e zera no próximo ok.
- Segurança: teste explícito de que, com `MAIA_MULTI_LINE=false` e um `telefone` real plantado no cliente de sonda, **nenhuma** primitiva de envio físico é chamada (o sink pega).

---

## §4. Rollout

0. **Migração** do tenant/agente/canal/pessoa de sonda (`_up`/`_down`) + flag `MAIA_SYNTHETIC_PROBE=false` + sink na fronteira `LineOutput` (aditivo, inerte enquanto não houver tráfego de sonda).
1. **Harness + worker atrás de flag** (default off): registra `synthetic_probe` em `workers/index.ts` (phase 2), com 1 cenário de tool. Métricas ligadas, alerta em modo "log only".
2. **Observação em staging:** ligar a flag em staging, medir latência baseline, calibrar SLO/SLO_warn e o K do dedup de alerta.
3. **Produção, alerta ligado:** flag on em produção com o cenário de tool + liveness; alerta real com dedup por transição.
4. **Expansão opcional:** cenário semântico com LLM-judge (sub-flag); mais cenários conforme necessidade. Ponto de extensão para o Nível 1 (cassetes VCR no CI) fica pronto no harness.

## §5. Riscos

- **Custo de LLM contínuo:** mitigado por cadência baixa, 1 cenário/tick, output bounded, kill-switch e auto-silêncio por falha de custo.
- **Falso-positivo por lentidão do provedor de LLM:** o outcome `slow` separa "degradado" de "quebrado"; o alerta exige K consecutivos.
- **Poluição de métricas/dados:** tenant de sonda namespaced e filtrado de analytics; `test:leak` como guard-rail.
- **Deriva de comportamento do agente de sonda:** perfil pinado numa versão fixa; asserção primária por efeito colateral, robusta a variação de fraseado.
