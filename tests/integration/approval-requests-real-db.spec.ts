/**
 * Fase 0 cap. 2 (migration 095) — store de evidência de aprovação em DB REAL.
 *
 * Prova, contra Postgres de verdade:
 *  1. partial unique: no máximo UM request aberto por fingerprint;
 *  2. decisões únicas por (request, principal) — duplicate approve não conta;
 *  3. CAS: claims concorrentes têm EXATAMENTE um vencedor;
 *  4. consume é one-time (segundo consume falha);
 *  5. cross-tenant: request de outro tenant é invisível (not found);
 *  6. expiração via relógio do banco.
 *
 * Skipped sem TEST_DB_URL (lane unit-only passa sem Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;
const createdIds: string[] = [];

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [agent, tenant],
  );
}

function baseRequest(fingerprint: string) {
  return {
    requester_pessoa_id: randomUUID(),
    entidade_id: null,
    conversa_id: null,
    mensagem_id: null,
    request_id: null,
    tool: 'register_transaction',
    operation_type: 'create',
    intent_payload: { valor: 25000 },
    intent_hash: fingerprint,
    intent_hash_version: 1,
    approval_class: 'two_distinct_owners' as const,
    required_approvals: 2,
    fingerprint,
    expires_at: new Date(Date.now() + 3600_000),
  };
}

d('approval store — DB real (migration 095)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent('primary', 'primary');
    await ensureTenantAgent('tenant-b', 'agent-b');
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await pool.query(`DELETE FROM approval_decisions WHERE request_id = ANY($1::uuid[])`, [
        createdIds,
      ]);
      await pool.query(`DELETE FROM approval_requests WHERE id = ANY($1::uuid[])`, [createdIds]);
    }
    await pool.end();
  });

  const inPrimary = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, fn);

  it('(1) no máximo um request aberto por fingerprint', async () => {
    const { approvalRequestsRepo } = await loadRepos();
    const fp = `v1:${randomUUID()}`;
    const first = await inPrimary(() => approvalRequestsRepo.create(baseRequest(fp)));
    expect(first).not.toBeNull();
    createdIds.push(first!.id);
    const second = await inPrimary(() => approvalRequestsRepo.create(baseRequest(fp)));
    expect(second).toBeNull();
  });

  it('(2) mesma pessoa não conta duas vezes; (3) claim tem um vencedor; (4) consume one-time', async () => {
    const { approvalRequestsRepo, approvalDecisionsRepo } = await loadRepos();
    const fp = `v1:${randomUUID()}`;
    const request = await inPrimary(() => approvalRequestsRepo.create(baseRequest(fp)));
    expect(request).not.toBeNull();
    createdIds.push(request!.id);

    const principal = randomUUID();
    const d1 = await inPrimary(() =>
      approvalDecisionsRepo.record({
        request_id: request!.id,
        principal_pessoa_id: principal,
        principal_tipo: 'dono',
        decision: 'approve',
        channel: 'whatsapp',
        reason: null,
      }),
    );
    expect(d1).not.toBeNull();
    // Duplicate (mesmo principal, outro canal) → unique bloqueia.
    const dup = await inPrimary(() =>
      approvalDecisionsRepo.record({
        request_id: request!.id,
        principal_pessoa_id: principal,
        principal_tipo: 'dono',
        decision: 'approve',
        channel: 'admin',
        reason: null,
      }),
    );
    expect(dup).toBeNull();

    const approved = await inPrimary(() => approvalRequestsRepo.markApproved(request!.id));
    expect(approved?.status).toBe('approved');

    // (3) 5 claims concorrentes — exatamente um vence.
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        inPrimary(() =>
          approvalRequestsRepo.claim({
            id: request!.id,
            claim_token: `token-${i}`,
            intent_hash: fp,
          }),
        ),
      ),
    );
    const winners = claims.filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    const winnerToken = winners[0]!.claim_token!;

    // (4) consume com token errado falha; com o certo, uma única vez.
    const wrong = await inPrimary(() =>
      approvalRequestsRepo.consume({ id: request!.id, claim_token: 'token-errado', result_ref: null }),
    );
    expect(wrong).toBeNull();
    const consumed = await inPrimary(() =>
      approvalRequestsRepo.consume({ id: request!.id, claim_token: winnerToken, result_ref: 'tx-1' }),
    );
    expect(consumed?.status).toBe('consumed');
    const replay = await inPrimary(() =>
      approvalRequestsRepo.consume({ id: request!.id, claim_token: winnerToken, result_ref: 'tx-2' }),
    );
    expect(replay).toBeNull();
  });

  it('(5) cross-tenant: request de outro tenant é invisível', async () => {
    const { approvalRequestsRepo } = await loadRepos();
    const fp = `v1:${randomUUID()}`;
    const request = await inPrimary(() => approvalRequestsRepo.create(baseRequest(fp)));
    createdIds.push(request!.id);

    const fromOtherTenant = await runWithTenantContext(
      { tenant_id: 'tenant-b', agent_id: 'agent-b' },
      async () => {
        const byId = await approvalRequestsRepo.byId(request!.id);
        const byFp = await approvalRequestsRepo.findOpenByFingerprint(fp);
        const byRef = await approvalRequestsRepo.findOpenByRefPrefix(request!.id.slice(0, 8));
        return { byId, byFp, byRef };
      },
    );
    expect(fromOtherTenant.byId).toBeNull();
    expect(fromOtherTenant.byFp).toBeNull();
    expect(fromOtherTenant.byRef).toBeNull();
  });

  it('(6) expiração usa o relógio do banco e é terminal', async () => {
    const { approvalRequestsRepo } = await loadRepos();
    const fp = `v1:${randomUUID()}`;
    const request = await inPrimary(() =>
      approvalRequestsRepo.create({ ...baseRequest(fp), expires_at: new Date(Date.now() - 1000) }),
    );
    createdIds.push(request!.id);

    const expired = await inPrimary(() => approvalRequestsRepo.expireDue());
    expect(expired.some((r) => r.id === request!.id)).toBe(true);

    // Expirado não aprova nem claima.
    const approved = await inPrimary(() => approvalRequestsRepo.markApproved(request!.id));
    expect(approved).toBeNull();
    const claimed = await inPrimary(() =>
      approvalRequestsRepo.claim({ id: request!.id, claim_token: 't', intent_hash: fp }),
    );
    expect(claimed).toBeNull();
  });
});
