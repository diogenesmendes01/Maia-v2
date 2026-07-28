/**
 * Issue #520 (migrations 101 + 102) — evidência de backup e ciclo de vida de
 * dados contra Postgres DE VERDADE.
 *
 * Prova o que só o banco pode provar:
 *  1. single-flight persistido: duas runs não-terminais são impossíveis;
 *  2. uma run terminal sem outcome/reason/finished_at é recusada;
 *  3. modo de criptografia sem key_id é recusado;
 *  4. backup_runs recusa qualquer tenant que não seja o sentinela `system`;
 *  5. as tabelas de ciclo de vida recusam o literal legado 'default';
 *  6. um passe de retenção em dry-run NÃO consegue registrar deleção;
 *  7. privacy request não avança sem verificação de identidade;
 *  8. export de privacidade sem expiração é recusado;
 *  9. tombstone sem alvo é recusado;
 * 10. a query de reconciliação (effective_at > watermark) é tenant-scoped e
 *     não vaza tombstone de outro tenant.
 *
 * Skipped sem TEST_DB_URL (a lane unit-only passa sem Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

// Ids NAMESPACED (ops520-*): tenants.id/agents.id são PK GLOBAIS — um id
// genérico colidiria com seeds de outras suítes.
const T_A = 'ops520-tenant-a';
const A_A = 'ops520-agent-a';
const T_B = 'ops520-tenant-b';
const A_B = 'ops520-agent-b';

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

async function insertRun(over: Record<string, unknown> = {}): Promise<string> {
  const row = {
    correlation_id: randomUUID(),
    state: 'running',
    profile: 'production',
    ...over,
  } as Record<string, unknown>;
  const cols = Object.keys(row);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO backup_runs (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    cols.map((c) => row[c]),
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  await ensureTenantAgent(T_A, A_A);
  await ensureTenantAgent(T_B, A_B);
});

afterAll(async () => {
  if (!SHOULD_RUN) return;
  await pool.query('DELETE FROM data_tombstones WHERE tenant_id IN ($1, $2)', [T_A, T_B]);
  await pool.query('DELETE FROM retention_runs WHERE tenant_id IN ($1, $2)', [T_A, T_B]);
  await pool.query('DELETE FROM privacy_requests WHERE tenant_id IN ($1, $2)', [T_A, T_B]);
  await pool.query('DELETE FROM legal_holds WHERE tenant_id IN ($1, $2)', [T_A, T_B]);
  await pool.query('DELETE FROM backup_manifests');
  await pool.query('DELETE FROM restore_drills');
  await pool.query('DELETE FROM backup_runs');
  await pool.end();
});

d('101 — backup_runs enforces the lifecycle contract', () => {
  it('allows at most ONE non-terminal run (persisted single-flight)', async () => {
    await pool.query('DELETE FROM backup_runs');
    await insertRun({ state: 'running' });
    await expect(insertRun({ state: 'scheduled' })).rejects.toThrow(/backup_runs_single_active_uq/);
  });

  it('lets a new run start once the previous one reached a terminal state', async () => {
    await pool.query('DELETE FROM backup_runs');
    const first = await insertRun({ state: 'running' });
    await pool.query(
      `UPDATE backup_runs
         SET state = 'completed_degraded', outcome = 'completed_degraded',
             outcome_reason = 'offsite_not_configured', finished_at = now()
       WHERE id = $1`,
      [first],
    );
    await expect(insertRun({ state: 'scheduled' })).resolves.toBeTruthy();
  });

  it('refuses a terminal state without outcome / reason / finished_at', async () => {
    await pool.query('DELETE FROM backup_runs');
    await expect(insertRun({ state: 'completed' })).rejects.toThrow(
      /backup_runs_terminal_shape_chk/,
    );
  });

  it('refuses a declared encryption mode with no key identifier', async () => {
    await pool.query('DELETE FROM backup_runs');
    await expect(insertRun({ encryption_mode: 'envelope_aes256_gcm' })).rejects.toThrow(
      /backup_runs_encryption_key_chk/,
    );
  });

  it('refuses any tenant other than the reserved `system` sentinel', async () => {
    await pool.query('DELETE FROM backup_runs');
    await expect(insertRun({ tenant_id: T_A, agent_id: A_A })).rejects.toThrow(
      /backup_runs_system_scope_chk/,
    );
    await expect(insertRun({ tenant_id: 'default', agent_id: 'default' })).rejects.toThrow(
      /backup_runs_system_scope_chk/,
    );
  });

  it('binds a manifest 1:1 to its run', async () => {
    await pool.query('DELETE FROM backup_manifests');
    await pool.query('DELETE FROM backup_runs');
    const run = await insertRun({ state: 'running' });
    const insertManifest = () =>
      pool.query(
        `INSERT INTO backup_manifests
           (backup_run_id, manifest_version, manifest, manifest_sha256, signature, signature_key_version)
         VALUES ($1, 1, '{}'::jsonb, $2, $3, 1)`,
        [run, 'a'.repeat(64), 'b'.repeat(64)],
      );
    await expect(insertManifest()).resolves.toBeTruthy();
    await expect(insertManifest()).rejects.toThrow(/backup_manifests_backup_run_id_key|unique/i);
  });
});

d('102 — data lifecycle is tenant-scoped and fail-closed', () => {
  it('refuses the legacy `default` literal on every lifecycle table', async () => {
    await expect(
      pool.query(
        `INSERT INTO legal_holds (tenant_id, agent_id, case_reference, data_class, reason_code, created_by)
         VALUES ('default', 'default', 'case-1', 'messages', 'litigation', 'ops')`,
      ),
    ).rejects.toThrow(/legal_holds_scope_chk/);

    await expect(
      pool.query(
        `INSERT INTO data_tombstones (tenant_id, agent_id, data_class, subject_ref, action, hmac)
         VALUES ('default', 'default', 'messages', 'subj', 'delete', 'h')`,
      ),
    ).rejects.toThrow(/data_tombstones_scope_chk/);
  });

  it('makes a dry-run retention pass structurally incapable of recording a deletion', async () => {
    await expect(
      pool.query(
        `INSERT INTO retention_runs (tenant_id, agent_id, correlation_id, data_class, dry_run, policy_version, deleted)
         VALUES ($1, $2, $3, 'messages', true, 'v0-pending-dpo', 5)`,
        [T_A, A_A, randomUUID()],
      ),
    ).rejects.toThrow(/retention_runs_dry_run_chk/);

    await expect(
      pool.query(
        `INSERT INTO retention_runs (tenant_id, agent_id, correlation_id, data_class, dry_run, policy_version, deleted)
         VALUES ($1, $2, $3, 'messages', false, 'v0-pending-dpo', 5)`,
        [T_A, A_A, randomUUID()],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses to advance a privacy request without verified identity', async () => {
    await expect(
      pool.query(
        `INSERT INTO privacy_requests (tenant_id, agent_id, type, subject_ref, status)
         VALUES ($1, $2, 'deletion', $3, 'approved')`,
        [T_A, A_A, randomUUID()],
      ),
    ).rejects.toThrow(/privacy_requests_identity_chk/);
  });

  it('refuses a privacy export with no expiry', async () => {
    await expect(
      pool.query(
        `INSERT INTO privacy_requests (tenant_id, agent_id, type, subject_ref, status, export_locator)
         VALUES ($1, $2, 'access_export', $3, 'received', 'opaque-locator')`,
        [T_A, A_A, randomUUID()],
      ),
    ).rejects.toThrow(/privacy_requests_export_expiry_chk/);
  });

  it('refuses a tombstone with no target', async () => {
    await expect(
      pool.query(
        `INSERT INTO data_tombstones (tenant_id, agent_id, data_class, action, hmac)
         VALUES ($1, $2, 'messages', 'delete', 'h')`,
        [T_A, A_A],
      ),
    ).rejects.toThrow(/data_tombstones_target_chk/);
  });

  it('allows only one OPEN destructive request per subject and type', async () => {
    const subject = randomUUID();
    const insert = () =>
      pool.query(
        `INSERT INTO privacy_requests (tenant_id, agent_id, type, subject_ref, status)
         VALUES ($1, $2, 'deletion', $3, 'received')`,
        [T_A, A_A, subject],
      );
    await expect(insert()).resolves.toBeTruthy();
    await expect(insert()).rejects.toThrow(/privacy_requests_open_subject_uq|unique/i);
  });

  it('never returns another tenant\'s tombstones from the reconciliation query', async () => {
    const watermark = new Date(Date.now() - 60_000);
    for (const [t, a] of [
      [T_A, A_A],
      [T_B, A_B],
    ]) {
      await pool.query(
        `INSERT INTO data_tombstones (tenant_id, agent_id, data_class, subject_ref, action, hmac, effective_at)
         VALUES ($1, $2, 'messages', $3, 'delete', 'h', now())`,
        [t, a, randomUUID()],
      );
    }
    const res = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM data_tombstones
        WHERE tenant_id = $1 AND agent_id = $2 AND effective_at > $3`,
      [T_A, A_A, watermark],
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.every((r) => r.tenant_id === T_A)).toBe(true);
  });
});
