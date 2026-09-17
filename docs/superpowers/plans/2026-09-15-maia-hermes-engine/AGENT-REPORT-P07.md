# AGENT-REPORT-P07 — supervisor Hermes, fatia de CONTRATO + POLÍTICA PURA

> Escopo desta fatia: a decisão. Não o encanamento. Nenhum subprocesso, timer,
> banco ou rede foi escrito nem exercitado aqui.
> Branch `claude/mh-p07-supervisor`, base `7993e563`.

## 1. O que foi implementado, e em qual commit

| Commit | Conteúdo |
|---|---|
| `a1c3de3a` | `src/integrations/hermes/supervisor-policy.ts` (novo) + `tests/unit/hermes-supervisor-policy.spec.ts` (novo, 60 casos) |
| *(este arquivo)* | relatório |

Três funções TOTAIS sobre instantâneos explícitos, uma por verbo da porta
(§5.3.1), mais duas auxiliares:

| Símbolo | Responsabilidade |
|---|---|
| `decideAdmission` | `start`: admitir, devolver a existente, conflitar ou recusar |
| `decideObservation` | `observe`: o que fazer com o que o canal acabou de dizer |
| `decideCancellation` | `cancel`: o próximo degrau do encerramento do §6.7.3 |
| `deadlinePosture` | prazo → `within_deadline` / `cancel_due` / `kill_due` |
| `mayFallBackToLocalEngine` | o gate de rollback do §6.11 |

Vocabulários fechados: `ADMISSION_DISPOSITIONS` (5), `OBSERVATION_DISPOSITIONS`
(8), `CANCELLATION_DISPOSITIONS` (6), `EXECUTOR_OBSERVED_STATES` (8, a lista
literal do §6.11 linha 1768) e `DEFERS_TO_RECOVERY` (7).

Duas garantias são ESTRUTURAIS, não convencionais:

- **`SPAWNS_PROCESS` é uma disposição só** (`admit_new`), e o caso 6 varre o
  produto cartesiano de todo instantâneo com execução já registrada para provar
  que ela é inalcançável ali. "Nenhum segundo processo" (T09, T10) deixa de ser
  uma frase e vira um invariante verificado.
- **O vocabulário não consegue expressar a ação proibida.** Não há membro que
  signifique "lance de novo"/"retome" (INV-09 atravessa a fronteira, casos 12 e
  21) nem "seguro repetir" (§6.7.3 item 5, caso 41). Mesmo mecanismo que a spec
  elogia na ausência de `resend_blind`.

Uma decisão de desenho que merece destaque, porque é onde quase se erra:
**`cancel_ack_received` não aparece em nenhuma condição de `decideCancellation`.**
O campo está no instantâneo por ser observável e auditável, mas o §6.4.2 define
`cancel_ack` como "controle recebido; não prova de interrupção ou ausência de
efeito" e o §5.7.2 manda "não fechar com base só no ACK". Quem encerra é o exit
confirmado pelo SO. O mutante M19 ("ACK encerra a espera") existe exatamente
para impedir que alguém "otimize" isso depois.

## 2. Matriz §11.2, teste a teste

**Nenhuma linha é marcada COBERTO.** O critério de aceite proíbe marcar coberto
o que depende de subprocesso real ou banco real, e toda linha T09–T16 é um
comportamento ponta a ponta. O que segue é a metade de política, que está feita
e verificada, e a metade que falta, nomeada.

| ID | Estado | Metade coberta (casos) | Metade que falta |
|---|---|---|---|
| T09 | **PARCIAL** | 1–4: fingerprint divergente → `conflict_payload`, domina os demais ramos, e não gera `admit_new` | supervisor real recusando o lançamento; unicidade provada em Postgres (é `pinEngineAndPrepareRun`, P03) |
| T10 | **PARCIAL** | 5–7 + varredura do caso 6 | canal IPC real com ACK de admissão perdido |
| T11 | **PARCIAL** | 8–12: `reconcile_admitted_not_executed` é disposição própria e **sobrevive à lease morta** (caso 9); nova execução só por `execution_id` novo com run anterior fechado (caso 11) | marcador DURÁVEL que distinga "admitido sem spawn" de "spawn com ACK perdido" — ver §6, achado A1 |
| T12 | **PARCIAL** | 13–15: mesmo digest → `repeat_result_ack`; digest diferente → `conflict_terminal`; primeiro terminal → `accept_terminal` | reentrega real pelo canal; prova em banco de que o ACK repetido não duplica custo/outbound |
| T13 | **PARCIAL (metade)** | 16–18: terminal íntegro **com** efeito não conciliado não é adotado; processo morto não converte desconhecido em ausência | o resto é P05 (dispatcher/ledger de efeito) e exige banco |
| T14 | **PARCIAL** | 19–22: `not_found` e `unavailable` viram `treat_as_unknown`; executor assentado sem proposta idem; o vocabulário não consegue afirmar não-execução | consulta real de status depois de restart |
| T15 | **PARCIAL** | 23–26: fence e lease verificados como condições **independentes**, cada uma descartando um terminal perfeito | lease real expirando contra Postgres durante trabalho real |
| T16 | **PARCIAL** | 27–42: a escada `min(prazo, lease)` → `cancel_due` → `kill_due`, a ordem obrigatória do §6.7.3 e a recusa do ACK como encerramento | kill real de processo/grupo e confirmação de exit pelo SO; reaper |
| T65 | **PARCIAL** | 43–45: fallback exige run fechado **e** zero efeito pendente | seletor de engine e o caminho de rollback (P12) |
| T66 | **PARCIAL** | 46: categoria `policy` entra na mesma escada; admissão recusa enquanto houver run aberto no turno | a flag real e seu escopo |

**Gate G-LIFE: NÃO CUMPRIDO.** Ele exige que "crash/retry/lease/ACK/drop/cancel
preservem os ledgers e não reexecutem efeito desconhecido" — ledger é banco e
crash é processo. Esta fatia entrega a política que o gate vai cobrar; não o
gate.

## 3. Gates executados, com exit code real

Capturados na hora, sem pipe (`cmd > arquivo 2>&1; echo $?`). Node v22.23.2.

| Gate | Comando | Exit |
|---|---|---|
| Vermelho inicial (TDD) | `npx vitest run tests/unit/hermes-supervisor-policy.spec.ts --no-coverage` | **1** — `Cannot find package '@/integrations/hermes/supervisor-policy.js'`, 0 casos executados |
| Typecheck | `npx tsc --noEmit` | **0** (saída vazia) |
| Lint | `npx eslint src/integrations/hermes/supervisor-policy.ts tests/unit/hermes-supervisor-policy.spec.ts` | **0** (saída vazia) |
| Teste | `npx vitest run tests/unit/hermes-supervisor-policy.spec.ts --no-coverage` | **0** — `executados=60 falharam=0 pulados=0` |
| Teste (pós-mutação, confirmando restauração) | idem | **0** — 60/60 |

`prettier` não foi executado: não é gate neste repositório (sem configuração, e
705 arquivos de `src/` reprovariam) — rodá-lo produziria churn de aspas em
arquivo alheio.

Nota sobre o alcance do typecheck: `tsconfig.json` tem `"exclude": [… "tests"]`,
então `tsc --noEmit` cobre `supervisor-policy.ts` mas **não** o spec. Os erros de
tipo do spec apareceriam só no runtime do vitest (esbuild não checa tipos). Não é
uma lacuna que eu possa fechar sem mexer em `tsconfig.json`; fica registrada.

## 4. Verificação por mutação

**33 mutantes aplicados, 33 mortos, 0 sobreviventes, 0 inválidos.** O script
(no scratchpad, fora do repositório) valida que cada `find` ocorre exatamente
uma vez, aplica a mutação a partir do fonte original, roda o spec com
`--retry=0` e restaura em `finally`. Restauração confirmada depois: nenhum
resíduo `if (false)` no fonte e a suíte de volta a 60/60.

Cobertura dos mutantes, por predicado que sustenta garantia:

- **Admissão (M01–M09):** conflito de payload desligado; distinção
  admitido-sem-executar desligada; metade `!spawned` removida; execução
  existente caindo em `admit_new`; cada um dos quatro gates (`open_run`,
  `lease`, `controle`, `deadline`) desligado; guarda de `execution_id`
  divergente removida.
- **Observação (M10–M17, M33):** cada metade da posse (fence / lease) removida
  separadamente; `lookup` ignorado; as duas colapsagens do par
  repetição/conflito; retenção por efeito desconhecido removida; executor
  assentado deixando de virar `unknown`; deadline deixando de abrir
  cancelamento; exaustividade devolvendo em vez de lançar.
- **Cancelamento (M18–M23):** revogar-primeiro removido; `send_cancel` removido;
  **ACK encerrando a espera** (M19, o erro clássico); matar sem esperar a
  tolerância; nunca matar; reconciliação de efeito removida.
- **Prazo (M24–M28):** cada metade do `min` isolada (só execução / só lease);
  degrau `cancel_due` removido; as duas validações de entrada removidas.
- **Rollback e junção (M29–M32):** cada metade do `&&` do fallback; membro
  indevido entrando em `DEFERS_TO_RECOVERY`; membro devido saindo dela.

Dois erros meus que a disciplina pegou, e que valem registro porque nenhum era
visível na leitura:

1. **Fixtures 30 e 31 estavam erradas na aritmética.** Com `now_ms: 1_500`,
   prazo efetivo 1000 e `grace_ms: 200`, o resultado correto é `kill_due`, não
   `cancel_due`. Corrigi a **fixture** (para `now_ms: 1_050`), não a asserção —
   e conferi que os mutantes M24/M25 continuam morrendo, que era o motivo de os
   casos existirem.
2. O vermelho inicial foi legítimo mas fraco (arquivo não carregou, 0 casos).
   O reporter da casa é explícito sobre isso — "pulado NÃO é passou" — e a
   rodada foi contada como não passada.

## 5. Como isto se compõe com `recovery.ts`, sem duplicá-lo

As duas políticas respondem a perguntas diferentes sobre objetos diferentes:

| | `recovery.ts` (P03.8b) | `supervisor-policy.ts` (P07) |
|---|---|---|
| Entrada | instantâneo do **journal** | instantâneo da **tentativa viva** |
| Pergunta | o que é seguro fazer com este run depois de uma queda | o que fazer com este pedido/frame agora |
| Origem | tabela do §5.8.2 | §6.7.3, §6.11, §5.8.1 |

Três mecanismos garantem que não há segunda tabela:

1. **Vocabulários disjuntos** (caso 54, verificado por interseção contra
   `RECOVERY_DISPOSITIONS`). Um nome repetido significaria duas tabelas
   decidindo a mesma coisa.
2. **`DEFERS_TO_RECOVERY`** nomeia as sete disposições cujo próximo passo é de
   `classifyRecovery` — e o caso 56 exige o complemento (`accept_terminal`,
   `keep_observing`, `admit_new`, `settle_cancelled` ficam de fora), porque uma
   lista que contivesse tudo não distinguiria nada.
3. **Consumo, não recontagem**: `mayFallBackToLocalEngine` recebe `run_closed`
   como fato do journal (quem o dá é `closeRunAfterHandoff`), e a admissão
   recusa por `open_run_exists` espelhando a unique parcial
   `engine_runs_one_open_turn_uq` em vez de inventar a regra.

**As duas concordam onde se encontram.** O caso T11 é a junta: minha disposição
`reconcile_admitted_not_executed` corresponde à fase `prepared` do journal, e
`classifyRecovery` nessa fase devolve `resume_owner` (com posse viva) ou
`maintenance_only` (sem ela). Não é contradição — é a divisão correta: o recovery
diz que o run preparado pode ser retomado pelo dono vivo; o supervisor, ao ser
perguntado "admito uma execução nova para este id?", responde "não, reconcilie
a que existe". O resultado combinado é usar o registro existente em vez de cunhar
um segundo.

**Não encontrei disposição faltando em `recovery.ts`.** A tarefa pedia que, se
faltasse, isso fosse achado e não segunda tabela — não faltou. O arquivo não foi
tocado.

## 6. Contradições e achados, com referência

**A1 — o journal não distingue "admitido sem spawn" de "spawn com ACK perdido".
É o achado que mais importa, porque é exatamente a ambiguidade de T10/T11.**
O §6.11 (linha 1763) manda "registrar state `admitted` antes do spawn" e o §4.1
(linha 274) define `remote_run_id` como "o handle do filho criado para o run".
Mas `recordStartObservation` (§5.6.3, linha 1128) só atribui o remote ID quando
o start é aceito — então, entre o spawn e o ACK, `remote_run_id` ainda é `NULL`
com o processo já vivo. Varri a DDL da 140 (§5.6.2, linhas ~900–990) e não há
coluna que signifique "o processo chegou a ser criado".
Consequência prática: meu campo `AdmittedExecutionV1.spawned` não tem hoje uma
fonte durável exata. O mapeamento conservador disponível é
`spawned = (phase !== 'prepared')`, apoiado em `markSubmitting`, que "registra
intenção ANTES do start externo" (§5.6.3, linha 1127) — e conservador é o lado
certo do erro, porque trata "talvez tenha lançado" como "lançou". Quem fizer a
metade durável do P07 precisa **confirmar esse mapeamento ou pedir a coluna**;
não dá para inferir do código atual.

**A2 — `admitted` não é fase durável.** §6.11 fala em "state `admitted`"; o enum
de `engine_runs.phase` (§5.6.2) não o tem. Já registrado pelo orquestrador como
**C10**, e esta fatia é coerente com aquela decisão: `EXECUTOR_OBSERVED_STATES`
é vocabulário de estado OBSERVADO do executor, declarado como tal e
explicitamente separado de `phase` no cabeçalho do tipo. Ele **não existia em
lugar nenhum do código** (`grep` por `'interrupted'` e por `executor_state` em
`src/` = 0), então defini-lo não duplica nada.

**A3 — `grace` é derivado, não transportado.** §6.4.2 (linha 1504) põe
`grace_deadline_at` no frame `cancel` (instante absoluto), enquanto §6.7.3 item
4 fala em "tolerância configurada" (duração). Não é contradição, é conversão:
`deadlinePosture` recebe `grace_ms` e quem monta o frame deriva o instante. Fica
registrado para que ninguém trate os dois como o mesmo campo.

**A4 — trailer de coautoria.** O lembrete de atribuição da sessão pede
`Co-Authored-By: Claude …`; `AGENTS.md` §8 ("Coautoria") o **proíbe** e isso é
gate bloqueante de CI (`npm run commit:trailers:check`). Segui o `AGENTS.md` — o
commit `a1c3de3a` não tem trailer de IA. Idêntico ao **C08** já registrado.

## 7. O que eu precisaria nos arquivos que não posso tocar

Nenhuma dessas mudanças foi feita. Estão aqui como pedido, com o porquê.

1. **`migrations/**` + `src/db/repositories/engine-repos.ts`** — resolver **A1**:
   ou um marcador durável escrito **antes** do spawn, ou a decisão registrada de
   que `phase !== 'prepared'` é a definição de `spawned`. Sem isso, a metade
   durável de T11 fica apoiada numa inferência.
2. **`src/db/repositories.ts`** (barril) — reexportar `engineRunsRepo`. O
   `VERIFICATION-LOG.md` já avisa que a adição não é trivial: o barril usa
   `export *`, e nomes genéricos (`NotFound`, `TurnFenceConflict`,
   `ControlConflict`, `ToolClassification`) cairiam numa superfície importada por
   meio repositório. O supervisor real vai precisar disso.
3. **`src/runtime/engines/contracts.ts`** — se a casa preferir que
   `EXECUTOR_OBSERVED_STATES` viva junto dos contratos de engine, mover.
   Deixei-o no meu arquivo só porque não posso editar `contracts.ts`; o conteúdo
   é do §6.11 e não conflita com nada que esteja lá.
4. **`src/runtime/engines/recovery.ts`** — **nada**. Lido, não editado, e sem
   disposição faltando para esta composição.
5. **`REQUIREMENTS-MATRIX.md` / `IMPLEMENTATION-STATE.md`** — não editei (outro
   agente os está alterando agora). As linhas T09–T16 e T65/T66 podem sair de
   "não iniciado" para parcial, com este relatório e o commit `a1c3de3a` como
   evidência, e a linha P07 continua em andamento.

## 8. O que NÃO foi verificado, e por quê

- **Nada com subprocesso real, IPC real, banco ou rede.** É o recorte da fatia.
  `child_process`, timers, reaper, imagem/launcher, fiação no shutdown e
  integração com o journal ficam fora — e o caso 58 do spec **impede** que
  entrem sem ninguém perceber: ele lê o fonte como texto e reprova se aparecer
  `child_process`, `.spawn(`, `setTimeout(`, `setInterval(`, `node:fs`,
  `fetch(`, `Date.now(`, `new Date(`, `@/db/`, ALS, env ou métricas. O caso 59
  exige que a política seja síncrona.
- **A suíte unitária completa (`npm test`) não foi executada.** O módulo é novo
  e **nenhum arquivo o importa** além do meu spec, e `tsc --noEmit` passou sobre
  todo o `src/`, o que cobre o risco de quebra em tempo de compilação. Somado a
  isso, a baseline desta máquina é sabidamente ruidosa (falhas preexistentes de
  ambiente Windows, infladas por paralelismo), então uma rodada completa aqui
  produziria números que não distinguem o meu efeito do ruído. Se quiser o
  número mesmo assim, é uma rodada; só não vale como evidência limpa.
- **Integração e leak suite** exigem Postgres, ausente localmente. Validam no CI.
- **Nenhum resultado de motor real.** Não há mock apresentado como Hermes real
  aqui: este arquivo não fala com o Hermes de forma alguma. As fixtures são
  sintéticas (`'a'.repeat(64)` e afins), sem dado de cliente, credencial ou
  perfil do Hermes Desktop.
