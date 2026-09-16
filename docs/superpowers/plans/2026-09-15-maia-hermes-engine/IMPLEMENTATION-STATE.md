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
```
