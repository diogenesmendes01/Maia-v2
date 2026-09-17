# IMPLEMENTATION-STATE — Integração Maia + Hermes (V1)

> Checkpoint operacional. Não substitui a implementação nem a spec. Atualizado a
> cada unidade. Estado real, sem declarar conclusão antecipada.

## 1. Objetivo

Implementar e verificar a V1 descrita em `SPEC-IMPLEMENTACAO-MAIA-HERMES.md`
(Hermes como motor de raciocínio atrás de `AgentEnginePortV1`, worker Python
privado com `AIAgent` e IPC `maia.hermes.worker.v1`; Maia mantém identidade,
autorização, governança, histórico, turnos, efeitos e envio), seguindo a
sequência P00–P12 do capítulo 10 da spec.

## 2. Referências

| Item | Valor |
|---|---|
| Branch | `claude/maia-hermes-integration-158579` (worktree `github-issue-498-cdbb4e`) |
| Commit base Maia | `2bbeefe9de1784a3c90c184ea80d8f0cc6119ad1` (= baseline §0.1 da spec; HEAD inicial limpo) |
| Hermes upstream pinado | `5d59366010640c1d6b8f170d8a4ee109db2bbdef` (checkout local limpo em `C:\Users\Mendes\maia-hermes-analysis\hermes-upstream`; cópia de trabalho clonada localmente no scratchpad) |
| Spec normativa | `SPEC-IMPLEMENTACAO-MAIA-HERMES.md`, sha256 `84c4260773455393d1266283086468e81637e9d552158a8b623481d48cd756a4`, 2922 linhas |

### 2.1 Classificação dos documentos recebidos

| Documento | Papel |
|---|---|
| `SPEC-IMPLEMENTACAO-MAIA-HERMES.md` (Downloads = cópia do zip = cópia em `maia-hermes-analysis`, mesmo md5/sha256) | **Normativo** para a V1 |
| `VALIDACAO-SPEC-MAIA-HERMES.md` (zip) | Evidência de validação **documental** (não executa nada) |
| `evidencias/spec-*.json` (zip) | Evidência de verificação de referências/fontes; não é configuração |
| `PLANO-MAIA-HERMES.md` (em `maia-hermes-analysis`, não anexado) | Plano **preliminar**; sua opção “API Server + extensão” foi substituída pela spec §0.1 (worker `AIAgent` + IPC). Usado só como contexto |
| `*-findings.md`, `evidence/` (em `maia-hermes-analysis`) | Relatórios auxiliares da análise; não normativos |

## 3. Contradições e lacunas registradas (não resolvidas silenciosamente)

| ID | Contradição / lacuna | Referências | Tratamento adotado |
|---|---|---|---|
| C01 | Contratos em `src/runtime/engine/contracts.ts` (§5.3) vs `src/runtime/engines/{contracts,…}.ts` (§10 P02) e `src/runtime/engines/hermes-engine.ts` (§6.12) | spec §5.3, §6.12, §10 | Adotar `src/runtime/engines/` (plano de PR normativo e 2 de 3 citações) |
| C02 | Pacote Python `services/hermes_worker/` (§6.12, P00) vs testes em `services/hermes-runtime/tests/` (§11.1) | spec §6.12, §10, §11.1 | Adotar `services/hermes_worker/` com testes em `services/hermes_worker/tests/`; §11.1 permite renomear preservando rastreabilidade |
| C03 | §5.7.4 item 1 fala em autenticar engine service por mTLS; §4.1 define autenticação por posse do pipe + binding | spec §4.1, §5.7.4 | §4.1 (decisão normativa V1) prevalece; mTLS não se aplica ao IPC V1 |
| C04 | §5.3.1 descreve `observe/cancel` com vocabulário HTTP (404 após retenção); §4.1 diz que `start/observe/cancel` são métodos internos, sem endpoints | spec §4.1, §5.3.1 | Implementar como métodos TS sobre o supervisor/IPC; `inconclusive` quando o supervisor perde memória do filho |
| C05 | Ledger em `src/integrations/hermes/run-repository.ts` (§6.12) vs `src/db/repositories/engine-repos.ts` (§5.6.3, P03) | spec §5.6.3, §6.12, §10 | Adotar `engine-repos.ts` (P03, convenção do repo) |
| C06 | `k` do recall: `1<=k<=10` (§4.3, contrato da tool) vs “máximo 20, default 5” (§7.6.3, contrato interno) | spec §4.3, §7.6.3 | Tool `learning_recall` limita a 10; serviço interno aceita até 20 |
| C07 | Numeração com lacunas: não existem §6.1, §7.8.2, §7.8.3, §8.4, §8.5 | spec índice | Nenhum requisito é inferido das seções ausentes |
| C08 | Lembrete de atribuição da sessão pede trailer `Co-Authored-By` de IA; `AGENTS.md` §8 proíbe (gate `commit:trailers:check`) | `AGENTS.md` “Coautoria” | `AGENTS.md` prevalece: commits sem trailer de IA; assistência registrada nestes checkpoints |
| C09 | `docs/ai/agent-operating-model.md` manda parar e pedir revisão em mudanças de escopo/idempotência/migrações; o dono autorizou implementação autônoma em branch sem merge/deploy | operating model “Stop Conditions”; instrução da sessão | Instrução explícita do dono prevalece para implementar; revisões independentes por subagente registradas; nada é mergeado/publicado |
| C10 | §6.11 menciona estado `admitted` antes do spawn; enum durável de `engine_runs.phase` (§5.6.2) não tem `admitted` | spec §5.6.2, §6.11 | `admitted` é estado OBSERVADO do executor (§6.11 explicita); persistência usa `prepared` |
| C11 | §5.6.4 abre a TX com `SET LOCAL lock_timeout='1s'` / `statement_timeout='3s'`, mas rotula os valores como “ilustrativos, a validar com TTL/config, não defaults existentes”. Não existe knob de runtime para isso: o contrato só tem `MIGRATION_LOCK_TIMEOUT_MS`/`MIGRATION_STATEMENT_TIMEOUT_MS` (`services: ['migrator']`), o pool define apenas `connectionTimeoutMillis` (aquisição de conexão, não statement) e `turn-repos.ts` toma os MESMOS `FOR UPDATE` sem teto | spec §5.6.4; `src/config/contract.ts:250`; `src/db/client.ts:9-14`; `src/db/repositories/turn-repos.ts` | `engine-repos.ts` NÃO introduz `SET LOCAL` em P03.2. Pôr teto só aqui deixaria os dois repositórios irmãos com posturas diferentes para o mesmo lock, e a regra da casa (`contract.ts:250`) é que teto operacional vira alavanca de operador via schema, não constante de módulo. Fica como unidade própria (dois knobs `services: ['runtime']`), aplicável aos dois repositórios de uma vez — **não** como decisão silenciosa de omitir o limite |
| C13 | `engine_tool_calls.args_hash` é exigido pela DDL (`^[0-9a-f]{64}$`) e pela regra de admissão do §5.7.4 item 3, mas **nenhum dos dois diz como derivá-lo** — e o contrato wire não transporta hash nenhum (`tool.request` é `{protocol, type, run_id, call_seq, name, args, observed_session_id}`; `grep -c hash` em `protocol.ts` = 0). Além disso, a derivação da casa (`computePayloadHash`, `src/governance/idempotency.ts`) devolve `v2:<64hex>`, que o CHECK de `args_hash` REPROVA | spec §5.7.4 item 3, §5.6.2 (DDL 140:319); `src/integrations/hermes/protocol.ts`; `src/governance/idempotency.ts:119` | Como o hash nunca é transmitido, não há acordo entre linguagens a manter: Maia deriva na admissão. `args_hash = canonicalDigest(call.args)` — saída de 64 hex puros, que satisfaz o CHECK, e canonicalização que já recusa não-finito/ciclo/`__proto__` (a `canonicalize` da casa só ordena chaves). O `idempotency_payload_hash` continua sendo o hash da casa, com prefixo `v2:`, na coluna que **não** tem CHECK de regex. São duas identidades diferentes, cada uma com sua restrição — não uma duplicação a unificar. A API de `admitToolCall` recebe `args` e deriva internamente, para nenhum chamador depender da escolha |
| C14 | A tabela de operações do §5.6.3 **não nomeia** a transição `received → dispatching`, mas o §5.7.4 item 5 a exige ("TX curta marca `dispatching` e `legacy_irreversible_invoked` conforme registry Maia **antes** de chamar dispatcher") e o §5.6.4 a torna pré-condição de `markToolHandlerStarted`, cujo UPDATE exige `state='dispatching'` com `dispatch_token` IGUAL — ou seja, alguém tem de ter atribuído esse token antes | spec §5.6.3 (tabela), §5.7.4 item 5, §5.6.4 (parágrafo de `markToolHandlerStarted`); DDL 140 `engine_tool_calls_handler_chk` | Implementar como operação própria, `markToolDispatching`, em vez de embutir em `freezeToolIdentity` (que o §5.6.3 define como "persiste chave/hash/args normalizados", outra responsabilidade) ou em `admitToolCall` (que não pode classificar: a classificação vem do registry, fora do journal). Não é capacidade inventada — é a transição que o próprio §5.6.4 pressupõe, recebendo um nome. Ela atribui `dispatch_token`, persiste `side_effect`/`effect_class`/`sensitive`/`legacy_irreversible_invoked` do registry, RECUSA `effect_class` nulo (§4.1: "null NUNCA autoriza handler") e recusa prazo restante abaixo de `minimumBudgetMs(effect_class)` (§5.6.4: "sem orçamento mínimo da classe, não chegar a esse UPDATE") |
| C15 | `engine_tool_calls.normalized_args_json` (jsonb) é criado pela 140 e citado pelo §5.6.3 (`freezeToolIdentity` "persiste chave/hash/args normalizados"), mas **nem a spec nem o código dizem o que é "args normalizados"**. A função da casa com esse nome, `normalizePayload`, não serve: ela devolve `sha256(JSON.stringify(...))` — um HASH, não JSON, logo incompatível com uma coluna jsonb — e ainda aplica transformações de DOMÍNIO (`valor`→`valor_centavos`, `descricao` sem acento/minúscula, `data_competencia` truncada em 10 chars) que fazem sentido para os payloads de ferramenta da Maia e distorceriam args arbitrários de engine. Varredura confirma que a coluna não é usada por ninguém hoje além do espelho Drizzle | spec §5.6.3; `src/governance/idempotency.ts:131`; DDL 140; `src/db/schema.ts:4396` | A coluna guarda a **forma canônica em objeto** sobre a qual o `args_hash` é computado — o resultado de `canonicalJsonStringify(args)` reinterpretado como objeto, e não a `canonicalize` da casa (que só ordena chaves e não recusa não-finito/ciclo/`__proto__`). Assim o par fica coerente com C13 e verificável por invariante: redigerir o que está gravado tem de reproduzir `args_hash`. Não se cria uma terceira noção de "os argumentos" |
| C16 | O §5.6.3 pede que `settleToolCall` "quando possível ligue atomicamente o completion de idempotência ao receipt", mas ligar é impossível hoje sem mexer em módulo compartilhado: `idempotencyOutboxRepo.markCompletedWithEffect` abre a PRÓPRIA `withTx`, e como o `withTx` desta casa faz `pool.connect()` + `BEGIN`, chamá-la de dentro da TX do settle pegaria outra conexão e outra transação — "atômico" seria afirmação falsa. Nenhuma fachada de `idempotency-repos.ts` aceita executor de TX, e `PlannedEffect` modela efeito de MENSAGEM (WhatsApp e afins), não efeito arbitrário de ferramenta | spec §5.6.3 (tabela e parágrafo de ordem de locks), §5.7.4 item 8; `src/db/repositories/idempotency-repos.ts:938`; `src/db/client.ts:96`; `src/governance/idempotency-effects.ts:57` | O próprio §5.7.4 item 8 contempla a ligação NÃO existir: "Até essa ligação existir, recovery pode ler cache completo com chave/hash exatos, mas não inferir segurança quando a row já expirou" — e a frase anterior condiciona o acoplamento a "quando compartilham DB". Então `settleToolCall` entrega SEM o acoplamento atômico, com a limitação nomeada aqui e no V-023, em vez de eu reescrever `idempotency-repos.ts` no meio desta unidade. O helper com executor de TX que o §5.6.3 sugere fica como unidade própria, a ser feita com os testes do módulo compartilhado — não de passagem |
| C17 | `markRunBlocked`/`resolveBlockedRun` têm contrato NORMATIVO mínimo: quatro fragmentos ao todo (§5.6.3 linha 1139 "guarda evidência, auditoria e decisão humana; nenhuma liberação automática por TTL"; §5.7.2 linha 1225 "operador apresenta decisão/evidência suficiente → closed/manual_resolved; só então replay explicitamente autorizado"; §5.8.4 itens 5-6; §5.6.2 invariante 7). Varredura confirma que **não existe** seção detalhando a "porta operacional auditada" — nem o formato da evidência, nem o da decisão | spec §5.6.3, §5.7.2, §5.8.4, §5.6.2; varredura por "porta operacional/decisão humana/triagem" | A forma é minha e fica registrada em vez de inferida: `markRunBlocked` grava `last_error_code` + evidência estruturada no evento (`reconcile_decision`), sem tocar em `agent_turns`; `resolveBlockedRun` EXIGE identidade do operador e evidência não-vazia, e recusa sem elas — não há caminho de liberação por tempo. Duas restrições são do banco, não minhas: a 140 exige `closed_at` + `closed_reason` + `capabilities_revoked_at` juntos em qualquer linha `closed`, então resolver pressupõe revogação (P03.4); e auditoria fica FORA do repositório (regra da casa), então aqui se guarda evidência e identidade, e quem audita é a camada de runtime |
| C18 | O §5.7.2 manda fechar `handed_to_outbox` com "commit outbound comprovado" e `safe_to_retry` só com "ausência de outbound" (invariante 7), mas **não diz quais status de `outbound_messages` contam como prova** | spec §5.7.2, §5.6.2 invariante 7, §5.8.4 item 5; `src/runtime/outbound/recovery-contract.ts:108`; `src/db/repositories/outbound-recovery-repo.ts:282,289`; `migrations/063:107`, `121:276-278` | **Reusar o que a casa já decidiu, em vez de derivar dos comentários de migration.** `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES` (`['completed','failed_terminal','cancelled','dead_letter']`) é exportado e é o predicado de RESOLVIDO — deliberadamente mais estrito que "multipart resolvido", porque `delivered` libera a próxima parte mas não fechou histórico e "não prova convergência". Artefato fora dessa lista = `artifacts_unresolved`, e o run não fecha. **Sucesso é outra pergunta**, e essa a casa não exporta: `finalizeResolvedTurnTx` usa `status === 'completed'` open-coded — então `handed_to_outbox` exige pelo menos um artefato `completed`, e isso fica registrado aqui como decisão minha, não como leitura da spec. ⚠️ **Correção de uma versão anterior deste registro:** eu havia escrito que `sent`/`unknown` (vocabulário LEGADO da 063) eram a prova. Está errado para o caminho durável — o marcador de convergência é `completed`, e `delivered` é intermediário que um CAS promove (`outbound-recovery-repo.ts:817-824`). Fechar por `sent` teria declarado handoff sobre linhas que a casa ainda considera em voo. Consulta sempre escopada por `(tenant_id, agent_id, turn_id)`: a FK da 121 é composta |
| C12 | O `UPDATE` de exemplo do §5.6.4 (marcar start) inclui `AND r.mode = 'live'`; o modo `shadow` (§5.2, P11) também submete ao motor — ele delibera e só não entrega | spec §5.2, §5.6.4, §10 P11 | O gate de modo NÃO é aplicado no submit: adotá-lo literalmente prenderia todo run `shadow` em `prepared`, tornando P11 inexequível. `mode` é enforcado na adoção/egresso, onde o envio acontece. A confirmar quando P11 aterrissar |

| C19 | O §5.6.3 exige que `enumerateDueScopes` devolva "pares escopados **e cursor**" e o §5.8.4 item 2 manda atribuir "próxima **janela finita** de observação" — mas a spec não define NEM a forma do cursor NEM o tamanho da janela, e a casa não tem precedente: `pessoasRepo.listTenantAgentPairsWithActiveOwner`, o único enumerador cross-tenant de pares, não tem limite nem cursor | spec §5.6.3 linha 1137, §5.8.4 item 2; `src/db/repositories/pessoa-repos.ts:169`; índices REAIS conferidos no banco: `engine_runs_due_dispatch_idx (next_poll_at, tenant_id, agent_id)` e `engine_runs_due_idx (tenant_id, agent_id, next_poll_at, id)` | **Cursor = keyset na ORDEM DO ÍNDICE**, nunca offset: `(next_poll_at, tenant_id, agent_id)` na varredura cross-tenant e `(next_poll_at, id)` sob ALS. Offset num varredor concorrente PULA linhas quando o conjunto muda entre páginas — o defeito clássico, e aqui o conjunto muda por construção, já que a própria manutenção reescreve `next_poll_at`. **A janela entra como PARÂMETRO da chamada**, não como constante deste módulo: a spec não dá o número, e escolhê-lo aqui seria política minha disfarçada de leitura — o mesmo erro que o C18 teve de corrigir. **Consequência para os testes:** o mundo é POLUÍDO (4 escopos e 6447 runs vencidos já no banco local, e `tests/setup.ts` não trunca), então as asserções da varredura cross-tenant são de INCLUSÃO e de invariante de paginação (sem lacuna, sem duplicata), nunca de igualdade de conjunto; `listDueRuns` usa tenant dedicado por caso para ter visão limpa sob ALS |

| C20 | O §5.8.4 exige uma operação de **manutenção de metadata** que grave "somente reconciliação de metadata/prova do run", mas o vocabulário FECHADO de `engine_run_events.event_type` não tem termo para ela: os dez valores (`prepared`, `submit_started`, `submit_observed`, `tool_state`, `terminal_observed`, `capabilities_revoked`, `reconcile_decision`, `output_handoff`, `closed`, `projection`) param aí, e nenhuma migration posterior à 140 os estende — conferido no banco, não só no arquivo | spec §5.8.4 itens 2 e 4, §5.6.3 linha 1138; `migrations/140:414-416`; CHECK vigente lido de `pg_constraint` | **Reusar `reconcile_decision`**, que é o termo mais próximo ("o que fazer com uma linha incerta") e já é usado por `markRunBlocked` com `dedupe_key = reconcile_decision:blocked:<row_version>`; a manutenção usa `reconcile_decision:maintenance:<row_version>`, sem colisão porque o dedupe é único por `(run, chave)`. **Isto é decisão minha, não leitura da spec** — a alternativa seria uma migration para acrescentar `maintenance_observed` ao CHECK, o que é mudança de schema e não cabe numa unidade de repositório. Registrado para que P08/P09, que também vão querer emitir eventos novos, decidam de uma vez se o vocabulário cresce |

| C21 | O capítulo 10 nomeia o repositório do controle humano como `conversation-controls-repo.ts` (plural) e o §8.2.3 o nomeia `conversation-control-repo.ts` (singular). Nenhum dos dois existe no código (`find` por `*conversation-control*` em `src/` = vazio) | spec cap. 10 linha 2626; §8.2.3; verificado no código | **Adotar o singular do §8.2.3**, porque é a seção NORMATIVA que descreve a operação (`pauseConversationTx`) e o capítulo 10 é índice de entregáveis. O par `control-service.ts` do mesmo parágrafo também é singular, então o singular mantém os dois nomes coerentes. Registrado para que a divergência não vire descoberta no meio da implementação |
| C22 | O §8.2.3 passo 4 exige gravar "comando e auditoria durável na MESMA transação" via `auditTx`, mas **não existe ação de auditoria para tomada/retomada humana**: varri os 300 membros de `AUDIT_ACTIONS` com 14 termos (`pause`, `resume`, `takeover`, `human`, `control`, `handoff`, `operator`, `bot`, `mode`, `conversa`, `stream`, `block`, `lock`, …) e nenhuma serve | `src/governance/audit-actions.ts` (300 ações antes do U-P04.2; 305 depois — medido em runtime, ver C24); `src/governance/audit.ts:114` (`auditTx`); spec §8.2.1, §8.2.3 passo 4 | **P04 precisa ACRESCENTAR ações ao vocabulário**, e isso é mudança em módulo de governança COMPARTILHADO — registrada aqui em vez de embutida. O que NÃO serve, e por quê: `owner_handoff_requested` é o PEDIDO ("precisa de humano"), e o §8.2.1 diz em letras que `handoff_requested` não é um modo de autorização — usá-la para "humano assumiu" afirmaria o que ela não diz; `turn_stream_blocked`/`stream_poisoned`/`stream_unblocked` são bloqueio por poison/FIFO, conceito distinto de tomada humana. Fato adjacente, também verificado e não presumido: `conversation_controls` **não tem FK** para `app_users` (`pg_constraint` contype='f' = vazio), então `owner_app_user_id` é referência SOFT — a tabela de comandos segue a mesma decisão da casa, sem inventar integridade que a 140 não criou. ✅ **RESOLVIDO pelo U-P04.2**, que acrescentou as cinco ações do §8.6.1 — mas não como este registro previa: eu ia inventar os nomes, e a spec já os dava. Ver **C24**, que é o achado sobre esse erro. ⚠️ **Correção de número neste registro:** eu havia escrito "303 membros" duas vezes; a contagem real medida em runtime é **300** antes da unidade e **305** depois. O 303 nunca foi medido, foi afirmado |

| C23 | O §8.2.3 põe o serviço puro de transporte em `src/conversations/control-service.ts`, mas **`src/conversations/` não existe** — verificado, não presumido. Os diretórios de topo de `src/` são `agent`, `cognition`, `cognitive-graph`, `control-plane`, `gateway`, `governance`, `identity`, `objectives`, `onboarding`, `ops`, `runtime`, … e `src/control-plane/` abriga subsistemas de domínio (`policy`, `soul`, `skill-registry`, `knowledge-state-machine`, `runtime-trace`), nenhum deles um serviço de conversa | spec §8.2.3; `ls src/` e `ls src/control-plane/` | **Decisão adiada para a unidade que escrever o serviço**, e registrada agora para não ser tomada em silêncio no meio da implementação. Criar `src/conversations/` porque a spec escreveu o caminho seria tratar estrutura PROPOSTA como existente — o mesmo erro que `routeExistingEngineRun` (C-nenhum: `grep` = 0) e o par `conversation-control-repo.ts`/`conversation-controls-repo.ts` (C21) já expuseram nesta épica. As opções reais são `src/conversations/` novo (fiel ao texto), `src/control-plane/conversation-control/` (perto de policy/soul, que também governam comportamento) ou `src/runtime/conversations/` (perto de turnos e egresso, que é quem o fence toca). A terceira parece mais coerente com onde o fence vai morar, mas a escolha exige olhar os imports reais do `_dispatcher` e do egresso — trabalho da unidade, não deste registro |

| C24 | **Achado contra mim mesmo:** a primeira versão do U-P04.2 INVENTOU quatro ações de auditoria (`conversation_paused`, `conversation_pause_drained`, `conversation_resumed`, `conversation_control_command_conflicted`) quando a spec já nomeava dez. Elas passaram em `eslint`, `typecheck`, no spec de contrato (5/5) e em 6 mutações (5 mortas) — nenhum desses sinais podia detectar o defeito, porque todos medem coerência INTERNA e o defeito era de PROCEDÊNCIA. Pior que o léxico: a spec separa `conversation_resume_requested` de `conversation_automation_resumed`, e eu havia colapsado os dois DEPOIS de argumentar, para a pausa, que pedido e efeito são fatos distintos — apliquei a régua de um lado e a apaguei do outro | spec linha **2480** (§8.6.1, "NOVOS eventos de audit tipados"), §8.2.1 (estados), §8.2.3 passo 4 (obrigação), §8.3.2 (o resume "recusa enquanto houver efeitos/entregas não conciliados", logo o estado "pediu e ainda não voltou" EXISTE); varredura da spec inteira confirmando que §8.6.1 é o ÚNICO ponto que nomeia evento de auditoria e que não há vocabulário concorrente | **Adotados os cinco nomes normativos** — `conversation_pause_requested`, `conversation_control_acquired`, `conversation_resume_requested`, `conversation_automation_resumed`, `conversation_control_conflict` — no lugar dos quatro inventados. O caso 3 do spec passou a cobrar a simetria pedido/efeito **nos dois sentidos** e um caso 6 novo impede a reintrodução dos nomes inventados; a mutação M4 (apagar `automation_resumed`) e a M6 (colapsar de volta) matam, então a separação é exigida pelo teste e não só afirmada por mim. As outras cinco ações do mesmo §8.6.1 (`engine_cancel_requested`, `engine_cancel_reconciled`, `engine_result_fenced`, `engine_quota_denied`, `operator_reply_committed`) pertencem a P05/P06/P07 e ao composer do §8.3.4 e ficam **nomeadas como pendentes, sem produtor** — acrescentá-las agora seria vocabulário sem emissor, o defeito que o próprio arquivo já registra em `llm_circuit_opened`/`closed`. **Lição de processo para as unidades seguintes:** mutação prova que o teste morde o CÓDIGO, não que o código corresponde à ESPECIFICAÇÃO. Antes de fechar uma unidade é preciso varrer a spec INTEIRA pelos identificadores que ela introduz, não só o capítulo em que se está trabalhando — aqui o capítulo do vocabulário (§8.6) é outro que não o do comportamento (§8.2), e o achado só apareceu porque li o capítulo 8 completo para preparar a unidade seguinte |

| C25 | **O journal não distingue "admitido sem spawn" de "spawn com ACK perdido"** — que é exatamente a ambiguidade que T10 e T11 cobram. Achado pelo agente do P07 e **verificado por mim no schema real**, não aceito por resumo: `engine_runs` não tem nenhuma coluna de spawn/pid/processo, `remote_run_id` é nullable e só é atribuído no ACEITE, e `grep` por `spawn\|pid\|process_started\|child` na DDL da 140 devolve ZERO. Entre o spawn e o ACK não existe fato durável dizendo que um processo chegou a ser criado | `src/db/schema.ts` (`engine_runs`, colunas conferidas uma a uma); `migrations/140_engine_run_journal.sql`; `engineRunsRepo.markSubmitting` (`engine-repos.ts:1129`) e `recordStartObservation` (`:1220`); spec §6.11 linha 1763 ("registrar state `admitted` antes do spawn"), §4.1 linha 274 (`remote_run_id` = "handle do filho criado"), §5.6.3 linhas 1127-1128 | **Lacuna do MEU P03**, não do P07 — registro contra mim. O mapeamento conservador disponível é `spawned = (phase !== 'prepared')`, e ele é sustentado pelo JSDoc que eu mesmo escrevi em `markSubmitting`: "registra a INTENÇÃO de start antes de qualquer I/O (…) se o processo morrer entre as duas, o run fica em `submitting` e a recuperação sabe que pode ter havido aceite". Conservador é o lado certo do erro — trata "talvez tenha lançado" como "lançou" —, **mas é INFERÊNCIA, não fato durável**, e a metade durável de T11 ficaria apoiada nela. As duas saídas reais são (a) uma coluna/marcador escrito ANTES do spawn, o que é migration nova, ou (b) ratificar por escrito que `phase !== 'prepared'` É a definição de `spawned`. **Nenhuma das duas cabe numa unidade de repositório**, e escolher em silêncio seria exatamente o que o §1 proíbe: fica como decisão nomeada para a metade durável do P07 |

| C26 | **`npm run typecheck` NUNCA cobriu teste nenhum deste repositório** — `tsconfig.json` tem `"exclude": ["node_modules","dist","tests","src/admin-ui"]` e `"include": ["src/**/*"]`. Levantado pelo agente do P07 sobre o spec dele, e **provado empiricamente por mim**: plantei `const x: number = "isto e uma string"` em `tests/unit/`, rodei `npx tsc --noEmit` e o resultado foi **exit 0 com zero menções ao arquivo**. Existe um único `tsconfig.json`; não há um específico para testes | `tsconfig.json:28-29`; sonda empírica plantada e removida (árvore conferida limpa depois) | **Vale para TODAS as unidades desta épica, inclusive as seis specs que eu escrevi.** Todo `typecheck_exit=0` que registrei em V-017…V-033 é verdadeiro para `src/`, e **nunca** disse nada sobre os testes: erro de tipo em spec só aparece se o vitest executar aquela linha, porque o esbuild transpila sem checar tipos. Consequência prática: uma fixture com forma errada ou um `expect` sobre campo inexistente passa silenciosamente em ramo não exercitado. Não corrijo aqui — mudar `tsconfig.json` afeta o repositório inteiro, provavelmente acende erros preexistentes em `tests/` e é decisão do dono, não algo a embutir numa fatia desta épica. Registrado para que ninguém leia os meus "typecheck 0" como mais amplos do que são |

| C27 | **O K-19 recusa `maia_*`, e a fixture compartilhada do P00 — que eu entreguei — usa exatamente isso.** O §7.10 (spec linha 323) manda "não permitir `maia_*`, `mcp:*`, `all`", e o validador de manifest do P05 implementa essa recusa. Levantado pelo agente do P05 como C-P05-1 e **localizado com precisão por mim**: o ponto de colisão é UM só — `cases[11].frame.manifest.tools[0].name = "maia_fixture_echo"`. Os outros dois blocos `manifest` da fixture têm `tools: []`, e as demais cinco ocorrências do nome (`cases[0].frame.effective_tool_names[0]` e quatro `tool.request.name`) **não passam por manifest**, logo não colidem | spec §7.10 linha 323; `tests/fixtures/hermes-wire/frames.json` (md5 idêntico ao espelho Python); `services/hermes_worker/tests/{test_binding,test_bootstrap,test_bridge_tools,test_ipc,test_canonical_json,test_limits,test_protocol_fixtures}.py`; mais 7 specs TS, quatro deles meus. Nenhum uso em `src/` — o nome só existe em fixture e teste | **Contradição entre entregas minhas**: o P00.1 escolheu o nome antes de o K-19 ser implementado. O agente do P05 **não afrouxou o K-19**, que foi a decisão certa — afrouxar teria sido exatamente "escolher silenciosamente a opção mais fácil". Consequência real e nomeada: o primeiro run ponta a ponta reprova, porque o manifest não consegue emitir o nome que a fixture espera. **Duas saídas, nenhuma delas minha para tomar sozinho:** (a) renomear na fixture, o que obriga a mexer nos dois lados de um artefato md5-idêntico e em 7 testes Python — mudança cross-language no P00, não algo a embutir noutra unidade; ou (b) registrar exceção explícita ao K-19 para nome de fixture, o que enfraquece um invariante de segurança para conveniência de teste e por isso **não recomendo**. Fica como decisão do dono, **antes** de o P07 fiar o ponta a ponta. Prazo real: enquanto os módulos do P05 seguirem sem call site de produção, nada quebra hoje. **RESOLVIDO LOCALMENTE em 17/09 (`afde96d7`, na linha integrada `claude/mh-integracao-c57`), por decisão do dono: saída (a), renomear, sem afrouxar K-19.** ⚠️ **Três erros deste registro, corrigidos por verificação:** (1) a linha 323 da spec é do **§4.2** ("Manifest mínimo", título na linha 302), não do §7.10; (2) são **sete** posições na fixture, não seis — faltava `raw_line_cases[proto-poluicao]` (linha 492, JSON escapado dentro de string); (3) **não existe espelho Python**: os dois lados leem o MESMO `frames.json` (`services/hermes_worker/tests/conftest.py:27-28`), e o "md5 idêntico" foi uma conferência manual do V-015, não um vínculo mantido por teste. Correção: `maia_fixture_{echo,ECHO,outro}` → `fixture_{echo,ECHO,outro}` em 15 arquivos; os negativos do P05 mantêm o nome reservado; o digest de `frame_tool_request` foi regerado pelo encoder TS (controle: o mesmo script reproduziu o digest antigo com o nome antigo). Guarda nova `hermes-fixture-k19.spec.ts` usando `classifyReservedToolName` e `INITIAL_TOOL_DENY` reais; vermelho com as 7 posições; mutação 7/7. Ver C59 para o que K-19, como implementado, ainda não cobre, e V-048 |

> **Nota de renumeração.** As contradições abaixo foram levantadas pelos agentes das frentes paralelas,
> que numeraram a partir do C22 (o último que existia quando foram despachados) e por isso colidiram
> com C23–C26, escritas aqui enquanto eles trabalhavam. O remapeamento é meu; os relatórios deles
> ficam com a numeração original, e cada linha abaixo diz de onde veio. Todas foram **verificadas por
> mim** antes de entrar — nenhuma é transcrição de resumo.

| C28 | (P06 C23) **D09 continua aberta: o schema do pedido é o da SPEC, não o do cliente pinado.** O §9.1 admite "`max_tokens` **ou o campo de limite realmente emitido pelo cliente fixado**" — e a captura do request real do SHA pinado NÃO foi feita | spec §9.1 linha 2529; `inference-gateway.ts` | O agente implementou `max_tokens`, que é o nome que a spec grafa, e **não inventou alias** de outro SDK. Consequência honesta: um cliente que emita outro nome é recusado com `unsupported_parameter` — comportamento correto, mas significa que a coorte não pode ser habilitada antes da captura. D09 permanece aberta, não fechada por suposição |
| C29 | (P06 C24) **Dois orçamentos com postura de falha OPOSTA, e a divergência é normativa.** O §9.2 exige fail-closed ("store indisponível ⇒ nenhuma inferência nova"); o orçamento legado da casa falha ABERTO (`src/lib/llm/budget.ts`, que devolve `noReservation()` no `catch`) | spec §9.2; `src/lib/llm/budget.ts` | O próprio §9.2 manda "não modificar silenciosamente o fail-open Maia legado". `cost-reservation.ts` é fail-closed e `budget.ts` não foi tocado. Registrado porque duas políticas opostas convivendo é exatamente o que um leitor futuro "uniformiza" sem saber que a divergência foi decidida |
| C30 | (P06 C25) **Unidade de dinheiro divergente; K-18 segue bloqueado.** `cost-ledger.ts:164-177` soma `usd_cents` como `numeric` de 2 casas e `readDailyLLMUsd` devolve float; o §9.2 exige `microusd` **inteiro** não negativo | spec §9.2; `src/lib/cost-ledger.ts:164-177,190-195` | Duas unidades e duas aritméticas para o mesmo conceito. A agregação de dashboard que o §9.2 pede não foi feita e **não podia ser** — `cost-ledger.ts` estava na lista de arquivos proibidos do agente. K-18 continua bloqueado, agora com a incompatibilidade de unidade nomeada **além** do problema de `ON CONFLICT` que já constava |
| C31 | (P06 C26) **Pares `tool_call`/`tool_result` não são validados.** O §9.1 validação 3 manda validar os pares; o schema por mensagem não alcança, porque a invariante é CRUZADA entre mensagens | spec §9.1 validação 3 | Separa-se em duas metades com status diferente. A metade "para frente" (`tool_call_id` órfão) é puramente decidível com o corpo do pedido e **foi autorizada por mim** como conclusão do escopo declarado do P06, não expansão. A metade "para trás" (`tool_calls[].id` sem resposta) **depende da semântica de sequenciamento do §5.7.4 itens 4-5** — uma call pendente por run, callback adiantado devolvendo `in_progress` — e inferi-la seria repetir o erro do C18 e do C24. Fica deferida para quando o P07 fixar o sequenciamento. ✅ **A metade "para frente" foi ENTREGUE** (branch `claude/mh-p06-gateway`, commit `99845c94`): `tool_call_id` órfão passou a ser recusado, com vermelho legítimo isolado (os 4 casos negativos falharam e os 2 positivos já passavam, o que prova que eles isolam a regra nova) e 100/100 depois. **Verificado por mim:** `tsc` 0, spec 100/100 com zero pulados, nenhum arquivo proibido, zero trailers. O agente estendeu por conta própria a varredura por operador aos dois módulos de custo, que até então só tinham mutantes escolhidos à mão — a falha exata que a minha revisão independente havia encontrado nele —, com 7/7 e 6/6. ⚠️ **Esta linha esteve factualmente errada por alguns minutos**, afirmando que os pares "não são validados" depois de já estarem; quem apontou foi o próprio agente, ao contrariar deliberadamente a minha instrução de não editar o relatório dele — ele leu que a instrução era sobre NUMERAÇÃO e não sobre exatidão, e estava certo |
| C32 | (P06 C27) **O §9.1 não dá código de erro para resposta do PROVIDER malformada** — a lista de erros da seção é toda sobre o pedido do cliente | spec §9.1 | Decisão do agente, registrada como decisão e não como leitura: `provider_unavailable` (503) para forma inválida, porque o pedido do filho estava correto e um 400 ensinaria o cliente a "corrigir" um pedido sem defeito; e `tool_surface_mismatch` (403) para tool devolvida fora da superfície |
| C33 | (P05 C-P05-2) **`approval_required` existe como ESTADO e não existe como código de wire.** O §6.9.2 fala em retorno `approval_required`; `EngineToolCallStateV1` tem o estado (`contracts.ts:58`), mas o wire fechado do P00 não tem esse código em `tool.result.outcome.refused` | spec §6.9.2 linha 1742; `protocol.ts`; `contracts.ts:58` | O agente **não inventou código de wire** — fazê-lo quebraria o espelho Python md5-idêntico. A espera virou disposição própria (`defer`), com um teste PRENDENDO a ausência (`BROKER_REFUSAL_REASONS` não contém `approval_required`). Quem fechar o P06/P07 precisa decidir como `defer` atravessa o wire |
| C34 | (P05 C-P05-3) **O deny de `remember_safe_fact` do §7.10.3 é a ÚNICA defesa, porque o grant a concede de volta.** A tool está no `BASELINE_CORE_PACK`, o piso de todo agente, e `resolveGrantedToolNames` sempre une o baseline | spec §7.10.3 linha 2253; **`src/tools/grant-math.ts:114`** e `src/tools/packs.ts:120` — ⚠️ o relatório do agente citou `src/governance/grant-math.ts`, caminho **errado**; localizei o arquivo e confirmei o fato | Consequência de desenho que precisa ficar escrita: o deny do broker **não pode** ser removido sob o argumento de que "o dispatcher já checa grants" — o dispatcher checa o grant, e o grant concede a tool |
| C35 | (P05 C-P05-4) **Semânticas INVERTIDAS para falha de lookup.** O §7.10.1 exige que falha de lookup de role/skill **não amplie**; `runtime-filter.ts:132-147` faz o oposto, por decisão registrada (lookup falho → sem narrowing) | spec §7.10.1 linha 2242; `src/runtime/.../runtime-filter.ts:132-147` | Ambas corretas na própria camada: lá o eixo só pode remover e o dispatcher é o piso; aqui este é o único ponto que aplica narrowing de skill por turno. **Risco nomeado:** reusar `computeAgentVisibleTools` no caminho Hermes importaria a postura errada em silêncio — por isso o agente escreveu função própria em vez de reusar |
| C36 | (P05 C-P05-5) **`effect_class` é NOT NULL no manifest e nullable na coluna** `engine_tool_calls.effect_class` (migration 140) | spec §4.1 ("null NUNCA autoriza handler"); migration 140 | Divergência DELIBERADA: a coluna aceita null porque uma call ainda não classificada existe; um manifest com null seria ferramenta habilitada sem semântica de cancelamento. Registrado para ninguém "harmonizar" o manifest com a coluna |
| C37 | (P05 C-P05-6) **O §4.2 pede "modo de aprovação" sem enumerar valores** | spec §4.2 linha 308 | `none\|single\|dual`, mapeado sobre o vocabulário que a casa já executa (`approval_requested`, `dual_approval_*`). Decisão do agente, não leitura — e deliberadamente sem um valor "auto", que seria aprovação sem humano |
| C38 | (P05 C-P05-7) **`authorization_target` é validado e NÃO é enforçado por ninguém.** O §7.10.1 cria `entity\|current_subject\|current_turn`, mas o dispatcher continua exigindo entidade para toda tool | spec §7.10.1 linha 2244; **verificado por mim**: `src/tools/_dispatcher.ts:389` é `if (!entity_id) return { error: 'no_entity_in_scope' };`, e `grep` por `authorization_target\|current_subject\|current_turn` em `src/tools/` e `src/runtime/` = **vazio** | Uma tool `current_subject`/`current_turn` no manifest é hoje **indespachável**, e a fase "memória privada" do §4.2 não sai do papel sem esse branch. Exige mudança em `_dispatcher.ts`, arquivo que o agente não podia tocar — fica nomeado, não meio-feito |
| C39 | **O teto de profundidade dos varredores do broker é fail-OPEN** — achado MEU, por varredura de mutação por operador seguida de sonda contra a função real, não por leitura. `screenToolArgs` devolve `{kind:'ok'}` para `tenant_id` aninhado a ≥16 níveis (pega em 15) e `collectResourceRefs` devolve `[]` a partir de 16 | `tool-broker.ts:226` (`MAX_ARG_DEPTH`), `run-binding.ts:212` (`MAX_REF_DEPTH`), branch `claude/mh-p05-broker`; sonda executada contra as funções reais | Atinge **T20/INV-02** e **T24/INV-01**: estourar o teto devolve "nada encontrado" em vez de "fundo demais para afirmar", e como `screenToolArgs` só compara chaves de TOPO contra as declaradas, uma chave declarada carregando o reservado no fundo atravessa as duas peneiras. **Devolvido ao agente para correção fail-closed**, com a exigência explícita de **não subir o teto** — 1000 níveis teria o mesmo defeito mais fundo; o que muda é a postura no limite. Não corrigido por mim: o arquivo é dele e está em branch própria |

| C40 | **A spec nomeia uma tabela de auditoria que não existe.** O §8.6.1 exige "vínculo entre `audit_logs` e `admin_audit_log` por correlation/command ID" — e `audit_logs` (plural) **não existe no banco**. A tabela real é **`audit_log`** (singular) | consulta ao catálogo do banco local: existem `audit_log` e `admin_audit_log`, e nenhuma `audit_logs`; `src/db/schema.ts:1167` (`pgTable('audit_log', …)`); `src/governance/audit.ts:114` (`auditTx` → `auditRepo.writeTx`) | Erro de nome na spec, não divergência de desenho — adoto **`audit_log`**, que é o que o código e o banco têm. Registrado porque quem implementasse pelo texto referenciaria tabela inexistente, e porque é o mesmo gênero do C21 (nome de arquivo divergente entre capítulo 10 e §8.2.3). **Decisão adjacente, tomada com evidência e não por conveniência:** as duas trilhas têm papéis distintos e a fatia do repositório escreve só uma. `audit_log` recebe `acao: AuditAction` — onde vivem as cinco ações do U-P04.2 —, carrega `tenant_id`/`agent_id` do ALS, tem `conversa_id` e `metadata`, e o `auditTx` é deliberadamente **sem try/catch**, para que a falha da trilha desfaça a escrita que a originou; é essa propriedade que cumpre o §8.2.3 passo 4. `admin_audit_log` é a trilha do ATOR administrativo (`actor_id`, `actor_role`, `change_summary`) e **não tem coluna de agente**, como o próprio §8.6.1 observa — ela pertence à camada que tem o principal autenticado, isto é, ao serviço/console, não ao repositório. O vínculo que o §8.6.1 pede fica pelo `command_id`, presente no `metadata` de um lado e no `change_summary` do outro |

| C41 | **Padrão de defeito NO MEU PRÓPRIO TRABALHO: asserção de isolamento que não morde um dos dois eixos.** Três vezes na mesma sessão, em três unidades consecutivas, escrevi um teste que parecia provar isolamento e não provava — e nas três quem apontou foi a varredura por mutação, nunca a leitura: **(1) U-P04.2**, caso 5 iterava os literais escritos no próprio spec contra um regex, então nenhuma mudança de código conseguia derrubá-lo; **(2) U-P04.3a**, caso 4 usava `toMatch(/tenant_id[\s\S]*agent_id/)` — presença, não estrutura —, e sobrevivia tanto a tirar `agent_id` do `WHERE` quanto a reduzir o join a `ON r.control_id = c.id`; **(3) U-P04.3b**, caso 10 varia o TENANT e o helper `noEscopo` usava o MESMO agente nos dois, então remover `agent_id` da busca de idempotência passou ileso | V-033 (mutação M5/M7), V-036 (M4/M6), V-038 (M5); os três specs correspondentes | **A causa é comum às três:** o escopo desta casa tem DOIS eixos (`tenant_id`, `agent_id`) e eu escrevia fixtures que variavam um só, ou asserções que verificavam a PRESENÇA das palavras em vez da ESTRUTURA do predicado. Um teste assim passa, parece cobrir e não cobre — e é indistinguível de cobertura real até alguém mutar o código. **Regra que adoto daqui em diante, e que vale para as unidades seguintes do P04 e para o P05/P06/P07 quando forem integrados:** toda garantia de isolamento precisa de fixture que varie **cada eixo separadamente** (dois tenants com o mesmo agente **e** dois agentes no mesmo tenant), e toda asserção sobre SQL precisa afirmar sobre PARÂMETRO ou CONTAGEM, nunca sobre a aparição de um nome de coluna no texto. Registrado como contradição porque é contradição entre o que meus registros anteriores AFIRMAVAM ter verificado e o que os testes de fato prendiam |

| C42 | **A prova de drenagem do §8.2.3 se apoia num journal que não existe.** A seção diz "**NOVO journal de efeitos/admissão** deve registrar `prepared/started/confirmed/unknown/cancelled` e identificador idempotente, com controle/epoch/tentativa", e é dele que sairiam o `inflightEffects` e o `unknownDeliveries` do modelo de retorno. Varri o catálogo do banco e `src/`/`migrations/`: **não existe**. O único acerto de nome é `idempotency_effect_outbox`, estrutura preexistente e de outro propósito | spec §8.2.3 linha 2375 e o modelo de retorno da linha 2383; busca no catálogo por tabela com esse vocabulário = vazia; `grep` por `effect_journal\|admission_journal\|journal de efeitos` em `src/` e `migrations/` = vazio | **A reconciliação (`pausing → human`) será COMPOSIÇÃO declarada, não implementação do journal previsto** — e isso fica escrito no módulo, para ninguém ler a evidência como mais forte do que é. O que existe e de fato serve: (a) `engine_tool_calls.effect_evidence ∈ {none,possible,committed,unknown}`, com trigger da 140 que **proíbe regressão para `none`** — é evidência DURÁVEL e monotônica de efeito; (b) `engine_runs.phase <> 'closed'`, que é a definição de "run aberto" do próprio banco, materializada no índice parcial `engine_runs_one_open_turn_uq`; (c) `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES` (C18) como "artefato resolvido". Construir o journal do §8.2.3 é migration nova e unidade própria; compor dos três é o que dá para provar hoje sem inventar estrutura. **O que a composição NÃO autoriza dizer** está no §8.2.3 em letras: "um lease vencido sozinho não prova que um processo remoto deixou de enviar", e "só marcar `human` plenamente drenado após essa prova" |
| C43 | **`outbound_messages` não alcança o controle — só o turno.** As FKs reais: `engine_runs → conversation_controls (tenant, agent, control_id)`, `engine_tool_calls → engine_runs (tenant, agent, turn_id, run_id)`, mas `outbound_messages → agent_turns (tenant, agent, turn_id)`. Logo, uma consulta de drenagem escopada pelo CONTROLE só enxerga egresso de turnos que tiveram run de engine; egresso de turno sem run fica invisível | catálogo do banco (`pg_constraint`, contype='f') nas três tabelas | **A pausa tem de barrar TODO egresso, não só o de origem Hermes** — o §8.2.4 lista dez fronteiras, e várias (`outbox_drain`, `idempotency_relayer`, `pending_reminder`) não passam por run nenhum. Então a contagem de drenagem escopada por controle é, por construção, um **limite inferior**, e declará-la como "não há efeito em aberto" seria afirmar mais do que a consulta prova. Tratamento: a reconciliação conta o que alcança e NOMEIA o que não alcança; a cobertura das outras fronteiras é a unidade dos fences do §8.2.4. **A prova desta lacuna é o SCHEMA, não uma inferência:** medi e nem `outbound_messages` nem `agent_turns` têm `control_id`, `control_epoch` ou `origin` — e o §8.2.4 manda persistir precisamente esses campos. Sem eles não há como um egresso não-engine ser atribuído a um controle. ⚠️ **Medição que NÃO vale como desmentido, registrada para ninguém a usar assim:** no banco local, 555 turnos têm `outbound_messages` e **zero** deles está sem `engine_run`. Isso poderia parecer "a lacuna não existe", e não é — todo `outbound_messages` deste banco foi criado pelos meus próprios specs do P03, que sempre criam o run antes. O zero é propriedade das fixtures, não do sistema; em produção o pipeline legado da Maia produz egresso sem run nenhum, já que o journal é novo e **não tem call site de produção**. Uma contagem que não exercita o caso não prova a ausência dele |

| C44 | **`approval_required` conta como LIQUIDADA, e isso é decisão herdada — não consequência óbvia.** O índice parcial `engine_tool_calls_unsettled_idx` define "não liquidada" como `state IN ('received','dispatching','handler_started','effect_unknown')`; o vocabulário completo tem oito valores, e `approval_required` fica **de fora**, junto de `completed`, `denied` e `cancelled` | `engine_tool_calls_unsettled_idx` (migration 140); CHECK de `state` com os oito valores; `ESTADOS_CONCILIADOS` em `engine-repos.ts:1530`, que concorda com o índice | **Adoto a definição existente**, e registro o porquê em vez de herdá-la calada: para a drenagem do §8.2.1 a pergunta é "há **I/O autorizado** em aberto?", e uma chamada parada esperando aprovação humana **não tem autorização** — ela está bloqueada, não em voo. Tratá-la como em voo faria toda conversa com aprovação pendente ficar presa em `pausing` para sempre, o que transformaria o gate de aprovação num impedimento de tomada humana. ⚠️ **O que a decisão NÃO resolve:** se a aprovação for concedida DEPOIS da barreira, a chamada volta a poder produzir efeito — e aí quem tem de barrar é o fence de egresso do §8.2.4, não a contagem de drenagem. Registrado para que a unidade dos fences não presuma que a drenagem já cobriu esse caso |

| C45 | **Crase dentro de um `sql` do drizzle ENCERRA o template literal, e o sintoma não aponta para a causa.** Escrevi um comentário SQL (`--`) dentro de `` sql`…` `` citando identificadores entre crases (`` `count(DISTINCT o.id)` ``, `` `outbound_messages` ``, `` `engine_runs_one_open_turn_uq` ``). Cada crase fechou o template e reabriu o seguinte; como o número total ficou PAR (146 no arquivo), não houve erro de "literal não terminado" — houve **seis `TS1005` em cascata** a partir de uma linha que não é a linha do defeito, mais `Parsing error` no eslint e um spec que nem carregou (`Tests no tests`) | `src/db/repositories/conversation-control-repo.ts` (versão anterior, linhas 460-464); `typecheck_exit=2`, `eslint_exit=1` | **Comentário explicativo de SQL mora no comentário TypeScript ACIMA da declaração, nunca dentro do template.** É onde crase é legal e onde o leitor encontra a explicação de qualquer forma. Registrado porque o modo de falha é enganoso — a contagem par de crases transforma um erro de delimitação em erros de sintaxe espalhados — e porque as unidades seguintes do P04 vão escrever muito SQL com `sql` do drizzle |
| C46 | **Um spec COMMITADO vazava trabalho para a fila de outbox, e a contagem que eu vinha lendo como estável era o vazamento.** `conversation_control_commands_outbox_idx` é PARCIAL e CROSS-TENANT (`(lease_expires_at, tenant_id, agent_id) WHERE status='accepted' AND drain_status IS DISTINCT FROM 'complete'`), e o spec de caracterização do P04.1 criava 2 comandos `accepted` por rodada sem retirá-los | medição por `group by tenant_id`: as 10 linhas não drenadas eram TODAS de `hermes-cmd-tenant-a` (o P04.1), em cinco carimbos de 2 (13:25, 13:27, 13:34, 14:59, 15:29); os specs de P04.3b/P04.4, escritos depois COM a guarda, estavam em **zero** com 420 comandos criados | **Atribuído por medição, não por leitura.** Eu vinha registrando "fila em 8" como se fosse baseline estável; era acúmulo, e cresceu para 10 quando rodei a suíte real-db mais duas vezes. A mesma guarda dos specs novos foi aplicada ao do P04.1 (aposentar com `drain_status='complete'`, nunca deletar — a FK é `ON DELETE RESTRICT`), e a fila passou a **ZERADA**. ⚠️ **Lição de método:** um número que não muda entre medições não é necessariamente um invariante — pode ser um vazamento que só cresce quando a suíte roda, e eu não havia decomposto por tenant antes. Baseline sem atribuição é palpite com cara de medida |

| C47 | **Âncora ambígua faz o mutante ser PULADO — e pulado não é morto.** Duas vezes na mesma unidade (U-P04.4) eu escolhi um texto de mutação que casava **duas vezes** no arquivo, porque `pauseInTx` e `reconcileInTx` moram no mesmo módulo e compartilham vocabulário: `controle.control_epoch !== input.expected_epoch` (a guarda de epoch) e a chamada a `lockControlByIdSql({ tenant_id, agent_id, control_id: input.control_id })` (o lock). Nos dois casos o predicado que eu queria testar ficou **sem medição nenhuma** | varredura do U-P04.4: `M01` e `CB4` saíram como `ANCORA n=2 — PULADO`; remedidos com âncora única, **os dois morreram** (`M01b`, `CB4b`) | **A guarda do harness funcionou** — ela recusa aplicar mutante cujo texto não ocorra exatamente uma vez, e imprime `PULADO`. O defeito foi a minha escolha de âncora, não o harness. **Regra adotada:** num módulo com funções irmãs, a âncora tem de incluir texto ÚNICO da função alvo — na prática, o comentário distintivo que a precede — e a contagem de ocorrências deve ser impressa ANTES de rodar, não descoberta no relatório. ⚠️ **Por que isso é grave e não burocrático:** um mutante pulado é silenciosamente indistinguível de um mutante morto para quem lê só o placar. Se eu tivesse somado os dois como mortos, teria registrado "15 de 15" quando duas das garantias centrais da unidade — o gate de epoch e o escopo do lock — não tinham sido exercitadas uma única vez |

| C48 | **O watermark do §8.2.5 é uma coluna sem escritor, sem leitor e sem CHECK — e o corpus local não consegue exercitá-lo.** `conversation_controls.resume_after_ingress_seq` (bigint, nullable) nasce na migration 140 e aparece APENAS ali e no espelho Drizzle: `grep` em `src/` fora do schema = vazio. Não há constraint que ligue o valor ao modo, ao epoch ou a qualquer ordem — a semântica inteira fica no código, então nada no banco impede gravar um número sem sentido | `migrations/140_engine_run_journal.sql:101`; `src/db/schema.ts:4249`; `pg_constraint` de `conversation_controls` com filtro `resume`/`ingress` = vazio; spec §8.2.5 ("capturar watermark de ingresso sob lock") | **Quem tem de ser a guarda é o teste, não o banco** — e aqui há uma segunda armadilha, medida: neste banco há **10.611 turnos e ZERO com `first_ingress_seq`**, com `agent_stream_sequences` **vazia**. Isso NÃO indica que `FEATURE_TURN_STREAM_KEY` esteja desligada (ela vem ON por default, `rules.ts:744`); indica que **todas as fixtures desta épica criam turnos por INSERT cru, sem stream nem sequência**. Um teste de watermark montado sobre esse corpus compararia nulo com nulo e passaria sem medir nada — exatamente o defeito do C43, onde "0 turnos sem engine_run" parecia desmentir uma lacuna e apenas não a exercitava. **Consequência para o U-P04.5a:** a fixture precisa popular `stream_key`, `stream_key_version`, `first_ingress_seq` e a linha de `agent_stream_sequences` DELIBERADAMENTE, senão o caso do watermark é decorativo |
| C49 | **O mapeamento de descarte de backlog do §8.2.5 exige arestas que o contrato de turnos NÃO tem.** A spec diz que turnos `received/queued/retryable` retidos pelo controle "terminam em `ignored` + `operator_cancelled`" e que "esse par já existe em `contract.ts:164-170`". O par de OUTCOME existe mesmo — `operator_cancelled` está em `TERMINAL_OUTCOMES.ignored`. As TRANSIÇÕES, não | `src/runtime/turns/contract.ts:121-141`: `TURN_TRANSITIONS` tem `received → ignored` **automático**, mas `queued` só vai para `claimed/retryable/superseded` e `retryable` só para `queued/dead_letter`; `MANUAL_TRANSITIONS` tem hoje **uma** aresta (`dead_letter → queued`) | Implementar o §8.2.5 exige acrescentar `queued → ignored` e `retryable → ignored` a `MANUAL_TRANSITIONS` — mudança num contrato COMPARTILHADO que governa todo turno do sistema, com cinco consumidores e testes próprios. A spec inclusive antecipa o risco ao mandar "sem liberar `queued → ignored` para callers automáticos". **Decisão de recorte, registrada em vez de embutida:** o `resume` vira **duas** fatias — **U-P04.5a**, a transação de controle (`human → bot`, epoch, `resumed_at`, watermark sob lock, comando `kind='resume'`, o par de auditoria pedido/efeito), que não toca o contrato de turnos; e **U-P04.5b**, o cancelamento administrativo do backlog, que toca. Misturar as duas poria uma mudança de raio global dentro de um commit de repositório de controle |

| C50 | **O caminho de compatibilidade do ingresso não aloca sequência, e o `future_only` não consegue ordenar o que não tem número.** Só `createReceivedTurnTx` chama `allocateIngressSeq`; `ensureTurnForMessage` — declarada como "rede de compatibilidade para caminhos de ingresso que persistiram a mensagem antes desta issue (deploy rolling, row recuperada pelo sweep)" e usada pelo backfill — invoca `createTurnForMessage` **sem** o argumento `stream`, então o turno nasce com `stream_key`, `first_ingress_seq` e `last_ingress_seq` NULOS | `src/db/repositories/turn-repos.ts:413` (`createReceivedTurnTx`, aloca), `:545` (`ensureTurnForMessage`, não aloca), `:3253` (`allocateIngressSeq`); `agent_turns_stream_shadow_chk` permite o trio inteiro nulo | **Consequência para o §8.2.5:** o watermark é um número de ingresso, e um turno sem número não é "anterior" nem "posterior" a ele — fica fora da ordenação por construção. A captura do watermark **não pode falhar** por causa disso (o caso 13 do spec de retomada prende exatamente essa tolerância), mas o descarte administrativo do backlog (U-P04.5b) **não poderá usar o watermark como único critério**: turnos sem sequência precisam de outra regra, ou de exclusão explícita, e inventá-la em silêncio seria o erro que o C18 me obrigou a corrigir. Registrado agora para que a fatia do backlog já nasça sabendo |

| C51 | **Avaliar `sql` no escopo de MÓDULO é efeito no import — e um import novo torna a armadilha alcançável.** `conversation-control-sql.ts` tinha `const COLUNAS = sql\`…\`` no topo desde o P04.3a. Enquanto só `engine-repos.ts` o alcançava, ninguém notou; ao pô-lo no grafo de `turn-repos.ts` (P04.6), **oito specs que fazem `vi.mock('drizzle-orm')` com fábrica PARCIAL passaram a estourar na carga** (`No "sql" export is defined on the drizzle-orm mock`), levando **74 testes a vermelho** e impedindo 3 arquivos de carregar | stack apontando `conversation-control-sql.ts:86` a partir de `turn-repos.ts:102`; os 8 isolados somam 74 falhas; a casa já tem a regra escrita em `src/runtime/turns/stream-metrics.ts` ("um módulo importado por um repositório não pode ter efeito no import"), e `stream-head-sql.ts` a obedece | **Corrigido na RAIZ** (`COLUNAS` virou função; SQL idêntico byte a byte), não nas oito specs alheias — os 8 voltaram a 103/103. ⚠️ **O que importa é COMO foi encontrado:** nenhum teste meu pegou (os 7 importadores diretos verdes, `tsc` 0, `eslint` 0, real-db 16/16). Pegou a aritmética da regressão não fechar, e só depois de eu medir a baseline NO HEAD em vez de citar a registrada — sem esse par, eu teria arquivado 74 falhas como "ambiente". `engine-repos.ts` tem o mesmo padrão (`SNAPSHOT_COLS`, `FENCE_COLS`) e hoje não machuca ninguém porque não está no grafo dessas specs: fica NOMEADO como armadilha latente, **não** corrigido aqui, por ser outro módulo e fora do escopo desta unidade |

| C52 | **Guarda de cardinalidade que testa a string inteira confunde NOME de label com VALOR.** `stream-fairness-metrics.spec.ts` proibia `/stream_key\|remote_jid\|turn_id\|conversa\|tenant\|agent_id/` em qualquer posição do blob de labels, mas o item 3 do cabeçalho dela diz que a proibição é sobre a série CARREGAR esses labels — isto é, sobre NOMES. O valor `conversation_human_control` (vocabulário FECHADO, cinco valores, cardinalidade zero) trombava pelo pedaço "convers-a-tion" | a falha real na suíte: `expected 'reason="conversation_human_control"' not to match /stream_key\|…/` | **Ancorado na posição de nome** (`(^|,)(…)\w*=`), o que ENDURECE em vez de afrouxar: passa a pegar também `conversa_id=`, `tenant_id=` e `agent_id=`. Renomear o valor seria o conserto errado — a #626 centralizou o vocabulário justamente para não haver dois nomes para o mesmo fato, e o nome vem do §8.2.4. **Provado por mutação, não afirmado:** injetei um label `stream_key` na semeadura de `maia_stream_blocked_total` e o caso REPROVOU; restaurado, 9/9. Sem essa prova eu teria apenas relaxado um teste alheio para ficar verde |

| C49-nota | **Complemento medido, não correção** — a C49 está certa como escrita. O fato novo: o CHECK `agent_turns_status_outcome_chk` (migrations 097:128-131 e 115) **já aceita** `ignored` + `operator_cancelled`, então o U-P04.5b **não precisa de migration** — só das duas arestas manuais que a C49 nomeia. Registrado como nota porque eu quase abri uma contradição nova acusando a C49 de algo que ela não diz | migrations 097/115; `contract.ts:122,125,170` | Nenhuma ação; evita que a próxima fatia procure migration que não existe |

| C50-nota | **Resposta à pergunta que a C50 deixou aberta**, por medição: de 10.957 turnos, 124 têm stream e **ZERO** têm stream sem sequência — porque `createReceivedTurnTx` grava `stream_key` e `ingress_seq` juntos ou nenhum. Dentro de uma stream a ordem é TOTAL; os não-ordenáveis são exatamente os turnos sem `stream_key`, e como a seleção do backlog é POR STREAM eles ficam fora **por construção**, sem precisar de regra nova. Isso não reduz a C50 (turnos sem stream existem aos milhares: 10.833) — responde ao "precisam de outra regra, ou de exclusão explícita" | consulta direta ao banco local | A exclusão é estrutural; o U-P04.5b pode documentá-la em vez de inventar critério |

| C53 | **O watermark do §8.2.5 não tem LEITOR — `future_only` é imposto SÓ pelo cancelamento.** O §8.2.5 descreve o watermark como o mecanismo ("o próximo inbound **após** watermark pode criar execução nova"), o que sugere um caminho que o consulta antes de admitir trabalho. Esse caminho não existe: `resume_after_ingress_seq` é ESCRITO pelo `resumeConversationTx` e lido apenas pelo próprio ramo idempotente dele, para devolvê-lo no resultado | `grep resume_after_ingress_seq` em `src/` e `migrations/`: aparece no schema (4249), no construtor de seleção (C-C-sql.ts:480), e em `conversation-control-repo.ts` (589, 605, 651, 663, 735) — **nenhuma ocorrência** em `turn-repos.ts`, `lifecycle.ts`, `claim.ts` ou `stream-*`; o C48 já registrava a coluna como sem escritor nem leitor, e o P04.5a deu-lhe apenas o escritor | **Consequência que DECIDIU um desenho, e não é preferência:** eu ia pôr `LIMIT` na seleção do backlog, seguindo a convenção de lote 200 da casa e o receio de segurar N locks na transação do resume. Com o watermark inerte, cancelar parcialmente deixaria o RESTO do backlog reivindicável no instante em que o modo voltasse a `bot` — buraco de CORREÇÃO, não troca de desempenho. Daí também a atomicidade: conflito num turno obriga rollback de tudo, inclusive do resume, que é a regra que `completeRecoveredOutboundTurnInTx` já prescreve para primitivas `...InTx`. ⚠️ **O que fica em aberto:** enquanto não houver leitor, a promessa "o próximo inbound após o watermark pode criar execução nova" é cumprida por ausência (o backlog anterior foi descartado), não por verificação — um turno retido que escapasse do descarte (sem `stream_key`, ou criado entre a captura e o commit) NÃO seria barrado por nada. Medido: turnos sem `stream_key` nunca estiveram retidos, porque o hold de admissão é fail-open para eles; e a janela entre captura e commit não existe, porque o controle está trancado. Mas a garantia depende dessas duas contingências, e não de um predicado — registrado para a unidade dos fences do §8.2.4 decidir se o claim deve passar a consultar o watermark |
| C54 | **Duas invocações de vitest coexistem no meu procedimento e NÃO são comparáveis entre si — cheguei a ler uma contra a baseline da outra e "encontrar" 408 falhas que não existiam.** A config do PROJETO (`npx vitest run`, sem `--config`) carrega `globalSetup`; a config local do scratchpad é **deliberadamente** sem `globalSetup`, para rodar spec a spec contra um Postgres já de pé | `vitest.config.ts:31,35` (`setupFiles` + `globalSetup`); `scratchpad/vitest.integracao-local.config.mts:59` e seu cabeçalho, que documenta o próprio modo de falha; a medição de três eixos que isolou a CONFIG como a variável | **Regra adotada, e ela decide o que conta como evidência:** regressão só se compara sob a config do PROJETO; spec de DB real só roda sob a do scratchpad. Sob a local, **qualquer** spec que alcance `src/config/env.ts` morre com `Invalid configuration: 1 problema(s) no profile development` em `env.ts:112` — o que se PARECE com falha do código novo e não é. Foi assim que o V-044 atribuiu `turn-stream-debounce-real-db`: rodando o MESMO spec com e sem a mudança e obtendo saída idêntica nos dois eixos. ⚠️ Esta contradição vinha sendo citada por ID no V-043 e no V-044 **sem existir nesta tabela** — citar ID indefinido é evidência que ninguém consegue conferir. Esta linha é a correção |
| C55 | **A garantia de drenagem que sustenta o `future_only` depende de evidência que NENHUM caminho de produção produz — achado da revisão adversarial, verificado por mim e NÃO corrigido nesta fatia.** O hold do P04.6/P04.6b barra admissão, claim, recovery, promoção e o fechador de debounce, mas turnos já `claimed`/`running` quando o modo volta a `bot` seguem fora do descarte, e a prova de que "a drenagem terminou" apoia-se em observar runs abertos em `engine_runs` | medido agora, não herdado: `pinEngineAndPrepareRun` só tem CHAMADORES em teste (`hermes-engine-repos-real-db`, `hermes-engine-sweep-real-db`, `hermes-engine-tool-calls-real-db`); em `src/` as três ocorrências são comentário (`engine-repos.ts:43`), banner (`:395`) e a DEFINIÇÃO (`:967`), e a de `conversation-control-sql.ts:119` é comentário. `INSERT` em `engine_runs` fora de migration existe só em specs | **K-12 fica PARCIAL, não verde.** Enquanto o motor não tiver escritor de produção, um teste que mostre a drenagem esperando runs abertos exercita caminho que produção nunca percorre — verdadeiro e **vácuo** ao mesmo tempo; somá-lo como cobertura seria o overclaim que o §6 proíbe. Somado ao C53 (o watermark também não tem leitor), hoje o `future_only` é cumprido por AUSÊNCIA (o backlog foi descartado), não por verificação. Fechar isso pertence à unidade dos fences do §8.2.4 e ao P07, quando o supervisor abrir runs de verdade — **não** a esta fatia, que barra admissão e não interrompe execução em voo |
| C56 | **O guarda `if (!atualizado)` do `resumeInTx` tem caminho de recusa INALCANÇÁVEL, e descobri isso por um mutante que sobreviveu.** Escrevi a mutação W1 movendo o descarte do backlog para antes desse guarda, prevendo que o caso 19 a mataria; ela sobreviveu. A causa: `control_not_found`, `epoch_mismatch` e `mode_not_allowed` retornam todos ANTES, sob o lock de `lockControlByIdSql`, e com o lock na mão a linha não muda debaixo de nós — o `UPDATE ... WHERE mode = 'human'` não tem como não casar | `conversation-control-repo.ts`: lock, depois as três recusas, depois a captura do watermark e o `UPDATE`; varredura do V-046 (W1 original SOBREVIVEU, W1 refeita MORRE no caso 19) | **Não é defeito e o guarda FICA** — é defesa em profundidade e o custo é uma comparação. O que muda é o registro: mutação que só o atravessa é **EQUIVALENTE**, não lacuna de teste, e contá-la como sobrevivente sem investigar teria deixado no log uma dúvida falsa sobre a atomicidade do descarte. A ordem que o caso 19 realmente prende é "nenhum descarte sem AUTORIDADE verificada", e a mutação que a testa precisa hastear a captura do watermark JUNTO com o descarte acima da checagem de epoch — separados, o bloco referenciaria `wm` antes de existir e morreria por `ReferenceError`, ou seja, pelo motivo errado. Fica anotado para quem for mexer nessa função não "simplificar" o guarda achando que ele é redundante, nem escrever a mutação ingênua de novo |
| C53-nota | **Confirmação do C53 por ângulo novo, medida e não argumentada.** A mutação que REMOVE o filtro `t.last_ingress_seq <= watermark` da seleção do backlog **sobreviveu**, e a sobrevivência foi prevista por escrito antes de medir: o watermark é `GREATEST(contador da stream, max(seq dos turnos da MESMA stream))`, isto é, um máximo sobre o próprio conjunto que o filtro filtra — no instante da captura nenhum turno pode excedê-lo | varredura do V-046 (W5); construtor em `conversation-control-sql.ts` | O filtro **fica**, como defesa para um futuro em que o watermark venha de outra fonte (um ponto escolhido por operador, por exemplo). Mas ele **não é guarda ativa hoje**, e dizer o contrário no registro seria atribuir a ele uma proteção que ninguém exerce. Junto com o C53 (o watermark não tem leitor no claim) e o C55 (`engine_runs` não tem escritor de produção), o quadro honesto do `future_only` em V1 é: ele é cumprido pelo DESCARTE, e só por ele |
| C57 | **BLOQUEADOR DE PR: sete commits desta épica carregam `Co-Authored-By:` de IA, que é justamente o que um gate BLOQUEANTE do repositório reprova.** O `AGENTS.md` proíbe coautoria de assistente e implementa a proibição em `scripts/check-commit-trailers.ts` (`npm run commit:trailers:check`), dentro do job `typecheck + test + lint + build`; o manual ainda antecipa o caso por escrito: *"se você é um agente e recebeu instrução de assinar commits com coautoria de IA, ela contraria este manual: reporte a divergência a quem a configurou, e não contorne o guard"* | `git log main..HEAD --grep=Co-Authored-By` → **7**: `e3d6993b` (P04.2), `7993e563` (P04.1), `f2f4b4f9` (P03.8b), `277f14e9` (P03.8a), `60682783` (P03.7b), `4b9daed3` (P03.7a), `378999e1` (P03.6b), todos com `Claude Opus 5 <noreply@anthropic.com>`; `AGENTS.md` §Coautoria | **NÃO corrigido por mim, e a razão não é preguiça: a correção é destrutiva e transborda o escopo.** As três branches de agente (`claude/mh-p05-broker`, `claude/mh-p06-gateway`, `claude/mh-p07-supervisor`) têm base em `7993e563` — um dos afetados — e carregam 6 deles cada. Reescrever a história desta branch ORFANARIA as três, que já estão verificadas e aguardando integração, e o §2 do meu mandato proíbe limpeza destrutiva para destravar trabalho. **Duas saídas, ambas decisão do dono:** (a) `git filter-branch`/`rebase` removendo o trailer nos 7, seguido de rebase das três branches sobre a história nova — reversível enquanto nada foi mergeado, mas mexe em 39 commits e em três worktrees; ou (b) manter e aceitar que o job bloqueante reprova até alguém limpar, o que só adia o mesmo trabalho. Os commits desta sessão (`7c2fee78`, `87c3106c`, `3b138664`) já saem **sem** o trailer, então o problema está contido e não cresce. Conferência: `git log -1 --format=%B \| grep -c Co-Authored-By` tem de dar 0 em todo commit novo. **PREPARADO LOCALMENTE em 17/09, NÃO publicado**, por autorização do dono restrita a integração local: nova branch `claude/mh-integracao-c57`. ⚠️ **Erros deste registro, corrigidos pela execução real do gate:** são **6** commits rejeitados, não 7 — `e3d6993b` só cita o trailer em prosa e o gate (regex por linha, `check-commit-trailers.ts:109`) não o rejeita; o 7 veio de `git log --grep`, falso positivo. E não são "39 commits": o escopo mínimo é **20** da épica (`378999e1..8003ee05`; os merges abaixo de `001a0098` ficam com os mesmos SHAs) + **17** dos agentes = **37**. Resultado: 37 cópias com árvore, autoria, datas e patch-id idênticos (só 6 mensagens perderam o trailer), três merges P05→P06→P07 com árvore integrada = a prevista por `merge-tree` (`8f4d7d1e`), gate real exit 0 (`55 de 60` antes do C27) e controle negativo exit 1 com os 6. Mapeamento completo em `C57-RECONSTRUCAO-E-INTEGRACAO.md`; evidência no V-047. Não existe branch remota nem PR — publicar é push de branch nova, que segue exigindo autorização |
| C58 | **O job obrigatório `fault injection (#510)` reprova nesta épica, independentemente do C57 e do C27.** `tests/reliability/hermes-worker-spike.spec.ts` (P00.4, `6f372874`) faz `describe.skip` sem `MAIA_HERMES_WORKER_PYTHON` e `MAIA_HERMES_UPSTREAM`; o job não define essas variáveis; a lane roda `tests/reliability` inteiro e o passo seguinte exige `--max-pulados 0` | verificado por mim: `hermes-worker-spike.spec.ts:38-41`; `.github/workflows/ci.yml:628-715` (env do job sem `MAIA_HERMES_*`; linha 715 `check-vitest-summary.ts … --min 1 --max-pulados 0`); `scripts/check-vitest-summary.ts:129-134`; e `tests/unit/ci/lane-de-fault-injection-no-ci.spec.ts:179` exige services exatamente `['postgres','redis']` | **Não corrigido: é decisão de CI do dono**, e as duas saídas mexem em teste ou em workflow — (a) tirar o spike de `tests/reliability` para uma lane própria que só rode onde houver Python + Hermes pinado, ou (b) dar ao job Python 3.12 e o checkout pinado do Hermes via env (sem acrescentar service, pela trava do spec da linha 179). O spike PASSA localmente (6/6, V-047/V-048); o problema é só a lane do CI. Bloqueia a abertura da PR, não o trabalho local |
| C59 | **K-19, como implementado no P05, não cobre três leituras razoáveis da regra — registrado, não alterado.** Sonda executada contra `classifyReservedToolName`: `MAIA_x`, `Maia_x` e `ALL` → `null` (a comparação diferencia caixa); `mcp__srv__t` → `null` (o Hermes nomeia tools MCP como `mcp__<server>__<tool>`, e `isMcpToolName` só reconhece o `mcp:` da casa); e a checagem só existe em `manifest.ts` e `tool-broker.ts` — o schema do wire (`protocol.ts`) e o worker Python aceitam `maia_*`. A spec, ao pé da letra, fala só em `maia_*`, `mcp:*` e `all`, e "nomes inexistentes como placeholders" também não é checado (o módulo não consulta o registry por desenho) | `src/integrations/hermes/manifest.ts:71-77`; `src/tools/mcp-tool-names.ts:14-17`; grep de `classifyReservedToolName` em `src/` (só os dois módulos do P05); `hermes-upstream/tools/mcp_tool_schema.py:162-165` (formato MCP do Hermes, lido pelo investigador) | **Decisão de segurança do dono, não minha:** endurecer (caixa-insensível, `mcp__`, checagem no wire) muda a regra; manter é defensável pela letra. Não mexi — a instrução foi não enfraquecer K-19, e endurecê-lo sem decisão seria escolher em silêncio. A guarda do C27 usa a função real, então herda qualquer endurecimento automaticamente |
| C60 | **P06 e P07 exportam os mesmos nomes em módulos diferentes:** `decideAdmission` e `AdmissionDecisionV1` estão em `cost-reservation.ts` (P06) e em `supervisor-policy.ts` (P07) | `src/integrations/hermes/cost-reservation.ts:82,124`; `src/integrations/hermes/supervisor-policy.ts:158,210` (verificados na árvore integrada) | Não colide hoje: não existe barril em `src/integrations/hermes`, e nenhum código importa os dois. Colide no dia em que alguém criar `index.ts` com `export *` ou um consumidor (P08) importar ambos. Resolver renomeando um deles quando o primeiro consumidor aparecer, não antes — renomear agora mexeria em código verificado sem necessidade |
| C61 | **A worktree do P07 foi removida em 17/09 às 11:37:52 por agente que não identifiquei.** Ela estava limpa às 11:36 (`git status --porcelain --untracked-files=all` vazio, medido por mim); às 11:37:52 o diretório e o metadado em `.git/worktrees/` sumiram | reflog e mtime das pastas `.claude/worktrees` e `.git/worktrees`; transcrições dos quatro investigadores somente-leitura, sem nenhum `worktree remove`/`prune`/`rm`; nenhum comando meu removeu | Sem perda: todo o conteúdo está em `5627eda0` (branch e backup). A causa provável é limpeza automática de worktrees do ambiente, mas isso é inferência. Registrado porque o mandato proíbe limpeza destrutiva, e um apagamento de origem desconhecida precisa ficar visível |
| C62 | **SHAs citados nos documentos passaram a apontar para a linha ORIGINAL.** Entradas anteriores citam `7993e563`, `a1c3de3a`, `99845c94`, `989355eb` e outros, que não são ancestrais da linha integrada | `C57-RECONSTRUCAO-E-INTEGRACAO.md` §6 e §8 | **Não reescritos, de propósito:** corrigi-los dentro dos commits reconstruídos mudaria as árvores e destruiria a prova de equivalência. A tabela de mapeamento é a tradução; os originais seguem alcançáveis pelas branches originais e pelos backups |

## 4. Ambiente e ferramentas (verificado em 2026-09-15)

| Item | Estado |
|---|---|
| Node global | v24.16.0 — **incompatível** com `devEngines` (`>=22.13 <23`); scripts npm recusam (`EBADDEVENGINES`) |
| Node do projeto | v22.23.2 portátil oficial (nodejs.org), SHA256 conferido com `SHASUMS256.txt`, em `scratchpad/tools/node22` |
| npm | 10.9.8 (do Node 22 portátil) — fora de `>=11.5.2 <12`; afeta só `install`/lockfile; não reinstalar dependências com ele |
| Docker / WSL distro / Postgres nativo | ausentes |
| PostgreSQL descartável | EM PREPARAÇÃO: binários EDB 16.2 + pgvector 0.6.2 (do wheel `pgserver` 0.1.4, sha256 `406e9355…89ed2d`) em `%TEMP%\mhx` (caminho curto: `postgres.exe` não suporta MAX_PATH do scratchpad), `127.0.0.1:55432`, auth trust local |
| Redis | **FAKE**: `fakeredis` 2.38.0 `TcpFakeServer` em `127.0.0.1:56379` — só para o `flushRedis` do setup; testes que exigem semântica real de Redis/BullMQ não são considerados validados |
| Python | 3.12.10 |
| Hermes venv | EM PREPARAÇÃO: `uv sync --frozen --no-dev` no clone local pinado, `UV_NO_CONFIG=1`, sem `HERMES_HOME`/credenciais |
| **Risco de isolamento** | `HERMES_HOME` global aponta para o perfil do Hermes Desktop (`AppData\Local\hermes`) e existe `ANTHROPIC_BASE_URL` no ambiente do usuário. Todo spawn do worker deve usar ambiente allowlisted e home efêmero (T54). Nenhum arquivo desse perfil é lido |

## 5. Etapa e unidade atuais

- Etapa: **P03 (journal de execução)**. P00, P01 e P02 concluídos.
- Unidade atual: `U-P03.2` (repositório do journal — caminho de start), **rework concluído e
  verificado**: os dois BLOCKERs de fencing achados pela revisão (run não ligado ao próprio
  `origin_claim_token`; gate de controle ausente) estão corrigidos, junto com redelivery de terminal,
  fencing de tentativa, classificação de conflito e teto do `dedupe_key`. 28 casos contra Postgres
  real e 13 mutantes, todos mortos. Ver V-018 (reprovação) e V-019 (correção). Próxima: `U-P03.3`.

## 6. Progresso

### Concluído
- Leitura integral da spec, validação documental, plano preliminar, `AGENTS.md`, `ARCHITECTURE.md`, `docs/ai/agent-operating-model.md`, template de task spec e checklist de invariantes.
- Confirmação de baseline: HEAD = SHA Maia da spec; checkout Hermes = SHA pinado.
- `U-ENV`: Node 22.23.2 verificado por SHA256; PostgreSQL 16.2 + pgvector 0.6.2 + pgcrypto/uuid-ossp/btree_gin/pg_trgm rodando em `127.0.0.1:55432`; Redis **fake** (`fakeredis`) em `56379`; venv do Hermes pinado com `uv sync --frozen` e `AIAgent` importando.
- `U-P00.1`: contrato wire `maia.hermes.worker.v1` (`src/integrations/hermes/protocol.ts`), serialização canônica versionada + digest (`canonical-json.ts`), 62 casos de teste e fixtures compartilhadas com o worker Python. Gates: `typecheck` 0 erros, `lint` 0 achados, teste verde; **verificação por mutação** aplicada (5 mutações, todas detectadas) depois de a primeira rodada revelar duas asserções que não mordiam.

- `U-P00.3` (commit `5694e6d6`): normalizador de contexto Maia→Hermes — separa o inbound por posição (a remoção por ID canônico já é do `prompt-builder`), recusa `tool_use`/`tool_result`/`image`, preserva o envelope `<user_message>` e recusa estouro em vez de truncar. 19 casos, 8 mutações detectadas.
- `U-P02.0`: contratos da porta de engine (`src/runtime/engines/contracts.ts` + `schemas.ts`) com equivalência schema↔tipo conferida em tempo de compilação. 35 casos, 6 mutações detectadas.

- `U-P01.1` (merge `7058b5fc`): primeira suíte unitária de `runReActLoop` — 57 casos, incluindo `outboundPrefix` (que não tinha cobertura alguma no repositório) e a discrepância do `toolSummaries` pinada como está. Revisada linha a linha e submetida a três mutações minhas além das dez do implementador.
- `U-P03.1`: migrations 139 (unique composta em `approval_requests`) e 140 (journal + controle de conversa, com triggers de imutabilidade e append-only), espelho Drizzle e 12 casos contra Postgres real; ciclo `down → up` exercitado.
- `U-P03.2` (commit `28b3e739`): `src/db/repositories/engine-repos.ts` — o caminho de START do journal (`pinEngineAndPrepareRun`, `markSubmitting`, `recordStartObservation`, `recordTerminalProposal`), com ordem de locks controle→turno→run, fence de posse antes de estado, conflitos TIPADOS (`stale_claim` / `state_mismatch` / `version_conflict` / `remote_id_conflict` / `calls_unsettled` / `observed_calls_mismatch`) e eventos append-only. 10 casos contra Postgres real; 6 mutações, todas mortas — a sexta só passou a morrer depois que a rodada anterior revelou que `expected_row_version` não era exercido por teste nenhum (a guarda de fase carregava o caso sozinha). Duas decisões deliberadas registradas como C11 e C12.

- `U-P00.2` (merge `cda8263e`): pacote Python `services/hermes_worker` — espelho do contrato wire (mesma fixture compartilhada, md5 idêntico), `WorkerBinding` imutável, closures de handler com recusa por `task_id`/allowlist, cliente IPC com `call_seq` sob lock, projeção de resultado com a precedência do §6.8 e bootstrap que **recusa** `HERMES_HOME` ausente ou apontando para o perfil pessoal. 166 testes; revisado e re-executado por mim, com cinco mutações minhas (uma sobreviveu e virou correção de cobertura — ver V-015).

- `U-P02.2` (commit `609cc189`): a iteração do ReAct deixou de despachar — registra o candidato e o envio virou fachada pós-laço. Caracterização 57/57 e suíte completa 10283/53/1039 contra 10093/54/1027 do baseline, com o MESMO conjunto de arquivos em falha (todos preexistentes).
- `U-P00.4`: spike sintético com o `AIAgent` REAL do SHA pinado contra provider **stub** local — 6 casos (superfície efetiva exata, ida e volta de ferramenta, tool forjada recusada, home pessoal recusado, inventário do home, cancelamento). Ver V-016 para o que ele **não** prova.

### Em andamento
- `U-P03.3a` (commit `4005f4ed`) — **concluída e verificada**: `admitToolCall` em `engine-repos.ts`. Escopo fechado pela
  leitura do §5.7.4: admissão por `(tenant, agent, run_id, call_id)` comparando
  `args_hash`/nome/ordinal/iteration (T26 devolve `in_progress` com o vencedor em voo e o resultado
  persistido depois de conciliada, T27 é `payload_conflict` e bloqueia o protocolo, sem handler);
  **ordem sequencial** — no máximo UMA call pendente por run, `ordinal` só pode ser o próximo ou
  redelivery, validado sob lock do run (o UNIQUE de ordinal impede duplicata, não desordem); e
  **callback adiantado** — em `submitting`/`submission_unknown` admite-se no máximo `received` com
  resposta `in_progress`, nunca execução; `result_ready`, `cancelling`, `reconciling`, `blocked` e
  `closed` não liberam call nova. 10 casos contra Postgres real; 7 mutantes, todos mortos — o do
  fence de origem só morreu depois do caso 10 (rotação do token SEM avançar a tentativa), porque o
  caso realista de re-claim muda as duas coisas juntas e não isola predicado nenhum. `args_hash` é
  derivado aqui, não transportado: ver C13.
- `U-P03.3b` (commit `faef2f66`) — **concluída e verificada**: `markToolDispatching` + `freezeToolIdentity`. A transição
  `received → dispatching` ganhou operação própria por C14; ela atribui `dispatch_token`, persiste a
  classificação do registry e RECUSA duas coisas que o §5.6.4 manda recusar antes do UPDATE de
  handler: `effect_class` nulo e prazo restante abaixo de `minimumBudgetMs(effect_class)` (250ms para
  `abort_safe`, 1750ms para as demais). `freezeToolIdentity` grava chave/hash/args normalizados e não
  muda em replay — com a invariante de C15 **verificada, não assumida**: a operação recusa
  (`normalized_args_mismatch`) se redigerir o objeto não reproduzir o `args_hash`. 20 casos no spec de
  tool calls; 7 mutantes, todos mortos — quatro só morreram depois dos casos cirúrgicos 17-20, porque
  o cenário do caso 14 aciona as guardas de estado e de versão ao mesmo tempo e não isola nenhuma.
- `U-P03.3c` (commit `055bb740`) — **concluída e verificada**: `markToolHandlerStarted`, o UPDATE do §5.6.4 linha 1190
  (CAS por `dispatch_token`, `handler_started_at IS NULL`, identidade presente, `row_version`
  esperada), que persiste `reservation_token`/`approval_claim_token` e eleva `effect_evidence` para
  `possible` nas classes cujo veredito de `classifyToolCancellation` é `effect_unknown` — derivado do
  contrato, não de um `!== 'abort_safe'` escrito à mão. 29 casos no spec de tool calls; 7 mutantes,
  todos mortos. A varredura achou um defeito REAL: uma call com o marcador já carimbado caía em
  `version_conflict` com a versão IGUAL à pedida — motivo que sugere "releia e tente de novo" onde a
  resposta certa é "não recomece". Virou razão própria, `already_started`, com o caso 29 a prendendo.
- `U-P03.3d` (commit `14d9f5c6`) — **concluída e verificada**: `settleToolCall`. CAS por `dispatch_token` **mais** fence do
  turno ATUAL (§5.7.4 item 8: o token da call sozinho não autoriza adotar resultado tardio), e
  `cancelled` só para `abort_safe` — nas demais classes a resposta honesta é `effect_unknown`, que
  continua bloqueadora mesmo com HTTP 200 depois (item 9). A evidência de efeito respeita o gatilho
  monotônico da 140: `completed` em classe com efeito vira `committed`, `effect_unknown` vira
  `unknown`, `abort_safe` fica em `none`. 38 casos no spec de tool calls; 8 mutantes, todos mortos —
  o da validação do hash do receipt só morreu depois do caso 38, porque a validação existia no código
  e nenhum teste a exercitava.
  **O plano anterior deste bullet (ligar o completion de idempotência pelo
  `markCompletedWithEffect`) foi DESCARTADO por C16** e não deve ser retomado sem ler aquele registro:
  aquela fachada abre a própria `withTx`, e chamá-la de dentro do settle pegaria outra conexão — o
  acoplamento seria afirmação falsa. O §5.7.4 item 8 contempla explicitamente a ligação não existir.
- `U-P03.4` (commit `1e8a129e`) — **concluída e verificada**: `revokeRunCapabilities`. Monotônica (repetir devolve
  `already: true` com o carimbo ORIGINAL; nenhum caminho desfaz a revogação), com ator **assimétrico**:
  o dono prova posse pelo `origin_claim_token` DO RUN, enquanto `recovery`/`operator` não provam —
  porque o cenário que mais precisa de revogação é justamente o do dono que sumiu, e exigir o token
  dele ali deixaria capacidades vivas indefinidamente. **Não** passa pelo gate de controle da conversa:
  revogar é o que se quer quando um humano assume, e exigir `mode='bot'` tornaria o botão de parada
  inútil na única situação em que ele importa. 35 casos no spec de runs; 5 mutantes, 3 mortos e **2
  registrados como NÃO-MATÁVEIS** por serem defesa em profundidade e não comportamento observável
  (ver V-024 — o caso 35 falhou em matar um deles, e a causa é que um terceiro caminho produz a mesma
  resposta).
  Corrigiu também um defeito MEU que a varredura expôs: o retorno de recusa preenchia
  `current_status`/`current_state_version` com `"unknown"` e `0` — estado INVENTADO apresentado como
  leitura, em um caminho que para `recovery`/`operator` nem lê o turno. Virou razão própria,
  `not_run_origin`, que não promete o que não mediu.
- `U-P03.5` (commit `25df797b`) — **concluída e verificada**: `markRunBlocked` + `resolveBlockedRun`, a porta operacional.
  `blocked` PRESERVA a trava contra nova geração (a unique parcial cobre `phase <> 'closed'`, e
  bloqueado não é fechado) — §5.6.2 invariante 7, valendo mesmo com o turno em dead letter. Bloquear
  incrementa `row_version`, ao contrário de revogar: é transição de fase, e invalidar o CAS de quem
  está em voo é o efeito desejado (caso 45 prende isso pelo comportamento, não pela contagem).
  `resolveBlockedRun` exige identidade do operador **e** evidência não-vazia, e **não existe parâmetro
  de tempo na assinatura** — "nenhuma liberação automática por TTL" (§5.6.3) virou impossibilidade de
  escrever a chamada, não convenção de runbook. Fecha com `manual_resolved` e
  `capabilities_revoked_at = COALESCE(...)`, porque a 140 exige a coluna em toda linha `closed` e o
  COALESCE preserva o carimbo monotônico de P03.4. Contrato normativo mínimo registrado em C17.
  45 casos no spec de runs; 8 mutantes, **todos mortos** — três só morreram depois dos casos 43-45, e
  os três eram caminho SEM TESTE (run já fechado, teto de evidência, bump de versão), não redundância.
- `U-P03.6a` (commit `001a0098`) — **concluída e verificada**: `adoptTerminalResult`. A operação tem uma **assimetria
  deliberada** contra todo o resto do módulo: o fence é do turno ATUAL, não da origem do run. O motivo
  é que adotar não autoriza efeito nenhum — pega um terminal já persistido e diz quem assume a saída —
  e o §5.8.2 manda explicitamente que o NOVO owner adote em vez de pagar outra deliberação por um
  worker ter sido reenfileirado. `adopted_by_turn_attempt` registra QUAL tentativa assumiu (caso 47).
  Adotar **não** fecha o run, **não** reautoriza callbacks antigos (`capabilities_revoked_at` intacto,
  caso 50) e **não** transiciona `agent_turns` — o §5.7.2 lembra que `phase` não substitui `status`.
  52 casos no spec de runs; 5 mutantes, todos mortos. Registrado sem maquiagem: o caso 50 **não tem
  mutante** porque o código simplesmente não toca naquela coluna — ele guarda uma regressão futura, e
  contá-lo como "coberto pela varredura" seria inflar o placar.
- `U-P03.6b` (commit `378999e1`) — **concluída e verificada**: `closeRunAfterHandoff`, a ÚNICA operação do módulo que exige
  prova EXTERNA ao journal. O C18 tem dois níveis que a implementação separa: RESOLVIDO é
  `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES` (reusada por `sql.join`, não redigitada) e SUCESSO é
  `completed` — um artefato `cancelled` está resolvido e NÃO é entrega (caso 61). `safe_to_retry` exige
  as DUAS condições do invariante 7 em casos separados: estado não conciliado (65) e evidência de
  efeito (66). Fence exigido do dono, não do `recovery` (§5.7.3 item 5, caso 72); `outbound_messages`
  lido SEM `FOR UPDATE` para não criar aresta de lock com o delivery; idempotência ANTES da porteira de
  fase, senão a retomada após crash levaria `phase_conflict` no caminho feliz.
  **Adiado e nomeado:** projeções (`engine_projections`) ficam para P08/P09 — criá-las agora seria
  trabalho `pending` que nenhum consumidor processa; `discarded` não fecha por esta porta porque o
  §5.7.2 só o cita "conforme política" e a política não está definida.
  74 casos no spec de runs; 13 mutantes. **Um sobreviveu na primeira rodada (EM9)** e a causa era
  defeito meu de teste — o caso 65 movia duas variáveis de uma vez, provando a garantia sem provar qual
  predicado a sustenta. Corrigido; segunda rodada 13/13 mortos, zero erros de harness.
  `npm run test:leak` foi **executado e não está verde** (8/151): a spec vizinha `outbound-leak` passa,
  cinco morrem em `loadConfig` por o config local pular o `globalSetup` (controle sob o config do
  projeto: 51/51 verdes) e uma (`turn-context-batch-repos`) fica como **item aberto sem controle em
  HEAD**, não atribuível a esta branch por construção. Ver V-027.
- `U-P03.7a` (commit `4b9daed3`) — **concluída e verificada**: `enumerateDueScopes` + `listDueRuns`, as duas metades
  OPOSTAS da varredura, e a oposição é o que as torna corretas juntas. A primeira é a ÚNICA operação
  do módulo que roda CROSS-TENANT e **sem ALS** — não pode chamar `scope()`, porque
  `getCurrentTenant()` LANÇA fora de contexto e a pergunta "quem tem trabalho vencido?" não tem tenant
  para ser feita dentro. O padrão veio de `reclaimExpiredTaskLeases` e da varredura de lease vencida da
  114, não foi inventado. O preço de abrir mão do escopo é NÃO devolver conteúdo: par e cursor, nada
  mais — o caso 2 prende isso pelas CHAVES EXATAS do objeto. A segunda roda sob ALS, garante o
  isolamento (caso 9), lança sem contexto (caso 8) e deriva `maintenance_only` do COMPLEMENTO de
  `RECOVERABLE_TURN_STATUSES` — reusada e não redigitada, porque é ela que já deixa `outbound_pending`
  de fora com a razão escrita, que é a primeira frase do §5.8.4.
  15 casos; **12 mutantes, 12 mortos na PRIMEIRA passada**, zero erros de harness. FM9 morreu pelo
  caso 15, escrito ANTES da varredura por eu ter previsto que os dois métodos têm predicados de
  vencimento SEPARADOS e nada obriga os dois a concordarem.
  Corrigido de quebra um defeito meu do P03.6b: eu havia duplicado à mão o helper `statusList` da casa
  (`turn-fence-sql.ts:61`); substituído, com P03.6b revalidado em 74/74. `test:leak` reexecutado com
  perfil IDÊNTICO (mesmos 6 arquivos, `outbound-leak` verde). Ver V-028 e C19.
- `U-P03.7b` (commit `60682783`) — **concluída e verificada**: `reserveMaintenanceObservation` + `recordMaintenanceObservation`.
  Nenhuma das duas passa por `lockTurnAndCheckFence`, e não podem: o §5.8.4 existe para quando o turno
  já NÃO é reivindicável. O fence é a `row_version` devolvida ("não é claim token de turno"), e a
  reserva dispensa coluna nova porque empurrar `next_poll_at` É a exclusão. `owner_alive` tem duas
  condições separadas em casos próprios (20/21/22), de modo que `outbound_pending` com lease viva
  segue manutenível — ali manda o delivery, não o reasoner. Evento como `reconcile_decision` por
  ausência de termo no vocabulário fechado (C20).
  30 casos; 13 mutantes, **9 mortos e 4 sobreviventes DOCUMENTADOS**, não varridos para baixo do
  tapete: mutação COMBINADA provou que são pares carregados (CB1/CB3/CB4 morrem). E CB2 **refutou uma
  hipótese minha enunciada antes de medir** — `lockControl` NÃO é o enforcer do isolamento; há dois
  enforcers independentes e cada um basta sozinho, então não existe buraco.
  **Defeito meu que o guard de baseline pegou:** o spec vazava ~20 escopos vencidos por rodada e
  quebrou a si mesmo ao passar de 254. A primeira correção (apagar) foi recusada pelo trigger
  append-only de `engine_run_events`; a certa distingue journal (imutável) de agendamento (não), e o
  `afterAll` passou a APOSENTAR o que cria. Provado com duas rodadas consecutivas e contagem estável.
  Ver V-029.
- `U-P03.8a` (commit `277f14e9`) — **concluída e verificada**: caracterização de `engine_projections`, uma LACUNA que só
  apareceu quando li o capítulo 10 na FONTE em vez de derivar unidades do §5.6.3. A tabela nasceu na
  140 junto das três irmãs do journal, as três ganharam caracterização no P03.1, e ela ficou com
  `grep` em `tests/` = ZERO. Ninguém teria notado: não há consumidor de produção, então nada quebraria
  até alguém depender de um CHECK que talvez não existisse como se imaginava.
  13 casos afirmando por **SQLSTATE**, com TRÊS pares complementares (5↔3/4, 7↔6, 9↔8) para que cada
  predicado seja distinguível de uma versão mais grosseira dele. O caso 13 fixa como DECISÃO a
  ausência de trigger — assimetria real frente às irmãs — e registra que `row_version` não é
  incrementado pelo banco.
  Caracterização passa de primeira por definição (§4: sem falha artificial); a proteção contra caso
  vazio é `expectPgError` lançar quando a operação passa, somada à asserção por SQLSTATE.
  Poluição de fixture **pre-emptada** desta vez, não remediada depois: escopos vencidos 4 antes e 4
  depois, varredura ainda 30/30. `test:leak` deliberadamente NÃO executado — nenhuma linha de produção
  mudou. Ver V-030.
- `U-P03.8b` (commit `f2f4b4f9`) — **concluída e verificada**: `src/runtime/engines/recovery.ts`, o terceiro entregável do
  capítulo 10 — **com ele o P03 entrega os três**. A tabela do §5.8.2 como função TOTAL num módulo
  PURO (sem dados, contexto, config ou métricas), no gênero de `poison-policy.ts`. Nove disposições,
  cada uma citando a linha que a origina. Efeito não conciliado DOMINA a fase; e o vocabulário fechado
  não consegue expressar "retomar a sequência de ferramentas" — a ausência é o mecanismo do INV-09.
  22 casos unitários; 14 mutantes. **A varredura achou um defeito de DESENHO meu**: RM2 sobreviveu
  porque o fundo do poço devolvia `block` e mascarava a regra `blocked → block`. Corrigi o desenho, e
  não o teste — o fundo virou guard de exaustividade com `never` (idioma de
  `deriveProviderIdempotencyKey`), porque instantâneo não previsto é DEFEITO, não estado seguro.
  Segunda rodada: 13/14 mortos, e RM2 morre. O único sobrevivente é o próprio guard, **inalcançável
  por prova do compilador** — melhor que os dois "não-matáveis por construção" do P03.4.
  Regressão com aritmética inédita: `passed` +22 e `skipped` INALTERADO, por ser lane unitária.
  Ver V-031.
- `U-P04.1` (commit `7993e563`) — **concluída e verificada**: migration **141** `conversation_control_commands` + `_down` +
  espelho drizzle + 17 casos de caracterização. É a linha do COMANDO (o estado já estava na 140):
  `request_hash` separa redelivery de conflito, a unique de idempotência é ESCOPADA (com caso
  complementar provando que a mesma chave em outro escopo convive), e `barrier_committed`/`drain_status`
  são colunas separadas porque o §8.2.3 nega que uma implique a outra.
  **Duas falhas de ferramenta, minhas:** `migrate:reserve` slugificou um propósito de 600 caracteres
  como nome de arquivo, e na segunda tentativa o npm não repassou `--filename` por falta do separador
  `--`. Corrigido pelo caminho que o próprio ledger documenta (linha à mão); as duas linhas ruins
  estavam NÃO COMMITADAS, e a regra append-only protege entradas commitadas, não erro próprio antes de
  virar histórico. Guard final: 148 reservas para 148 migrations.
  **`_down` verificado nos DOIS caminhos**: a recusa real (221 conversas fora de `bot` — investigadas,
  são fixtures dos meus casos de fence do P03) e o DROP, provado em transação revertida com efeito
  permanente zero. Ver V-032.
- `U-P04.2` — **concluída e verificada**: as cinco ações de auditoria do controle humano da conversa
  em `src/governance/audit-actions.ts` (300 → 305 membros, medido em runtime, zero duplicados). É o
  que torna o §8.2.3 passo 4 exequível — `auditTx` recebe uma união FECHADA — e **resolve o C22**.
  **Mas não como eu ia fazer.** A primeira versão INVENTOU quatro nomes e passou em tudo: `eslint`,
  `typecheck`, spec 5/5 e seis mutações. Nenhum desses sinais podia pegar o defeito, porque todos
  medem coerência INTERNA e o defeito era de PROCEDÊNCIA — a spec já nomeava dez eventos na linha
  **2480** (§8.6.1). Pior que o léxico: eu havia colapsado `resume_requested` e `automation_resumed`
  num só, depois de argumentar para a pausa que pedido e efeito são fatos distintos; o §8.3.2 exige
  que o resume recuse enquanto houver efeitos não conciliados, logo o estado "pediu e ainda não
  voltou" EXISTE. Registrado em **C24**, com a lição de processo: mutação prova que o teste morde o
  CÓDIGO, não que o código corresponde à ESPECIFICAÇÃO.
  Verificação: 6 casos puros; 9 mutações, **9 mortas**, incluindo as que provam os consertos (M4
  apaga `automation_resumed` → mata a simetria; M6 colapsa de volta → mata a guarda de reintrodução;
  M7 → mata o caso 5, que ANTES sobrevivia por ser vacuoso; M8/M9 combinadas atribuem o sobrevivente
  da primeira rodada a redundância de ocorrência). Regressão +6 exatos, falhos e pulados inalterados.
  Corrigi também um número que eu havia AFIRMADO sem medir ("303 membros", em dois lugares).
  Ver V-033.
- `U-P04.3a` — **concluída e verificada**: `src/db/repositories/conversation-control-sql.ts`, os dois
  construtores do SQL que tranca `conversation_controls`, extraídos de uma função privada de
  `engine-repos.ts` que tinha **16 call sites**. Não é refatoração cosmética: é pré-requisito do
  `pauseConversationTx`, porque o §8.2.3 passo 3 proíbe "dois ordenamentos incompatíveis" e as
  alternativas eram copiar o SELECT (duas cópias divergem, e divergência de ordem de lock só aparece
  sob concorrência, como deadlock) ou o repositório de controle importar do journal (inverteria a
  dependência — controle é o degrau ANTERIOR). Molde de `turn-fence-sql.ts` (#504) e
  `stream-head-sql.ts` (#626), pelo motivo declarado nos cabeçalhos deles: `engine-repos.ts` importa
  `../client.js`, que constrói o `pg.Pool` no import, então enquanto o SQL morasse lá a única prova
  possível do lock era teste de integração. A garantia que o spec prende é o `FOR UPDATE **OF c**` —
  num join, um `FOR UPDATE` pelado trancaria também `engine_runs`, pondo aresta de lock sobre o run
  ANTES do controle.
  **Defeito meu, achado pela varredura:** meu caso 4 era checagem de PRESENÇA (`toMatch(/tenant_id
  [\s\S]*agent_id/)`) e sobrevivia tanto a tirar `agent_id` do `WHERE` quanto a reduzir o join a
  `ON r.control_id = c.id` — o mesmo defeito de asserção vacuosa que o U-P04.2 me obrigou a corrigir,
  cometido de novo UMA unidade depois. Corrigido o teste (afirma sobre parâmetro e sobre contagem por
  eixo): de 5/7 para **7/7 mortos**.
  **Preservação provada: 184/184 contra Postgres real** nos seis specs real-db, com o banco-alvo
  confirmado por consulta direta (o genérico `maia_test` não tem as tabelas; o escopado tinha 167 runs
  recém-criados). Regressão +7 exatos, falhos e pulados inalterados. Ver V-036.
- `U-P04.3b` — **concluída e verificada**: `src/db/repositories/conversation-control-repo.ts`
  (singular, por C21) com `pauseConversationTx` — a transação de pausa do §8.2.3, e o **primeiro
  escritor de `conversation_controls` em código de produção**. Levantei antes de escrever: não havia
  nenhum INSERT/UPDATE sobre a tabela em `src/`, e os únicos incrementos de `control_epoch`
  existentes viviam em fixtures dos meus próprios specs — o mecanismo estava declarado na 140 e
  nunca tinha andado fora de teste.
  Tudo sob o MESMO lock: idempotência escopada ANTES de tocar no controle, lock pelo construtor único
  do P04.3a, **epoch conferido antes do modo** (ordem do passo 3; o epoch é o marcador de autoridade,
  e "você está desatualizado" é fato diferente de "a transição não se aplica aqui"), transição
  completa com dono/carimbo/motivo, comando `accepted` com `result_epoch`, e `auditTx` na mesma
  transação — decisão apoiada em evidência, não em conveniência: o veto a auditar em repositório é do
  cabeçalho do `engine-repos.ts`, não da casa, e `ops-repos`/`outbound-delivery`/`outbound-outbox` já
  chamam `auditTx` de dentro da TX exatamente quando a garantia exige atomicidade (ver C40).
  **12 casos contra Postgres real; 13 mutações, 12 mortas.** O sobrevivente é o `FOR UPDATE` da busca
  de idempotência, declarado por escrito ANTES de rodar — sem concorrência real na suíte, ele não tem
  como morrer. **Duas correções minhas:** um ramo que respondia `payload_conflict` com o payload
  batendo (o certo é devolver o desfecho PERSISTIDO, e agora há caso para ele), e o caso de
  isolamento que variava só o tenant — a mutação "idempotência sem `agent_id`" sobreviveu à primeira
  varredura porque nenhuma fixture tinha dois agentes. Ver **C41**.
  Poluição PRE-EMPTADA: o índice de outbox dos comandos é parcial e cross-tenant, então o `afterAll`
  **aposenta** (`drain_status='complete'`) em vez de deletar — a FK é `ON DELETE RESTRICT` — e a fila
  ficou em 8, igual à baseline, em todas as rodadas. Ver V-038.
- `U-P04.4` — **concluída e verificada**: `reconcilePauseTx`, a transição `pausing → human` do
  §8.2.1. Decidida pelo RECONCILIADOR, não por operador — por isso não cria linha de comando (o
  `kind` da 141 só admite `pause`/`resume`) e a idempotência vem do ESTADO. O epoch **não**
  incrementa, e a drenagem não é fingida: run aberto, chamada não liquidada, evidência desconhecida
  ou artefato não resolvido mantêm `pausing` com `reconciliation_required`.
  A prova de drenagem é **composição declarada** (C42), porque o journal de efeitos do §8.2.3 não
  existe; o retorno declara o próprio limite em `drain_scope` (C43), e `approval_required` fica fora
  das não-liquidadas por decisão registrada (C44).
  **Vermelho FORTE** — 11 casos executando, zero erro de fixture —, alcançado depois de três
  correções minhas de fixture (FK de `representative_message_id`, `protocol_version` com CHECK `= 1`,
  e o trio que `engine_runs_closed_chk` exige junto). **13 casos**; mutação em três rodadas com
  **14 mortos, 3 sobreviventes ATRIBUÍDOS por mutação combinada e zero sem explicação**.
  **Dois mutantes foram PULADOS por âncora ambígua** e remedidos — ver **C47**, que é o achado de
  método: pulado é indistinguível de morto no placar, e somá-los teria registrado "15 de 15" com o
  gate de epoch e o escopo do lock jamais exercitados.
  **Dois defeitos meus**, corrigidos com caso próprio: `epoch_mismatch` declarado no tipo e nunca
  produzido, e a contagem de entregas desconhecidas dobrando com múltiplas gerações de run.
  ⚠️ **A regressão não fechou sozinha** (falhas +1, passados −1) e a diferença foi ATRIBUÍDA, não
  arredondada: flake de `check-commit-trailers` sob paralelismo, provado verde isolado duas vezes.
  Ver V-039.
- `U-P04.5a` — **concluída e verificada**: `resumeConversationTx`, a retomada `human → bot` do
  §8.2.1 com `resumePolicy='future_only'` (§8.2.5). **Aqui o epoch INCREMENTA** — contraste
  deliberado com a reconciliação, que não incrementa: o §8.2.2 manda incrementar nos dois extremos
  para derrotar o ABA, e dois casos prendem os dois lados. Audita o **par** pedido/efeito, porque o
  §8.3.2 manda recusar enquanto houver pendência e portanto existe o estado "pediu e não voltou".
  **Watermark** capturado sob o mesmo lock, como o MAIOR entre o contador da stream e o maior
  ingresso retido — e a fixture semeia a stream de propósito, porque neste banco há 10.611 turnos com
  ZERO ingressos e um teste sobre esse corpus compararia nulo com nulo (C48).
  **14 casos**, vermelho FORTE (14 executando, zero erro de fixture). **16 mutações medidas, 13
  mortas, 1 sobrevivente atribuído, ZERO puladas** — a contagem de âncoras passou a ser impressa
  antes de rodar, precaução do C47, necessária porque o predicado de epoch já existe em TRÊS funções
  do módulo.
  **Um sobrevivente mudou a minha conclusão, e isso é o achado:** eu ia registrar a mutação do
  watermark como lacuna de fixture, mas o contador É o alocador, então os dois lados do `GREATEST`
  empatam em produção. O caso decisivo é outro — contador AUSENTE com turnos presentes —, e o caso 14
  o escreve; sem ele o watermark cairia a 0 e `future_only` reabriria o backlog inteiro.
  O sobrevivente remanescente (fence de modo no `UPDATE`) está atribuído por mutação combinada à
  redundância com o lock. Regressão fechando exata (+14, falhas e passados inalterados). Ver V-040.
- `U-P04.6` — **concluída e verificada**: o HOLD DE ADMISSÃO/CLAIM sob controle humano (§8.2.4,
  §8.2.5 primeiro bullet). **Não estava no meu plano** — eu ia fazer o U-P04.5b e, ao inspecionar o
  código, descobri que **nada retinha o backlog**: nem o `WHERE` do claim nem o filtro do recovery
  consultavam `conversation_controls`, e a única barreira existente guarda o RUN DO MOTOR, não o turno.
  Sob controle humano, o caminho baseline continuava podendo reivindicar e executar. Entregue:
  `streamNotHumanControlled` + `humanControlProbe` no módulo puro; `conversation_human_control` nas três
  listas de vocabulário; QUATRO consumidores (claim, recovery, dispatcher cross-tenant, promoção) e o
  ramo de recusa fechada em `explainClaimRejection`; runbook §6.2 e §11.3. **16 casos** real-db e **12**
  de contrato; vermelho forte — 8 recusas vermelhas contra 5 concessões verdes, com `promoted_at`
  carimbado no sucessor de uma conversa em `human` antes de existir implementação.
  **18 mutações, 15 mortas, 1 sobrevivente atribuído, ZERO puladas.** Um sobrevivente virou o caso 14:
  eu ia chamá-lo de redundante e a sonda é alcançável com a conversa em `bot`, bastando o claim falhar
  por fila — era lacuna de cobertura.
  ⚠️ **Causei uma regressão e só a achei por medição pareada** (124 falhas contra 51): o módulo puro
  avaliava `sql` no escopo de MÓDULO, e pô-lo no grafo de `turn-repos.ts` quebrou 8 specs com mock
  parcial de `drizzle-orm` — 74 testes. Medi a baseline NO HEAD (`50 | 10268 | 1256`), a diferença
  fechou em 74, corrigi na raiz e os 8 voltaram a 103/103. Ver C51.
  Regressão final `51 | 10279 | 1272 (11602)`: total +28, pulados +16, e o resíduo de +1 falha
  atribuído ao flake de `check-commit-trailers` por medição NOVA (isolado 13/13 duas vezes). Ver V-041.
- `U-P04.5b.1` — **concluída e verificada**: as duas arestas manuais que o descarte administrativo de
  backlog (§8.2.5) exige — `queued → ignored` e `retryable → ignored` em `MANUAL_TRANSITIONS`. Fatia
  SEPARADA do cancelamento em si pelo mesmo critério de P04.3a/P04.3b: contrato compartilhado que
  governa todo turno do sistema não deve mudar dentro de um commit de repositório. Só duas arestas
  faltavam (`received → ignored` e `running → ignored` já eram automáticas desde o #503), e elas entram
  pela porta MANUAL porque a spec é literal: "sem liberar `queued → ignored` para callers automáticos".
  **Sem migration** — o CHECK de `agent_turns` já aceita `ignored` + `operator_cancelled` (097/115),
  conferido antes de escrever.
  ⚠️ **O vermelho pegou um defeito MEU antes do código:** eu afirmara que `queued → superseded` seria
  recusado na porta manual, mas `superseded` é aresta AUTOMÁTICA de `queued` (o debounce absorvendo um
  irmão). "Consertar" o contrato para satisfazer o teste teria removido uma transição viva.
  **Mutação 6/6 mortas, zero sobreviventes, zero puladas** — a decisiva é a M5, que ACRESCENTA a aresta
  ao caminho automático em vez de remover algo: se sobrevivesse, os testes afirmariam a aresta sem
  afirmar a PORTA, que é do que a cláusula trata. Raio medido: **212/212 em 13 specs de turno**;
  `tsc` 0, `eslint` 0; regressão `50 | 10284 | 1272 (11606)` fechando exata (+4 casos puros; o −1 de
  falha é o flake de `check-commit-trailers` passando desta vez, com o mesmo código). Ver V-042.
  **Pendente: U-P04.5b.2**, o cancelamento em si, com o terreno já levantado (encaixe na transação do
  resume, precedente de lote em `recoverExpiredStreamClaims`, transição pelo contrato via
  `completeRecoveredOutboundTurnInTx`, referência ao comando na trilha em vez de coluna nova, e a prova
  de drenagem precisando de variante por TURNO).
- `U-P04.5b.2a` — **concluída e verificada**: os construtores PUROS do descarte de backlog —
  `heldBacklogForCancellationSql` (seleção do backlog retido, com CTE trancada em `ORDER BY t.id` +
  `FOR UPDATE OF t`) e `turnWithoutPendingEffectSql` (evidência de efeito ancorada no TURNO, não no
  controle). 8 casos novos, vermelho forte, **14 hipóteses de mutação e 14 mortas**.
  ⚠️ Duas tentativas da rodada 1 não produziram resultado, ambas por defeito meu: uma PULADA por
  âncora ambígua (C47 de novo) e uma sobrevivente por mutação defeituosa que só ACRESCENTAVA texto.
  Refeitas, ambas morreram.
  ⚠️ **O `EXPLAIN` contra o Postgres real me desmentiu**: escrevi que os literais fariam o planejador
  escolher o índice parcial, e o plano medido mostra que não — o índice é chaveado por `run_id` e a
  consulta filtra por `turn_id`. Corrigi o comentário, não o código.
  ⚠️ **Uma medição descartou o `LIMIT`** que eu ia pôr na seleção: `resume_after_ingress_seq` **não
  tem leitor** (nem claim, nem recovery, nem promoção o consultam), logo `future_only` é imposto SÓ
  pelo cancelamento — capar a seleção deixaria o resto do backlog reivindicável e seria buraco de
  correção, não troca de desempenho. Ver C53.
  Gates `tsc`/`eslint` 0, guarda do C51 em 103/103, regressão `51 | 10291 | 1272 (11614)` fechando
  exata. **Os construtores estão INERTES** — sem call site de produção; a fiação é a fatia seguinte.
  Ver V-043.
- `U-P04.6b` — **concluída e verificada**: o hold de controle humano estendido ao caminho de
  DEBOUNCE, que o P04.6 tinha deixado de fora. **A fatia não veio de leitura minha do plano, veio da
  revisão adversarial** — e só entrou depois de um vermelho executável confirmar o defeito:
  `2 failed | 17 passed`, com o fechador FECHANDO a janela de uma conversa sob controle humano
  (`closed === true`) e o enumerador listando a stream retida. Era defeito real, em produção.
  Quatro edições em `turn-repos.ts`, com divisão de trabalho explícita: predicado em
  `listDueDebounceStreams` (forma cross-tenant), sonda `humanControlProbe` com retorno cedo em
  `closeDueDebounceBatchTx` e o predicado no `WHERE` do CAS — **a sonda dá o MOTIVO, o predicado do
  CAS dá a ATOMICIDADE**, porque esta transação segura o mutex da STREAM e não o lock do CONTROLE,
  então entre ler e escrever uma pausa pode comitar. `DebounceCloseResult` ganhou
  `conversation_human_control` na união de recusa.
  **4 mutações, 3 mortas, 1 sobrevivente ATRIBUÍDO, 0 puladas** (âncoras contadas e impressas antes,
  por C47). A sobrevivência do predicado do CAS não é lacuna e a prova é a diferença entre duas
  assertivas: sem a sonda o CAS ainda recusa e o desfecho vira `lost_race` (janela preservada, motivo
  errado ao operador); sem os DOIS a janela fecha. Rodar só as mutações isoladas teria registrado
  "1 sobrevivente sem explicação" — ou, pior, me levado a remover o predicado.
  Gates `tsc`/`eslint` 0, contrato 40/40 (consumidores agora **6**), hold real-db 19/19.
  ⚠️ `turn-stream-debounce-real-db` **não serve de evidência aqui**, e isso foi atribuído por eixo
  pareado (saída idêntica com e sem a mudança): é a família do C54.
  ⚠️ **A regressão só fechou porque remedi a baseline no HEAD** em vez de citar a registrada: o mesmo
  commit deu `53 | 10289 | 1272` hoje contra `51 | 10291 | 1272` antes. Placar não decide; o diff dos
  CONJUNTOS decide — um arquivo a mais em falha, zero a menos, nenhuma área desta branch. O resíduo é
  `check-commit-trailers`, cujo mecanismo enfim está nomeado pelo reporter do repositório (prazo de
  20s estourado na tentativa 1, recuperado pela 2 no HEAD, e as DUAS estourando na minha rodada;
  isolado, 13/13 em 8,37s). Ver V-044.
  ⚠️ **O que esta fatia NÃO faz, dito aqui para não ser lido como mais do que é:** ela barra
  ADMISSÃO, não interrompe execução em voo. Turnos já `claimed`/`running` quando o modo volta seguem
  fora — ver **C55**, que registra o achado da revisão ainda em aberto e mantém o K-12 PARCIAL.
- `U-P04.5b.2b` — **concluída e verificada**: `cancelHeldBacklogTurnInTx`, a primitiva que descarta
  UM turno retido compartilhando a transação de quem retoma, e `recordBacklogCancellationCommitted`,
  o emissor ADIADO da métrica. É `...InTx` pelo precedente de `completeRecoveredOutboundTurnInTx`, e
  daí vem também a recusa ruidosa: conflito aqui é rollback obrigatório, nunca conflito devolvido com
  o caller comitando o resto. As origens vêm da constante e **não** de `sourceStatusesFor`, que
  traria `running` junto — a armadilha que o P04.5b.1 documentou e que o caso 4 prende.
  ⚠️ **O vermelho inicial passava de graça em 4 dos 10 casos.** Eles usavam `rejects.toThrow()`, e um
  `TypeError` de função inexistente satisfaz isso: passariam contra implementação nenhuma. Endurecidos
  para cobrar o conflito ESPECÍFICO, o vermelho virou 10/10.
  ⚠️ **O lint apontou uma vacuidade, não um estilo:** `inA2`/`inB` sem uso significavam que os casos de
  isolamento provavam "A não alcança" sem provar que o turno era cancelável. Fechada a outra metade, a
  advertência sumiu sozinha.
  ⚠️ **Uma mutação que eu NÃO previa sobreviveu, e a culpa era da asserção.** Emitir o contador dentro
  da transação passou ileso porque o caso 10 procurava `to="ignored",outcome="operator_cancelled"` e
  `key()` (`src/lib/metrics.ts:41`) ordena rótulos alfabeticamente — a agulha nunca é produzida, logo
  a asserção não podia falhar. É a **quinta** ocorrência da família C41, e a primeira em que quem
  pegou foi a varredura e não a leitura. Corrigida para usar a MESMA agulha nas duas metades.
  **Rodada final: 9 mutações, 9 mortas, 0 sobreviventes, 0 puladas** (3 âncoras ambíguas remedidas
  antes, por C47). Gates `tsc`/`eslint` 0; família real-db **337 casos / 13 arquivos / 0 falhas**;
  regressão EXATA — falhas e passados inalterados, pulados +11, conjunto de arquivos idêntico.
  **A primitiva nasce INERTE: sem call site de produção.** A fiação no `resumeConversationTx` é a
  fatia seguinte. Ver V-045.
- `U-P04.5b.2c` — **concluída e verificada**: a FIAÇÃO. O `resumeInTx` passa a selecionar o backlog
  retido (construtor do P04.5b.2a) e a descartá-lo turno a turno pela primitiva do P04.5b.2b, na
  MESMA transação da retomada e sob o MESMO lock. Com isso os três artefatos deixam de ser inertes e
  o `future_only` do §8.2.5 passa de **declarado** a **executado**. `ResumeConversationResult` ganha
  `backlog_cancelled`; a auditoria de `conversation_automation_resumed` passa a registrar quantas
  mensagens do cliente foram fechadas por decisão do operador — o fato mais consequente da operação,
  que antes não aparecia em trilha nenhuma. A métrica sai depois do commit e **só** na variante de
  transação própria; `resumeConversationInTx` não emite, e a assimetria está documentada na função.
  O laço é sequencial por escolha: cada turno passa por `assertTurnTransition` + CAS, guardas que um
  `UPDATE ... WHERE id = ANY(...)` pularia.
  **7 mutações, 6 mortas, 1 sobrevivente atribuído, 0 puladas** — mas a primeira rodada me desmentiu
  duas vezes, e as duas viraram registro:
  ⚠️ **a W1 original sobreviveu porque o guarda `!atualizado` é INALCANÇÁVEL** (as três recusas reais
  retornam antes, sob o lock): era mutante EQUIVALENTE, não lacuna. Refeita para hastear captura e
  descarte acima da checagem de epoch, ela morre no caso 19 — e só então o caso 19, que **passava no
  vermelho**, virou prova. Ver **C56**.
  ⚠️ **a W5 sobreviveu como previsto**: o filtro do watermark não exclui ninguém porque o watermark é
  um máximo sobre o próprio conjunto. Confirma o C53 por ângulo novo; ver **C53-nota**.
  Dois defeitos meus corrigidos no caminho: o caso 17 tinha fixture inválida (FK de binding) e o
  driver de mutação casava o `const command_id` da função de PAUSA. Gates `tsc`/`eslint` 0; família
  real-db **344 / 13 arquivos / 0 falhas**; regressão EXATA pela segunda vez seguida (falhas e
  passados inalterados, pulados +7, conjunto de arquivos idêntico). Ver V-046.
- `U-C57` — **integração LOCAL concluída e verificada, NÃO publicada** (autorização do dono de
  17/09, restrita a branch/worktree nova). A linha canônica da épica passa a ser
  `claude/mh-integracao-c57` (worktree `.claude/worktrees/mh-integracao-c57`); a branch antiga
  `claude/maia-hermes-integration-158579` e as três de agente ficam intactas, com backups em
  `backup/c57-20260917/*`. 37 commits reconstruídos por `commit-tree` com árvore, autoria, datas e
  patch-id idênticos, só 6 mensagens sem o trailer de IA; P05, P06 e P07 transportados como cópias
  sobre o P04.1 reconstruído e integrados por três merges, com a árvore integrada igual à prevista
  por `merge-tree`. Gate de trailers REAL: exit 0 na integração, exit 1 com os 6 na épica antiga.
  Verificação da árvore integrada: typecheck, lint (0 erros), build, `docs:ai:check`, reservas de
  migration, drift de config; unitária `47 | 10549 | 1293 (11889)` com o MESMO conjunto de
  arquivos em falha da épica medida na mesma worktree (+254 casos dos agentes, todos passando);
  DB real em banco novo com 148 migrations do zero, 598 passados; `test:leak` com perfil idêntico
  ao V-027; pytest 169; spike 6/6. Mapeamento em `C57-RECONSTRUCAO-E-INTEGRACAO.md`. Ver V-047.
  ⚠️ **As 5 "melhoras" da suíte unitária NÃO são mérito da integração:** a worktree antiga tem
  arquivos com CRLF em disco; medida a épica reconstruída NA MESMA worktree nova, o conjunto em
  falha é idêntico ao da integrada.
- `U-C27` — **concluída e verificada** (`afde96d7`): nome da tool de fixture conforme K-19 sem
  afrouxar a regra, digest regerado pelo encoder TS, guarda com a função real e mutação 7/7. Ver
  V-048 e a correção de três erros do próprio registro C27.
- Harness do spike: `tests/helpers/hermes-stub-provider.ts` (provider **stub** compatível com Chat Completions, com gravação das requisições — é também o instrumento que responde a decisão D09) — escrito, ainda não commitado porque só faz sentido junto do teste do spike.

### Bloqueado
- Gates que exigem semântica real de Redis/BullMQ — **sem Redis real na máquina** (ver V-005).
- `U-P00.4` com provider real pago — D02/orçamento. O spike com stub NÃO é bloqueado.
- `U-P02.1` (extração do reasoner) — esperando a caracterização do P01 aterrissar, para não mexer em `react-loop.ts` antes de existir a linha de base.

- `U-P02.1`: `MaiaEngine` — o motor local implementando `AgentEnginePortV1`, com raciocínio injetado (`runReasoning`), registro de execução em memória deliberadamente honesto (`not_found/inconclusive`, nunca prova de não-aceite), conflito de `request_key` como recusa terminal e `cancel` que pede sem afirmar ausência de efeito. 15 casos, 5 mutações detectadas.

### Próximo trabalho

> Esta seção estava OBSOLETA até P03.6b — listava `U-P02.2`, `U-P03.2` e `U-P00.4`, todas concluídas
> (`609cc189`, `28b3e739`, `6f372874`). Documentação estragada custa tempo real: os comandos de
> retomada da seção 9 apontavam para binário, data dir e nome de banco errados e consumiram um desvio
> inteiro de diagnóstico nesta sessão. Manter esta lista viva é parte do trabalho, não enfeite.

> **Escopo do P03 relido na FONTE (capítulo 10, linha 2625), e não nos nomes que derivei do §5.6.3.**
> A etapa tem TRÊS entregáveis: `engine-repos.ts` (feito), schema + migrations reservadas (feito) e
> **`src/runtime/engines/recovery.ts` (nem começado)**. Ler o capítulo 10 antes de continuar evitou que
> eu desenhasse o recovery DENTRO do repositório: ele é módulo de RUNTIME. O capítulo lista ainda
> "projeções" e "testes DB/crash" como escopo do P03.

> **P03 CONCLUÍDO.** Os três entregáveis que o capítulo 10 nomeia estão entregues e verificados:
> `engine-repos.ts`, schema + migrations reservadas, e `recovery.ts`. A etapa somou 167 casos de
> integração contra Postgres real, 22 unitários puros, e varreduras de mutação em cada unidade.

1. `P04` — **controle humano da conversa e fencing de egresso**. O capítulo 10 dá o escopo:
   "pause/pausing/human/resume e fence real em TODO egresso; hold de inbound", tocando
   `conversation-controls-repo.ts`, `conversation-control.ts`, admissão de turno, o dispatcher de
   tools e as rotas de egresso/inline/recovery. Depende do P03 (feito) e **vale também no engine
   local** — não é fatia só-Hermes. A spec manda testar ABA e backlog, e o §5.6.2 já deixou o
   `control_epoch` no journal justamente para derrotar ABA.
2. **Fiação de `routeExistingEngineRun`** (`core.ts:750-753`), em unidade própria: altera o pipeline
   vivo de turno, que é o maior raio de explosão desta épica até agora.

   Descrição da etapa 8b, mantida como contexto histórico: **`src/runtime/engines/recovery.ts`**, o TERCEIRO entregável que o capítulo 10 nomeia
   para o P03 e o único que falta. A tabela de política do §5.8.2 como módulo PURO de decisão (estado
   do journal → ação segura), sem tocar no fluxo de turno. A spec nomeia o arquivo mas **não
   especifica API nenhuma** — o desenho é meu e será registrado como decisão, não como leitura.
   `routeExistingEngineRun` é estrutura PROPOSTA (`grep` no código = 0) e sua costura tem lugar exato
   (linha 495: depois do claim/ALS, ANTES de reexecutar `runAgentTurnPipeline`, em `core.ts:750-753` —
   as duas chamadas sob `comEscopoDeSaida`). **A fiação fica para unidade própria**: alterar o pipeline
   vivo de turno tem raio de explosão maior que tudo feito até aqui.
2. `P04` — controle humano da conversa e fencing de egresso.

   Descrição da etapa 8a, mantida como contexto histórico: caracterização de `engine_projections`,
   lacuna encontrada ao reler o
   capítulo 10, não um item do plano original: a tabela existe desde a 140, mas `grep` em `tests/`
   devolve ZERO — nenhum caso a exercita, enquanto as três irmãs do journal ganharam caracterização no
   P03.1. São 6 CHECKs (vocabulário de `projection` e de `state`, terminal exige `finished_at`,
   `anchor_message_id` só em `event_history`), FK e PK compostas, e **nenhum trigger** — assimetria que
   merece teste próprio, porque a ausência é correta (o estado avança `pending→started→completed`) e
   alguém pode "consertá-la" por engano. Não confundir com o adiamento do P03.6b, que é sobre
   PROCESSAR projeções (P08/P09) e continua de pé.
2. `U-P03.8b` — **`src/runtime/engines/recovery.ts`**: a tabela de política do §5.8.2 como módulo PURO
   de decisão (estado do journal → ação segura), sem tocar no fluxo de turno. A spec nomeia o arquivo
   mas **não especifica API nenhuma** — o desenho é meu e será registrado. `routeExistingEngineRun` é
   estrutura PROPOSTA (não existe no código: `grep` = 0) e sua costura tem lugar exato (§5.8.2 linha
   495: depois do claim/ALS, ANTES de reexecutar `runAgentTurnPipeline`, em `core.ts:750-753` — as duas
   chamadas sob `comEscopoDeSaida`). **A fiação fica para unidade própria**: alterar o pipeline vivo de
   turno tem raio de explosão maior que tudo feito até aqui, e o §3 pede unidades pequenas.
3. `P04` — controle humano da conversa e fencing de egresso.

   Descrição anterior desta etapa, mantida como contexto: compõe o que já existe em vez de
   reimplementar: a varredura (7a) descobre o trabalho, a manutenção (7b) reserva a janela,
   `revokeRunCapabilities` (P03.4) revoga de forma monotônica e `closeRunAfterHandoff` (P03.6b) fecha
   com prova. O que falta é a POLÍTICA que encadeia os quatro — §5.8.4 item 5 ("com prova de outbound,
   terminal íntegro e calls conciliadas, fechar `handed_to_outbox` por CAS e evento
   `actor_kind=recovery`; se só existe turno terminal sem prova suficiente, manter blocked/triagem,
   não inventar entrega nem `safe_to_retry`") e item 6 (`dead_letter` com efeito desconhecido continua
   bloqueado). Atenção ao que NÃO é escopo: reexecução de graph iniciado segue proibida sem
   idempotência própria.
   Descrição da etapa 7b, mantida como contexto histórico: **manutenção** (§5.8.4 itens 2 e 4):
   `reserveMaintenanceObservation`/`recordMaintenanceObservation`. Reserva curta por CAS de
   `row_version` com `next_poll_at <= clock_timestamp()`, onde **a versão devolvida É o fence e NÃO é
   claim token de turno**; a gravação só vale com a reserva ainda vigente, uma manutenção atrasada não
   sobrescreve outra, e falha de CAS exige nova leitura — nunca payload cego. A janela de observação
   entra como PARÂMETRO (C19). Se houver dono vivo em operação, a manutenção ADIA em vez de disputar.
   Descrição original da etapa, mantida como contexto: `enumerateDueScopes` (CROSS-TENANT, sem ALS,
   só pares e cursor, nunca conteúdo — o padrão da casa é `objectivesRepo.reclaimExpiredTaskLeases`,
   com `db.execute` cru e `FOR UPDATE SKIP LOCKED`), `listDueRuns` (sob ALS, pelo índice parcial
   `engine_runs_due_idx`), e o par `reserveMaintenanceObservation`/`recordMaintenanceObservation`,
   onde a `row_version` reservada É o fence e NÃO é claim token de turno. Verificado: não há RLS em
   nenhuma tabela e `client.ts` não injeta tenant por GUC, então a leitura cross-tenant é viável sem
   papel especial. A "próxima janela finita de observação" do item 2 entra como PARÂMETRO — a spec não
   dá o número, e inventá-lo seria política minha disfarçada de leitura.
2. `U-P03.8` — recovery do journal, fechando o P03.
3. `P04` — controle humano da conversa e fencing de egresso.

## 7. Decisões pendentes (spec §12.5) — nenhuma preenchida por suposição

D01 launcher/isolamento real · D02 provider/modelo/conta · D03 volume/latência/orçamento · D04 coorte piloto · D05 política de dados · D06 aprovadores reais · D07 ferramentas comerciais · D08 estratégia de revisão de fatos (verificável no PR) · D09 formato real do request SDK (verificável no spike) · D10 UX de backlog humano.

## 8. Riscos correntes

- Ambiente local sem Redis real: gates que dependem de BullMQ/Redis ficam como não verificados localmente.
- Postgres local é 16.2 com pgvector 0.6.2 (CI usa imagem `pgvector/pgvector:pg16`, versão mais nova); diferença registrada.
- Sem push: nenhum CI roda sobre o código novo (INV-13: CI da baseline não homologa nada).
- **O gate de formatação da casa não cobre `tests/`.** Não existe configuração de prettier no
  repositório (sem `.prettierrc*`, sem chave em `package.json`, sem `.prettierignore`), então ele roda
  no default — e `npm run format` é `prettier --write **src**`. Consequência medida, não suposta:
  `tests/integration/hermes-runs-real-db.spec.ts` REPROVA em `prettier --check`, enquanto os specs que
  escrevi hoje passam. Isso não é defeito de ninguém, mas tem efeito prático: acrescentar casos a um
  spec antigo e formatá-lo reescreveria centenas de linhas preexistentes e o commit deixaria de conter
  apenas as alterações da tarefa (§2). Por isso a caracterização de `engine_projections` foi para
  arquivo próprio. Normalizar `tests/` de uma vez é decisão do dono — é diff grande e sem relação com
  esta épica, e eu não vou embutí-lo aqui.
- **O espelho drizzle de `src/db/schema.ts` é CONVENÇÃO, não gate.** Verificado ao criar a 141: as seis
  tabelas da 140 têm espelho, mas **nenhum teste cobra a paridade** entre `schema.ts` e as migrations —
  não há spec de paridade, e `probe:drizzle-kit`/`config:check:drift` são outra coisa (o segundo checa
  artefatos de configuração). Ou seja, esquecer o espelho de uma tabela nova não quebraria nada e
  passaria despercebido até alguém precisar importá-la num repositório. Registrado porque eu quase
  fechei o P04.1 sem ele, e só notei ao conferir com o padrão de grep certo — o primeiro grep (de uma
  linha só) deu falso negativo dizendo que NENHUMA tabela estava espelhada. Um gate de paridade seria
  barato e é decisão do dono; não o acrescento aqui para não expandir escopo.
- **A lacuna do prettier NÃO é só de `tests/` — `src/` também está fora de norma.** Medido ao fechar o
  P04.1: `prettier --check` na versão do HEAD de `src/db/schema.ts` REPROVA. Rodar
  `prettier --write` nele para acompanhar um acréscimo de ~80 linhas produziu um diff de
  **3100 adicionadas / 2117 removidas** — ~5 mil linhas de reformatação alheia enterrando o conteúdo
  da tarefa, o que violaria o §2 ("commits de apenas as alterações desta tarefa"). Restaurei o arquivo
  e reapliquei só o bloco, no estilo vigente do arquivo. **O detalhe que torna isso uma decisão do
  dono, e não um bug meu:** o gate da casa é `npm run format` = `prettier --write src`, então rodar o
  PRÓPRIO gate hoje produziria esse churn em massa. Normalizar o repositório de uma vez é um commit
  separado e grande; embuti-lo numa fatia desta épica seria esconder a decisão dentro de outra coisa.
- **ARMADILHA DE EOL desta worktree: editar arquivo antigo produz diff de arquivo INTEIRO.** Medido ao
  acrescentar ações em `audit-actions.ts`: o diff veio 1002/953 para um bloco de 49 linhas. A causa NÃO
  é o editor — é que `core.autocrlf` é **`true` no nível system** e `false` no local, e os arquivos
  foram checados out como **CRLF** quando o valor do sistema valia, enquanto os blobs são **LF**
  (medido sem pipe: `audit-actions.ts` worktree CR=1002/55286 bytes, blob LF/51720). O `git status` os
  dá como limpos porque o cache de `stat` do índice bate e ele nunca recompara o conteúdo; qualquer
  edição muda tamanho/mtime, o git recompara, e a divergência PREEXISTENTE aparece como se fosse sua.
  Não há `.gitattributes` para normalizar.
  **Procedimento ao editar arquivo antigo:** `git checkout -- <arquivo>` ANTES de editar (o checkout
  grava LF, porque o local vale) e só então aplicar a mudança; conferir com
  `git diff --numstat` que o número bate com o tamanho real da edição. Dois arquivos já me custaram
  esse ciclo nesta sessão (`schema.ts`, por prettier; `audit-actions.ts`, por EOL) — e nos dois o
  sintoma foi idêntico: conteúdo pequeno enterrado sob milhares de linhas alheias, que o §2 proíbe
  commitar junto. Arquivos CRLF confirmados na worktree: `audit.ts`, `poison-policy.ts`,
  `audit-actions.ts`. A correção definitiva (um `.gitattributes`) é decisão do dono.

## 9. Comandos de retomada

```bash
# Node do projeto
export PATH="<scratchpad>/tools/node22:$PATH"
# Postgres descartável — binário `pgs`, data dir `data2`.
# ATENÇÃO: o par `pgsql`/`data` é o PRIMEIRO initdb e está ABANDONADO — `vector.dll`
# não carrega nele (`unknown error 127`) e a 001 exige `CREATE EXTENSION vector`.
# Refeito em `pgs`/`data2` em 15/09 19:59. Esta linha já apontou para o par errado
# e custou um desvio inteiro de diagnóstico; não "corrija" de volta.
/c/Users/Mendes/AppData/Local/Temp/mhx/pgs/bin/pg_ctl.exe -D /c/Users/Mendes/AppData/Local/Temp/mhx/data2 -o "-p 55432 -c listen_addresses=127.0.0.1 -c max_connections=300" -l /c/Users/Mendes/AppData/Local/Temp/mhx/server2.log -w start
# Redis FAKE
<scratchpad>/venvs/pg/Scripts/python.exe -c "from fakeredis import TcpFakeServer; TcpFakeServer(('127.0.0.1',56379), server_type='redis').serve_forever()"
# Integração contra o banco local
TEST_DB_URL=postgres://maia_test:test1234@127.0.0.1:55432/maia_test REDIS_URL=redis://127.0.0.1:56379 npm run test:integration -- <spec>

# ── Desde 17/09 (C57): a linha canônica é a worktree de INTEGRAÇÃO ──────────
# Worktree:  .claude/worktrees/mh-integracao-c57   branch: claude/mh-integracao-c57
# node_modules: junction para o da worktree github-issue-498-cdbb4e (lockfile idêntico,
#   conferido sem CR; o disco da worktree antiga tem CRLF, o blob não).
# Banco desta worktree (criado e migrado do zero pelo globalSetup, 148 migrations):
#   maia_test_wt_c_users_mendes_documents_10fe483e
# Passo 1 (só se o banco sumir): config do projeto, termina no erro do Redis — esperado.
TEST_DB_URL=postgres://maia_test:test1234@127.0.0.1:55432/maia_test REDIS_URL=redis://127.0.0.1:56379 node node_modules/vitest/vitest.mjs run tests/integration/hermes-runs-real-db.spec.ts
# Passo 2: família real-db, sem globalSetup.
TEST_DB_URL=postgres://maia_test:test1234@127.0.0.1:55432/maia_test_wt_c_users_mendes_documents_10fe483e DATABASE_URL=<o mesmo> REDIS_URL=redis://127.0.0.1:56379 MAIA_REPO_ROOT=<worktree> node node_modules/vitest/vitest.mjs run --config <scratchpad>/vitest.integracao-local.config.mts hermes-
# pytest do worker (169)
cd services/hermes_worker && PYTHONDONTWRITEBYTECODE=1 <scratchpad>/venvs/pytest/Scripts/python.exe -m pytest -p no:cacheprovider -q
# spike (AIAgent real, provider STUB)
MAIA_HERMES_WORKER_PYTHON=<scratchpad>/hermes/hermes-upstream/.venv/Scripts/python.exe MAIA_HERMES_UPSTREAM=<scratchpad>/hermes/hermes-upstream node node_modules/vitest/vitest.mjs run tests/reliability/hermes-worker-spike.spec.ts
# Gate de trailers com evento REAL (JSON UTF-8 sem BOM, base = main). Sem evento ele diz
# "pulado" e sai 0 — isso NÃO é aprovação.
printf '{"pull_request":{"base":{"sha":"<main>","ref":"main"},"head":{"sha":"%s"}}}' "$(git rev-parse HEAD)" > <scratchpad>/evento.json
env -u VITEST GITHUB_EVENT_PATH=<scratchpad>/evento.json node node_modules/tsx/dist/cli.mjs scripts/check-commit-trailers.ts
```
