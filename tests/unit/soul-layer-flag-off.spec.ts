/**
 * P8b round-2 — FEATURE_SOUL_LAYER_V1 kill switch tests.
 *
 * Validates that when FEATURE_SOUL_LAYER_V1 is disabled:
 *  1. Drift orchestrator uses 7 detectors (soul detector excluded).
 *  2. When enabled, 8 detectors are used (soul detector included).
 *  3. buildSoulSlice depth='none' returns empty slice (no soul DB/LLM work).
 *
 * The flag is controlled via featureFlags.override() / featureFlags.killSwitch()
 * so tests are deterministic regardless of env.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

// ---- Mock all detectors and runner so we can count calls ----

const {
  soulDetectMock,
  tomDetectMock,
  runCognitiveModuleMock,
} = vi.hoisted(() => ({
  soulDetectMock: vi.fn(),
  tomDetectMock: vi.fn(),
  runCognitiveModuleMock: vi.fn(),
}));

vi.mock('@/cognition/drift/soul.js', () => ({
  soulDriftDetector: { type: 'soul_drift', detect: soulDetectMock },
}));
vi.mock('@/cognition/drift/tom.js', () => ({
  tomDetector: { type: 'tom', detect: tomDetectMock },
}));
vi.mock('@/cognition/drift/valores.js', () => ({
  valoresDetector: { type: 'valores', detect: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/cognition/drift/confianca.js', () => ({
  confiancaDetector: { type: 'confianca', detect: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/cognition/drift/vies.js', () => ({
  viesDetector: { type: 'vies', detect: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/cognition/drift/escopo.js', () => ({
  escopoDetector: { type: 'escopo', detect: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/cognition/drift/linguagem.js', () => ({
  linguagemDetector: { type: 'linguagem', detect: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/cognition/drift/procedimento.js', () => ({
  procedimentoDetector: { type: 'procedimento', detect: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: (opts: unknown, fn: () => Promise<unknown>) =>
    runCognitiveModuleMock(opts, fn),
}));

vi.mock('@/control-plane/soul/soul-biases-repo.js', () => ({
  soulBiasesRepo: {
    findActiveForScope: vi.fn(async () => []),
    findByProposalId: vi.fn(async () => null),
    listProposed: vi.fn(async () => []),
    propose: vi.fn(),
    activate: vi.fn(),
    rollback: vi.fn(),
    deprecate: vi.fn(),
    listVersions: vi.fn(async () => []),
    getById: vi.fn(async () => null),
  },
}));

function makeInput() {
  return {
    profile_active: {} as never,
    recent_messages: [],
    capabilities: [],
    self_model_skills: [],
    recent_procedures: [],
  };
}

beforeEach(() => {
  runCognitiveModuleMock.mockReset();
  soulDetectMock.mockReset();
  tomDetectMock.mockReset();

  // Default: invoke the fn and wrap result
  runCognitiveModuleMock.mockImplementation(
    async (_opts: unknown, fn: () => Promise<unknown>) => {
      const output = await fn();
      return { output, status: 'success', fallback_triggered: false, latency_ms: 5 };
    },
  );
  tomDetectMock.mockResolvedValue(null);
  soulDetectMock.mockResolvedValue(null);
});

afterEach(() => {
  featureFlags.reset();
});

describe('FEATURE_SOUL_LAYER_V1 kill switch', () => {
  it('flag OFF → drift orchestrator usa 7 detectores (soul excluído)', async () => {
    featureFlags.killSwitch(FeatureFlagName.FEATURE_SOUL_LAYER_V1);

    const { runAllDriftDetectors } = await import('@/cognition/drift/index.js');
    await runAllDriftDetectors(makeInput());

    // 7 base detectors, soul NOT included
    expect(runCognitiveModuleMock).toHaveBeenCalledTimes(7);
    const calledNames = runCognitiveModuleMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>)['name'],
    );
    expect(calledNames).not.toContain('drift_detector_soul_drift');
    expect(soulDetectMock).not.toHaveBeenCalled();
  });

  it('flag ON → drift orchestrator usa 8 detectores (soul incluído)', async () => {
    featureFlags.override(FeatureFlagName.FEATURE_SOUL_LAYER_V1, true);

    const { runAllDriftDetectors } = await import('@/cognition/drift/index.js');
    await runAllDriftDetectors(makeInput());

    // 7 base + 1 soul = 8
    expect(runCognitiveModuleMock).toHaveBeenCalledTimes(8);
    const calledNames = runCognitiveModuleMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>)['name'],
    );
    expect(calledNames).toContain('drift_detector_soul_drift');
    expect(soulDetectMock).toHaveBeenCalledTimes(1);
  });

  it('flag OFF → buildSoulSlice com depth=none devolve slice vazio (nenhum DB/LLM soul work)', async () => {
    featureFlags.killSwitch(FeatureFlagName.FEATURE_SOUL_LAYER_V1);

    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    // Callers must pass depth='none' when flag is off — the slice builder
    // respects depth='none' and returns empty without calling the repo.
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'none',
      max_biases: 5,
    });

    const { soulBiasesRepo } = await import('@/control-plane/soul/soul-biases-repo.js');
    expect(slice.active_biases).toHaveLength(0);
    expect(slice.rendered_block).toBeNull();
    // When depth='none', findActiveForScope must not be called
    expect(soulBiasesRepo.findActiveForScope).not.toHaveBeenCalled();
  });
});
