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
 *      exatamente UM vencedor e um `pairing_in_progress` determinístico
 *      (o `FOR UPDATE` dentro da transação é o juiz).
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

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

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
      await c.query(`DELETE FROM channel_line_state WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM channels WHERE tenant_id = $1`, [t]);
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
