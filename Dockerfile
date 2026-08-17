# Node pinado na linha que o repo realmente testa: .nvmrc = 22 e
# package.json engines `"node": ">=22.13.0"` (o piso é o maior entre o do
# npm@11.5.2 pinado, `^20.17.0 || >=22.9.0`, e o do eslint no lockfile,
# `^20.19.0 || ^22.13.0 || >=24`, que o `engine-strict=true` do .npmrc torna
# obrigatório). A tag `node:22-alpine` resolve para o 22.x corrente, acima
# desse piso.
# (Antes: node:26-alpine — dois majors à frente de CI/dev, superfície de
# drift desnecessária.)
FROM node:26-alpine AS base
WORKDIR /app
# node:22-alpine embarca npm 10.x, mas o preinstall guard do package.json
# exige npm >=11.5.2 <12 (pin do formato do package-lock.json — ver
# CONTRIBUTING.md). Alinha o builder ANTES de qualquer `npm ci`.
RUN apk add --no-cache postgresql-client tini \
  && npm install -g npm@11.5.2

FROM base AS deps
COPY package.json package-lock.json ./
# O guard precisa existir no filesystem antes do `npm ci`: o `preinstall` do
# package.json ainda o encadeia (rede de segurança do caminho `npm install`),
# e a linha `RUN node scripts/check-node.mjs` abaixo o invoca de propósito.
# Copiar só o guard (e não o `scripts/` inteiro) preserva o cache deste layer.
COPY scripts/check-node.mjs ./scripts/check-node.mjs
# O guard é INVOCADO explicitamente, e não deixado a cargo do `preinstall`:
# com `engine-strict=true` (.npmrc) um Node fora de `engines` morre em
# `EBADENGINE` antes de qualquer lifecycle script, e num `npm ci` que passa o
# `preinstall` só roda DEPOIS de a árvore estar escrita. Quem barra de fato é
# `devEngines.runtime` (package.json, onFail: error); esta linha garante a
# MENSAGEM legível por construção. Coberto por
# tests/unit/scripts/check-node.spec.ts.
RUN node scripts/check-node.mjs
# `npm ci` (não `npm install`): instala EXATAMENTE o lockfile e falha em
# drift, em vez de regenerar silenciosamente um lockfile incompatível.
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS build
COPY package.json package-lock.json ./
# O guard precisa existir no filesystem antes do `npm ci`: o `preinstall` do
# package.json ainda o encadeia (rede de segurança do caminho `npm install`),
# e a linha `RUN node scripts/check-node.mjs` abaixo o invoca de propósito.
# Copiar só o guard (e não o `scripts/` inteiro) preserva o cache deste layer.
COPY scripts/check-node.mjs ./scripts/check-node.mjs
# O guard é INVOCADO explicitamente, e não deixado a cargo do `preinstall`:
# com `engine-strict=true` (.npmrc) um Node fora de `engines` morre em
# `EBADENGINE` antes de qualquer lifecycle script, e num `npm ci` que passa o
# `preinstall` só roda DEPOIS de a árvore estar escrita. Quem barra de fato é
# `devEngines.runtime` (package.json, onFail: error); esta linha garante a
# MENSAGEM legível por construção. Coberto por
# tests/unit/scripts/check-node.spec.ts.
RUN node scripts/check-node.mjs
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
# Usuário dedicado non-root (uid/gid 1001 `maia`) — auditoria P0 cap. 6.
RUN addgroup -g 1001 -S maia \
  && adduser -u 1001 -S -G maia maia
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
# Pontos de montagem graváveis do runtime (sessão Baileys + mídia). O
# código em si fica root-owned de propósito (o processo não consegue
# alterar o próprio código). Volumes nomeados NOVOS herdam este chown na
# primeira montagem; volumes de um deployment root-era precisam de um
# chown único para uid 1001 — ver docs/runbooks/deploy-prod.md.
RUN mkdir -p /app/.baileys-auth /app/media \
  && chown -R maia:maia /app/.baileys-auth /app/media
ENV TZ=America/Sao_Paulo
EXPOSE 3000
USER maia
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
