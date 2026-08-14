/**
 * Issue #519 (GATE 5) — o worker `onboarding_expirer` contra Postgres real.
 *
 * A spec unitária (`tests/unit/workers/onboarding-expirer.spec.ts`) prova o
 * CALL SITE: que a entrada existe no registry e que ela chama `expireStale`
 * com um teto de lote. O que só um banco de verdade prova:
 *
 *   - uma run VENCIDA vira `cancelled` com `last_error_code='expired'` e deixa
 *     o evento append-only `run_expired` — nunca é apagada (critério de aceite
 *     da issue: uma run abandonada continua diagnosticável);
 *   - uma run NÃO vencida sobrevive intacta (mesma `version`, mesmo estado);
 *   - uma run já terminal não é re-expirada (o `notInArray(TERMINAL_STATES)` +
 *     a re-validação sob `FOR UPDATE`);
 *   - o LIMITE DE LOTE corta o tick: com 3 runs vencidas e limite 2, o tick
 *     expira 2 — não varre até esvaziar.
 *
 * Tudo é disparado pela `fn` REGISTRADA em `JOBS` (não por um chamado direto
 * ao repositório): apagar a entrada do registry deixa este arquivo vermelho.
 *
 * Runs com `tenant_id IS NULL` são de propósito: é o caso da run criada ANTES
 * de o tenant existir — exatamente a que um dispatcher per-tenant deixaria
 * viva para sempre. Por isso o worker é uma varredura global sob `system`.
 *
 * Depois da revisão de #555 este arquivo também prova, contra banco real, as
 * duas peças que a issue acrescentou:
 *
 *   - a série `maia_onboarding_run_cancelled_total{reason="expired"}` sai
 *     ATRIBUÍDA ao `tenant_id + agent_id` de cada run varrida (e a run sem
 *     tenant cai no bucket `system`, contada e não descartada);
 *   - `onboardingRunsRepo.snapshotExpiryBacklog()` — a fonte da série de
 *     backlog lida no scrape — enxerga a fila que sobra quando ela é maior que
 *     o lote, e a vê encolher tick a tick.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { JOBS } from '@/workers/index.js';
import { renderPrometheus } from '@/lib/metrics.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/**
 * A varredura é GLOBAL por desenho — duas cópias desta spec (vitest roda
 * arquivos em paralelo, e o repositório tem dezenas de worktrees contra o mesmo
 * banco) disputariam as mesmas runs vencidas. Mesmo remédio, e mesmo motivo, de
 * `helpers/pairing-queue-lock.ts`: um advisory lock de SESSÃO numa conexão
 * dedicada dá posse exclusiva da varredura enquanto esta spec roda.
 */
const LOCK_KEY = "hashtextextended('maia_onboarding_expiry_sweep', '51905190')";

/** Chamada exatamente como o scheduler a faz. */
function tick(): Promise<void> {
  const job = JOBS.find((j) => j.name === 'onboarding_expirer');
  if (!job) throw new Error('onboarding_expirer não está registrado em JOBS');
  return job.fn();
}

/**
 * Mesma `fn` do registry, com o teto de lote sobrescrito. O tipo do registry é
 * `() => Promise<void>` (o scheduler nunca passa argumento); o parâmetro
 * opcional existe para que este teste exercite o CAMINHO DE PRODUÇÃO com um
 * lote pequeno, em vez de inserir 101 runs para ver o corte.
 */
function tickWithLimit(limit: number): Promise<void> {
  const job = JOBS.find((j) => j.name === 'onboarding_expirer');
  if (!job) throw new Error('onboarding_expirer não está registrado em JOBS');
  return (job.fn as (opts?: { limit?: number }) => Promise<void>)({ limit });
}

let pool: pg.Pool;
let lockClient: pg.PoolClient | null = null;
const createdRuns: string[] = [];
/** Tenants criados só para provar a atribuição da auditoria. */
const seededTenants: string[] = [];

type SeedRun = {
  tenant_id?: string | null;
  /** `null` é o caso REAL da run que vence antes de o agente existir. */
  agent_id?: string | null;
  state?: string;
  /** Deslocamento de `expires_at` em ms a partir de agora (negativo = vencida). */
  expires_in_ms: number;
};

async function seedRun(run: SeedRun): Promise<string> {
  const id = randomUUID();
  const tenant_id = run.tenant_id ?? null;
  const agent_id = run.agent_id ?? null;
  await pool.query(
    `INSERT INTO onboarding_runs
       (id, kind, tenant_id, agent_id, state, created_by, expires_at,
        configuration_contract_version, schema_version)
     VALUES ($1, $2, $3, $4, $5, 'expirer-spec', now() + ($6 || ' milliseconds')::interval, '1', '1')`,
    [
      id,
      tenant_id === null ? 'global_bootstrap' : 'tenant_onboarding',
      tenant_id,
      agent_id,
      run.state ?? 'created',
      String(run.expires_in_ms),
    ],
  );
  createdRuns.push(id);
  return id;
}

async function readRun(id: string): Promise<{
  state: string;
  version: number;
  last_error_code: string | null;
  cancelled_at: Date | null;
}> {
  const { rows } = await pool.query(
    'SELECT state, version, last_error_code, cancelled_at FROM onboarding_runs WHERE id=$1',
    [id],
  );
  return rows[0];
}

/**
 * Trilha administrativa da run. `admin_audit_log` é onde a saga inteira audita
 * (o evento append-only NÃO substitui auditoria — ver o cabeçalho de
 * `src/db/repositories/onboarding-repos.ts`).
 */
async function auditRows(run_id: string): Promise<
  Array<{
    tenant_id: string;
    actor_id: string;
    actor_role: string;
    action: string;
    resource_type: string;
    change_summary: Record<string, unknown>;
  }>
> {
  const { rows } = await pool.query(
    `SELECT tenant_id, actor_id, actor_role, action, resource_type, change_summary
       FROM admin_audit_log
      WHERE resource_type='onboarding_run' AND resource_id=$1
      ORDER BY id`,
    [run_id],
  );
  return rows;
}

async function eventTypes(run_id: string): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT event_type FROM onboarding_events WHERE run_id=$1 ORDER BY created_at',
    [run_id],
  );
  return rows.map((r: { event_type: string }) => r.event_type);
}

/**
 * SOMA de todas as séries de cancelamento por vencimento, qualquer que seja o
 * escopo. O worker emite UMA série por `tenant_id + agent_id` varrido — a MESMA
 * série que o cancelamento pelo console usa —, então "quantas foram expiradas
 * neste tick" é a soma, não uma linha.
 */
async function expiredCounter(): Promise<number> {
  const out = await renderPrometheus();
  return out
    .split('\n')
    .filter(
      (l) =>
        l.startsWith('maia_onboarding_run_cancelled_total{') && l.includes('reason="expired"'),
    )
    .reduce((acc, l) => acc + Number(l.slice(l.lastIndexOf('} ') + 2)), 0);
}

/** Valor da série de cancelamento por vencimento para UM escopo. */
async function expiredCounterFor(tenant_id: string, agent_id: string): Promise<number> {
  const out = await renderPrometheus();
  const prefix =
    `maia_onboarding_run_cancelled_total{agent_id="${agent_id}",` +
    `reason="expired",tenant_id="${tenant_id}"} `;
  const line = out.split('\n').find((l) => l.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  lockClient = await pool.connect();
  await lockClient.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
}, 120_000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  for (const id of createdRuns) {
    await pool.query('DELETE FROM onboarding_events WHERE run_id=$1', [id]);
    await pool.query(
      "DELETE FROM admin_audit_log WHERE resource_type='onboarding_run' AND resource_id=$1",
      [id],
    );
    await pool.query('DELETE FROM onboarding_runs WHERE id=$1', [id]);
  }
  for (const t of seededTenants) {
    await pool.query('DELETE FROM tenants WHERE id=$1', [t]).catch(() => undefined);
  }
  if (lockClient) {
    await lockClient.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
    lockClient.release();
    lockClient = null;
  }
  await pool.end().catch(() => undefined);
});

d('worker onboarding_expirer contra Postgres real (issue #519)', () => {
  beforeEach(async () => {
    // Cada caso parte de um banco sem candidatas de casos anteriores.
    for (const id of createdRuns) {
      await pool.query('DELETE FROM onboarding_events WHERE run_id=$1', [id]);
      await pool.query(
        "DELETE FROM admin_audit_log WHERE resource_type='onboarding_run' AND resource_id=$1",
        [id],
      );
      await pool.query('DELETE FROM onboarding_runs WHERE id=$1', [id]);
    }
    createdRuns.length = 0;
  });

  it('expira a run vencida: cancelled + last_error_code=expired + evento run_expired', async () => {
    // `tenant_id IS NULL`: a run órfã, criada antes do tenant existir.
    const stale = await seedRun({ expires_in_ms: -60_000 });

    await tick();

    const after = await readRun(stale);
    expect(after.state).toBe('cancelled');
    expect(after.last_error_code).toBe('expired');
    expect(after.cancelled_at).not.toBeNull();
    expect(after.version).toBe(2);
    // Nunca apagada — a trilha append-only continua diagnosticável.
    expect(await eventTypes(stale)).toContain('run_expired');
  });

  it('grava EVENTO e AUDITORIA na expiração (invariante MUST nº 4)', async () => {
    // A run tem tenant real: a auditoria vai para o tenant dela.
    await pool.query(
      `INSERT INTO tenants (id, nome, status) VALUES ('expirer-audit', 'Expirer Audit', 'active')
       ON CONFLICT (id) DO NOTHING`,
    );
    seededTenants.push('expirer-audit');
    const stale = await seedRun({ tenant_id: 'expirer-audit', expires_in_ms: -60_000 });

    await tick();

    // O evento append-only continua lá…
    expect(await eventTypes(stale)).toEqual(['run_expired']);
    // …e NÃO substitui a trilha de governança.
    const audit = await auditRows(stale);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe('system');
    expect(audit[0].actor_role).toBe('system');
    // MESMA ação do cancelamento operado pelo console: quem consulta "runs
    // canceladas" faz UMA consulta; o `reason_code` separa os dois casos.
    expect(audit[0].action).toBe('onboarding_run_cancelled');
    expect(audit[0].tenant_id).toBe('expirer-audit');
    expect(audit[0].change_summary).toMatchObject({
      run_id: stale,
      from_state: 'created',
      reason_code: 'expired',
      target_tenant_id: 'expirer-audit',
      swept_by: 'onboarding_expirer',
    });
    // A regra aplicada precisa estar registrada com o dado a que foi aplicada.
    expect(audit[0].change_summary.expires_at).toEqual(expect.any(String));
  });

  it('audita também a run de bootstrap, que ainda não tem tenant', async () => {
    // `tenant_id IS NULL`: `admin_audit_log.tenant_id` é FK NOT NULL para
    // `tenants`, então a linha vai para o bucket sancionado `system` com o
    // alvo preservado em `change_summary` — nunca um literal 'default'.
    const stale = await seedRun({ expires_in_ms: -60_000 });

    await tick();

    const audit = await auditRows(stale);
    expect(audit).toHaveLength(1);
    expect(audit[0].tenant_id).toBe('system');
    expect(audit[0].actor_id).toBe('system');
    expect(audit[0].change_summary).toMatchObject({
      reason_code: 'expired',
      target_tenant_id: null,
      target_agent_id: null,
    });
    expect(JSON.stringify(audit[0].change_summary)).not.toContain('default');
  });

  it('auditoria, evento e UPDATE são a MESMA transação (mesmo xmin)', async () => {
    // Prova direta, sem injetar falha em código de produção: no Postgres, o
    // `xmin` de uma linha É o id da transação que a escreveu. Se as três
    // escritas saem do mesmo `withTx`, os três `xmin` são idênticos; se a
    // auditoria escapar para fora da transação (um `db.insert` no lugar do
    // `tx.insert`), o dela passa a ser outro — e a trilha sobrevive a um
    // rollback do UPDATE, que é exatamente o defeito.
    const stale = await seedRun({ tenant_id: 'expirer-xmin', expires_in_ms: -60_000 });

    await tick();

    const { rows } = await pool.query(
      `SELECT (SELECT xmin::text FROM onboarding_runs WHERE id=$1::uuid) AS run_xmin,
              (SELECT xmin::text FROM onboarding_events WHERE run_id=$1::uuid) AS event_xmin,
              (SELECT xmin::text FROM admin_audit_log
                WHERE resource_type='onboarding_run' AND resource_id=$1::text) AS audit_xmin`,
      [stale],
    );
    const { run_xmin, event_xmin, audit_xmin } = rows[0];
    expect(run_xmin).toBeTruthy();
    expect(event_xmin).toBe(run_xmin);
    expect(audit_xmin).toBe(run_xmin);
  });

  it('run viva não gera nem evento nem auditoria', async () => {
    const ids = [
      await seedRun({ tenant_id: 'expirer-atomic-1', expires_in_ms: -60_000 }),
      await seedRun({ tenant_id: 'expirer-atomic-2', expires_in_ms: -60_000 }),
      await seedRun({ tenant_id: 'expirer-atomic-3', expires_in_ms: 60 * 60_000 }),
    ];

    await tick();

    const states = await Promise.all(ids.map(readRun));
    const audits = await Promise.all(ids.map(auditRows));
    expect(states.map((s) => s.state)).toEqual(['cancelled', 'cancelled', 'created']);
    // Uma linha de auditoria por run EXPIRADA, nenhuma para a que sobreviveu.
    expect(audits.map((a) => a.length)).toEqual([1, 1, 0]);
    expect(await eventTypes(ids[2])).toHaveLength(0);
  });

  it('preserva a run que ainda NÃO venceu', async () => {
    const alive = await seedRun({ tenant_id: 'expirer-alive', expires_in_ms: 60 * 60_000 });

    await tick();

    const after = await readRun(alive);
    expect(after.state).toBe('created');
    expect(after.last_error_code).toBeNull();
    expect(after.cancelled_at).toBeNull();
    expect(after.version).toBe(1);
    expect(await eventTypes(alive)).toHaveLength(0);
  });

  it('não re-expira uma run já terminal, mesmo vencida', async () => {
    const terminal = await seedRun({
      tenant_id: 'expirer-terminal',
      state: 'active',
      expires_in_ms: -60_000,
    });

    await tick();

    const after = await readRun(terminal);
    expect(after.state).toBe('active');
    expect(after.version).toBe(1);
    expect(after.last_error_code).toBeNull();
    expect(await eventTypes(terminal)).toHaveLength(0);
  });

  it('duas corridas simultâneas não expiram a mesma run duas vezes (por que não há lock)', async () => {
    // A justificativa para NÃO acrescentar single-flight, verificada em vez de
    // afirmada: `expireStale` trava cada run com `SELECT … FOR UPDATE` e
    // re-valida estado/`expires_at` DEPOIS da trava, então a corrida perdedora
    // encontra a run já terminal e não escreve nada.
    const ids = [
      await seedRun({ tenant_id: 'expirer-race-1', expires_in_ms: -60_000 }),
      await seedRun({ tenant_id: 'expirer-race-2', expires_in_ms: -60_000 }),
      await seedRun({ tenant_id: 'expirer-race-3', expires_in_ms: -60_000 }),
    ];

    const before = await expiredCounter();
    await Promise.all([tick(), tick()]);

    // 3 runs, 2 corridas: a contagem total continua 3 — sem dobra.
    expect(await expiredCounter()).toBe(before + 3);
    for (const id of ids) {
      const after = await readRun(id);
      expect(after.state).toBe('cancelled');
      expect(after.last_error_code).toBe('expired');
      // Um único UPDATE por run: `version` 1 → 2, e UM evento append-only.
      expect(after.version).toBe(2);
      expect(await eventTypes(id)).toEqual(['run_expired']);
    }
  });

  it('a série de cancelamento sai com o tenant e o agente DE CADA RUN', async () => {
    // Duas runs com escopo real e distinto, e uma terceira ainda sem tenant.
    // O que se prova aqui é a decisão do dono: a varredura roda global, a
    // ATRIBUIÇÃO é por escopo. Com o worker emitindo um agregado sob `system`,
    // as duas primeiras asserções ficam em 0.
    const scoped = [
      await seedRun({ tenant_id: 'expirer-scope-1', agent_id: 'ag-1', expires_in_ms: -60_000 }),
      await seedRun({ tenant_id: 'expirer-scope-2', agent_id: 'ag-2', expires_in_ms: -60_000 }),
    ];
    const orphan = await seedRun({ expires_in_ms: -60_000 });

    const before = {
      one: await expiredCounterFor('expirer-scope-1', 'ag-1'),
      two: await expiredCounterFor('expirer-scope-2', 'ag-2'),
      system: await expiredCounterFor('system', 'system'),
    };

    await tick();

    expect((await expiredCounterFor('expirer-scope-1', 'ag-1')) - before.one).toBe(1);
    expect((await expiredCounterFor('expirer-scope-2', 'ag-2')) - before.two).toBe(1);
    // A run SEM tenant continua expirada e contada — no bucket sancionado
    // `system`, nunca num literal `'default'` (invariante MUST nº 8).
    expect((await expiredCounterFor('system', 'system')) - before.system).toBe(1);
    const out = await renderPrometheus();
    expect(out).not.toContain('tenant_id="default"');

    for (const id of [...scoped, orphan]) {
      expect((await readRun(id)).state).toBe('cancelled');
    }
  });

  it('o backlog aparece quando a fila é maior que o lote — e drena tick a tick', async () => {
    // Esta é a pergunta que a contagem de expiradas não responde: o worker
    // drena o teto todo tick e parece saudável enquanto a fila cresce. A fonte
    // é a MESMA que o coletor de scrape usa
    // (`src/observability/onboarding-expiry-collector.ts`), com o mesmo
    // predicado da varredura.
    const { onboardingRunsRepo } = await import('@/db/repositories/onboarding-repos.js');
    const base = await onboardingRunsRepo.snapshotExpiryBacklog();

    await seedRun({ tenant_id: 'expirer-backlog-1', expires_in_ms: -600_000 });
    await seedRun({ tenant_id: 'expirer-backlog-2', expires_in_ms: -60_000 });
    await seedRun({ tenant_id: 'expirer-backlog-3', expires_in_ms: -60_000 });
    // Uma run VIVA não é backlog: o predicado é o da varredura, não "tudo que
    // existe".
    await seedRun({ tenant_id: 'expirer-backlog-4', expires_in_ms: 60 * 60_000 });

    const queued = await onboardingRunsRepo.snapshotExpiryBacklog();
    expect(queued.backlog - base.backlog).toBe(3);
    // A mais atrasada esperava ~10 minutos. É o sinal que diz "estou perdendo a
    // corrida" quando a contagem sozinha não diz.
    expect(queued.oldest_age_seconds).toBeGreaterThanOrEqual(600);

    // Um tick com lote 2 deixa exatamente uma na fila.
    await tickWithLimit(2);
    const after = await onboardingRunsRepo.snapshotExpiryBacklog();
    expect(after.backlog - base.backlog).toBe(1);

    // E o resto drena no tick seguinte.
    await tickWithLimit(2);
    expect((await onboardingRunsRepo.snapshotExpiryBacklog()).backlog - base.backlog).toBe(0);
  });

  it('respeita o limite de lote: 3 vencidas, limite 2 ⇒ 2 expiradas neste tick', async () => {
    // Tenants distintos: `onboarding_runs_one_live_per_tenant_uq` só admite uma
    // run viva por tenant.
    const ids = [
      await seedRun({ tenant_id: 'expirer-batch-1', expires_in_ms: -60_000 }),
      await seedRun({ tenant_id: 'expirer-batch-2', expires_in_ms: -60_000 }),
      await seedRun({ tenant_id: 'expirer-batch-3', expires_in_ms: -60_000 }),
    ];

    const before = await expiredCounter();
    await tickWithLimit(2);
    const afterFirst = await expiredCounter();

    // Exatamente o teto — nem 3 (varreria tudo), nem um laço até esvaziar.
    expect(afterFirst - before).toBe(2);
    const states = await Promise.all(ids.map(readRun));
    expect(states.filter((s) => s.state === 'cancelled')).toHaveLength(2);
    expect(states.filter((s) => s.state === 'created')).toHaveLength(1);

    // A sobra drena no tick seguinte — o backlog não fica preso.
    await tickWithLimit(2);
    expect(await expiredCounter()).toBe(before + 3);
    const final = await Promise.all(ids.map(readRun));
    expect(final.every((s) => s.state === 'cancelled' && s.last_error_code === 'expired')).toBe(
      true,
    );
  });
});
