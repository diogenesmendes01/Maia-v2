# Harness de fault injection para turnos (issue #510)

> **Estado desta entrega:** passos 1–4 do rollout da issue — primitives, fakes e
> self-tests. **Nenhum cenário FI-01..FI-25 está implementado.** O
> `InvariantOracle`, os perfis `reliability:pr`/`full`/`soak` e qualquer gate
> blocking ficaram FORA. A issue #510 continua aberta.

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

Eles rodam na lane padrão, sem infraestrutura:

```bash
npx vitest run tests/reliability/self-tests --no-coverage
```

O único caso que exige Postgres + Redis é o ciclo de vida completo do
`ReliabilityEnvironment` (`environment.spec.ts`), que faz `describe.skip` sem
`TEST_DB_URL`. **`pulado` não é `passou`** — o bloco de diagnóstico impresso ao
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

## O que falta para fechar a #510

1. `InvariantOracle` (turno, FIFO, outbound, segurança, operação);
2. `FailpointController` do lado do processo filho (o `FailpointGateRegistry`
   já é o lado do cenário; falta o transporte e os pontos de injeção);
3. `TurnDriver`;
4. FI-01 a FI-25;
5. perfis `reliability:pr` / `full` / `soak` e o gate blocking;
6. runbook de reprodução por FI-ID/seed e o template de cenário novo.
