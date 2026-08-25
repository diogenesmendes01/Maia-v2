# Runbook — Deploy de produção (`compose.prod.yml`)

> Auditoria P0 cap. 6. Produção NUNCA usa `docker-compose.yml` (compose de
> dev: portas de datastore no host, fallback `maia/maia`, Redis sem auth,
> `.env` inteiro em todos os containers, processos root).

> **Não deploya por Compose?** O gate de migration da #516 é feito de
> primitivas do Compose e não sobrevive fora dele. O equivalente para
> Coolify está em [§7](#7-deploy-fora-do-compose--coolify-issue-565), que
> começa dizendo o que ali foi executado e o que não foi.

## 0. Pré-voo OBRIGATÓRIO: smoke do job `migrate` na imagem real

```bash
npm run smoke:migrate:image
```

**Gate bloqueante antes do primeiro rollout, e gate permanente de release**
(job `smoke-migrate-image` em `.github/workflows/ci.yml`). Precisa de Docker
e de rede para o build; leva alguns minutos.

O que ele faz, e por que nada mais cobre isso:

- constrói a imagem de **produção real** (`Dockerfile`, sem substituição);
- sobe um Postgres **efêmero** e confirma que ele está vazio;
- roda o comando **real** do job (`npm run db:migrate`) dentro dela, como
  **uid 1001**, com **rootfs read-only** e `/tmp` em tmpfs — as mesmas
  condições que `compose.prod.yml` impõe ao serviço `migrate`;
- exige saída 0, eventos `migration.applied` no stdout e um ledger com
  exatamente tantas migrations `applied` quantas a imagem empacota;
- repete o run contra o banco já no head e exige saída 0 de novo.

`tests/unit/migrations/compose-migrate-job.spec.ts` prova que os arquivos de
Compose **dizem** a coisa certa. Nada ali executa o comando, e o que só a
execução responde é: `npm run db:migrate` é `tsx scripts/migrate.ts`, o
`tsx` resolve `@/*` em runtime lendo `tsconfig.json`, e ele cria
`/tmp/tsx-<uid>` **antes de carregar o primeiro módulo**. Dois exemplos
medidos, ambos com o job saindo != 0 e portanto segurando `app`/`admin-ui`
fora do ar via `service_completed_successfully`:

| Se sumir da imagem | O job morre com |
|---|---|
| `COPY tsconfig.json` (Dockerfile) | `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/config' imported from /app/scripts/migrate.ts` |
| `tmpfs: - /tmp` (compose) | `Error: ENOENT: no such file or directory, mkdir '/tmp/tsx-1001'` |

O smoke não tem flag de bypass nem fallback de imagem: ele constrói
`Dockerfile` e nada mais. Um gate com escape hatch é um gate que um dia
passa pelo escape hatch.

## 1. Bring-up

```bash
cd /opt/maia   # checkout do repo no host

# Env por serviço (uma vez; rotacione depois conforme política)
cp .env.app.prod.example .env.app       && chmod 600 .env.app
cp .env.admin.prod.example .env.admin   && chmod 600 .env.admin
# preencha ambos — placeholders __SET_ME__ são rejeitados no boot.
# Desde a issue #572, `cp` + preencher os `__SET_ME__` É o conjunto completo:
# os exemplos declaram TODAS as chaves que o profile `production` exige.
# Quem prova isso é o preflight abaixo — não este comentário.

# Credenciais de infra — usadas SÓ para interpolação do compose
cat > .env.infra <<'EOF'
POSTGRES_USER=maia_prod
POSTGRES_PASSWORD=<openssl rand -hex 24>   # URL-safe, min 8 chars
POSTGRES_DB=maia
REDIS_PASSWORD=<openssl rand -hex 24>
MAIA_ENV=production                        # OBRIGATÓRIA — ver abaixo
EOF
chmod 600 .env.infra

# Pré-voo de configuração — OBRIGATÓRIO, e antes do `up`
npm run config:preflight

docker compose --env-file .env.infra -f compose.prod.yml up -d --build
docker compose --env-file .env.infra -f compose.prod.yml ps
```

### O pré-voo de configuração (`npm run config:preflight`, issue #572)

```
$ npm run config:preflight
Maia config preflight — compose.prod.yml (interpolação: .env.infra)

── serviço migrate → loaders migrator · env_file: (nenhum)
  · subset migrator
    Maia config — profile production (contrato 1.0.0, hash 895b4af7779cc842)
    OK: nenhuma inconsistência encontrada.

── serviço app → loaders runtime · env_file: .env.app
  ...

── serviço admin-ui → loaders admin-ui · env_file: .env.admin
  · subset admin-ui
    ...
  · gates de boot do admin-ui (src/admin-ui/lib/auth-gating.ts)
    OK: comprimentos e padrões aceitos (isto NÃO testa o IdP).
```

Sai **0** quando os três ambientes efetivos satisfazem o contrato, e **1** com
a lista completa de problemas quando não. Rode-o depois de preencher os
`__SET_ME__` e **antes** do `up`: é a diferença entre corrigir um `.env` na sua
frente e descobrir a falta no boot de um container, depois de o `migrate` já ter
saído com sucesso e o gate `service_completed_successfully` ter liberado a
subida.

**Por que não `config:check --env-file .env.app`.** Porque ele dá falso
positivo. O container `app` não recebe só o `.env.app`: `compose.prod.yml`
injeta `DATABASE_URL`, `REDIS_URL`, `POSTGRES_*`, `NODE_ENV` e `MAIA_ENV` pelo
`environment:`, interpolados do `.env.infra`. Checar uma fonte só erra dos dois
lados — acusa como ausente o que o compose injeta, e não vê o que o compose
sobrescreve. E `config check` valida o contrato INTEIRO, então reprovaria o
`migrate` (que de propósito recebe só o subset `migrator`) por variáveis que ele
nunca deve ver. O preflight compõe as duas fontes na precedência do Compose
(`env_file` primeiro, `environment:` por cima) e valida **cada serviço contra
TODOS os subsets que o processo daquele container avalia no boot** — o mesmo
`validateConfig` do boot.

“Todos”, e não “o loader nominal”, é o ponto — e a lista do `admin-ui`
encolheu de dois subsets para um na **issue #596**. Entre a #572 e a #596 o
container do console importava `src/config/env.ts` (direto em
`src/admin-ui/trpc/tool-enablement.ts` e
`src/admin-ui/trpc/routers/tools-catalog.ts`, e via `@/db/client.ts`), aquele
singleton chama `validateConfig({ service: 'runtime' })`, e o preflight tinha de
validar **`runtime` + `admin-ui`** para não ficar verde num `.env.admin` que
derrubava o container. A #596 removeu a causa: os módulos compartilhados entre
os dois containers leem o contrato por
[`src/config/contract-env.ts`](../../src/config/contract-env.ts), nenhum import
do console alcança o singleton, e o `admin-ui` volta a ser validado contra
**`admin-ui`** mais os **gates de boot próprios do console**.

Ele lê o compose com o mesmo parser subset estrito das specs de #516
(`src/config/compose-env.ts`) e a interpolação COMPLETA do
`compose-go/template` — `$$`, `$VAR`, `${VAR}`, `${VAR:-d}`, `${VAR-d}`,
`${VAR:+r}`, `${VAR+r}`, `${VAR:?m}`, `${VAR?m}` —, inclusive **dentro dos
`env_file`**, que o `docker compose` também interpola (aspas simples continuam
literais). Um `.env.infra` sem `MAIA_ENV` **falha no preflight**, na mesma linha
em que o `up` abortaria; uma forma que o parser não reconheça **lança**, em vez
de resolver diferente do Compose.

`tests/unit/config/compose-config-differential.spec.ts` compara o ambiente
reconstruído com o que o `docker compose config` REAL resolve (o subcomando
`config` não precisa de daemon). É a única medição do preflight que não passa
pelo parser dele — sem ela, os dois lados do teste poderiam errar juntos.

**Execução HERMÉTICA, e o shell.** A interpolação sai do `.env.infra` e de mais
nada. O `docker compose`, porém, dá **precedência ao ambiente exportado no
shell** sobre o `--env-file`. Então o preflight compara: toda variável
**referenciada por interpolação** que esteja exportada no seu shell **com valor
diferente** do `.env.infra` é reportada como divergência e **reprova** o
comando, com o nome da variável (nunca o valor) e a instrução de `unset` ou de
alinhar o arquivo. Sem isso, um `export MAIA_ENV=staging` esquecido faria o
preflight certificar um ambiente e o `up` subir outro.

"Referenciada" é a **união** do YAML com os `env_file`, e não só o YAML: o
Compose interpola `${…}` dentro de um `env_file` e o ambiente do projeto
(`--env-file` + shell) vence até as chaves definidas no próprio arquivo. Um
`.env.admin` com `NEXTAUTH_URL=https://${DOMAIN}/admin` e um `DOMAIN` exportado
diferente do `.env.infra` mudaria a URL que o `up` materializa sem que `DOMAIN`
apareça em lugar nenhum do `compose.prod.yml`. Referência em **comentário** e
valor entre **aspas simples** não contam — o Compose não interpola nem um nem
outro, e um alarme falso permanente é um alarme que se aprende a ignorar.

Argumentos: `--compose <arquivo>` (default `compose.prod.yml`), `--infra
<arquivo>` (default `.env.infra`), `--profile <p>` para forçar um profile e
`--json` para saída de máquina.

#### O que o preflight NÃO cobre

Um verde aqui **não** é promessa de que os containers sobem. Ele é a garantia de
que o **contrato** está satisfeito. Fora do alcance dele:

| Não cobre | Onde isso aparece |
|---|---|
| **Conectividade.** Nada abre conexão com Postgres, Redis, S3 ou IdP. Um `BACKUP_S3_BUCKET` sintaticamente válido apontando para bucket inexistente passa. | `maia doctor` (issue #517); a primeira run do `nightly_backup` |
| **A CONECTIVIDADE do IdP.** Os gates de boot do admin-ui (comprimento de `NEXTAUTH_SECRET` e `OIDC_CLIENT_SECRET`, padrões de placeholder, `https://` do issuer) **passaram a ser cobertos** — `src/config/admin-boot-gates.ts`, espelhado com teste de paridade. O que continua fora é se o issuer existe, se o client é válido e se o IdP responde. | `maia doctor` (issue #517); a primeira tentativa de sign-in |
| **O `.env.infra` além da interpolação.** Ele é lido para resolver `${…}`; o preflight não julga a força da senha do Postgres. | — |
| **Qualquer coisa que o operador passe direto ao `docker compose` na linha de comando** (`-e`, `--env-file` extra). O preflight lê os arquivos, não a invocação. Variáveis do SHELL são a exceção: elas são detectadas e reprovam (ver acima). | — |
| **Migrations, imagem e runtime.** O smoke do §0 é quem cobre isso. | `npm run smoke:migrate:image` |

#### O boot do console valida o subset `admin-ui` (issue #596)

Vale dizer isto em voz alta, porque MUDOU o que "reprova no boot" significa para
o container do console.

**Até a #596**, o `admin-ui` importava `src/config/env.ts` — direto em
`src/admin-ui/trpc/tool-enablement.ts` e
`src/admin-ui/trpc/routers/tools-catalog.ts`, e transitivamente via
`@/db/client.ts` — e esse singleton valida o contrato com
**`service: 'runtime'`**. Isso cortava dos DOIS lados:

- as `OIDC_*` são `services: ['admin-ui']`, ou seja, estavam FORA daquele subset
  — o `requiredIn` delas nunca era avaliado, e o `validateConfig` descarta
  achados cross-field sobre variáveis fora do escopo do serviço pedido
  ([`src/config/validate.ts`](../../src/config/validate.ts)). Com as quatro
  ausentes, o console **subia** e entregava a tela "no providers configured";
  o literal `default` em `OIDC_TENANT_SLUGS` passava pelo mesmo motivo;
- e o subset `runtime` INTEIRO era cobrado do container do console, inclusive
  chaves que ele nunca usa (`WHATSAPP_*`, `OWNER_*`, chave de LLM, `VOYAGE_*` e
  as seis `BACKUP_*`, credencial de S3 incluída).

**Desde a #596**, as duas pontas estão fechadas, e no CÓDIGO:

- [`src/admin-ui/instrumentation.ts`](../../src/admin-ui/instrumentation.ts) é o
  hook que o Next.js aguarda em `BaseServer.prepare()` ANTES do primeiro
  request. Ele chama `assertAdminBootConfig()`
  ([`src/admin-ui/lib/boot-config.ts`](../../src/admin-ui/lib/boot-config.ts)),
  que roda `loadAdminConfig()` (subset `admin-ui`: `requiredIn` das quatro
  `OIDC_*` e a regra `admin-ui/tenant-slugs-default-literal`) mais os gates
  próprios do console (`resolveSecret()` / `oidcProviderEnabled()`). `register()`
  que lança = container que **não serve**. O `next build` não passa por aqui (o
  Next pula o hook em `phase-production-build`), então a imagem continua
  construível sem `.env.admin`.
- os módulos COMPARTILHADOS pelos dois containers (`@/db/client.ts`,
  `@/lib/logger.ts`, `@/lib/llm-settings.ts`, `@/governance/idempotency.ts`,
  `@/control-plane/runtime-trace/lib/hmac.ts`, `@/gateway/staging-crypto.ts`,
  `@/config/feature-flags.ts`) leem o contrato por
  [`src/config/contract-env.ts`](../../src/config/contract-env.ts) — uma
  variável por vez, no acesso — em vez de arrastar o boot do subset `runtime`.
  `tests/unit/config/admin-import-boundary.spec.ts` reprova se algum caminho de
  import do console voltar a alcançar `src/config/env.ts`, e fixa o conjunto de
  entrypoints do runtime que continuam alcançando-o.
- por consequência, `.env.admin.prod.example` **perdeu** o bloco `BACKUP_*` e o
  bloco "exigidas transitivamente". A orientação anterior — usar credencial S3
  separada e sem permissão, e keyring fictício mas válido, no `.env.admin` —
  **não vale mais e não deve ser seguida**: aquelas variáveis simplesmente não
  vão para o container do console.
  `RUNTIME_TRACE_HMAC_MASTER_SECRET` ficou, e por motivo oposto: o console
  **verifica** a integridade dos envelopes de trace, então a #596 declarou as
  três `RUNTIME_TRACE_HMAC_*` como `services: ['runtime', 'admin-ui']`.

**Os dois gates coexistem, e medem coisas diferentes.** O preflight mede os
ARQUIVOS (`env_file` + `environment:` interpolado) ANTES de existir container —
é ele que dá o veredito na sua frente, com o `up` ainda por rodar. O boot mede o
ambiente que o processo REALMENTE recebeu. Pular `npm run config:preflight` já
não permite subir um console sem sign-in configurado: o container recusa-se a
servir. O preflight continua sendo o jeito de descobrir isso ANTES do deploy, e
não pelo container em CrashLoop.

#### O gap que ele fechou

Até a #572, `cp` + "preencha os placeholders" **não** produzia um ambiente que
sobe, e o runbook trazia aqui uma lista de dez chaves para acrescentar à mão:

- **`.env.app`** — seis `BACKUP_*` que não apareciam no exemplo **nem
  comentadas**, em **duas rodadas** de erro (o primeiro boot acusava só
  `BACKUP_ENCRYPTION_MODE` e `BACKUP_S3_BUCKET`; preenchê-las destravava
  `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_ENCRYPTION_KEYRING` e
  `BACKUP_ENCRYPTION_ACTIVE_KEY_ID`).
- **`.env.admin`** — as quatro `OIDC_*`, presentes porém **comentadas**, sob um
  texto que dizia "configure as quatro (ou nenhuma)". Comentário não chega a
  `process.env`: para um container, elas estavam ausentes.

As dez agora são linhas reais nos dois `.prod.example`, com os mesmos valores
que `npm run config:init -- --profile production` emite. Duas decisões que
estavam abertas na issue, e a evidência de cada uma:

- **As `BACKUP_*` são mesmo do `app`.** Nesta topologia o `app` **é** o executor
  do backup: `compose.prod.yml` não tem container de backup, e o processo sobe
  no role default `all`, que possui `cron_scheduler`
  ([`src/runtime/lifecycle/roles.ts`](../../src/runtime/lifecycle/roles.ts)) —
  de onde saem `nightly_backup`, `backup_retention` e `restore_drill`
  ([`src/workers/index.ts`](../../src/workers/index.ts)), que leem os valores por
  [`src/ops/backup/config-input.ts`](../../src/ops/backup/config-input.ts).
  Afrouxar o `requiredIn` não daria um "deploy sem backup remoto": em
  `production`, `BACKUP_ENABLED=false` e `BACKUP_OFFSITE_REQUIRED=false` já são
  recusados (issue #520), e sem bucket a regra `backup/offsite-destination`
  reprovaria o mesmo boot com uma mensagem pior.
- **`OIDC_TENANT_SLUGS` nunca é `default`.** O exemplo trazia
  `OIDC_TENANT_SLUGS=default` na linha comentada. O slug vai **direto** para
  `appUsersRepo.getByEmail(tenant, email)` e `tenantsRepo.findById(tenant)` em
  [`src/admin-ui/lib/auth-resolver.ts`](../../src/admin-ui/lib/auth-resolver.ts):
  ele **é** o `tenant_id`, num caminho dinâmico que `AGENTS.md` §4 (regras 2 e 8)
  proíbe. A regra `admin-ui/tenant-slugs-default-literal` recusa — no preflight,
  antes do deploy, e desde a issue #596 também no **boot** do console
  (`src/admin-ui/instrumentation.ts`), que passou a avaliar o subset `admin-ui`.

Preso por teste nos dois lados:
[`tests/unit/config/preflight.spec.ts`](../../tests/unit/config/preflight.spec.ts)
(toda reprova sobre o exemplo cru é de uma chave que o exemplo deixa ao
operador — nenhuma sobra sem dono) e
[`tests/unit/migrations/compose-prod-effective-env.spec.ts`](../../tests/unit/migrations/compose-prod-effective-env.spec.ts)
(o ambiente efetivo dos três satisfaz o loader, e cada linha acrescentada é
load-bearing: tirá-la volta a reprovar).

### `MAIA_ENV` é obrigatória, e de propósito não tem default

`compose.prod.yml` interpola `MAIA_ENV` com `${MAIA_ENV:?...}` — e injeta o
resultado no `environment:` dos **três** serviços: `migrate`, `app` e
`admin-ui`. Isso não é redundância: `.env.infra` serve **só para
interpolação**, ele não é injetado em container nenhum, e o contrato marca
`MAIA_ENV` como `services: ALL` com `requiredIn: ['staging','production']`.

A primeira versão desta mudança pôs a linha só no `migrate`. O resultado
seria pior que não ter feito nada: o job terminaria com **sucesso**, o gate
`service_completed_successfully` liberaria a subida, e `app`/`admin-ui`
reprovariam no **boot**, com

```
Invalid configuration for service "runtime" (profile production):
  - MAIA_ENV [profile/required]: MAIA_ENV é obrigatória no profile production.
      → Defina MAIA_ENV.
```

`NODE_ENV=production` (que os dois recebem) **não** supre: ele é o modo do
Node, não o profile da Maia, e não sabe dizer `staging`.

Os `.env.app` / `.env.admin` **não** declaram `MAIA_ENV`, de propósito: duas
fontes são duas fontes que podem divergir — o migrator rodaria num profile e
os consumidores em outro, sem nada apontando a contradição. Fonte única,
`.env.infra`, propagada pelo compose.
`tests/unit/migrations/compose-prod-effective-env.spec.ts` monta o ambiente
efetivo dos três (env file + `environment:`, ambos lidos do repositório, pelo
mesmo módulo que o preflight usa) e roda o loader de cada um — verificando que
`MAIA_ENV` deixou de ser um dos problemas **e**, desde a #572, que não sobrou
nenhum outro.

Faltou a linha no `.env.infra`, o compose **aborta antes de criar container
algum**:

```
$ docker compose --env-file .env.infra -f compose.prod.yml up -d
error while interpolating services.migrate.environment.MAIA_ENV: required
variable MAIA_ENV is missing a value: MAIA_ENV is required (production|staging)
— declare-a no .env.infra; ...
```

Antes havia `${MAIA_ENV:-production}`. O default não falhava — ele acertava
o alvo errado em silêncio: um **staging** cujo `.env.infra` esquecesse a
linha assumia o perfil de **produção** sem uma linha de log dizendo isso, e
a descoberta vinha por uma regra de produção sendo aplicada (ou relaxada)
num ambiente que ninguém achava que era produção.

Um ensaio de staging com o mesmo arquivo continua sendo um `MAIA_ENV=staging`
no `.env.infra` — só que agora **escrito**. (`staging` é compatível com
`NODE_ENV=production`; `src/config/profiles.ts` só recusa contradição.)

### Migrations: aplicadas pelo próprio `up` (issue #516)

O `up` acima já aplica as migrations. `compose.prod.yml` tem um job
one-shot `migrate` no meio da subida:

```
postgres healthy → migrate (roda `npm run db:migrate`, sai 0) → app + admin-ui
```

`app` e `admin-ui` declaram `depends_on: { migrate: { condition:
service_completed_successfully } }`, então:

- **o job falhou** (erro de SQL, `dirty`, checksum divergente,
  `missing_file`, lock indisponível) ⇒ `docker compose up` sai **!= 0** e
  NENHUM serviço de aplicação sobe. É o comportamento desejado: melhor um
  deploy que não sobe do que uma instância de pé contra schema incompatível
  respondendo 503 pelo `/readyz`;
- **o job saiu 0** ⇒ o schema está no head desta build antes do primeiro
  request.

Diagnóstico quando o `up` para aqui:

```bash
C="docker compose --env-file .env.infra -f compose.prod.yml"
$C ps -a                       # migrate deve aparecer como `exited (0)`
$C logs migrate                # eventos JSON: migration.applied/failed/dirty/blocked
$C run --rm migrate npm run db:migrate -- status   # read-only, não pega lock
```

Recuperação de `dirty`, checksum mismatch e `repair`:
[`docs/runbooks/migrations.md`](migrations.md).

O job **não** roda `_down` de nada e **não** dispensa o backup antes de uma
migration destrutiva — ele só automatiza o passo forward que antes era
manual (`exec app npm run db:migrate`), removendo a janela em que o app já
estava de pé e o schema ainda não.

Rodar migrations fora da subida (raro; o job já cobre o caso normal):
`docker compose --env-file .env.infra -f compose.prod.yml run --rm migrate`.

## 2. Arquivos de segredo (o que mora onde)

| Arquivo      | Vai para                  | Conteúdo                                              |
| ------------ | ------------------------- | ----------------------------------------------------- |
| `.env.infra` | interpolação do compose   | `POSTGRES_USER/PASSWORD/DB`, `REDIS_PASSWORD`, `MAIA_ENV` |
| `.env.app`   | container `app`           | LLM keys, WhatsApp/owner, HMAC, thresholds            |
| `.env.admin` | container `admin-ui`      | NextAuth/OIDC + mínimo transitivo de `env.ts`         |

Todos `chmod 600`, todos fora do git. `RUNTIME_TRACE_HMAC_MASTER_SECRET`
deve ser o MESMO em `.env.app` e `.env.admin`.

> ⚠️ O `.gitignore` atual ignora apenas `.env`, `.env.local` e
> `.env.*.local` — `.env.app`/`.env.admin`/`.env.infra` NÃO estão cobertos.
> Confirme antes do primeiro commit no host (`git status`) e adicione os
> três ao `.gitignore` (follow-up da auditoria). O `.dockerignore` já
> exclui `.env*` do build context.

## 3. Verificar que 5432/6379 não estão expostos

```bash
# No host: nenhum LISTEN em 5432/6379 (nem 3000/4000 — só o proxy publica)
ss -ltn | grep -E ':(5432|6379|3000|4000)\b' && echo "EXPOSTO — investigue" || echo OK

# De FORA do host (scan externo):
nc -vz -w3 <ip-publico> 5432   # deve falhar/timeout
nc -vz -w3 <ip-publico> 6379   # deve falhar/timeout

# Redis exige auth mesmo por dentro:
docker exec -e REDISCLI_AUTH= maia-redis redis-cli ping   # → NOAUTH (esperado)
```

## 4. Verificar non-root

```bash
docker exec maia-app id        # uid=1001(maia)
# `maia-migrate` é um job: já saiu. Confira no registro do container:
docker inspect -f '{{.Config.User}} {{.State.ExitCode}}' maia-migrate  # 1001:1001 0
docker exec maia-admin-ui id   # uid=1001(maia)
docker exec maia-postgres id   # uid=999(postgres)
docker exec maia-redis id      # uid=999(redis)
```

## 5. Migração de um host que rodava o compose antigo

Mesmo diretório ⇒ mesmo project name ⇒ `compose.prod.yml` REUSA os volumes
(`maia_pg_data`, `maia_redis_data`, `maia_baileys_auth`, `maia_media`).
Postgres/Redis já pertencem ao uid 999 (os entrypoints chownavam antes de
dropar privilégio). Os volumes do app eram escritos como root — chown único
para o uid 1001 antes do primeiro `up`:

```bash
docker compose down   # SEM -v
docker run --rm -v maia-v2_maia_baileys_auth:/d -v maia-v2_maia_media:/m \
  alpine sh -c 'chown -R 1001:1001 /d /m'
# prefixo = project name; confira com `docker volume ls`
```

## 6. Rollback

Imagens são construídas do checkout; volumes nunca são apagados por `up`.

```bash
git -C /opt/maia checkout <tag-ou-sha-anterior>
docker compose --env-file .env.infra -f compose.prod.yml up -d --build
```

- Rollback de app/admin-ui é seguro: estado vive nos volumes + Postgres.
- Migrations aplicadas têm `_down` (ver `docs/runbooks/migrations.md`) —
  reverta apenas se a versão anterior não entender o schema novo.
- NUNCA `docker compose down -v` em produção (apaga dados e sessão
  WhatsApp). Backups: `npm run backup` / `docs/runbooks/operational.md`.
- Se o rollback for para uma versão anterior a este runbook (imagens
  root-era), os volumes chownados para 1001 continuam legíveis pelo
  processo root antigo — sem passo extra.

## 7. Deploy fora do Compose — Coolify (issue #565)

Esta seção existe porque o gate da #516 é feito de primitivas do **Compose**:
`restart: "no"`, a ausência de `env_file:` no serviço `migrate`, e
`depends_on: { migrate: { condition: service_completed_successfully } }`.
`service_completed_successfully` **não existe fora do Compose**. Um deploy
que assuma "é só rodar a mesma imagem" perde o invariante em silêncio — que é
exatamente o modo de falha que o gate existe para eliminar.

O repositório descreve a topologia de Coolify em
[`docs/admin-ui-deploy.md`](../admin-ui-deploy.md): **duas aplicações** (`app`
e `admin-ui`) apontando para o mesmo repositório, cada uma com build por
Dockerfile e seu próprio editor de variáveis. Nessa topologia não existe
"não passar" um segredo para o passo de migration: ele nasce dentro do
ambiente completo da aplicação.

> **DECISÃO DO DONO — a infraestrutura real tem um TERCEIRO recurso, só de
> migration.** Com ele, "não passar o segredo" volta a existir: o recurso de
> migration tem editor de variáveis próprio e recebe **apenas o subset
> `migrator`**. O que muda em relação ao texto abaixo está em
> [§7.5](#75-o-recurso-de-migration-separado--a-topologia-adotada), e é lá que
> começa quem já opera nessa topologia. O gate de §7.1 continua valendo — como
> rede de segurança dentro do recurso separado, e como o caminho único para
> quem ainda roda com duas aplicações.

### 7.0 O que foi EXECUTADO e o que NÃO foi

Leia esta tabela antes de seguir qualquer passo abaixo. Ela é a razão de esta
seção poder existir sem virar ficção: um runbook que descreve um caminho que
ninguém executou é pior que a ausência dele — ele é lido no meio de um
incidente.

| Afirmação | Status | Onde a prova está |
|---|---|---|
| O gate roda **o mesmo comando** do job `migrate` do Compose (`npm run db:migrate`) | **EXECUTADO** | `tests/unit/migrations/release-gate.spec.ts` lê `compose.prod.yml` do disco e compara |
| Ele **sai 0** quando as migrations aplicam, e o ledger fica no head | **EXECUTADO** | `tests/integration/release-migrate-gate.spec.ts`, processo real contra Postgres real, banco descartável |
| Ele **sai != 0** quando o migrate falha (ledger `dirty`) | **EXECUTADO** | idem |
| Ele entrega ao migrator **só o subset `migrator`** (#515) — nada de chave de LLM, sessão de WhatsApp ou credencial S3 | **EXECUTADO** | idem: a mesma variável derruba o migrator cru (saída 2) e não chega nele pelo gate (saída 0) |
| `gate && consumidor` **impede o consumidor de rodar** quando o gate falha | **EXECUTADO** | idem: o marcador que o consumidor escreveria não existe no disco |
| **O painel do Coolify executa o gate antes do rollout e desiste do rollout quando ele sai != 0** | **NÃO VERIFICADO** | Não há instância de Coolify acessível a quem escreveu isto. O que se afirma é só o contrato: *"rode este comando; se ele sair != 0, não suba"* |
| **O nome e a localização do campo do painel onde o comando é colado** | **NÃO VERIFICADO** | Varia por versão do Coolify e não foi conferido em nenhuma. Procure-o na sua instância; o texto abaixo descreve o que o campo precisa fazer, não onde ele fica |
| Um redeploy **re-executa** o gate, e o que acontece quando ele sai `up_to_date` | **NÃO VERIFICADO** | Ver §7.4 |
| O recurso de migration separado recebe **só** o subset `migrator`, e o processo dele valida **só** esse subset | **EXECUTADO** | `tests/unit/scripts/migrate-subset-boot.spec.ts` roda `tsx scripts/migrate.ts` num processo com o `.env.migrator.prod.example` (lido do disco) e nada mais |
| Uma chave de aplicação acrescentada ao subset `migrator` **derruba o migrator**, em vez de aumentar o raio de explosão em silêncio | **EXECUTADO** | `src/config/migrator-subset.ts`, chamado por `loadMigrationConfig()`; guard em `tests/unit/config/migrator-subset.spec.ts` |
| **O painel do Coolify permite criar o recurso separado, e como se chama o campo** | **NÃO VERIFICADO** | Mesma razão das duas linhas acima: não há instância acessível a quem escreveu isto. O que §7.5 descreve é o CONJUNTO DE VARIÁVEIS do recurso, que é verificável aqui, e não a navegação do painel |

### 7.1 O comando

```bash
npm run release:migrate
```

[`scripts/release-migrate.ts`](../../scripts/release-migrate.ts) sobre
[`src/migrations/release-gate.ts`](../../src/migrations/release-gate.ts). Ele
faz três coisas, e nada além:

1. **filtra o ambiente** para o subset `migrator` do contrato (#515) mais um
   punhado de variáveis de processo (`PATH`, `HOME`, `npm_config_cache`, …).
   Allowlist, não denylist: uma chave nova em `.env.app` já nasce de fora.
   `NODE_OPTIONS` é retida de propósito — um passo que aplica DDL não carrega
   código que o painel injetou;
2. **roda `npm run db:migrate`** — o mesmo `command:` do serviço `migrate` em
   `compose.prod.yml`, com o mesmo `stdio`, então os eventos
   `migration.applied` / `migration.blocked` vão direto para o log do deploy;
3. **propaga o exit code** do migrator sem alterá-lo. Sai 0 por um caminho só:
   o migrator saiu 0. Spawn que falha, morte por sinal e código fora da faixa
   viram falha.

O que ele **retém** é reportado por nome (nunca por valor) numa linha JSON.
Esta é a saída literal de uma rodada de
`tests/integration/release-migrate-gate.spec.ts`, quebrada em linhas para
caber (no log ela é uma linha só):

```json
{"event":"release_gate.env_scrubbed","command":"npm run db:migrate",
 "passed":["DATABASE_URL","HOME","MAIA_ENV","NODE_ENV","PATH","POSTGRES_DB","POSTGRES_PASSWORD","POSTGRES_USER","PWD","TZ","npm_config_cache"],
 "withheld_contract":["ANTHROPIC_API_KEY","BACKUP_S3_SECRET_KEY","NEXTAUTH_SECRET"],
 "withheld_unknown_maia":["MAIA_TEST_MARKER"],"withheld_other":25}
```

`withheld_contract` é a lista acionável: são segredos de `app`/`admin-ui` que
chegaram ao passo de migration porque o painel injeta um ambiente só.
`withheld_unknown_maia` não vazio é **erro de configuração seu** — uma chave
`MAIA_*`/`FEATURE_*` que o contrato não declara, ou seja, um typo numa
configuração que você acha ativa. O gate a retém (senão o migrator recusaria o
boot), e por isso mesmo a nomeia.

### 7.2 Duas formas de ligar o gate, e o que cada uma custa

| | (A) campo de comando pré-deploy | (B) encadeado no comando de start |
|---|---|---|
| Como fica | o painel roda o gate; se sair != 0, não faz o rollout | `npm run release:migrate && exec node dist/index.js` |
| Quem faz o exit code valer | o painel | o `&&` do shell |
| Roda quantas vezes | uma por deploy | uma por container que sobe (o lock global de `src/migrations/lock.ts` serializa) |
| Falha aparece como | deploy abortado, versão anterior intacta | container em crash-loop |
| **Verificado aqui?** | **NÃO** — depende do painel | **SIM** — `tests/integration/release-migrate-gate.spec.ts` roda o encadeamento num shell e prova que o consumidor não executa |

Prefira **(A)** se a sua instância tem o campo: um deploy abortado deixa a
versão anterior de pé, um crash-loop não. Use **(B)** como rede de segurança —
ela é a única das duas cuja semântica não depende de nenhuma promessa de
painel, e é a que está exercitada em teste.

Com **(B)**, o comando de start de cada aplicação passa a ser:

```bash
# aplicação `app` — precisa de um SHELL, porque quem faz o `&&` valer é ele
sh -c 'npm run release:migrate && exec node dist/index.js'
```

`node dist/index.js` é o `CMD` do `Dockerfile`; o `ENTRYPOINT` é
`/sbin/tini --`, então o `sh` acima entra como argumento do tini e continua
sendo PID 1 quem repassa sinais. Se o painel já monta um `sh -c` em volta do
que você digita, digite só o miolo — dois `sh -c` aninhados funcionam, mas a
mensagem de erro fica pior.

O `admin-ui` **não pode** rodar este comando, e a razão é da imagem, não de
preferência: `src/admin-ui/Dockerfile` produz o `standalone` do Next.js — o
estágio de runtime copia `.next/standalone` e `.next/static` e mais nada.
Não há `scripts/`, não há `migrations/`, não há o `package.json` da raiz (logo
não existe o script `release:migrate`) e não há `tsx`. Colar o comando no
editor da Aplicação 2 falha com "missing script", não com um erro de
migration.

O gate mora na Aplicação 1 (`app`), e só nela — o que também evita dois
migradores disputando o lock global. O `admin-ui` depende de o gate do `app`
ter passado, e essa dependência **não existe como aresta** fora do Compose:
é ordem de deploy. Deploy do `app` primeiro.

**Na topologia adotada (§7.5) o gate não mora na Aplicação 1: ele é um recurso
próprio, o terceiro.** Tudo desta subseção continua descrevendo o caminho de
duas aplicações — leia-a se a sua instância não tiver o recurso separado, ou
como a rede de segurança de §7.5 quando o painel herdar variáveis de projeto.

### 7.3 O que este gate NÃO recupera do Compose

Dito por inteiro, porque a diferença importa num incidente:

- **`app` e `admin-ui` continuam sem aresta entre si.** No Compose, os dois
  esperam o mesmo job. Aqui, o `admin-ui` pode subir contra um schema atrasado
  se for deployado antes do `app`. E **nada o segura**: a checagem de readiness
  de schema (`getSchemaReadiness()`, #516) está ligada ao `/readyz` do `app`
  (`src/runtime/lifecycle/schema-readiness.ts`) — o console não tem
  equivalente. Deploy do `app` primeiro, e é disciplina de ordem, não uma
  aresta;
- **o container ainda POSSUI os segredos.** No Compose, o migrator não recebe
  `.env.app` — ele não pode vazar o que nunca teve. Aqui, o processo do
  migrator não os recebe, mas o container em volta dele sim. É um raio de
  explosão menor, não o mesmo raio de explosão. **Esta é exatamente a lacuna
  que o recurso separado de §7.5 fecha**, e é por isso que ele é a topologia
  adotada: com editor de variáveis próprio, o container também nunca tem o que
  não usa;
- **nada aqui verifica configuração de `app`/`admin-ui`.** O migrator satisfaz
  o contrato dele e sai 0; `app`/`admin-ui` ainda podem reprovar no boot pelas
  chaves listadas em §1. O gate é sobre schema, não sobre bring-up.

E o que **não** foi reusado, com o motivo — porque a pergunta é razoável:

- **o preflight de configuração** (issue #572) recebe um arquivo de Compose e
  os `env_file` do disco e certifica o ambiente EFETIVO de cada serviço. No
  painel não existe nenhum dos dois: o ambiente mora no editor da aplicação.
  A entrada dele não existe aqui, então não há o que reusar do comando. O que
  É reusado é a checagem por baixo: o migrator chama `loadMigrationConfig()`
  → `loadServiceConfig('migrator')`, o mesmo loader, e o gate não
  reimplementa validação nenhuma;
- **`maia doctor`** (issue #517) é liveness — ele abre conexão e responde
  "está de pé?". O gate roda ANTES de existir instância para perguntar. São
  passos diferentes do mesmo deploy, não um substituto do outro.

### 7.4 Perguntas que só uma instância real responde

Registradas aqui em vez de respondidas, porque respondê-las de cabeça é
exatamente o que esta seção não faz:

1. Se o seu Coolify deploya por **arquivo de Compose** (e não por Dockerfile),
   o gate da #516 pode valer como está — mas só se a versão de Compose usada
   honrar `service_completed_successfully`, que é `depends_on` de forma longa
   e é **ignorada em silêncio** por versões antigas. Confirme antes de assumir
   que esta seção inteira é desnecessária.
2. Como `${MAIA_ENV:?…}` se comporta na interpolação do painel. A variável é
   obrigatória de propósito (§1); um orquestrador que injete env por outro
   caminho pode reintroduzir o default silencioso que ela eliminou.
3. Se um redeploy re-executa o gate e o que o painel faz com a saída
   `up_to_date` (que é 0, e é o caso normal de todo deploy sem migration
   nova).

### 7.5 O recurso de migration SEPARADO — a topologia adotada

Decisão do dono, já tomada: a infraestrutura real tem **uma aplicação/job de
migration própria**, além das duas de `docs/admin-ui-deploy.md`. São três
recursos apontando para o mesmo repositório:

| Recurso | Comando | Editor de variáveis |
|---|---|---|
| 1. `app` | `node dist/index.js` | `.env.app.prod.example` |
| 2. `admin-ui` | `server.js` do standalone | `.env.admin.prod.example` |
| 3. **`migrate`** | `npm run db:migrate` | **`.env.migrator.prod.example`** |

O que isso compra, e é o motivo inteiro de existir: **o container de migration
não recebe os segredos da aplicação**. Não "recebe e o gate filtra" — não
recebe. Um job que só aplica DDL não tem motivo para carregar a chave que fala
com o cliente, e o que ele nunca teve ele não pode vazar. É a garantia (2) da
#516, que §7.3 listava como perdida fora do Compose, de volta inteira.

#### O conjunto de variáveis

```bash
cp .env.migrator.prod.example .env.migrator && chmod 600 .env.migrator
```

Cole o conteúdo no editor de variáveis do recurso 3 e preencha os
`__SET_ME__`. São 15 chaves — o subset `migrator` do contrato
(`src/config/contract.ts`, #515) inteiro, das quais 5 o operador preenche:

| Chave | Por quê |
|---|---|
| `MAIA_ENV` | o profile. Obrigatória em staging/production; sem ela o boot reprova |
| `NODE_ENV` | otimizações da plataforma Node. `production` com `MAIA_ENV=production` — a combinação contrária é recusada |
| `DATABASE_URL` | o destino do DDL. **As mesmas credenciais do `app`**: um migrator que aponta para outro banco não gateia nada |
| `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` | o mesmo banco, pelas partes |
| `TZ` · `LOG_LEVEL` | knobs de processo |
| `MAIA_BUILD_COMMIT` · `MAIA_CONFIG_STRICT_BOOT` | opcionais, comentadas no exemplo |
| as quatro `MIGRATION_*_MS` | os tetos de lock/statement da #516, com default do contrato |

E o que ele **não** recebe, que é a metade que importa: nenhuma `WHATSAPP_*`
ou `BAILEYS_*`, nenhuma `OWNER_*`, nenhuma chave de LLM
(`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`), nenhuma
`VOYAGE_API_KEY`/`COHERE_API_KEY`, nenhuma `BACKUP_S3_*` ou
`BACKUP_ENCRYPTION_*`, nenhum `NEXTAUTH_SECRET`, nenhuma `OIDC_*`, nenhuma
`REDIS_URL`, nenhum transporte de alerta.

Essa lista **não é uma lista para manter à mão** — uma allowlist copiada
envelhece em silêncio, e a `WHATSAPP_*` criada na semana que vem passaria por
ela. A invariante é travada pela ORIGEM da chave em
[`src/config/migrator-subset.ts`](../../src/config/migrator-subset.ts): grupo
do contrato (só `core` e `database`), namespace (só `MAIA_` entre os da Maia)
e segredo-só-de-banco. Um domínio novo em `GROUP_ORDER`, ou um prefixo novo em
`MAIA_KEY_PREFIXES`, nasce proibido para o migrator sem ninguém editar nada.
`loadMigrationConfig()` chama esse guard no boot: um contrato que dê ao
migrator uma chave de aplicação vira um migrator que **recusa rodar**,
nomeando a variável e a regra, com exit 2.

#### Ordem do deploy, que continua sendo disciplina e não aresta

```
recurso 3 (migrate) → sai 0 → recurso 1 (app) → recurso 2 (admin-ui)
```

`service_completed_successfully` não existe no painel: quem segura o rollout é
o painel desistir quando o recurso 3 sai != 0. **Deploy o recurso 3 primeiro,
e só siga se ele sair 0.** Réplicas simultâneas continuam seguras — o advisory
lock global (`src/migrations/lock.ts`) serializa e o perdedor sai de forma
limpa e observável.

O comando do recurso 3 é `npm run db:migrate` — **o mesmo `command:` do
serviço `migrate` do Compose**, pinado em
`tests/unit/migrations/release-gate.spec.ts`. Ele sai 0 em sucesso e em
"já no head" (o caso normal de todo deploy sem migration nova), e != 0 em
falha, blocker (dirty, checksum mismatch, missing_file) ou lock indisponível.

#### E se o painel injetar as variáveis do projeto em todo recurso

Alguns painéis têm variáveis de PROJETO, herdadas por todos os recursos. Nesse
caso o recurso 3 recebe o ambiente completo mesmo tendo editor próprio, e a
separação some. A rede de segurança é o gate de §7.1:

```bash
npm run release:migrate     # em vez de `npm run db:migrate`
```

Ele filtra o ambiente para este mesmo subset antes de chamar o migrator, e
**nomeia** (nunca por valor) o que reteve na linha
`release_gate.env_scrubbed`. `withheld_contract` não vazio nesse recurso é o
sinal de que a herança está acontecendo — o raio de explosão volta a ser o do
container, não o do processo.

#### O que continua NÃO verificável daqui

- se o painel realmente desiste do rollout quando o recurso 3 sai != 0 (§7.0);
- se `${MAIA_ENV:?…}` sobrevive à interpolação do painel — no recurso 3 a
  variável é declarada literalmente (`MAIA_ENV=production`), sem interpolação,
  justamente para não depender disso;
- o que o painel faz com um redeploy que sai `up_to_date` (§7.4).

### 7.6 Kubernetes

Entrega futura, fora do escopo desta issue por decisão do dono. Não há
manifesto nem init container neste repositório, e nenhuma linha deste runbook
descreve um.
