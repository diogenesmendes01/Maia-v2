import { defineConfig, devices } from '@playwright/test';

/**
 * P8.5 — Playwright config for admin-ui E2E tests.
 *
 * Requires:
 *   - npm install (root + src/admin-ui)
 *   - npm run admin:dev (Fastify :3000 + Next.js :4000)
 *
 * Run: `npm run test:admin-ui:e2e`
 */
export default defineConfig({
  testDir: './tests/admin-ui/e2e',
  fullyParallel: false, // admin-ui tests touch shared DB; serialize for safety
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
