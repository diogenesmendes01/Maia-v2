FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache postgresql-client tini

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM base AS build
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
ENV TZ=America/Sao_Paulo
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
