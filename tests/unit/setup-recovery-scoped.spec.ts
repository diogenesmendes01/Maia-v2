/**
 * Auditoria P0 cap. 7 — recovery POR ALVO sobre o layout multi-linha:
 *
 *   <BAILEYS_AUTH_DIR>/
 *     control/setup-token.txt · primary/ · lines/<id>/ · pairing/<id>/
 *
 *  - recovery da PRIMÁRIA remove APENAS primary/ (+ entradas legadas soltas
 *    na raiz) — sentinelas provam que lines/, pairing/, control/ e um dir
 *    FORA da raiz sobrevivem (o bug original: rm recursivo da raiz inteira
 *    destruía as credenciais de todas as linhas, os pareamentos e o token);
 *  - recovery de uma LINHA desativa o canal (fail-closed) e remove apenas
 *    lines/<id> — token NÃO rotaciona;
 *  - channelId com traversal ('../evil', 'a/b') é rejeitado sem NENHUM
 *    efeito colateral;
 *  - single-flight é POR ALVO: o mesmo alvo converge para uma execução;
 *    alvos distintos correm independentes.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { ROOT, OUTSIDE, auditMock, auditContexts, sendAlertMock, rotateTokenMock, deactivateMock } =
  vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    const root = path.join(os.tmpdir(), 'maia-baileys-recovery-scoped-' + Date.now());
    return {
      ROOT: root,
      OUTSIDE: root + '-outside',
      auditMock: vi.fn(async () => undefined),
      auditContexts: [] as Array<{ tenant_id: string; agent_id: string } | null>,
      sendAlertMock: vi.fn(async () => undefined),
      rotateTokenMock: vi.fn(async () => 'new-token'),
      deactivateMock: vi.fn(async () => ({ rowCount: 1 })),
    };
  });

vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: ROOT },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('../../src/setup/token.js', () => ({ rotateToken: rotateTokenMock }));
vi.mock('../../src/db/tenant-context.js', () => ({
  runWithTenantContext: vi.fn(
    async (ctx: { tenant_id: string; agent_id: string }, fn: () => Promise<unknown>) => {
      auditContexts.push(ctx);
      return fn();
    },
  ),
  tryGetCurrentContext: () => null,
}));
vi.mock('../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { deactivate: deactivateMock },
}));

import { triggerRecovery, _internal } from '../../src/setup/recovery.js';

const LINE_A = 'ch-line-aaaa';
const LINE_B = 'ch-line-bbbb';
const PAIR_C = 'ch-pair-cccc';
const PAIR_D = 'ch-pair-dddd';

const CHANNEL_A = {
  id: LINE_A,
  tenant_id: 'tenant-x',
  agent_id: 'agent-x',
  external_id: '+5511900002222',
};

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Árvore completa do layout novo + sentinela FORA da raiz. */
async function buildTree(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await rm(OUTSIDE, { recursive: true, force: true });
  await mkdir(join(ROOT, 'primary'), { recursive: true });
  await writeFile(join(ROOT, 'primary', 'creds.json'), '{"me":{"id":"primary"}}');
  for (const ch of [LINE_A, LINE_B]) {
    await mkdir(join(ROOT, 'lines', ch), { recursive: true });
    await writeFile(join(ROOT, 'lines', ch, 'creds.json'), `{"me":{"id":"${ch}"}}`);
  }
  for (const ch of [PAIR_C, PAIR_D]) {
    await mkdir(join(ROOT, 'pairing', ch), { recursive: true });
    await writeFile(join(ROOT, 'pairing', ch, 'creds.json'), `{"me":{"id":"${ch}"}}`);
  }
  await mkdir(join(ROOT, 'control'), { recursive: true });
  await writeFile(join(ROOT, 'control', 'setup-token.txt'), 'sentinel-token\n');
  await mkdir(OUTSIDE, { recursive: true });
  await writeFile(join(OUTSIDE, 'sentinel.txt'), 'outside\n');
}

/** Sentinelas que NENHUM recovery pode tocar. */
async function expectSharedSurvivors(): Promise<void> {
  expect(await exists(join(ROOT, 'lines', LINE_B, 'creds.json'))).toBe(true);
  expect(await exists(join(ROOT, 'pairing', PAIR_C, 'creds.json'))).toBe(true);
  expect(await exists(join(ROOT, 'pairing', PAIR_D, 'creds.json'))).toBe(true);
  expect((await readFile(join(ROOT, 'control', 'setup-token.txt'), 'utf-8')).trim()).toBe(
    'sentinel-token',
  );
  expect(await exists(join(OUTSIDE, 'sentinel.txt'))).toBe(true);
}

beforeEach(async () => {
  vi.clearAllMocks();
  deactivateMock.mockResolvedValue({ rowCount: 1 });
  auditContexts.length = 0;
  _internal.reset();
  await buildTree();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(OUTSIDE, { recursive: true, force: true });
});

describe('recovery da PRIMÁRIA — escopo primary/ apenas', () => {
  it('remove SÓ primary/ — lines/, pairing/, control/ e fora-da-raiz intactos', async () => {
    const shutdownBaileys = vi.fn().mockResolvedValue(undefined);
    const startBaileys = vi.fn().mockResolvedValue(undefined);

    await triggerRecovery({ target: 'primary', line: '+5511900001111', shutdownBaileys, startBaileys });

    expect(await exists(join(ROOT, 'primary'))).toBe(false);
    await expectSharedSurvivors();
    expect(await exists(join(ROOT, 'lines', LINE_A, 'creds.json'))).toBe(true);

    // Semânticas preservadas do fluxo original: token rotaciona, alerta sai,
    // sequência shutdown → start, audits started/completed com o alvo.
    expect(rotateTokenMock).toHaveBeenCalledTimes(1);
    expect(shutdownBaileys).toHaveBeenCalledTimes(1);
    expect(startBaileys).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'pairing_recovery_started',
      metadata: { target: 'primary' },
    });
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'pairing_recovery_completed',
      metadata: { target: 'primary' },
    });
    // Alerta nomeia a linha afetada e o NOVO caminho do token (control/).
    const alertBody = (sendAlertMock.mock.calls[0]![0] as { body: string }).body;
    expect(alertBody).toContain('+5511900001111');
    expect(alertBody).toContain(`${ROOT}/control/setup-token.txt`);
  });

  it('varre entradas de sessão LEGADAS soltas na raiz (migração falha) sem tocar as reservadas', async () => {
    // Boot em fallback legado: sessão vive na raiz.
    await writeFile(join(ROOT, 'creds.json'), '{"me":{"id":"legacy"}}');
    await mkdir(join(ROOT, 'app-state-sync'), { recursive: true });
    await writeFile(join(ROOT, 'app-state-sync', 'k.json'), '{}');

    await triggerRecovery({
      target: 'primary',
      shutdownBaileys: vi.fn().mockResolvedValue(undefined),
      startBaileys: vi.fn().mockResolvedValue(undefined),
    });

    expect(await exists(join(ROOT, 'creds.json'))).toBe(false);
    expect(await exists(join(ROOT, 'app-state-sync'))).toBe(false);
    await expectSharedSurvivors();
    expect(await exists(join(ROOT, 'lines', LINE_A, 'creds.json'))).toBe(true);
  });
});

describe('recovery de LINHA adicional — escopo lines/<id> apenas', () => {
  it('desativa o canal (ALS do dono), remove SÓ lines/<id> e NÃO rotaciona token', async () => {
    await triggerRecovery({ target: 'line', channel: CHANNEL_A });

    // Só o auth da linha A morre; primária e o resto sobrevivem.
    expect(await exists(join(ROOT, 'lines', LINE_A))).toBe(false);
    expect(await exists(join(ROOT, 'primary', 'creds.json'))).toBe(true);
    await expectSharedSurvivors();

    // Persistência fail-closed: deactivate chamado sob o ALS do dono.
    expect(deactivateMock).toHaveBeenCalledTimes(1);
    expect(deactivateMock).toHaveBeenCalledWith(LINE_A);
    expect(auditContexts).toContainEqual({ tenant_id: 'tenant-x', agent_id: 'agent-x' });

    // Token da /setup NÃO rotaciona no loggedOut de uma linha.
    expect(rotateTokenMock).not.toHaveBeenCalled();

    // Audits com o alvo = channelId.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'pairing_recovery_started',
        metadata: expect.objectContaining({ target: LINE_A }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'pairing_recovery_completed',
        metadata: expect.objectContaining({ target: LINE_A }),
      }),
    );

    // Alerta nomeia a linha afetada.
    const alertBody = (sendAlertMock.mock.calls[0]![0] as { body: string }).body;
    expect(alertBody).toContain('+5511900002222');
    expect(alertBody).toContain(LINE_A);
  });

  it.each([['../evil'], ['a/b'], ['..'], ['']])(
    'rejeita channelId hostil %j sem NENHUM efeito colateral',
    async (evilId) => {
      await expect(
        triggerRecovery({
          target: 'line',
          channel: { ...CHANNEL_A, id: evilId },
        }),
      ).rejects.toMatchObject({ code: 'auth_dir_escape' });

      // Nada removido, nada desativado.
      expect(deactivateMock).not.toHaveBeenCalled();
      expect(await exists(join(ROOT, 'primary', 'creds.json'))).toBe(true);
      expect(await exists(join(ROOT, 'lines', LINE_A, 'creds.json'))).toBe(true);
      await expectSharedSurvivors();
    },
  );
});

describe('single-flight POR ALVO', () => {
  it('o MESMO alvo converge para uma única execução (mesma promise)', async () => {
    let release: (() => void) | undefined;
    deactivateMock.mockImplementationOnce(
      () =>
        new Promise<{ rowCount: number }>((res) => {
          release = () => res({ rowCount: 1 });
        }),
    );

    const p1 = triggerRecovery({ target: 'line', channel: CHANNEL_A });
    const p2 = triggerRecovery({ target: 'line', channel: CHANNEL_A });
    expect(p1).toBe(p2);
    expect(_internal.isRecovering(`line:${LINE_A}`)).toBe(true);

    // O deactivate roda alguns microtasks depois (imports dinâmicos + audit
    // started) — espera o deferred ficar pendurado antes de liberar.
    await vi.waitFor(() => {
      if (!release) throw new Error('deactivate ainda não foi alcançado');
    });
    release!();
    await p1;
    expect(deactivateMock).toHaveBeenCalledTimes(1);
    expect(_internal.isRecovering()).toBe(false);
  });

  it('alvos DIFERENTES correm independentes (linha completa com a primária presa)', async () => {
    let releasePrimary!: () => void;
    const shutdownBaileys = vi.fn(
      () =>
        new Promise<void>((res) => {
          releasePrimary = res;
        }),
    );
    const startBaileys = vi.fn().mockResolvedValue(undefined);

    const primaryRun = triggerRecovery({ target: 'primary', shutdownBaileys, startBaileys });
    expect(_internal.isRecovering('primary')).toBe(true);

    // A recovery da linha NÃO espera a da primária.
    await triggerRecovery({ target: 'line', channel: CHANNEL_A });
    expect(await exists(join(ROOT, 'lines', LINE_A))).toBe(false);
    expect(_internal.isRecovering('primary')).toBe(true);

    releasePrimary();
    await primaryRun;
    expect(_internal.isRecovering()).toBe(false);
  });

  it('linhas DIFERENTES não compartilham o lock', async () => {
    const CHANNEL_B = { ...CHANNEL_A, id: LINE_B, external_id: '+5511900003333' };
    const pA = triggerRecovery({ target: 'line', channel: CHANNEL_A });
    const pB = triggerRecovery({ target: 'line', channel: CHANNEL_B });
    expect(pA).not.toBe(pB);
    await Promise.all([pA, pB]);
    expect(await exists(join(ROOT, 'lines', LINE_A))).toBe(false);
    expect(await exists(join(ROOT, 'lines', LINE_B))).toBe(false);
    expect(deactivateMock).toHaveBeenCalledTimes(2);
  });
});
