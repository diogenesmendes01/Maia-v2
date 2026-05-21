import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Post-Codex-review #101: admin-ui has its own node_modules (Next.js +
// @trpc/server). When admin-ui router code runs under vitest from the repo
// root, two copies of @trpc/server would be loaded — root's (for the test
// file's import) and admin-ui's (for the router's import). Two copies ⇒ two
// distinct TRPCError classes ⇒ `instanceof TRPCError` fails. We alias both
// resolvers to whichever copy actually exists at test time so a single class
// instance is shared.
const adminUiTrpcServer = resolve(__dirname, 'src/admin-ui/node_modules/@trpc/server');
const rootTrpcServer = resolve(__dirname, 'node_modules/@trpc/server');
const trpcServerAlias = existsSync(rootTrpcServer)
  ? rootTrpcServer
  : existsSync(adminUiTrpcServer)
    ? adminUiTrpcServer
    : undefined;

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      ...(trpcServerAlias ? { '@trpc/server': trpcServerAlias } : {}),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/admin-ui/e2e/**'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // A handful of integration specs share process-wide singletons (Decision
    // Engine module-level caches, the Baileys presence handle, etc.) and
    // flake when they run after a polluting test file in the same worker.
    // Retrying once absorbs the flake without hiding a real regression — a
    // true failure surfaces on the second attempt too.
    retry: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
