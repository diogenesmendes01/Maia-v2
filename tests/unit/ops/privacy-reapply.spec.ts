import { describe, it, expect } from 'vitest';
import { reapplyTombstones, type ReapplyPorts } from '../../../src/ops/privacy/reapply.js';
import {
  planReconciliation,
  signTombstone,
  type TombstoneRecord,
} from '../../../src/ops/retention/tombstones.js';
import type { PurgeJob } from '../../../src/ops/privacy/execution.js';

/**
 * Issue #536 §3 — a reaplicação de tombstones depois de um restore.
 *
 * O que estes testes fixam é a diferença entre AVALIAR e EXECUTAR. Antes desta
 * fatia, `planReconciliation` e `canReleaseTraffic` existiam e eram testados,
 * mas nenhum processo os executava: o runbook mandava um humano reaplicar as
 * exclusões no passo 3.6. A proteção contra ressurreição de dado dependia de
 * alguém lembrar, exatamente no dia em que se acabou de perder o banco.
 *
 * A propriedade mais importante aqui: `canReleaseTraffic` recebe o que foi
 * CONFIRMADO, nunca a lista de pendentes. Um executor que passasse
 * `plan.pending.map(t => t.id)` liberaria o tráfego sempre — e é uma linha de
 * código de distância.
 */

const SECRET = 'k1';

function tombstone(over: Partial<TombstoneRecord> = {}): TombstoneRecord {
  const body = {
    id: 'ts-a',
    tenant_id: 't1',
    agent_id: 'a1',
    data_class: 'postgres.messages',
    subject_ref: 'subj-a',
    resource_locator: null,
    action: 'delete' as const,
    effective_at: new Date('2026-08-20T00:00:00.000Z'),
    origin: 'privacy_request' as const,
    version: 1,
    ...over,
  };
  return { ...body, hmac: signTombstone(body, SECRET), hmac_key_version: 1 };
}

interface Rec {
  ports: ReapplyPorts;
  purged: PurgeJob[];
  reconciled: string[];
  audits: { action: string; metadata: Record<string, unknown> }[];
}

function recorder(over: Partial<ReapplyPorts> = {}): Rec {
  const r: Rec = { purged: [], reconciled: [], audits: [], ports: null as unknown as ReapplyPorts };
  r.ports = {
    purge: async (job) => {
      r.purged.push(job);
      return 2;
    },
    markReconciled: async (id) => {
      r.reconciled.push(id);
    },
    audit: async (action, metadata) => {
      r.audits.push({ action, metadata });
    },
    now: () => new Date('2026-08-24T12:00:00.000Z'),
    ...over,
  };
  return r;
}

/** Snapshot velho: watermark anterior às exclusões ⇒ há o que reaplicar. */
function pendingPlan(tombstones: TombstoneRecord[]) {
  return planReconciliation({
    watermark: new Date('2026-08-01T00:00:00.000Z'),
    ledger_available: true,
    tombstones,
    secret: SECRET,
  });
}

describe('reaplicação — o caminho feliz fecha a cadeia', () => {
  it('reaplica cada tombstone pendente e libera o tráfego', async () => {
    const r = recorder();
    const plan = pendingPlan([tombstone(), tombstone({ id: 'ts-b', data_class: 'postgres.memory' })]);
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });

    expect(out.release).toBe(true);
    expect(out.reason).toBe('ok');
    expect(out.applied_ids).toEqual(['ts-a', 'ts-b']);
    expect(r.purged.map((p) => p.data_class)).toEqual(['postgres.messages', 'postgres.memory']);
    expect(r.reconciled).toEqual(['ts-a', 'ts-b']);
    expect(r.audits.at(-1)?.action).toBe('post_restore_reconciliation_completed');
  });

  it('usa o mecanismo declarado pela classe — anonimizar não vira apagar', async () => {
    const r = recorder();
    const plan = pendingPlan([tombstone({ data_class: 'postgres.people', action: 'anonymize' })]);
    await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(r.purged[0]?.mechanism).toBe('anonymize');
  });

  it('reaplicar sobre dado que já não existe é no-op e CONTA como aplicado', async () => {
    // É o que permite a `execution.ts` gravar o tombstone antes da purga: um
    // ledger que exagera se auto-corrige aqui, de graça.
    const r = recorder({ purge: async () => 0 });
    const plan = pendingPlan([tombstone()]);
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(out.release).toBe(true);
    expect(out.reapplied['postgres.messages']).toBe(0);
  });

  it('um plano sem pendências libera sem tocar em nada', async () => {
    const r = recorder();
    const plan = planReconciliation({
      // Snapshot MAIS NOVO que a exclusão: não há o que reaplicar.
      watermark: new Date('2026-08-23T00:00:00.000Z'),
      ledger_available: true,
      tombstones: [tombstone()],
      secret: SECRET,
    });
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(out.release).toBe(true);
    expect(r.purged).toEqual([]);
  });
});

describe('reaplicação — o gate recebe o CONFIRMADO, não o pretendido', () => {
  it('um tombstone que falhou bloqueia a liberação', async () => {
    const r = recorder({
      purge: async (job) => {
        if (job.data_class === 'postgres.memory') throw Object.assign(new Error('x'), { code: 'purge_failed' });
        return 1;
      },
    });
    const plan = pendingPlan([tombstone(), tombstone({ id: 'ts-b', data_class: 'postgres.memory' })]);
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });

    expect(out.release).toBe(false);
    expect(out.reason).toBe('tombstones_not_reapplied');
    expect(out.applied_ids).toEqual(['ts-a']);
    expect(out.failed).toEqual([
      { tombstone_id: 'ts-b', data_class: 'postgres.memory', code: 'purge_failed' },
    ]);
  });

  it('uma falha no meio NÃO interrompe os demais — mais dado ressuscitado morre', async () => {
    const r = recorder({
      purge: async (job) => {
        if (job.data_class === 'postgres.memory') throw Object.assign(new Error('x'), { code: 'purge_failed' });
        return 1;
      },
    });
    const plan = pendingPlan([
      tombstone({ id: 'ts-a', effective_at: new Date('2026-08-10T00:00:00.000Z') }),
      tombstone({
        id: 'ts-b',
        data_class: 'postgres.memory',
        effective_at: new Date('2026-08-11T00:00:00.000Z'),
      }),
      tombstone({
        id: 'ts-c',
        data_class: 'postgres.traces',
        effective_at: new Date('2026-08-12T00:00:00.000Z'),
      }),
    ]);
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(out.applied_ids).toEqual(['ts-a', 'ts-c']);
    expect(out.release).toBe(false);
  });

  it('um tombstone sem alvo NÃO vira purga da classe inteira', async () => {
    const r = recorder();
    const plan = pendingPlan([tombstone({ subject_ref: null, resource_locator: null })]);
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(r.purged).toEqual([]);
    expect(out.failed[0]?.code).toBe('tombstone_without_target');
    expect(out.release).toBe(false);
  });
});

describe('reaplicação — o ledger precisa ser INDEPENDENTE do snapshot restaurado', () => {
  /**
   * A armadilha silenciosa: depois do `pg_restore`, `data_tombstones` DENTRO do
   * banco restaurado é a cópia antiga do ledger. Nenhum tombstone dela é mais
   * novo que o watermark do próprio snapshot, então o plano sai `ok: true` com
   * `pending: []` — indistinguível de "não havia nada a reaplicar" — e libera o
   * tráfego com todo o dado que o titular mandou apagar de volta no ar.
   *
   * Nenhuma checagem automática separa as duas leituras: as linhas são as
   * mesmas. Por isso a afirmação é exigida do operador, e a ausência bloqueia.
   */
  it('sem a afirmação de independência, nada roda e o tráfego fica bloqueado', async () => {
    const r = recorder();
    const plan = pendingPlan([tombstone()]);
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: false });
    expect(out.release).toBe(false);
    expect(out.reason).toBe('ledger_not_independent');
    expect(r.purged).toEqual([]);
    expect(r.reconciled).toEqual([]);
  });

  it('o caso PERIGOSO — ledger do próprio snapshot, plano ok e vazio — não libera', async () => {
    const r = recorder();
    // Exatamente o que `planReconciliation` devolve quando se lê o ledger de
    // dentro do banco restaurado: ok, sem pendências, pronto para liberar.
    const plan = planReconciliation({
      watermark: new Date('2026-08-23T00:00:00.000Z'),
      ledger_available: true,
      tombstones: [tombstone()],
      secret: SECRET,
    });
    expect(plan.ok).toBe(true);
    expect(plan.pending).toEqual([]);

    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: false });
    expect(out.release).toBe(false);
    expect(out.reason).toBe('ledger_not_independent');
  });

  it('o bloqueio é auditado como falha de reconciliação, não como sucesso silencioso', async () => {
    const r = recorder();
    await reapplyTombstones(pendingPlan([tombstone()]), r.ports, { ledger_independent: false });
    expect(r.audits).toHaveLength(1);
    expect(r.audits[0]?.action).toBe('post_restore_reconciliation_failed');
    expect(r.audits[0]?.metadata.reason).toBe('ledger_not_independent');
  });
});

describe('reaplicação — falha fechado sem plano confiável', () => {
  it('ledger ilegível: nada é reaplicado e o tráfego fica bloqueado', async () => {
    const r = recorder();
    const plan = planReconciliation({
      watermark: new Date('2026-08-01T00:00:00.000Z'),
      ledger_available: false,
      tombstones: [tombstone()],
      secret: SECRET,
    });
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(out.release).toBe(false);
    expect(out.reason).toBe('ledger_unavailable');
    expect(r.purged).toEqual([]);
    expect(r.audits.at(-1)?.action).toBe('post_restore_reconciliation_failed');
  });

  it('watermark ausente: o artefato antecede o ledger, então não se sabe o que reaplicar', async () => {
    const r = recorder();
    const plan = planReconciliation({
      watermark: null,
      ledger_available: true,
      tombstones: [tombstone()],
      secret: SECRET,
    });
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(out.release).toBe(false);
    expect(out.reason).toBe('watermark_missing');
    expect(r.purged).toEqual([]);
  });

  it('tombstone com HMAC inválido bloqueia — o ledger inteiro deixa de ser confiável', async () => {
    const r = recorder();
    const forged = { ...tombstone({ id: 'ts-forjado' }), hmac: 'deadbeef' };
    const plan = pendingPlan([tombstone(), forged]);
    const out = await reapplyTombstones(plan, r.ports, { ledger_independent: true });
    expect(out.release).toBe(false);
    expect(out.reason).toBe('invalid_tombstone');
    expect(r.purged).toEqual([]);
  });
});
