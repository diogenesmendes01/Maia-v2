/**
 * P4 Task 6 — profile-renderer: renderOperationalProfile.
 *
 * Determinístico (sem async, sem LLM). Converte uma versão do perfil
 * operacional em 3 blocos de texto para o prompt-builder injetar.
 *
 * Invariante defense-in-depth: entries em `episodic_temp.entries` com
 * `mention_allowed=false` OU `proactive_use=false` NUNCA aparecem em qualquer
 * bloco renderizado. Trava de segurança em camada extra (a camada de memória
 * já faz a filtragem primária — P2 — mas o renderer também recusa, por
 * segurança).
 */
import { describe, it, expect } from 'vitest';
import { renderOperationalProfile } from '@/identity/profile-renderer.js';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';

/**
 * Build a fake AgentOperationalProfileVersion for renderer tests.
 *
 * The renderer still reads the legacy 4-layer keys (core_immutable /
 * operational_profile / episodic_temp / growth_backlog) via an `as unknown`
 * cast (migration TODO in profile-renderer.ts).  We embed them at the top
 * level of the fake row so the renderer can find them, and cast the result to
 * satisfy TypeScript without touching production code.
 *
 * When the renderer migrates to read from `profile_body`, update this helper
 * to nest the keys inside profile_body instead.
 */
function buildVersion(
  overrides: Record<string, unknown>,
): AgentOperationalProfileVersion {
  return {
    id: 'prof-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: 'active',
    // profile_body satisfies the Drizzle type; legacy keys are merged at the
    // top level so the renderer's `(version as unknown).core_immutable` cast works.
    profile_body: {} as unknown as AgentOperationalProfileVersion['profile_body'],
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
  } as unknown as AgentOperationalProfileVersion;
}

describe('renderOperationalProfile', () => {
  it('1. full profile renders 3 blocks with expected text', () => {
    const version = buildVersion({
      core_immutable: {
        identity_block: 'Você é a **Maia**, assistente financeira do Mendes.',
        principles: [
          'Separação acima de tudo. PF é PF.',
          'Confirme antes de agir em coisas relevantes.',
        ],
      },
      operational_profile: {
        voice_descriptor: 'Português brasileiro, registro coloquial-profissional.',
        thresholds: {
          confirm_limit_brl: 500,
          tone: 'direta',
        },
      },
      episodic_temp: {
        entries: [
          {
            summary: 'Mendes consolidou três contas em janeiro.',
            mention_allowed: true,
            proactive_use: true,
          },
        ],
      },
      growth_backlog: {
        items: [
          { descricao: 'Reconciliação automática mensal' },
        ],
      },
    });

    const result = renderOperationalProfile({ version });

    // system_prompt_block: identidade + princípios + voz + parâmetros
    expect(result.system_prompt_block).toContain('Você é a **Maia**');
    expect(result.system_prompt_block).toContain('## Princípios');
    expect(result.system_prompt_block).toContain('- Separação acima de tudo. PF é PF.');
    expect(result.system_prompt_block).toContain(
      '- Confirme antes de agir em coisas relevantes.',
    );
    expect(result.system_prompt_block).toContain('## Voz operacional');
    expect(result.system_prompt_block).toContain('Português brasileiro');
    expect(result.system_prompt_block).toContain('## Parâmetros calibrados');
    expect(result.system_prompt_block).toContain('- confirm_limit_brl: 500');
    expect(result.system_prompt_block).toContain('- tone: direta');

    // growth_hints_block
    expect(result.growth_hints_block).not.toBeNull();
    expect(result.growth_hints_block).toContain(
      '## Capacidades em desenvolvimento (aprovadas, ainda não consolidadas)',
    );
    expect(result.growth_hints_block).toContain('- Reconciliação automática mensal');

    // episodic_summary_block
    expect(result.episodic_summary_block).not.toBeNull();
    expect(result.episodic_summary_block).toContain('## Contexto recente');
    expect(result.episodic_summary_block).toContain(
      '- Mendes consolidou três contas em janeiro.',
    );
  });

  it('2. growth_backlog vazio → growth_hints_block === null', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'identidade' },
      growth_backlog: [],
    });

    const result = renderOperationalProfile({ version });
    expect(result.growth_hints_block).toBeNull();
    // system_prompt_block ainda é populado.
    expect(result.system_prompt_block).toContain('identidade');
  });

  it('3. episodic_temp vazio → episodic_summary_block === null', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'identidade' },
      episodic_temp: {},
    });

    const result = renderOperationalProfile({ version });
    expect(result.episodic_summary_block).toBeNull();
  });

  it('4. episodic entry com mention_allowed=false é OMITIDA (defense in depth)', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'identidade' },
      episodic_temp: {
        entries: [
          {
            summary: 'segredo que NUNCA deve vazar',
            mention_allowed: false,
            proactive_use: true,
          },
        ],
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.episodic_summary_block).toBeNull();
    // Garantia adicional: o segredo não aparece em NENHUM bloco.
    expect(result.system_prompt_block).not.toContain('segredo');
  });

  it('5. episodic entry com proactive_use=false é OMITIDA mesmo se mention_allowed=true (defense in depth)', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'identidade' },
      episodic_temp: {
        entries: [
          {
            summary: 'memória que pode ser mencionada se perguntado, mas não proativamente',
            mention_allowed: true,
            proactive_use: false,
          },
        ],
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.episodic_summary_block).toBeNull();
    expect(result.system_prompt_block).not.toContain('proativamente');
  });

  it('bonus: mixed episodic entries — only fully-allowed ones are included', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'id' },
      episodic_temp: {
        entries: [
          {
            summary: 'permitida 1',
            mention_allowed: true,
            proactive_use: true,
          },
          {
            summary: 'bloqueada por mention_allowed',
            mention_allowed: false,
            proactive_use: true,
          },
          {
            summary: 'bloqueada por proactive_use',
            mention_allowed: true,
            proactive_use: false,
          },
          {
            summary: 'permitida 2',
            mention_allowed: true,
            proactive_use: true,
          },
        ],
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.episodic_summary_block).toContain('- permitida 1');
    expect(result.episodic_summary_block).toContain('- permitida 2');
    expect(result.episodic_summary_block).not.toContain('bloqueada por mention_allowed');
    expect(result.episodic_summary_block).not.toContain('bloqueada por proactive_use');
  });

  it('bonus: episodic entry without explicit flags (defaults restrictive) is OMITTED', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'id' },
      episodic_temp: {
        entries: [
          {
            summary: 'sem flags explícitas — padrão restritivo, deve ser omitido',
          },
        ],
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.episodic_summary_block).toBeNull();
  });

  it('bonus: growth_backlog as plain array of strings is rendered', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'id' },
      growth_backlog: ['Capacidade A', 'Capacidade B'],
    });

    const result = renderOperationalProfile({ version });
    expect(result.growth_hints_block).toContain('- Capacidade A');
    expect(result.growth_hints_block).toContain('- Capacidade B');
  });

  it('bonus: growth_backlog as object with items[] is rendered', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'id' },
      growth_backlog: {
        items: [{ descricao: 'feature X' }, { descricao: 'feature Y' }],
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.growth_hints_block).toContain('- feature X');
    expect(result.growth_hints_block).toContain('- feature Y');
  });

  it('bonus: empty principles array produces NO "## Princípios" section', () => {
    const version = buildVersion({
      core_immutable: {
        identity_block: 'só identidade',
        principles: [],
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.system_prompt_block).toBe('só identidade');
    expect(result.system_prompt_block).not.toContain('## Princípios');
  });

  it('bonus: empty thresholds object produces NO "## Parâmetros calibrados" section', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'id' },
      operational_profile: {
        voice_descriptor: 'voz',
        thresholds: {},
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.system_prompt_block).not.toContain('## Parâmetros calibrados');
    expect(result.system_prompt_block).toContain('## Voz operacional');
  });

  // -------------------------------------------------------------------------
  // Migration-061 / Codex review #163 coverage:
  // After migration 061 added `profile_body` alongside the legacy columns,
  // the renderer must still produce the same output for rows with ONLY
  // legacy data (existing active profiles), AND it must derive a minimum
  // render from rows that have ONLY profile_body (newly created via the
  // admin-ui agent setup flow). Mixed rows prefer the explicit legacy
  // columns because profile_body lacks the legacy-only fields (principles
  // detail, thresholds, etc.).
  // -------------------------------------------------------------------------

  it('legacy-only row (pre-061 data) still renders the legacy blocks', () => {
    const version = buildVersion({
      core_immutable: {
        identity_block: 'Você é a Maia.',
        principles: ['Separação acima de tudo.'],
      },
      operational_profile: { voice_descriptor: 'Direta e profissional.' },
    });
    const result = renderOperationalProfile({ version });
    expect(result.system_prompt_block).toContain('Você é a Maia.');
    expect(result.system_prompt_block).toContain('## Princípios');
    expect(result.system_prompt_block).toContain('- Separação acima de tudo.');
    expect(result.system_prompt_block).toContain('## Voz operacional');
    expect(result.system_prompt_block).toContain('Direta e profissional.');
  });

  it('profile_body-only row (post-admin-ui setup) renders identity + voice', () => {
    const version = buildVersion({
      // Legacy columns are missing (or empty {} from the column DEFAULT after
      // an old DB ran migration 061). The renderer falls back to profile_body.
      profile_body: {
        schema_version: 'v3.1.1-2026-05-15',
        identity: {
          role_descriptor: 'Você é a Acme Bot.',
          voice: { tone: 'caloroso e direto', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: ['precisao', 'clareza'],
          learned_voice_modifiers: [],
        },
        style: { language: 'pt-BR', rhythm: {} },
        metadata: { effective_from: '', created_by: 'system', previous_version_id: null },
      },
    });
    const result = renderOperationalProfile({ version });
    expect(result.system_prompt_block).toContain('Você é a Acme Bot.');
    expect(result.system_prompt_block).toContain('## Princípios');
    expect(result.system_prompt_block).toContain('- precisao');
    expect(result.system_prompt_block).toContain('- clareza');
    expect(result.system_prompt_block).toContain('## Voz operacional');
    expect(result.system_prompt_block).toContain('caloroso e direto');
  });

  it('Drizzle-shaped row (legacy keys direct under profile_body) renders full legacy payload', () => {
    // This is THE production case (Codex review #163 round 3):
    // `seedInitialOperationalProfile` writes legacy keys (core_immutable,
    // operational_profile, episodic_temp, growth_backlog) DIRECTLY under
    // profile_body. Migration 061 backfills the same shape. The renderer
    // MUST read from there.
    const version = buildVersion({
      // No top-level legacy fields — Drizzle returns ONLY profile_body.
      profile_body: {
        schema_version: 'v3.1.1-2026-05-15',
        identity: {
          // Canonical fields are present but should be ignored when the
          // direct-embed legacy keys carry the authoritative payload.
          role_descriptor: 'derived role (synthesized — should be ignored)',
          voice: { tone: 'derived tone (synthesized — should be ignored)' },
          priorities: ['derived (should be ignored)'],
        },
        // Direct-embed: how proposal-generator + migration 061 write it.
        core_immutable: {
          identity_block: 'Você é a Maia (do profile_body direct-embed).',
          principles: ['Princípio A', 'Princípio B'],
        },
        operational_profile: {
          voice_descriptor: 'Voz direct-embed.',
          thresholds: { max_inference_depth: 4 },
        },
        episodic_temp: {
          entries: [
            { summary: 'evento direct', mention_allowed: true, proactive_use: true },
          ],
        },
        growth_backlog: ['Hint direct'],
      },
    });
    const result = renderOperationalProfile({ version });
    expect(result.system_prompt_block).toContain('Você é a Maia (do profile_body direct-embed).');
    expect(result.system_prompt_block).toContain('## Princípios');
    expect(result.system_prompt_block).toContain('- Princípio A');
    expect(result.system_prompt_block).toContain('- Princípio B');
    expect(result.system_prompt_block).toContain('## Voz operacional');
    expect(result.system_prompt_block).toContain('Voz direct-embed.');
    expect(result.system_prompt_block).toContain('## Parâmetros calibrados');
    expect(result.system_prompt_block).toContain('max_inference_depth');
    expect(result.episodic_summary_block).toContain('evento direct');
    expect(result.growth_hints_block).toContain('Hint direct');
    // Canonical identity.* must NOT leak when the direct-embed is present.
    expect(result.system_prompt_block).not.toContain('derived');
  });

  it('mixed row (legacy + profile_body) prefers legacy (keeps full payload)', () => {
    // After migration 061 a row carries BOTH the legacy columns (untouched)
    // and a backfilled profile_body. The renderer must keep using the legacy
    // payload because profile_body's best-effort backfill loses things like
    // operational_profile.thresholds that the legacy column still has.
    const version = buildVersion({
      core_immutable: {
        identity_block: 'Você é a Maia (legacy).',
        principles: ['Princípio legacy 1', 'Princípio legacy 2'],
      },
      operational_profile: {
        voice_descriptor: 'Voz legacy explícita.',
        thresholds: { max_inference_depth: 3 },
      },
      profile_body: {
        identity: {
          role_descriptor: 'Você é a Maia (do profile_body, deve ser ignorada).',
          voice: { tone: 'tom do profile_body que deve ser ignorado' },
          priorities: ['this-must-not-render'],
        },
      },
    });
    const result = renderOperationalProfile({ version });
    expect(result.system_prompt_block).toContain('Você é a Maia (legacy).');
    expect(result.system_prompt_block).toContain('Voz legacy explícita.');
    expect(result.system_prompt_block).toContain('## Parâmetros calibrados');
    expect(result.system_prompt_block).not.toContain('profile_body');
    expect(result.system_prompt_block).not.toContain('this-must-not-render');
  });

  it('bonus: null/undefined threshold values are skipped silently', () => {
    const version = buildVersion({
      core_immutable: { identity_block: 'id' },
      operational_profile: {
        thresholds: {
          a: 1,
          b: null,
          c: undefined,
          d: 'foo',
        },
      },
    });

    const result = renderOperationalProfile({ version });
    expect(result.system_prompt_block).toContain('- a: 1');
    expect(result.system_prompt_block).toContain('- d: foo');
    expect(result.system_prompt_block).not.toContain('- b:');
    expect(result.system_prompt_block).not.toContain('- c:');
  });
});
