/**
 * Sonda sintética (spec §3, aceite unit) — lógica pura + orquestração do tick +
 * sink de outbound, sem DB/rede (deps injetadas). Cobre:
 *   - buildSyntheticMessage / classifyOutcome (ok/slow/wrong/silent);
 *   - sink: intercepta SÓ com (armado + triplete de sonda), devolve wid
 *     sintético e NÃO chama primitiva de envio; fora disso, caminho normal;
 *   - runProbeTick: guard de pré-requisito (shadow ⇒ no-op+audit), classificação,
 *     transição de health + alerta na transição, cleanup só no sucesso, judge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock das primitivas de envio ANTES de importar line-output (para provar que o
// sink não as chama). `vi.hoisted` porque a factory do vi.mock é içada ao topo.
const h = vi.hoisted(() => ({ sendOutboundText: vi.fn(async () => 'real-text-wid') }));
vi.mock('@/gateway/baileys.js', () => ({
  sendOutboundText: h.sendOutboundText,
  sendOutboundDocument: vi.fn(async () => 'real-doc-wid'),
  sendOutboundVoice: vi.fn(async () => 'real-voice-wid'),
  isBaileysConnected: () => true,
}));
vi.mock('@/gateway/presence.js', () => ({
  markRead: vi.fn(),
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(),
  sendPoll: vi.fn(async () => ({ whatsapp_id: 'real-poll', message_secret: null, creator_jid: null })),
}));
vi.mock('@/gateway/line-session-manager.js', () => ({
  getLineSessionManager: () => ({
    isEnabled: () => false,
    transportFor: vi.fn(),
    isLineConnected: () => true,
  }),
}));

import { buildSyntheticMessage, classifyOutcome, runProbeTick, type ProbeTickDeps } from '@/probe/probe.js';
import { PROBE_SCOPE, PROBE_CLIENT_TEL, isProbeScope } from '@/probe/constants.js';
import { _setProbeSinkArmedForTests } from '@/probe/sink-guard.js';
import { _buildOutputForTests } from '@/gateway/line-output.js';

describe('buildSyntheticMessage', () => {
  it('monta um IWebMessageInfo mínimo com id estável e texto do cenário', () => {
    const msg = buildSyntheticMessage('registre X', 'wid-123', 1_700_000_000_000);
    expect(msg.key?.id).toBe('wid-123');
    expect(msg.key?.fromMe).toBe(false);
    expect(msg.key?.remoteJid).toContain(PROBE_CLIENT_TEL.replace('+', ''));
    expect(msg.message?.conversation).toBe('registre X');
    expect(msg.messageTimestamp).toBe(Math.floor(1_700_000_000_000 / 1000));
  });
});

describe('classifyOutcome', () => {
  it('ok quando efeito satisfeito dentro do SLO_warn', () => {
    expect(classifyOutcome({ effectSatisfied: true, liveness: true, elapsedMs: 1000, slowMs: 2000 })).toBe('ok');
  });
  it('slow quando efeito satisfeito mas acima do SLO_warn', () => {
    expect(classifyOutcome({ effectSatisfied: true, liveness: true, elapsedMs: 3000, slowMs: 2000 })).toBe('slow');
  });
  it('wrong quando respondeu (liveness) mas sem efeito', () => {
    expect(classifyOutcome({ effectSatisfied: false, liveness: true, elapsedMs: 5000, slowMs: 2000 })).toBe('wrong');
  });
  it('silent quando nem respondeu', () => {
    expect(classifyOutcome({ effectSatisfied: false, liveness: false, elapsedMs: 5000, slowMs: 2000 })).toBe('silent');
  });
});

describe('outbound sink (buildOutput)', () => {
  beforeEach(() => {
    h.sendOutboundText.mockClear();
    _setProbeSinkArmedForTests(false);
  });

  it('isProbeScope casa só o triplete completo', () => {
    expect(isProbeScope(PROBE_SCOPE)).toBe(true);
    expect(isProbeScope({ ...PROBE_SCOPE, channel_id: 'outro' })).toBe(false);
    expect(isProbeScope({ ...PROBE_SCOPE, tenant_id: 'primary' })).toBe(false);
  });

  it('ARMADO + triplete de sonda ⇒ sink: wid sintético, NENHUMA primitiva chamada', async () => {
    _setProbeSinkArmedForTests(true);
    const out = _buildOutputForTests({ ...PROBE_SCOPE });
    const wid = await out.sendText('jid', 'oi');
    expect(wid).toMatch(/^synthetic-/);
    expect(out.isConnected()).toBe(true);
    expect(h.sendOutboundText).not.toHaveBeenCalled();
  });

  it('ARMADO + escopo NÃO-sonda ⇒ caminho normal (primitiva chamada)', async () => {
    _setProbeSinkArmedForTests(true);
    const out = _buildOutputForTests({ tenant_id: 'primary', agent_id: 'primary', channel_id: 'c-real' });
    const wid = await out.sendText('jid', 'oi');
    expect(wid).toBe('real-text-wid');
    expect(h.sendOutboundText).toHaveBeenCalledOnce();
  });

  it('DESARMADO + triplete de sonda ⇒ caminho normal (sink inerte)', async () => {
    _setProbeSinkArmedForTests(false);
    const out = _buildOutputForTests({ ...PROBE_SCOPE });
    const wid = await out.sendText('jid', 'oi');
    expect(wid).toBe('real-text-wid');
    expect(h.sendOutboundText).toHaveBeenCalledOnce();
  });
});

// ── runProbeTick ────────────────────────────────────────────────────────────

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    createRun: vi.fn(async () => 'run-1'),
    setRunMensagemId: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    cleanupRunTraffic: vi.fn(async () => 1),
    recordOk: vi.fn(async () => ({ recovered: false })),
    recordFailure: vi.fn(async () => ({ consecutive_failures: 1, transitioned_to_degraded: false })),
    recordAlertAttempt: vi.fn(async () => undefined),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<ProbeTickDeps> = {}): ProbeTickDeps {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    routingMode: 'exact_first',
    scenario: {
      id: 'register_transaction_pendente',
      prompt: 'registre despesa pendente de 50',
      intent: 'registrar despesa pendente',
      assert: vi.fn(async () => ({ effect_satisfied: true, liveness: true, detail: { transacao_id: 't-1' } })),
    },
    ingress: vi.fn(async () => 'handled' as const),
    resolveInboundId: vi.fn(async () => 'm-1'),
    latestReplyText: vi.fn(async () => 'ok, registrei'),
    repo: fakeRepo() as unknown as ProbeTickDeps['repo'],
    judge: { enabled: false, run: vi.fn(async () => ({ pass: true, reason: '' })) },
    audit: vi.fn(async () => undefined),
    metrics: { inc: vi.fn(), observe: vi.fn() },
    deliverAlert: vi.fn(async () => true),
    sloMs: 5000,
    slowMs: 2000,
    alertAfterK: 3,
    pollIntervalMs: 1000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('runProbeTick', () => {
  it('shadow ⇒ fail-closed: audit prereq_unmet, NÃO injeta, status prereq_unmet', async () => {
    const deps = baseDeps({ routingMode: 'shadow' });
    const res = await runProbeTick(deps);
    expect(res.status).toBe('prereq_unmet');
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'synthetic_probe_prereq_unmet' }),
    );
    expect(deps.ingress).not.toHaveBeenCalled();
  });

  it('happy path ⇒ ok: cleanup + recordOk + completeRun terminal', async () => {
    const repo = fakeRepo();
    const deps = baseDeps({ repo: repo as unknown as ProbeTickDeps['repo'] });
    const res = await runProbeTick(deps);
    expect(res.outcome).toBe('ok');
    expect(deps.ingress).toHaveBeenCalledOnce();
    expect(repo.cleanupRunTraffic).toHaveBeenCalledWith(expect.objectContaining({ mensagem_id: 'm-1' }));
    expect(repo.recordOk).toHaveBeenCalled();
    expect(repo.completeRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ terminal: true, outcome: 'ok' }));
    expect(deps.metrics.inc).toHaveBeenCalledWith('synthetic_probe_runs_total', { outcome: 'ok' });
  });

  it('efeito ausente + liveness ⇒ wrong: recordFailure, NÃO terminal, NÃO cleanup', async () => {
    const repo = fakeRepo();
    const deps = baseDeps({
      repo: repo as unknown as ProbeTickDeps['repo'],
      scenario: {
        id: 's',
        prompt: 'p',
        intent: 'i',
        assert: vi.fn(async () => ({ effect_satisfied: false, liveness: true, detail: {} })),
      },
    });
    const res = await runProbeTick(deps);
    expect(res.outcome).toBe('wrong');
    expect(repo.recordFailure).toHaveBeenCalled();
    expect(repo.cleanupRunTraffic).not.toHaveBeenCalled();
    expect(repo.completeRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ terminal: false, outcome: 'wrong' }));
  });

  it('sem resposta até o SLO ⇒ silent', async () => {
    const deps = baseDeps({
      scenario: {
        id: 's',
        prompt: 'p',
        intent: 'i',
        assert: vi.fn(async () => ({ effect_satisfied: false, liveness: false, detail: {} })),
      },
    });
    const res = await runProbeTick(deps);
    expect(res.outcome).toBe('silent');
  });

  it('efeito satisfeito tarde ⇒ slow', async () => {
    let calls = 0;
    const deps = baseDeps({
      slowMs: 2000,
      scenario: {
        id: 's',
        prompt: 'p',
        intent: 'i',
        assert: vi.fn(async () => {
          calls++;
          return calls >= 4
            ? { effect_satisfied: true, liveness: true, detail: {} }
            : { effect_satisfied: false, liveness: false, detail: {} };
        }),
      },
    });
    const res = await runProbeTick(deps);
    expect(res.outcome).toBe('slow');
  });

  it('transição saudável→degradado ⇒ deliverAlert + recordAlertAttempt', async () => {
    const repo = fakeRepo({
      recordFailure: vi.fn(async () => ({ consecutive_failures: 3, transitioned_to_degraded: true })),
    });
    const deps = baseDeps({
      repo: repo as unknown as ProbeTickDeps['repo'],
      scenario: {
        id: 's',
        prompt: 'p',
        intent: 'i',
        assert: vi.fn(async () => ({ effect_satisfied: false, liveness: false, detail: {} })),
      },
    });
    const res = await runProbeTick(deps);
    expect(res.outcome).toBe('silent');
    expect(res.consecutiveFailures).toBe(3);
    expect(deps.deliverAlert).toHaveBeenCalledOnce();
    expect(repo.recordAlertAttempt).toHaveBeenCalledWith(expect.objectContaining({ delivered: true }));
  });

  it('judge habilitado ⇒ consulta a resposta e julga (quando há liveness)', async () => {
    const judgeRun = vi.fn(async () => ({ pass: true, reason: 'ok' }));
    const deps = baseDeps({ judge: { enabled: true, run: judgeRun } });
    await runProbeTick(deps);
    expect(deps.latestReplyText).toHaveBeenCalledWith('m-1');
    expect(judgeRun).toHaveBeenCalledOnce();
  });

  it('ingress não-handled ⇒ error', async () => {
    const deps = baseDeps({ ingress: vi.fn(async () => 'dropped' as const) });
    const res = await runProbeTick(deps);
    expect(res.status).toBe('ingress_failed');
    expect(res.outcome).toBe('error');
  });
});
