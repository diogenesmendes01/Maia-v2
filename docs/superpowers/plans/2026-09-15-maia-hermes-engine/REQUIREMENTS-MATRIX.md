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
| P00 | Wire/JSON Schema TS+Python, normalização de histórico, execução sintética real com AIAgent, superfície após compressão e cleanup | **em andamento**: P00.1 (contrato wire TS + canônico + fixtures compartilhadas) concluído e verificado; P00.2 (worker Python), P00.3 (normalizador de histórico) e P00.4 (spike real com `AIAgent`) pendentes |
| P01 | Caracterização do comportamento local (matriz de delivery, role/pending/report/sensitive, pós-turno) | **concluído e verificado** — `tests/unit/react-loop-characterization.spec.ts` (57 casos), primeira suíte unitária de `runReActLoop`; 10 mutações do implementador + 3 minhas, independentes, todas detectadas |
| P02 | `AgentEnginePortV1`, `MaiaEngine`, assembler, output coordinator; default local | **em andamento**: P02.0 (contratos + schemas) concluído e verificado; `MaiaEngine`/assembler/coordinator pendentes |
| P03 | Binding/run/tool journal/eventos/projeções, CAS/constraints/imutabilidade, recovery sem rerun | **em andamento**: P03.1 (migrations 139/140 + espelho Drizzle + 12 casos contra Postgres real, incluindo triggers de imutabilidade e append-only) concluído; `engine-repos` e recovery pendentes |
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
| T17 | Durabilidade | P03 | — | não iniciado |
| T18 | Segurança | P06 | — | não iniciado |
| T19 | Segurança | P05 | — | não iniciado |
| T20 | Segurança | P00/P05 | — | não iniciado |
| T21 | Segurança | P05 | — | não iniciado |
| T22 | Segurança | P05 | — | não iniciado |
| T23 | Segurança | P05 | — | não iniciado |
| T24 | Segurança | P05 | — | não iniciado |
| T25 | Segurança | P05/P08 | — | não iniciado |
| T26 | Segurança | P03/P05 | — | não iniciado |
| T27 | Segurança | P03/P05 | — | não iniciado |
| T28 | Segurança | P00/P07 | — | não iniciado |
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
| T53 | Hermes | P00/P07 | — | não iniciado |
| T54 | Hermes | P00/P07 | — | não iniciado |
| T55 | Hermes | P00/P07 | — | não iniciado |
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
| G-ABI | não iniciado |
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
