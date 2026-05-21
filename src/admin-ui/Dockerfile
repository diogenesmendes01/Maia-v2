# Dedicated Dockerfile for the Maia Admin UI (Next.js).
#
# The admin-ui lives at `src/admin-ui/` inside the main Maia repo but is
# deployed as its OWN container (see docker-compose.yml + Coolify wiring in
# docs/admin-ui-deploy.md). Coolify routes `admin.${DOMAIN}` to this
# container's port 4000; the main Fastify app stays on port 3000 behind
# `${DOMAIN}`.
#
# Build context: the REPO ROOT (not `src/admin-ui/`) — the build needs
# `src/db/schema.ts`, `src/lib/`, `src/identity/`, etc. that the admin-ui
# imports via the `@/*` path alias. So Coolify must point this Dockerfile
# at the repo root and use `dockerfile: src/admin-ui/Dockerfile`.

# ─── stage: deps ─────────────────────────────────────────────────────────
# Install the admin-ui's local node_modules (next, next-auth, @trpc/*, etc.).
FROM node:25-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY src/admin-ui/package.json src/admin-ui/package-lock.json* ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

# ─── stage: build ────────────────────────────────────────────────────────
# Bring in the repo so the admin-ui's `@/*` aliases can reach
# `src/db/schema.ts` etc. Then run `next build` from inside src/admin-ui.
FROM node:25-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./src/admin-ui/node_modules
COPY . .
RUN cd src/admin-ui && npm run build

# ─── stage: runtime ──────────────────────────────────────────────────────
# Standalone server bundle: a minimal Node runtime that the next.config.mjs
# `output: 'standalone'` setting produces under .next/standalone.
FROM node:25-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4000
ENV HOSTNAME=0.0.0.0
RUN apk add --no-cache tini

# Next standalone output bundles its own minimal node_modules + flattens
# the workspace so the entrypoint is `server.js` at the standalone root.
# We don't ship a `public/` directory — favicon.ico is emitted from `app/`.
# Static assets MUST live at `.next/static/` (relative to server.js) for
# Next's static handler to find them.
COPY --from=build /app/src/admin-ui/.next/standalone ./
COPY --from=build /app/src/admin-ui/.next/static ./.next/static

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
