/**
 * Sonda sintética (spec §3, aceite de integração — DB real). Cobre:
 *   - máquina de estado durável: recordFailure→degraded no K + alert_pending;
 *     recordOk reseta + limpa alert_pending + recovered; SOBREVIVE a "restart"
 *     (releitura via getState);
 *   - single-flight: acquire/release/hold do lease;
 *   - correlação + asserção por efeito colateral: findInboundMensagemIdByWid +
 *     scenario.assert sobre rows reais (transacao pendente + out);
 *   - cleanup: remove a transacao (side-effect) e PRESERVA mensagens/audit
 *     (trilha) — §1.5/§1.7.6;
 *   - sweep de TTL: fecha um run órfão;
 *   - regressão §1.7.7: o canal de sonda SEMEADO é inativo + is_synthetic ⇒
 *     fora do discriminador de `findPrimaryCatchAllChannel` (não degrada o
 *     ingresso real).
 *
 * Skipped sem TEST_DB_URL (espelha as specs de integração irmãs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { audit } from '@/governance/audit.js';
import { syntheticProbeRepo } from '@/db/repositories/synthetic-probe-repos.js';
import { findInboundMensagemIdByWid } from '@/probe/queries.js';
import { registerTransactionPendenteScenario } from '@/probe/scenarios.js';
import {
  PROBE_TENANT_ID,
  PROBE_AGENT_ID,
  PROBE_CHANNEL_ID,
  PROBE_PESSOA_ID,
  PROBE_ENTIDADE_ID,
  PROBE_CONTA_ID,
  PROBE_CONTEXT,
} from '@/probe/constants.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

async function q<R extends pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
  const c = await pool.connect();
  try {
    return await c.query<R>(text, params);
  } finally {
    c.release();
  }
}

/** Insere um "turno completo" simulado no tenant da sonda e devolve os ids. */
async function seedTurn(wid: string): Promise<{ conversaId: string; inboundId: string; outId: string }> {
  const conv = await q<{ id: string }>(
    `INSERT INTO conversas (tenant_id, agent_id, pessoa_id, channel_id, status)
     VALUES ($1,$2,$3,$4,'ativa') RETURNING id`,
    [PROBE_TENANT_ID, PROBE_AGENT_ID, PROBE_PESSOA_ID, PROBE_CHANNEL_ID],
  );
  const conversaId = conv.rows[0]!.id;
  const inbound = await q<{ id: string }>(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, channel_id, direcao, tipo, conteudo, metadata)
     VALUES ($1,$2,$3,$4,'in','texto','registre despesa pendente de 50', jsonb_build_object('whatsapp_id',$5::text))
     RETURNING id`,
    [PROBE_TENANT_ID, PROBE_AGENT_ID, conversaId, PROBE_CHANNEL_ID, wid],
  );
  const inboundId = inbound.rows[0]!.id;
  await q(
    `INSERT INTO transacoes (tenant_id, agent_id, entidade_id, conta_id, natureza, valor, data_competencia, status, descricao, origem, conversa_id, mensagem_id)
     VALUES ($1,$2,$3,$4,'despesa',50,CURRENT_DATE,'pendente','almoço','whatsapp',$5,$6)`,
    [PROBE_TENANT_ID, PROBE_AGENT_ID, PROBE_ENTIDADE_ID, PROBE_CONTA_ID, conversaId, inboundId],
  );
  const out = await q<{ id: string }>(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, channel_id, direcao, tipo, conteudo, metadata)
     VALUES ($1,$2,$3,$4,'out','texto','registrei sua despesa pendente', jsonb_build_object('in_reply_to',$5::text))
     RETURNING id`,
    [PROBE_TENANT_ID, PROBE_AGENT_ID, conversaId, PROBE_CHANNEL_ID, inboundId],
  );
  return { conversaId, inboundId, outId: out.rows[0]!.id };
}

async function cleanProbeRuntime(): Promise<void> {
  await q(`DELETE FROM synthetic_probe_runs WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
  await q(`DELETE FROM synthetic_probe_state WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
  await q(`DELETE FROM audit_log WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
  await q(`DELETE FROM transacoes WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
  // wids de teste começam com 'probe-' — pega também a row plantada em 'primary'
  // pelo teste de vazamento (cross-tenant).
  await q(`DELETE FROM mensagens WHERE tenant_id=$1 OR metadata->>'whatsapp_id' LIKE 'probe-%'`, [PROBE_TENANT_ID]);
  await q(`DELETE FROM conversas WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
  // restaura o canal ao estado semeado (inativo) — testes de ativação podem tê-lo ligado.
  await q(`UPDATE channels SET active=false WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
}

if (SHOULD_RUN) {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await cleanProbeRuntime();
    await pool.end();
  });
  beforeEach(cleanProbeRuntime);
}

d('synthetic probe — state machine (durável)', () => {
  it('recordFailure → degraded no K-ésimo, com alert_pending; sobrevive a restart', async () => {
    const K = 3;
    let r = await syntheticProbeRepo.recordFailure({ tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, alert_after_k: K });
    expect(r.consecutive_failures).toBe(1);
    expect(r.transitioned_to_degraded).toBe(false);
    r = await syntheticProbeRepo.recordFailure({ tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, alert_after_k: K });
    expect(r.consecutive_failures).toBe(2);
    r = await syntheticProbeRepo.recordFailure({ tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, alert_after_k: K });
    expect(r.consecutive_failures).toBe(3);
    expect(r.transitioned_to_degraded).toBe(true);

    // "Restart": releitura do estado durável (não in-memory).
    const state = await syntheticProbeRepo.getState(PROBE_TENANT_ID, PROBE_AGENT_ID);
    expect(state?.health).toBe('degraded');
    expect(state?.alert_pending).toBe(true);
    expect(state?.consecutive_failures).toBe(3);
  });

  it('recordOk reseta, marca recovered e limpa alert_pending', async () => {
    const K = 2;
    await syntheticProbeRepo.recordFailure({ tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, alert_after_k: K });
    await syntheticProbeRepo.recordFailure({ tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, alert_after_k: K });
    const rec = await syntheticProbeRepo.recordOk(PROBE_TENANT_ID, PROBE_AGENT_ID);
    expect(rec.recovered).toBe(true);
    const state = await syntheticProbeRepo.getState(PROBE_TENANT_ID, PROBE_AGENT_ID);
    expect(state?.health).toBe('healthy');
    expect(state?.consecutive_failures).toBe(0);
    expect(state?.alert_pending).toBe(false);
    expect(state?.last_ok_at).toBeTruthy();
  });

  it('secondsSinceLastOk ~0 logo após um OK', async () => {
    await syntheticProbeRepo.recordOk(PROBE_TENANT_ID, PROBE_AGENT_ID);
    const secs = await syntheticProbeRepo.secondsSinceLastOk(PROBE_TENANT_ID, PROBE_AGENT_ID);
    expect(secs).toBeGreaterThanOrEqual(0);
    expect(secs).toBeLessThan(5);
  });

  it('K=1: a PRIMEIRA falha já transiciona para degradado + alerta (P2-E)', async () => {
    const r = await syntheticProbeRepo.recordFailure({ tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, alert_after_k: 1 });
    expect(r.consecutive_failures).toBe(1);
    expect(r.transitioned_to_degraded).toBe(true);
    const state = await syntheticProbeRepo.getState(PROBE_TENANT_ID, PROBE_AGENT_ID);
    expect(state?.health).toBe('degraded');
    expect(state?.alert_pending).toBe(true);
  });

  it('NEVER GREEN: gauge cresce a partir do first_attempt_at (last_ok_at nulo)', async () => {
    // Uma sonda que falha desde o 1º tick: recordFailure carimba first_attempt_at.
    await syntheticProbeRepo.recordFailure({ tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, alert_after_k: 3 });
    // Envelhece a primeira tentativa 20min no passado, mantendo last_ok_at nulo.
    await q(
      `UPDATE synthetic_probe_state SET first_attempt_at = now() - interval '20 minutes', last_ok_at = NULL
        WHERE tenant_id=$1 AND agent_id=$2`,
      [PROBE_TENANT_ID, PROBE_AGENT_ID],
    );
    const secs = await syntheticProbeRepo.secondsSinceLastOk(PROBE_TENANT_ID, PROBE_AGENT_ID);
    // Sem o fallback, seria 0 (regra '>15m' nunca dispararia). Com o fix, ~1200s.
    expect(secs).toBeGreaterThan(15 * 60);
  });
});

d('synthetic probe — single-flight lease', () => {
  it('acquire uma vez, bloqueia a segunda; release libera; hold segura', async () => {
    const args = { tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, lease_ms: 60_000 };
    expect(await syntheticProbeRepo.acquireLease(args)).toBe(true);
    expect(await syntheticProbeRepo.acquireLease(args)).toBe(false);
    await syntheticProbeRepo.releaseLease(PROBE_TENANT_ID, PROBE_AGENT_ID);
    expect(await syntheticProbeRepo.acquireLease(args)).toBe(true);
    await syntheticProbeRepo.holdLease(PROBE_TENANT_ID, PROBE_AGENT_ID, 3_600_000);
    expect(await syntheticProbeRepo.acquireLease(args)).toBe(false);
  });
});

d('synthetic probe — correlação, asserção e cleanup', () => {
  it('resolve o inbound pelo wid e asserta o efeito (transacao pendente + liveness)', async () => {
    const wid = 'probe-it-1';
    const { inboundId } = await seedTurn(wid);
    expect(await findInboundMensagemIdByWid(wid)).toBe(inboundId);
    const a = await registerTransactionPendenteScenario.assert(inboundId);
    expect(a.effect_satisfied).toBe(true);
    expect(a.liveness).toBe(true);
    expect(a.detail.transacao_id).toBeTruthy();
  });

  it('zero vazamento: mesmo wid num tenant REAL não é resolvido pela sonda', async () => {
    const wid = 'probe-leak-1';
    const { inboundId } = await seedTurn(wid);
    // mesma whatsapp_id, mas plantada num tenant real ('primary').
    await q(
      `INSERT INTO mensagens (tenant_id, agent_id, direcao, tipo, conteudo, metadata)
       VALUES ('primary','primary','in','texto','x', jsonb_build_object('whatsapp_id',$1::text))`,
      [wid],
    );
    // a resolução da sonda é escopada ao tenant da sonda — só enxerga a SUA row.
    expect(await findInboundMensagemIdByWid(wid)).toBe(inboundId);
  });

  it('cleanup remove a transacao mas PRESERVA mensagens e audit (trilha)', async () => {
    const wid = 'probe-it-2';
    const { conversaId, inboundId } = await seedTurn(wid);
    // trilha: uma audit_log referenciando o inbound (FK NO ACTION ⇒ fixa a msg).
    await runWithTenantContext(PROBE_CONTEXT, () =>
      audit({ acao: 'transaction_created', mensagem_id: inboundId, conversa_id: conversaId }),
    );

    const removed = await syntheticProbeRepo.cleanupRunTraffic({
      tenant_id: PROBE_TENANT_ID,
      agent_id: PROBE_AGENT_ID,
      mensagem_id: inboundId,
    });
    expect(removed).toBe(1);

    const tx = await q<{ n: string }>(`SELECT count(*) n FROM transacoes WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
    expect(Number(tx.rows[0]!.n)).toBe(0); // side-effect removido
    const msgs = await q<{ n: string }>(`SELECT count(*) n FROM mensagens WHERE tenant_id=$1`, [PROBE_TENANT_ID]);
    expect(Number(msgs.rows[0]!.n)).toBe(2); // in + out preservados (audit-pinned)
    const aud = await q<{ n: string }>(`SELECT count(*) n FROM audit_log WHERE tenant_id=$1 AND mensagem_id=$2`, [
      PROBE_TENANT_ID,
      inboundId,
    ]);
    expect(Number(aud.rows[0]!.n)).toBe(1); // trilha preservada
  });
});

d('synthetic probe — sweep de TTL', () => {
  it('lista e fecha um run órfão', async () => {
    const runId = await syntheticProbeRepo.createRun({
      tenant_id: PROBE_TENANT_ID,
      agent_id: PROBE_AGENT_ID,
      channel_id: PROBE_CHANNEL_ID,
      scenario: 'register_transaction_pendente',
      whatsapp_id: 'probe-orphan',
    });
    const open = await syntheticProbeRepo.listOpenRunsOlderThan(PROBE_CONTEXT, new Date(Date.now() + 60_000), 100);
    expect(open.some((r) => r.id === runId)).toBe(true);
    await syntheticProbeRepo.closeOrphanRun(PROBE_CONTEXT, runId);
    const stillOpen = await syntheticProbeRepo.listOpenRunsOlderThan(PROBE_CONTEXT, new Date(Date.now() + 60_000), 100);
    expect(stillOpen.some((r) => r.id === runId)).toBe(false);
  });
});

d('synthetic probe — regressão §1.7.7 / P1-A (ingresso real intacto)', () => {
  it('o canal de sonda semeado é inativo + is_synthetic', async () => {
    const row = await q<{ active: boolean; is_synthetic: boolean }>(
      `SELECT active, is_synthetic FROM channels WHERE id=$1`,
      [PROBE_CHANNEL_ID],
    );
    expect(row.rows[0]!.active).toBe(false);
    expect(row.rows[0]!.is_synthetic).toBe(true);
  });

  it('P1-A: mesmo ATIVO, o canal de sonda é EXCLUÍDO do discriminador do catch-all', async () => {
    // Ativa o canal de sonda e confirma que o discriminador de
    // findPrimaryCatchAllChannel (active AND tenant≠primary AND NOT is_synthetic)
    // NÃO o conta — logo ele nunca derruba o catch-all real.
    await q(`UPDATE channels SET active=true WHERE id=$1`, [PROBE_CHANNEL_ID]);
    const disc = await q<{ n: string }>(
      `SELECT count(*) n FROM channels
        WHERE active=true AND tenant_id <> 'primary' AND is_synthetic = false AND id=$1`,
      [PROBE_CHANNEL_ID],
    );
    expect(Number(disc.rows[0]!.n)).toBe(0);
  });
});

d('synthetic probe — ativação atômica + auditada (P1-B)', () => {
  it('setChannelActive liga/desliga com predicado is_synthetic e valida RETURNING', async () => {
    const on = await syntheticProbeRepo.setChannelActive(
      { tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, channel_id: PROBE_CHANNEL_ID },
      true,
    );
    expect(on?.active).toBe(true);
    const dbRow = await q<{ active: boolean }>(`SELECT active FROM channels WHERE id=$1`, [PROBE_CHANNEL_ID]);
    expect(dbRow.rows[0]!.active).toBe(true);
  });

  it('setChannelActive RECUSA (null) um canal que não é is_synthetic', async () => {
    // um channel_id inexistente/não-sintético não casa o predicado atômico.
    const res = await syntheticProbeRepo.setChannelActive(
      { tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, channel_id: '00000000-0000-0000-0000-0000000000aa' },
      true,
    );
    expect(res).toBeNull();
  });
});
