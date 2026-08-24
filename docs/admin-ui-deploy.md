# Deploying the Admin UI (Coolify, 2-container split)

> **Onde este arquivo se encaixa (reconciliado na issue #565).** A fonte
> canônica do deploy de produção é
> [`docs/runbooks/deploy-prod.md`](runbooks/deploy-prod.md). Este arquivo
> cobre **só** a topologia de duas aplicações no Coolify: qual Dockerfile,
> qual porta, qual domínio, quais variáveis do console. Onde os dois
> divergiam, o runbook ganhou — as divergências corrigidas estão listadas em
> [Reconciliação com o runbook](#reconciliação-com-o-runbook), no fim.
>
> **Migrations não são mais um passo pós-deploy.** Desde a #516 elas rodam
> num job one-shot que bloqueia a subida; fora do Compose, em
> `npm run release:migrate` (runbook §7, que diz o que ali foi executado e o
> que não foi). A instrução antiga — "depois do deploy, rode
> `docker compose run --rm app npm run db:migrate`" — **foi removida deste
> arquivo**, porque é exatamente a janela que o gate existe para fechar: app
> de pé contra schema atrasado.

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
- Health check: `GET /livez` → 200 — o MESMO endpoint que
  `compose.prod.yml` usa (issue #512). Se o campo do painel decide
  **roteamento de tráfego** (e não restart), o endpoint certo é `/readyz`,
  que é fail-closed e é onde a readiness de schema da #516 está ligada.

  > **Não use `/health`, e isso agora é contrato, não acidente.** Desde a
  > issue #613 ele é um endpoint **de diagnóstico**: responde **200 sempre**
  > que consegue produzir o relatório, inclusive quando o corpo diz
  > `"status": "down"`. Como health check ele **nunca detecta nada** — e,
  > diferente de antes, isso está declarado: `reply.code(200)` explícito no
  > handler (`src/server.ts`, `asDiagnostic()`), header
  > `x-maia-endpoint-kind: diagnostic` em toda resposta de `/health*` e
  > `"probe": false` + o mapa `probes` no corpo. O motivo de ele não passar a
  > 503 está na [ADR 0003](architecture/decisions/0003-health-is-diagnostic-livez-readyz-are-the-probes.md):
  > `checkAll()` é role-blind, e `whatsapp: down` é o estado normal de um
  > processo `api`/`worker`/`scheduler` — um LB apontado para lá drenaria
  > instâncias corretas.
  >
  > **Se você configurou este campo como `GET /health` antes de ler isto,
  > troque agora.** Aquele check está verde desde sempre, inclusive durante
  > as quedas que ele deveria ter pego.
- Resources: the same `app` you already have. After this PR, the
  Fastify-served `/dashboard` is gone — `${DOMAIN}/dashboard` returns 404,
  which is correct.
- **Gate de migration: é AQUI.** `npm run release:migrate`, no campo de
  comando pré-deploy ou encadeado no comando de start. Esta imagem é a única
  das duas que consegue rodá-lo. Ver
  [`docs/runbooks/deploy-prod.md`](runbooks/deploy-prod.md) §7.

### Application 2 — `maia-admin-ui` (new)

- Build pack: **Dockerfile**
- Dockerfile path: `src/admin-ui/Dockerfile`
- Build context: `/` (repo root — admin-ui needs `src/db/`, `src/lib/`, etc.)
- Domain: `admin.${DOMAIN}` (e.g. `admin.maia.menddes.com`)
- Container port: `4000`
- Health check: `GET /` com status < 500 — o MESMO critério de
  `compose.prod.yml` (a raiz redireciona para o sign-in; qualquer resposta
  abaixo de 500 significa servidor de pé). O `GET /api/auth/csrf` que este
  arquivo pedia antes divergia do compose sem motivo registrado.
- **Sem gate de migration aqui.** Esta imagem é o `standalone` do Next.js: o
  estágio de runtime de `src/admin-ui/Dockerfile` copia `.next/standalone` e
  `.next/static`, e mais nada — sem `scripts/`, sem `migrations/`, sem o
  `package.json` da raiz, sem `tsx`. `npm run release:migrate` aqui falha com
  "missing script". Deploy a Aplicação 1 primeiro; fora do Compose essa ordem
  é disciplina, não uma aresta declarada.

### Environment variables (Application 2)

Set in Coolify's environment editor for `maia-admin-ui`. **All marked
required must be set or the container fails fast at boot.**

| Variable                  | Required | Value                                         | Notes                                    |
|---------------------------|----------|-----------------------------------------------|------------------------------------------|
| `NODE_ENV`                | yes      | `production`                                  | Disables dev sign-in path                |
| `MAIA_ENV`                | yes      | `production` (ou `staging`)                   | **O contrato a exige nos profiles `staging`/`production` para TODOS os serviços** (`src/config/contract.ts`), e `NODE_ENV=production` não supre: ele é o modo do Node, não o profile da Maia, e não sabe dizer `staging`. No Compose ela vem do `.env.infra`; aqui, do editor do painel — o MESMO valor nas duas aplicações |
| `DATABASE_URL`            | yes      | Same as `app` container                       | Shared Postgres                          |
| `NEXTAUTH_URL`            | yes      | `https://admin.${DOMAIN}`                     | Must match the public URL exactly        |
| `NEXTAUTH_SECRET`         | yes      | `openssl rand -base64 48`                     | ≥ 32 chars; rotation invalidates sessions |
| `AUTH_TRUST_HOST`         | yes      | `true`                                        | Required behind Coolify's reverse proxy  |
| `RUNTIME_TRACE_HMAC_MASTER_SECRET` | yes | Same value as the `app` container | Required in prod — `@/config/env.ts` fail-closes without it (audit HMACs would be forgeable). Set **runtime-only, NOT a build variable**: the Dockerfile build uses a throwaway stub, so the real secret never enters the build env or logs. |
| `MAIA_STAGING_KEYRING` / `MAIA_STAGING_ACTIVE_KEY_ID` | for pairing | Same values as the `app` container | Required to pair WhatsApp lines from the console (issue #518). O QR/código só atravessam o Postgres CIFRADOS com este keyring — sem ele a tela de linhas continua mostrando os estados, mas o botão de parear fica desabilitado com a explicação. Runtime-only, nunca variável de build. |
| `OIDC_ISSUER`             | yes      | `https://login.example.com/realms/maia`       | `https://` REQUIRED in prod              |
| `OIDC_CLIENT_ID`          | yes      | (from IdP)                                    |                                          |
| `OIDC_CLIENT_SECRET`      | yes      | (from IdP, ≥ 16 chars)                        | Never logged                             |
| `OIDC_TENANT_SLUGS`       | yes      | `default,acme`                                | Non-empty CSV of `app_users.tenant_id`   |
| `FEATURE_ADMIN_UI_V1`     | no       | unset                                         | Gates dev sign-in — keep unset in prod   |
| `ALLOW_DEV_AUTH`          | no       | unset                                         | Same                                     |
| `ADMIN_UI_DEV_LOGIN_TOKEN`| no       | unset                                         | Same                                     |

> As quatro `OIDC_*` estavam marcadas aqui como "for SSO", isto é,
> opcionais. **Não são**: o contrato as marca
> `requiredIn: ['staging','production']` e `services: ['admin-ui']`
> (`src/config/contract.ts`). O `.env.admin.prod.example` já foi corrigido
> na mesma direção; este arquivo estava atrasado. Sem elas o console sobe e
> entrega a tela "no providers configured" — ver
> [`docs/runbooks/deploy-prod.md`](runbooks/deploy-prod.md) §1.

> ⚠️ **Inherited env vars (known wart):** The admin-ui imports
> `@/db/client.ts`, which loads the main app's global config validator
> (`@/config/env.ts`). That validator demands **every** main-app env var be
> present — `WHATSAPP_NUMBER_MAIA`, `OWNER_TELEFONE_WHATSAPP`,
> `OWNER_NOME`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
> `VOYAGE_API_KEY`, `ALERT_CHANNELS`, `REDIS_URL`, `POSTGRES_*` — even
> though the admin-ui doesn't use any of them.
>
> **O conselho que estava aqui — "dê ao admin-ui o mesmo `env_file: .env` do
> `app`" — vale para DEV e só para dev**, e o `docker-compose.yml` o faz com
> a ressalva `DEV-ONLY` escrita nas duas linhas de `env_file`. Em produção
> ele contradiz a postura que a #515/#516 montou: `compose.prod.yml` dá a
> cada container o SEU arquivo (`.env.app` / `.env.admin`), e o migrator não
> recebe arquivo nenhum. Um console que carrega as chaves de LLM e a sessão
> de WhatsApp amplia o raio de explosão sem usar nada disso.
>
> O que fazer no painel: preencher o editor da Aplicação 2 a partir de
> [`.env.admin.prod.example`](../.env.admin.prod.example) — o mínimo
> transitivo que `src/config/env.ts` exige, e não o `.env` do `app`. O que
> ainda falta nesse mínimo para o boot passar está listado em
> [`docs/runbooks/deploy-prod.md`](runbooks/deploy-prod.md) §1 ("O que os
> exemplos NÃO cobrem", issue #572) — não invente as chaves que faltam,
> siga aquela lista.
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
docker compose up --build migrate app admin-ui
```

O `migrate` aparece explicitamente no segundo comando porque nomear serviços
sobe só eles e suas dependências — e `app`/`admin-ui` DEPENDEM do job, então
ele viria junto de qualquer forma. Está escrito para que a ordem fique
visível: `migrate` roda, sai 0, e só então os dois sobem. Um
`docker compose up -d` sem nomes faz o mesmo.

Then open `http://localhost:4000` — sign-in page lives at
`http://localhost:4000/auth/signin`.

## Migrations

**Não há passo pós-deploy.** As tabelas que este console lê
(`app_users`/`app_sessions`, migration 045; a remoção de
`dashboard_sessions`, migration 062) são criadas por um job one-shot que
roda ANTES de qualquer container de aplicação subir (issue #516):

- **por Compose** — `compose.prod.yml` tem o serviço `migrate`, e `app` e
  `admin-ui` declaram
  `depends_on: { migrate: { condition: service_completed_successfully } }`.
  O próprio `up` aplica; um migrate que falha derruba o `up` inteiro;
- **fora do Compose (Coolify)** — `npm run release:migrate`, ligado como
  comando pré-deploy ou encadeado no comando de start. Ver
  [`docs/runbooks/deploy-prod.md`](runbooks/deploy-prod.md) §7, que separa
  linha a linha o que foi executado do que não foi.

A instrução antiga desta seção mandava rodar
`docker compose run --rm app npm run db:migrate` **depois** do deploy. Entre
um passo e outro o console já estava de pé contra um schema atrasado — a
janela exata que o gate fecha. Ela foi removida na issue #565.

## Reconciliação com o runbook

Este arquivo e [`docs/runbooks/deploy-prod.md`](runbooks/deploy-prod.md)
divergiam. O que foi corrigido aqui, e contra o quê:

| O que este arquivo dizia | O que vale | Fonte |
|---|---|---|
| "After deploy, run migrations once" | Migrations rodam ANTES da subida, num job que a bloqueia | `compose.prod.yml` (serviço `migrate`), runbook §1 e §7, issue #516 |
| Health check do `app`: `GET /health` → 200 | `GET /livez` (restart) ou `GET /readyz` (roteamento). `/health` é **diagnóstico** e responde 200 mesmo `down`, por decisão | `compose.prod.yml`, `src/server.ts`, issues #512 e **#613**, [ADR 0003](architecture/decisions/0003-health-is-diagnostic-livez-readyz-are-the-probes.md) |
| Health check do `admin-ui`: `GET /api/auth/csrf` | `GET /` com status < 500 | `compose.prod.yml` |
| `MAIA_ENV` ausente da tabela de variáveis | Obrigatória em `staging`/`production`, nas DUAS aplicações | `src/config/contract.ts`, runbook §1 |
| `OIDC_*` "for SSO" (opcionais) | Obrigatórias em `staging`/`production` | `src/config/contract.ts`, `.env.admin.prod.example` |
| "dê ao admin-ui o mesmo `.env` do app" | Env por serviço; DEV-ONLY no compose de dev | `compose.prod.yml`, issues #515/#516 |

O que **não** foi resolvido aqui, de propósito: as chaves que ainda faltam
para `app`/`admin-ui` passarem no boot (`BACKUP_*`, e o subset transitivo do
console). Isso é a issue #572, tem PR em voo, e mexer nisso por aqui
duplicaria a decisão em dois lugares.
