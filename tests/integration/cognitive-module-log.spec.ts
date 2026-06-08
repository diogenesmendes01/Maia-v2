import { describe, it, expect } from 'vitest';
import { db } from '@/db/client.js';
import { cognitive_module_log } from '@/db/schema.js';
import { cognitiveModuleLogRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { eq } from 'drizzle-orm';

// Padrão do projeto (tests/integration/leak.spec.ts): integration tests
// só rodam quando TEST_DB_URL está setada. No CI a validate job não tem
// Postgres — o integration job (com service container) cuida desse caso.
const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

d('cognitive_module_log smoke', () => {
  it('aceita insert de evento de reflection', async () => {
    await runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, async () => {
      await cognitiveModuleLogRepo.record({
        tenant_id: 'primary',
        agent_id: 'primary',
        conversa_id: null,
        turno_id: null,
        module_name: 'reflection.test',
        module_version: 'v1',
        prompt_version: null,
        triggered_by: 'async_event',
        started_at: new Date(),
        ended_at: new Date(),
        latency_ms: 100,
        model_used: 'claude-haiku-4-5',
        tokens_in: 50,
        tokens_out: 20,
        cost_estimate: null,
        output_summary_hash: 'abc123',
        confidence: '0.500',
        fallback_triggered: false,
        fallback_reason: null,
        status: 'success',
        metadata: { test: true },
      });
    });

    const rows = await db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, 'reflection.test'));
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // cleanup
    await db.delete(cognitive_module_log).where(eq(cognitive_module_log.module_name, 'reflection.test'));
  });
});
