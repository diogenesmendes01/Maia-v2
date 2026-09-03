# Harness de fault injection para turnos (issue #510)

> **Estado desta entrega (fatias E + F):** além do que as fatias B e C
> trouxeram (transporte de failpoint, `InvariantOracle`, FI-04/05/06/07 e
> FI-17/FI-18), existe agora o **`TurnDriver`** — o componente que injeta um
> inbound de VERDADE pela porta de produção e acompanha
> `mensagem_id`/`turn_id`/`conversa_id`/job da BullMQ — e com ele os **três
> cenários da família de ENTRADA (FI-01, FI-02 e FI-03)**, mais os **cinco da
> fatia F — FI-08, FI-09, FI-14, FI-15 e FI-16** — que cobrem a RECUPERAÇÃO
> (varredura concorrente, job retido), a POLÍTICA de poison/DLQ e as duas
> janelas de crash em volta do COMMIT DO OUTBOX. **14 dos 25 cenários estão
> implementados.** Os perfis `reliability:full`/`soak` continuam FORA. A issue
> #510 segue aberta — o inventário abaixo é o mapa honesto do que falta.

## Por que este harness existe

`FEATURE_TURN_CLAIM` passou a ter default **`true`** (`src/config/contract.ts`,
decisão do dono na #504): o claim atômico está implementado e **ligado em
produção desde o primeiro deploy**. Isso não afrouxa a necessidade deste
harness — inverte o ônus dela. Antes a pergunta era "podemos ligar?"; agora é
"o que está ligado sobrevive a um `SIGKILL` real?", e essa prova continua não
existindo: as suítes atuais simulam réplicas concorrentes **dentro de um mesmo
processo**, com `worker_id` distinto.

Um `throw` simulado ainda roda `finally`, ainda fecha o pool, ainda deixa o
heartbeat cancelar o timer. Um `SIGKILL` não roda nada disso — é exatamente por
isso que ele é o teste, e é exatamente isso que não existia no repositório.

## A decisão de infraestrutura: service containers, **não** Testcontainers

A issue manda escolher e documentar. A escolha é **reusar a infraestrutura já
provisionada** (service containers no CI, pilha compartilhada local) e isolar
por **banco Postgres + prefixo de fila**, não por container.

### O argumento

**1. O job que tem os serviços não tem o daemon.** O job `integration` do CI
(`.github/workflows/ci.yml`) sobe `pgvector/pgvector:pg16` e `redis:7-alpine`
como *service containers*. Service containers não dão um Docker daemon ao
passo que roda os testes — é o próprio `tests/integration/_fixtures/postgres-testcontainer.ts`
que documenta isso no cabeçalho ("the existing `integration` job uses service
containers and does NOT provide a Docker daemon — testcontainer-based specs
need a separate job"). Adotar Testcontainers aqui significaria um job novo, com
Docker-in-Docker, para o gate mais caro da fase 1.

**2. O custo se multiplica pelo número de suítes.** Um container por suíte
carrega o pull da imagem, o boot do Postgres e **as 125+ migrations**, todas
vezes. Reusar o servidor e criar só um *banco* por suíte paga as migrations uma
vez por banco e nada mais — é a mesma conta que a #571 já fez e mediu (~6.8s
para migrar um banco novo).

**3. A equivalência local/CI sai de graça, e é a MESMA função.** A #571 já
resolveu isolamento por worktree com banco próprio e db lógico do Redis próprio.
`ReliabilityEnvironment` chama `resolveTestEnv()` — a mesmíssima função que
`tests/setup.ts` e `tests/globalSetup.ts` chamam — e deriva o banco da suíte a
partir dela. Local e CI chegam ao mesmo lugar por construção, não por duas
configurações que alguém precisa manter em sincronia.

**4. O que Testcontainers daria a mais, nenhum cenário desta matriz precisa.**
A vantagem real dele seria isolar o *processo do servidor*. Nenhum FI-01..FI-25
derruba o Postgres inteiro; os que modelam "Postgres indisponível" (FI-06,
"heartbeat interrompido") derrubam a **conexão do worker**, que é fiel ao modo
como a falha acontece em produção — e não exige matar o servidor de todo mundo
numa máquina com ~60 worktrees ativas.

### O que a decisão NÃO faz

Não remove `@testcontainers/postgresql` do `package.json` nem toca na única spec
que o usa (`tests/integration/_fixtures/postgres-testcontainer.ts`). A decisão é
apenas que **este harness** não depende dele.

### O custo que a decisão aceita

Servidor compartilhado significa que uma faxina errada destrói trabalho alheio.
É por isso que `assertAlvoDestrutivo()` existe e é a função mais testada do
harness (`self-tests/environment.spec.ts`): perfil não-produção, host na lista,
marcador `_fi_` no nome do banco e prefixo `fi_<slug>` na fila — quatro
condições independentes, avaliadas **antes** de qualquer comando destrutivo, com
todos os motivos acumulados numa mensagem só.

## Inventário FI-01..FI-25 — o estado de cada cenário da matriz

A issue #510 exige 25 cenários nominais. Esta tabela é a fonte de verdade sobre
quais existem, e é atualizada a cada fatia. **`documentado` não é `implementado`:**
vários IDs aparecem em comentários e nos self-tests dos fakes sem que exista um
cenário que os execute — eles contam como FALTA aqui.

| ID | Falha injetada | Estado | Onde está / o que bloqueia |
|---|---|---|---|
| FI-01 | redelivery inbound | **feito** (fatia E) | `scenarios/fi-ingresso-enfileiramento.spec.ts` |
| FI-02 | crash pós-persist/pre-enqueue | **feito** (fatia E) | `scenarios/fi-ingresso-enfileiramento.spec.ts` |
| FI-03 | enqueue duplicado | **feito** (fatia E) | `scenarios/fi-ingresso-enfileiramento.spec.ts` |
| FI-04 | corrida de claim | **feito** (fatia B) | `scenarios/fi-claim-crash-fence.spec.ts` |
| FI-05 | crash pós-claim | **feito** (fatia B) | `scenarios/fi-claim-crash-fence.spec.ts` |
| FI-06 | heartbeat interrompido | **feito** (fatia B) | `scenarios/fi-claim-crash-fence.spec.ts` |
| FI-07 | stale completion | **feito** (fatia B) | `scenarios/fi-claim-crash-fence.spec.ts` |
| FI-08 | recovery concorrente | **feito** (fatia F) | `scenarios/fi-recuperacao-concorrente.spec.ts` |
| FI-09 | job failed retido | **feito** (fatia F) | `scenarios/fi-recuperacao-concorrente.spec.ts` |
| FI-10 | FIFO mesma stream | **falta** | o `TurnDriver` já injeta dois ingressos na MESMA stream; falta o cenário de promoção (`stream-promotion`) |
| FI-11 | paralelismo entre streams | **falta** | idem FI-10, com `criarAlvo()` distinto por stream |
| FI-12 | debounce concorrente | **falta** | exige `FEATURE_MESSAGE_DEBOUNCE` ligada no filho e dois closers de `stream-debounce` |
| FI-13 | retry head-of-line | **falta** | idem FI-10 |
| FI-14 | poison/DLQ | **feito** (fatia F) | `scenarios/fi-poison-dlq.spec.ts` |
| FI-15 | crash antes do outbox commit | **feito** (fatia F) | `scenarios/fi-outbox-commit-recuperacao.spec.ts` |
| FI-16 | crash pós-outbox/pre-enqueue | **feito** (fatia F) | `scenarios/fi-outbox-commit-recuperacao.spec.ts` |
| FI-17 | dois delivery workers | **feito** (fatia C) | `scenarios/fi-outbound-entrega.spec.ts` |
| FI-18 | provider aceita, ACK perdido | **feito** (fatia C) | `scenarios/fi-outbound-entrega.spec.ts` |
| FI-19 | crash pós-delivery persist | **falta** | exige o elo entrega→`completed` do turno |
| FI-20 | payload/key collision | **parcial** | o FAKE já recusa chave igual/hash diferente (`self-tests/fake-channel-provider.spec.ts`); falta exercer a `logical_dedupe_key` de PRODUÇÃO |
| FI-21 | deadline durante LLM | **parcial** | `FakeLlmServer` já observa `AbortSignal`; falta o cenário com o turno real |
| FI-22 | deadline antes da tool | **falta** | `after_llm_before_tool` sem call site |
| FI-23 | deadline após efeito possível | **falta** | `after_tool_effect_before_result_persist` sem call site |
| FI-24 | shutdown gracioso | **falta** | `ProcessSupervisor` já faz SIGTERM; falta o cenário com turnos ativos |
| FI-25 | isolamento adversarial | **falta** | o oracle já checa `tenant_id + agent_id`; falta o cenário de dois tenants |

**Resumo: 14 implementados, 2 parciais (infra pronta, cenário ausente), 9 sem
começar.** Fora da matriz nominal, continua faltando o cenário de duplicação
**entre JOBS no mesmo processo** (ver a seção sobre as duas formas de duplicação).

### O que REALMENTE bloqueia os 11 restantes

Não é volume de cenário — é que **10 dos 16 failpoints do catálogo não têm
SEAM**. Os seis pontos alcançáveis hoje por um caminho de produção são
`after_turn_claim_before_running` (fatia B), `after_outbound_claim_before_send`
e `after_provider_accept_before_delivery_persist` (fatia C),
`after_inbound_persist_before_enqueue` (fatia E), e
`after_response_built_before_outbox_commit` e
`after_outbox_commit_before_delivery_enqueue` (fatia F). Um cenário novo só é
honesto quando existe um SEAM de produção onde o gate cabe entre duas chamadas
reais — foi assim que FI-04..07 usaram `acquireTurnLease` + `markRunning`,
FI-17/18 usam `beginInlineDelivery` + `recordInlineDelivery`, FI-02 usa
`mensagensRepo.createInbound` + `enqueueAgent`, e FI-15/16 usam a construção da
resposta + `commitOutboundIntent`.

**O que é um SEAM, exatamente.** Não é um call site em `src/`: o catálogo mora
em `tests/` e o teste arquitetural proíbe que qualquer um dos 16 nomes apareça
em `src/`. É a existência, no caminho de produção, de duas chamadas SEPARADAS e
SEQUENCIAIS entre as quais o gate cabe — de modo que o fixture as componha na
mesma ordem em que a produção as compõe. `after_inbound_persist_before_enqueue`
virou alcançável sem nenhuma mudança em `src/` justamente porque
`src/gateway/baileys.ts` já chama as duas em sequência, e a janela entre elas é
a que `createReceivedTurnTx` documenta ("o Postgres grava `received`, o caller
tenta o enqueue").

**Uma correção de rota da fatia F.** Este arquivo dizia que
`after_response_built_before_outbox_commit` seria um ponto "DENTRO de uma
transação" e portanto inalcançável. Isso vale para o nome lido ao pé da letra
("dentro de `commitTurnOutboundTx`") e é falso para o ponto que a matriz
descreve: a resposta é CONSTRUÍDA pelo chamador e só então entregue a
`commitOutboundIntent` — `src/agent/output-dispatch.ts` faz exatamente isso em
cada limite de efeito. O intervalo entre as duas chamadas é um seam de produção
como qualquer outro. O mesmo vale para
`after_outbox_commit_before_delivery_enqueue`, entre o commit e o transporte.

Onde de fato não há seam (`during_llm_request`, os failpoints de TOOL — pontos
DENTRO de uma função), o cenário exige antes uma mudança de desenho no código
de produção, e essa mudança é uma decisão de dono, não de teste. É a razão pela
qual as fatias avançam por FAMÍLIA DE SEAM e não por ordem numérica de FI-ID.

## O que está entregue

| Componente | Arquivo | O que faz |
|---|---|---|
| `ReliabilityEnvironment` | `harness/environment.ts` | Banco + prefixo de fila por suíte, migrations pelo runner de produção, seeds de tenant/agent explícitos, faxina com tranca |
| `ProcessSupervisor` | `harness/process-supervisor.ts` | Filhos de verdade, handshake de prontidão, SIGTERM com escalada, **hard kill por PID exato**, saída inesperada reprova o cenário |
| `eventually` / `estavelDurante` | `harness/eventually.ts` | Espera por condição com prazo e diagnóstico; nunca `sleep` cego |
| `ArtifactCollector` | `harness/artifacts.ts` | Timeline monotônica, stdout/stderr por processo, snapshots — tudo sanitizado |
| Sanitizador | `harness/sanitize.ts` | Telefone, JID, segredo, connection string e conteúdo de usuário |
| Catálogo de failpoints | `harness/failpoints.ts` | 16 nomes tipados (Zod), gate determinístico, impossível de habilitar em produção |
| Seed reproduzível | `harness/seeded-faults.ts` | xorshift128 semeado por string; `--seed=` reproduz a ordem dos kills |
| `FakeLlmServer` | `fakes/fake-llm-server.ts` | Roteiro de respostas, delay, stream parcial, erro, rate limit, **aborto observável** |
| `FakeChannelProvider` | `fakes/fake-channel-provider.ts` + `-server.mjs` | Processo separado, ledger com `physical_call_count` × `logical_effect_count` |
| **`FailpointServer`** | `harness/failpoint-transport.ts` | HTTP em loopback com porta efêmera e token por rodada; resposta DIFERIDA (é o handshake) e **barreira** de largada |
| **`alcancar` / `barreira`** | `harness/failpoint-client.ts` | O lado do FILHO: custo zero com a injeção off, `error`/`disconnect`/`kill` quando on |
| **`congelar` / `descongelar`** | `harness/process-supervisor.ts` | `SIGSTOP`/`SIGCONT` por PID exato — a falha que o `SIGKILL` não modela |
| **`InvariantOracle`** | `oracles/invariant-oracle.ts` | Foto durável (turno, outbound, audit) + checagens PURAS por família |
| **Cenários FI-04/05/06/07** | `scenarios/fi-claim-crash-fence.spec.ts` | Réplicas de PROCESSO contra Postgres real, com barreira, `SIGKILL` e `SIGSTOP` |
| **Cenários FI-17/FI-18** | `scenarios/fi-outbound-entrega.spec.ts` | Claim de ENTREGA disputado por processos, e o efeito não repetido através de um `SIGKILL` |
| **`replica-de-entrega.ts`** | `fixtures/replica-de-entrega.ts` | O filho que chama `beginInlineDelivery`/`recordInlineDelivery` REAIS e fala com o provider por HTTP |
| **`TurnDriver`** | `harness/turn-driver.ts` | Injeta inbound pela porta de produção, semeia linha/pessoa/conversa, acompanha `mensagem_id`/`turn_id`/`conversa_id`/job da BullMQ e espera estado terminal com `eventually` |
| **`esperarParadoEm`** | `harness/failpoint-transport.ts` | Espera o filho ESTACIONAR no gate antes de qualquer `liberar`/`hardKill` — "chegou" e "estacionou" são fatos diferentes, e soltar um gate vazio devolve 0 (#707) |
| **`motor-de-turno.ts`** | `fixtures/motor-de-turno.ts` | O filho que chama `createInbound`, `enqueueAgent` e `runMessageRecovery` REAIS |
| **Cenários FI-01/02/03** | `scenarios/fi-ingresso-enfileiramento.spec.ts` | Reentrega do mesmo evento, `SIGKILL` entre o commit e o enqueue, e o mesmo `turn_id` enfileirado por 4 processos |
| **Cenários FI-15/FI-16** | `scenarios/fi-outbox-commit-recuperacao.spec.ts` | As duas janelas de crash em volta do commit do outbox, e a varredura que recupera o artefato órfão |
| **Cenários FI-08/FI-09** | `scenarios/fi-recuperacao-concorrente.spec.ts` | Dois sweepers de PROCESSO sobre o mesmo lote, e o job determinístico retido em `failed` |
| **Cenário FI-14** | `scenarios/fi-poison-dlq.spec.ts` | A política de poison decidindo entre LIBERAR e INTERDITAR a conversa, com as duas pontas no mesmo caso |
| **`replica-de-commit.ts`** | `fixtures/replica-de-commit.ts` | O filho que reivindica o turno e chama `commitOutboundIntent` REAL, com gate antes e depois |
| **`replica-de-varredura.ts`** | `fixtures/replica-de-varredura.ts` | O filho que roda `runOutboundRecoveryForScope` REAL e ANUNCIA o lote que leu |
| **`replica-de-veneno.ts`** | `fixtures/replica-de-veneno.ts` | O filho que esgota as tentativas por `failTurnRetryable` REAL e deixa a política decidir |

## Como os failpoints são impossíveis de habilitar em produção

Três trancas independentes, e a primeira é estrutural:

1. **O catálogo mora em `tests/`.** `tsconfig.json` tem `include: ["src/**/*"]`
   e `exclude: [..., "tests"]`, então ele **não entra em `dist/`**. Não é uma
   flag desligada; é código ausente do artefato. `self-tests/failpoints.spec.ts`
   afirma o `exclude` para que ele não mude sem alguém notar.
2. **Nenhum nome do catálogo aparece em `src/`.** O teste arquitetural varre
   todo o `src/` e reprova se qualquer um dos 16 identificadores — ou o prefixo
   `TEST_RELIABILITY_` — aparecer lá. Uma mensagem de WhatsApp não pode acionar
   um failpoint cujo identificador não existe no código que a processa.
3. **`assertFailpointsAllowed()` recusa em produção sem opt-out.**
   `MAIA_ENV`/`NODE_ENV` em `production` fecha a porta *antes* de olhar flag ou
   token — nem argumento, nem variável, nem token a abrem.

### A armadilha de namespace de env

`src/config/validate.ts:249` **rejeita** qualquer chave `MAIA_*`/`FEATURE_*` que
não exista no contrato, e uma variável no `env:` de um job do CI alcança **todo**
processo daquele job. Isso já custou 498 falhas de CI aqui.

Por isso as variáveis deste harness usam o prefixo **neutro `TEST_`**:
`TEST_RELIABILITY_FAILPOINTS`, `TEST_RELIABILITY_FAILPOINT_TOKEN`,
`TEST_RELIABILITY_FAILPOINT_URL`, `TEST_RELIABILITY_SEED`,
`TEST_RELIABILITY_ALLOWED_DB_HOSTS`, `TEST_RELIABILITY_QUEUE_PREFIX`.
**Nenhuma mudança em `src/config/contract.ts` foi necessária, e nenhuma deve
ser feita para elas.**

## Como rodar os self-tests

A lane inteira (self-tests + cenários), com `--retry=0` para que nenhum flake
seja absorvido em silêncio:

```bash
npm run test:reliability
```

Só os self-tests, na lane padrão e sem infraestrutura:

```bash
npx vitest run tests/reliability/self-tests --no-coverage
```

Os casos que exigem Postgres + Redis são o ciclo de vida completo do
`ReliabilityEnvironment` (`environment.spec.ts`), o coletor do
`InvariantOracle` e **todos os cenários FI** — os três fazem `describe.skip`
sem `TEST_DB_URL`. **`pulado` não é `passou`** — o bloco de diagnóstico impresso ao
fim de toda rodada traz os três números.

Que a prova mais perigosa (a tranca da faxina) rode **sem** infraestrutura é
deliberado: ela é uma função pura sobre a URL e o prefixo, e assim é verificada
em todo PR, não só no job que tem banco.

## O primeiro consumidor fora dos self-tests (#513, fatia D)

`tests/integration/channel-session-sigkill-duas-replicas-real-db.spec.ts` usa
`ProcessSupervisor`, `eventually`/`estavelDurante` e o `ArtifactCollector` para
provar a posse de linha da #513 com duas réplicas de **processo** e um `SIGKILL`
de verdade. O filho é `tests/reliability/fixtures/replica-de-canal.ts`, e ele
importa `@/gateway/channel-lease.js` — reescrever o SQL no fixture deixaria a
suíte verde com o `WHERE` de produção apagado.

Duas armadilhas encontradas ali, que valem para todo cenário futuro:

**1. Não suba o filho pelo CLI do `tsx`.** `node node_modules/tsx/dist/cli.mjs
filho.ts` **spawna um neto** para aplicar os flags do loader. O PID que o
`ProcessSupervisor` registra passa a ser o do invólucro, e o `hardKill` mata o
invólucro enquanto o processo que segura a lease continua batendo heartbeat —
um teste de `SIGKILL` que não mata o processo certo. Use
`NODE_OPTIONS='--import tsx'` com o `.ts` como `script`: o loader entra no
MESMO processo. E afirme `carga.pid === filho.pid` no handshake, para que a
premissa seja cobrada em vez de assumida.

**2. Cuidado com o nome do campo no probe.** `sanitizarValor()` redige por
substring do nome, e `token` está na lista. Um probe de `estavelDurante` com um
campo `…token…` compara `[REDACTED]` com `[REDACTED]` e passa **sempre**.
`claim_token` (#504) e `fencing_token`/`session_fencing_token` (#513) estão nas
exceções explícitas do sanitizador por causa disso; um nome novo dessa família
precisa entrar lá — ou o probe precisa de outro nome.

## Limites declarados dos fakes

**`FakeChannelProvider` é MAIS FORTE que o WhatsApp real:** honra a chave de
idempotência de verdade e para sempre. O Baileys não oferece essa garantia — o
`messageID` do cliente reduz, não elimina, duplicata em reconexão. Um cenário
que passe aqui não prova exactly-once contra o provider real.

**E MAIS FRACO:** não modela rate limit por número, ban, perda de sessão,
reordenação de ACK entre dispositivos, nem os erros de mídia do upload real.

**`FakeLlmServer` nunca chama a internet** — não há caminho de saída no módulo,
e `self-tests/fake-llm-server.spec.ts` afirma isso lendo o próprio fonte.

## Fatia B — o que a injeção passou a saber fazer, e o que ela PROVA

Um harness de fault injection é fácil de fazer vácuo: injeta a falha, nada
quebra, e o teste passa afirmando nada. A regra desta fatia, e a que todo
cenário novo tem de seguir: **para cada falha injetada, a reação do sistema é
observada positivamente, e existe um caso de controle em que ela não deveria
acontecer.**

| Falha que o harness injeta | Como | Reação PROVADA | Onde |
|---|---|---|---|
| duas réplicas disputam o mesmo turno | barreira solta as duas juntas | o `UPDATE` atômico do claim concede a UMA: um `acquired`, um recusado com motivo, `attempt_count = 1` | FI-04 |
| morte abrupta do dono, num ponto EXATO | gate `pause` + `SIGKILL` por PID | a lease vence e o sucessor assume (`attempt_count = 2`, token novo); **antes** do prazo ele é recusado | FI-05 |
| heartbeat interrompido com o processo VIVO | `SIGSTOP` | a lease vence pelo relógio do banco mesmo com o dono vivo, e o sucessor assume | FI-06 |
| o dono deposto volta e tenta gravar | `SIGCONT` + gate liberado | `WHERE claim_token = …` recusa com `conflict: 'stale_claim'`; a linha não se move | FI-07 |
| falha sintética no meio do caminho | gate `error` | `FailpointInjectedError` chega ao call site | self-test |
| desconexão cooperativa | gate `disconnect` | o call site recebe a ação e decide o que derrubar | self-test |
| suicídio no failpoint | gate `kill` (`SIGKILL` no próprio pid) | nenhum `finally` roda — a linha seguinte e a do `finally` NUNCA aparecem | self-test |

### E como se sabe que os cenários não são vácuo

Cada um foi verificado com uma **sonda vermelha no call site de PRODUÇÃO**: o
defeito é reintroduzido, o vermelho é observado, o defeito é revertido. As três
sondas e o que cada uma derruba estão no corpo da PR da fatia B; em resumo:

- apagar a condição `lease_expires_at <= now()` do takeover ⇒ **FI-04 e FI-05
  vermelhos** (duas réplicas ganham; o sucessor entra na primeira tentativa);
- apagar o ramo de takeover inteiro ⇒ **FI-05 e FI-06/07 vermelhos** (ninguém
  jamais assume);
- apagar `claim_token` do fence em `turn-fence-sql.ts` ⇒ **FI-06/07 vermelho**
  (a gravação do zumbi passa: `ok: true, conflict: null`).

O oracle e o transporte têm sondas equivalentes sobre si próprios.

### A barreira NÃO é um failpoint

`ROTA_BARREIRA` existe porque a issue exige que corridas sejam liberadas "por
barrier/gate, não por sleep". Duas réplicas que só sobem e tentam produzem um
vencedor por ordem de boot — quem terminou de importar o grafo de módulos
primeiro —, e isso não é corrida, é sorteio de tempo de import. Ela fica FORA do
catálogo de failpoints de propósito: o catálogo é a lista fechada dos pontos que
a PRODUÇÃO tem, e uma barreira não é um deles.

### Por que o cliente devolve `kill`, mas o cenário prefere `hardKill`

Um `SIGKILL` que o próprio filho dispara em `process.pid` é, por construção, o
próprio PID — não há risco de acertar processo alheio. Ele é útil quando a morte
precisa acontecer com janela zero. Nos cenários, porém, o padrão é `pause` +
`ProcessSupervisor.hardKill`: o filho fica PARADO no failpoint (bloqueado no
`await fetch`), então a morte é igualmente exata e ainda passa pelas duas
trancas do supervisor — PID do registro e filho vivo. O cenário precisa chamar
`autorizarSaida()` antes, senão o supervisor trata a morte que ele mesmo pediu
como saída inesperada, que é o comportamento certo.

## Fatia C — a família de SAÍDA, e o contador que sobrevive ao crash

A fatia B provou a posse do TURNO. A fatia C prova a da ENTREGA, que é onde o
erro custa caro: um turno reivindicado duas vezes gasta CPU, mas uma entrega
enviada duas vezes **chega duas vezes ao destinatário**.

| Falha que o harness injeta | Como | Reação PROVADA | Onde |
|---|---|---|---|
| dois delivery workers na mesma linha | barreira solta os dois juntos | o `UPDATE` atômico de `tryClaimDelivery` concede a UM; o outro leva `DeliveryFenceError`; `attempt = 1` | FI-17 |
| provider aceita, conexão cai, worker MORRE | `accept_then_drop` + `SIGKILL` no gate 2 | a linha fica em `sending`; o sucessor é ESTRUTURALMENTE incapaz de reenviar e grava `cancelled_after_send_unknown` | FI-18 |

### Por que o provider precisa viver FORA do processo

Esta é a razão de a fatia existir, e não é estilo. A suíte in-process que já
existe (`tests/integration/outbound-delivery-claim-lease-fence-real-db.spec.ts`)
é boa, mas três coisas nela são simuladas:

1. o "crash" é apenas **parar de chamar funções** — o processo nunca morre, e
   todo `finally`, pool e timer continuam intactos;
2. o vencimento da lease é **forçado** por
   `UPDATE … lease_expires_at = now() - interval '1 second'`;
3. o contador de chamadas do provider vive **no mesmo processo do worker**.

O item 3 é o fatal. Quando a pergunta é "o worker morreu com a chamada em voo;
o sucessor reenviou?", um contador in-process **deixa de existir exatamente no
instante que interessa**. O ledger de `fake-channel-provider-server.mjs` roda
noutro PID e sobrevive ao `SIGKILL`, então `physical_call_count` continua
legível depois da morte — e é ele que responde à pergunta.

### Como se sabe que FI-17 e FI-18 não são vácuo

Duas **sondas vermelhas no call site de produção**
(`src/db/repositories/outbound-delivery-repo.ts`), cada uma revertida e o verde
reconfirmado:

**Sonda 1 — apagar a trava estrutural do `sending`.** Trocar
`status = CASE WHEN status = 'sending' THEN 'sending' ELSE 'claimed' END` por
`status = 'claimed'` faz **FI-18 ficar vermelho**, e o vermelho é literalmente o
dano:

```
estavelDurante("o sucessor NÃO chama o provider uma segunda vez") observou
MUDANÇA dentro da janela de 3000ms. Antes: 1. Depois: 2.
```

`Antes: 1. Depois: 2.` é o destinatário recebendo a mensagem duas vezes.

**Sonda 2 — apagar a exclusão do claim.** Trocar o bloco
`AND (status IN (…claimable…) … OR status IN (…takeover…) AND lease_expires_at <= now())`
por `AND (true)` faz **FI-17 ficar vermelho** em `attempt`:

```
AssertionError: expected 2 to be 1
  ❯ expect(linha.attempt).toBe(1)
```

E o diagnóstico do filho mostra o mecanismo: **as duas réplicas reivindicaram**
(`attempt` foi a 2), e a que perdeu só foi barrada mais adiante, pelo fence do
`markSending`. Ou seja, a sonda revelou que há **duas camadas independentes** de
defesa nesse caminho, e que FI-17 detecta a perda da PRIMEIRA mesmo quando a
segunda ainda segura. Um cenário que só olhasse "quantos enviaram?" teria ficado
verde e escondido a regressão.

### O que estes dois cenários NÃO provam

`FakeChannelProvider` honra a chave idempotente **para sempre**, e o WhatsApp
real não. FI-18 prova que o SUT não reenvia por conta própria; ele não prova
exactly-once contra o Baileys. Ver "Limites declarados dos fakes".

## As DUAS formas de duplicação, e por que o harness precisa distinguir

Uma correção de rota que vale registrar, porque ela muda quais cenários valem a
pena escrever a seguir.

O contrato de concorrência de schedulers (#513, `src/workers/job-contract.ts`)
declara lacunas em `unguarded` — jobs com efeito externo não idempotente e sem
claim. É tentador tratar toda lacuna declarada como alvo de fault injection.
Não é: **cinco delas já foram fechadas e a declaração ficou para trás**
(`pending_expirer` e `workflow_engine_tick` ganharam compare-and-swap na #691;
os três `briefing_*` passaram a comprometer o aviso em `outbox_messages` sob
`dedupe_key` na #692). Injetar concorrência nesses cinco mediria uma proteção
que já existe achando que expõe um buraco — vácuo com sinal trocado. Se forem
cobertos, que seja pela afirmação certa: **dois disparos concorrentes produzem
UM efeito**.

As que continuam abertas de verdade são nove: `conversation_summarizer`,
`pattern_detector`, `legacy_memory_reclassifier`, `procedure_candidate_consumer`,
`knowledge_state_promoter`, `drift_monitor`, `gap_escalation_monitor`,
`tool_request_issue_relayer` e `tool_request_closure_monitor`. A mais cara é
`tool_request_issue_relayer`: o efeito duplicado dela é **abrir duas issues no
GitHub**.

E há uma distinção que o harness ainda não sabe fazer, e precisa:

- **duplicação entre RÉPLICAS** — dois processos rodando o mesmo tick. É a forma
  que FI-04..FI-07 já injetam. Hoje ela é LATENTE, não atual: produção roda um
  processo só (`MAIA_PROCESS_ROLE=all`; o split `scheduler`/`worker` está atrás
  do perfil `split-roles`, desligado).
- **duplicação entre JOBS DISTINTOS no mesmo processo** que compartilham um
  efeito. É a que acontece HOJE — foi exatamente a forma do bug de dual approval
  que a #691 fechou. O harness não tem cenário para ela, e ela não se reduz à
  primeira: matar réplica não a reproduz, porque não há réplica envolvida.

## Fatia E — a família de ENTRADA, e o driver que faltava

A fatia B provou a posse do TURNO; a fatia C, a da ENTREGA. A fatia E prova o
que vem ANTES das duas: que a mensagem entra UMA vez, que ela não se perde num
crash entre o commit e o enqueue, e que N enfileiramentos do mesmo trabalho
viram um job só.

| Falha que o harness injeta | Como | Reação PROVADA | Onde |
|---|---|---|---|
| o MESMO evento chega a duas réplicas de processo | barreira solta as duas juntas, com o mesmo `whatsapp_id` | `createInbound` persiste UM ingresso e cria UM turno; a perdedora recebe a MESMA `mensagem_id` com `duplicate: true` e NENHUM turno | FI-01 |
| morte abrupta entre o commit e o `enqueueAgent` | gate `after_inbound_persist_before_enqueue` + `SIGKILL` por PID | o turno fica em `received`, a mensagem não processada, zero jobs; `runMessageRecovery()` rearma EXATAMENTE UM | FI-02 |
| o mesmo `turn_id` enfileirado 8 vezes por 4 processos | barreira solta os quatro juntos | a fila fica com UM job (`turn-<uuid>`), e ele é claimável uma vez só (`attempt_count = 1`) | FI-03 |

### Por que o `TurnDriver` existe, e o que ele NÃO faz

Os cenários das fatias B e C começam do MEIO: `turnoNovo()` e `saidaNova()` são
`INSERT`s diretos, e podem ser, porque o que estava sob prova era o CLAIM.
FI-01/02/03 não podem — o que está sob prova é a FRONTEIRA DE ENTRADA, e um
`INSERT` fabricado responderia sobre o `INSERT` do teste.

O driver **observa**; quem **executa** é sempre um processo filho. A razão é
específica desta fatia: `ReliabilityEnvironment` cria um banco exclusivo da
suíte, e o processo do vitest continua apontando para o banco da worktree. Um
driver que chamasse `mensagensRepo.createInbound` dentro do runner escreveria no
banco ERRADO e o cenário afirmaria sobre linhas que ninguém leu.

O que o driver faz no processo do teste é ler — um `pg.Pool` no banco da suíte e
a fila `agent` REAL —, e as duas leituras usam vocabulário de PRODUÇÃO
(`parseAgentTurnJob`, `isTerminalTurnStatus`), porque uma cópia dessas listas
continuaria verde depois de a produção mudar.

### A flake que esta fatia expôs na FI-05, e a correção

Acrescentar um terceiro arquivo de cenário à lane aumenta o paralelismo, e isso
tornou visível uma corrida LATENTE na FI-05 (fatia B), reproduzida em 2 de 7
rodadas:

```
AssertionError: o sucessor entrou na PRIMEIRA tentativa — a lease do morto não
barrou nada: [{"tentativa":1,"result":"acquired","attempt":2,…}]:
expected 0 to be greater than or equal to 2
```

Nada da produção mudou. O que mudou foi o TEMPO: o sucessor era spawnado DEPOIS
do `SIGKILL`, então o import a frio do grafo de produção sob `tsx` (2s a 7s,
§7.1 do `AGENTS.md`) corria contra o TTL de 6s da suíte. Numa máquina carregada a
lease vencia antes de o sucessor terminar de importar, ele entrava na primeira
tentativa, e o CONTROLE das recusas ficava vermelho medindo o import em vez da
lease.

A correção é subir o sucessor ANTES da morte e segurá-lo numa BARREIRA: o import
é pago enquanto o dono ainda está vivo e parado no gate, e a primeira tentativa
acontece milissegundos depois do `SIGKILL`. Não é afrouxar o cenário — a sonda
vermelha da fatia B continua valendo: apagar `lease_expires_at <= now()` do
takeover deixa **FI-04 e FI-05 vermelhos**, e o vermelho de FI-05 continua sendo
literalmente `o sucessor entrou na PRIMEIRA tentativa`.

### O único relógio fabricado desta fatia, e o controle que o torna honesto

`TurnDriver.envelhecerTurno` faz um `UPDATE` no `created_at` do turno.
`STUCK_AFTER_MS` (`src/workers/message-recovery.ts`) é 2 minutos e não tem env
que a parametrize; esperá-los de verdade transformaria a lane num soak.

O que o `UPDATE` fabrica é a IDADE da linha, e só ela: estado, regra de
elegibilidade (`findRecoverableTurns`) e produtor do job (`enqueueAgent`)
continuam sendo os de produção. E o cenário não pede que se acredite nisso —
**FI-02 roda o varredor ANTES do envelhecimento e afirma que ele não rearma
nada**. É essa asserção que separa "envelheci a linha" de "desliguei a checagem".

### Como se sabe que FI-01, FI-02 e FI-03 não são vácuo

Três **sondas vermelhas no call site de produção**, cada uma revertida e o verde
reconfirmado (`git diff src/` vazio depois de cada uma):

**Sonda 1 — desligar a dedup de ingresso.** Fazer o `findExisting` de
`mensagensRepo.createInbound` devolver `null` sempre deixa só a unique do banco
de pé, e ela vira CRASH em vez de dedup. **FI-01 vermelho:**

```
Error: o motor "ingresso-b" falhou antes de terminar a ação: Error: duplicate key
value violates unique constraint "uniq_mensagens_channel_whatsapp"
```

**Sonda 2 — apagar o ramo `received`/`queued` do filtro de recovery.** Trocar
`and(inArray(status, ['received','queued']), lte(created_at, cutoff))` por
`sql\`false\`` em `findRecoverableTurns` faz o varredor enumerar o par e não achar
nada. **FI-02 vermelho:**

```
EventuallyTimeoutError: eventually("o varredor de produção rearma UM job para o
turno órfão") estourou em 30000ms após 298 tentativa(s) em 30078ms. Último valor
observado: undefined. Estado no momento da falha: [].
```

**Sonda 3 — apagar o `jobId` determinístico.** Trocar
`const jobId = data.turn_id ? agentTurnJobId(data.turn_id) : undefined` por
`undefined` em `enqueueAgent` faz **FI-03 E FI-02 ficarem vermelhos**, e o
vermelho de FI-03 é literalmente o dano — oito jobs para um turno:

```
EventuallyTimeoutError: eventually("8 enfileiramentos do mesmo turno colidem num
job") estourou em 30000ms … Estado no momento da falha: [{"id":"9",…},{"id":"8",…},
{"id":"7",…},{"id":"6",…},{"id":"5",…},{"id":"4",…},{"id":"3",…},{"id":"2",…}]
```

E o de FI-02 mostra a segunda face do mesmo defeito — o job rearmado deixa de
ser o do turno:

```
AssertionError: expected '1' to be 'turn-758b8b7d-c395-4b5c-9433-44dbeb36…'
```

A sonda 3 é a razão de `TurnDriver.jobsDoTurno` varrer a fila e classificar o
PAYLOAD em vez de perguntar `getJob(agentTurnJobId(turn_id))`: com o id
determinístico apagado, o `getJob` não acharia nenhum dos oito e o vermelho
seria "0 to be 1" — verdadeiro, e mudo sobre a causa.

## Fatia F — a RECUPERAÇÃO, a POLÍTICA e as duas janelas do commit

As fatias B e C provaram a POSSE (do turno e da entrega). A fatia F prova o que
acontece quando a posse não basta: quando o processo morre **fora** de uma
janela protegida por lease, quando **dois** processos de recuperação decidem
sobre a mesma linha, quando o **transporte** está entupido, e quando a
plataforma tem de **escolher** entre liberar a conversa e interditá-la.

| Falha que o harness injeta | Como | Reação PROVADA | Onde |
|---|---|---|---|
| dois sweepers sobre o mesmo lote | barreira solta os dois juntos, e os dois ANUNCIAM o lote que leram | uma decisão por linha: `dead_lettered` somado entre as duas réplicas é 2 para 2 linhas, UMA `audit_log` por linha, UM job por linha rearmada | FI-08 |
| job determinístico retido em `failed` | o job é criado pela BullMQ e movido para `failed` pelas chaves | `enqueueOutboundDelivery` remove o cadáver e rearma — e NÃO toca no job `waiting` | FI-09 |
| M1 esgota as tentativas | `failTurnRetryable` com `attempt_count` no teto, duas vezes, com códigos de erro de categorias diferentes | a política DECIDE: `effect_committed` interdita a conversa (linha em `agent_stream_blocks`, `stream_poisoned` na auditoria, claim seguinte recusado com `stream_poisoned`); `model` libera (nada disso, e o claim seguinte passa) | FI-14 |
| `SIGKILL` com a resposta pronta e o outbox vazio | gate `after_response_built_before_outbox_commit` + `hardKill` | nenhuma linha do outbox nasce; o sucessor assume depois do prazo e commita UMA, e o segundo commit da MESMA saída lógica devolve `inserted: false` | FI-15 |
| `SIGKILL` depois do commit e antes do transporte | gate `after_outbox_commit_before_delivery_enqueue` + `hardKill` | a linha fica `pending` e sem job; a varredura de produção a rearma num job de id determinístico; o ciclo de entrega real produz UM efeito no ledger — e a varredura seguinte não produz um segundo | FI-16 |

### Como se sabe que os cinco não são vácuo

Cinco **sondas vermelhas em call site de PRODUÇÃO**, cada uma aplicada,
observada, revertida (`git diff -- src/` vazio) e com o verde reconfirmado:

| Cenário | Defeito reintroduzido em `src/` | Vermelho LITERAL |
|---|---|---|
| FI-08 | `deadLetterTx`: `AND status IN (…)` → `AND true` (`outbound-recovery-repo.ts`) | `dead letter aconteceu 4 vezes para 2 linhas … expected 4 to be 2` |
| FI-09 | `enqueueOutboundDelivery`: `clearRetainedOutboundJob(jobId)` apagado (`gateway/queue.ts`) | `o job continua RETIDO em failed — nenhum tick da varredura consegue rearmar esta linha: expected 'failed' to be 'waiting'` |
| FI-14 | `deadLetterTurn`: `poisonDisposition(...)` → `'release'` fixo (`turns/lifecycle.ts`) | `a conversa do efeito irreversível NÃO foi interditada: expected [] to have a length of 1 but got +0` |
| FI-15 | `commitTurnOutboundTx`: `.onConflictDoNothing()` apagado (`outbound-outbox-repo.ts`) | `eventually("o sucessor commita a mesma saída lógica duas vezes") estourou em 30000ms` — e o stdout do filho traz o `##harness-fatal##` com a violação de unique |
| FI-16 | `sweepDeliverable`: `await enqueueOutboundDelivery(...)` apagado, `stats.rearmed += 1` MANTIDO (`workers/outbound-recovery.ts`) | `expected { existe: false, naFila: +0 } to deeply equal { existe: true, naFila: 1 }` |

A sonda de FI-16 é deliberadamente a mais má: ela deixa a varredura CONTINUAR
reportando `rearmed: 1` e só remove o efeito. Um cenário que confiasse no
número que o próprio sweeper devolve ficaria verde; o que olha a fila fica
vermelho. É a mesma régua da fatia C — medir o EFEITO, não o relato.

A sonda de FI-15 revelou uma segunda camada, como a sonda 2 da fatia C: sem a
idempotência da `logical_dedupe_key`, a segunda tentativa não cria uma linha
duplicada em silêncio — ela ESTOURA no unique `outbound_messages_turn_sequence_uq`
(migração 121), e o commit falha fechado. As duas defesas são independentes, e
FI-15 detecta a perda da primeira mesmo com a segunda ainda de pé.

### O que a fatia F mudou no harness, e por quê

**`esperarParadoEm` é usado em todo gate novo.** O primitivo é da #707 (que o
criou depois de a FI-17 reprovar no CI: `liberar()` sobre gate vazio devolve
`0`, e o cenário passava a esperar por um efeito que ninguém ia produzir).
FI-15 e FI-16 param processos em gates e usam `esperarParadoEm` antes de
qualquer `hardKill` ou `liberar` — a regra desta lane passa a ser: **nunca aja
sobre um gate sem antes provar que existe alguém parado nele.**

**A regra de posse do oracle, no TERMINAL.** `turno.claim_completo` cobrava o
tuplo `(claim_token, claimed_by, lease_expires_at)` completo ou vazio. A
conclusão terminal de produção libera token e lease e PRESERVA `claimed_by`
("a posse morre com a tentativa; `claimed_by` fica para a forense",
`turn-repos.ts`), então a regra acusaria TODO turno concluído — e FI-14, o
primeiro cenário desta lane a levar um turno até `dead_letter`, encontrou isso.
No terminal vale a invariante mais forte: `turno.posse_liberada_no_terminal` —
nenhuma posse VIVA sobrevive ao fim do turno. Os dois casos estão nos
self-tests do oracle.

**A ordem "sucessor antes do crash" (FI-05 e FI-15).** Um controle de takeover
("antes do prazo ele é RECUSADO") que sobe o sucessor DEPOIS do `SIGKILL`
depende de o import a frio do grafo de produção caber dentro do TTL da lease —
1.9s–6.8s de import contra 6s de TTL. Em cinco rodadas seguidas da lane, a
FI-15 escrita assim reprovou em QUATRO, e a FI-05 (fatia B, mesma construção)
reprovou em uma: o sucessor terminava de importar depois do vencimento e
entrava na PRIMEIRA tentativa, sem nunca ter sido barrado — o controle sumia
sem que ninguém tivesse mexido em produção. Os dois cenários passaram a subir o
sucessor ANTES do crash e a observar as recusas com o dono PROVADAMENTE vivo. O
controle fica mais forte, não mais frouxo: "recusado enquanto o dono vive" é
uma afirmação melhor que "recusado antes de um prazo".

### Isolamento de FILA, e o que ele NÃO é

As filas de produção (`src/gateway/queue.ts`) são construídas no import com o
prefixo `bull` padrão; não existe env que troque o prefixo sem mexer em `src/`.
O que isola FI-08/FI-09/FI-16 é (a) o **db lógico do Redis exclusivo da
worktree** (#571) e (b) o **`jobId`**, que é
`outboundDeliveryJobId(<uuid da rodada>)` — um valor que nenhuma outra árvore
pode produzir. Toda leitura e toda limpeza destes cenários miram ids da própria
rodada. **Nenhuma varre prefixo de fila**, e isso é regra: uma varredura por
prefixo num Redis compartilhado por dezenas de árvores é dano cruzado, não
faxina.

O limite declarado: se a alocação de slots do Redis (#571) reciclar o db desta
árvore no meio de uma rodada, um consumidor alheio poderia drenar um job destes
cenários. O sintoma seria FI-09/FI-16 vermelhos com o job sumido — e a resposta
é olhar a alocação de slots, não afrouxar a asserção.

### O que estes cinco cenários NÃO provam

- **FI-16 não roda o CONSUMIDOR da fila.** Ele prova que a varredura arma UM
  job com o id determinístico e que o ciclo de entrega REAL, sobre aquela
  linha, produz UM efeito. Quem tira o job da fila e chama o ciclo é o worker
  de `FEATURE_OUTBOUND_DELIVERY_WORKER`, e ele fica fora do cenário — subir um
  worker BullMQ aqui consumiria a fila de qualquer outra árvore que
  compartilhasse o db lógico.
- **FI-15 prova que nenhum envio era POSSÍVEL**, não que um envio foi impedido:
  sem linha durável não existe nada que o ciclo de entrega possa reivindicar. A
  afirmação sobre um provider que sobrevive ao crash é de FI-16 e FI-18.
- **FI-08 prova a exclusão entre RÉPLICAS do sweeper.** A duplicação entre JOBS
  DISTINTOS no mesmo processo continua sem cenário (ver a seção sobre as duas
  formas de duplicação).
- **FI-14 usa a política DEFAULT** (`TURN_POISON_BLOCK_CATEGORIES=effect_committed`),
  declarada pelo cenário em vez de herdada. Ele não varre as seis categorias —
  isso é papel dos testes unitários de `poison-policy.ts`.

## O que falta para fechar a #510

Ver o **Inventário FI-01..FI-25** no topo deste arquivo para o estado de cada
cenário. Em resumo, o que ainda falta:

1. os failpoints de TOOL e os de dentro do LLM continuam sem SEAM; com os dois
   que a fatia C alcançou, o que a fatia E alcançou e os dois da fatia F, são
   **10** os que faltam;
2. os 11 cenários restantes da matriz — e, fora dela, a duplicação ENTRE JOBS no
   mesmo processo (ver a seção sobre as duas formas de duplicação);
3. a família FIFO (FI-10..FI-13) deixou de estar bloqueada pelo `TurnDriver`: o
   que falta nela agora é o cenário de PROMOÇÃO de stream e o closer de debounce
   em processos separados;
4. perfis `reliability:full` / `soak` (o script `npm run test:reliability` existe
   e roda a lane inteira com `--retry=0`, e o job `fault injection (#510)` do CI
   já é blocking com piso `--min 1 --max-pulados 0`);
5. runbook de reprodução por FI-ID/seed e o template de cenário novo.
