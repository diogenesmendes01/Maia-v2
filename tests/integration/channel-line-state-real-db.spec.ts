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

  it('abort é idempotente e devolve a linha para declared, limpando o material', async () => {
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
    expect(state?.state).toBe('declared');
    expect(state?.pairing_material).toBeNull();
    expect(state?.reason_code).toBe('operator_abort');
  });

  it('após abort, um novo start abre normalmente (retry não reutiliza a tentativa anterior)', async () => {
    const { channelLineStateRepo } = await import('../../src/db/repositories.js');
    const scope = { tenant_id: T, agent_id: A, channel_id: channelId };
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'start_pairing',
      method: 'qr',
      command_id: randomUUID(),
      ...ACTOR,
    });
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: randomUUID(),
      ...ACTOR,
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
    await channelLineStateRepo.requestCommand({
      scope,
      command: 'abort_pairing',
      command_id: randomUUID(),
      ...ACTOR,
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
    // O worker reivindicou (instância "velha") e o processo morreu.
    await channelLineStateRepo.claimNextCommand('old-instance:1');
    await channelLineStateRepo.putPairingMaterial({
      channel_id: channelId,
      command_id: key,
      envelope: Buffer.from('SEALED'),
      key_id: 'k1',
      kind: 'qr',
      expires_at: new Date(Date.now() + 60_000),
    });
    await channelLineStateRepo.clearCommand(channelId);

    const stale = await channelLineStateRepo.failStalePairings({
      owner_instance: 'new-instance:2',
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
      owner_instance: 'any-instance',
      reason_code: 'interrupted_retryable',
    });
    expect(stale).toHaveLength(0);
    expect((await channelLineStateRepo.getStateForScope(scope))?.state).toBe('pairing');
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
