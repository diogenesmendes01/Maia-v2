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

const { transitionMock, createAlertMock, getActiveContextForAgentMock } = vi.hoisted(() => ({
  transitionMock: vi.fn(),
  createAlertMock: vi.fn(),
  getActiveContextForAgentMock: vi.fn(),
}));

vi.mock('@/db/repositories.js', () => ({
  operationalProfileVersionsRepo: {
    transition: transitionMock,
    getActiveContextForAgent: getActiveContextForAgentMock,
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

  // P8d §7 — papel_drift floor rules (determinísticas)
  it('PAPEL_DRIFT: 1 off_role → BAIXO, 2 → MEDIO, 3 → ALTO, 5+ → CRITICO', () => {
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, { off_role_examples: ['a'] }),
      ),
    ).toBe(DriftSeverity.BAIXO);
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, { off_role_examples: ['a', 'b'] }),
      ),
    ).toBe(DriftSeverity.MEDIO);
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, { off_role_examples: ['a', 'b', 'c'] }),
      ),
    ).toBe(DriftSeverity.ALTO);
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, {
          off_role_examples: ['a', 'b', 'c', 'd', 'e'],
        }),
      ),
    ).toBe(DriftSeverity.CRITICO);
  });

  it('PAPEL_DRIFT: rolesDiverge + 3+ off_role → CRITICO (mesmo abaixo de 5, ambos slugs válidos)', () => {
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, {
          off_role_examples: ['a', 'b', 'c'],
          declared_role: 'atendimento_financeiro_pf',
          observed_role_inferred: 'consultoria_juridica_e_investimentos',
        }),
      ),
    ).toBe(DriftSeverity.CRITICO);
  });

  it('PAPEL_DRIFT: declared_role é prosa (sem slug) + 3 off_role → ALTO (não promove a critico)', () => {
    // Caso real do seed: role_descriptor = core_immutable.identity_block (prosa longa).
    // A divergência de papéis NÃO pode ser detectada se um dos lados não é um slug
    // de papel validado — portanto a promoção a critico não deve acontecer.
    const prosaDeclarada = 'Sou a Maia, assistente financeira inteligente para pessoas físicas e pequenas empresas, especializada em controle de gastos, planejamento orçamentário e análise de fluxo de caixa.';
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, {
          off_role_examples: ['a', 'b', 'c'],
          declared_role: prosaDeclarada,
          observed_role_inferred: 'vendas',
        }),
      ),
    ).toBe(DriftSeverity.ALTO); // 3 off_role → ALTO; rolesDiverge false (prosa não é slug)
  });

  it('PAPEL_DRIFT: observed_role_inferred é prosa + 3 off_role → ALTO (não promove a critico)', () => {
    // observed_role_inferred pode conter texto livre do LLM — também deve bloquear promoção.
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, {
          off_role_examples: ['a', 'b', 'c'],
          declared_role: 'atendimento_financeiro_pf',
          observed_role_inferred: 'Parece que o agente está atuando como consultor jurídico especializado',
        }),
      ),
    ).toBe(DriftSeverity.ALTO); // observed não é slug → rolesDiverge=false → piso ALTO
  });

  it('PAPEL_DRIFT: rolesDiverge mas só 2 off_role → MEDIO (rule não dispara)', () => {
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, {
          off_role_examples: ['a', 'b'],
          declared_role: 'atendimento_financeiro_pf',
          observed_role_inferred: 'consultoria_juridica',
        }),
      ),
    ).toBe(DriftSeverity.MEDIO);
  });

  it('PAPEL_DRIFT: roles compartilham prefixo (não diverge) + 3 off_role → ALTO (não promove)', () => {
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, {
          off_role_examples: ['a', 'b', 'c'],
          declared_role: 'atendimento_financeiro_pf',
          observed_role_inferred: 'atendimento_corporativo',
        }),
      ),
    ).toBe(DriftSeverity.ALTO);
  });

  it('PAPEL_DRIFT: sem off_role + hint → respeita hint', () => {
    expect(
      classifySeverity(
        makeEvidence(DriftType.PAPEL_DRIFT, {
          off_role_examples: [],
          severity_hint: 'medio',
        }),
      ),
    ).toBe(DriftSeverity.MEDIO);
  });

  it('PAPEL_DRIFT: sem off_role nem hint → BAIXO (default)', () => {
    expect(
      classifySeverity(makeEvidence(DriftType.PAPEL_DRIFT, {})),
    ).toBe(DriftSeverity.BAIXO);
  });
});

describe('decideAndApply', () => {
  beforeEach(() => {
    transitionMock.mockReset();
    createAlertMock.mockReset();
    getActiveContextForAgentMock.mockReset();
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

  // ---- Codex Adversarial Review of PR #182 round 2: batch collapse ----
  //
  // The bug: `decideAndApply` processed evidences sequentially and hard-coded
  // `expected_from:'active'` for EVERY profile transition. If an alto froze
  // the row first, a subsequent critico tried `rolled_back` against the
  // already-frozen row with `expected_from='active'` and hit the repository's
  // stale guard. Critical rollback was silently demoted to applied=false and
  // the profile ended frozen instead of rolled_back.
  //
  // Fix: collapse to strongest mutator per active_profile_id per batch.
  // Discarded evidences still persist their alert row (forensic trail) and
  // get `superseded_by` pointing at the winner's alert_id, but they do NOT
  // call `transition` — so the engine can never atropelar itself.

  it('batch collapse: [alto, critico] same profile → rollback aplicado, alto descartado com superseded_by', async () => {
    transitionOk();
    const evAlto = makeEvidence(
      DriftType.VALORES,
      { violated_principles: [0] },
      'alto evidence',
    );
    const evCritico = makeEvidence(
      DriftType.LINGUAGEM,
      { offensive: true },
      'critico evidence',
    );

    const out = await decideAndApply({
      evidences: [evAlto, evCritico],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(2);

    // Ordem de input preservada: alto (índice 0), critico (índice 1).
    const altoResult = out[0]!;
    const criticoResult = out[1]!;

    expect(altoResult.severity).toBe(DriftSeverity.ALTO);
    expect(altoResult.decision).toBe(DriftDecision.FROZEN);
    expect(altoResult.applied).toBe(false); // descartado
    expect(altoResult.applied_error).toBeUndefined();
    expect(altoResult.alert_id).toMatch(/^alert-/); // alert ainda persistido
    expect(altoResult.superseded_by).toBe(criticoResult.alert_id);

    expect(criticoResult.severity).toBe(DriftSeverity.CRITICO);
    expect(criticoResult.decision).toBe(DriftDecision.ROLLBACK);
    expect(criticoResult.applied).toBe(true); // strongest wins
    expect(criticoResult.superseded_by).toBeUndefined();

    // EXATAMENTE 1 transition (rolled_back), não 2.
    expect(transitionMock).toHaveBeenCalledTimes(1);
    const transArgs = transitionMock.mock.calls[0]![0];
    expect(transArgs.to).toBe('rolled_back');
    expect(transArgs.approved_by).toBe('auto:drift_critico');
    expect(transArgs.expected_from).toBe('active');
    expect(transArgs.rollback_reason).toBe('critico evidence');

    // Ambos alerts criados (audit trail preservado).
    expect(createAlertMock).toHaveBeenCalledTimes(2);
  });

  it('batch collapse: [critico, alto] same profile (ordem invertida) → mesmo resultado, rollback aplicado', async () => {
    transitionOk();
    const evCritico = makeEvidence(
      DriftType.LINGUAGEM,
      { offensive: true },
      'critico evidence',
    );
    const evAlto = makeEvidence(
      DriftType.VALORES,
      { violated_principles: [0] },
      'alto evidence',
    );

    const out = await decideAndApply({
      evidences: [evCritico, evAlto],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(2);

    const criticoResult = out[0]!;
    const altoResult = out[1]!;

    expect(criticoResult.severity).toBe(DriftSeverity.CRITICO);
    expect(criticoResult.applied).toBe(true);
    expect(criticoResult.superseded_by).toBeUndefined();

    expect(altoResult.severity).toBe(DriftSeverity.ALTO);
    expect(altoResult.applied).toBe(false);
    expect(altoResult.superseded_by).toBe(criticoResult.alert_id);

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![0].to).toBe('rolled_back');
  });

  it('batch collapse: [alto, alto] same profile → primeiro alto vence (tie-break por índice), segundo descartado', async () => {
    transitionOk();
    const ev1 = makeEvidence(
      DriftType.VALORES,
      { violated_principles: [0] },
      'alto 1',
    );
    const ev2 = makeEvidence(
      DriftType.VALORES,
      { violated_principles: [1, 2] },
      'alto 2',
    );

    const out = await decideAndApply({
      evidences: [ev1, ev2],
      active_profile_id: PROFILE_ID,
    });

    expect(out[0]!.applied).toBe(true);
    expect(out[0]!.superseded_by).toBeUndefined();

    expect(out[1]!.applied).toBe(false);
    expect(out[1]!.superseded_by).toBe(out[0]!.alert_id);

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![0].to).toBe('frozen');
  });

  it('batch collapse: [alto, critico, alto] same profile → critico vence, ambos altos descartados', async () => {
    transitionOk();
    const ev1 = makeEvidence(DriftType.VALORES, { violated_principles: [0] }, 'alto 1');
    const ev2 = makeEvidence(DriftType.LINGUAGEM, { offensive: true }, 'critico');
    const ev3 = makeEvidence(DriftType.VALORES, { violated_principles: [1] }, 'alto 2');

    const out = await decideAndApply({
      evidences: [ev1, ev2, ev3],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(3);
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.superseded_by).toBe(out[1]!.alert_id);
    expect(out[1]!.applied).toBe(true);
    expect(out[1]!.superseded_by).toBeUndefined();
    expect(out[2]!.applied).toBe(false);
    expect(out[2]!.superseded_by).toBe(out[1]!.alert_id);

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(createAlertMock).toHaveBeenCalledTimes(3);
  });

  it('batch collapse: single evidence (alto sozinho) → comportamento atual preservado (applied=true, sem superseded_by)', async () => {
    transitionOk();
    const ev = makeEvidence(DriftType.VALORES, { violated_principles: [0] });
    const out = await decideAndApply({
      evidences: [ev],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
    expect(out[0]!.applied).toBe(true);
    expect(out[0]!.superseded_by).toBeUndefined();
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  it('batch collapse: [baixo, alto, medio] same profile → alto único mutator, aplicado normalmente; baixo/medio não tocam superseded_by', async () => {
    transitionOk();
    const evBaixo = makeEvidence(DriftType.TOM, { examples: ['x'] });
    const evAlto = makeEvidence(DriftType.VALORES, { violated_principles: [0] });
    const evMedio = makeEvidence(DriftType.TOM, { examples: ['a', 'b'] });

    const out = await decideAndApply({
      evidences: [evBaixo, evAlto, evMedio],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(3);
    expect(out[0]!.decision).toBe(DriftDecision.AUTO_APPROVED);
    expect(out[0]!.superseded_by).toBeUndefined(); // baixo nunca é mutator
    expect(out[1]!.decision).toBe(DriftDecision.FROZEN);
    expect(out[1]!.applied).toBe(true);
    expect(out[1]!.superseded_by).toBeUndefined();
    expect(out[2]!.decision).toBe(DriftDecision.QUEUED_HUMAN);
    expect(out[2]!.superseded_by).toBeUndefined(); // medio nunca é mutator

    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  it('batch collapse: soul_drift critico + valores critico → valores vence porque soul nunca é mutator', async () => {
    transitionOk();
    const evSoul = makeEvidence(DriftType.SOUL_DRIFT, {
      violations: ['v1', 'v2'],
      severity_hint: 'critico',
    });
    const evValores = makeEvidence(
      DriftType.VALORES,
      { violated_principles: [0], severity_hint: 'critico' },
      'valores critico',
    );

    const out = await decideAndApply({
      evidences: [evSoul, evValores],
      active_profile_id: PROFILE_ID,
    });

    expect(out[0]!.severity).toBe(DriftSeverity.CRITICO);
    expect(out[0]!.decision).toBe(DriftDecision.QUEUED_HUMAN); // soul_drift NUNCA rollback
    expect(out[0]!.superseded_by).toBeUndefined(); // soul nunca participa do collapse

    expect(out[1]!.severity).toBe(DriftSeverity.CRITICO);
    expect(out[1]!.decision).toBe(DriftDecision.ROLLBACK);
    expect(out[1]!.applied).toBe(true);
    expect(out[1]!.superseded_by).toBeUndefined();

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![0].to).toBe('rolled_back');
  });

  // ---- Codex Adversarial Review of PR #182 round 3: alert-aware fallback ----
  //
  // Round 2 picked the winner by raw severity rank BEFORE persisting alerts.
  // If the top mutator's alert insert failed (DB outage, CHECK constraint),
  // the engine dropped the whole batch's transition and left the active
  // profile running uncovered, even when a weaker-but-persisted mutator was
  // ready to act.
  //
  // Round 3 fix: re-rank winners AFTER alert persistence, ignoring any
  // mutator with `alert_persist_failed`. The real winner is the strongest
  // mutator AMONG persisted ones. The intended winner that failed alert
  // insert keeps its own `applied_error: 'alert_persist_failed:...'` for
  // forensics. A structured `drift.batch.collapse.fallback` log fires when
  // intended !== real so the rescue path is discoverable.

  it('round 3 fallback: [alto, critico] critico alert FAILS → real winner is alto, freeze applied', async () => {
    transitionOk();
    // Order: alto (index 0) alert ok, critico (index 1) alert fails.
    createAlertMock.mockReset();
    createAlertMock.mockImplementationOnce(async () => ({ id: 'alert-alto' }));
    createAlertMock.mockImplementationOnce(async () => {
      throw new Error('db down');
    });

    const evAlto = makeEvidence(
      DriftType.VALORES,
      { violated_principles: [0] },
      'alto evidence',
    );
    const evCritico = makeEvidence(
      DriftType.LINGUAGEM,
      { offensive: true },
      'critico evidence',
    );

    const out = await decideAndApply({
      evidences: [evAlto, evCritico],
      active_profile_id: PROFILE_ID,
    });

    // Alto: alert ok, real winner now (critico's alert failed) → freeze applied.
    expect(out[0]!.alert_id).toBe('alert-alto');
    expect(out[0]!.applied).toBe(true);
    expect(out[0]!.applied_error).toBeUndefined();
    expect(out[0]!.superseded_by).toBeUndefined();
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);

    // Critico: alert failed → applied=false with alert_persist_failed,
    // NOT marked superseded_by (it lost because it had no audit row, not
    // because alto beat it).
    expect(out[1]!.alert_id).toBeUndefined();
    expect(out[1]!.applied).toBe(false);
    expect(out[1]!.applied_error).toContain('alert_persist_failed');
    expect(out[1]!.superseded_by).toBeUndefined();

    // CRITICAL: one transition fired (alto → frozen), batch was rescued.
    expect(transitionMock).toHaveBeenCalledTimes(1);
    const transArgs = transitionMock.mock.calls[0]![0];
    expect(transArgs.to).toBe('frozen');
    expect(transArgs.approved_by).toBe('auto:drift_alto');
  });

  it('round 3 fallback: [alto1, critico, alto2] critico alert FAILS → alto1 wins by index tie-break', async () => {
    transitionOk();
    createAlertMock.mockReset();
    createAlertMock.mockImplementationOnce(async () => ({ id: 'alert-alto1' }));
    createAlertMock.mockImplementationOnce(async () => {
      throw new Error('db down for critico');
    });
    createAlertMock.mockImplementationOnce(async () => ({ id: 'alert-alto2' }));

    const evAlto1 = makeEvidence(DriftType.VALORES, { violated_principles: [0] }, 'alto 1');
    const evCritico = makeEvidence(DriftType.LINGUAGEM, { offensive: true }, 'critico');
    const evAlto2 = makeEvidence(DriftType.VALORES, { violated_principles: [1] }, 'alto 2');

    const out = await decideAndApply({
      evidences: [evAlto1, evCritico, evAlto2],
      active_profile_id: PROFILE_ID,
    });

    // alto1: real winner (critico filtered out, tie-break by lower index)
    expect(out[0]!.alert_id).toBe('alert-alto1');
    expect(out[0]!.applied).toBe(true);
    expect(out[0]!.superseded_by).toBeUndefined();

    // critico: alert failed → applied=false, NOT superseded_by
    expect(out[1]!.alert_id).toBeUndefined();
    expect(out[1]!.applied).toBe(false);
    expect(out[1]!.applied_error).toContain('alert_persist_failed');
    expect(out[1]!.superseded_by).toBeUndefined();

    // alto2: alert ok but lost the tie-break → superseded_by alto1
    expect(out[2]!.alert_id).toBe('alert-alto2');
    expect(out[2]!.applied).toBe(false);
    expect(out[2]!.superseded_by).toBe('alert-alto1');

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![0].approved_by).toBe('auto:drift_alto');
  });

  it('round 3 fallback: ALL mutators alert FAIL → no transition, no winner', async () => {
    transitionOk();
    createAlertMock.mockReset();
    createAlertMock.mockImplementation(async () => {
      throw new Error('db unavailable');
    });

    const evAlto = makeEvidence(DriftType.VALORES, { violated_principles: [0] });
    const evCritico = makeEvidence(DriftType.LINGUAGEM, { offensive: true });

    const out = await decideAndApply({
      evidences: [evAlto, evCritico],
      active_profile_id: PROFILE_ID,
    });

    // No mutator was persisted → no real winner → no transition.
    expect(out[0]!.alert_id).toBeUndefined();
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toContain('alert_persist_failed');
    expect(out[0]!.superseded_by).toBeUndefined();

    expect(out[1]!.alert_id).toBeUndefined();
    expect(out[1]!.applied).toBe(false);
    expect(out[1]!.applied_error).toContain('alert_persist_failed');
    expect(out[1]!.superseded_by).toBeUndefined();

    // CRITICAL: zero transitions when no mutator persisted.
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('round 3 fallback: single mutator alert FAILS → no transition (same as before)', async () => {
    transitionOk();
    createAlertMock.mockReset();
    createAlertMock.mockImplementationOnce(async () => {
      throw new Error('db down');
    });

    const evCritico = makeEvidence(DriftType.LINGUAGEM, { offensive: true });

    const out = await decideAndApply({
      evidences: [evCritico],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.alert_id).toBeUndefined();
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toContain('alert_persist_failed');
    expect(out[0]!.superseded_by).toBeUndefined();

    // No transition — there's nothing to fall back to.
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('round 3 fallback: discarded mutator that ALSO failed alert insert → superseded_by NOT set', async () => {
    transitionOk();
    // [alto1 alert ok, alto2 alert fails, critico alert ok] → critico is real winner.
    // alto1: persisted but lost → superseded_by = critico.alert_id
    // alto2: alert failed → applied_error, superseded_by undefined
    createAlertMock.mockReset();
    createAlertMock.mockImplementationOnce(async () => ({ id: 'alert-alto1' }));
    createAlertMock.mockImplementationOnce(async () => {
      throw new Error('db down for alto2');
    });
    createAlertMock.mockImplementationOnce(async () => ({ id: 'alert-critico' }));

    const evAlto1 = makeEvidence(DriftType.VALORES, { violated_principles: [0] }, 'alto1');
    const evAlto2 = makeEvidence(DriftType.VALORES, { violated_principles: [1] }, 'alto2');
    const evCritico = makeEvidence(DriftType.LINGUAGEM, { offensive: true }, 'critico');

    const out = await decideAndApply({
      evidences: [evAlto1, evAlto2, evCritico],
      active_profile_id: PROFILE_ID,
    });

    // critico is the real winner (all persisted; critico is strongest).
    expect(out[2]!.applied).toBe(true);
    expect(out[2]!.superseded_by).toBeUndefined();

    // alto1: persisted but lost → superseded_by = critico
    expect(out[0]!.alert_id).toBe('alert-alto1');
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.superseded_by).toBe('alert-critico');

    // alto2: alert failed → applied_error, NO superseded_by
    expect(out[1]!.alert_id).toBeUndefined();
    expect(out[1]!.applied).toBe(false);
    expect(out[1]!.applied_error).toContain('alert_persist_failed');
    expect(out[1]!.superseded_by).toBeUndefined();

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![0].to).toBe('rolled_back');
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

  // ---- Codex Adversarial Review of PR #182 round 4: cross-invocation escalation ----
  //
  // Round 2 collapse fixed intra-batch ordering (alto + critico in the SAME
  // invocation). But two concurrent `decideAndApply` calls for the same agent
  // can still race: an alto invocation freezes the active row first; the
  // critico invocation arrives second, sees the row as `frozen`, and the
  // `expected_from='active'` guard demotes its rollback to `applied=false`.
  // The critical drift ends up `frozen` instead of `rolled_back`.
  //
  // Codex Adversarial Review of PR #196 round 1 — refetch semantics. The
  // earlier round 4 helper queried `WHERE status='active'`, so in the exact
  // race the patch was meant to handle (target row frozen, no replacement),
  // it returned null and the engine took the `active_replaced` skip path,
  // dropping the rollback in the scenario the escalation was designed to
  // recover. The new helper (`getActiveContextForAgent`) reports current
  // active-slot occupancy; the engine combines it with the original
  // `profileId` and distinguishes:
  //   - active_profile_id === null → target frozen, no replacement.
  //     ESCALATE via `transition({to:'rolled_back', expected_from:'frozen'})`.
  //     Log `drift.rollback.escalated`.
  //   - active_profile_id !== null && !== profileId → replacement seeded.
  //     SKIP with `drift.skip.active_replaced`.
  //   - active_profile_id === profileId → defensive (not a legal edge
  //     today). SKIP with `drift.skip.refetch_anomaly`.
  //   - retry also stale/terminal → log `drift.skip.terminal_state`.

  it('PR #196 escalation: critico race vs concurrent freeze (no replacement) → retry with expected_from=frozen succeeds', async () => {
    // CASE A: an `alto` batch from another invocation froze v1 between this
    // engine's pre-lock read and the actual transition call. The first
    // transition (to:'rolled_back', expected_from:'active') comes back
    // stale with actual='frozen'. The engine then re-fetches active
    // context. In the real DB the helper does `SELECT WHERE
    // status='active'`, so a frozen target with no replacement returns
    // null (the previous round's mock used the impossible `PROFILE_ID`
    // value, which masked the bug Codex flagged on PR #196). The engine
    // recognises null + original frozen → escalate.

    // First transition: stale (actual='frozen').
    transitionMock.mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      expected_from: 'active',
      actual: 'frozen',
    });
    // Re-fetch: NO active slot occupant (target row was frozen, nobody
    // seeded a replacement). This is what real Postgres returns when
    // status='active' filters the row out.
    getActiveContextForAgentMock.mockResolvedValueOnce({ active_profile_id: null });
    // Retry transition: ok (frozen → rolled_back is a valid transition).
    transitionMock.mockResolvedValueOnce({
      ok: true,
      updated: { id: PROFILE_ID, status: 'rolled_back' },
    });

    const evCritico = makeEvidence(
      DriftType.LINGUAGEM,
      { offensive: true },
      'critico cross-invocation evidence',
    );

    const out = await decideAndApply({
      evidences: [evCritico],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe(DriftSeverity.CRITICO);
    expect(out[0]!.decision).toBe(DriftDecision.ROLLBACK);
    expect(out[0]!.applied).toBe(true);
    expect(out[0]!.applied_error).toBeUndefined();
    expect(out[0]!.alert_id).toMatch(/^alert-/);

    // Two transition calls: first with expected_from='active' (stale),
    // second with expected_from='frozen' (escalation).
    expect(transitionMock).toHaveBeenCalledTimes(2);
    expect(transitionMock.mock.calls[0]![0]).toMatchObject({
      to: 'rolled_back',
      expected_from: 'active',
      approved_by: 'auto:drift_critico',
    });
    expect(transitionMock.mock.calls[1]![0]).toMatchObject({
      to: 'rolled_back',
      expected_from: 'frozen',
      approved_by: 'auto:drift_critico',
      rollback_reason: 'critico cross-invocation evidence',
    });

    // Re-fetch happened exactly once between the two transitions.
    expect(getActiveContextForAgentMock).toHaveBeenCalledTimes(1);
  });

  it('PR #196 escalation: critico race vs concurrent seed (active was REPLACED) → skip, no retry', async () => {
    // CASE B: a concurrent `seedNewActiveAtomic` froze v1 and seeded v2 as
    // the new active. The first transition comes back stale with
    // actual='frozen'. The engine re-fetches active context and sees
    // active_profile_id is now PROFILE_ID_V2 (DIFFERENT from PROFILE_ID/
    // v1). The evidence was scored against v1; rolling back v1 is
    // meaningless when v2 is the agent's current contract surface. Skip
    // with `drift.skip.active_replaced`; the next drift cycle will
    // re-evaluate against v2.

    transitionMock.mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      expected_from: 'active',
      actual: 'frozen',
    });
    // Re-fetch: DIFFERENT id → active was replaced.
    getActiveContextForAgentMock.mockResolvedValueOnce({
      active_profile_id: 'prof-active-v2',
    });

    const evCritico = makeEvidence(
      DriftType.LINGUAGEM,
      { offensive: true },
      'critico vs replaced active',
    );

    const out = await decideAndApply({
      evidences: [evCritico],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe(DriftSeverity.CRITICO);
    expect(out[0]!.decision).toBe(DriftDecision.ROLLBACK);
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toBe(
      'stale:expected=active,actual=frozen;active_replaced',
    );
    expect(out[0]!.alert_id).toMatch(/^alert-/);

    // Only ONE transition call — escalation NOT attempted because v1 is no
    // longer the current contract surface.
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(getActiveContextForAgentMock).toHaveBeenCalledTimes(1);
  });

  it('PR #196 escalation: terminal state (third invocation, row already rolled_back) → no-op, log terminal_state', async () => {
    // CASE C: another worker already escalated v1 to rolled_back between
    // this engine's stale observation and the retry. The retry
    // `transition({to:'rolled_back', expected_from:'frozen'})` also sees
    // stale (actual='rolled_back') OR terminal. The desired terminal
    // state is achieved (by someone else), so mark applied=false with a
    // log line pointing at the converging path.

    transitionMock.mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      expected_from: 'active',
      actual: 'frozen',
    });
    // Refetch: no active slot occupant (target rolled_back, no
    // replacement). The helper would return null here as well.
    getActiveContextForAgentMock.mockResolvedValueOnce({ active_profile_id: null });
    // Retry transition: another worker already rolled it back; transition
    // returns terminal (the state machine treats rolled_back as terminal).
    transitionMock.mockResolvedValueOnce({
      ok: false,
      reason: 'terminal',
    });

    const evCritico = makeEvidence(
      DriftType.LINGUAGEM,
      { offensive: true },
      'critico vs already-rolled-back row',
    );

    const out = await decideAndApply({
      evidences: [evCritico],
      active_profile_id: PROFILE_ID,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toBe('terminal');

    // Two transitions, one re-fetch — same shape as CASE A, just no
    // success on the retry.
    expect(transitionMock).toHaveBeenCalledTimes(2);
    expect(getActiveContextForAgentMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[1]![0].expected_from).toBe('frozen');
  });

  it('PR #196 escalation: FROZEN winner (alto) racing concurrent freeze → no escalation, original stale path', async () => {
    // Belt-and-suspenders: an ALTO winner (decision=FROZEN) that races a
    // concurrent freeze does NOT trigger escalation — the row is already
    // at the desired state, so the original `stale:expected=active,
    // actual=frozen` outcome is correct (no retry, no re-fetch).
    transitionMock.mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      expected_from: 'active',
      actual: 'frozen',
    });

    const evAlto = makeEvidence(DriftType.VALORES, { violated_principles: [0] });

    const out = await decideAndApply({
      evidences: [evAlto],
      active_profile_id: PROFILE_ID,
    });

    expect(out[0]!.severity).toBe(DriftSeverity.ALTO);
    expect(out[0]!.decision).toBe(DriftDecision.FROZEN);
    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toBe('stale:expected=active,actual=frozen');

    // No re-fetch, no retry.
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(getActiveContextForAgentMock).not.toHaveBeenCalled();
  });

  it('PR #196 escalation: re-fetch helper THROWS → conservative skip with refetch_failed in error', async () => {
    // Defensive coverage: if `getActiveContextForAgent` itself fails (DB
    // outage, network glitch), we cannot decide between CASE A (escalate)
    // and CASE B (skip). The engine must NOT retry blindly — that could
    // rollback a replaced active. Mark applied=false with both the
    // original stale signal AND the refetch failure for forensics.

    transitionMock.mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      expected_from: 'active',
      actual: 'frozen',
    });
    getActiveContextForAgentMock.mockRejectedValueOnce(
      new Error('connection reset'),
    );

    const evCritico = makeEvidence(DriftType.LINGUAGEM, { offensive: true });

    const out = await decideAndApply({
      evidences: [evCritico],
      active_profile_id: PROFILE_ID,
    });

    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toContain('stale:expected=active,actual=frozen');
    expect(out[0]!.applied_error).toContain('refetch_failed');
    expect(out[0]!.applied_error).toContain('connection reset');

    // Only the first transition attempted — no retry without a confirmed
    // re-fetch.
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  it('PR #196 escalation: refetch_anomaly defensive path (impossible same-id observation) → skip, no retry', async () => {
    // Defensive coverage: if the refetch somehow reports
    // active_profile_id === profileId AFTER the transition observed
    // status='frozen', the row would have had to transition
    // `frozen → active` between the two reads — not a legal edge today.
    // The engine refuses to retry (could rollback a row that's back in
    // service) and logs the anomaly. This case is the previous round's
    // INCORRECT test mock; the bug Codex flagged was that the engine
    // treated this impossible observation as "escalate", which would
    // wrongly rollback a re-activated row.

    transitionMock.mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      expected_from: 'active',
      actual: 'frozen',
    });
    // Impossible-in-practice but defensible refetch outcome.
    getActiveContextForAgentMock.mockResolvedValueOnce({
      active_profile_id: PROFILE_ID,
    });

    const evCritico = makeEvidence(DriftType.LINGUAGEM, { offensive: true });

    const out = await decideAndApply({
      evidences: [evCritico],
      active_profile_id: PROFILE_ID,
    });

    expect(out[0]!.applied).toBe(false);
    expect(out[0]!.applied_error).toBe(
      'stale:expected=active,actual=frozen;refetch_anomaly',
    );

    // Only the FIRST transition was attempted — defensive skip refuses to
    // retry against a row that the refetch says is `active`.
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(getActiveContextForAgentMock).toHaveBeenCalledTimes(1);
  });
});
