/**
 * P8a Task 14 — buildPromptFromPacket() tests.
 *
 * Validates that an ExecutionContextPacket renders into a sensible
 * system+messages prompt structure with each slice contributing.
 */
import { describe, it, expect } from 'vitest';
import { buildPromptFromPacket } from '@/runtime/prompt/build-prompt-from-packet.js';
import type { ExecutionContextPacket } from '@/runtime/context-packet/types.js';

const minimalPacket = (
  overrides?: Partial<ExecutionContextPacket>,
): ExecutionContextPacket => ({
  trace_id: 't1',
  tenant_id: 'tenant1',
  agent_id: 'agent1',
  conversation_id: 'conv1',
  base_ref: 'b1',
  decision_ref: 'd1',
  identity: {
    role_descriptor: 'maia',
    voice: { tone: 'amistoso', formality: 'medium', verbosity: 'concise' },
    cognitive_limits: {
      max_inference_depth: 2,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: ['proteger autonomia', 'preservar evidência'],
    learned_voice_modifiers: [],
    schema_version: 'v3.1.1',
    version_id: 'v1',
  },
  user: {
    pessoa: null,
    preferences: {},
    memories: [],
    behavioral_hints: [],
    truncated: false,
  },
  knowledge: { facts: [], rules: [], truncated: { facts: false, rules: false } },
  soul: {
    active_biases: [],
    rendered_block: null,
    total_active: 0,
    truncated_to: 0,
    cache_key: '',
    resolved_at: new Date(0),
  },
  policy: {
    applicable_rules: [],
    resolver_cache_key: 'k',
    truncated: false,
  },
  skill: { mode: 'candidates', selected_skill: null, candidate_skills: [] },
  tool: { available_tools: [], blocked_tools: [], requires_confirmation: [] },
  history: { turns: [], truncated: false },
  assembly_meta: {
    started_at_ms: 0,
    finished_at_ms: 50,
    duration_ms: 50,
    cache_hits: {},
    fallback_depths_applied: {},
    builder_durations_ms: {},
  },
  ...overrides,
});

describe('buildPromptFromPacket', () => {
  it('renders identity block', () => {
    const result = buildPromptFromPacket(minimalPacket());
    expect(result.system).toContain('## Identidade operacional');
    expect(result.system).toContain('Papel: maia');
    expect(result.system).toContain('proteger autonomia');
  });

  // Issue #192 — once identity-slice-builder is fixed to keep slice.priorities
  // strictly from identity.priorities, a profile migrated by 061 (priorities=[],
  // principles=[...]) renders an IdentitySlice whose .priorities is []. The
  // renderer must NOT emit a "Prioridades:" line populated with principles
  // text — otherwise migrated rows ship human principles under the priorities
  // channel until the slug migration runs. With Issue #200's principles
  // channel, principle text appears under "## Princípios" — strictly NOT
  // under "Prioridades:".
  it('Issue #192: migrated profile with priorities=[] does not render principles under "Prioridades"', () => {
    const result = buildPromptFromPacket(
      minimalPacket({
        identity: {
          role_descriptor: 'maia',
          voice: { tone: 'amistoso', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 2,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: [], // post-061 migrated row, slug migration not yet run
          learned_voice_modifiers: [],
          schema_version: 'v3.1.1',
          version_id: 'v1',
          principles: ['transparência radical', 'preservar a evidência'],
        },
      }),
    );
    // The "Prioridades:" heading must NOT appear for migrated rows.
    expect(result.system).not.toContain('Prioridades:');
    // The principle text MAY appear, but only under the "Princípios" channel
    // (Issue #200). The strict invariant: the line right after "Prioridades:"
    // must not contain principle text. Since "Prioridades:" doesn't render
    // at all here, the only place principle text can appear is under
    // "## Princípios" — which is the correct, dedicated channel.
    const prioridadesIdx = result.system.indexOf('Prioridades');
    expect(prioridadesIdx).toBe(-1);
    // Principles surface through their own channel.
    expect(result.system).toContain('## Princípios');
  });

  // Issue #200 codex review [MEDIUM] — once class builder populates
  // slice.principles for migrated rows, the renderer must emit them under
  // their OWN heading ("Princípios"), never under "Prioridades". This
  // preserves operational guidance during the rollout gap while keeping the
  // priorities/principles channels strictly separated.
  it('Issue #200 [MEDIUM]: slice.principles renders under "Princípios" heading (not "Prioridades")', () => {
    const result = buildPromptFromPacket(
      minimalPacket({
        identity: {
          role_descriptor: 'maia',
          voice: { tone: 'amistoso', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 2,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: [], // migrated row pre-slug-migration
          learned_voice_modifiers: [],
          schema_version: 'v3.1.1',
          version_id: 'v1',
          principles: ['transparência radical', 'preservar a evidência'],
        },
      }),
    );
    // Principles surface through their dedicated channel.
    expect(result.system).toContain('## Princípios');
    expect(result.system).toContain('transparência radical');
    expect(result.system).toContain('preservar a evidência');
    // And critically, NOT under the priorities heading.
    expect(result.system).not.toContain('Prioridades:');
  });

  it('Issue #200 [MEDIUM]: empty slice.principles does NOT emit the Princípios heading', () => {
    const result = buildPromptFromPacket(minimalPacket());
    expect(result.system).not.toContain('## Princípios');
  });

  it('skips empty slices (no policy, soul, knowledge, user, skill, tool)', () => {
    const result = buildPromptFromPacket(minimalPacket());
    expect(result.system).not.toContain('## Políticas');
    expect(result.system).not.toContain('## Vieses');
    expect(result.system).not.toContain('## Fatos');
    expect(result.system).not.toContain('## Tools');
  });

  it('renders policy block when applicable_rules present', () => {
    const result = buildPromptFromPacket(
      minimalPacket({
        policy: {
          applicable_rules: [
            {
              policy_id: 'p1',
              version: 1,
              rule_descriptor: 'no transfer > 5000',
              rule_kind: 'hard_limit',
              applies_to_peps: ['early', 'mid'],
              rule_body_ref: 'ref1',
            },
          ],
          resolver_cache_key: 'k',
          truncated: false,
        },
      }),
    );
    expect(result.system).toContain('## Políticas aplicáveis');
    expect(result.system).toContain('[hard_limit]');
    expect(result.system).toContain('no transfer > 5000');
  });

  it('renders tool block with side_effect / audit_level / confirmation flag', () => {
    const result = buildPromptFromPacket(
      minimalPacket({
        tool: {
          available_tools: [
            {
              name: 'transfer',
              side_effect_level: 'high',
              requires_confirmation: true,
              idempotent: false,
              audit_level: 'high',
              timeout_ms: 10000,
            },
          ],
          blocked_tools: ['admin_reset'],
          requires_confirmation: ['transfer'],
        },
      }),
    );
    expect(result.system).toContain('## Tools disponíveis');
    expect(result.system).toContain('transfer');
    expect(result.system).toContain('side_effect=high');
    expect(result.system).toContain('audit=high');
    expect(result.system).toContain('[CONFIRMAÇÃO]');
    expect(result.system).toContain('Bloqueadas: admin_reset');
  });

  it('renders user block with pessoa, memories and hints', () => {
    const result = buildPromptFromPacket(
      minimalPacket({
        user: {
          pessoa: {
            id: 'p1',
            display_name: 'Diogenes',
            locale: 'pt-BR',
          },
          preferences: { theme: 'dark' },
          memories: [
            {
              id: 'm1',
              kind: 'preference',
              content: 'prefere chamar de "Diogo"',
              confidence: 0.9,
              scope: 'pessoa',
              sensitivity: 'normal',
              proactive_use: true,
            },
          ],
          behavioral_hints: [
            { aspect: 'ritmo', suggestion: 'mais devagar', strength: 0.6 },
          ],
          truncated: false,
        },
      }),
    );
    expect(result.system).toContain('## Sobre o interlocutor');
    expect(result.system).toContain('Diogenes');
    expect(result.system).toContain('## Memória relevante');
    expect(result.system).toContain('Diogo');
    expect(result.system).toContain('## Instruções comportamentais ativas');
  });

  it('maps history turns to user/assistant messages', () => {
    const result = buildPromptFromPacket(
      minimalPacket({
        history: {
          turns: [
            { role: 'user', content: 'oi', ts: '2025-01-01T00:00:00Z' },
            { role: 'agent', content: 'olá', ts: '2025-01-01T00:00:01Z' },
            { role: 'tool', content: '{...}', ts: '2025-01-01T00:00:02Z' },
            { role: 'user', content: 'tudo bem?', ts: '2025-01-01T00:00:03Z' },
          ],
          truncated: false,
        },
      }),
    );
    expect(result.messages).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá' },
      { role: 'user', content: 'tudo bem?' },
    ]);
  });

  it('renders selected_skill block with runtime_hints', () => {
    const result = buildPromptFromPacket(
      minimalPacket({
        skill: {
          mode: 'selected_only',
          selected_skill: {
            id: 'sk1',
            name: 'transfer_money',
            version: 3,
            input_schema_ref: 'schema-in',
            output_schema_ref: 'schema-out',
            procedure_ref: 'proc1',
            constraints: {},
            success_criteria: {},
            runtime_hints: { preferred_model: 'sonnet-4.5', max_tool_calls: 3 },
          },
          candidate_skills: [],
        },
      }),
    );
    expect(result.system).toContain('## Skill');
    expect(result.system).toContain('transfer_money');
    expect(result.system).toContain('sonnet-4.5');
  });
});
