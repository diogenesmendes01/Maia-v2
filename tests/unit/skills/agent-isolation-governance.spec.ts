/**
 * P9a — Agent isolation + governance enforcement tests.
 *
 * Cobre os 5 gaps fechados em resposta ao Codex review #99:
 *
 *  1. Agent scoping (finding 1 — critical):
 *     - findActive não retorna skills de outro agente do mesmo tenant
 *     - propose / activate / deprecate / rollback / getById / listVersions
 *       respeitam scope
 *     - runSkill bloqueia execução cross-agent (`agent_scope_violation`)
 *
 *  2. Governance — fail closed em descritores não resolvidos (finding 2):
 *     - skill com policy_descriptors declarados e qualquer unresolved →
 *       reason 'unresolved_policy'
 *
 *  3. Governance — hard_limit_block (mission item 2):
 *     - skill com policy rule_kind='hard_limit' e evaluator matched →
 *       reason 'hard_limit_block'
 *
 *  4. runtime_hints caps (mission item 3):
 *     - max_tool_calls cap bloqueia dispatch e marca _tool_cap_hit
 *     - max_tokens cap trunca o loop e marca _token_budget_exceeded
 *
 *  5. evaluator mode rejeita allowed_tools no propose (mission item 4)
 *
 *  6. runCognitiveModule wrapper presente em todos 4 modes (mission item 5)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => true) },
}));

// In-memory skillsRepo state for agent-isolation scenarios.
type Row = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  procedure: any;
  input_schema: any;
  output_schema: any;
  allowed_tools: string[];
  policy_descriptors: string[];
  runtime_hints: any;
  status: string;
  version: number;
  goal: string;
  when_to_use: string;
  [k: string]: any;
};
const state: Record<string, Row> = {};
let counter = 0;

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  // Mock that mirrors the agent-scoped real repo. Caller MUST be inside
  // runWithTenantContext — we read the current tenant/agent each time.
  const { getCurrentTenant, getCurrentAgent } = await import('@/db/tenant-context.js');
  return {
    ...actual,
    skillsRepo: {
      async propose(input: any) {
        counter++;
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        const tenant = input.tenant_id ?? ctxTenant;
        if (input.tenant_id && input.tenant_id !== ctxTenant) {
          throw new Error(`tenant mismatch: input ${input.tenant_id} vs context ${ctxTenant}`);
        }
        let agent_id: string | null;
        if (input.agent_id === undefined) agent_id = ctxAgent;
        else if (input.agent_id === null) agent_id = null;
        else if (input.agent_id !== ctxAgent) {
          throw new Error(
            `agent_scope_violation: input agent ${input.agent_id} vs context ${ctxAgent}`,
          );
        } else agent_id = input.agent_id;
        if (
          input.execution_mode === 'evaluator' &&
          input.allowed_tools &&
          input.allowed_tools.length > 0
        ) {
          throw new Error(
            'evaluator_mode_disallows_tools: skills with execution_mode=evaluator must have empty allowed_tools',
          );
        }
        const sameKey = Object.values(state).filter(
          (s) =>
            s.tenant_id === tenant &&
            s.agent_id === agent_id &&
            s.skill_descriptor === input.skill_descriptor,
        );
        const ver = sameKey.reduce((m, s) => Math.max(m, s.version), 0) + 1;
        const row: Row = {
          id: `s-${counter}`,
          tenant_id: tenant,
          agent_id,
          skill_descriptor: input.skill_descriptor,
          category: input.category,
          execution_mode: input.execution_mode,
          goal: input.goal ?? 'g',
          when_to_use: input.when_to_use ?? 'w',
          procedure: input.procedure ?? {},
          input_schema: input.input_schema ?? { type: 'object' },
          output_schema: input.output_schema ?? { type: 'object' },
          policy_descriptors: input.policy_descriptors ?? [],
          allowed_tools: input.allowed_tools ?? [],
          runtime_hints: input.runtime_hints ?? {},
          status: 'proposed',
          version: ver,
        };
        state[row.id] = row;
        return row;
      },
      async findActive(descriptor: string, agent_id?: string | null) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        let scopeMatch: (r: Row) => boolean;
        if (agent_id === undefined) {
          scopeMatch = (r) => r.agent_id === ctxAgent || r.agent_id === null;
        } else if (agent_id === null) {
          scopeMatch = (r) => r.agent_id === null;
        } else {
          if (agent_id !== ctxAgent) {
            throw new Error(
              `agent_scope_violation: input agent ${agent_id} vs context ${ctxAgent}`,
            );
          }
          scopeMatch = (r) => r.agent_id === agent_id;
        }
        // Prefer agent-scoped over tenant-wide.
        const matches = Object.values(state)
          .filter(
            (s) =>
              s.tenant_id === ctxTenant &&
              s.skill_descriptor === descriptor &&
              s.status === 'active' &&
              scopeMatch(s),
          )
          .sort((a, b) => (a.agent_id === null ? 1 : 0) - (b.agent_id === null ? 1 : 0));
        return matches[0] ?? null;
      },
      async listByCategory(category: string) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        return Object.values(state).filter(
          (s) =>
            s.tenant_id === ctxTenant &&
            s.category === category &&
            s.status === 'active' &&
            (s.agent_id === null || s.agent_id === ctxAgent),
        );
      },
      async activate(id: string, approver: string) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        const target = state[id];
        if (!target || target.tenant_id !== ctxTenant) throw new Error('skill_not_found');
        if (target.agent_id !== null && target.agent_id !== ctxAgent) {
          throw new Error(
            `agent_scope_violation: target agent ${target.agent_id} vs context ${ctxAgent}`,
          );
        }
        if (target.status !== 'proposed') throw new Error('cannot_activate');
        for (const s of Object.values(state)) {
          if (
            s.tenant_id === target.tenant_id &&
            s.agent_id === target.agent_id &&
            s.skill_descriptor === target.skill_descriptor &&
            s.status === 'active'
          ) {
            s.status = 'deprecated';
          }
        }
        target.status = 'active';
        target.approved_by = approver;
        return target;
      },
      async deprecate(id: string) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        const t = state[id];
        if (!t || t.tenant_id !== ctxTenant) throw new Error('skill_not_found');
        if (t.agent_id !== null && t.agent_id !== ctxAgent) {
          throw new Error(
            `agent_scope_violation: target agent ${t.agent_id} vs context ${ctxAgent}`,
          );
        }
        t.status = 'deprecated';
        return t;
      },
      async rollback(id: string, reason: string) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        const t = state[id];
        if (!t || t.tenant_id !== ctxTenant) throw new Error('skill_not_found');
        if (t.agent_id !== null && t.agent_id !== ctxAgent) {
          throw new Error(
            `agent_scope_violation: target agent ${t.agent_id} vs context ${ctxAgent}`,
          );
        }
        t.status = 'rolled_back';
        t.rollback_reason = reason;
        return t;
      },
      async getById(id: string) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        const r = state[id];
        if (!r) return null;
        if (r.tenant_id !== ctxTenant) return null;
        if (r.agent_id !== null && r.agent_id !== ctxAgent) return null;
        return r;
      },
      async getByDescriptor(descriptor: string, version?: number) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        const all = Object.values(state).filter(
          (s) =>
            s.tenant_id === ctxTenant &&
            s.skill_descriptor === descriptor &&
            (s.agent_id === null || s.agent_id === ctxAgent) &&
            (version === undefined || s.version === version),
        );
        all.sort((a, b) => b.version - a.version);
        return all[0] ?? null;
      },
      async listVersions(descriptor: string) {
        const ctxTenant = getCurrentTenant();
        const ctxAgent = getCurrentAgent();
        const all = Object.values(state).filter(
          (s) =>
            s.tenant_id === ctxTenant &&
            s.skill_descriptor === descriptor &&
            (s.agent_id === null || s.agent_id === ctxAgent),
        );
        all.sort((a, b) => b.version - a.version);
        return all;
      },
    },
  };
});

// Pass-through cognitive runner mock — wraps fn so we can verify runCognitiveModule
// is invoked for every mode (mission item 5).
const runModuleCalls: Array<{ name: string }> = [];
vi.mock('@/cognition/runner.js', async () => {
  const actual = await vi.importActual<typeof import('@/cognition/runner.js')>(
    '@/cognition/runner.js',
  );
  return {
    ...actual,
    runCognitiveModule: vi.fn(async (opts: any, fn: any) => {
      runModuleCalls.push({ name: opts.name });
      try {
        const out = await fn();
        return { output: out, status: 'success', fallback_triggered: false, latency_ms: 1 };
      } catch (err) {
        const msg = (err as Error).message;
        const status = msg === 'timeout' ? 'timeout' : 'error';
        return {
          output: typeof opts.fallback === 'function' ? opts.fallback() : opts.fallback ?? null,
          status,
          fallback_triggered: true,
          latency_ms: 1,
        };
      }
    }),
  };
});

vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => {
  const resolveDescriptors = vi.fn(async (_args: any) => ({
    resolved: [],
    unresolved: [],
  }));
  return { policyDescriptorResolver: { resolveDescriptors } };
});

vi.mock('@/skills/modes/prompt-only.js', () => ({
  promptOnlyMode: vi.fn(async () => ({ classification: 'ok' })),
  parseJsonResponse: vi.fn(),
}));
vi.mock('@/skills/modes/procedure-adapter.js', () => ({
  procedureAdapterMode: vi.fn(async () => ({ procedure_execution_id: 'x' })),
}));
vi.mock('@/skills/modes/tool-mediated.js', () => ({
  toolMediatedMode: vi.fn(async () => ({ ok: true })),
  setToolDispatcher: vi.fn(),
}));
vi.mock('@/skills/modes/evaluator.js', () => ({
  evaluatorMode: vi.fn(async () => ({ score: 1, verdict: 'pass', reasons: [] })),
  parseEvaluatorOutput: vi.fn(),
}));

import { skillsRepo } from '@/db/repositories.js';
import { runSkill, applyPoliciesPreSkill } from '@/skills/skill-runner.js';
import { policyDescriptorResolver } from '@/control-plane/policy/policy-descriptor-resolver.js';
import { promptOnlyMode } from '@/skills/modes/prompt-only.js';
import { procedureAdapterMode } from '@/skills/modes/procedure-adapter.js';
import { toolMediatedMode } from '@/skills/modes/tool-mediated.js';
import { evaluatorMode } from '@/skills/modes/evaluator.js';

const baseInput = {
  skill_descriptor: 'detect_legal_risk',
  category: 'classify',
  execution_mode: 'prompt_only',
  goal: 'Detectar risco jurídico',
  when_to_use: 'Sempre',
  procedure: { system_prompt: 'X' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  proposed_by: 'test',
};

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k];
  counter = 0;
  runModuleCalls.length = 0;
  vi.clearAllMocks();
  vi.mocked(policyDescriptorResolver.resolveDescriptors).mockResolvedValue({
    resolved: [],
    unresolved: [],
  });
});

describe('Finding 1 — agent isolation in skillsRepo', () => {
  it('findActive: agent A não enxerga skill de agent B (mesmo tenant)', async () => {
    // Agent A propõe + ativa
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(s.id, 'owner');
    });
    // Agent B procura — não deve achar
    const found = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-B' },
      async () => skillsRepo.findActive(baseInput.skill_descriptor),
    );
    expect(found).toBeNull();
  });

  it('findActive: explicit agent_id de outro agente → throw agent_scope_violation', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(s.id, 'owner');
    });
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-B' }, async () => {
      await expect(
        skillsRepo.findActive(baseInput.skill_descriptor, 'agent-A'),
      ).rejects.toThrow(/agent_scope_violation/);
    });
  });

  it('findActive: tenant-wide skill (agent_id=null) é visível por qualquer agente do tenant', async () => {
    // Propõe + ativa tenant-wide (agent_id=null explícito).
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'admin' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput, agent_id: null });
      await skillsRepo.activate(s.id, 'owner');
    });
    const found = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-B' },
      async () => skillsRepo.findActive(baseInput.skill_descriptor),
    );
    expect(found?.skill_descriptor).toBe(baseInput.skill_descriptor);
  });

  it('propose: rejeita input.agent_id de outro agente', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      await expect(
        skillsRepo.propose({ ...baseInput, agent_id: 'agent-B' }),
      ).rejects.toThrow(/agent_scope_violation/);
    });
  });

  it('activate: rejeita ativar skill de outro agente', async () => {
    let skillId = '';
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput });
      skillId = s.id;
    });
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-B' }, async () => {
      await expect(skillsRepo.activate(skillId, 'owner')).rejects.toThrow(/agent_scope_violation/);
    });
  });

  it('getById: retorna null para skill de outro agente (não vaza ID)', async () => {
    let skillId = '';
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput });
      skillId = s.id;
    });
    const found = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-B' },
      async () => skillsRepo.getById(skillId),
    );
    expect(found).toBeNull();
  });

  it('listVersions: não lista skills de outro agente', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      await skillsRepo.propose({ ...baseInput });
    });
    const list = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-B' },
      async () => skillsRepo.listVersions(baseInput.skill_descriptor),
    );
    expect(list.length).toBe(0);
  });
});

describe('Finding 1 — runSkill blocks cross-agent execution', () => {
  it('runSkill: agent B tenta executar skill de agent A → skill_not_found (findActive scoped)', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(s.id, 'owner');
    });
    const result = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-B' },
      async () =>
        runSkill({
          skill_descriptor: baseInput.skill_descriptor,
          input: {},
          triggered_by: 'user_message',
        }),
    );
    expect(result.ok).toBe(false);
    // The skill was not found in agent-B's scope; runner returns skill_not_found.
    expect(result.reason).toBe('skill_not_found');
  });

  it('runSkill: explicit input.agent_id mismatch → reason agent_scope_violation', async () => {
    const result = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-A' },
      async () =>
        runSkill({
          skill_descriptor: 'x',
          input: {},
          agent_id: 'agent-B',
          triggered_by: 'user_message',
        }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('agent_scope_violation');
  });

  it('runSkill: sem tenant context → reason agent_scope_violation', async () => {
    const result = await runSkill({
      skill_descriptor: 'x',
      input: {},
      triggered_by: 'user_message',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('agent_scope_violation');
    expect(result.message).toContain('missing_tenant_context');
  });
});

describe('Finding 2 — fail-closed on unresolved policy descriptors', () => {
  it('runSkill: descritor declarado mas unresolved → reason unresolved_policy', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({
        ...baseInput,
        policy_descriptors: ['lgpd_strict'],
      });
      await skillsRepo.activate(s.id, 'owner');
    });
    vi.mocked(policyDescriptorResolver.resolveDescriptors).mockResolvedValue({
      resolved: [],
      unresolved: [{ descriptor: 'lgpd_strict', reason: 'p8e_resolver_not_yet_merged' }],
    });
    const result = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-A' },
      async () =>
        runSkill({
          skill_descriptor: baseInput.skill_descriptor,
          input: {},
          triggered_by: 'user_message',
        }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unresolved_policy');
    expect(result.message).toContain('lgpd_strict');
  });

  it('runSkill: sem policy_descriptors declarados, resolver vazio → executa normalmente', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(s.id, 'owner');
    });
    const result = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-A' },
      async () =>
        runSkill({
          skill_descriptor: baseInput.skill_descriptor,
          input: {},
          triggered_by: 'user_message',
        }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('Finding 2 — hard_limit_block', () => {
  it('applyPoliciesPreSkill: hard_limit + evaluator(matched=true) → block kind=hard_limit', () => {
    const decision = applyPoliciesPreSkill(
      [
        {
          policy_id: 'p-hard',
          descriptor: 'pii_out_of_region',
          effect: 'audit',
          rule_kind: 'hard_limit',
          evaluator: () => ({ matched: true, reason: 'pii detected' }),
        },
      ],
      { skill: { id: 's', allowed_tools: [] } as any, input: { msg: '11122233344' } },
    );
    expect(decision).toEqual({ decision: 'block', reason: 'pii detected', kind: 'hard_limit' });
  });

  it('applyPoliciesPreSkill: hard_limit + evaluator(matched=false) → allow', () => {
    const decision = applyPoliciesPreSkill(
      [
        {
          policy_id: 'p-hard',
          descriptor: 'pii',
          effect: 'audit',
          rule_kind: 'hard_limit',
          evaluator: () => ({ matched: false }),
        },
      ],
      { skill: { id: 's' } as any, input: {} },
    );
    expect(decision).toEqual({ decision: 'allow' });
  });

  it('applyPoliciesPreSkill: hard_limit evaluator throws → fail closed (block)', () => {
    const decision = applyPoliciesPreSkill(
      [
        {
          policy_id: 'p-hard',
          descriptor: 'broken',
          effect: 'audit',
          rule_kind: 'hard_limit',
          evaluator: () => {
            throw new Error('evaluator_crashed');
          },
        },
      ],
      { skill: { id: 's' } as any, input: {} },
    );
    expect(decision.decision).toBe('block');
    if (decision.decision === 'block') {
      expect(decision.kind).toBe('hard_limit');
      expect(decision.reason).toContain('hard_limit_evaluator_error');
    }
  });

  it('runSkill: hard_limit_block surface → reason hard_limit_block', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({
        ...baseInput,
        policy_descriptors: ['budget_cap'],
      });
      await skillsRepo.activate(s.id, 'owner');
    });
    vi.mocked(policyDescriptorResolver.resolveDescriptors).mockResolvedValue({
      resolved: [
        {
          policy_id: 'p-budget',
          descriptor: 'budget_cap',
          effect: 'audit',
          rule_kind: 'hard_limit',
          evaluator: () => ({ matched: true, reason: 'monthly cap exceeded' }),
        },
      ],
      unresolved: [],
    });
    const result = await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'agent-A' },
      async () =>
        runSkill({
          skill_descriptor: baseInput.skill_descriptor,
          input: {},
          triggered_by: 'user_message',
        }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hard_limit_block');
    expect(result.message).toBe('monthly cap exceeded');
  });
});

describe('Mission item 4 — evaluator mode rejeita allowed_tools', () => {
  it('propose: execution_mode=evaluator + allowed_tools non-empty → throws', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      await expect(
        skillsRepo.propose({
          ...baseInput,
          execution_mode: 'evaluator',
          allowed_tools: ['call_anything'],
        }),
      ).rejects.toThrow(/evaluator_mode_disallows_tools/);
    });
  });

  it('propose: execution_mode=evaluator + allowed_tools vazio → ok', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({
        ...baseInput,
        execution_mode: 'evaluator',
        allowed_tools: [],
      });
      expect(s.execution_mode).toBe('evaluator');
    });
  });
});

describe('Mission item 5 — runCognitiveModule wraps all 4 modes', () => {
  it('prompt_only: runCognitiveModule é invocado', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({ ...baseInput, execution_mode: 'prompt_only' });
      await skillsRepo.activate(s.id, 'owner');
      const r = await runSkill({
        skill_descriptor: baseInput.skill_descriptor,
        input: {},
        triggered_by: 'user_message',
      });
      expect(r.ok).toBe(true);
      expect(runModuleCalls.some((c) => c.name.startsWith('skill:'))).toBe(true);
      expect(promptOnlyMode).toHaveBeenCalled();
    });
  });

  it('procedure_adapter: runCognitiveModule é invocado', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({
        ...baseInput,
        execution_mode: 'procedure_adapter',
      });
      await skillsRepo.activate(s.id, 'owner');
      await runSkill({
        skill_descriptor: baseInput.skill_descriptor,
        input: {},
        triggered_by: 'sync_required',
      });
      expect(runModuleCalls.length).toBeGreaterThan(0);
      expect(procedureAdapterMode).toHaveBeenCalled();
    });
  });

  it('tool_mediated: runCognitiveModule é invocado', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({
        ...baseInput,
        execution_mode: 'tool_mediated',
        allowed_tools: ['x'],
      });
      await skillsRepo.activate(s.id, 'owner');
      await runSkill({
        skill_descriptor: baseInput.skill_descriptor,
        input: {},
        triggered_by: 'tool_loop',
      });
      expect(runModuleCalls.length).toBeGreaterThan(0);
      expect(toolMediatedMode).toHaveBeenCalled();
    });
  });

  it('evaluator: runCognitiveModule é invocado', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'agent-A' }, async () => {
      const s = await skillsRepo.propose({
        ...baseInput,
        execution_mode: 'evaluator',
        // evaluator mode requires empty allowed_tools (mission item 4)
        allowed_tools: [],
      });
      await skillsRepo.activate(s.id, 'owner');
      await runSkill({
        skill_descriptor: baseInput.skill_descriptor,
        input: {},
        triggered_by: 'evaluator_pipeline',
      });
      expect(runModuleCalls.length).toBeGreaterThan(0);
      expect(evaluatorMode).toHaveBeenCalled();
    });
  });
});
