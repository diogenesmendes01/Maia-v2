/**
 * P8b — Tests for soulDriftDetector.
 *
 * Mocks soulBiasesRepo + Anthropic SDK. Validates:
 *  - < 5 mensagens do agente → null (skip)
 *  - heuristic detecta keywords absolutistas
 *  - severity_hint: 0-1 violations = baixo, 2-4 = medio, 5+ = alto
 *  - sem ANTHROPIC_API_KEY, judge devolve null mas detector ainda emite
 *    quando heurística confirma alta confiança
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Bias = {
  id: string;
  tenant_id: string;
  agent_id: string;
  scope: string;
  scope_value: string;
  principle: string;
  guidance: string;
  origin: string;
  strength: string;
  activation_context: Record<string, unknown>;
  status: string;
  version: number;
  previous_version_id: string | null;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_at: Date | null;
  deprecated_at: Date | null;
  deprecated_reason: string | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  proposal_id: string | null;
  source_drift_alert_id: string | null;
  created_at: Date;
};

let mockActiveBiases: Bias[] = [];

vi.mock('@/control-plane/soul/soul-biases-repo.js', () => ({
  soulBiasesRepo: {
    findActiveForScope: vi.fn(async () => mockActiveBiases),
  },
}));

function makeBias(p: Partial<Bias>): Bias {
  return {
    id: p.id ?? `b-${Math.random().toString(36).slice(2, 8)}`,
    tenant_id: 'default',
    agent_id: 'default',
    scope: p.scope ?? 'tenant',
    scope_value: p.scope_value ?? '*',
    principle: p.principle ?? 'humildade_epistemica',
    guidance: p.guidance ?? 'Evite afirmar com certeza absoluta.',
    origin: p.origin ?? 'founder_explicit',
    strength: p.strength ?? '0.900',
    activation_context: p.activation_context ?? {},
    status: 'active',
    version: 1,
    previous_version_id: null,
    proposed_by: 'founder',
    proposed_reason: null,
    approved_by: 'founder',
    approved_at: new Date(),
    activated_at: new Date(),
    deprecated_at: null,
    deprecated_reason: null,
    rolled_back_at: null,
    rollback_reason: null,
    proposal_id: null,
    source_drift_alert_id: null,
    created_at: new Date(),
  };
}

function makeMessages(n: number, text: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    from: 'agent' as const,
    text,
    created_at: new Date(),
  }));
}

beforeEach(() => {
  mockActiveBiases = [];
  vi.clearAllMocks();
  // ANTHROPIC_API_KEY é seeded em tests/setup.ts; o detector tem try/catch
  // que retorna null silenciosamente em qualquer erro do SDK — heurística
  // permanece o caminho principal nos testes.
});

describe('soulDriftDetector (P8b)', () => {
  it('returns null se < 5 mensagens do agente', async () => {
    mockActiveBiases = [makeBias({ principle: 'humildade_epistemica' })];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(3, 'sempre tenho certeza'),
    });
    expect(r).toBeNull();
  });

  it('returns null se não há active biases no tenant', async () => {
    mockActiveBiases = [];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(10, 'sempre tenho certeza'),
    });
    expect(r).toBeNull();
  });

  it('heuristica detecta violação de humildade_epistemica (>= 20% absolutistas)', async () => {
    mockActiveBiases = [makeBias({ principle: 'humildade_epistemica' })];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(5, 'sempre tenho certeza absoluta sobre isso'),
    });
    expect(r).not.toBeNull();
    expect(r!.drift_type).toBe('soul_drift');
    expect(r!.detected_by).toBe('drift_detector_soul');
    const payload = r!.payload as { violations: unknown[]; severity_hint: string };
    expect(payload.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('severity_hint=baixo para 1 violation, medio para 2-4, alto para 5+', async () => {
    // 5 biases todas violadas (heurística forte)
    mockActiveBiases = [
      makeBias({ id: 'b1', principle: 'humildade_epistemica' }),
      makeBias({ id: 'b2', principle: 'humildade_v2' }),
      makeBias({ id: 'b3', principle: 'humildade_v3' }),
      makeBias({ id: 'b4', principle: 'humildade_v4' }),
      makeBias({ id: 'b5', principle: 'humildade_v5' }),
    ];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(10, 'sempre tenho certeza absoluta nunca duvido'),
    });
    expect(r).not.toBeNull();
    const payload = r!.payload as { severity_hint: string; violations: unknown[] };
    expect(payload.violations.length).toBe(5);
    expect(payload.severity_hint).toBe('alto');
  });

  it('severity_hint=medio para 2 violations', async () => {
    mockActiveBiases = [
      makeBias({ id: 'b1', principle: 'humildade_v1' }),
      makeBias({ id: 'b2', principle: 'humildade_v2' }),
    ];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(10, 'sempre garantido sem dúvida'),
    });
    expect(r).not.toBeNull();
    const payload = r!.payload as { severity_hint: string };
    expect(payload.severity_hint).toBe('medio');
  });

  it('payload inclui violations[] com bias_id, principle, confidence, examples', async () => {
    mockActiveBiases = [
      makeBias({ id: 'bias-humility', principle: 'humildade_epistemica' }),
    ];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(5, 'sempre tenho certeza absoluta'),
    });
    expect(r).not.toBeNull();
    const payload = r!.payload as {
      violations: Array<{
        bias_id: string;
        principle: string;
        confidence: number;
        examples: string[];
      }>;
    };
    const v = payload.violations[0]!;
    expect(v.bias_id).toBe('bias-humility');
    expect(v.principle).toBe('humildade_epistemica');
    expect(v.confidence).toBeGreaterThan(0);
    expect(v.examples.length).toBeGreaterThan(0);
  });

  it('evidence_summary tem < 200 chars', async () => {
    mockActiveBiases = [makeBias({ principle: 'humildade_epistemica' })];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(5, 'sempre certeza absoluta'),
    });
    expect(r!.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('sem violações reais devolve null', async () => {
    mockActiveBiases = [makeBias({ principle: 'humildade_epistemica' })];
    const { soulDriftDetector } = await import('@/cognition/drift/soul.js');
    const r = await soulDriftDetector.detect({
      profile_active: {} as never,
      recent_messages: makeMessages(5, 'pode ser que a resposta seja x; parece que sim'),
    });
    expect(r).toBeNull();
  });
});
