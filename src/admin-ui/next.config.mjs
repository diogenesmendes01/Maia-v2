import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions: ['ts', 'tsx'],
  // `standalone` lets the production Dockerfile copy a minimal Node runtime
  // (`.next/standalone/server.js` + its node_modules subset) into a small
  // image instead of dragging the full repo's node_modules. Required by
  // the dedicated admin-ui container for Coolify (`src/admin-ui/Dockerfile`).
  output: 'standalone',
  // Tracing root MUST be the repo root, not `src/admin-ui/`. The admin-ui
  // imports cross-tree modules (`../../db/repositories.js`,
  // `../../identity/profile-renderer.js`, `../../config/env.js`, etc.) plus
  // their transitive root deps (`dotenv`, `pino`, `drizzle-orm`, ...). Without
  // this, Next's file tracer (nft) ignores everything outside the admin-ui
  // package and the standalone bundle ships an image that crashes on the
  // first request with `Cannot find module '../../db/...'` or
  // `Cannot find module 'dotenv'`. Codex Adversarial Review on PR #176.
  //
  // Top-level since Next 15 (was `experimental.outputFileTracingRoot` in 14.x).
  outputFileTracingRoot: resolve(__dirname, '../..'),
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:4000', 'localhost:3000'],
    },
  },
  // Issue #518 — `Referrer-Policy: no-referrer` em TODAS as páginas do
  // console. As URLs do admin carregam ids de tenant/agente/canal; sem esta
  // política, qualquer navegação ou recurso externo levaria a URL de origem
  // no header `Referer`. É também a contrapartida no console da mesma regra
  // já aplicada ao `/setup` do runtime. `nosniff` e `DENY` são higiene padrão
  // da mesma superfície.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
  // ESM-style imports across the admin-ui use the .js extension on .ts files
  // (consistent with the root tsconfig "module: NodeNext" + tsc-alias output).
  // Next's webpack default doesn't resolve `.js` → `.ts(x)`; this alias does.
  // Without it, `next build` / `next dev` fail with "Module not found" on
  // every internal import.
  //
  // ---------------------------------------------------------------------
  // Next 16 — por que `dev` e `build` passam `--webpack` (issue #604)
  // ---------------------------------------------------------------------
  // No Next 16 o Turbopack virou o bundler PADRÃO de `next dev` e de
  // `next build`, e um projeto com config `webpack` REPROVA o build de
  // propósito ("This build is using Turbopack, with a `webpack` config and
  // no `turbopack` config"). O guia de migração dá três saídas; a escolhida
  // aqui é a terceira, e as outras duas foram MEDIDAS antes de descartadas:
  //
  //   1. Usar o Turbopack assim mesmo (`--turbopack` / `turbopack: {}`).
  //      Medido nesta worktree: o build morre com "Module not found" em
  //      TODO import interno — `../../lib/auth.js`, `../../trpc/context.js`,
  //      `middleware.ts:65`, `app/layout.tsx:4`, ~30 arquivos. O Turbopack
  //      não reimplementa o `extensionAlias` do webpack.
  //
  //   2. Migrar a config para opções equivalentes do Turbopack. NÃO EXISTE
  //      equivalente: o Turbopack expõe `resolveAlias` e `resolveExtensions`
  //      (ver `turbopack.md` nos docs embarcados em node_modules/next), e
  //      nenhum dos dois reescreve o especificador `foo.js` para `foo.ts` —
  //      `resolveExtensions` só vale para especificador SEM extensão. A
  //      alternativa seria tirar o `.js` de todo import interno do console,
  //      que é um refactor de toda a árvore e contradiz a convenção de
  //      módulos da raiz — fora do escopo de um upgrade.
  //
  //   3. `--webpack`: o opt-out documentado. Mantém a resolução de módulos
  //      IGUAL à do 15.5, que é exatamente o que um upgrade deve preservar.
  //
  // O dia em que o `.js` sair dos imports internos, este bloco e os dois
  // `--webpack` do package.json saem juntos.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
