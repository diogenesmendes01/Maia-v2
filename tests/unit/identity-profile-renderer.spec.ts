/**
 * P4 Task 5 — profile-renderer: renderOperationalProfile (v3.1.1).
 *
 * Determinístico (sem async, sem LLM). Converte uma versão do perfil
 * operacional (`AgentOperationalProfileVersion`, JSONB `profile_body` em 3
 * namespaces — identity / style / metadata) em um bloco de texto que o
 * `prompt-builder` (Task 7) injeta no system prompt.
 *
 * API v3.1.1 do `RenderedProfile`:
 *   - `system_prompt_block` — identidade + estilo, sempre presente
 *   - `version_label`       — rótulo da versão (ex: "op_profile_v1")
 *
 * Removidos (v3.1.0 → v3.1.1):
 *   - `growth_hints_block`      → migrou para o Evolution Pipeline (P5/P9)
 *   - `episodic_summary_block`  → migrou para o User Layer (P8c)
 */
import { describe, it, expect } from 'vitest';
import { renderOperationalProfile } from '@/identity/profile-renderer.js';
import type { ProfileBody, AgentOperationalProfileVersion } from '@/db/schema.js';

const sampleProfile: ProfileBody = {
  schema_version: 'v3.1.1-2026-05-15',
  identity: {
    role_descriptor: 'atendimento_financeiro_pf',
    voice: { tone: 'claro_profissional', formality: 'medium', verbosity: 'concise' },
    cognitive_limits: {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: ['preservar_capital_do_cliente', 'clareza_de_comunicacao'],
    learned_voice_modifiers: [],
  },
  style: { language: 'pt-BR', rhythm: {} },
  metadata: {
    effective_from: '2026-05-15T00:00:00Z',
    created_by: 'test',
    previous_version_id: null,
  },
};

function buildVersion(
  overrides: Partial<AgentOperationalProfileVersion> = {},
): AgentOperationalProfileVersion {
  return {
    id: 'prof-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: 'active',
    profile_body: sampleProfile,
    proposed_by: 'system_seed',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: null,
    frozen_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('profile-renderer (v3.1.1)', () => {
  it('renders identity block from profile_body.identity', () => {
    const version = buildVersion();
    const rendered = renderOperationalProfile({ version });
    expect(rendered.system_prompt_block).toContain('atendimento_financeiro_pf');
    expect(rendered.system_prompt_block).toContain('preservar_capital_do_cliente');
  });

  it('renders voice tone from profile_body.identity.voice', () => {
    const version = buildVersion();
    const rendered = renderOperationalProfile({ version });
    expect(rendered.system_prompt_block).toContain('claro_profissional');
  });

  it('renders style.language from profile_body.style', () => {
    const version = buildVersion();
    const rendered = renderOperationalProfile({ version });
    expect(rendered.system_prompt_block).toContain('pt-BR');
  });

  it('renders cognitive_limits (depth, speculation cap, confidence floor)', () => {
    const version = buildVersion();
    const rendered = renderOperationalProfile({ version });
    expect(rendered.system_prompt_block).toContain('3');
    expect(rendered.system_prompt_block).toContain('0.2');
    expect(rendered.system_prompt_block).toContain('0.7');
  });

  it('renders all priorities in declared order', () => {
    const version = buildVersion();
    const rendered = renderOperationalProfile({ version });
    const block = rendered.system_prompt_block;
    const idx1 = block.indexOf('preservar_capital_do_cliente');
    const idx2 = block.indexOf('clareza_de_comunicacao');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it('priorities vazias não geram seção de prioridades', () => {
    const version = buildVersion({
      profile_body: {
        ...sampleProfile,
        identity: { ...sampleProfile.identity, priorities: [] },
      },
    });
    const rendered = renderOperationalProfile({ version });
    expect(rendered.system_prompt_block).not.toContain('Prioridades');
  });

  it('version_label reflete o número da versão', () => {
    const version = buildVersion({ version: 7 });
    const rendered = renderOperationalProfile({ version });
    expect(rendered.version_label).toBe('op_profile_v7');
  });

  it('RenderedProfile shape v3.1.1: só system_prompt_block + version_label', () => {
    const version = buildVersion();
    const rendered = renderOperationalProfile({ version });
    expect(rendered.system_prompt_block).toBeTruthy();
    expect(rendered.version_label).toBe('op_profile_v1');
    // Campos removidos em v3.1.1 — não devem existir no objeto retornado.
    expect((rendered as Record<string, unknown>).growth_hints_block).toBeUndefined();
    expect((rendered as Record<string, unknown>).episodic_summary_block).toBeUndefined();
  });
});
