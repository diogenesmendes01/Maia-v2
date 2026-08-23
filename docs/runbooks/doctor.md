# Runbook — `maia doctor`

> Diagnóstico **read-only** do ambiente (issue #517). Roda dentro do container
> já de pé, abre conexão com as dependências e devolve um veredito acionável
> com exit code estável. Não conserta nada.

```bash
npm run doctor                              # offline: runtime + configuração (sai 3, INCOMPLETO)
npm run doctor -- --online                  # + liveness de Postgres e Redis
npm run doctor -- --online --format json
npm run doctor -- --online --strict         # warnings também saem 1
npm run doctor -- --online --only postgres
npm run doctor -- --help
```

> **O modo offline nunca sai 0.** Ele não abre conexão, portanto não exerce
> nenhum bloqueador de dependência, portanto não prova prontidão. O veredito é
> `INCOMPLETO` com exit `3` — ver §3. Como gate, use `--online`.

**Dentro da imagem de produção**, sem alteração de Dockerfile: a imagem já leva
`scripts/`, `src/`, `tsconfig.json`, `migrations/` e `tsx` (que é dependência de
runtime, não de dev) — o mesmo caminho pelo qual o job de migration roda
`scripts/migrate.ts`.

```bash
docker compose -f compose.prod.yml exec app npm run doctor -- --online
docker compose -f compose.prod.yml run --rm --entrypoint sh app -c \
  'npm run doctor -- --online --format json'
```

---

## 1. Quatro coisas que respondem "dá para operar?" — e não se substituem

A confusão entre elas é o erro mais caro deste terreno, porque três delas rodam
perto do boot. A tabela é a fronteira:

| | Quando roda | O que abre | O que afirma |
|---|---|---|---|
| **preflight de configuração** | ANTES do `docker compose up` | nada — é puro | Os **arquivos** (`compose.prod.yml` + `.env.*`) montam, para cada serviço, um ambiente que satisfaz o subset do contrato do loader dele. Um `BACKUP_S3_BUCKET` sintaticamente válido apontando para um bucket inexistente **passa**. |
| **`maia doctor`** | com o ambiente de pé, sob demanda | Postgres, Redis (só com `--online`) | O ambiente **que este processo realmente recebeu** satisfaz o contrato, e as dependências estão **vivas, na versão certa e com a política certa**. |
| **`/readyz`** | continuamente, por instância | o pool da própria app | Esta instância pode receber tráfego AGORA. Cacheado, barato, binário. |
| **sonda sintética (#472)** | continuamente, após o deploy | o caminho vivo inteiro | Uma mensagem real atravessa o sistema e volta. É a única que prova comportamento. |

Um quinto item mora ao lado e é o mais fácil de confundir com o doctor porque
também roda antes do boot: o **gate de migration** (#516) — job one-shot que
responde uma pergunta só, "o schema está pronto?". O doctor **consome** o
veredito desse gate (`getSchemaReadiness()`), não o reimplementa.

### Por que o doctor não substitui o preflight

Eles olham **snapshots diferentes do mesmo contrato**. O preflight lê os
arquivos na máquina do operador e reconstrói o que cada container *receberia*;
o doctor lê o que o processo *recebeu*. Uma substituição de orquestrador que
produziu string vazia, um secret montado no caminho errado, um `docker run -e`
que o compose nunca mencionou, um container velho iniciado com um `.env`
anterior — nada disso é visível pelos arquivos, e tudo é visível de dentro.

Na direção contrária: o preflight pega o problema **antes de existir
container**, que é a hora barata. O doctor só pode falar depois.

Quando os dois discordam, **a discordância é o achado**.

---

## 2. Matriz de checks

Ordem do relatório = ordem do registry: primeiro o que responde sem socket.

| ID | Criticidade | Rede | O que um `pass` afirma |
|---|---|---|---|
| `runtime.node_version` | blocker | não | O processo roda em Node >= o piso de `engines.node`. |
| `config.contract` | blocker | não | O ambiente **deste container** satisfaz o subset do contrato do serviço (`--service`, default `runtime`). |
| `config.admin_boot_gates` | blocker¹ | não | Os gates de boot **próprios do admin-ui** — mais estritos que o contrato — estão satisfeitos. |
| `postgres.connectivity` | blocker | sim | O banco responde `SELECT 1` dentro do deadline. |
| `postgres.read_only_session` | blocker | sim | As consultas do doctor rodam em transação READ ONLY **imposta pelo servidor**. |
| `postgres.server_version` | blocker | sim | O servidor é PostgreSQL >= 16. |
| `postgres.pgvector` | blocker | sim | A extensão `vector` está INSTALADA neste banco (não apenas disponível). |
| `postgres.schema_readiness` | blocker | sim | O schema aplicado é compatível com esta build: head, `dirty`, `running` órfão, checksum divergente, checksum desconhecido, migration que o banco aplicou e a build não empacota. |
| `postgres.clock_drift` | advisory | sim | Os relógios deste processo e do servidor não divergiram além de 2s. |
| `redis.connectivity` | blocker | sim | O Redis responde `PING`. |
| `redis.server_version` | advisory | sim | O servidor é Redis >= 7. |
| `redis.maxmemory_policy` | blocker | sim | A política de eviction não permite despejo **cross-tenant**. |
| `redis.memory_pressure` | advisory | sim | A memória usada está longe do cap. |
| `redis.persistence` | advisory | sim | Há AOF **configurado**, ou uma regra `save` não vazia, e o último save não falhou. |

¹ `config.admin_boot_gates` degrada para `warn` no profile `development`, onde
o console não aplica os gates. Ele retorna `skip` quando nenhuma variável do
admin-ui está presente — "não há console aqui" não é um `pass`. É o **único**
`skip` marcado `not_applicable` no registry, e por isso o único que não leva a
rodada a `INCOMPLETO` (§3).

### `config.admin_boot_gates` — o gate que o contrato não vê

O contrato pede `NEXTAUTH_SECRET` com `min(8)` e apenas *presença* de
`OIDC_CLIENT_SECRET`. O boot do console
(`src/admin-ui/lib/auth-gating.ts`) é mais estrito: `NEXTAUTH_SECRET` >= 32
chars e `OIDC_CLIENT_SECRET` >= 16. Um `config check` verde com um
`NEXTAUTH_SECRET` de 12 caracteres é honesto e ainda assim o console não sobe.
Esse é o buraco que este check fecha, e é a razão de ele existir aqui e não no
contrato.

Os dois pisos são **cópias** — `src/admin-ui` está fora do `tsconfig.json` da
raiz e nada em `src/` importa naquela direção. `tests/unit/ops/doctor-checks.spec.ts`
lê `auth-gating.ts` como texto e reprova divergência.

### `redis.maxmemory_policy` — um check de isolamento vestido de ops

Sob qualquer `allkeys-*`, o Redis evicta por tempo ocioso apenas: a escrita do
tenant B pode derrubar a working memory do tenant A, e prefixo de chave não
protege contra o evictor. Por isso é **blocker**, não advisory. A classificação
segue [`redis.md` §4](redis.md):

| Política | Verdicto |
|---|---|
| `noeviction` | `pass` (o pin de `compose.prod.yml`) |
| `volatile-*` | `warn` — as chaves da BullMQ não têm TTL de chave, então sob pressão ele evicta um subset e falha o write mesmo assim |
| `allkeys-*` | `fail` — vetor de despejo cross-tenant |
| `noeviction` com `maxmemory=0` | `warn` — sem cap, `noeviction` nunca dispara e o Redis cresce até o OOM killer do host |

### `redis.persistence` — configuração, não "o último save deu certo"

`rdb_last_bgsave_status` é o resultado da última **tentativa** de snapshot, não
a prova de que existe snapshot agendado. Uma instância com `save ""` reporta
`ok` para sempre — não houve tentativa que falhasse. Por isso o check lê
`CONFIG GET save` (já na allowlist read-only; `CONFIG SET` não está e não
entra) e só considera RDB ligado quando existe **regra não vazia**:

| AOF | `save` | Verdicto |
|---|---|---|
| ligado | — | `pass`, ou `fail` se `aof_last_write_status: err` |
| desligado | vazio (`save ""`) | `warn` — não persiste nada; a fila BullMQ some no restart |
| desligado | regra presente | `pass`, ou `fail` se `rdb_last_bgsave_status: err` |
| desligado | parâmetro ausente na resposta | `skip` — sem permissão para responder, e isso não é um `pass` |

---

## 3. Saída e exit codes

### Humano

```text
maia doctor — profile production · v3.1.0 · a1b2c3d4e5f6 · online
run_id 5d0e6c1e-…

[PASS] runtime.node_version                   1ms  Node 22.13.0
[PASS] postgres.connectivity                 18ms  conectado em 18ms
[FAIL] postgres.schema_readiness              64ms  schema is below the minimum this build supports…
       state: blocked
       expected_head: 118_x.sql
       applied_head: 116_y.sql
       blockers: schema_below_minimum
       Fix: Rode o job de migration desta release ANTES de subir a aplicação…
[WARN] redis.maxmemory_policy                  1ms  maxmemory-policy=volatile-lru: aceitável, mas…

11 pass · 1 warn · 1 fail · 1 skip — 214ms
NÃO PRONTO — há bloqueador
```

Uma rodada incompleta nomeia **quais** bloqueadores ficaram sem resposta:

```text
0 pass · 0 warn · 0 fail · 6 skip — 1ms
INCOMPLETO — 5 bloqueador(es) não foram exercidos: postgres.connectivity, …
O modo offline não abre conexão alguma. Rode com `--online` para exercer a liveness das dependências.
```

Evidência de check que passou só aparece com `--verbose`.

### JSON (`--format json`)

Contrato versionado em `schema_version` (hoje `1.1`), aditivo: um campo novo
sobe o MINOR; renomear ou remover um existente sobe o MAJOR. Envelope:
`run_id`, `started_at`, `profile`, `app_version`, `commit`, `online`, `strict`,
`ok`, `verdict`, `timed_out`, `duration_ms`, `summary`, `checks[]`. Cada check
traz `id`, `category`, `criticality`, `status`, `summary`, `skip_kind`,
`duration_ms`, `timed_out`, `evidence`, `remediation`.

`1.1` acrescentou `verdict` (`ready` | `incomplete` | `not_ready`) e
`skip_kind` (`unproven` | `not_applicable` | `null`). `ok` continua existindo e
continua booleano — o que mudou foi **quando** ele é `true`: uma rodada que
pulou um bloqueador selecionado dizia `ok: true` e não diz mais. Isso é correção
de defeito, não quebra de contrato. Prefira `verdict` a `ok`: só ele distingue
"reprovou" de "não respondeu".

O `run_id` é aleatório **por execução** e serve só para correlacionar o
relatório humano com o JSON da mesma rodada. Não é identificador de nada
persistido: o doctor não escreve auditoria.

### Veredito e exit codes

O veredito tem **três** valores e sai de **uma** função — `verdictFor()` em
`src/ops/doctor/runner.ts`. O exit code e a última linha do relatório humano
são duas renderizações dela, e é por isso que não podem discordar (já
discordaram: com `--strict` o shell recebia `1` e o texto dizia `PRONTO`).

| Veredito | Exit | Significado |
|---|---|---|
| `PRONTO` | `0` | Todo bloqueador **selecionado** foi exercido e passou. Warnings permitidos (com `--strict`, nenhum). |
| `NÃO PRONTO` | `1` | Um bloqueador **reprovou** — ou, com `--strict`, existe warning/falha advisory. Provamos que não dá. |
| `INCOMPLETO` | `3` | A rodada terminou, mas um bloqueador selecionado **não foi exercido**. Não provamos nada sobre ele. |
| — | `2` | Uso inválido, ou o próprio doctor quebrou. **O gate não rodou.** |

**Por que `INCOMPLETO` tem código próprio.** Nenhum dos vizinhos carrega esse
significado com honestidade: `0` seria um verde sobre uma dependência que
ninguém tocou (era exatamente o defeito — `--online --only postgres` sem
`DATABASE_URL` pulava os seis checks e imprimia `PRONTO`), `1` afirmaria que
encontramos um defeito quando encontramos um ponto cego, e `2` afirmaria que o
doctor quebrou quando ele funcionou perfeitamente. Um pipeline que promove
apenas com `code === 0` não precisa de mudança alguma e continua correto nos
quatro casos.

**O que leva a `INCOMPLETO`** — qualquer `skip` num check `blocker`:

| Situação | Exemplo |
|---|---|
| modo offline | `npm run doctor` sem `--online` |
| handle ausente com `--online` | ver abaixo: isto virou `fail`, não `skip` |
| `--skip` de um bloqueador | `--skip postgres.connectivity` |
| dependência não satisfeita | `postgres.pgvector` depois de `postgres.connectivity` pular |
| o próprio check não conseguiu responder | `redis.maxmemory_policy` sem `maxmemory-policy` no `CONFIG GET` |

**A única exceção**, e ela é sobre o AMBIENTE, não sobre o nosso alcance: um
`skip` marcado `not_applicable`. Hoje existe um só —
`config.admin_boot_gates` quando **nenhuma** variável do admin-ui está
presente: não há console aqui, então não há gate de console por satisfazer.
Está no tipo (`DoctorSkipKind` em `src/ops/doctor/types.ts`), o default é o
estrito (`unproven`), e cada uso de `notApplicable()` é uma afirmação
revisável.

**`--online` sem DSN é `fail`, não `skip`.** Se o operador pediu liveness e a
CLI não conseguiu abrir o pool (`DATABASE_URL`/`REDIS_URL` ausente ou vazia), o
check de conectividade **reprova** — a pergunta foi feita e a resposta é "não
dá para responder daqui". Offline continua sendo `skip`, porque ali a pergunta
não foi feita.

---

## 4. Read-only: o que garante, e como

Não é uma promessa de disciplina; são dois mecanismos que o servidor impõe e um
que o código impõe.

**Postgres — servidor.** O pool do doctor (`doctorPostgresPool`) conecta com
`default_transaction_read_only=on` e **toda** consulta roda dentro de
`BEGIN READ ONLY … ROLLBACK`. Um `INSERT`/`UPDATE`/`DELETE`/DDL é recusado com
SQLSTATE `25006` independentemente do que o autor do check escreveu. Os dois são
redundantes de propósito: remover qualquer um deles ainda deixa um doctor que
não escreve. `tests/integration/doctor-real-deps.spec.ts` prova a recusa contra
um banco real e checa que a linha não apareceu.

O próprio relatório carrega a prova: `postgres.read_only_session` imprime
`transaction_read_only` a cada execução.

**O caminho do schema tem a mesma costura.** `getSchemaReadiness()` (#516)
precisa de um cliente e de várias consultas, o que o handle estreito não
oferece — então ele passa por `withReadOnlySchemaTransaction()`
(`src/ops/doctor/schema.ts`), que abre o MESMO `BEGIN READ ONLY`, aplica
`SET LOCAL statement_timeout` **menor que o deadline do check** (4s contra 10s,
e o caminho de leitura emite no máximo duas consultas), e devolve o cliente de
qualquer jeito no fim. Antes disso esse adapter entregava um cliente cru: sem
transação, sem timeout de statement, e uma leitura travada segurava o cliente
até `pool.end()` — o comando estourava tanto o prazo do check quanto o total.
Quando o deadline dispara, a conexão é **destruída** em vez de devolvida ao
pool: devolver um cliente com consulta em voo é o que faz `pool.end()` esperar,
e fechar o socket é também o que cancela o statement no servidor.
`tests/integration/doctor-real-deps.spec.ts` empurra uma mutação por esse
adapter (SQLSTATE `25006`) e trava uma leitura com `pg_sleep`, medindo que o
processo termina dentro do orçamento.

**Redis — allowlist fechada.** Redis não tem modo read-only por conexão, então
a garantia é de código: `PING`, `INFO`, `DBSIZE`, `CONFIG GET`, e nada mais.
`CONFIG` é chaveado por **subcomando** — `CONFIG SET` é outra entrada, e não
está na lista. Não existe canário `SET`/`DEL` para "provar" conectividade.

**O que o doctor nunca toca.** `checkAll()` e qualquer repositório que grave
health ou auditoria; job BullMQ; socket de WhatsApp; migration; arquivo; chamada
faturável de LLM.

---

## 5. Deadlines, dependências e determinismo

- **Dois deadlines.** Cada check tem o seu; a rodada tem um total
  (`--timeout`, default 30s). O check corre contra
  `AbortSignal.any([total, próprio])` e o sinal é **passado para dentro** do
  check, para que quem sabe cancelar cancele.
- **Timeout é resultado explícito**, nunca silêncio: `fail` + `timed_out`, com
  qual dos dois prazos estourou na evidência.
- **Dependência que não passou vira `skip`, não `fail`** — e só nos dependentes.
  Com o Postgres morto, os checks de Redis continuam rodando; é isso que impede
  uma indisponibilidade de apagar o resto do diagnóstico.
- **`skip` nunca é sucesso** — e, num bloqueador, ele agora é ativamente
  `INCOMPLETO` (§3). Aparece em quatro situações e todas dizem o motivo: modo
  offline com check de rede, dependência não satisfeita, `--skip` explícito
  (que ainda imprime `DESABILITADO`) e o check que não conseguiu obter o dado.
- **A saída é determinística.** Checks rodam com concorrência limitada, mas o
  relatório sai sempre na ordem do registry.

---

## 6. Secrets

Todo texto visível ao operador passa por `scrubSecrets()`
(`src/config/redact.ts`) no render — resumo, cada valor de evidência e cada
linha de remediação. É defesa em profundidade: os checks são escritos para
nunca interpolar um secret, mas o que vaza não é a string que escrevemos, é a
mensagem de driver que encaminhamos (a do `pg` embute o DSN inteiro, com senha).

Erros de adapter viram **classe**, nunca mensagem, exatamente por isso. Por essa
razão a maioria dos `fail` de conectividade mostra `ECONNREFUSED` /
`ETIMEDOUT` / `28P01` em vez de prosa.

---

## 7. Diagnóstico por sintoma

| Sintoma | Leitura | Ação |
|---|---|---|
| `config.contract` reprova com 10+ variáveis | O container recebeu um ambiente incompleto | Corrija **todas** de uma vez; a lista é completa até o limite de exibição. Se os arquivos estiverem certos, o container está velho: `up -d --force-recreate` |
| `config.contract` verde, `admin_boot_gates` reprova | O contrato está satisfeito e o console ainda não sobe | Gere um `NEXTAUTH_SECRET` >= 32 chars; pegue o `OIDC_CLIENT_SECRET` real no IdP |
| `postgres.connectivity` `ECONNREFUSED` | Serviço fora, ou rede errada | Confirme o serviço de pé e que o container está na mesma rede do compose |
| `postgres.connectivity` `28P01` | Autenticação | Usuário/senha do `DATABASE_URL` |
| `postgres.connectivity` `3D000` | Banco inexistente | Nome do banco no `DATABASE_URL` |
| `postgres.pgvector` reprova com `available: true` | Extensão disponível, não instalada | Rode o migrator — a migration 001 faz `CREATE EXTENSION` |
| `schema_readiness` = `missing_file` | O banco aplicou uma migration que esta build não empacota | Uma release mais nova migrou este banco. **Não** suba esta build; ver [`migrations.md`](migrations.md) |
| `schema_readiness` = `dirty` / `checksum_mismatch` | Exige reparo explícito e auditado | `migrate repair` — o doctor é read-only e nunca repara |
| `redis.maxmemory_policy` reprova | Política `allkeys-*` | Troque para `noeviction`; ver [`redis.md`](redis.md) §4 |
| `postgres.clock_drift` avisa | Relógios divergentes | Sincronize NTP: leases, dedup e expiração comparam timestamps entre processos |
| `redis.persistence` avisa `save` vazio | Snapshotting DESLIGADO; `rdb_last_bgsave_status: ok` não contradiz isso | Ligue `--appendonly yes` (o pin de produção) ou configure uma regra `save`. Sem isso a fila BullMQ some no restart |
| exit `2` | O gate não rodou | Leia a mensagem de uso; não interprete como ambiente ruim |
| exit `3` | O gate rodou e **não provou** o que foi pedido | Veja a linha `INCOMPLETO`: ela nomeia os bloqueadores não exercidos. Rode com `--online`, ou pare de `--skip`ar um bloqueador |

---

## 8. Fora de escopo (hoje)

Declarado, não esquecido — cada item precisa de uma peça que ainda não está no
lugar:

- **Prontidão de tenant/agente.** O readiness canônico é
  `src/onboarding/readiness.ts` e a invariante da issue proíbe reproduzi-lo como
  heurística na CLI. Consumi-lo exige um caminho de leitura read-only sobre o
  drizzle `db` singleton, que hoje não existe.
- **Filas BullMQ** (pending/failed, oldest job, heartbeat de worker). Exigiria
  ampliar a allowlist do Redis e depender do contrato de nomes de fila.
- **Backup / RPO / restore drill.** `evaluateBackupReadiness()`
  (`src/ops/backup/rpo.ts`) já existe e é o consumo natural; falta o mesmo
  caminho de leitura read-only sobre o banco.
- **Providers em `--online`.** Só vale com endpoint de metadata não faturável;
  sem isso o resultado honesto é `skip`, e um `skip` que nunca vira `pass` não
  paga o seu custo ainda.
- **Espaço em disco, `pg_dump`/`pg_restore` presentes, diretórios de auth/mídia.**
  Barato, mas pertence à mesma leva do backup.

---

## Relacionados

- [`migrations.md`](migrations.md) — o gate de migration e o `repair`
- [`redis.md`](redis.md) — política de eviction e pressão de memória
- [`config-contract.md`](config-contract.md) — boot falhando por configuração
- [`deploy-prod.md`](deploy-prod.md) — a sequência de bring-up
- [`synthetic-probe.md`](synthetic-probe.md) — a sonda que exercita o caminho vivo
- Código: `src/ops/doctor/`, `scripts/doctor.ts`
