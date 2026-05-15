/**
 * P4 Task 9 — drift decision engine tests.
 *
 * Mocka `operationalProfileVersionsRepo.transition` e `driftAlertsRepo.create`
 * via @/db/repositories.js para validar:
 *  - Classificação determinística por (drift_type, payload) sem LLM.
 *  - Mapeamento severity → decision.
 *  - Alert criado para TODA evidência (independente da decisão).
 *  - Frozen/rollback invocam o transition; baixo/medio não.
 *  - Falhas no transition setam applied=false + applied_error mas não
 *    interrompem o loop nem impedem o alert.
 *  - Falhas no create do alert são reportadas via applied_error, sem afetar
 *    as evidências subsequentes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';
import type { DriftEvidence } from '@/cognition/drift/types.js';

const { transitionMock, createAlertMock } = vi.hoisted(() => ({
  transitionMock: vi.fn(),
  createAlertMock: vi.fn(),
}));

vi.mock('@/db/repositories.js', () => ({
  operationalProfileVersionsRepo: {
    transition: transitionMock,
  },
  driftAlertsRepo: {
    create: createAlertMock,
  },
}));

import { decideAndApply, classifySeverity } from '@/cognition/drift/decision-engine.js';

function makeEvidence(
  drift_type: DriftType,
  payload: Record<string, unknown>,
  summary = 'summary stub',
): DriftEvidence {
  return {
    drift_type,
    detected_by: `drift_detector_${drift_type}`,
    payload,
    evidence_summary: summary,
  };
}

const PROFILE_ID = 'prof-active-1';

function defaultAlertMockImpl() {
  createAlertMock.mockImplementation(async (input: { drift_type: string }) => ({
    id: `alert-${input.drift_type}-${Math.random().toString(36).slice(2)}`,
  }));
}

function transitionOk() {
  transitionMock.mockImplementation(async () => ({
    ok: true,
    updated: { id: PROFILE_ID, status: 'frozen' },
  }));
}

describe('classifySeverity (deterministic, per type)', () => {
  it('TOM: 1 example → baixo, 2 → medio, 3+ → alto (without hint)', () => {
    expect(
      classifySeverity(makeEvidence(DriftType.TOM, { examples: ['a'] })),
    ).toBe(DriftSeverity.BAIXO);
    expect(
      classifySeverity(makeEvidence(DriftType.TOM, { examples: ['a', 'b'] })),
    ).toBe(DriftSeverity.MEDIO);
    expect(
      classifySeverity(makeEvidence(DriftType.TOM, { examples: ['a', 'b', 'c'] })),
    ).toBe(DriftSeverity.ALTO);
  });

  it('VALORES: violated_principles → ALTO mesmo sem hint; hint critico promove', () => {
    expect(
      classifySeverity(
        makeEvidence(DriftType.VALORES, { violated_principles: [0] }),
      ),
    ).toBe(DriftSeverity.ALTO);
    expect(
      classifySeverity(
        makeEvidence(DriftType.VALORES, {
          violated_principles: [0, 1],
          severity_hint: 'critico',
        }),
      ),
    ).toBe(DriftSeverity.CRITICO);
  });

  it('CONFIANCA: max_gap thresholds (deterministico)', () => {
    expect(
      classifySeverity(makeEvidence(DriftType.CONFIANCA, { max_gap: 0.1 })),
    ).toBe(DriftSeverity.BAIXO);
    expect(
      classifySeverity(makeEvidence(DriftType.CONFIANCA, { max_gap: 0.35 })),
    ).toBe(DriftSeverity.MEDIO);
    expect(
      classifySeverity(makeEvidence(DriftType.CONFIANCA, { max_gap: 0.55 })),
    ).toBe(DriftSeverity.ALTO);
    expect(
      classifySeverity(makeEvidence(DriftType.CONFIANCA, { max_gap: 0.8 })),
    ).toBe(DriftSeverity.CRITICO);
  });

  it('LINGUAGEM: offensive=true → critico independente de hint', () => {
    expect(
      classifySeverity(
        makeEvidence(DriftType.LINGUAGEM, {
          offensive: true,
          severity_hint: 'baixo',
        }),
      ),
    ).toBe(DriftSeverity.CRITICO);
    expect(
      classifySeverity(makeEvidence(DriftType.LINGUAGEM, { offensive: false })),
    ).toBe(DriftSeverity.BAIXO);
  });

  it('Unknown drift_type: hint válido → hint; senão baixo', () => {
    const ev: DriftEvidence = {
      drift_type: 'inexistente' as DriftType,
      detected_by: 'x',
      payload: { severity_hint: 'medio' },
      evidence_summary: '',
    };
    expect(classifySeverity(ev)).toBe(DriftSeverity.MEDIO);
    const ev2: DriftEvidence = {
      drift_type: 'inexistente' as DriftType,
      detected_by: 'x',
      payload: { severity_hint: 'invalid-value' },
      evidence_summary: '',
    };
    expect(classifySeverity(ev2)).toBe(DriftSeverity.BAIXO);
  });
});

describe('decideAndApply', () => {
  beforeEach(() => {
    transitionMock.mockReset();
    createAlertMock.mockReset();
    defaultAlertMockImpl();
  });

  it('baixo (TOM, examples.length=1) → auto_approved, applied=false, alert criado, sem chamar transition', async () => {
    const ev = makeEvidence(DriftType.TOM, { examples: ['x'] }, 'um exemplo');
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe(DriftSeverity.BAIXO);
    expect(out[0]!.decision).toBe(DriftDecision.AUTO_APPROVED);
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toBeUndefined();
    expect(out[0]!.alert_id).toMatch(/^alert-/);

    expect(transitionMock).not.toHaveBeenCalled();
    expect(createAlertMock).toHaveBeenCalledTimes(1);
    const alertArgs = createAlertMock.mock.calls[0]![0];
    expect(alertArgs.profile_version_id).toBe(PROFILE_ID);
    expect(alertArgs.drift_type).toBe(DriftType.TOM);
    expect(alertArgs.severity).toBe(DriftSeverity.BAIXO);
    expect(alertArgs.decision).toBe(DriftDecision.AUTO_APPROVED);
    expect(alertArgs.decided_by).toBe('decision_engine');
    expect(alertArgs.evidence).toMatchObject({
      examples: ['x'],
      summary: 'um exemplo',
    });
  });

  it('medio (TOM, examples.length=2) → queued_human, applied=false, alert criado, sem transition', async () => {
    const ev = makeEvidence(DriftType.TOM, { examples: ['a', 'b'] });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(out[0]!.severity).toBe(DriftSeverity.MEDIO);
    expect(out[0]!.decision).toBe(DriftDecision.QUEUED_HUMAN);
    expect(out[0]!.applied).toBe(false);
    expect(transitionMock).not.toHaveBeenCalled();
    expect(createAlertMock).toHaveBeenCalledTimes(1);
  });

  it('alto (TOM, examples.length=3, hint=alto) → frozen, applied=true, alert criado', async () => {
    transitionOk();
    const ev = makeEvidence(DriftType.TOM, {
      examples: ['a', 'b', 'c'],
      severity_hint: 'alto',
    });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(out[0]!.severity).toBe(DriftSeverity.ALTO);
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
    expect(out[0]!.applied).toBe(true);
    expect(out[0]!.applied_error).toBeUndefined();

    expect(transitionMock).toHaveBeenCalledTimes(1);
    const transArgs = transitionMock.mock.calls[0]![0];
    expect(transArgs.id).toBe(PROFILE_ID);
    expect(transArgs.to).toBe('frozen');
    expect(transArgs.approved_by).toBe('auto:drift_alto');
    expect(transArgs.rollback_reason).toBeUndefined();

    expect(createAlertMock).toHaveBeenCalledTimes(1);
    expect(createAlertMock.mock.calls[0]![0].decision).toBe(DriftDecision.FROZEN);
  });

  it('critico (LINGUAGEM, offensive=true) → rollback, applied=true, alert tem decision=rollback', async () => {
    transitionOk();
    const ev = makeEvidence(
      DriftType.LINGUAGEM,
      { offensive: true },
      'mensagem ofensiva detectada',
    );
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(out[0]!.severity).toBe(DriftSeverity.CRITICO);
    expect(out[0]!.decision).toBe(DriftDecision.ROLLBACK);
    expect(out[0]!.applied).toBe(true);

    expect(transitionMock).toHaveBeenCalledTimes(1);
    const transArgs = transitionMock.mock.calls[0]![0];
    expect(transArgs.to).toBe('rolled_back');
    expect(transArgs.rollback_reason).toBe('mensagem ofensiva detectada');
    expect(transArgs.approved_by).toBe('auto:drift_critico');

    expect(createAlertMock.mock.calls[0]![0].decision).toBe(
      DriftDecision.ROLLBACK,
    );
  });

  it('CONFIANCA max_gap=0.8 → critico → rollback', async () => {
    transitionOk();
    const ev = makeEvidence(DriftType.CONFIANCA, { max_gap: 0.8 });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(out[0]!.severity).toBe(DriftSeverity.CRITICO);
    expect(out[0]!.decision).toBe(DriftDecision.ROLLBACK);
    expect(transitionMock.mock.calls[0]![0].to).toBe('rolled_back');
  });

  it('VALORES violated_principles=[0] → alto → frozen', async () => {
    transitionOk();
    const ev = makeEvidence(DriftType.VALORES, { violated_principles: [0] });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(out[0]!.severity).toBe(DriftSeverity.ALTO);
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
    expect(transitionMock.mock.calls[0]![0].to).toBe('frozen');
  });

  it('ESCOPO unfulfillable_promises=[a,b,c,d] → critico → rollback', async () => {
    transitionOk();
    const ev = makeEvidence(DriftType.ESCOPO, {
      unfulfillable_promises: ['a', 'b', 'c', 'd'],
    });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(out[0]!.severity).toBe(DriftSeverity.CRITICO);
    expect(out[0]!.decision).toBe(DriftDecision.ROLLBACK);
  });

  it('PROCEDIMENTO count=2 any_active=true → alto → frozen', async () => {
    transitionOk();
    const ev = makeEvidence(DriftType.PROCEDIMENTO, {
      count: 2,
      any_active: true,
    });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(out[0]!.severity).toBe(DriftSeverity.ALTO);
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
  });

  it('transition retorna invalid_transition → applied=false + applied_error="invalid_transition", alert ainda criado', async () => {
    transitionMock.mockResolvedValue({ ok: false, reason: 'invalid_transition' });
    const ev = makeEvidence(DriftType.VALORES, { violated_principles: [0] });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });

    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toBe('invalid_transition');
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
    expect(createAlertMock).toHaveBeenCalledTimes(1);
    expect(out[0]!.alert_id).toMatch(/^alert-/);
  });

  it('múltiplas evidências sequenciais: alto seguido de medio — primeiro freeze + alert, segundo só alert', async () => {
    transitionOk();
    const ev1 = makeEvidence(DriftType.TOM, {
      examples: ['a', 'b', 'c'],
      severity_hint: 'alto',
    });
    const ev2 = makeEvidence(DriftType.TOM, { examples: ['x', 'y'] });
    const out = await decideAndApply({
      evidences: [ev1, ev2],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(2);
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
    expect(out[0]!.applied).toBe(true);
    expect(out[1]!.decision).toBe(DriftDecision.QUEUED_HUMAN);
    expect(out[1]!.applied).toBe(false);

    // transition chamado uma vez (apenas pelo alto)
    expect(transitionMock).toHaveBeenCalledTimes(1);
    // alert criado para AMBOS
    expect(createAlertMock).toHaveBeenCalledTimes(2);
  });

  it('severity baixo NÃO chama repo.transition (verificado via mock counter)', async () => {
    const ev = makeEvidence(DriftType.LINGUAGEM, { offensive: false });
    await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });
    expect(transitionMock).toHaveBeenCalledTimes(0);
  });

  it('driftAlertsRepo.create lança erro → applied_error inclui "alert_persist_failed", próximas evidências continuam', async () => {
    transitionOk();
    createAlertMock.mockImplementationOnce(async () => {
      throw new Error('db unavailable');
    });
    createAlertMock.mockImplementationOnce(async () => ({
      id: 'alert-second-ok',
    }));

    const ev1 = makeEvidence(DriftType.TOM, { examples: ['a'] });
    const ev2 = makeEvidence(DriftType.LINGUAGEM, { offensive: false });
    const out = await decideAndApply({
      evidences: [ev1, ev2],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(2);
    expect(out[0]!.applied_error).toContain('alert_persist_failed');
    expect(out[0]!.applied_error).toContain('db unavailable');
    expect(out[0]!.alert_id).toBeUndefined();

    // Segunda evidência foi processada normalmente
    expect(out[1]!.applied_error).toBeUndefined();
    expect(out[1]!.alert_id).toBe('alert-second-ok');
  });

  it('transition LANÇA erro (não retorna ok:false) → applied=false, applied_error tem a mensagem, alert ainda criado', async () => {
    transitionMock.mockRejectedValueOnce(new Error('db timeout'));
    const ev = makeEvidence(DriftType.VALORES, { violated_principles: [0] });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });

    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toBe('db timeout');
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
    expect(createAlertMock).toHaveBeenCalledTimes(1);
  });
});
