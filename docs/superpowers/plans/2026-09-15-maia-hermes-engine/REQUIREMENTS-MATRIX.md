# REQUIREMENTS-MATRIX — Integração Maia + Hermes (V1)

> Rastreabilidade requisito → implementação → teste/evidência → estado.
> Estados: **não iniciado** · **implementado não verificado** · **verificado** · **bloqueado**.
> “Verificado” exige execução real registrada em `VERIFICATION-LOG.md`; teste pulado não verifica.
> Seções referem-se a `SPEC-IMPLEMENTACAO-MAIA-HERMES.md` (sha256 `84c42607…d756a4`).

## 1. Invariantes de aceitação (§3)

| ID | Requisito | Implementação | Testes / evidência | Estado |
|---|---|---|---|---|
| INV-01 | Escopo tenant+agente (+pessoa/conversa quando privado); IDs não conferem autorização | — | T19, T24, T25, T64 | não iniciado |
| INV-02 | Contexto de tool derivado do registro da execução + credencial do processo, nunca de campos do modelo | — | T19, T20 | não iniciado |
| INV-03 | Tool disponível = interseção agente∩role∩decisão∩skill∩cliente∩modo∩política | — | T21, T22, T23 | não iniciado |
| INV-04 | Grants/epoch atuais prevalecem sobre snapshot | — | T22, T52 | não iniciado |
| INV-05 | Resultado/envio só com claim vigente e controle compatível | — | T15, T33, T34 | não iniciado |
| INV-06 | Timeout não prova ausência de efeito; `unknown` ≠ `failed` repetível | — | T13, T14 | não iniciado |
| INV-07 | Conclusão Hermes ≠ mensagem enviada | — | T06, T32 | não iniciado |
| INV-08 | Privado não vira conhecimento do agente sem gates; origem humana só de ato autenticado | — | T42, T44 | não iniciado |
| INV-09 | Crash não retoma sequência de tools; Maia reconcilia | — | T11, T13 | não iniciado |
| INV-10 | Shadow sem efeito externo/envio/aprovação/memória | — | T60, T61 | não iniciado |
| INV-11 | Nenhum profile/transcript/skill/segredo do Desktop herdado | — | T54, T55, T67 | não iniciado |
| INV-12 | Auditoria com correlação, sem prompts/PII integrais | — | T31, T67 | não iniciado |
| INV-13 | CI da baseline não homologa a integração | processo: nenhum resultado de CI base usado como evidência | `VERIFICATION-LOG.md` | verificado (processo) |
| INV-14 | Atualização Hermes exige verificação de interface/superfície/cleanup | — | T53, T68 | não iniciado |

## 2. Contratos integrados (§4.1–§4.3)

| ID | Requisito | Seção | Implementação | Testes / evidência | Estado |
|---|---|---|---|---|---|
| K-01 | `AgentEnginePortV1` como métodos TS internos, sem endpoints | §4.1, §5.3.1 | `src/runtime/engines/contracts.ts` (tipos) + `schemas.ts` (Zod estrito, equivalência schema↔tipo conferida pelo compilador) | `tests/unit/agent-engine-contract.spec.ts` (35 casos) + 6 mutações detectadas | **contrato verificado**; implementações (`MaiaEngine`/`HermesEngine`) pendentes |
| K-02 | Transporte: filho Python descartável, pipe herdado, protocolo `maia.hermes.worker.v1` | §4.1, §6.4 | `src/integrations/hermes/protocol.ts` (schemas dos 9 frames, limites, direção) | `tests/unit/hermes-wire-contract.spec.ts` (62 casos) + `tests/fixtures/hermes-wire/frames.json` | **contrato verificado**; worker/supervisor ainda não existem |
| K-03 | `run_id` = `RunBinding.execution_id` (um UUID) | §4.1 | `protocol.ts` (`start.binding.execution_id` + `run_id`) | fixture `start-ok` | implementado não verificado (falta o supervisor produzir o par) |
| K-04 | `call_seq` inicia em 0; `call_id = run_id:call_seq`; `ordinal = call_seq` | §4.1 | `protocol.ts` (`deriveCallId`, `call_seq` ≥ 0) | `hermes-wire-contract.spec.ts` (bloco “identidade da chamada”) + fixtures `tool-request-*` | **verificado** (unit) |
| K-05 | `iteration` opcional/`null`; nunca inventado | §4.1 | — | — | não iniciado |
| K-06 | Broker admite ordinais contíguos e serializa dispatch por run | §4.1, §5.7.4 | — | T17, T26 | não iniciado |
| K-07 | `control_id`/`control_epoch` no snapshot e em `engine_runs` | §4.1 | — | T33, T39 | não iniciado |
| K-08 | Autenticação de tools por posse do pipe + binding; nada de bearer/tenant ao modelo | §4.1, §6.3 | — | T19, T67 | não iniciado |
| K-09 | Único HTTP novo do filho: gateway de inferência Maia | §4.1, §9.1 | — | T18, T56 | não iniciado |
| K-10 | Engine enum persistido `maia_react \| hermes` | §4.1 | — | — | não iniciado |
| K-11 | Sem memória nativa / skills genéricas Hermes | §4.1, §6.6, §7.7.4 | — | T53, T55 | não iniciado |
| K-12 | Retomada humana `future_only` | §4.1, §8.2.5 | — | T39 | não iniciado |
| K-13 | Ordem global de locks controle→stream→turno→run→call/projeções + teste de deadlock | §4.1, §5.6.3 | — | teste de deadlock | não iniciado |
| K-14 | Shadow OFFLINE, sem segunda row aberta em `engine_runs` | §4.1 | — | T60 | não iniciado |
| K-15 | `agent_engine_policies` / `agent_execution_limits` versionados com CAS | §4.1 | — | — | não iniciado |
| K-16 | Normalizador de histórico Maia→Hermes (texto canônico; user_message único removido por ID; recusa formatos não suportados) | §4.1 | `src/integrations/hermes/history.ts` — separa o inbound por POSIÇÃO (a remoção por ID canônico já acontece em `prompt-builder.ts`, no `if (m.id === ctx.inbound.id) continue`), recusa `tool_use`/`tool_result`/`image`, preserva o envelope `<user_message>` e recusa estouro de limite em vez de truncar | `tests/unit/hermes-history-normalizer.spec.ts` (19 casos) + verificação por mutação | **verificado** (unit) |
| K-17 | Compatibilidade de orçamento (5 iterações / 1024 tokens na fixture local; limites finitos no live) | §4.1 | — | — | não iniciado |
| K-18 | Revisões de fatos não quebram `ON CONFLICT` de `cost-ledger` (ADR ou tabela especializada) | §4.1, §7.4.3 | — | — | bloqueado (D08: decisão verificável no PR de schema) |
| K-19 | Manifest `maia-hermes-runtime-manifest/v1` estrito, default vazio, sem `maia_*`/`mcp:*`/`all` | §4.2 | — | T21, T53 | não iniciado |
| K-20 | Tools de aprendizado `learning_recall`/`learning_propose`/`published_skill_read` com schemas fechados | §4.3 | — | T42–T52 | não iniciado |

## 3. Plano por PR (§10)

| PR | Entrega verificável | Estado |
|---|---|---|
| P00 | Wire/JSON Schema TS+Python, normalização de histórico, execução sintética real com AIAgent, superfície após compressão e cleanup | **concluído para o que é verificável sem provider pago**: P00.1 (contrato wire + canônico + fixtures), P00.2 (pacote Python, 166 testes), P00.3 (normalizador) e P00.4 (spike com `AIAgent` real, 6 casos — V-016). **Pendente**: superfície APÓS COMPRESSÃO (a compressão está desligada no config do worker, então o caso não foi exercitado) e o smoke com provider real (D02) |
| P01 | Caracterização do comportamento local (matriz de delivery, role/pending/report/sensitive, pós-turno) | **concluído e verificado** — `tests/unit/react-loop-characterization.spec.ts` (57 casos), primeira suíte unitária de `runReActLoop`; 10 mutações do implementador + 3 minhas, independentes, todas detectadas |
| P02 | `AgentEnginePortV1`, `MaiaEngine`, assembler, output coordinator; default local | **em andamento**: P02.0 (contratos + schemas) e P02.1 (`MaiaEngine` com raciocínio injetado) concluídos e verificados; falta ligar o laço real (P02.2), o assembler e o coordenador de saída |
| P03 | Binding/run/tool journal/eventos/projeções, CAS/constraints/imutabilidade, recovery sem rerun | **em andamento**: P03.1 (migrations 139/140 + espelho Drizzle + 12 casos contra Postgres real, incluindo triggers de imutabilidade e append-only) concluído; P03.2 (`engine-repos.ts` — caminho de START: `pinEngineAndPrepareRun`, `markSubmitting`, `recordStartObservation`, `recordTerminalProposal`; 10 casos contra Postgres real, 6 mutações mortas) concluído; demais operações do §5.6.3 (`admitToolCall` … `resolveBlockedRun`) — dessas, **P03.3a (`admitToolCall`) concluída**: redelivery devolve `in_progress` ou o resultado persistido sem repetir handler (T26), args divergentes são `payload_conflict` sem tocar no journal (T27), ordem sequencial (uma call pendente por run, ordinal só o próximo ou redelivery) e callback adiantado (`submitting`/`submission_unknown` journalam `received` e respondem `in_progress`, nunca execução). 10 casos contra Postgres real, 7 mutantes mortos. **P03.3b (`markToolDispatching` + `freezeToolIdentity`) concluída**: a transição `received → dispatching` (nomeada por C14, que o §5.6.4 pressupõe ao exigir `dispatch_token` igual) atribui o token e a classificação do registry, recusando `effect_class` nulo e prazo abaixo do mínimo da classe; o freeze grava identidade, não muda em replay e VERIFICA a invariante do C15. **P03.3c (`markToolHandlerStarted`) concluída**: o marcador do §5.6.4 linha 1190 — CAS por `dispatch_token` com `handler_started_at IS NULL`, identidade congelada e `row_version` esperada, sob run `running`/não-revogado/prazo vivo e fence do turno; eleva `effect_evidence` a `possible` só nas classes cujo veredito de `classifyToolCancellation` é `effect_unknown`, e distingue `already_started` de `version_conflict`. **P03.3d (`settleToolCall`) concluída**: CAS por `dispatch_token` mais fence do turno ATUAL (o token da call sozinho não adota resultado tardio, §5.7.4 item 8); `cancelled` só para `abort_safe`, com as demais classes recusadas em favor de `effect_unknown` (item 9); evidência de efeito monotônica (`committed`/`unknown`/`none`) e receipt validado antes do banco. **Sem** o acoplamento atômico ao ledger de idempotência — ver C16, sancionado pelo próprio item 8. **P03.4 (`revokeRunCapabilities`) concluída**: revogação monotônica (carimbo original preservado, nenhum caminho desfaz), ator assimétrico (dono prova origem do run; `recovery`/`operator` não, porque o dono sumido é o caso que mais precisa de revogação) e deliberadamente FORA do gate de controle da conversa — revogar é o que se quer quando um humano assume. **P03.5 (`markRunBlocked` + `resolveBlockedRun`) concluída**: `blocked` preserva a trava contra nova geração (unique parcial cobre `phase <> 'closed'`) e avança `row_version` para invalidar CAS em voo; resolver exige operador **e** evidência não-vazia, sem nenhum parâmetro de tempo na assinatura — a ausência de liberação por TTL é estrutural, não convenção; fecha em `manual_resolved` com `capabilities_revoked_at` por COALESCE, que a 140 exige e que preserva o carimbo de P03.4. Contrato normativo mínimo em C17. **P03.6a (`adoptTerminalResult`) concluída**: fence do turno ATUAL e não da origem do run — assimetria deliberada, porque adotar não autoriza efeito e o §5.8.2 manda o novo owner adotar em vez de pagar nova deliberação; registra `adopted_by_turn_attempt` da tentativa que assumiu, com teto de preparação recusado tipado antes do CHECK de 256 KiB; não fecha o run, não reautoriza callbacks e não transiciona o turno. **P03.6b (`closeRunAfterHandoff`) concluída**: a única operação com prova EXTERNA ao journal — `handed_to_outbox` exige artefato de saída RESOLVIDO (`OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES`, reusada do contrato) **e** `completed`, porque resolvido não é sinônimo de entregue (um `cancelled` é resolvido e não entregou); `completed_no_reply` e `safe_to_retry` exigem ausência de saída, e `safe_to_retry` soma as DUAS condições do invariante 7 (estado conciliado e evidência de efeito), verificadas em casos separados. Fence do dono, não do `recovery` (§5.7.3 item 5); `outbound_messages` lido sem `FOR UPDATE` para não criar aresta de lock com o delivery; repetição após crash é idempotente e não duplica evento. **Projeções adiadas e nomeadas** (P08/P09) e `discarded` deliberadamente fora (política não definida pela spec). 74 casos no spec de runs, 13 mutantes mortos após um sobrevivente corrigido. Varredura/manutenção (`enumerateDueScopes`, `listDueRuns`, `reserveMaintenanceObservation`) e recovery seguem pendentes |
| P04 | Controle humano (pause/pausing/human/resume) com fence em todo egresso | não iniciado |
| P05 | Broker: binding por canal, manifest efetivo, ACL cliente/recurso, dispatch instrumentado, receipt | não iniciado |
| P06 | Gateway de inferência fechado, grants, reservas/eventos idempotentes | não iniciado |
| P07 | Adapter/supervisor: start/observe/cancel por IPC, reaper, deadlines, shutdown | não iniciado |
| P08 | Aprendizado base G1–G4 | não iniciado |
| P09 | Decisões/compilador/publicação/revogação | não iniciado |
| P10 | Console/operação | não iniciado |
| P11 | Shadow offline | não iniciado |
| P12 | Canário | bloqueado (exige autorização humana de deploy, D01–D07) |

## 4. Achados G1–G4 (§7.2.1, §7.6)

| ID | Requisito | Implementação | Testes | Estado |
|---|---|---|---|---|
| G1 | Batch de reflexão sem escrita ativa/global; sujeito preservado | — | T44 | não iniciado |
| G2 | Recall autorizado com lifecycle/ACL/sujeito antes do ranking | — | T25, T51 | não iniciado |
| G3 | `propose_fact` sem origem humana declarável; classifica payload canônico | — | T42, T43 | não iniciado |
| G4 | Revogação legada reflete em todos os leitores | — | T51 | não iniciado |

## 5. Matriz de testes (§11.2)

| ID | Gate | PR alvo | Implementação do teste | Estado |
|---|---|---|---|---|
| T01 | Extração | P01/P02 | `tests/unit/react-loop-characterization.spec.ts` (“T01 — turno comum”) | **verificado na baseline** (falta repetir contra o `MaiaEngine` extraído) |
| T02 | Extração | P01/P02 | cobertura existente em `agent-core-trace-envelope-fail-closed.spec.ts` e `agent-core-channel-resolution.spec.ts` (gates barram antes do reasoner) | verificado na baseline |
| T03 | Extração | P01/P02 | caracterização: `reasoner_failed` sem envio inventado; `iteration_cap` sem reexecução | **verificado na baseline** |
| T04 | Extração | P01/P02 | caracterização: `outboundPrefix` (4 casos) — antes disso, cobertura ZERO no repositório | **verificado na baseline** |
| T05 | Contrato | P00/P02 | `hermes-wire-contract.spec.ts` “schema estrito” + fixtures `*-com-tenant`, `*-call-id-fornecido` | **verificado** (wire; falta o lado do assembler em P02) |
| T06 | Contrato | P02 | `hermes-wire-contract.spec.ts` “result não aceita alegação de entrega” + fixture `result-alega-entrega` | **verificado** (wire) |
| T07 | Contrato | P00 | `hermes-wire-contract.spec.ts` “limites são recusa determinística” (valores absolutos + mutação) | **verificado** |
| T08 | Contrato | P00 | `hermes-wire-contract.spec.ts` “fingerprint canônico” sobre `canonical-json.ts` | **verificado** |
| T09 | Contrato | P03/P07 | — | não iniciado |
| T10 | Durabilidade | P03/P07 | — | não iniciado |
| T11 | Durabilidade | P03/P07 | — | não iniciado |
| T12 | Durabilidade | P03/P07 | — | não iniciado |
| T13 | Durabilidade | P03/P05 | — | não iniciado |
| T14 | Durabilidade | P03/P07 | — | não iniciado |
| T15 | Durabilidade | P03/P07 | — | não iniciado |
| T16 | Durabilidade | P07 | — | não iniciado |
| T17 | Durabilidade | P03 | `tests/integration/hermes-engine-repos-real-db.spec.ts` (28 casos) | **parcial**: a corrida PERDIDA é exercida em todos os eixos — CAS de `row_version` com snapshot obsoleto, unique parcial de run aberto, `remote_run_id` divergente, fence de ORIGEM do run (token e tentativa isolados, casos 25/26) e gate de controle (modo e epoch isolados, casos 27/28). 13 mutantes mortos. Falta concorrência REAL (duas TX simultâneas) — a suíte é sequencial, e com ela `clock_timestamp()` vs `now()` fica não verificado — e as transições de cancelamento/reconciliação |
| T18 | Segurança | P06 | — | não iniciado |
| T19 | Segurança | P05 | — | não iniciado |
| T20 | Segurança | P00/P05 | — | não iniciado |
| T21 | Segurança | P05 | — | não iniciado |
| T22 | Segurança | P05 | — | não iniciado |
| T23 | Segurança | P05 | — | não iniciado |
| T24 | Segurança | P05 | — | não iniciado |
| T25 | Segurança | P05/P08 | — | não iniciado |
| T26 | Segurança | P03/P05 | `tests/integration/hermes-engine-tool-calls-real-db.spec.ts` (casos 2, 3) | **parcial (metade P03)**: redelivery do mesmo `call_id` com os mesmos args devolve `in_progress` enquanto o vencedor está em voo e o **resultado persistido** depois de conciliada — sem repetir handler, e sem criar segunda linha. Falta a metade P05: o gateway traduzindo isso para `EngineToolReplyV1` e a reutilização de registro do ledger de idempotência da casa |
| T27 | Segurança | P03/P05 | `tests/integration/hermes-engine-tool-calls-real-db.spec.ts` (caso 4) | **parcial (metade P03)**: mesmo `call_id` com args diferentes é `payload_conflict`, nenhuma linha é alterada (o `args_hash` gravado permanece o mesmo) e nenhum handler é alcançado — a admissão recusa antes disso. O "409" do enunciado é a tradução do gateway (P05), ainda não implementada |
| T28 | Segurança | P00/P07 | spike: modelo pede `terminal_exec` e nenhum `tool.request` sai (o registry real não a conhece) | **parcial** — falta o lado do dispatcher Maia (P05) |
| T29 | Segurança | P02/P05 | — | não iniciado |
| T30 | Segurança | P05 | — | não iniciado |
| T31 | Segurança | P05 | — | não iniciado |
| T32 | Entrega | P02 | — | não iniciado |
| T33 | Entrega | P04 | — | não iniciado |
| T34 | Entrega | P04 | — | não iniciado |
| T35 | Entrega | P04/P10 | — | não iniciado |
| T36 | Entrega | P02 | — | não iniciado |
| T37 | Entrega | P02/P03 | — | não iniciado |
| T38 | Entrega | P04 | — | não iniciado |
| T39 | Entrega | P04 | — | não iniciado |
| T40 | Console | P04/P10 | — | não iniciado |
| T41 | Console | P04 | — | não iniciado |
| T42 | Aprendizado | P08 | — | não iniciado |
| T43 | Aprendizado | P08 | — | não iniciado |
| T44 | Aprendizado | P08 | — | não iniciado |
| T45 | Aprendizado | P08 | — | não iniciado |
| T46 | Aprendizado | P08/P09 | — | não iniciado |
| T47 | Aprendizado | P08/P09 | — | não iniciado |
| T48 | Aprendizado | P09 | — | não iniciado |
| T49 | Aprendizado | P09 | — | não iniciado |
| T50 | Aprendizado | P09 | — | não iniciado |
| T51 | Aprendizado | P08 | — | não iniciado |
| T52 | Aprendizado | P09 | — | não iniciado |
| T53 | Hermes | P00/P07 | `tests/reliability/hermes-worker-spike.spec.ts` — igualdade exata entre manifest, `agent.tools`/`valid_tool_names` e a lista `tools` que chega ao provider | **verificado** com motor real (provider stub) |
| T54 | Hermes | P00/P07 | mesmo arquivo — `HERMES_HOME` do perfil pessoal recusado com exit 2, sem frames e sem escrita | **verificado** |
| T55 | Hermes | P00/P07 | mesmo arquivo — inventário do home efêmero após o turno (`state.db`, `config.yaml`) | **verificado** (o worker inventaria; a retenção/limpeza é do supervisor, P07) |
| T56 | Custo | P06 | — | não iniciado |
| T57 | Custo | P06 | — | não iniciado |
| T58 | Custo | P06 | — | não iniciado |
| T59 | Custo | P06 | — | não iniciado |
| T60 | Shadow | P11 | — | não iniciado |
| T61 | Shadow | P11 | — | não iniciado |
| T62 | Privacidade | P08/P10 | — | não iniciado |
| T63 | Privacidade | P10 | — | não iniciado |
| T64 | Privacidade | P10 | — | não iniciado |
| T65 | Rollback | P07/P12 | — | não iniciado |
| T66 | Rollback | P07 | — | não iniciado |
| T67 | Segurança | P05/P06/P07 | — | não iniciado |
| T68 | Upgrade | P00/P07 | — | não iniciado |
| T69 | Migração | P03/P04/P06/P09 | migrations 139/140 aplicadas pelo runner real + ciclo `down → up` executado no banco descartável; constraints e triggers conferidos no catálogo | **verificado** para esta fatia (novas migrations exigirão repetição) |
| T70 | Deploy | P00/P07 | — | não iniciado |

## 6. Gates de expansão (§10.2) e verificação real do motor (§11.3)

| Gate | Estado |
|---|---|
| G-ABI | **atingido com provider stub**: loop real, registry real, tools/limites/contexto/cleanup compatíveis com o SHA pinado, cancelamento exercitado (V-016). Falta o smoke com provider real (D02) e a validação em Linux |
| G-AUTH | não iniciado |
| G-LIFE | não iniciado |
| G-HUMAN | não iniciado |
| G-LEARN | não iniciado |
| G-COST | não iniciado |
| G-DATA | bloqueado (D05) |
| G-OPS | bloqueado (D01) |
| G-QUALITY | bloqueado (D03/D04, produto) |
| §11.3.3 smoke com provider real | bloqueado (D02 + orçamento não autorizado) |
| §11.3.7 benchmark em hardware alvo | bloqueado (D01/D03) |

## 7. Decisões pendentes (§12.5)

| ID | Decisão | Default seguro aplicado | Bloqueia |
|---|---|---|---|
| D01 | Launcher/isolamento real | somente smoke sintético sem PII | dados reais, G-OPS |
| D02 | Provider/modelo/conta | nenhuma chave/assinatura pessoal | smoke pago/live |
| D03 | Volume/concorrência/latência/orçamento | limites live sem default | dimensionamento/live |
| D04 | Coorte piloto | tudo off | canário |
| D05 | Política de dados | não capturar/compartilhar | memória/PII |
| D06 | Aprovadores reais | propostas pendentes | aprendizado compartilhado/handoff |
| D07 | Ferramentas comerciais | deny-by-default | capacidade comercial |
| D08 | Revisão de fatos | draft separado, unique intacta | migração learning |
| D09 | Formato real do request SDK | gateway fechado | integração real (resolvível no spike P00) |
| D10 | UX de backlog humano | `future_only` | atendimento humano |
