import { describe, it, expect, vi } from 'vitest';
import nodePath from 'node:path';
import {
  planExportSweep,
  readExportArtifact,
  runExportSweep,
  holdClassesForExport,
  type ExpiredExportCandidate,
  type ExportSweepPorts,
} from '../../../src/ops/privacy/export-sweeper.js';
import type { HoldRecord } from '../../../src/ops/retention/legal-hold.js';

/**
 * Issue #536 — o varredor do TTL do export.
 *
 * O FAKE É ADVERSARIAL, e cada peça dele existe por um defeito conhecido:
 *
 *  - o disco pode ter um SYMLINK ou um HARD LINK no lugar do `.enc`, porque
 *    esses são os dois jeitos de o caminho não ser o arquivo que o banco diz
 *    que é;
 *  - `remove` pode MENTIR (dizer que apagou e deixar o arquivo), que foi
 *    exatamente a falha que a rodada 1 da #520 pegou na retenção de artefatos;
 *  - a leitura de holds pode ser INDISPONÍVEL, e não apenas vazia — "não sei se
 *    há hold" e "não há hold" são coisas diferentes;
 *  - o `finalize` pode CAIR depois de o arquivo já ter sido apagado, que é o
 *    estado intermediário que a ordem escolhida (apagar → marcar) precisa
 *    saber retomar.
 *
 * O FAKE NÃO REIMPLEMENTA O VARREDOR. Ele é só um armazém: um mapa de linhas e
 * um mapa de arquivos. Toda a decisão — plano, hold, guarda, ordem, contagem —
 * vem de `runExportSweep`, do módulo de produção. Um harness que reconstruísse
 * a lógica passaria mesmo com o call site de produção apagado.
 */

const ROOT = '/srv/backups/privacy-export';
const NOW = new Date('2026-08-24T12:00:00.000Z');
const EXPIRED = new Date('2026-08-10T00:00:00.000Z');
const FUTURE = new Date('2026-09-30T00:00:00.000Z');
const LOC_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const LOC_B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

interface Row {
  request_id: string;
  tenant_id: string;
  agent_id: string;
  subject_ref: string;
  locator: string | null;
  expires_at: Date | null;
  purged_at: Date | null;
  purge_started_at: Date | null;
}

interface FileNode {
  symlink?: boolean;
  dir?: boolean;
  nlink?: number;
}

function row(over: Partial<Row> = {}): Row {
  return {
    request_id: 'req-1',
    tenant_id: 'primary',
    agent_id: 'primary',
    subject_ref: 'subj-hash-1',
    locator: LOC_A,
    expires_at: EXPIRED,
    purged_at: null,
    purge_started_at: null,
    ...over,
  };
}

function hold(over: Partial<HoldRecord> = {}): HoldRecord {
  return {
    id: 'hold-1',
    tenant_id: 'primary',
    agent_id: 'primary',
    data_class: '*',
    subject_ref: null,
    status: 'active',
    effective_from: new Date('2026-01-01T00:00:00.000Z'),
    effective_until: null,
    reason_code: 'litigation',
    ...over,
  };
}

function world(opts: {
  rows?: Row[];
  files?: Record<string, FileNode>;
  holds?: readonly HoldRecord[] | null;
  lyingRemove?: boolean;
  finalizeThrowsOn?: string;
  listThrows?: boolean;
  bindingOverride?: (id: string) => { locator: string } | null | undefined;
} = {}) {
  const rows = new Map((opts.rows ?? [row()]).map((r) => [r.request_id, { ...r }]));
  const files = new Map<string, FileNode>(
    Object.entries(
      opts.files ?? { [nodePath.join(ROOT, `${LOC_A}.enc`)]: {} },
    ),
  );
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const removed: string[] = [];

  const ports: ExportSweepPorts = {
    now: () => NOW,
    exportRoot: () => ROOT,
    listCandidates: vi.fn(async (limit: number) => {
      if (opts.listThrows) throw new Error('db down');
      return [...rows.values()]
        .filter((r) => r.locator !== null && r.purged_at === null)
        .sort((a, b) => (a.expires_at?.getTime() ?? 0) - (b.expires_at?.getTime() ?? 0))
        .slice(0, limit)
        .map(
          (r): ExpiredExportCandidate => ({
            request_id: r.request_id,
            tenant_id: r.tenant_id,
            agent_id: r.agent_id,
            subject_ref: r.subject_ref,
            locator: r.locator as string,
            expires_at: r.expires_at,
            purged_at: r.purged_at,
          }),
        );
    }),
    listHolds: vi.fn(async () => (opts.holds === undefined ? [] : opts.holds)),
    readBinding: vi.fn(async (id: string) => {
      const override = opts.bindingOverride?.(id);
      if (override === null) return null;
      const r = rows.get(id);
      if (!r || r.locator === null) return null;
      return {
        request_id: r.request_id,
        tenant_id: r.tenant_id,
        agent_id: r.agent_id,
        locator: override?.locator ?? r.locator,
      };
    }),
    claim: vi.fn(async (id: string, at: Date) => {
      const r = rows.get(id);
      if (r && r.purged_at === null) r.purge_started_at = at;
    }),
    probe: {
      realpath: async (p: string) => {
        if (p === ROOT) return ROOT;
        if (files.has(p)) return p;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      lstat: async (p: string) => {
        const f = files.get(p);
        if (!f) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return {
          isSymbolicLink: () => f.symlink === true,
          isFile: () => f.dir !== true && f.symlink !== true,
          nlink: f.nlink ?? 1,
        };
      },
    },
    remove: vi.fn(async (p: string) => {
      removed.push(p);
      // `force: true` no adapter real — ausência é sucesso, nunca erro.
      if (!opts.lyingRemove) files.delete(p);
    }),
    confirmRemoved: vi.fn(async (p: string) => !files.has(p)),
    finalize: vi.fn(async (record) => {
      if (opts.finalizeThrowsOn === record.request_id) {
        throw new Error('process died before commit');
      }
      const r = rows.get(record.request_id);
      // A transição de VENCEDOR ÚNICO do repositório real
      // (`UPDATE … WHERE export_purged_at IS NULL RETURNING id`): quem não
      // ganha não audita.
      if (!r || r.purged_at !== null) return false;
      r.purged_at = record.purged_at;
      audits.push({
        action: 'privacy_export_purged',
        metadata: {
          privacy_request_id: record.request_id,
          export_locator: record.locator,
          already_absent: record.already_absent,
        },
      });
      return true;
    }),
    recordRefusal: vi.fn(async (record) => {
      audits.push({
        action: 'privacy_export_purge_refused',
        metadata: { privacy_request_id: record.request_id, reason: record.reason },
      });
    }),
    log: (event, detail) => logs.push({ event, detail }),
  };

  return { ports, rows, files, audits, logs, removed };
}

const OPTS = { dryRun: false, correlationId: 'corr-1', limit: 100 };

describe('planExportSweep — a decisão pura', () => {
  const c = (over: Partial<ExpiredExportCandidate> = {}): ExpiredExportCandidate => ({
    request_id: 'req-1',
    tenant_id: 'primary',
    agent_id: 'primary',
    subject_ref: 's',
    locator: LOC_A,
    expires_at: EXPIRED,
    purged_at: null,
    ...over,
  });

  it('apaga o que venceu', () => {
    expect(planExportSweep([c()], NOW, () => false)[0].decision).toEqual({
      action: 'delete',
      reason: 'expired',
    });
  });

  it('mantém o que ainda não venceu', () => {
    expect(
      planExportSweep([c({ expires_at: FUTURE })], NOW, () => false)[0].decision,
    ).toEqual({ action: 'keep', reason: 'not_expired' });
  });

  it('mantém o que já foi varrido — a segunda passagem não repete trabalho', () => {
    expect(planExportSweep([c({ purged_at: NOW })], NOW, () => false)[0].decision).toEqual({
      action: 'keep',
      reason: 'already_purged',
    });
  });

  /**
   * Locator sem prazo viola o CHECK da migration 102 — é uma linha que não
   * deveria existir. NÃO é apagada por precaução: um artefato cujo prazo
   * ninguém consegue provar que venceu não pode ser destruído com base num
   * palpite.
   */
  it('mantém locator sem prazo em vez de apagar por precaução', () => {
    expect(planExportSweep([c({ expires_at: null })], NOW, () => false)[0].decision).toEqual({
      action: 'keep',
      reason: 'no_expiry_set',
    });
  });

  /**
   * Hold vence o prazo, e vem ANTES dele na decisão: o operador que lê a razão
   * precisa ver `legal_hold` e não `not_expired` num artefato congelado.
   */
  it('hold vence o vencimento, e o motivo registrado é o hold', () => {
    expect(planExportSweep([c()], NOW, () => true)[0].decision).toEqual({
      action: 'keep',
      reason: 'legal_hold',
    });
    expect(
      planExportSweep([c({ expires_at: FUTURE })], NOW, () => true)[0].decision,
    ).toEqual({ action: 'keep', reason: 'legal_hold' });
  });
});

describe('holdClassesForExport', () => {
  /**
   * Um hold sobre as MENSAGENS do titular alcança o pacote que as empacotou: a
   * cópia entregue é material responsivo tanto quanto a origem.
   */
  it('cobre a classe do artefato e as classes que o pacote empacota', () => {
    const classes = holdClassesForExport();
    expect(classes).toContain('privacy.export');
    expect(classes).toContain('postgres.messages');
    expect(classes).toContain('postgres.people');
    expect(new Set(classes).size).toBe(classes.length);
  });
});

describe('runExportSweep — o guarda ANTES da remoção', () => {
  /**
   * A SONDA DE PATH, na forma mais forte possível: a prova não é que a
   * varredura devolveu um erro — é que `remove` NÃO FOI CHAMADO. Com a
   * validação neutralizada, este teste falha porque o locator com traversal
   * chega à chamada de remoção.
   */
  it('um locator com traversal NÃO ALCANÇA a chamada de remoção', async () => {
    const w = world({
      rows: [row({ locator: '../../etc/passwd' })],
      files: {},
    });
    const out = await runExportSweep(w.ports, OPTS);

    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(w.removed).toEqual([]);
    expect(out.refused).toBe(1);
    expect(out.purged).toBe(0);
    expect(out.status).toBe('failed');
    expect(out.error_code).toBe('locator_refused');
    expect(w.audits).toEqual([
      {
        action: 'privacy_export_purge_refused',
        metadata: { privacy_request_id: 'req-1', reason: 'path_separator' },
      },
    ]);
    // E o pedido NÃO é marcado como varrido — nada foi removido.
    expect(w.rows.get('req-1')?.purged_at).toBeNull();
    /**
     * Nem como "em varredura". O claim vem DEPOIS do guarda de propósito: ele
     * significa "estávamos prestes a remover". Marcado antes, toda recusa
     * apareceria na consulta de plantão que existe para achar processo morto
     * no meio de um passe — dois diagnósticos opostos no mesmo predicado.
     */
    expect(w.rows.get('req-1')?.purge_started_at).toBeNull();
    expect(w.ports.claim).not.toHaveBeenCalled();
  });

  it('um symlink no lugar do artefato NÃO ALCANÇA a remoção', async () => {
    const w = world({ files: { [nodePath.join(ROOT, `${LOC_A}.enc`)]: { symlink: true } } });
    const out = await runExportSweep(w.ports, OPTS);
    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(out.refused).toBe(1);
    expect(w.audits[0].metadata.reason).toBe('symlink');
  });

  it('um artefato com outro hard link NÃO ALCANÇA a remoção', async () => {
    const w = world({ files: { [nodePath.join(ROOT, `${LOC_A}.enc`)]: { nlink: 3 } } });
    const out = await runExportSweep(w.ports, OPTS);
    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(out.refused).toBe(1);
    expect(w.audits[0].metadata.reason).toBe('multiply_linked');
  });

  /**
   * A releitura do binding: entre planejar e apagar, outro processo reemitiu o
   * export. Apagar o arquivo do PLANO destruiria um artefato vivo enquanto o
   * pedido acha que ele existe.
   */
  it('locator que não corresponde mais ao pedido NÃO ALCANÇA a remoção', async () => {
    const w = world({ bindingOverride: () => ({ locator: LOC_B }) });
    const out = await runExportSweep(w.ports, OPTS);
    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(out.refused).toBe(1);
    expect(w.audits[0].metadata.reason).toBe('locator_not_bound_to_request');
  });

  it('pedido que sumiu entre planejar e apagar NÃO ALCANÇA a remoção', async () => {
    const w = world({ bindingOverride: () => null });
    const out = await runExportSweep(w.ports, OPTS);
    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(w.audits[0].metadata.reason).toBe('request_vanished');
  });

  it('uma recusa não impede o próximo artefato de ser varrido', async () => {
    const w = world({
      rows: [
        row({ request_id: 'req-mau', locator: '../../etc/passwd', expires_at: EXPIRED }),
        row({
          request_id: 'req-bom',
          locator: LOC_B,
          expires_at: new Date('2026-08-11T00:00:00.000Z'),
        }),
      ],
      files: { [nodePath.join(ROOT, `${LOC_B}.enc`)]: {} },
    });
    const out = await runExportSweep(w.ports, OPTS);
    expect(out.refused).toBe(1);
    expect(out.purged).toBe(1);
    // Recusou UM e apagou o outro ⇒ o passe não é `completed`, é `partial`.
    expect(out.status).toBe('partial');
    expect(w.removed).toEqual([nodePath.join(ROOT, `${LOC_B}.enc`)]);
  });
});

describe('runExportSweep — legal hold', () => {
  /**
   * A SONDA DE HOLD: com a checagem removida, o artefato congelado é varrido.
   * A prova é a mesma forma da sonda de path — `remove` não é alcançado.
   */
  it('um artefato sob hold NÃO É VARRIDO', async () => {
    const w = world({ holds: [hold()] });
    const out = await runExportSweep(w.ports, OPTS);

    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(w.files.has(nodePath.join(ROOT, `${LOC_A}.enc`))).toBe(true);
    expect(out.skipped_held).toBe(1);
    expect(out.eligible).toBe(0);
    expect(out.purged).toBe(0);
    expect(out.status).toBe('completed');
    expect(w.rows.get('req-1')?.purged_at).toBeNull();
  });

  it('um hold sobre as MENSAGENS do titular congela o pacote que as empacotou', async () => {
    const w = world({
      holds: [hold({ data_class: 'postgres.messages', subject_ref: 'subj-hash-1' })],
    });
    const out = await runExportSweep(w.ports, OPTS);
    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(out.skipped_held).toBe(1);
  });

  it('um hold de OUTRO titular não congela este artefato', async () => {
    const w = world({
      holds: [hold({ data_class: 'postgres.messages', subject_ref: 'outro-titular' })],
    });
    const out = await runExportSweep(w.ports, OPTS);
    expect(out.skipped_held).toBe(0);
    expect(out.purged).toBe(1);
  });

  it('um hold de OUTRO tenant não congela este artefato', async () => {
    const w = world({ holds: [hold({ tenant_id: 'outro' })] });
    const out = await runExportSweep(w.ports, OPTS);
    expect(out.skipped_held).toBe(0);
    expect(out.purged).toBe(1);
  });

  it('um hold já liberado não congela nada', async () => {
    const w = world({
      holds: [hold({ status: 'released', effective_until: new Date('2026-08-01') })],
    });
    expect((await runExportSweep(w.ports, OPTS)).purged).toBe(1);
  });

  /**
   * "Não sei se há hold" NUNCA vira "não há hold". O passe inteiro reprova, e
   * nada é apagado — nem os artefatos de escopos cujos holds foram lidos.
   */
  it('hold ILEGÍVEL reprova o passe inteiro e não apaga nada', async () => {
    const w = world({ holds: null });
    const out = await runExportSweep(w.ports, OPTS);

    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(out.status).toBe('failed');
    expect(out.error_code).toBe('legal_hold_unavailable');
    expect(out.purged).toBe(0);
    expect(w.logs.some((l) => l.event === 'privacy.export_sweep_hold_unavailable')).toBe(true);
  });

  it('o log do hold carrega ids, nunca o reason_code (que pode ser sensível)', async () => {
    const w = world({ holds: [hold({ reason_code: 'processo-sigiloso-12345' })] });
    await runExportSweep(w.ports, OPTS);
    const held = w.logs.find((l) => l.event === 'privacy.export_sweep_held');
    expect(held?.detail.hold_ids).toEqual(['hold-1']);
    expect(JSON.stringify(w.logs)).not.toContain('processo-sigiloso');
  });
});

describe('runExportSweep — idempotência', () => {
  /**
   * A SONDA DE IDEMPOTÊNCIA. Rodar duas vezes não pode falhar nem duplicar
   * auditoria. Com a ordem invertida (marcar antes de apagar, sem
   * reconciliação) ou com a marcação incondicional, este teste fica vermelho.
   */
  it('duas execuções seguidas: uma remoção, UMA linha de auditoria', async () => {
    const w = world();

    const first = await runExportSweep(w.ports, OPTS);
    expect(first.purged).toBe(1);
    expect(first.status).toBe('completed');
    expect(w.files.size).toBe(0);

    const second = await runExportSweep(w.ports, OPTS);
    expect(second.status).toBe('completed');
    expect(second.scanned).toBe(0);
    expect(second.purged).toBe(0);

    expect(w.audits.filter((a) => a.action === 'privacy_export_purged')).toHaveLength(1);
  });

  /**
   * A QUEDA NO MEIO. `finalize` explode DEPOIS de o arquivo já ter sido
   * apagado — o estado intermediário que a ordem apagar→marcar produz.
   *
   * A execução seguinte tem que TERMINAR o serviço: reencontrar o pedido (ele
   * ainda não está marcado), provar o caminho, ver que o arquivo já não está lá
   * (`already_absent`), e marcar. Uma linha de auditoria, nenhuma falha.
   *
   * Com a ordem invertida, este cenário deixaria o pedido dizendo "artefato
   * removido" com o `.enc` vivo — e o teste do arquivo abaixo falharia.
   */
  it('queda entre apagar e marcar: a execução seguinte conclui, sem duplicar', async () => {
    const w = world({ finalizeThrowsOn: 'req-1' });

    const first = await runExportSweep(w.ports, OPTS);
    expect(first.failed).toBe(1);
    expect(first.purged).toBe(0);
    expect(first.status).toBe('failed');
    // O arquivo JÁ FOI. O pedido ainda NÃO está marcado — é isso que o torna
    // recuperável.
    expect(w.files.size).toBe(0);
    expect(w.rows.get('req-1')?.purged_at).toBeNull();
    // E o carimbo de "começou" ficou, que é como o operador enxerga o passe caído.
    expect(w.rows.get('req-1')?.purge_started_at).toEqual(NOW);

    // Segunda execução com `finalize` de novo funcionando.
    const w2 = world({
      rows: [{ ...(w.rows.get('req-1') as Row) }],
      files: {},
    });
    const second = await runExportSweep(w2.ports, OPTS);
    expect(second.purged).toBe(1);
    expect(second.already_absent).toBe(1);
    expect(second.status).toBe('completed');
    expect(w2.audits.filter((a) => a.action === 'privacy_export_purged')).toHaveLength(1);
    expect(w2.audits[0].metadata.already_absent).toBe(true);
  });

  /**
   * A corrida: outro passe ganhou a transição entre a remoção e a marcação.
   * O perdedor NÃO conta e NÃO audita — é o `RETURNING` do UPDATE condicional
   * que decide, e não um `if` no varredor.
   */
  it('quem perde a transição não conta nem audita', async () => {
    const w = world();
    // Marca a linha "por fora", como se outro passe tivesse concluído primeiro.
    const original = w.ports.finalize;
    w.ports.finalize = vi.fn(async (record) => {
      const r = w.rows.get(record.request_id);
      if (r) r.purged_at = new Date('2026-08-24T11:59:00.000Z');
      return original(record);
    });

    const out = await runExportSweep(w.ports, OPTS);
    expect(out.purged).toBe(0);
    expect(out.status).toBe('completed');
    expect(w.audits).toHaveLength(0);
    expect(w.logs.some((l) => l.event === 'privacy.export_sweep_already_finalized')).toBe(true);
  });

  /**
   * Uma remoção que MENTE (disse que apagou, o arquivo continua lá) NÃO pode
   * marcar o pedido como varrido. Foi este defeito — delete não confirmado
   * contado como sucesso — que a rodada 1 da #520 encontrou na retenção.
   */
  it('remoção não confirmada NÃO marca o pedido e reprova o passe', async () => {
    const w = world({ lyingRemove: true });
    const out = await runExportSweep(w.ports, OPTS);

    expect(w.ports.remove).toHaveBeenCalledTimes(1);
    expect(out.purged).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.status).toBe('failed');
    expect(w.rows.get('req-1')?.purged_at).toBeNull();
    expect(w.audits.some((a) => a.action === 'privacy_export_purged')).toBe(false);
    expect(w.audits.some((a) => a.metadata.reason === 'delete_unconfirmed')).toBe(true);
  });
});

describe('runExportSweep — dry-run e desfecho', () => {
  it('dry-run conta e não toca em nada', async () => {
    const w = world();
    const out = await runExportSweep(w.ports, { ...OPTS, dryRun: true });
    expect(out.eligible).toBe(1);
    expect(out.purged).toBe(0);
    expect(w.ports.remove).not.toHaveBeenCalled();
    expect(w.ports.finalize).not.toHaveBeenCalled();
    expect(w.files.size).toBe(1);
  });

  it('listagem que falha reprova o passe sem apagar nada', async () => {
    const w = world({ listThrows: true });
    const out = await runExportSweep(w.ports, OPTS);
    expect(out.status).toBe('failed');
    expect(out.error_code).toBe('candidate_listing_failed');
    expect(w.ports.remove).not.toHaveBeenCalled();
  });

  it('nada a fazer é `completed` com zeros', async () => {
    const w = world({ rows: [], files: {} });
    const out = await runExportSweep(w.ports, OPTS);
    expect(out).toMatchObject({ status: 'completed', scanned: 0, purged: 0 });
    expect(w.ports.listHolds).not.toHaveBeenCalled();
  });

  it('o audit da remoção nomeia pedido, locator e resultado', async () => {
    const w = world();
    await runExportSweep(w.ports, OPTS);
    expect(w.audits[0]).toEqual({
      action: 'privacy_export_purged',
      metadata: {
        privacy_request_id: 'req-1',
        export_locator: LOC_A,
        already_absent: false,
      },
    });
  });
});

/**
 * A LEITURA DO PEDIDO — o quarto item da entrega.
 *
 * Sem isto, um pedido varrido continuaria devolvendo `export_locator` e
 * apontando para um arquivo que não existe mais.
 */
describe('readExportArtifact — o pedido indica ARTEFATO EXPIRADO', () => {
  it('pedido sem export', () => {
    expect(
      readExportArtifact(
        { export_locator: null, export_expires_at: null, export_purged_at: null },
        NOW,
      ),
    ).toMatchObject({ state: 'none', locator: null });
  });

  it('export vivo devolve o locator', () => {
    expect(
      readExportArtifact(
        { export_locator: LOC_A, export_expires_at: FUTURE, export_purged_at: null },
        NOW,
      ),
    ).toMatchObject({ state: 'available', locator: LOC_A });
  });

  /**
   * Entre o vencimento e a passagem do varredor o arquivo AINDA EXISTE.
   * Devolver o locator nessa janela furaria o próprio TTL.
   */
  it('vencido mas ainda não varrido: `expired`, e o locator NÃO é entregue', () => {
    expect(
      readExportArtifact(
        { export_locator: LOC_A, export_expires_at: EXPIRED, export_purged_at: null },
        NOW,
      ),
    ).toMatchObject({ state: 'expired', locator: null });
  });

  it('locator sem prazo é tratado como expirado — fail-closed', () => {
    expect(
      readExportArtifact(
        { export_locator: LOC_A, export_expires_at: null, export_purged_at: null },
        NOW,
      ),
    ).toMatchObject({ state: 'expired', locator: null });
  });

  it('varrido: `purged`, com o instante da remoção e sem locator', () => {
    const purgedAt = new Date('2026-08-24T11:00:00.000Z');
    expect(
      readExportArtifact(
        { export_locator: LOC_A, export_expires_at: EXPIRED, export_purged_at: purgedAt },
        NOW,
      ),
    ).toEqual({
      state: 'purged',
      locator: null,
      expires_at: EXPIRED,
      purged_at: purgedAt,
    });
  });

  /**
   * A SONDA DE MARCAÇÃO, ancorada de ponta a ponta: depois de um passe REAL do
   * varredor sobre a linha REAL do armazém, a leitura tem que dizer `purged` e
   * não pode devolver o locator. Remover a marcação em `runExportSweep` (ou
   * fazer `readExportArtifact` ignorar `export_purged_at`) deixa esta
   * expectativa vermelha, porque a leitura volta a apontar para um arquivo que
   * o próprio passe apagou.
   */
  it('depois do varredor, a leitura da linha NÃO aponta mais para o arquivo', async () => {
    const w = world();
    const before = readExportArtifact(
      {
        export_locator: w.rows.get('req-1')?.locator ?? null,
        export_expires_at: w.rows.get('req-1')?.expires_at ?? null,
        export_purged_at: w.rows.get('req-1')?.purged_at ?? null,
      },
      NOW,
    );
    expect(before.state).toBe('expired');

    await runExportSweep(w.ports, OPTS);

    const r = w.rows.get('req-1') as Row;
    // O arquivo realmente sumiu do disco…
    expect(w.files.size).toBe(0);
    // …e a leitura do pedido diz isso, em vez de continuar oferecendo o locator.
    const after = readExportArtifact(
      {
        export_locator: r.locator,
        export_expires_at: r.expires_at,
        export_purged_at: r.purged_at,
      },
      NOW,
    );
    expect(after.state).toBe('purged');
    expect(after.locator).toBeNull();
    expect(after.purged_at).toEqual(NOW);
  });
});
