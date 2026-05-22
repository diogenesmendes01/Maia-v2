# Deploying the Admin UI (Coolify, 2-container split)

The repo ships **two** Dockerfiles:

| Service     | Path                       | Port | Purpose                              |
|-------------|----------------------------|------|--------------------------------------|
| `app`       | `Dockerfile`               | 3000 | Fastify backend (WhatsApp gateway, agent runtime, /health, /metrics, /setup) |
| `admin-ui`  | `src/admin-ui/Dockerfile`  | 4000 | Next.js admin console (NextAuth, /dashboard, /inbox, /identities, /setup/*, …) |

Both share the same Postgres + Redis. In production they live behind a
reverse proxy that routes by host:

```
${DOMAIN}          → app container       (Fastify :3000) — webhook + /metrics + health
admin.${DOMAIN}    → admin-ui container  (Next.js :4000) — governance console
```

## Coolify setup (one repo, two applications)

In Coolify, create **two separate applications** pointing at the same git
repo + branch. Coolify will deploy each on a push.

### Application 1 — `maia` (existing)

- Build pack: **Dockerfile**
- Dockerfile path: `Dockerfile` (repo root)
- Build context: `/` (repo root)
- Domain: `${DOMAIN}` (e.g. `maia.menddes.com`)
- Container port: `3000`
- Health check: `GET /health` → 200
- Resources: the same `app` you already have. After this PR, the
  Fastify-served `/dashboard` is gone — `${DOMAIN}/dashboard` returns 404,
  which is correct.

### Application 2 — `maia-admin-ui` (new)

- Build pack: **Dockerfile**
- Dockerfile path: `src/admin-ui/Dockerfile`
- Build context: `/` (repo root — admin-ui needs `src/db/`, `src/lib/`, etc.)
- Domain: `admin.${DOMAIN}` (e.g. `admin.maia.menddes.com`)
- Container port: `4000`
- Health check: `GET /api/auth/csrf` → 200 (NextAuth endpoint that always
  responds when the server is up)

### Environment variables (Application 2)

Set in Coolify's environment editor for `maia-admin-ui`. **All marked
required must be set or the container fails fast at boot.**

| Variable                  | Required | Value                                         | Notes                                    |
|---------------------------|----------|-----------------------------------------------|------------------------------------------|
| `NODE_ENV`                | yes      | `production`                                  | Disables dev sign-in path                |
| `DATABASE_URL`            | yes      | Same as `app` container                       | Shared Postgres                          |
| `NEXTAUTH_URL`            | yes      | `https://admin.${DOMAIN}`                     | Must match the public URL exactly        |
| `NEXTAUTH_SECRET`         | yes      | `openssl rand -base64 48`                     | ≥ 32 chars; rotation invalidates sessions |
| `AUTH_TRUST_HOST`         | yes      | `true`                                        | Required behind Coolify's reverse proxy  |
| `OIDC_ISSUER`             | for SSO  | `https://login.example.com/realms/maia`       | `https://` REQUIRED in prod              |
| `OIDC_CLIENT_ID`          | for SSO  | (from IdP)                                    |                                          |
| `OIDC_CLIENT_SECRET`      | for SSO  | (from IdP, ≥ 16 chars)                        | Never logged                             |
| `OIDC_TENANT_SLUGS`       | for SSO  | `default,acme`                                | Non-empty CSV of `app_users.tenant_id`   |
| `FEATURE_ADMIN_UI_V1`     | no       | unset                                         | Gates dev sign-in — keep unset in prod   |
| `ALLOW_DEV_AUTH`          | no       | unset                                         | Same                                     |
| `ADMIN_UI_DEV_LOGIN_TOKEN`| no       | unset                                         | Same                                     |

> ⚠️ **Inherited env vars (known wart):** The admin-ui imports
> `@/db/client.ts`, which loads the main app's global config validator
> (`@/config/env.ts`). That validator demands **every** main-app env var be
> present — `WHATSAPP_NUMBER_MAIA`, `OWNER_TELEFONE_WHATSAPP`,
> `OWNER_NOME`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
> `VOYAGE_API_KEY`, `ALERT_CHANNELS`, `REDIS_URL`, `POSTGRES_*` — even
> though the admin-ui doesn't use any of them. Until a follow-up refactor
> splits the config, **the simplest path is to give the admin-ui container
> the same `env_file: .env` as the main `app`**. `docker-compose.yml` does
> this already. In Coolify, point Application 2's env to the same source
> as Application 1 OR explicitly copy the values.
>
> **Do NOT** copy `FEATURE_ADMIN_UI_V1`, `ALLOW_DEV_AUTH`, or
> `ADMIN_UI_DEV_LOGIN_TOKEN` into the production `maia-admin-ui` env. The
> dev sign-in's gating explicitly bails on `NODE_ENV === 'production'` — but
> not setting them at all keeps the audit trail clean.

### IdP callback registration

The OIDC IdP must allow the exact redirect URI:

```
${NEXTAUTH_URL}/api/auth/callback/oidc
```

For `admin.maia.menddes.com`, that's:

```
https://admin.maia.menddes.com/api/auth/callback/oidc
```

Register this in your IdP (Auth0 / Keycloak / Okta / etc.) before the
first prod sign-in attempt.

## Seeding the first owner

After the admin-ui container is up, you still need at least one
`app_users` row that matches an IdP email, or the SSO sign-in will hit
`AccessDenied`. From `psql` against the shared Postgres:

```sql
INSERT INTO app_users (id, tenant_id, email, name, role, email_verified)
VALUES (
  gen_random_uuid()::text,
  'default',
  'you@example.com',
  'Your Name',
  'founder',
  now()
);
```

The IdP email claim must equal `app_users.email` (case-insensitive). The
tenant_id must appear in `OIDC_TENANT_SLUGS`.

## Smoke-testing locally (single host)

`docker-compose.yml` ships both services. From the repo root:

```bash
cp .env.example .env
# Edit .env: set NEXTAUTH_SECRET (>=32 chars), NEXTAUTH_URL, OIDC_* (optional)
docker compose up -d postgres redis
docker compose up --build app admin-ui
```

Then open `http://localhost:4000` — sign-in page lives at
`http://localhost:4000/auth/signin`.

## Migration prerequisites

After deploy, run migrations once:

```bash
docker compose run --rm app npm run db:migrate
```

This is what creates `app_users` / `app_sessions` (migration 045) and
drops the legacy `dashboard_sessions` (migration 062).
