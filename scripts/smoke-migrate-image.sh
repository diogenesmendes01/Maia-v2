#!/usr/bin/env bash
# =======================================================================
# smoke-migrate-image.sh — o job `migrate` do Compose, exercitado DENTRO
# da imagem de produção real. Gate obrigatório antes do primeiro rollout
# (issue #516) e gate permanente de release (CI, job `smoke-migrate-image`).
#
#   npm run smoke:migrate:image
#
# POR QUE ESTE ARQUIVO EXISTE
# ---------------------------
# `tests/unit/migrations/compose-migrate-job.spec.ts` prova que os arquivos
# de Compose DIZEM a coisa certa: `restart: "no"`, `user: 1001:1001`,
# `read_only: true`, `service_completed_successfully`, subset `migrator` do
# contrato. Nada disso executa o comando. A PR #563 encerrou declarando o
# risco residual em uma linha: o job nunca rodou dentro da imagem real.
#
# O que só a imagem real responde:
#
#   - `npm run db:migrate` é `tsx scripts/migrate.ts`, e `scripts/migrate.ts`
#     importa `@/config/migration-config.js`. O alias `@/*` é resolvido pelo
#     `tsx` em runtime, lendo `tsconfig.json` — não pelo `dist/` compilado.
#     Se o `tsx` precisar escrever cache em algum lugar que o rootfs
#     read-only não permita, ou se `tsconfig.json`/`src/` não estiverem na
#     imagem, o job morre na primeira linha. Verificação estática não vê
#     nada disso;
#   - `npm ci --omit=dev` (Dockerfile, stage `deps`) instala só as
#     dependências de produção. `tsx` estar em `dependencies` e não em
#     `devDependencies` é a única razão de o comando existir na imagem;
#   - uid 1001 + rootfs read-only + `npm_config_cache=/tmp/.npm` é a
#     combinação que o `compose.prod.yml` impõe ao job. Cada uma sozinha
#     funciona; o que interessa é as três juntas.
#
# COMO ESTE SMOKE FALHA (e por que ele não passa por acidente)
# -----------------------------------------------------------
# Um smoke que passa sem exercitar nada é pior do que não ter smoke. Este
# aqui carrega quatro asserções feitas para pegar exatamente isso:
#
#   1. banco EFÊMERO e comprovadamente vazio antes do run — se
#      `schema_migrations` já existir, aborta. Um banco pré-migrado faria
#      `up` sair 0 sem aplicar uma linha;
#   2. sonda com AS MESMAS FLAGS do run real: uid tem de ser 1001 e uma
#      escrita em /app tem de FALHAR. Se alguém tirar `--read-only` ou
#      `--user`, a sonda passa a escrever e o smoke reprova — as condições
#      do teste são elas próprias testadas;
#   3. contagem: o ledger tem de terminar com exatamente tantas migrations
#      `applied` quantas a IMAGEM empacota (contadas dentro dela). Um run
#      que não aplicou nada deixa 0 e reprova mesmo saindo 0;
#   4. o stdout tem de conter eventos `migration.applied` do runner real —
#      um `exit 0` vindo de qualquer outro caminho não satisfaz isto.
#
# Depois disso, um SEGUNDO run contra o mesmo banco tem de sair 0 sem
# aplicar nada: é o caminho "já no head", que é o que roda em todo deploy
# que não traz migration nova, e que também precisa funcionar read-only.
#
# NÃO EXISTE `--dockerfile` NEM FALLBACK AQUI DE PROPÓSITO. O gate constrói
# `Dockerfile` e nada mais. Um smoke com escape hatch é um smoke que um dia
# passa pelo escape hatch.
# =======================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# A imagem de produção real, do Dockerfile real.
DOCKERFILE="Dockerfile"
IMAGE_TAG="maia-migrate-smoke:local"

# Mesma imagem de banco que `compose.prod.yml` usa em produção (pgvector
# vem pré-instalado; `001_initial.sql` cria a extensão). Pinada aqui e
# conferida contra o arquivo real em compose-migrate-job.spec.ts.
POSTGRES_IMAGE="pgvector/pgvector:pg16"

# Credenciais do banco EFÊMERO deste run. Não são segredo: o container
# morre no fim do script e nunca escuta no host.
PGUSER_SMOKE="maia_smoke"
PGPASS_SMOKE="smoke_pw_ephemeral"
PGDB_SMOKE="maia_smoke"

RUN_ID="$$-$(date +%s)"
NETWORK="maia-smoke-net-${RUN_ID}"
PG_CONTAINER="maia-smoke-pg-${RUN_ID}"

# O comando REAL do job — o mesmo `command:` de compose.prod.yml.
MIGRATE_COMMAND=(npm run db:migrate)

# As flags de isolamento REAIS do job em compose.prod.yml. Um único array,
# usado tanto pela sonda quanto pelo run de verdade: não há como o smoke
# rodar sob condições mais frouxas do que aquelas que ele afirma testar.
HARDENING_FLAGS=(
  --user 1001:1001
  --read-only
  --tmpfs /tmp
  --cap-drop ALL
  --security-opt no-new-privileges:true
)

# As chaves de `environment:` do serviço `migrate` em compose.prod.yml.
# compose-migrate-job.spec.ts falha se este conjunto divergir do arquivo.
migrator_env_flags() {
  printf '%s\n' \
    -e "NODE_ENV=production" \
    -e "MAIA_ENV=production" \
    -e "DATABASE_URL=postgres://${PGUSER_SMOKE}:${PGPASS_SMOKE}@${PG_CONTAINER}:5432/${PGDB_SMOKE}" \
    -e "POSTGRES_USER=${PGUSER_SMOKE}" \
    -e "POSTGRES_PASSWORD=${PGPASS_SMOKE}" \
    -e "POSTGRES_DB=${PGDB_SMOKE}" \
    -e "npm_config_cache=/tmp/.npm" \
    -e "TZ=America/Sao_Paulo"
}

log()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✖ SMOKE FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# SEMPRE por TCP (`-h 127.0.0.1`), nunca pelo socket unix. Isto não é
# estilo: o entrypoint da imagem oficial do Postgres sobe um servidor
# TEMPORÁRIO durante o `initdb`, e esse servidor escuta SÓ no socket unix.
# Um `pg_isready` (ou psql) sem `-h` responde "accepting connections" para
# esse servidor temporário, o script segue em frente, e o próximo comando
# pega o "database system is shutting down" do fim do initdb. Essa corrida
# derrubou este smoke em 1 de 3 execuções antes deste comentário existir.
psql_smoke() {
  docker exec "$PG_CONTAINER" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 \
    -U "$PGUSER_SMOKE" -d "$PGDB_SMOKE" -tAc "$1"
}

# --- 0. pré-requisito -------------------------------------------------
docker info >/dev/null 2>&1 || fail "o daemon do Docker não está acessível"

# --- 1. construir a imagem de produção REAL ---------------------------
log "build da imagem de produção (${DOCKERFILE})"
docker build -t "$IMAGE_TAG" -f "$DOCKERFILE" . || fail "a imagem de produção não constrói"
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")"
echo "imagem: ${IMAGE_TAG} (${IMAGE_ID})"

# Quantas migrations forward a IMAGEM empacota. Contado DENTRO dela, não no
# checkout: é sobre esta build que o ledger vai ser conferido.
EXPECTED_MIGRATIONS="$(
  docker run --rm --entrypoint sh "$IMAGE_TAG" -c \
    "ls -1 migrations | grep '\.sql$' | grep -v '_down\.sql$' | wc -l" | tr -d '[:space:]'
)"
[ "$EXPECTED_MIGRATIONS" -gt 0 ] 2>/dev/null \
  || fail "a imagem não empacota migration alguma (contei '${EXPECTED_MIGRATIONS}') — o COPY de migrations/ sumiu?"
echo "migrations empacotadas na imagem: ${EXPECTED_MIGRATIONS}"

# --- 2. Postgres efêmero ----------------------------------------------
log "subindo Postgres efêmero (${POSTGRES_IMAGE})"
docker network create "$NETWORK" >/dev/null
docker run -d --name "$PG_CONTAINER" --network "$NETWORK" \
  -e "POSTGRES_USER=${PGUSER_SMOKE}" \
  -e "POSTGRES_PASSWORD=${PGPASS_SMOKE}" \
  -e "POSTGRES_DB=${PGDB_SMOKE}" \
  "$POSTGRES_IMAGE" >/dev/null

for _ in $(seq 1 90); do
  if psql_smoke 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_smoke 'select 1' >/dev/null 2>&1 \
  || fail "o Postgres efêmero não aceitou conexão TCP em 90s"

# O banco tem de estar VAZIO: contra um banco já migrado, `up` sai 0 sem
# aplicar nada e o smoke viraria decoração.
LEDGER_EXISTS="$(psql_smoke "select to_regclass('public.schema_migrations') is not null")"
[ "$LEDGER_EXISTS" = "f" ] \
  || fail "o banco efêmero JÁ tem schema_migrations — ele não estava vazio, e um run contra banco migrado não prova nada"

# --- 3. sonda: as condições do teste são elas próprias testadas -------
log "sonda de isolamento (mesmas flags do run real)"
PROBE_UID="$(docker run --rm "${HARDENING_FLAGS[@]}" --entrypoint sh "$IMAGE_TAG" -c 'id -u')"
[ "$PROBE_UID" = "1001" ] || fail "o container rodou como uid '${PROBE_UID}', não 1001 — --user não pegou"

# A escrita de sonda vai em /app/media, e não em /app. A diferença NÃO é
# cosmética: /app é root-owned de propósito (Dockerfile), então um `touch
# /app/x` como uid 1001 falha por PERMISSÃO mesmo com o rootfs gravável — a
# primeira versão desta sonda passou verde com `--read-only` removido à mão,
# porque estava medindo o dono do diretório e não o modo do rootfs.
# /app/media é `chown maia:maia` no Dockerfile: o uid 1001 escreve nele
# quando o rootfs é gravável, e só o `--read-only` o impede.
PROBE_OWNER="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c 'stat -c %u /app/media')"
[ "$PROBE_OWNER" = "1001" ] \
  || fail "/app/media pertence ao uid '${PROBE_OWNER}', não a 1001 — a sonda de rootfs deixou de discriminar read-only e precisa de outro alvo"

PROBE_WRITE="$(docker run --rm "${HARDENING_FLAGS[@]}" --entrypoint sh "$IMAGE_TAG" \
  -c 'touch /app/media/__smoke_probe 2>&1 || true')"
case "$PROBE_WRITE" in
  *'Read-only file system'*) ;;
  '') fail "escrever em /app/media funcionou — o rootfs NÃO está read-only, então este smoke não testa a condição que afirma testar" ;;
  *)  fail "a escrita de sonda falhou por outro motivo que não read-only: ${PROBE_WRITE}" ;;
esac
echo "uid 1001 ✓ · rootfs read-only (escrita em /app/media recusada) ✓"

# --- 4. o run REAL ----------------------------------------------------
log "run 1: ${MIGRATE_COMMAND[*]} na imagem de produção, banco vazio"
RUN_LOG="$(mktemp)"
set +e
# shellcheck disable=SC2046
docker run --rm --network "$NETWORK" "${HARDENING_FLAGS[@]}" $(migrator_env_flags) \
  "$IMAGE_TAG" "${MIGRATE_COMMAND[@]}" 2>&1 | tee "$RUN_LOG"
RUN_EXIT="${PIPESTATUS[0]}"
set -e

[ "$RUN_EXIT" -eq 0 ] \
  || fail "'${MIGRATE_COMMAND[*]}' saiu ${RUN_EXIT} dentro da imagem de produção (uid 1001, rootfs read-only)"

grep -q '"event":"migration.applied"' "$RUN_LOG" \
  || fail "o stdout não tem nenhum evento migration.applied — saiu 0 sem que o runner real tenha aplicado nada"

# `|| echo` (e não um psql que estoura): quando o run não criou o ledger, o
# smoke tem de reprovar com a frase que explica o quê, não com um stack de
# psql. A comparação abaixo falha de qualquer jeito — o texto é que muda.
APPLIED="$(psql_smoke "select count(*) from schema_migrations where status = 'applied'" 2>/dev/null || echo 'AUSENTE(schema_migrations não existe)')"
[ "$APPLIED" = "$EXPECTED_MIGRATIONS" ] \
  || fail "o ledger tem ${APPLIED} migrations applied, a imagem empacota ${EXPECTED_MIGRATIONS}"
echo "ledger: ${APPLIED}/${EXPECTED_MIGRATIONS} applied ✓"

# --- 5. segundo run: o caminho "já no head" ---------------------------
log "run 2: mesmo comando, banco já no head"
RUN2_LOG="$(mktemp)"
set +e
# shellcheck disable=SC2046
docker run --rm --network "$NETWORK" "${HARDENING_FLAGS[@]}" $(migrator_env_flags) \
  "$IMAGE_TAG" "${MIGRATE_COMMAND[@]}" 2>&1 | tee "$RUN2_LOG"
RUN2_EXIT="${PIPESTATUS[0]}"
set -e

[ "$RUN2_EXIT" -eq 0 ] \
  || fail "o segundo run saiu ${RUN2_EXIT} — todo deploy sem migration nova cairia aqui e o service_completed_successfully nunca completaria"

APPLIED2="$(psql_smoke "select count(*) from schema_migrations where status = 'applied'")"
[ "$APPLIED2" = "$EXPECTED_MIGRATIONS" ] \
  || fail "o segundo run mexeu no ledger (${APPLIED2} != ${EXPECTED_MIGRATIONS})"

DIRTY="$(psql_smoke "select count(*) from schema_migrations where status <> 'applied'")"
[ "$DIRTY" = "0" ] || fail "sobraram ${DIRTY} linhas fora de 'applied' no ledger"

printf '\n\033[32m✔ SMOKE OK\033[0m — %s rodou na imagem %s como uid 1001, rootfs read-only, e aplicou %s migrations (segundo run idempotente).\n' \
  "${MIGRATE_COMMAND[*]}" "$IMAGE_ID" "$EXPECTED_MIGRATIONS"
