/**
 * P4 Task 8 (Cluster 3) — drift detector: procedimento (determinístico, sem LLM).
 *
 * Cobertura:
 *  - 3 procedures (<=30d) com evidence_count=1 → evidence, count=3, severity_hint=medio
 *  - Mesmo cenário mas um com status=active → severity_hint=alto
 *  - 1 procedure com baixa evidência → null (abaixo do COUNT_THRESHOLD)
 *  - Procedures > 30 dias → null
 */
import { describe, it, expect } from 'vitest';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';
import { procedimentoDetector } from '@/cognition/drift/procedimento.js';

function makeProfile(): AgentOperationalProfileVersion {
  const now = new Date();
  return {
    id: 'prof-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: 'active',
    core_immutable: { identity_block: 'Maia', principles: [] } as unknown,
    operational_profile: { voice_descriptor: 'pt-br', thresholds: {} } as unknown,
    episodic_temp: {} as unknown,
    growth_backlog: [] as unknown,
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

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

describe('procedimentoDetector', () => {
  it('3 procedures recentes com evidence_count=1 → evidence, count=3, severity_hint=medio', async () => {
    const out = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      recent_procedures: [
        { id: 'p1', created_at: daysAgo(5), evidence_count: 1, status: 'proposed' },
        { id: 'p2', created_at: daysAgo(10), evidence_count: 2, status: 'queued' },
        { id: 'p3', created_at: daysAgo(20), evidence_count: 0, status: 'proposed' },
      ],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('procedimento');
    expect(out.detected_by).toBe('drift_detector_procedimento');
    expect(out.payload['count']).toBe(3);
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['any_active']).toBe(false);
    const lowEv = out.payload['low_evidence_procedures'] as Array<Record<string, unknown>>;
    expect(lowEv).toHaveLength(3);
    expect(out.evidence_summary).toContain('3 procedures');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('3 procedures recentes com evidence_count baixa, UM com status=active → severity_hint=alto', async () => {
    const out = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      recent_procedures: [
        { id: 'p1', created_at: daysAgo(5), evidence_count: 1, status: 'proposed' },
        { id: 'p2', created_at: daysAgo(10), evidence_count: 1, status: 'active' },
        { id: 'p3', created_at: daysAgo(20), evidence_count: 2, status: 'queued' },
      ],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('alto');
    expect(out.payload['any_active']).toBe(true);
  });

  it('apenas 1 procedure recente com baixa evidência → null (abaixo do COUNT_THRESHOLD)', async () => {
    const out = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      recent_procedures: [
        { id: 'p1', created_at: daysAgo(5), evidence_count: 1, status: 'proposed' },
      ],
    });

    expect(out).toBeNull();
  });

  it('procedures todas > 30 dias → null (fora da janela)', async () => {
    const out = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      recent_procedures: [
        { id: 'p1', created_at: daysAgo(35), evidence_count: 1, status: 'active' },
        { id: 'p2', created_at: daysAgo(40), evidence_count: 0, status: 'active' },
        { id: 'p3', created_at: daysAgo(60), evidence_count: 1, status: 'active' },
      ],
    });

    expect(out).toBeNull();
  });

  it('recent_procedures vazio/ausente → null', async () => {
    const out = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      recent_procedures: [],
    });
    expect(out).toBeNull();

    const out2 = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      // recent_procedures omitido
    });
    expect(out2).toBeNull();
  });

  it('procedures com evidence_count alta (>2) NÃO contam → null mesmo com várias recentes', async () => {
    const out = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      recent_procedures: [
        { id: 'p1', created_at: daysAgo(5), evidence_count: 5, status: 'active' },
        { id: 'p2', created_at: daysAgo(10), evidence_count: 8, status: 'active' },
        { id: 'p3', created_at: daysAgo(20), evidence_count: 10, status: 'active' },
      ],
    });

    expect(out).toBeNull();
  });

  it('aceita created_at como string ISO (não só Date)', async () => {
    const isoStr = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

    const out = await procedimentoDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [],
      recent_procedures: [
        { id: 'p1', created_at: isoStr(5), evidence_count: 1, status: 'proposed' },
        { id: 'p2', created_at: isoStr(10), evidence_count: 2, status: 'proposed' },
      ],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['count']).toBe(2);
  });
});
