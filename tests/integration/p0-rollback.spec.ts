import { describe, it, expect } from 'vitest';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';

// Padrão do projeto (tests/integration/leak.spec.ts): integration tests
// só rodam quando TEST_DB_URL está setada. No CI a validate job não tem
// Postgres — o integration job (com service container) cuida desse caso.
const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

d('P0 rollback NOT NULL', () => {
  it('reverter NOT NULL volta pra nullable sem perda de dados', async () => {
    // Snapshot count antes do rollback
    const beforeCountResult = await db.execute(sql`SELECT count(*) as cnt FROM transacoes`);
    const beforeCount = (beforeCountResult.rows[0] as Record<string, unknown>).cnt as number;

    // Rollback: remove NOT NULL constraint
    await db.execute(sql`ALTER TABLE transacoes ALTER COLUMN tenant_id DROP NOT NULL`);

    // Verifica que coluna agora aceita NULL
    const result = await db.execute<{ is_nullable: string }>(
      sql`SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'transacoes' AND column_name = 'tenant_id'`
    );
    expect((result.rows[0] as Record<string, unknown>)?.is_nullable).toBe('YES');

    // Dados preservados: count permanece igual
    const afterCountResult = await db.execute(sql`SELECT count(*) as cnt FROM transacoes`);
    const afterCount = (afterCountResult.rows[0] as Record<string, unknown>).cnt as number;
    expect(afterCount).toBe(beforeCount);

    // Reapply constraint (cleanup pra outros testes)
    await db.execute(sql`ALTER TABLE transacoes ALTER COLUMN tenant_id SET NOT NULL`);
  });
});
