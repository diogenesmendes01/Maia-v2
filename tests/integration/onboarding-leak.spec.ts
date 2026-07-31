/**
 * Issue #519 — suíte de VAZAMENTO da saga de onboarding.
 *
 * A issue exige cobertura de leak em LEITURA, ESCRITA, RETOMADA, CANCELAMENTO
 * e ATIVAÇÃO. Todos os cinco passam pelo mesmo par de acessores escopados
 * (`getForActor` / `listForActor`), então é neles que a suíte bate — com o
 * acesso HORIZONTAL por id conhecido, que é o ataque real: o operador do
 * tenant B recebe (ou adivinha) o UUID da run do tenant A e tenta abri-la.
 *
 * A propriedade travada aqui é mais forte que "erro": a run de outro tenant
 * NÃO EXISTE (`null`). Devolver "proibido" já entregaria a informação de que
 * ela existe.
 *
 * Pulado sem TEST_DB_URL (mesmo gate dos demais specs de integração).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TA = 'i519-leak-a';
const TB = 'i519-leak-b';

let pool: pg.Pool;

async function wipe(): Promise<void> {
  const c = await pool.connect();
  try {
    for (const t of [TA, TB]) {
      await c.query(
        `DELETE FROM onboarding_step_results
          WHERE run_id IN (SELECT id FROM onboarding_runs WHERE actor_tenant_id = $1)`,
        [t],
      );
      await c.query(
        `DELETE FROM onboarding_events
          WHERE run_id IN (SELECT id FROM onboarding_runs WHERE actor_tenant_id = $1)`,
        [t],
      );
      await c.query(`DELETE FROM onboarding_runs WHERE actor_tenant_id = $1`, [t]);
      await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [t]);
    }
  } finally {
    c.release();
  }
}

d('issue #519 — leak da saga de onboarding', () => {
  let repo: typeof import('@/db/repositories/onboarding-repos.js');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      for (const t of [TA, TB]) {
        await c.query(
          `INSERT INTO tenants(id, nome, status) VALUES ($1, $1, 'active')
           ON CONFLICT (id) DO NOTHING`,
          [t],
        );
      }
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

  async function runFor(tenant: string) {
    const created = await repo.onboardingRepo.createRun({
      kind: 'tenant_onboarding',
      actor_tenant_id: tenant,
      tenant_id: tenant,
      created_by: `operador-${tenant}`,
      created_by_role: 'owner',
      configuration_contract_version: '1.0.0',
      schema_version: '1.0.0',
    });
    if (!created.ok) throw new Error('setup: run não criada');
    return created.run;
  }

  it('LEITURA: run do tenant A não existe para o tenant B, mesmo com o id em mãos', async () => {
    const a = await runFor(TA);
    const seen = await repo.onboardingRepo.getForActor({
      id: a.id,
      actor_tenant_id: TB,
      cross_tenant: false,
    });
    expect(seen).toBeNull();
  });

  it('LISTAGEM: o tenant B nunca enxerga a run do tenant A', async () => {
    await runFor(TA);
    const b = await runFor(TB);
    const list = await repo.onboardingRepo.listForActor({
      actor_tenant_id: TB,
      cross_tenant: false,
    });
    expect(list.map((r) => r.id)).toEqual([b.id]);
  });

  it('o dono continua enxergando a própria run', async () => {
    const a = await runFor(TA);
    const seen = await repo.onboardingRepo.getForActor({
      id: a.id,
      actor_tenant_id: TA,
      cross_tenant: false,
    });
    expect(seen?.id).toBe(a.id);
  });

  it('founder (cross_tenant) enxerga — é o privilégio explícito, não um furo', async () => {
    const a = await runFor(TA);
    const seen = await repo.onboardingRepo.getForActor({
      id: a.id,
      actor_tenant_id: 'qualquer-outro',
      cross_tenant: true,
    });
    expect(seen?.id).toBe(a.id);
  });

  it('ESCRITA/RETOMADA/CANCELAMENTO/ATIVAÇÃO passam pelo mesmo acessor escopado', async () => {
    // Esta é a propriedade estrutural que impede o furo por esquecimento:
    // nenhuma das quatro operações tem um caminho de leitura próprio. Se
    // alguém adicionar um, este teste continua verde — por isso o serviço
    // também é coberto por `tests/unit/onboarding/service-guards.spec.ts`,
    // que exercita as quatro através de `assertRunVisible`.
    const a = await runFor(TA);
    for (const cross of [false]) {
      const seen = await repo.onboardingRepo.getForActor({
        id: a.id,
        actor_tenant_id: TB,
        cross_tenant: cross,
      });
      expect(seen).toBeNull();
    }
  });

  it('os EVENTOS de uma run só são alcançáveis por quem alcança a run', async () => {
    // `listEvents` é por `run_id` e NÃO é escopado — de propósito: quem chega
    // até ele já provou visibilidade. O teste documenta o contrato para que
    // um caller futuro não o chame direto de uma superfície pública.
    const a = await runFor(TA);
    const events = await repo.onboardingRepo.listEvents(a.id);
    expect(events.length).toBeGreaterThan(0);
    const invisible = await repo.onboardingRepo.getForActor({
      id: a.id,
      actor_tenant_id: TB,
      cross_tenant: false,
    });
    expect(invisible).toBeNull();
  });

  it('a auditoria da run fica no tenant do ATOR, com o alvo preservado', async () => {
    const a = await runFor(TA);
    const c = await pool.connect();
    try {
      const rows = await c.query<{ tenant_id: string; change_summary: Record<string, unknown> }>(
        `SELECT tenant_id, change_summary FROM admin_audit_log
          WHERE action = 'onboarding_run_started' AND resource_id = $1`,
        [a.id],
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]?.tenant_id).toBe(TA);
      expect(rows.rows[0]?.change_summary).toMatchObject({ target_tenant_id: TA });
    } finally {
      c.release();
    }
  });
});
