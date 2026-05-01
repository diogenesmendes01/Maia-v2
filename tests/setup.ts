/**
 * Vitest global setup. Forces deterministic env vars for the schema in
 * `src/config/env.ts` so test runs aren't poisoned by the developer's shell
 * environment. Tests that need a custom config still mock `@/config/env.js`
 * directly via `vi.mock`; this file just keeps the *unmocked* import path
 * from blowing up `loadConfig`.
 */
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
