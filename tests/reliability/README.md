# Harness de fault injection para turnos (issue #510)

> **Estado desta entrega (fatia B):** passos 1–4 do rollout continuam valendo, e
> agora existem também o **transporte de failpoint** (o lado do processo filho),
> o **`InvariantOracle`** e os **quatro primeiros cenários da matriz — FI-04,
> FI-05, FI-06 e FI-07**. Os outros 21 cenários, os perfis
> `reliability:full`/`soak` e o gate blocking de CI continuam FORA. A issue #510
> segue aberta.

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

## O que falta para fechar a #510

1. `TurnDriver` (injetar inbound de verdade e acompanhar IDs pelo pipeline);
2. os failpoints do caminho de OUTBOUND e de TOOL — hoje o único ponto de
   injeção com call site real é `after_turn_claim_before_running`, alcançado
   pelo fixture; os outros 15 nomes do catálogo continuam sem call site;
3. FI-01/02/03, FI-08 a FI-25;
4. perfis `reliability:full` / `soak` e o gate blocking de CI (o script
   `npm run test:reliability` existe e roda a lane inteira com `--retry=0`);
5. runbook de reprodução por FI-ID/seed e o template de cenário novo.
