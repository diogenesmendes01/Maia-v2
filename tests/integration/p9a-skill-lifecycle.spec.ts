/**
 * P9a Task 9 — integration test do ciclo de vida da Skill (mocked).
 *
 * Cobre os 6 cenários do plan:
 *  1. propose → activate → findActive
 *  2. skill executável após ativação
 *  3. nova versão deprecia anterior
 *  4. rollback reativa anterior
 *  5. capability_proposal flow (capability_type='skill')
 *  6. policy_blocked respeitado pre-execução
 *
 * Sem DB real — usa mocks in-memory para skillsRepo + mode handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// Set flag ON for the whole suite
vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => true) },
}));

// In-memory state for mocked skillsRepo
type SkillRow = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  procedure: any;
  input_schema: any;
  output_schema: any;
  policy_descriptors: string[];
  allowed_tools: string[];
  runtime_hints: any;
  status: string;
  version: number;
  goal: string;
  when_to_use: string;
  approved_by: string | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  [k: string]: any;
};
const skillsState: Record<string, SkillRow> = {};
let counter = 0;

function key(s: SkillRow) {
  return `${s.tenant_id}:${s.agent_id ?? 'tw'}:${s.skill_descriptor}`;
}

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    skillsRepo: {
      async propose(input: any) {
        counter++;
        const tenant = input.tenant_id ?? 'default';
        const agent = input.agent_id ?? null;
        const sameKey = Object.values(skillsState).filter(
          (s) =>
            s.tenant_id === tenant &&
            s.agent_id === agent &&
            s.skill_descriptor === input.skill_descriptor,
        );
        const ver = sameKey.reduce((m, s) => Math.max(m, s.version), 0) + 1;
        const row: SkillRow = {
          id: `s-${counter}`,
          tenant_id: tenant,
          agent_id: agent,
          skill_descriptor: input.skill_descriptor,
          category: input.category,
          execution_mode: input.execution_mode,
          goal: input.goal,
          when_to_use: input.when_to_use,
          procedure: input.procedure ?? {},
          input_schema: input.input_schema,
          output_schema: input.output_schema,
          policy_descriptors: input.policy_descriptors ?? [],
          allowed_tools: input.allowed_tools ?? [],
          runtime_hints: input.runtime_hints ?? {},
          status: 'proposed',
          version: ver,
          approved_by: null,
          rolled_back_at: null,
          rollback_reason: null,
        };
        skillsState[row.id] = row;
        return row;
      },
      async findActive(descriptor: string, agent_id?: string | null) {
        return (
          Object.values(skillsState).find(
            (s) =>
              s.skill_descriptor === descriptor &&
              s.status === 'active' &&
              (agent_id === undefined || s.agent_id === agent_id),
          ) ?? null
        );
      },
      async listByCategory(category: string) {
        return Object.values(skillsState).filter((s) => s.category === category && s.status === 'active');
      },
      async activate(id: string, approver: string) {
        const t = skillsState[id];
        if (!t) throw new Error('skill_not_found');
        if (t.status !== 'proposed') throw new Error('cannot_activate');
        for (const s of Object.values(skillsState)) {
          if (key(s) === key(t) && s.status === 'active') s.status = 'deprecated';
        }
        t.status = 'active';
        t.approved_by = approver;
        return t;
      },
      async deprecate(id: string) {
        const t = skillsState[id];
        if (!t) throw new Error('skill_not_found');
        t.status = 'deprecated';
        return t;
      },
      async rollback(id: string, reason: string) {
        const t = skillsState[id];
        if (!t) throw new Error('skill_not_found');
        t.status = 'rolled_back';
        t.rolled_back_at = new Date();
        t.rollback_reason = reason;
        const prev = Object.values(skillsState).find(
          (s) => key(s) === key(t) && s.version === t.version - 1,
        );
        if (prev && prev.status === 'deprecated') prev.status = 'active';
        return t;
      },
      async getById(id: string) {
        return skillsState[id] ?? null;
      },
      async getByDescriptor(d: string, v?: number) {
        const all = Object.values(skillsState).filter(
          (s) => s.skill_descriptor === d && (v === undefined || s.version === v),
        );
        all.sort((a, b) => b.version - a.version);
        return all[0] ?? null;
      },
      async listVersions(d: string) {
        return Object.values(skillsState)
          .filter((s) => s.skill_descriptor === d)
          .sort((a, b) => b.version - a.version);
      },
    },
    capabilityProposalsRepo: {
      ...actual.capabilityProposalsRepo,
      create: vi.fn(async (input: any) => ({ id: `prop-${counter++}`, ...input })),
    },
  };
});

vi.mock('@/cognition/runner.js', async () => {
  const actual = await vi.importActual<typeof import('@/cognition/runner.js')>(
    '@/cognition/runner.js',
  );
  return {
    ...actual,
    runCognitiveModule: vi.fn(async (_opts: any, fn: any) => {
      try {
        const out = await fn();
        return { output: out, status: 'success', fallback_triggered: false, latency_ms: 1 };
      } catch (err) {
        const msg = (err as Error).message;
        const status = msg === 'timeout' ? 'timeout' : 'error';
        return { output: null, status, fallback_triggered: true, latency_ms: 1 };
      }
    }),
  };
});

vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => {
  const resolveDescriptors = vi.fn(async (_args: any) => ({ resolved: [], unresolved: [] }));
  return { policyDescriptorResolver: { resolveDescriptors } };
});

vi.mock('@/skills/modes/prompt-only.js', () => ({
  promptOnlyMode: vi.fn(async () => ({ classification: 'positive' })),
  parseJsonResponse: vi.fn(),
}));

vi.mock('@/skills/modes/procedure-adapter.js', () => ({
  procedureAdapterMode: vi.fn(async () => ({ procedure_execution_id: 'exec-x' })),
}));

vi.mock('@/skills/modes/tool-mediated.js', () => ({
  toolMediatedMode: vi.fn(async () => ({ ok: true })),
  setToolDispatcher: vi.fn(),
}));

vi.mock('@/skills/modes/evaluator.js', () => ({
  evaluatorMode: vi.fn(async () => ({ score: 0.9, verdict: 'pass', reasons: [] })),
  parseEvaluatorOutput: vi.fn(),
}));

import { skillsRepo, capabilityProposalsRepo } from '@/db/repositories.js';
import { runSkill } from '@/skills/skill-runner.js';
import { policyDescriptorResolver } from '@/control-plane/policy/policy-descriptor-resolver.js';

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

describe('P9a Skill Lifecycle — E2E (mocked)', () => {
  beforeEach(() => {
    for (const k of Object.keys(skillsState)) delete skillsState[k];
    counter = 0;
    vi.clearAllMocks();
    vi.mocked(policyDescriptorResolver.resolveDescriptors).mockResolvedValue({
      resolved: [],
      unresolved: [],
    });
  });

  it('cenário 1: propose → activate → findActive', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const proposal = await skillsRepo.propose({ ...baseInput });
      expect(proposal.status).toBe('proposed');
      const activated = await skillsRepo.activate(proposal.id, 'owner@maia');
      expect(activated.status).toBe('active');
      const found = await skillsRepo.findActive(baseInput.skill_descriptor);
      expect(found?.id).toBe(activated.id);
    });
  });

  it('cenário 2: skill é executável após ativação', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const p = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(p.id, 'owner');
      const result = await runSkill({
        skill_descriptor: baseInput.skill_descriptor,
        input: { msg: 'test' },
        triggered_by: 'user_message',
      });
      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ classification: 'positive' });
      expect(result.trace.skill_id).toBe(p.id);
    });
  });

  it('cenário 3: nova versão deprecia anterior', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const v1 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v1.id, 'owner');
      const v2 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v2.id, 'owner');
      const v1Check = await skillsRepo.getById(v1.id);
      expect(v1Check?.status).toBe('deprecated');
      const found = await skillsRepo.findActive(baseInput.skill_descriptor);
      expect(found?.id).toBe(v2.id);
    });
  });

  it('cenário 4: rollback reativa versão anterior', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const v1 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v1.id, 'owner');
      const v2 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v2.id, 'owner');
      await skillsRepo.rollback(v2.id, 'too aggressive', 'admin');
      const v1Check = await skillsRepo.getById(v1.id);
      const v2Check = await skillsRepo.getById(v2.id);
      expect(v2Check?.status).toBe('rolled_back');
      expect(v1Check?.status).toBe('active');
      const found = await skillsRepo.findActive(baseInput.skill_descriptor);
      expect(found?.id).toBe(v1.id);
    });
  });

  it('cenário 5: capability_proposals integra capability_type=skill', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const created = await capabilityProposalsRepo.create({
        capability_type: 'skill',
        title: 'detect_pii',
        description: 'Skill to detect PII',
        proposed_spec: { skill_descriptor: 'detect_pii', goal: 'detect PII' },
        motivation: 'Compliance LGPD',
        test_scenarios: [],
      });
      expect(created.id).toBeDefined();
      expect(capabilityProposalsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ capability_type: 'skill' }),
      );
    });
  });

  it('cenário 6: policy_blocked é respeitado pre-execução', async () => {
    vi.mocked(policyDescriptorResolver.resolveDescriptors).mockResolvedValue({
      resolved: [
        { policy_id: 'p-block', descriptor: 'critical', effect: 'block', reason: 'compliance hold' },
      ],
      unresolved: [],
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const p = await skillsRepo.propose({
        ...baseInput,
        policy_descriptors: ['critical'],
      });
      await skillsRepo.activate(p.id, 'owner');
      const result = await runSkill({
        skill_descriptor: baseInput.skill_descriptor,
        input: {},
        triggered_by: 'user_message',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('policy_blocked');
      expect(result.message).toBe('compliance hold');
    });
  });
});
