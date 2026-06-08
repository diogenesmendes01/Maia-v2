/**
 * Vitest global setup. Forces deterministic env vars for the schema in
 * `src/config/env.ts` so test runs aren't poisoned by the developer's shell
 * environment. Tests that need a custom config still mock `@/config/env.js`
 * directly via `vi.mock`; this file just keeps the *unmocked* import path
 * from blowing up `loadConfig`.
 */
import { beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://maia_test:test1234@localhost:5432/maia_test';
process.env.POSTGRES_USER = 'maia_test';
process.env.POSTGRES_PASSWORD = 'test1234';
process.env.POSTGRES_DB = 'maia_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
process.env.OPENROUTER_API_KEY = 'sk-or-test-placeholder';
process.env.WHATSAPP_NUMBER_MAIA = '+5500000000000';
process.env.OWNER_TELEFONE_WHATSAPP = '+5511111111111';
process.env.OWNER_NOME = 'Test Owner';
process.env.VOYAGE_API_KEY = 'test-voyage-key';
process.env.ALERT_CHANNELS = 'log';

// issue #323: PRODUCTION defaults `MAIA_REJECT_DEFAULT_LITERAL` ON (reject the
// 'default' literal fail-closed, opt-out). The unit suite uses 'default' as a
// generic mock tenant in many unrelated tests, so the TEST baseline is OFF; the
// dedicated rejection/flip tests set it to 'true' (or delete it) per-case. A
// beforeEach re-asserts the baseline so a per-case override never leaks across
// tests (threads share process.env).
process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
beforeEach(() => {
  process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
});
