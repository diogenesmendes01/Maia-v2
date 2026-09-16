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
- `U-P03.6a` — **concluída e verificada**: `adoptTerminalResult`. A operação tem uma **assimetria
  deliberada** contra todo o resto do módulo: o fence é do turno ATUAL, não da origem do run. O motivo
  é que adotar não autoriza efeito nenhum — pega um terminal já persistido e diz quem assume a saída —
  e o §5.8.2 manda explicitamente que o NOVO owner adote em vez de pagar outra deliberação por um
  worker ter sido reenfileirado. `adopted_by_turn_attempt` registra QUAL tentativa assumiu (caso 47).
  Adotar **não** fecha o run, **não** reautoriza callbacks antigos (`capabilities_revoked_at` intacto,
  caso 50) e **não** transiciona `agent_turns` — o §5.7.2 lembra que `phase` não substitui `status`.
  52 casos no spec de runs; 5 mutantes, todos mortos. Registrado sem maquiagem: o caso 50 **não tem
  mutante** porque o código simplesmente não toca naquela coluna — ele guarda uma regressão futura, e
  contá-lo como "coberto pela varredura" seria inflar o placar.
- `U-P03.6b` (próxima): `closeRunAfterHandoff`. Depende de prova de outbound — ver C18, que precisou
  ser CORRIGIDO: o marcador de convergência da casa é `status='completed'`, não o `sent`/`unknown` do
  vocabulário legado, e `delivered` é intermediário que um CAS promove. Reusar
  `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES` (exportado) para "resolvido"; `safe_to_retry` exige ausência
  de outbound **e** de efeito não reconciliado (invariante 7), então também consulta `effect_evidence`.
- Harness do spike: `tests/helpers/hermes-stub-provider.ts` (provider **stub** compatível com Chat Completions, com gravação das requisições — é também o instrumento que responde a decisão D09) — escrito, ainda não commitado porque só faz sentido junto do teste do spike.

### Bloqueado
- Gates que exigem semântica real de Redis/BullMQ — **sem Redis real na máquina** (ver V-005).
- `U-P00.4` com provider real pago — D02/orçamento. O spike com stub NÃO é bloqueado.
- `U-P02.1` (extração do reasoner) — esperando a caracterização do P01 aterrissar, para não mexer em `react-loop.ts` antes de existir a linha de base.

- `U-P02.1`: `MaiaEngine` — o motor local implementando `AgentEnginePortV1`, com raciocínio injetado (`runReasoning`), registro de execução em memória deliberadamente honesto (`not_found/inconclusive`, nunca prova de não-aceite), conflito de `request_key` como recusa terminal e `cancel` que pede sem afirmar ausência de efeito. 15 casos, 5 mutações detectadas.

### Próximo trabalho
1. `U-P02.2` — ligar `runReasoning` ao laço REAL: extrair de `runReActLoop` a parte deliberativa (sem despacho), mantendo `runReActLoop` como fachada com o comportamento de hoje. A rede que protege essa troca é a caracterização do P01 (57 casos) — qualquer divergência aparece lá.
2. `U-P03.2` — `engine-repos` (CAS de fase, admissão de call, journal) sobre as tabelas da 140, com testes contra o Postgres real.
3. `U-P00.4` — spike sintético: `AIAgent` do checkout pinado contra o provider stub, verificando superfície efetiva de tools, rotação de sessão por compressão, cancelamento e limpeza do home efêmero (depende do worker Python do agente paralelo).

## 7. Decisões pendentes (spec §12.5) — nenhuma preenchida por suposição

D01 launcher/isolamento real · D02 provider/modelo/conta · D03 volume/latência/orçamento · D04 coorte piloto · D05 política de dados · D06 aprovadores reais · D07 ferramentas comerciais · D08 estratégia de revisão de fatos (verificável no PR) · D09 formato real do request SDK (verificável no spike) · D10 UX de backlog humano.

## 8. Riscos correntes

- Ambiente local sem Redis real: gates que dependem de BullMQ/Redis ficam como não verificados localmente.
- Postgres local é 16.2 com pgvector 0.6.2 (CI usa imagem `pgvector/pgvector:pg16`, versão mais nova); diferença registrada.
- Sem push: nenhum CI roda sobre o código novo (INV-13: CI da baseline não homologa nada).

## 9. Comandos de retomada

```bash
# Node do projeto
export PATH="<scratchpad>/tools/node22:$PATH"
# Postgres descartável
/c/Users/Mendes/AppData/Local/Temp/mhx/pgsql/bin/pg_ctl.exe -D /c/Users/Mendes/AppData/Local/Temp/mhx/data -o "-p 55432 -c listen_addresses=127.0.0.1 -c max_connections=300" -l /c/Users/Mendes/AppData/Local/Temp/mhx/server.log -w start
# Redis FAKE
<scratchpad>/venvs/pg/Scripts/python.exe -c "from fakeredis import TcpFakeServer; TcpFakeServer(('127.0.0.1',56379), server_type='redis').serve_forever()"
# Integração contra o banco local
TEST_DB_URL=postgres://maia_test:test1234@127.0.0.1:55432/maia_test REDIS_URL=redis://127.0.0.1:56379 npm run test:integration -- <spec>
```
