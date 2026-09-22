/**
 * K-15 (spec §4.1) — `agent_engine_policies` (145) e o seletor de turno novo,
 * contra Postgres REAL.
 *
 * O que os casos prendem:
 *
 *  1. **Escopo.** Linha `hermes` do tenant A não liga o tenant B, nem outro
 *     agente do A, nem outro canal do mesmo agente.
 *  2. **Ausência ≠ falha.** Sem linha = `maia_react`; lookup que falha recusa.
 *  3. **CAS.** Versão velha é recusada e a linha não muda; versão certa sobe 1.
 *  4. **O banco recusa sozinho** duplicata, engine desconhecido e canal de
 *     outro escopo (FK composta para `channels (tenant_id, agent_id, id)`).
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  EnginePolicyLookupError,
  enginePoliciesRepo,
  readEnginePolicyForScope,
} from '@/db/repositories/engine-policy-repos.js';
import { lookupEngineForNewTurn } from '@/runtime/engines/selector.js';
import {
  canaryAllowsHermesLiveTurn,
  canaryPolicyRepo,
} from '@/db/repositories/canary-policy-repos.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT_A = 'engine-policy-tenant-a';
const TENANT_B = 'engine-policy-tenant-b';
const AGENT_A1 = 'engine-policy-agent-a1';
const AGENT_A2 = 'engine-policy-agent-a2';
const AGENT_B1 = 'engine-policy-agent-b1';
const OPERADOR = 'app-user-operador';

let pool: pg.Pool;

function noEscopo<T>(tenant_id: string, agent_id: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id, agent_id }, fn);
}

async function mkCanal(tenant_id: string, agent_id: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, active)
     VALUES ($1, $2, 'web', $3, true) RETURNING id`,
    [tenant_id, agent_id, `engine-policy-${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

/** O seletor de turno novo com a porta de produção, sob o ALS do escopo. */
function motorDoTurnoNovo(
  tenant_id: string,
  agent_id: string,
  channel_id: string,
  kill_switch = false,
) {
  return noEscopo(tenant_id, agent_id, () =>
    lookupEngineForNewTurn({
      scope: { tenant_id, agent_id, channel_id },
      kill_switch,
      readPolicy: readEnginePolicyForScope,
      // Degrau já liberado de propósito: o assunto DESTE arquivo é a LINHA
      // (K-15). A composição dos dois gates tem bloco proprio no fim.
      canaryAllowsHermes: async () => true,
    }),
  );
}

async function linhaCrua(channel_id: string) {
  const r = await pool.query(
    `SELECT tenant_id, agent_id, engine, row_version::int AS row_version, updated_by
       FROM agent_engine_policies WHERE channel_id = $1`,
    [channel_id],
  );
  return r.rows;
}

d('agent_engine_policies + seletor de turno novo contra Postgres real (K-15)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    for (const t of [TENANT_A, TENANT_B]) {
      await pool.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [
        t,
      ]);
    }
    for (const [a, t] of [
      [AGENT_A1, TENANT_A],
      [AGENT_A2, TENANT_A],
      [AGENT_B1, TENANT_B],
    ] as const) {
      await pool.query(
        'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
        [a, t],
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM agent_engine_policies WHERE tenant_id = ANY($1)`, [
      [TENANT_A, TENANT_B],
    ]);
    await pool.query(`DELETE FROM agent_canary_policy WHERE tenant_id = ANY($1)`, [
      [TENANT_A, TENANT_B],
    ]);
    await pool.query(`DELETE FROM channels WHERE tenant_id = ANY($1)`, [[TENANT_A, TENANT_B]]);
    await pool.end();
  });

  it('1. sem linha: leitura devolve null e o turno novo cai em maia_react', async () => {
    const canal = await mkCanal(TENANT_A, AGENT_A1);
    expect(await noEscopo(TENANT_A, AGENT_A1, () => enginePoliciesRepo.find(canal))).toBeNull();
    expect(await motorDoTurnoNovo(TENANT_A, AGENT_A1, canal)).toEqual({
      kind: 'ok',
      engine: 'maia_react',
      source: 'no_policy',
    });
  });

  it('2. tenant A ligado não liga tenant B, nem outro agente, nem outro canal', async () => {
    const canalA1 = await mkCanal(TENANT_A, AGENT_A1);
    const outroCanalA1 = await mkCanal(TENANT_A, AGENT_A1);
    const canalA2 = await mkCanal(TENANT_A, AGENT_A2);
    const canalB1 = await mkCanal(TENANT_B, AGENT_B1);

    const w = await noEscopo(TENANT_A, AGENT_A1, () =>
      enginePoliciesRepo.write({
        channel_id: canalA1,
        engine: 'hermes',
        expected_row_version: null,
        updated_by: OPERADOR,
      }),
    );
    expect(w).toEqual({ ok: true, row_version: 1 });

    expect(await motorDoTurnoNovo(TENANT_A, AGENT_A1, canalA1)).toEqual({
      kind: 'ok',
      engine: 'hermes',
      source: 'policy',
    });
    for (const [t, a, c] of [
      [TENANT_B, AGENT_B1, canalB1],
      [TENANT_A, AGENT_A2, canalA2],
      [TENANT_A, AGENT_A1, outroCanalA1],
    ] as const) {
      expect(await motorDoTurnoNovo(t, a, c)).toEqual({
        kind: 'ok',
        engine: 'maia_react',
        source: 'no_policy',
      });
    }
    // O id do canal de A, lido sob o ALS de B, não vaza a linha de A.
    expect(await noEscopo(TENANT_B, AGENT_B1, () => enginePoliciesRepo.find(canalA1))).toBeNull();
  });

  it('3. kill switch vence a linha hermes', async () => {
    const canal = await mkCanal(TENANT_A, AGENT_A1);
    await noEscopo(TENANT_A, AGENT_A1, () =>
      enginePoliciesRepo.write({
        channel_id: canal,
        engine: 'hermes',
        expected_row_version: null,
        updated_by: OPERADOR,
      }),
    );
    expect(await motorDoTurnoNovo(TENANT_A, AGENT_A1, canal, true)).toEqual({
      kind: 'ok',
      engine: 'maia_react',
      source: 'kill_switch',
    });
  });

  it('4. CAS feliz: insert nasce na versão 1 e cada escrita aceita sobe 1', async () => {
    const canal = await mkCanal(TENANT_A, AGENT_A1);
    const escrever = (engine: 'hermes' | 'maia_react', expected_row_version: number | null) =>
      noEscopo(TENANT_A, AGENT_A1, () =>
        enginePoliciesRepo.write({
          channel_id: canal,
          engine,
          expected_row_version,
          updated_by: OPERADOR,
        }),
      );

    expect(await escrever('hermes', null)).toEqual({ ok: true, row_version: 1 });
    expect(await escrever('maia_react', 1)).toEqual({ ok: true, row_version: 2 });
    expect(await escrever('hermes', 2)).toEqual({ ok: true, row_version: 3 });

    const lida = await noEscopo(TENANT_A, AGENT_A1, () => enginePoliciesRepo.find(canal));
    expect(lida).toMatchObject({ engine: 'hermes', row_version: 3, updated_by: OPERADOR });
  });

  it('5. CAS recusa versão velha e a linha não muda', async () => {
    const canal = await mkCanal(TENANT_A, AGENT_A1);
    const escrever = (
      engine: 'hermes' | 'maia_react',
      expected_row_version: number | null,
      updated_by: string,
    ) =>
      noEscopo(TENANT_A, AGENT_A1, () =>
        enginePoliciesRepo.write({ channel_id: canal, engine, expected_row_version, updated_by }),
      );

    // Sem linha, "está na versão 1" é mentira: recusa, e nada é criado.
    expect(await escrever('hermes', 1, OPERADOR)).toEqual({
      ok: false,
      reason: 'stale_row_version',
      current_row_version: null,
    });
    expect(await linhaCrua(canal)).toEqual([]);

    await escrever('maia_react', null, OPERADOR);
    await escrever('maia_react', 1, OPERADOR);
    const antes = await linhaCrua(canal);
    expect(antes).toEqual([
      {
        tenant_id: TENANT_A,
        agent_id: AGENT_A1,
        engine: 'maia_react',
        row_version: 2,
        updated_by: OPERADOR,
      },
    ]);

    expect(await escrever('hermes', 1, 'app-user-atrasado')).toEqual({
      ok: false,
      reason: 'stale_row_version',
      current_row_version: 2,
    });
    // "Não existe linha" com linha presente também é versão velha.
    expect(await escrever('hermes', null, 'app-user-atrasado')).toEqual({
      ok: false,
      reason: 'stale_row_version',
      current_row_version: 2,
    });
    expect(await linhaCrua(canal)).toEqual(antes);
  });

  it('6. duas escritas com a mesma versão: uma aceita, uma recusa', async () => {
    const canal = await mkCanal(TENANT_A, AGENT_A1);
    const escrever = (engine: 'hermes' | 'maia_react') =>
      noEscopo(TENANT_A, AGENT_A1, () =>
        enginePoliciesRepo.write({
          channel_id: canal,
          engine,
          expected_row_version: null,
          updated_by: OPERADOR,
        }),
      );
    const r = await Promise.all([escrever('hermes'), escrever('maia_react')]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok)).toEqual([
      { ok: false, reason: 'stale_row_version', current_row_version: 1 },
    ]);
    expect((await linhaCrua(canal))[0]?.row_version).toBe(1);
  });

  it('7. o banco recusa duplicata do mesmo escopo', async () => {
    const canal = await mkCanal(TENANT_A, AGENT_A1);
    const inserir = () =>
      pool.query(
        `INSERT INTO agent_engine_policies (tenant_id, agent_id, channel_id, engine, updated_by)
         VALUES ($1, $2, $3, 'hermes', $4)`,
        [TENANT_A, AGENT_A1, canal, OPERADOR],
      );
    await inserir();
    await expect(inserir()).rejects.toMatchObject({
      code: '23505',
      constraint: 'agent_engine_policies_pk',
    });
  });

  it('8. o banco recusa engine desconhecido', async () => {
    const canal = await mkCanal(TENANT_A, AGENT_A1);
    await expect(
      pool.query(
        `INSERT INTO agent_engine_policies (tenant_id, agent_id, channel_id, engine, updated_by)
         VALUES ($1, $2, $3, 'gpt', $4)`,
        [TENANT_A, AGENT_A1, canal, OPERADOR],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'agent_engine_policies_engine_chk' });
    await expect(
      pool.query(
        `INSERT INTO agent_engine_policies (tenant_id, agent_id, channel_id, engine, updated_by)
         VALUES ($1, $2, $3, 'hermes', '')`,
        [TENANT_A, AGENT_A1, canal],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'agent_engine_policies_updated_by_chk' });
  });

  it('9. canal de outro tenant ou de outro agente: a FK composta recusa', async () => {
    const canalA1 = await mkCanal(TENANT_A, AGENT_A1);

    // Pelo repositório, sob o ALS de B, com o canal de A.
    await expect(
      noEscopo(TENANT_B, AGENT_B1, () =>
        enginePoliciesRepo.write({
          channel_id: canalA1,
          engine: 'hermes',
          expected_row_version: null,
          updated_by: OPERADOR,
        }),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '23503',
        constraint: 'agent_engine_policies_channel_fk',
      }),
    });

    // Direto no banco, outro agente do MESMO tenant.
    await expect(
      pool.query(
        `INSERT INTO agent_engine_policies (tenant_id, agent_id, channel_id, engine, updated_by)
         VALUES ($1, $2, $3, 'hermes', $4)`,
        [TENANT_A, AGENT_A2, canalA1, OPERADOR],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'agent_engine_policies_channel_fk' });
    expect(await linhaCrua(canalA1)).toEqual([]);
  });

  it('10. falha de lookup fecha: erro tipado, e o seletor recusa em vez de escolher', async () => {
    // Erro de banco real (uuid inválido), não "sem linha".
    const erro = await noEscopo(TENANT_A, AGENT_A1, () =>
      enginePoliciesRepo.find('nao-e-uuid'),
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(EnginePolicyLookupError);
    expect((erro as EnginePolicyLookupError).reason).toBe('query_failed');

    expect(await motorDoTurnoNovo(TENANT_A, AGENT_A1, 'nao-e-uuid')).toEqual({
      kind: 'refused',
      reason: 'policy_lookup_failed',
    });

    // Escopo pedido diferente do ALS: recusa, não lê a política de ninguém.
    const canalA1 = await mkCanal(TENANT_A, AGENT_A1);
    await noEscopo(TENANT_A, AGENT_A1, () =>
      enginePoliciesRepo.write({
        channel_id: canalA1,
        engine: 'hermes',
        expected_row_version: null,
        updated_by: OPERADOR,
      }),
    );
    await expect(
      noEscopo(TENANT_B, AGENT_B1, () =>
        readEnginePolicyForScope({ tenant_id: TENANT_A, agent_id: AGENT_A1, channel_id: canalA1 }),
      ),
    ).rejects.toMatchObject({ reason: 'scope_mismatch' });
    expect(
      await noEscopo(TENANT_B, AGENT_B1, () =>
        lookupEngineForNewTurn({
          scope: { tenant_id: TENANT_A, agent_id: AGENT_A1, channel_id: canalA1 },
          kill_switch: false,
          readPolicy: readEnginePolicyForScope,
          canaryAllowsHermes: async () => true,
        }),
      ),
    ).toEqual({ kind: 'refused', reason: 'policy_lookup_failed' });
  });
});

/**
 * P12 (spec §10.1) — a LINHA e o DEGRAU compondo contra Postgres real.
 *
 * O arquivo acima prova a linha de `agent_engine_policies` (K-15). Estes casos
 * provam o que ela NÃO basta para fazer sozinha: ligar o Hermes. A escada do
 * §10.1 põe `hermes_live_turn` em `live_informational`, e até esta fatia ela
 * era dado e regra sem leitor nenhum — uma linha de tabela bastava para ligar
 * o motor remoto, sem coorte cadastrada e sem evidência de aceite.
 *
 * Aqui os dois gates rodam com as portas de PRODUÇÃO — `readEnginePolicyForScope`
 * e `canaryAllowsHermesLiveTurn` —, contra as duas tabelas de verdade (145 e
 * 147). Um teste que injetasse a escada como booleano provaria a conjunção em
 * TypeScript e não provaria que a leitura do degrau funciona.
 */
d('P12 — a escada do canário decide junto com a linha (Postgres real)', () => {
  let canal: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await pool.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [
      TENANT_A,
    ]);
    await pool.query(
      'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
      [AGENT_A1, TENANT_A],
    );
    canal = await mkCanal(TENANT_A, AGENT_A1);
    await noEscopo(TENANT_A, AGENT_A1, () =>
      enginePoliciesRepo.write({
        channel_id: canal,
        engine: 'hermes',
        expected_row_version: null,
        updated_by: OPERADOR,
      }),
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM agent_canary_policy WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM agent_engine_policies WHERE tenant_id = $1`, [TENANT_A]);
    await pool.query(`DELETE FROM channels WHERE tenant_id = $1`, [TENANT_A]);
    await pool.end();
  });

  /** O seletor com as DUAS portas de produção. */
  function motor() {
    return noEscopo(TENANT_A, AGENT_A1, () =>
      lookupEngineForNewTurn({
        scope: { tenant_id: TENANT_A, agent_id: AGENT_A1, channel_id: canal },
        kill_switch: false,
        readPolicy: readEnginePolicyForScope,
        canaryAllowsHermes: canaryAllowsHermesLiveTurn,
      }),
    );
  }

  async function degrau(input: {
    stage: 'off' | 'synthetic' | 'shadow_offline' | 'live_informational';
    cohort_ref?: string | null;
    acceptance_evidence_ref?: string | null;
  }) {
    await pool.query(`DELETE FROM agent_canary_policy WHERE tenant_id = $1`, [TENANT_A]);
    return noEscopo(TENANT_A, AGENT_A1, () =>
      canaryPolicyRepo.write({
        stage: input.stage,
        cohort_ref: input.cohort_ref ?? null,
        acceptance_evidence_ref: input.acceptance_evidence_ref ?? null,
        expected_row_version: null,
        updated_by: OPERADOR,
      }),
    );
  }

  it('1. linha hermes SEM degrau cadastrado: fica no incumbente', async () => {
    // Ausência de linha de canário vale `off`. Era exatamente este o buraco:
    // a linha de `agent_engine_policies` sozinha ligava o motor remoto.
    await pool.query(`DELETE FROM agent_canary_policy WHERE tenant_id = $1`, [TENANT_A]);
    expect(await motor()).toEqual({ kind: 'ok', engine: 'maia_react', source: 'canary_hold' });
  });

  it('2. degrau `shadow_offline` ainda não libera turno vivo', async () => {
    // O §10.1 descreve `shadow_offline` como "resultados não enviados". Um
    // turno de verdade no motor remoto é o degrau seguinte.
    expect(
      await degrau({ stage: 'shadow_offline', acceptance_evidence_ref: 'aceite-1' }),
    ).toMatchObject({ ok: true });
    expect(await motor()).toEqual({ kind: 'ok', engine: 'maia_react', source: 'canary_hold' });
  });

  it('3. `live_informational` COM coorte e aceite: o Hermes atende', async () => {
    // A contra-prova. Sem ela, um gate que negasse sempre passaria nos dois
    // casos acima e o canário nunca sairia do lugar.
    expect(
      await degrau({
        stage: 'live_informational',
        cohort_ref: 'coorte-1',
        acceptance_evidence_ref: 'aceite-1',
      }),
    ).toMatchObject({ ok: true });
    expect(await motor()).toEqual({ kind: 'ok', engine: 'hermes', source: 'policy' });
  });

  it('4. degrau `live` SEM coorte nem chega a existir — a escrita recusa', async () => {
    // `validateCanaryPolicy` roda antes do banco e diz QUAL requisito faltou;
    // a CHECK da 147 diz a mesma coisa e é a que vale para escrita à mão.
    const r = await degrau({ stage: 'live_informational', acceptance_evidence_ref: 'aceite-1' });
    expect(r).toMatchObject({ ok: false, reason: 'incoherent_policy' });
    // E sem degrau válido o motor continua sendo o incumbente.
    expect(await motor()).toEqual({ kind: 'ok', engine: 'maia_react', source: 'canary_hold' });
  });
});
