/**
 * Issue #518 — `channel_line_state` (migration 103) contra Postgres real.
 *
 * O que só um banco de verdade prova:
 *   1. ISOLAMENTO: um channel_id de OUTRO tenant não é encontrado nem
 *      comandado — lookup cross-tenant não é autorização.
 *   2. LISTAGEM: o canal WhatsApp inativo ("declarado") CONTINUA visível
 *      (a `listActive` antiga o fazia sumir da tela).
 *   3. IDEMPOTÊNCIA + CONCORRÊNCIA: a mesma idempotency key devolve a
 *      tentativa existente; duas chaves diferentes com pairing vivo geram
 *      exatamente UM vencedor e um `pairing_in_progress` determinístico.
 *      QUEM arbitra depende de a linha do canal já existir (#573):
 *        - linha EXISTENTE ⇒ o `FOR UPDATE` dentro da transação é o juiz;
 *          a perdedora serializa atrás da vencedora e lê o pairing vivo dela.
 *        - linha AINDA INEXISTENTE ⇒ `FOR UPDATE` não tranca o que não
 *          existe, e o árbitro é o índice único de `channel_id`. Por isso o
 *          INSERT é `ON CONFLICT DO NOTHING`: a colisão vira zero linhas em
 *          vez de `23505`, e é a RELEITURA travada (aí sim com o `FOR UPDATE`
 *          fazendo efeito) que devolve `pairing_in_progress`.
 *   4. RESTART: uma tentativa órfã vira `failed` retryable, NUNCA `verified`,
 *      e o material cifrado é destruído junto.
 *   5. O material só entra na row como envelope — a coluna é `bytea` e o
 *      conteúdo em claro nunca aparece.
 *
 * Pulado sem TEST_DB_URL (mesmo gate dos demais specs de integração).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { useExclusivePairingQueue } from './helpers/pairing-queue-lock.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// A fila de `channel_line_state` é global por desenho — ver o helper.
useExclusivePairingQueue();

const T = 'i518-tenant';
const T2 = 'i518-tenant-b';
const A = 'i518-agent';
const A2 = 'i518-agent-b';

let pool: pg.Pool;
let channelId: string;
let foreignChannelId: string;

async function wipe(): Promise<void> {
  const c = await pool.connect();
  try {
    for (const t of [T, T2]) {
      await c.query(`DELETE FROM admin_audit_log WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM channel_policies WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM roles WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM channel_line_state WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM channels WHERE tenant_id = $1`, [t]);
    }
  } finally {
    c.release();
  }
}

/** Triplete de uma linha, como `listLocalLineSessions()` o entrega. */
function ownedLine(channel_id: string, tenant_id = T, agent_id = A) {
  return { channel_id, tenant_id, agent_id };
}

/**
 * Mata a lease de posse de SESSÃO deterministicamente.
 *
 * Substitui o `lease_ms: 1` + `sleep`: com 1ms a lease vencia ANTES da própria
 * chamada seguinte (o round-trip ao Postgres já passa de 1ms), então o cenário
 * "dono vivo agora, morto depois" nunca era montado. Empurrar o vencimento
 * para o passado no banco expressa a intenção sem depender de relógio.
 */
async function expireSessionLease(channel_id: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `UPDATE channel_line_state
          SET session_owner_lease_expires_at = now() - interval '1 minute'
        WHERE channel_id = $1`,
      [channel_id],
    );
  } finally {
    c.release();
  }
}

/**
 * Espera até que ALGUMA outra transação esteja bloqueada pela de `holderPid`.
 *
 * É o que torna o teste de corrida do #573 determinístico em vez de torcer
 * pelo escalonador: em vez de dormir um tempo arbitrário antes de commitar,
 * o teste só solta o commit depois que o Postgres CONFIRMA que a chamada de
 * produção travou esperando a linha segurada.
 */
async function waitUntilBlockedBy(holderPid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const c = await pool.connect();
  try {
    for (;;) {
      const r = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND $1 = ANY (pg_blocking_pids(pid))`,
        [holderPid],
      );
      if (r.rows[0]!.n > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          `#573: nada ficou bloqueado pelo pid ${holderPid} em ${timeoutMs}ms — ` +
            `o INSERT concorrente não chegou a disputar o índice único`,
        );
      }
      await new Promise((done) => setTimeout(done, 20));
    }
  } finally {
    c.release();
  }
}

async function seedChannel(
  tenant: string,
  agent: string,
  line: string,
  active = false,
): Promise<string> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO channels(tenant_id, agent_id, channel_type, external_id, active)
       VALUES ($1, $2, 'whatsapp', $3, $4) RETURNING id`,
      [tenant, agent, line, active],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

if (SHOULD_RUN) {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      for (const [t, a] of [
        [T, A],
        [T2, A2],
      ]) {
        await c.query(
          `INSERT INTO tenants(id, nome) VALUES ($1, 'I518') ON CONFLICT (id) DO NOTHING`,
          [t],
        );
        await c.query(
          `INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1, $2, 'I518', 'active')
             ON CONFLICT (id) DO NOTHING`,
          [a, t],
        );
      }
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await wipe();
    const c = await pool.connect();
    try {
      for (const [t, a] of [
        [T, A],
        [T2, A2],
      ]) {
        await c.query(`DELETE FROM agents WHERE id = $1`, [a]);
        await c.query(`DELETE FROM tenants WHERE id = $1`, [t]);
      }
    } finally {
      c.release();
      await pool.end();
    }
  });

  beforeEach(async () => {
    await wipe();
    channelId = await seedChannel(T, A, `+55119${Date.now() % 100000000}`);
    foreignChannelId = await seedChannel(T2, A2, `+55118${Date.now() % 100000000}`);
  });
}

const ACTOR = { actor_id: 'i518-user', actor_role: 'owner', correlation_id: 'corr-1' };

d('channel_line_state — isolamento e listagem', () => {
  it('canal INATIVO permanece visível na listagem do console', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const lines = await channelLineStateRepo.listLinesForScope({
      tenant_id: T,
      agent_id: A,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.active).toBe(false);
    // Sem row em channel_line_state ainda: o estado é DERIVADO, nunca `connected`.
    expect(lines[0]!.state).toBe('declared');
  });

  it('a listagem NÃO enxerga linhas de outro tenant', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const lines = await channelLineStateRepo.listLinesForScope({
      tenant_id: T,
      agent_id: A,
    });
    expect(lines.map((l) => l.channel_id)).not.toContain(foreignChannelId);
  });

  it('getForScope com channel_id de OUTRO tenant devolve null (fail-closed)', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const line = await channelLineStateRepo.getForScope({
      tenant_id: T,
      agent_id: A,
      channel_id: foreignChannelId,
    });
    expect(line).toBeNull();
  });

  it('requestCommand contra linha de outro tenant é channel_not_found — nenhuma row criada', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const res = await channelLineStateRepo.requestCommand({
      scope: { tenant_id: T, agent_id: A, channel_id: foreignChannelId },
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    expect(res).toEqual({ ok: false, reason: 'channel_not_found' });

    const c = await pool.connect();
    try {
      const rows = await c.query(`SELECT 1 FROM channel_line_state WHERE channel_id = $1`, [
        foreignChannelId,
      ]);
      expect(rows.rowCount).toBe(0);
    } finally {
      c.release();
    }
  });
});

d('channel_line_state — idempotência e concorrência', () => {
  it('mesma idempotency key ⇒ devolve a tentativa existente, sem novo attempt', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const key = randomUUID();
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };

    const first = await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: key,
      ...ACTOR,
    });
    const second = await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: key,
      ...ACTOR,
    });

    expect(first).toMatchObject({ ok: true, idempotent: false });
    expect(second).toMatchObject({ ok: true, idempotent: true });
    expect((second as { row: { pairing_attempts: number } }).row.pairing_attempts).toBe(1);
  });

  it('duas requisições CONCORRENTES com chaves distintas: um vencedor, um pairing_in_progress', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const [a, b] = await Promise.all([
      channelLineStateRepo.requestCommand({
        scope,
        command: 'start_pairing',
        method: 'qr',
        command_id: randomUUID(),
        ...ACTOR,
      }),
      channelLineStateRepo.requestCommand({
        scope,
        command: 'start_pairing',
        method: 'code',
        command_id: randomUUID(),
        ...ACTOR,
      }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0] as { reason: string }).reason).toBe('pairing_in_progress');
  });

  /**
   * Issue #573 — regressão DETERMINÍSTICA da corrida de criação da linha.
   *
   * O caso acima só reproduzia o defeito por sorte: a janela entre o
   * `SELECT … FOR UPDATE` e o `INSERT` é sub-milissegundo. Aqui a ordem é
   * FORÇADA. Uma transação nossa cria a linha vencedora e SEGURA o commit;
   * `requestCommand` — a chamada de produção de verdade, não um harness
   * espelho — roda com essa linha ainda invisível, lê `null` (o `FOR UPDATE`
   * não tem fantasma para trancar) e trava no índice único; só então o
   * vencedor commita.
   *
   * Com o defeito, a perdedora estoura `duplicate key value violates unique
   * constraint "channel_line_state_pkey"` (23505). Com a correção, o
   * `ON CONFLICT DO NOTHING` devolve zero linhas, a releitura travada enxerga
   * o pairing vivo do vencedor e a resposta é `pairing_in_progress`.
   *
   * Deadlock não é possível: o bloqueio é de mão única (a transação segurada
   * não pede nada que a de `requestCommand` detenha). Ainda assim a espera
   * pelo bloqueio tem prazo próprio (8s, dentro do `testTimeout` de 20s) e a
   * transação segurada é sempre encerrada no `finally`.
   */
  it('linha AINDA INEXISTENTE: o INSERT perdedor devolve pairing_in_progress, não 23505', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };

    const holder = await pool.connect();
    let settled: Promise<{ value?: unknown; error?: unknown }> | null = null;
    let committed = false;
    try {
      await holder.query('BEGIN');
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;

      // O VENCEDOR: pairing VIVO, escrito mas ainda NÃO commitado.
      await holder.query(
        `INSERT INTO channel_line_state
           (channel_id, tenant_id, agent_id, state, command, command_method, command_id,
            command_requested_at, actor_id, actor_role, correlation_id,
            pairing_method, pairing_started_at, pairing_expires_at,
            pairing_attempts, last_transition_at)
         VALUES ($1, $2, $3, 'pairing', 'start_pairing', 'qr', $4,
                 now(), $5, $6, $7, 'qr', now(), now() + interval '15 minutes', 1, now())`,
        [channelId, T, A, randomUUID(), ACTOR.actor_id, ACTOR.actor_role, ACTOR.correlation_id],
      );

      // O PERDEDOR. Captura o desfecho dos dois lados para que uma falha na
      // espera não vire unhandled rejection.
      settled = channelLineStateRepo
        .requestCommand({
          scope,
          command: 'start_pairing',
          method: 'code',
          command_id: randomUUID(),
          ...ACTOR,
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );

      await waitUntilBlockedBy(holderPid);
      await holder.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await holder.query('ROLLBACK').catch(() => undefined);
      // Não deixa a transação de produção pendurada para o próximo `wipe()`.
      if (settled) await settled;
      holder.release();
    }

    const outcome = await settled!;
    // Com o defeito, isto relança o 23505 literal — é o vermelho da regressão.
    if (outcome.error !== undefined) throw outcome.error;
    expect(outcome.value).toEqual({ ok: false, reason: 'pairing_in_progress' });

    // E o vencedor continua sendo o vencedor: a perdedora não escreveu nada.
    const state = await channelLineStateRepo.getStateForScope(scope);
    expect(state?.pairing_method).toBe('qr');
    expect(state?.pairing_attempts).toBe(1);
  });

  it('SEQUÊNCIA start → abort → start ANTES do tick: o segundo start é rejeitado', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };

    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const abortKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: abortKey,
      ...ACTOR,
    });

    // Antes do fix: o abort devolvia a linha para `declared` na hora, este
    // start passava, sobrescrevia o comando de abort — e a sessão antiga
    // seguia viva, podendo concluir e ATIVAR a linha.
    const retry = await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    expect(retry).toEqual({ ok: false, reason: 'pairing_in_progress' });

    const state = await channelLineStateRepo.getStateForScope(scope);
    expect(state?.state).toBe('aborting');
    expect(state?.command).toBe('abort_pairing');
    expect(state?.command_id).toBe(abortKey);
  });

  it('confirmado o abort, um novo start passa', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const abortKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: abortKey,
      ...ACTOR,
    });
    // O worker confirma que a sessão morreu.
    await channelLineStateRepo.transition({
      channel_id: channelId,
      state: 'declared',
      reason_code: 'operator_abort',
      expected_command_id: abortKey,
      release_owner: true,
    });

    const retry = await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    expect(retry.ok).toBe(true);
  });

  it('abort repetido antes do tick não troca o command_id (CAS do worker preservado)', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const firstAbort = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: firstAbort,
      ...ACTOR,
    });
    const second = await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: randomUUID(),
      ...ACTOR,
    });
    expect(second).toMatchObject({ ok: true, idempotent: true });
    expect((await channelLineStateRepo.getStateForScope(scope))?.command_id).toBe(firstAbort);
  });

  it('abort órfão (dono morto) é resgatado: a linha volta a ser pareável', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const abortKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: abortKey,
      ...ACTOR,
    });
    await channelLineStateRepo.claimNextCommand('dead-instance', 1);
    await channelLineStateRepo.completeCommand({
      channel_id: channelId,
      command_id: abortKey,
      owner_instance: 'dead-instance',
      release_owner: false,
      lease_ms: 1,
    });
    await new Promise((r) => setTimeout(r, 20));

    const released = await channelLineStateRepo.releaseStaleAborts();
    expect(released.map((r) => r.channel_id)).toContain(channelId);
    expect((await channelLineStateRepo.getStateForScope(scope))?.state).toBe('declared');
  });

  it('abort é idempotente e devolve a linha para aborting, limpando o material', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const startKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: startKey,
      ...ACTOR,
    });
    await channelLineStateRepo.putPairingMaterial({
      channel_id: channelId,
      command_id: startKey,
      envelope: Buffer.from('SEALED-ENVELOPE'),
      key_id: 'k1',
      kind: 'qr',
      expires_at: new Date(Date.now() + 60_000),
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await channelLineStateRepo.requestCommand({
        scope,
        command: 'abort_pairing',
        command_id: randomUUID(),
        ...ACTOR,
      });
      expect(res.ok).toBe(true);
    }

    const state = await channelLineStateRepo.getStateForScope(scope);
    // `aborting`, não `declared`: a linha só reabre quando o runtime confirmar.
    expect(state?.state).toBe('aborting');
    expect(state?.pairing_material).toBeNull();
    expect(state?.reason_code).toBe('operator_abort');
  });

  it('após abort CONFIRMADO, um novo start abre normalmente (retry não reutiliza a tentativa anterior)', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const abortKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: abortKey,
      ...ACTOR,
    });
    await channelLineStateRepo.transition({
      channel_id: channelId,
      state: 'declared',
      reason_code: 'operator_abort',
      expected_command_id: abortKey,
      release_owner: true,
    });
    const retry = await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'code',
      command_id: randomUUID(),
      ...ACTOR,
    });
    expect(retry.ok).toBe(true);
    expect((retry as { row: { pairing_attempts: number } }).row.pairing_attempts).toBe(2);
  });
});

/**
 * Rodada 2 do review PR #528 — o gate de readiness ignorava o perfil
 * operacional: um agente com policy e role, mas SEM perfil ativo, continuava
 * elegível para ativação, e a linha entrava em roteamento para responder sem
 * identidade operacional aprovada.
 */
d('line readiness — perfil operacional ativo é precondição', () => {
  async function seedPolicyAndRole(): Promise<void> {
    const c = await pool.connect();
    try {
      const role = await c.query<{ id: string }>(
        `INSERT INTO roles(tenant_id, agent_id, role_key, display_name, is_default, active)
         VALUES ($1, $2, 'atendente', 'Atendente', true, true) RETURNING id`,
        [T, A],
      );
      await c.query(
        `INSERT INTO channel_policies(tenant_id, agent_id, channel_id, default_role_id, switch_behavior)
         VALUES ($1, $2, $3, $4, 'locked')`,
        [T, A, channelId, role.rows[0]!.id],
      );
    } finally {
      c.release();
    }
  }

  async function seedActiveProfile(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, proposed_by, activated_at)
         VALUES ($1, $2, 1, 'active', 'i518-test', now())`,
        [T, A],
      );
    } finally {
      c.release();
    }
  }

  async function wipeReadiness(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM channel_policies WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM roles WHERE tenant_id = $1`, [T]);
    } finally {
      c.release();
    }
  }

  beforeEach(async () => {
    await wipeReadiness();
  });

  afterAll(async () => {
    await wipeReadiness();
  });

  it('CASO NEGATIVO: policy + role prontos, mas SEM perfil ativo ⇒ não pronta', async () => {
    const { evaluateLineReadiness } = await import('../../src/setup/line-readiness.js');
    await seedPolicyAndRole();

    expect(
      await evaluateLineReadiness({ id: channelId, tenant_id: T, agent_id: A }),
    ).toEqual({ ready: false, reason_code: 'missing_active_profile' });
  });

  it('perfil apenas PROPOSTO não conta', async () => {
    const { evaluateLineReadiness } = await import('../../src/setup/line-readiness.js');
    await seedPolicyAndRole();
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, proposed_by)
         VALUES ($1, $2, 1, 'proposed', 'i518-test')`,
        [T, A],
      );
    } finally {
      c.release();
    }

    expect(
      await evaluateLineReadiness({ id: channelId, tenant_id: T, agent_id: A }),
    ).toEqual({ ready: false, reason_code: 'missing_active_profile' });
  });

  it('perfil ativo + policy + role ativo ⇒ pronta', async () => {
    const { evaluateLineReadiness } = await import('../../src/setup/line-readiness.js');
    await seedActiveProfile();
    await seedPolicyAndRole();

    expect(
      await evaluateLineReadiness({ id: channelId, tenant_id: T, agent_id: A }),
    ).toEqual({ ready: true });
  });

  it('o perfil de OUTRO tenant não satisfaz a precondição (escopo)', async () => {
    const { evaluateLineReadiness } = await import('../../src/setup/line-readiness.js');
    await seedPolicyAndRole();
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, proposed_by, activated_at)
         VALUES ($1, $2, 1, 'active', 'i518-test', now())`,
        [T2, A2],
      );
    } finally {
      c.release();
    }

    expect(
      await evaluateLineReadiness({ id: channelId, tenant_id: T, agent_id: A }),
    ).toEqual({ ready: false, reason_code: 'missing_active_profile' });

    const cleanup = await pool.connect();
    try {
      await cleanup.query(
        `DELETE FROM agent_operational_profile_versions WHERE tenant_id = $1`,
        [T2],
      );
    } finally {
      cleanup.release();
    }
  });
});

d('channel_line_state — comando e auditoria no MESMO commit (review PR #528, P2)', () => {
  const AUDIT = {
    actor_id: 'i518-user',
    actor_role: 'owner' as const,
    action: 'channel_pairing_requested',
    change_summary: { agent_id: A, method: 'qr', reason: 'teste de atomicidade' },
  };

  async function auditRows(): Promise<number> {
    const c = await pool.connect();
    try {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM admin_audit_log WHERE tenant_id = $1 AND resource_id = $2`,
        [T, channelId],
      );
      return Number(r.rows[0]!.n);
    } finally {
      c.release();
    }
  }

  it('comando e trilha aparecem juntos', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const res = await channelLineStateRepo.requestCommandWithAudit({
      scope: { tenant_id: T, agent_id: A, channel_id: channelId },
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
      audit: AUDIT,
    });
    expect(res.ok).toBe(true);
    expect(await auditRows()).toBe(1);
  });

  it('trilha que falha DESFAZ o comando — nunca sobra comando sem auditoria', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };

    // `action` NULL viola NOT NULL em admin_audit_log: simula a falha do
    // segundo write. Antes eram dois commits, e o comando sobrevivia sozinho.
    await expect(
      channelLineStateRepo.requestCommandWithAudit({
        scope,
        command: 'start_pairing',
        method: 'qr',
        command_id: randomUUID(),
        ...ACTOR,
        audit: { ...AUDIT, action: null as unknown as string },
      }),
    ).rejects.toThrow();

    expect(await auditRows()).toBe(0);
    // O comando NÃO ficou pendente: o rollback levou os dois juntos.
    expect(await channelLineStateRepo.getStateForScope(scope)).toBeNull();
  });

  it('replay idempotente não duplica a trilha', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const key = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await channelLineStateRepo.requestCommandWithAudit({
        scope,
        command: 'start_pairing',
        method: 'qr',
        command_id: key,
        ...ACTOR,
        audit: AUDIT,
      });
    }
    expect(await auditRows()).toBe(1);
  });

  it('disable: roteamento, estado, comando de parada e trilha num commit só', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const activeId = await seedChannel(T, A, `+55116${Date.now() % 100000000}`, true);
    const scope = { tenant_id: T, agent_id: A, channel_id: activeId };

    const res = await channelLineStateRepo.disableLineWithAudit({
      scope,
      reason_code: 'operator_disabled',
      stop_command_id: randomUUID(),
      ...ACTOR,
      audit: { ...AUDIT, action: 'channel_disabled' },
    });
    expect(res.ok).toBe(true);

    const state = await channelLineStateRepo.getStateForScope(scope);
    expect(state?.state).toBe('disabled');
    expect(state?.command).toBe('stop_line');

    const c = await pool.connect();
    try {
      const chan = await c.query<{ active: boolean }>(
        `SELECT active FROM channels WHERE id = $1`,
        [activeId],
      );
      expect(chan.rows[0]!.active).toBe(false);
      const audit = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM admin_audit_log
          WHERE tenant_id = $1 AND resource_id = $2 AND action = 'channel_disabled'`,
        [T, activeId],
      );
      expect(Number(audit.rows[0]!.n)).toBe(1);
    } finally {
      c.release();
    }
  });

  it('disable de linha fora do escopo não desativa nem audita nada', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const res = await channelLineStateRepo.disableLineWithAudit({
      scope: { tenant_id: T, agent_id: A, channel_id: foreignChannelId },
      reason_code: 'operator_disabled',
      stop_command_id: randomUUID(),
      ...ACTOR,
      audit: { ...AUDIT, action: 'channel_disabled' },
    });
    expect(res).toEqual({ ok: false, reason: 'channel_not_found' });

    const c = await pool.connect();
    try {
      const chan = await c.query<{ active: boolean }>(
        `SELECT active FROM channels WHERE id = $1`,
        [foreignChannelId],
      );
      expect(chan.rows[0]!.active).toBe(false); // seed nasce inativo; segue intacto
      const audit = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM admin_audit_log WHERE resource_id = $1`,
        [foreignChannelId],
      );
      expect(Number(audit.rows[0]!.n)).toBe(0);
    } finally {
      c.release();
    }
  });
});

d('channel_line_state — material cifrado e restart', () => {
  it('o material persistido é opaco: o texto em claro nunca aparece na row', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const key = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'code',
      command_id: key,
      ...ACTOR,
    });
    await channelLineStateRepo.putPairingMaterial({
      channel_id: channelId,
      command_id: key,
      envelope: Buffer.from([0x01, 0x02, 0x03, 0x04]),
      key_id: 'k1',
      kind: 'code',
      expires_at: new Date(Date.now() + 60_000),
    });

    const c = await pool.connect();
    try {
      const r = await c.query<{ row: string }>(
        `SELECT channel_line_state::text AS row FROM channel_line_state WHERE channel_id = $1`,
        [channelId],
      );
      expect(r.rows[0]!.row).not.toContain('4F7K2M9Q');
    } finally {
      c.release();
    }
  });

  it('material de uma tentativa ANTIGA não entra na tentativa nova (guard de identidade)', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const oldKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: oldKey,
      ...ACTOR,
    });
    const abortKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: abortKey,
      ...ACTOR,
    });
    // O runtime confirma o abort — só então a linha reabre para um novo start.
    await channelLineStateRepo.transition({
      channel_id: channelId,
      state: 'declared',
      reason_code: 'operator_abort',
      expected_command_id: abortKey,
      release_owner: true,
    });
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });

    // Callback ATRASADO da sessão antiga.
    const applied = await channelLineStateRepo.putPairingMaterial({
      channel_id: channelId,
      command_id: oldKey,
      envelope: Buffer.from('STALE'),
      key_id: 'k1',
      kind: 'qr',
      expires_at: new Date(Date.now() + 60_000),
    });
    expect(applied).toBe(false);
    const state = await channelLineStateRepo.getStateForScope(scope);
    expect(state?.pairing_material).toBeNull();
  });

  it('DUAS réplicas nunca executam o mesmo comando: o segundo claim volta vazio', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    await channelLineStateRepo.requestCommand({
      scope: { tenant_id: T, agent_id: A, channel_id: channelId },
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });

    // `FOR UPDATE SKIP LOCKED` so protege a janela da transacao; o bug era o
    // comando voltar a ser elegivel assim que ela commitava.
    const a = await channelLineStateRepo.claimNextCommand('replica-A');
    const b = await channelLineStateRepo.claimNextCommand('replica-B');
    expect(a?.channel_id).toBe(channelId);
    expect(b).toBeNull();
  });

  it('claims CONCORRENTES de duas réplicas produzem exatamente um vencedor', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    await channelLineStateRepo.requestCommand({
      scope: { tenant_id: T, agent_id: A, channel_id: channelId },
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const [a, b] = await Promise.all([
      channelLineStateRepo.claimNextCommand('replica-A'),
      channelLineStateRepo.claimNextCommand('replica-B'),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it('lease VENCIDA (dono morto) libera o comando para outra réplica', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    await channelLineStateRepo.requestCommand({
      scope: { tenant_id: T, agent_id: A, channel_id: channelId },
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    // Réplica A reivindica com lease de 1ms e "morre" (nunca renova).
    expect(await channelLineStateRepo.claimNextCommand('replica-A', 1)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    const takeover = await channelLineStateRepo.claimNextCommand('replica-B');
    expect(takeover?.owner_instance).toBe('replica-B');
  });

  it('a réplica B NÃO derruba o pareamento vivo da réplica A (heartbeat)', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const key = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: key,
      ...ACTOR,
    });
    // A reivindica, consome o comando e mantém a sessão viva renovando a lease.
    await channelLineStateRepo.claimNextCommand('replica-A');
    await channelLineStateRepo.completeCommand({
      channel_id: channelId,
      command_id: key,
      owner_instance: 'replica-A',
      release_owner: false,
    });
    await channelLineStateRepo.renewOwnerLeases('replica-A');

    // B varre. Antes do fix, o filtro `owner_instance <> 'replica-B'` matava a
    // sessão de A a cada tick — o bug distribuído que a #528 apontou.
    const swept = await channelLineStateRepo.failStalePairings({
      reason_code: 'interrupted_retryable',
    });
    expect(swept.map((s) => s.channel_id)).not.toContain(channelId);
    expect((await channelLineStateRepo.getStateForScope(scope))?.state).toBe('pairing');
  });

  it('o heartbeat renova SÓ as rows do próprio dono', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    await channelLineStateRepo.requestCommand({
      scope: { tenant_id: T, agent_id: A, channel_id: channelId },
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    await channelLineStateRepo.claimNextCommand('replica-A');
    expect(await channelLineStateRepo.renewOwnerLeases('replica-B')).toBe(0);
    expect(await channelLineStateRepo.renewOwnerLeases('replica-A')).toBe(1);
  });

  it('conclusão terminal: comando limpo E posse liberada no MESMO write', async () => {
    // Rodada 2 do review PR #528: `release_owner` num statement separado
    // zerava o `owner_instance` que o CAS do clear comparava — o clear falhava
    // e o comando terminal voltava a ser elegível na hora.
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const key = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: key,
      ...ACTOR,
    });
    const claimed = await channelLineStateRepo.claimNextCommand('replica-A');
    expect(claimed?.command).toBe('abort_pairing');

    const done = await channelLineStateRepo.completeCommand({
      channel_id: channelId,
      command_id: key,
      owner_instance: 'replica-A',
      release_owner: true,
      state: 'declared',
      reason_code: 'operator_abort',
    });
    expect(done).toBe(true);

    const after = await channelLineStateRepo.getStateForScope(scope);
    expect(after?.command).toBeNull();
    expect(after?.owner_instance).toBeNull();
    expect(after?.owner_lease_expires_at).toBeNull();
    expect(after?.state).toBe('declared');

    // A PROVA: nenhuma réplica volta a receber o comando.
    expect(await channelLineStateRepo.claimNextCommand('replica-A')).toBeNull();
    expect(await channelLineStateRepo.claimNextCommand('replica-B')).toBeNull();
  });

  it('conclusão SEM liberar a posse mantém a linha reservada a esta instância', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const key = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: key,
      ...ACTOR,
    });
    await channelLineStateRepo.claimNextCommand('replica-A');
    await channelLineStateRepo.completeCommand({
      channel_id: channelId,
      command_id: key,
      owner_instance: 'replica-A',
      release_owner: false,
    });

    const after = await channelLineStateRepo.getStateForScope(scope);
    expect(after?.command).toBeNull();
    // A PairingSession segue viva em A: soltar a posse aqui faria o sweep
    // matá-la.
    expect(after?.owner_instance).toBe('replica-A');
    expect(after?.owner_lease_expires_at).not.toBeNull();
    expect(after?.state).toBe('pairing');
  });

  it('completeCommand é CAS: um finally atrasado não apaga o comando NOVO', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const oldKey = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: oldKey,
      ...ACTOR,
    });
    await channelLineStateRepo.claimNextCommand('replica-A');
    // O operador cancela: comando NOVO na mesma row.
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: randomUUID(),
      ...ACTOR,
    });

    const cleared = await channelLineStateRepo.completeCommand({
      channel_id: channelId,
      command_id: oldKey,
      owner_instance: 'replica-A',
      release_owner: false,
    });
    expect(cleared).toBe(false);
    expect((await channelLineStateRepo.getStateForScope(scope))?.command).toBe('abort_pairing');
  });

  it('restart: tentativa órfã vira failed retryable (nunca verified) e perde o material', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    const key = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: key,
      ...ACTOR,
    });
    // O worker reivindicou (instância "velha", lease de 1ms) e o processo
    // morreu: nunca renovou o heartbeat, então a lease vence.
    await channelLineStateRepo.claimNextCommand('old-instance:1', 1);
    await channelLineStateRepo.putPairingMaterial({
      channel_id: channelId,
      command_id: key,
      envelope: Buffer.from('SEALED'),
      key_id: 'k1',
      kind: 'qr',
      expires_at: new Date(Date.now() + 60_000),
    });
    await channelLineStateRepo.completeCommand({
      channel_id: channelId,
      command_id: key,
      owner_instance: 'old-instance:1',
      release_owner: false,
      lease_ms: 1,
    });
    await new Promise((r) => setTimeout(r, 20));

    const stale = await channelLineStateRepo.failStalePairings({
      reason_code: 'interrupted_retryable',
    });
    expect(stale.map((s) => s.channel_id)).toContain(channelId);

    const state = await channelLineStateRepo.getStateForScope(scope);
    expect(state?.state).toBe('failed');
    expect(state?.reason_code).toBe('interrupted_retryable');
    expect(state?.pairing_material).toBeNull();
  });

  it('uma tentativa recém-pedida (comando AINDA pendente) NÃO é varrida', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const stale = await channelLineStateRepo.failStalePairings({
      reason_code: 'interrupted_retryable',
    });
    expect(stale).toHaveLength(0);
    expect((await channelLineStateRepo.getStateForScope(scope))?.state).toBe('pairing');
  });

  it('listVerifiedAwaitingActivation só devolve linha VERIFICADA e INATIVA', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    await channelLineStateRepo.upsertTransition({
      channel_id: channelId,
      tenant_id: T,
      agent_id: A,
      state: 'verified_offline',
    });
    // Linha de outro tenant, também verificada e inativa: entra na lista
    // (a varredura é cross-tenant por contrato), mas com o triplete próprio.
    await channelLineStateRepo.upsertTransition({
      channel_id: foreignChannelId,
      tenant_id: T2,
      agent_id: A2,
      state: 'verified_offline',
    });

    const pending = await channelLineStateRepo.listVerifiedAwaitingActivation();
    const mine = pending.find((p) => p.channel_id === channelId);
    expect(mine).toMatchObject({ tenant_id: T, agent_id: A });
    const foreign = pending.find((p) => p.channel_id === foreignChannelId);
    expect(foreign).toMatchObject({ tenant_id: T2, agent_id: A2 });
  });

  it('linha JÁ ativa não aparece como pendente de ativação', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const activeId = await seedChannel(T, A, `+55117${Date.now() % 100000000}`, true);
    await channelLineStateRepo.upsertTransition({
      channel_id: activeId,
      tenant_id: T,
      agent_id: A,
      state: 'verified_offline',
    });
    const pending = await channelLineStateRepo.listVerifiedAwaitingActivation();
    expect(pending.map((p) => p.channel_id)).not.toContain(activeId);
  });

  /**
   * P1 NOVO da rodada 2 do review PR #528 — duas réplicas promovendo a mesma
   * linha. Sem CAS sobre `active = false`, as duas recebiam `ok: true` e cada
   * uma subia um socket Baileys para a MESMA linha WhatsApp.
   */
  it('activateVerified é CAS: duas réplicas concorrentes, UM vencedor', async () => {
    const { channelsRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };

    const [a, b] = await Promise.all([
      channelsRepo.activateVerified(scope),
      channelsRepo.activateVerified(scope),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // Perdedor benigno, distinguível de erro de escopo: quem perde não pode
    // marcar a linha `failed` nem subir uma segunda sessão.
    expect((losers[0] as { reason: string }).reason).toBe('already_active');
  });

  it('ativação sequencial: a segunda chamada informa already_active, não sucesso', async () => {
    const { channelsRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    expect((await channelsRepo.activateVerified(scope)).ok).toBe(true);
    expect(await channelsRepo.activateVerified(scope)).toEqual({
      ok: false,
      reason: 'already_active',
    });
  });

  it('activateVerified fora do escopo continua not_found (fail-closed)', async () => {
    const { channelsRepo } = await import('../../src/db/repositories.js');
    expect(
      await channelsRepo.activateVerified({
        tenant_id: T,
        agent_id: A,
        channel_id: foreignChannelId,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  /**
   * P1 da rodada 2 do review PR #528 — `channelLines.ts:335`.
   *
   * `stopLineSession` só enxerga o `Map` local da réplica que consumiu o
   * comando. Sem endereçamento, a réplica ERRADA consumia o `stop_line`,
   * chamava um no-op e concluía: o operador via "desabilitada" e a linha
   * continuava respondendo pela réplica dona. Pior que não ter feito nada.
   */
  it('stop_line é endereçado à réplica DONA do socket — a outra não o consome', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };

    // A réplica A publica que segura o socket desta linha.
    await channelLineStateRepo.upsertTransition({
      channel_id: channelId,
      tenant_id: T,
      agent_id: A,
      state: 'connected',
    });
    await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]);

    await channelLineStateRepo.disableLineWithAudit({
      scope,
      reason_code: 'operator_disabled',
      stop_command_id: randomUUID(),
      ...ACTOR,
      audit: {
        actor_id: 'i518-user',
        actor_role: 'owner',
        action: 'channel_disabled',
        change_summary: { agent_id: A },
      },
    });

    const state = await channelLineStateRepo.getStateForScope(scope);
    expect(state?.command).toBe('stop_line');
    expect(state?.target_instance).toBe('replica-A');

    // A réplica B NÃO pode consumir: ela não tem o socket.
    expect(await channelLineStateRepo.claimNextCommand('replica-B')).toBeNull();
    // A dona consome.
    const claimed = await channelLineStateRepo.claimNextCommand('replica-A');
    expect(claimed?.command).toBe('stop_line');
  });

  it('dono MORTO (lease vencida): qualquer réplica conclui o stop', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.upsertTransition({
      channel_id: channelId,
      tenant_id: T,
      agent_id: A,
      state: 'connected',
    });
    await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]);
    // A réplica A morreu e nunca mais renovou.
    await expireSessionLease(channelId);

    await channelLineStateRepo.disableLineWithAudit({
      scope,
      reason_code: 'operator_disabled',
      stop_command_id: randomUUID(),
      ...ACTOR,
      audit: {
        actor_id: 'i518-user',
        actor_role: 'owner',
        action: 'channel_disabled',
        change_summary: { agent_id: A },
      },
    });

    // Com o dono morto o comando nasce SEM destino — o socket morreu junto.
    const state = await channelLineStateRepo.getStateForScope(scope);
    expect(state?.target_instance).toBeNull();
    expect((await channelLineStateRepo.claimNextCommand('replica-B'))?.command).toBe(
      'stop_line',
    );
  });

  it('comando endereçado a um dono que morreu DEPOIS não fica pendurado', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.upsertTransition({
      channel_id: channelId,
      tenant_id: T,
      agent_id: A,
      state: 'connected',
    });
    // Dono VIVO no momento em que o comando é enfileirado — é o que faz o
    // comando nascer endereçado.
    await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]);
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'stop_line',
      command_id: randomUUID(),
      ...ACTOR,
      address_to_session_owner: true,
    });
    expect((await channelLineStateRepo.getStateForScope(scope))?.target_instance).toBe(
      'replica-A',
    );

    // ...e só DEPOIS a réplica dona morre. Sem o escape de lease vencida no
    // claim, o comando ficaria endereçado a um processo que não existe mais.
    await expireSessionLease(channelId);
    expect((await channelLineStateRepo.claimNextCommand('replica-B'))?.command).toBe(
      'stop_line',
    );
  });

  it('a conclusão do stop apaga o registro de posse da sessão', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]);
    const key = randomUUID();
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'stop_line',
      command_id: key,
      ...ACTOR,
      address_to_session_owner: true,
    });
    await channelLineStateRepo.claimNextCommand('replica-A');
    await channelLineStateRepo.completeCommand({
      channel_id: channelId,
      command_id: key,
      owner_instance: 'replica-A',
      release_owner: true,
      clear_session_owner: true,
    });

    const after = await channelLineStateRepo.getStateForScope(scope);
    expect(after?.command).toBeNull();
    expect(after?.target_instance).toBeNull();
    expect(after?.session_owner_instance).toBeNull();
    expect(after?.session_owner_lease_expires_at).toBeNull();
  });

  /**
   * Falha de CI da rodada 2. `renewSessionLeases` era um UPDATE puro: quando a
   * row de `channel_line_state` ainda não existia, a escrita não pegava nada e
   * a posse ficava NULL — em silêncio. Consequência: `disable` nascia SEM
   * destino e voltava a ser consumido pela réplica errada, que chamava
   * `stopLineSession` num Map local vazio e reportava sucesso. O P1 da rodada
   * 2 reintroduzido como no-op.
   *
   * Acontece de verdade: um canal ativado fora do fluxo do console nunca passa
   * por `requestCommand`, e o heartbeat pode disparar antes do primeiro
   * `connection.update`.
   */
  it('registra a posse mesmo quando a row de estado AINDA NÃO EXISTE', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    // Nenhum pareamento, nenhuma transição: a row não existe.
    expect(await channelLineStateRepo.getStateForScope(scope)).toBeNull();

    expect(
      await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]),
    ).toBe(1);

    const after = await channelLineStateRepo.getStateForScope(scope);
    expect(after).not.toBeNull();
    expect(after!.session_owner_instance).toBe('replica-A');
    expect(after!.session_owner_lease_expires_at).not.toBeNull();
    // A row nasce com o escopo correto — sem ele o console não a enxergaria.
    expect(after!.tenant_id).toBe(T);
    expect(after!.agent_id).toBe(A);
  });

  it('a posse recém-registrada JÁ endereça o disable à réplica dona', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]);

    await channelLineStateRepo.disableLineWithAudit({
      scope,
      reason_code: 'operator_disabled',
      stop_command_id: randomUUID(),
      ...ACTOR,
      audit: {
        actor_id: 'i518-user',
        actor_role: 'owner',
        action: 'channel_disabled',
        change_summary: { agent_id: A },
      },
    });

    expect((await channelLineStateRepo.getStateForScope(scope))?.target_instance).toBe(
      'replica-A',
    );
    expect(await channelLineStateRepo.claimNextCommand('replica-B')).toBeNull();
  });

  it('renovar a posse NÃO altera o estado da linha (ortogonalidade)', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.markDisabled(scope, 'operator_disabled');

    await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]);

    const after = await channelLineStateRepo.getStateForScope(scope);
    // Uma linha `disabled` que ainda tem socket PRECISA continuar endereçável;
    // e registrar posse não pode ressuscitar o estado.
    expect(after?.state).toBe('disabled');
    expect(after?.session_owner_instance).toBe('replica-A');
  });

  it('releaseSessionOwnership só solta o que é do próprio dono', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.renewSessionLeases('replica-A', [ownedLine(channelId)]);

    expect(await channelLineStateRepo.releaseSessionOwnership('replica-B', [channelId])).toBe(0);
    expect((await channelLineStateRepo.getStateForScope(scope))?.session_owner_instance).toBe(
      'replica-A',
    );
    expect(await channelLineStateRepo.releaseSessionOwnership('replica-A', [channelId])).toBe(1);
    expect(
      (await channelLineStateRepo.getStateForScope(scope))?.session_owner_instance,
    ).toBeNull();
  });

  it('uma linha DESABILITADA não é ressuscitada por callback atrasado da sessão', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.markDisabled(scope, 'operator_disabled');

    // `connection.update` atrasado do socket que ainda não morreu.
    await channelLineStateRepo.upsertTransition({
      channel_id: channelId,
      tenant_id: T,
      agent_id: A,
      state: 'connected',
      connected_at: new Date(),
    });

    expect((await channelLineStateRepo.getStateForScope(scope))?.state).toBe('disabled');
  });

  it('claimNextCommand devolve o triplete + a linha, para o worker abrir o ALS certo', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    await channelLineStateRepo.requestCommand({
      scope: { tenant_id: T, agent_id: A, channel_id: channelId },
      command: 'start_pairing',
      method: 'code',
      command_id: randomUUID(),
      ...ACTOR,
    });
    const claimed = await channelLineStateRepo.claimNextCommand('worker-1');
    expect(claimed).toMatchObject({
      channel_id: channelId,
      tenant_id: T,
      agent_id: A,
      command: 'start_pairing',
      command_method: 'code',
      actor_id: 'i518-user',
      actor_role: 'owner',
      owner_instance: 'worker-1',
      channel_type: 'whatsapp',
    });
  });
});
