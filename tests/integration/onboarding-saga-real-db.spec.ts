/**
 * Issue #519 — a saga de onboarding contra Postgres real (migrations 113/114).
 *
 * O que só um banco de verdade prova, e por isso vive aqui e não nos unitários:
 *
 *   1. CONCORRÊNCIA. O CAS por `version` e o `SELECT … FOR UPDATE` na row da
 *      run só se comportam como esperado com dois clientes de verdade
 *      disputando. Dois `claimStep` simultâneos: um reivindica, o outro vê a
 *      reivindicação — nunca os dois.
 *   2. IDEMPOTÊNCIA DURÁVEL. O UNIQUE `(run_id, step)` é o que impede o
 *      double-click de criar dois recursos mesmo quando o cliente perde a
 *      chave e gera outra.
 *   3. RETOMADA. Uma reivindicação `pending` abandonada expira por lease e
 *      pode ser tomada — sem isso, uma queda no meio de um passo travaria a
 *      run para sempre.
 *   4. O ÍNDICE PARCIAL de "uma run viva por (tenant, agente)" — pura
 *      semântica de Postgres.
 *   5. A CREDENCIAL DE BOOTSTRAP: consumo por CAS (duas requisições, no máximo
 *      um sucesso), lockout persistido e o singleton de credencial viva.
 *
 * Pulado sem TEST_DB_URL (mesmo gate dos demais specs de integração).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'i519-tenant';

let pool: pg.Pool;

async function wipe(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`DELETE FROM onboarding_step_results WHERE tenant_id = $1 OR tenant_id IS NULL`, [T]);
    await c.query(
      `DELETE FROM onboarding_events WHERE run_id IN (SELECT id FROM onboarding_runs WHERE actor_tenant_id = $1)`,
      [T],
    );
    await c.query(`UPDATE bootstrap_credentials SET consumed_by_run_id = NULL`);
    await c.query(`DELETE FROM onboarding_runs WHERE actor_tenant_id = $1`, [T]);
    await c.query(`DELETE FROM bootstrap_credentials`);
    await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [T]);
  } finally {
    c.release();
  }
}

d('issue #519 — saga de onboarding contra Postgres real', () => {
  let repo: typeof import('@/db/repositories/onboarding-repos.js');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome, status) VALUES ($1, 'i519', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [T],
      );
    } finally {
      c.release();
    }
    repo = await import('@/db/repositories/onboarding-repos.js');
  });

  afterAll(async () => {
    await wipe();
    await pool.end();
  });

  beforeEach(wipe);

  async function newRun() {
    const created = await repo.onboardingRepo.createRun({
      kind: 'tenant_onboarding',
      actor_tenant_id: T,
      tenant_id: T,
      created_by: 'operador',
      created_by_role: 'owner',
      configuration_contract_version: '1.0.0',
      schema_version: '1.0.0',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');
    return created.run;
  }

  it('a criação da run grava o primeiro evento e a trilha administrativa no MESMO commit', async () => {
    const run = await newRun();
    const events = await repo.onboardingRepo.listEvents(run.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('started');

    const c = await pool.connect();
    try {
      const audit = await c.query(
        `SELECT action FROM admin_audit_log WHERE tenant_id = $1 AND action = 'onboarding_run_started'`,
        [T],
      );
      expect(audit.rowCount).toBe(1);
    } finally {
      c.release();
    }
  });

  it('dois claims simultâneos do MESMO passo: exatamente um reivindica', async () => {
    const run = await newRun();
    const claim = (key: string) =>
      repo.onboardingRepo.claimStep({
        run_id: run.id,
        step: 'tenant',
        expected_version: run.version,
        idempotency_key_hash: repo.hashOpaque(key),
        request_hash: repo.hashPayload({ mode: 'attach', tenant_id: T }),
        actor_id: 'operador',
        actor_role: 'owner',
      });

    const [a, b] = await Promise.all([claim('chave-a'), claim('chave-b')]);
    const outcomes = [a, b].map((r) => (r.ok ? r.outcome : r.reason));
    // Um reivindica; o outro encontra a reivindicação viva e recusa correr
    // junto. O que NÃO pode acontecer é os dois reivindicarem.
    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'claim_in_progress')).toHaveLength(1);
  });

  it('mesma chave com payload divergente devolve conflito, não o resultado antigo', async () => {
    const run = await newRun();
    const key = repo.hashOpaque('chave-unica');
    const first = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version,
      idempotency_key_hash: key,
      request_hash: repo.hashPayload({ tenant_id: T }),
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(first.ok).toBe(true);

    const second = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version,
      idempotency_key_hash: key,
      request_hash: repo.hashPayload({ tenant_id: 'outro' }),
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('idempotency_payload_mismatch');
  });

  it('retry após conclusão devolve o resultado persistido (replay), sem refazer nada', async () => {
    const run = await newRun();
    const key = repo.hashOpaque('chave-retry');
    const payloadHash = repo.hashPayload({ tenant_id: T });
    const claim = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version,
      idempotency_key_hash: key,
      request_hash: payloadHash,
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(claim.ok && claim.outcome === 'claimed').toBe(true);

    const done = await repo.onboardingRepo.completeStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version,
      to_state: 'tenant_ready',
      next_step: 'admin',
      actor_id: 'operador',
      actor_role: 'owner',
      result: { tenant_id: T, created: false },
      tenant_id: T,
      audit: {
        action: 'onboarding_tenant_attached',
        resource_type: 'tenant',
        resource_id: T,
        change_summary: { target_tenant_id: T },
      },
    });
    expect(done.ok).toBe(true);

    const replay = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      // A run JÁ avançou — o replay tem de ser reconhecido mesmo assim, que é
      // exatamente o caso do cliente que não recebeu a resposta.
      expected_version: run.version,
      idempotency_key_hash: key,
      request_hash: payloadHash,
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.outcome).toBe('replay');
    if (replay.outcome !== 'replay') return;
    expect(replay.result).toMatchObject({ tenant_id: T });
  });

  it('reivindicação abandonada expira por lease e pode ser tomada', async () => {
    const run = await newRun();
    await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version,
      idempotency_key_hash: repo.hashOpaque('dono-que-morreu'),
      request_hash: repo.hashPayload({ tenant_id: T }),
      actor_id: 'operador',
      actor_role: 'owner',
    });

    // Empurra a reivindicação para o passado — o mesmo truque determinístico
    // que o spec da #518 usa para matar uma lease.
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE onboarding_step_results SET created_at = now() - interval '1 hour' WHERE run_id = $1`,
        [run.id],
      );
    } finally {
      c.release();
    }

    const taken = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version,
      idempotency_key_hash: repo.hashOpaque('novo-dono'),
      request_hash: repo.hashPayload({ tenant_id: T }),
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.outcome).toBe('resumed');
  });

  it('CAS por versão: dois operadores não avançam a mesma versão', async () => {
    const run = await newRun();
    const stale = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version + 1, // leu uma versão que não é a corrente
      idempotency_key_hash: repo.hashOpaque('k'),
      request_hash: repo.hashPayload({}),
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe('version_conflict');
  });

  it('salto de etapa é recusado E deixa evento de negação', async () => {
    const run = await newRun();
    const jump = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'activation',
      expected_version: run.version,
      idempotency_key_hash: repo.hashOpaque('k'),
      request_hash: repo.hashPayload({}),
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(jump.ok).toBe(false);

    const events = await repo.onboardingRepo.listEvents(run.id);
    expect(events.some((e) => e.event_type === 'denied' && e.step === 'activation')).toBe(true);
  });

  it('run vencida recusa comandos e o sweep a torna terminal sem apagar nada', async () => {
    const run = await newRun();
    const c = await pool.connect();
    try {
      await c.query(`UPDATE onboarding_runs SET expires_at = now() - interval '1 day' WHERE id = $1`, [
        run.id,
      ]);
    } finally {
      c.release();
    }

    const blocked = await repo.onboardingRepo.claimStep({
      run_id: run.id,
      step: 'tenant',
      expected_version: run.version,
      idempotency_key_hash: repo.hashOpaque('k'),
      request_hash: repo.hashPayload({}),
      actor_id: 'operador',
      actor_role: 'owner',
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('run_expired');

    const expired = await repo.onboardingRepo.expireStaleRuns();
    expect(expired.map((r) => r.id)).toContain(run.id);
    const after = await repo.onboardingRepo.getById(run.id);
    expect(after?.state).toBe('failed_terminal');
    // Diagnosticável: os eventos continuam lá.
    expect((await repo.onboardingRepo.listEvents(run.id)).length).toBeGreaterThan(0);
  });

  describe('credencial de bootstrap', () => {
    it('só existe UMA credencial viva por vez', async () => {
      const first = await repo.bootstrapCredentialsRepo.issue({
        secret_hash: repo.hashOpaque('segredo-1'),
        created_by: 'cli',
        expires_at: new Date(Date.now() + 3600_000),
      });
      expect(first.ok).toBe(true);

      const second = await repo.bootstrapCredentialsRepo.issue({
        secret_hash: repo.hashOpaque('segredo-2'),
        created_by: 'cli',
        expires_at: new Date(Date.now() + 3600_000),
      });
      expect(second.ok).toBe(false);
    });

    it('duas requisições concorrentes com o segredo certo consomem no máximo UMA vez', async () => {
      await repo.bootstrapCredentialsRepo.issue({
        secret_hash: repo.hashOpaque('segredo-corrida'),
        created_by: 'cli',
        expires_at: new Date(Date.now() + 3600_000),
      });
      const runA = await newRun();
      const runB = await newRun().catch(() => null);

      const results = await Promise.all([
        repo.bootstrapCredentialsRepo.consume({
          secret_hash: repo.hashOpaque('segredo-corrida'),
          run_id: runA.id,
        }),
        repo.bootstrapCredentialsRepo.consume({
          secret_hash: repo.hashOpaque('segredo-corrida'),
          run_id: (runB ?? runA).id,
        }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it('tentativas erradas incrementam o contador e trancam — o hash não vira oráculo', async () => {
      await repo.bootstrapCredentialsRepo.issue({
        secret_hash: repo.hashOpaque('segredo-certo'),
        created_by: 'cli',
        expires_at: new Date(Date.now() + 3600_000),
      });
      const run = await newRun();
      for (let i = 0; i < 5; i++) {
        const r = await repo.bootstrapCredentialsRepo.consume({
          secret_hash: repo.hashOpaque(`palpite-${i}`),
          run_id: run.id,
        });
        expect(r.ok).toBe(false);
      }
      // Trancada: nem o segredo CERTO passa enquanto o lockout durar.
      const locked = await repo.bootstrapCredentialsRepo.consume({
        secret_hash: repo.hashOpaque('segredo-certo'),
        run_id: run.id,
      });
      expect(locked.ok).toBe(false);
      if (locked.ok) return;
      expect(locked.reason).toBe('locked');
    });

    it('credencial expirada não é consumida', async () => {
      await repo.bootstrapCredentialsRepo.issue({
        secret_hash: repo.hashOpaque('segredo-vencido'),
        created_by: 'cli',
        expires_at: new Date(Date.now() - 1000),
      });
      const run = await newRun();
      const r = await repo.bootstrapCredentialsRepo.consume({
        secret_hash: repo.hashOpaque('segredo-vencido'),
        run_id: run.id,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('expired');
    });

    it('o SEGREDO EM CLARO nunca chega ao banco', async () => {
      const secret = randomUUID() + randomUUID();
      await repo.bootstrapCredentialsRepo.issue({
        secret_hash: repo.hashOpaque(secret),
        label: 'deploy inicial',
        created_by: 'cli',
        expires_at: new Date(Date.now() + 3600_000),
      });
      const c = await pool.connect();
      try {
        const rows = await c.query<{ secret_hash: string; label: string | null }>(
          `SELECT secret_hash, label FROM bootstrap_credentials`,
        );
        for (const row of rows.rows) {
          expect(row.secret_hash).not.toContain(secret);
          expect(row.label ?? '').not.toContain(secret);
        }
      } finally {
        c.release();
      }
    });
  });
});
