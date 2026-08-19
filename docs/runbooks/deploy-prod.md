# Runbook — Deploy de produção (`compose.prod.yml`)

> Auditoria P0 cap. 6. Produção NUNCA usa `docker-compose.yml` (compose de
> dev: portas de datastore no host, fallback `maia/maia`, Redis sem auth,
> `.env` inteiro em todos os containers, processos root).

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

── serviço admin-ui → loaders runtime + admin-ui · env_file: .env.admin
  · subset runtime
    ...
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

“Todos”, e não “o loader nominal”, é o ponto: o container do `admin-ui` importa
`src/config/env.ts` (direto em `src/admin-ui/trpc/tool-enablement.ts` e
`src/admin-ui/trpc/routers/tools-catalog.ts`, e via `@/db/client.ts`), e aquele
singleton chama `validateConfig({ service: 'runtime' })`. Ele é portanto
validado contra **`runtime` + `admin-ui`**, mais os **gates de boot próprios do
console**. Antes da review de PR #595 o preflight validava só o subset
`admin-ui`: tirar do `.env.admin` uma chave somente-runtime deixava o comando
verde e o container caía no boot.

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
referenciada pelo compose que esteja exportada no seu shell **com valor
diferente** do `.env.infra` é reportada como divergência e **reprova** o
comando, com o nome da variável (nunca o valor) e a instrução de `unset` ou de
alinhar o arquivo. Sem isso, um `export MAIA_ENV=staging` esquecido faria o
preflight certificar um ambiente e o `up` subir outro.

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

#### Por que o preflight é a ÚNICA checagem do subset `admin-ui`

Vale dizer isto em voz alta, porque muda o que "reprova no boot" significa para
o container do console.

O `admin-ui` importa `src/config/env.ts` — direto em
[`src/admin-ui/trpc/tool-enablement.ts`](../../src/admin-ui/trpc/tool-enablement.ts)
e [`src/admin-ui/trpc/routers/tools-catalog.ts`](../../src/admin-ui/trpc/routers/tools-catalog.ts),
e transitivamente via `@/db/client.ts` — e esse singleton valida o contrato com
**`service: 'runtime'`** ([`src/config/env.ts`](../../src/config/env.ts),
`loadConfig()`). Isso corta dos DOIS lados:

- as `OIDC_*` são `services: ['admin-ui']`, ou seja, estão FORA desse subset — o
  `requiredIn` delas nunca é avaliado ali, e o `validateConfig` descarta
  explicitamente achados cross-field sobre variáveis fora do escopo do serviço
  pedido ([`src/config/validate.ts`](../../src/config/validate.ts));
- e o subset `runtime` INTEIRO é cobrado do container do console, inclusive
  chaves que ele nunca usa (`WHATSAPP_*`, `OWNER_*`, chave de LLM, `VOYAGE_*`,
  `RUNTIME_TRACE_HMAC_MASTER_SECRET` e as seis `BACKUP_*`). É por isso que
  `.env.admin.prod.example` as traz — ver o CAVEAT no topo daquele arquivo, e o
  aviso de blast radius do bloco `BACKUP_*`.

`loadAdminConfig()`
([`src/config/admin-config.ts`](../../src/config/admin-config.ts)) existe, mas
**nenhum caminho de boot o chama**.

Consequência prática, e ela é pior que "o container não sobe": com as quatro
`OIDC_*` ausentes, o admin-ui **sobe**. `oidcProviderEnabled()` trata
`OIDC_ISSUER` vazio como "este deploy não usa OIDC" e devolve `false` em
silêncio — em produção, onde o provider de dev está desligado, isso registra
ZERO providers e entrega a tela "no providers configured". E o literal
`default` em `OIDC_TENANT_SLUGS` passa igual: a regra que o recusa
(`admin-ui/tenant-slugs-default-literal`) vive no contrato, no subset
`admin-ui`, que aquele boot não avalia.

`npm run config:preflight` é, hoje, o único lugar que roda o loader
`admin-ui` sobre o ambiente efetivo do container `admin-ui` — e desde a review
de PR #595 ele roda TAMBÉM o subset `runtime` e os gates de boot do console,
porque é isso que o container faz.

**O que continua dependendo de disciplina de runbook, dito sem eufemismo:**
fechar a assimetria no CÓDIGO — fazer o boot do console chamar
`loadAdminConfig()` — é a **issue #596**, e NÃO está feito. Enquanto ela não
landar, pular `npm run config:preflight` ainda permite subir um `admin-ui` sem o
subset OIDC/fail-closed avaliado. O preflight é o gate; ele só protege quem o
roda.

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
  proíbe. A regra `admin-ui/tenant-slugs-default-literal` recusa — e o preflight
  é o que faz essa regra rodar antes do deploy, porque o boot do admin-ui **não**
  chama o validador do contrato (ver "O que o preflight NÃO cobre").

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
