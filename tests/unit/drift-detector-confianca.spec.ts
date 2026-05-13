/**
 * P4 Task 8 (Cluster 2) — drift detector: confianca (determinístico, sem LLM).
 *
 * Cobertura:
 *  - skill com confidence baixa + msg confiante → evidence com severity derivada do gap
 *  - skill com confidence alta + msg confiante → null (claim alinhada)
 *  - self_model_skills vazio → null
 *  - sem regex confiante na mensagem → null
 *  - múltiplos gaps → severity hint baseada no MAIOR gap
 *  - múltiplas skills, só uma com confidence baixa → só essa entra em confident_claims
 */
import { describe, it, expect } from 'vitest';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';
import type { DriftRecentMessage } from '@/cognition/drift/types.js';
import { confiancaDetector } from '@/cognition/drift/confianca.js';

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

function makeAgentMsg(text: string, id = 'm-' + Math.random().toString(36).slice(2)): DriftRecentMessage {
  return { id, from: 'agent', text, created_at: new Date() };
}

describe('confiancaDetector', () => {
  it('skill vendas com confidence=0.3 + msg "tenho certeza que entendo vendas" → evidence com severity critico (gap=0.7)', async () => {
    const out = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Tenho certeza que entendo vendas e posso te orientar.', 'm1')],
      self_model_skills: [{ skill_name: 'vendas', confidence: 0.3, evidence_count: 2 }],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('confianca');
    expect(out.detected_by).toBe('drift_detector_confianca');
    expect(out.payload['severity_hint']).toBe('critico');
    expect(out.payload['max_gap']).toBeCloseTo(0.7, 5);
    const claims = out.payload['confident_claims'] as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(1);
    expect(claims[0]['matched_skill']).toBe('vendas');
    expect(claims[0]['actual_confidence']).toBe(0.3);
    expect(claims[0]['gap']).toBeCloseTo(0.7, 5);
    expect(claims[0]['message_id']).toBe('m1');
    expect(out.evidence_summary).toContain('1 afirmações confiantes');
    expect(out.evidence_summary).toContain('max_gap=0.70');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('skill vendas com confidence=0.9 + msg confiante mencionando "vendas" → null (claim alinhada)', async () => {
    const out = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Tenho certeza que vendas funcionam assim.')],
      self_model_skills: [{ skill_name: 'vendas', confidence: 0.9, evidence_count: 50 }],
    });

    expect(out).toBeNull();
  });

  it('self_model_skills vazio/ausente → null', async () => {
    const out = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Tenho certeza que entendo vendas.')],
      self_model_skills: [],
    });

    expect(out).toBeNull();

    const out2 = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Tenho certeza que entendo vendas.')],
      // self_model_skills omitido
    });

    expect(out2).toBeNull();
  });

  it('agent msg sem regex confiante → null (mesmo com skill de baixa confiança)', async () => {
    const out = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Acho que vendas costumam funcionar assim, mas não sei dizer ao certo.')],
      self_model_skills: [{ skill_name: 'vendas', confidence: 0.2, evidence_count: 1 }],
    });

    expect(out).toBeNull();
  });

  it('múltiplas claims com gaps diferentes → severity hint vem do MAIOR gap', async () => {
    const out = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        // gap = 0.6 → alto, isoladamente
        makeAgentMsg('Tenho certeza que conheço fluxo_caixa.', 'm-a'),
        // gap = 0.85 → critico, isoladamente; deve dominar a severity
        makeAgentMsg('Garanto que conjugacao_verbal está dominada.', 'm-b'),
      ],
      self_model_skills: [
        { skill_name: 'fluxo_caixa', confidence: 0.4, evidence_count: 3 },
        { skill_name: 'conjugacao_verbal', confidence: 0.15, evidence_count: 1 },
      ],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('critico');
    expect(out.payload['max_gap']).toBeCloseTo(0.85, 5);
    const claims = out.payload['confident_claims'] as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(2);
  });

  it('msg confiante menciona skill X (baixa) e skill Y (alta) → só X entra em confident_claims', async () => {
    const out = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        makeAgentMsg('Com certeza, tanto vendas quanto suporte estão dominados.'),
      ],
      self_model_skills: [
        { skill_name: 'vendas', confidence: 0.25, evidence_count: 1 },
        { skill_name: 'suporte', confidence: 0.95, evidence_count: 80 },
      ],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    const claims = out.payload['confident_claims'] as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(1);
    expect(claims[0]['matched_skill']).toBe('vendas');
  });

  it('mensagens do usuário NÃO entram na detecção (só do agente)', async () => {
    const out = await confiancaDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'Tenho certeza que entendo vendas.', created_at: new Date() },
      ],
      self_model_skills: [{ skill_name: 'vendas', confidence: 0.1, evidence_count: 1 }],
    });

    expect(out).toBeNull();
  });
});
