# Dedicated Dockerfile for the Maia Admin UI (Next.js).
#
# The admin-ui lives at `src/admin-ui/` inside the main Maia repo but is
# deployed as its OWN container (see compose.prod.yml + Coolify wiring in
# docs/admin-ui-deploy.md). Coolify routes `admin.${DOMAIN}` to this
# container's port 4000; the main Fastify app stays on port 3000 behind
# `${DOMAIN}`.
#
# Build context: the REPO ROOT (not `src/admin-ui/`) — the build needs
# `src/db/schema.ts`, `src/lib/`, `src/identity/`, etc. that the admin-ui
# imports via the `@/*` path alias. So Coolify must point this Dockerfile
# at the repo root and use `dockerfile: src/admin-ui/Dockerfile`.
#
# Node pinado em 22 (`.nvmrc` / engines) — antes node:25-alpine, drift em
# relação ao que CI/dev rodam. Auditoria P0 cap. 6: `npm ci` em vez de
# `npm install`, e runtime non-root (uid 1001).
#
# Dependency story (Codex Adversarial Review on PR #176, [P1]/[high]):
#   The admin-ui's `package.json` ONLY declares Next + NextAuth + tRPC +
#   tailwind. But the runtime imports reach `src/db/client.ts` →
#   `src/config/env.ts` → `dotenv`, `zod`, `pg`, `drizzle-orm`, `pino`, ...
#   all declared in the ROOT package.json. We therefore install BOTH:
#     1. `src/admin-ui/node_modules`  — Next-specific deps
#     2. root `node_modules`          — shared runtime deps the admin-ui
#                                        transitively imports
#   The standalone bundle uses `outputFileTracingRoot` (in next.config.mjs)
#   to follow imports across both trees so they land inside the final image.

# ─── stage: root-deps ───────────────────────────────────────────────────
# Install the REPO's runtime deps. Required because the admin-ui pulls
# `src/db/client.ts` → `@/config/env.ts` → `dotenv`, plus indirect deps via
# `src/db/schema.ts`, `src/lib/*`, etc.
FROM node:22-alpine AS root-deps
WORKDIR /app
# O preinstall guard do package.json RAIZ exige npm >=11.5.2 <12 (pin do
# lockfile — ver CONTRIBUTING.md); node:22-alpine embarca npm 10.x.
RUN apk add --no-cache libc6-compat \
  && npm install -g npm@11.5.2
COPY package.json package-lock.json ./
# `npm ci`: instala exatamente o lockfile, falha em drift.
RUN npm ci --omit=dev --no-audit --no-fund

# ─── stage: admin-deps ──────────────────────────────────────────────────
# Install the admin-ui's local node_modules (next, next-auth, @trpc/*,
# tailwind) from the admin-ui's OWN package-lock.json. --legacy-peer-deps
# preserved from the previous `npm install` (peer conflicts in the
# next-auth v5 beta tree).
FROM node:22-alpine AS admin-deps
WORKDIR /app
RUN apk add --no-cache libc6-compat \
  && npm install -g npm@11.5.2
COPY src/admin-ui/package.json src/admin-ui/package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

# ─── stage: build ───────────────────────────────────────────────────────
# Bring in BOTH node_modules trees + the repo source, then run `next build`.
# Build env needs the full main-app config vars set because the admin-ui's
# transitive import of `@/config/env.ts` validates them eagerly during the
# Next.js page-data-collection pass — see the BUILD_ENV defaults below.
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Stub values so the build doesn't fail validating env. None of these reach
# the runtime image — Coolify supplies the real values at container start.
ENV NODE_ENV=production
ENV NEXTAUTH_SECRET=build-time-only-secret-min-32-chars-not-shipped-12345
ENV NEXTAUTH_URL=http://localhost:4000
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV POSTGRES_USER=build
ENV POSTGRES_PASSWORD=buildbuild
ENV POSTGRES_DB=build
ENV REDIS_URL=redis://localhost:6379
ENV WHATSAPP_NUMBER_MAIA=+5500000000000
ENV OWNER_TELEFONE_WHATSAPP=+5511111111111
ENV OWNER_NOME=build
ENV ANTHROPIC_API_KEY=sk-ant-build
ENV OPENROUTER_API_KEY=sk-or-build
ENV VOYAGE_API_KEY=voyage-build
ENV ALERT_CHANNELS=log
# config/env.ts fail-closes in production when RUNTIME_TRACE_HMAC_MASTER_SECRET
# is unset (its superRefine: audit HMACs would be forgeable without it, added in
# P10b / made unconditional in P11). The admin-ui transitively imports that
# validator via @/db/client.ts during `next build`'s page-data collection pass,
# so the BUILD needs a stub too — otherwise `next build` crashes on
# "Failed to collect page data for /api/auth/[...nextauth]". The REAL KMS-backed
# secret is injected by Coolify at container START (same value as the main app —
# see docs/admin-ui-deploy.md "Inherited env vars"). This stub never ships.
ENV RUNTIME_TRACE_HMAC_MASTER_SECRET=build-time-only-hmac-not-shipped-min-32-chars-1234567890

COPY --from=root-deps  /app/node_modules ./node_modules
COPY --from=admin-deps /app/node_modules ./src/admin-ui/node_modules
COPY . .
RUN cd src/admin-ui && npm run build

# ─── stage: runtime ─────────────────────────────────────────────────────
# Standalone server bundle: Next.js emits a minimal Node runtime under
# .next/standalone, with traced node_modules from BOTH trees (because
# `outputFileTracingRoot` is set to the repo root in next.config.mjs).
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4000
ENV HOSTNAME=0.0.0.0
RUN apk add --no-cache tini
# Usuário dedicado non-root (uid/gid 1001 `maia`) — auditoria P0 cap. 6.
RUN addgroup -g 1001 -S maia \
  && adduser -u 1001 -S -G maia maia

# Standalone output flattens the workspace. With outputFileTracingRoot at
# the repo root, the produced layout is:
#   .next/standalone/server.js
#   .next/standalone/src/admin-ui/server.js  (the actual Next entrypoint)
#   .next/standalone/node_modules/...
#   .next/standalone/src/admin-ui/node_modules/...
# Static assets are at .next/static and must be copied separately.
#
# --chown segue o exemplo oficial do Next (nextjs:nodejs): o runtime
# standalone escreve cache em .next/cache (ISR/imagens/fetch-cache) —
# precisa ser gravável pelo uid 1001 quando o container roda sem
# read_only. Em compose.prod.yml o rootfs é read-only e o cache vira
# tmpfs, então o chown é apenas o fallback para `docker run` avulso.
COPY --from=build --chown=maia:maia /app/src/admin-ui/.next/standalone ./
COPY --from=build --chown=maia:maia /app/src/admin-ui/.next/static ./src/admin-ui/.next/static
RUN mkdir -p /app/src/admin-ui/.next/cache \
  && chown -R maia:maia /app/src/admin-ui/.next/cache

EXPOSE 4000
USER maia
ENTRYPOINT ["/sbin/tini", "--"]
# The standalone bundle puts the Next entrypoint at src/admin-ui/server.js
# when outputFileTracingRoot is set to the repo root (it preserves the
# original directory shape).
CMD ["node", "src/admin-ui/server.js"]
