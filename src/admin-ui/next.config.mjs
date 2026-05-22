import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  pageExtensions: ['ts', 'tsx'],
  // `standalone` lets the production Dockerfile copy a minimal Node runtime
  // (`.next/standalone/server.js` + its node_modules subset) into a small
  // image instead of dragging the full repo's node_modules. Required by
  // the dedicated admin-ui container for Coolify (`src/admin-ui/Dockerfile`).
  output: 'standalone',
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:4000', 'localhost:3000'],
    },
    // Tracing root MUST be the repo root, not `src/admin-ui/`. The admin-ui
    // imports cross-tree modules (`../../db/repositories.js`,
    // `../../identity/profile-renderer.js`, `../../config/env.js`, etc.) plus
    // their transitive root deps (`dotenv`, `pino`, `drizzle-orm`, ...). Without
    // this, Next's file tracer (nft) ignores everything outside the admin-ui
    // package and the standalone bundle ships an image that crashes on the
    // first request with `Cannot find module '../../db/...'` or
    // `Cannot find module 'dotenv'`. Codex Adversarial Review on PR #176.
    //
    // Note: in Next 14.x this lives under `experimental.outputFileTracingRoot`.
    // It moved to top-level `outputFileTracingRoot` in Next 15. Migrate when
    // the admin-ui upgrades.
    outputFileTracingRoot: resolve(__dirname, '../..'),
  },
  // ESM-style imports across the admin-ui use the .js extension on .ts files
  // (consistent with the root tsconfig "module: NodeNext" + tsc-alias output).
  // Next's webpack default doesn't resolve `.js` → `.ts(x)`; this alias does.
  // Without it, `next build` / `next dev` fail with "Module not found" on
  // every internal import.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
