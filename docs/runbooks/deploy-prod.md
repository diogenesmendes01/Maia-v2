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
#
# ATENÇÃO: `cp` + preencher os placeholders NÃO basta para app/admin-ui
# subirem. Os dois exemplos não cobrem tudo que o profile `production`
# exige — leia "O que os exemplos NÃO cobrem" logo abaixo ANTES do `up`.

# Credenciais de infra — usadas SÓ para interpolação do compose
cat > .env.infra <<'EOF'
POSTGRES_USER=maia_prod
POSTGRES_PASSWORD=<openssl rand -hex 24>   # URL-safe, min 8 chars
POSTGRES_DB=maia
REDIS_PASSWORD=<openssl rand -hex 24>
MAIA_ENV=production                        # OBRIGATÓRIA — ver abaixo
EOF
chmod 600 .env.infra

docker compose --env-file .env.infra -f compose.prod.yml up -d --build
docker compose --env-file .env.infra -f compose.prod.yml ps
```

### O que os exemplos NÃO cobrem (gap conhecido — issue #572)

`cp` + "preencha os placeholders" **não** produz um ambiente que sobe. Os dois
`.prod.example` são o conjunto mínimo do schema Zod de `src/config/env.ts`; o
**contrato** (`src/config/contract.ts`) exige mais no profile `production`, e
essas chaves não estão nos exemplos.

O gate que a issue #516 entrega cobre o **migrator, e só ele**: `migrate` não
tem `env_file`, recebe apenas o subset `migrator` do contrato pelo
`environment:` do compose, e satisfaz o loader. `app` e `admin-ui` **reprovam
no boot** — depois de o migrator ter saído com sucesso e o gate
`service_completed_successfully` ter liberado a subida.

Acrescente à mão, depois do `cp`:

**`.env.app` — nenhuma destas aparece em `.env.app.prod.example`, nem
comentada.** Não há linha para descomentar; são seis chaves novas:

| Chave | Por que o contrato exige em `production` |
|---|---|
| `BACKUP_S3_BUCKET` | `requiredIn: ['staging','production']` |
| `BACKUP_S3_ACCESS_KEY` | `requiredWhen`: `BACKUP_S3_BUCKET` presente |
| `BACKUP_S3_SECRET_KEY` | `requiredWhen`: `BACKUP_S3_BUCKET` presente |
| `BACKUP_ENCRYPTION_MODE` | o default `none` é **recusado** em production (`backup/production-encryption`) — o valor de produção é `envelope_aes256_gcm` |
| `BACKUP_ENCRYPTION_KEYRING` | `requiredWhen`: `BACKUP_ENCRYPTION_MODE=envelope_aes256_gcm` |
| `BACKUP_ENCRYPTION_ACTIVE_KEY_ID` | `requiredWhen`: `BACKUP_ENCRYPTION_MODE=envelope_aes256_gcm` |

São **duas rodadas de erro**, não uma: o primeiro boot acusa apenas
`BACKUP_ENCRYPTION_MODE` e `BACKUP_S3_BUCKET`; preenchê-las é o que destrava a
exigência das outras quatro. Preencher só o que a primeira mensagem lista
devolve uma segunda falha de boot.

**`.env.admin` — as quatro `OIDC_*` existem no exemplo, porém COMENTADAS**
(`.env.admin.prod.example`, seção "Sign-in de produção"). O exemplo dizia
"configure as quatro (ou nenhuma)"; esse "ou nenhuma" **não vale em
production** — o contrato marca as quatro com
`requiredIn: ['staging','production']` — e o texto do arquivo já foi corrigido.
Descomente e preencha `OIDC_ISSUER` (tem de ser `https://`), `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET` e `OIDC_TENANT_SLUGS`.

> **TODO (issue #572)** — alinhar contrato, `.prod.example` e este runbook, e
> acrescentar um preflight `config:check` real dos **dois** consumidores, para
> que esta seção vire um comando em vez de uma lista conferida à mão. Decidir
> se produção realmente obriga backup off-site cifrado e SSO é decisão de
> produto, não de wiring — por isso ela não foi tomada aqui.
>
> Enquanto isso, o gap está preso em
> `tests/unit/migrations/compose-prod-effective-env.spec.ts` (`describe` "gap
> conhecido…"), que afirma as chaves acima pelos dois lados: fica vermelho se o
> gap crescer **e** se ele fechar sem esta seção ser atualizada junto.

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
efetivo dos três (env file + `environment:`, ambos lidos do repositório) e
roda o loader de cada um — verificando que `MAIA_ENV` deixou de ser um dos
problemas. Ele **não** afirma que esse ambiente sobe: o que falta para isso
está na seção anterior, e o próprio spec o prende por nome.

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
