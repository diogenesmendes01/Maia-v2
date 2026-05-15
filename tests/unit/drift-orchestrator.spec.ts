/**
 * P4 Task 8 (Cluster 3) — drift orchestrator: runAllDriftDetectors.
 *
 * Mocka os 7 detectores e o runCognitiveModule do runner para garantir que:
 *  - O orchestrator chama runCognitiveModule UMA vez por detector (7x).
 *  - As opções passadas a runCognitiveModule incluem name=`drift_detector_<type>`,
 *    triggered_by='async_event', timeoutMs=8000, fallback=null.
 *  - O resultado final filtra `r.output === null`, ou seja, só retorna
 *    DriftEvidence onde algum detector identificou drift de fato.
 *  - A ordem das chamadas reflete a ordem de DETECTORS (tom, valores, confianca,
 *    vies, escopo, linguagem, procedimento).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftType } from '@/types/enums.js';
import type { DriftDetectionInput, DriftEvidence } from '@/cognition/drift/types.js';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';

const {
  tomDetectMock,
  valoresDetectMock,
  confiancaDetectMock,
  viesDetectMock,
  escopoDetectMock,
  linguagemDetectMock,
  procedimentoDetectMock,
  runCognitiveModuleMock,
} = vi.hoisted(() => ({
  tomDetectMock: vi.fn(),
  valoresDetectMock: vi.fn(),
  confiancaDetectMock: vi.fn(),
  viesDetectMock: vi.fn(),
  escopoDetectMock: vi.fn(),
  linguagemDetectMock: vi.fn(),
  procedimentoDetectMock: vi.fn(),
  runCognitiveModuleMock: vi.fn(),
}));

vi.mock('@/cognition/drift/tom.js', () => ({
  tomDetector: { type: 'tom', detect: tomDetectMock },
}));
vi.mock('@/cognition/drift/valores.js', () => ({
  valoresDetector: { type: 'valores', detect: valoresDetectMock },
}));
vi.mock('@/cognition/drift/confianca.js', () => ({
  confiancaDetector: { type: 'confianca', detect: confiancaDetectMock },
}));
vi.mock('@/cognition/drift/vies.js', () => ({
  viesDetector: { type: 'vies', detect: viesDetectMock },
}));
vi.mock('@/cognition/drift/escopo.js', () => ({
  escopoDetector: { type: 'escopo', detect: escopoDetectMock },
}));
vi.mock('@/cognition/drift/linguagem.js', () => ({
  linguagemDetector: { type: 'linguagem', detect: linguagemDetectMock },
}));
vi.mock('@/cognition/drift/procedimento.js', () => ({
  procedimentoDetector: { type: 'procedimento', detect: procedimentoDetectMock },
}));

vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: (opts: unknown, fn: () => Promise<unknown>) =>
    runCognitiveModuleMock(opts, fn),
}));

import { runAllDriftDetectors } from '@/cognition/drift/index.js';

function makeProfile(): AgentOperationalProfileVersion {
  const now = new Date();
  return {
    id: 'prof-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: 'active',
    profile_body: {
      schema_version: 'v3.1.1-2026-05-15',
      identity: {
        role_descriptor: 'Maia',
        voice: {
          tone: 'pt-br',
          formality: 'medium',
          verbosity: 'medium',
        },
        cognitive_limits: {
          max_inference_depth: 3,
          max_speculation_in_response: 0.2,
          confidence_floor_for_action: 0.7,
        },
        priorities: [],
        learned_voice_modifiers: [],
      },
      style: {
        language: 'pt-BR',
        rhythm: {},
      },
      metadata: {
        effective_from: now.toISOString(),
        created_by: 'system_seed',
        previous_version_id: null,
      },
    } as unknown,
    proposed_by: 'system_seed',
    proposed_reason: null,
    approved_by: 'system_seed',
    approved_at: now,
    activated_at: now,
    frozen_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: now,
  } as unknown as AgentOperationalProfileVersion;
}

function makeInput(): DriftDetectionInput {
  return {
    profile_active: makeProfile(),
    recent_messages: [],
    capabilities: [],
    self_model_skills: [],
    recent_procedures: [],
  };
}

function makeEvidence(t: DriftType): DriftEvidence {
  return {
    drift_type: t,
    detected_by: `drift_detector_${t}`,
    payload: {},
    evidence_summary: `evidence ${t}`,
  };
}

describe('runAllDriftDetectors', () => {
  beforeEach(() => {
    tomDetectMock.mockReset();
    valoresDetectMock.mockReset();
    confiancaDetectMock.mockReset();
    viesDetectMock.mockReset();
    escopoDetectMock.mockReset();
    linguagemDetectMock.mockReset();
    procedimentoDetectMock.mockReset();
    runCognitiveModuleMock.mockReset();
  });

  it('chama runCognitiveModule 7x (um por detector) com opções corretas e retorna apenas outputs não-null', async () => {
    // Make runCognitiveModule simply invoke the detector and wrap result
    runCognitiveModuleMock.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => {
      const output = await fn();
      return { output, status: 'success', fallback_triggered: false, latency_ms: 5 };
    });

    // tom and vies return evidence; the rest return null.
    tomDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.TOM));
    valoresDetectMock.mockResolvedValueOnce(null);
    confiancaDetectMock.mockResolvedValueOnce(null);
    viesDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.VIES));
    escopoDetectMock.mockResolvedValueOnce(null);
    linguagemDetectMock.mockResolvedValueOnce(null);
    procedimentoDetectMock.mockResolvedValueOnce(null);

    const out = await runAllDriftDetectors(makeInput());

    expect(runCognitiveModuleMock).toHaveBeenCalledTimes(7);

    // Validate the options passed to runCognitiveModule for the first call
    const firstCallOpts = runCognitiveModuleMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstCallOpts['name']).toBe('drift_detector_tom');
    expect(firstCallOpts['triggered_by']).toBe('async_event');
    expect(firstCallOpts['timeoutMs']).toBe(8000);
    expect(firstCallOpts['fallback']).toBeNull();

    // Order of calls matches DETECTORS order
    const calledNames = runCognitiveModuleMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>)['name'],
    );
    expect(calledNames).toEqual([
      'drift_detector_tom',
      'drift_detector_valores',
      'drift_detector_confianca',
      'drift_detector_vies',
      'drift_detector_escopo',
      'drift_detector_linguagem',
      'drift_detector_procedimento',
    ]);

    // Only non-null outputs returned
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.drift_type)).toEqual(['tom', 'vies']);
  });

  it('quando runCognitiveModule retorna output:null (fallback) → excluído do resultado', async () => {
    runCognitiveModuleMock.mockResolvedValue({
      output: null,
      status: 'error',
      fallback_triggered: true,
      latency_ms: 10,
    });

    tomDetectMock.mockResolvedValue(null);
    valoresDetectMock.mockResolvedValue(null);
    confiancaDetectMock.mockResolvedValue(null);
    viesDetectMock.mockResolvedValue(null);
    escopoDetectMock.mockResolvedValue(null);
    linguagemDetectMock.mockResolvedValue(null);
    procedimentoDetectMock.mockResolvedValue(null);

    const out = await runAllDriftDetectors(makeInput());
    expect(out).toEqual([]);
  });

  it('todos detectores retornam evidence → 7 evidences no resultado', async () => {
    runCognitiveModuleMock.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => {
      const output = await fn();
      return { output, status: 'success', fallback_triggered: false, latency_ms: 5 };
    });

    tomDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.TOM));
    valoresDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.VALORES));
    confiancaDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.CONFIANCA));
    viesDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.VIES));
    escopoDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.ESCOPO));
    linguagemDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.LINGUAGEM));
    procedimentoDetectMock.mockResolvedValueOnce(makeEvidence(DriftType.PROCEDIMENTO));

    const out = await runAllDriftDetectors(makeInput());
    expect(out).toHaveLength(7);
    expect(out.map((e) => e.drift_type).sort()).toEqual([
      'confianca',
      'escopo',
      'linguagem',
      'procedimento',
      'tom',
      'valores',
      'vies',
    ]);
  });
});
