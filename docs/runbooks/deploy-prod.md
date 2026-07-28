# Runbook — Deploy de produção (`compose.prod.yml`)

> Auditoria P0 cap. 6. Produção NUNCA usa `docker-compose.yml` (compose de
> dev: portas de datastore no host, fallback `maia/maia`, Redis sem auth,
> `.env` inteiro em todos os containers, processos root).

## 1. Bring-up

```bash
cd /opt/maia   # checkout do repo no host

# Env por serviço (uma vez; rotacione depois conforme política)
cp .env.app.prod.example .env.app       && chmod 600 .env.app
cp .env.admin.prod.example .env.admin   && chmod 600 .env.admin
# preencha ambos — placeholders __SET_ME__ são rejeitados no boot

# Credenciais de infra — usadas SÓ para interpolação do compose
cat > .env.infra <<'EOF'
POSTGRES_USER=maia_prod
POSTGRES_PASSWORD=<openssl rand -hex 24>   # URL-safe, min 8 chars
POSTGRES_DB=maia
REDIS_PASSWORD=<openssl rand -hex 24>
EOF
chmod 600 .env.infra

docker compose --env-file .env.infra -f compose.prod.yml up -d --build
docker compose --env-file .env.infra -f compose.prod.yml ps
```

Migrations: `docker compose --env-file .env.infra -f compose.prod.yml exec app npm run db:migrate`.

## 2. Arquivos de segredo (o que mora onde)

| Arquivo      | Vai para                  | Conteúdo                                              |
| ------------ | ------------------------- | ----------------------------------------------------- |
| `.env.infra` | interpolação do compose   | `POSTGRES_USER/PASSWORD/DB`, `REDIS_PASSWORD`         |
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
