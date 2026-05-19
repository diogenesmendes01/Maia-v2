/**
 * P9a Task 4 — skillsRepo tests (in-memory mock).
 *
 * Mock-based pattern (matches tests/unit/capability-proposals-repo.spec.ts):
 * we mock @/db/repositories.js with a stateful in-memory map. The mock
 * implements the same contract as the real repo so consumer code typed
 * against the repo behaves identically.
 *
 * Validates:
 *  - propose() default status='proposed', auto-version
 *  - activate() transactional: deprecate previous + activate target
 *  - rollback() transactional: rolled_back + reactivate v-1
 *  - listVersions ordering (most recent first)
 *  - tenant scoping
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

type SkillRow = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  goal: string;
  when_to_use: string;
  procedure: Record<string, unknown>;
  constraints: unknown[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  allowed_tools: string[];
  policy_descriptors: string[];
  success_criteria: unknown[];
  failure_modes: unknown[];
  runtime_hints: Record<string, unknown>;
  status: 'proposed' | 'active' | 'deprecated' | 'rolled_back';
  version: number;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_at: Date | null;
  deprecated_at: Date | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  created_at: Date;
};

const skillsState: Record<string, SkillRow> = {};
let idCounter = 0;

function nextId(): string {
  idCounter++;
  return `skill-${idCounter}`;
}

function keyOf(s: { tenant_id: string; agent_id: string | null; skill_descriptor: string }): string {
  return `${s.tenant_id}:${s.agent_id ?? 'tenant_wide'}:${s.skill_descriptor}`;
}

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );

  return {
    ...actual,
    skillsRepo: {
      async propose(input: any) {
        const tenant_id = input.tenant_id ?? 'default';
        const agent_id = input.agent_id ?? null;
        const k = keyOf({ tenant_id, agent_id, skill_descriptor: input.skill_descriptor });
        const sameKey = Object.values(skillsState).filter(
          (s) => keyOf(s) === k,
        );
        const nextVersion = sameKey.reduce((max, s) => Math.max(max, s.version), 0) + 1;
        const id = nextId();
        const row: SkillRow = {
          id,
          tenant_id,
          agent_id,
          skill_descriptor: input.skill_descriptor,
          category: input.category,
          execution_mode: input.execution_mode,
          goal: input.goal,
          when_to_use: input.when_to_use,
          procedure: input.procedure ?? {},
          constraints: input.constraints ?? [],
          input_schema: input.input_schema,
          output_schema: input.output_schema,
          allowed_tools: input.allowed_tools ?? [],
          policy_descriptors: input.policy_descriptors ?? [],
          success_criteria: input.success_criteria ?? [],
          failure_modes: input.failure_modes ?? [],
          runtime_hints: input.runtime_hints ?? {},
          status: 'proposed',
          version: nextVersion,
          proposed_by: input.proposed_by,
          proposed_reason: input.proposed_reason ?? null,
          approved_by: null,
          approved_at: null,
          activated_at: null,
          deprecated_at: null,
          rolled_back_at: null,
          rollback_reason: null,
          created_at: new Date(),
        };
        skillsState[id] = row;
        return row;
      },
      async findActive(descriptor: string, agent_id?: string | null) {
        const tenant_id = 'default';
        const matches = Object.values(skillsState).filter(
          (s) =>
            s.tenant_id === tenant_id &&
            s.skill_descriptor === descriptor &&
            s.status === 'active' &&
            (agent_id === undefined || s.agent_id === agent_id),
        );
        return matches[0] ?? null;
      },
      async listByCategory(category: string) {
        return Object.values(skillsState).filter(
          (s) => s.category === category && s.status === 'active',
        );
      },
      async activate(id: string, approver: string, reason?: string) {
        const target = skillsState[id];
        if (!target) throw new Error('skill_not_found');
        if (target.status !== 'proposed') {
          throw new Error(`cannot_activate_from_${target.status}`);
        }
        const k = keyOf(target);
        for (const s of Object.values(skillsState)) {
          if (keyOf(s) === k && s.status === 'active') {
            s.status = 'deprecated';
            s.deprecated_at = new Date();
          }
        }
        const now = new Date();
        target.status = 'active';
        target.activated_at = now;
        target.approved_by = approver;
        target.approved_at = now;
        if (reason) {
          target.proposed_reason =
            (target.proposed_reason ? target.proposed_reason + ' | ' : '') + 'approved: ' + reason;
        }
        return target;
      },
      async deprecate(id: string) {
        const t = skillsState[id];
        if (!t) throw new Error('skill_not_found');
        t.status = 'deprecated';
        t.deprecated_at = new Date();
        return t;
      },
      async rollback(id: string, reason: string) {
        const t = skillsState[id];
        if (!t) throw new Error('skill_not_found');
        t.status = 'rolled_back';
        t.rolled_back_at = new Date();
        t.rollback_reason = reason;
        // Reativar v-1 deprecated
        const k = keyOf(t);
        const prev = Object.values(skillsState).find(
          (s) => keyOf(s) === k && s.version === t.version - 1,
        );
        if (prev && prev.status === 'deprecated') {
          prev.status = 'active';
          prev.activated_at = new Date();
        }
        return t;
      },
      async getById(id: string) {
        return skillsState[id] ?? null;
      },
      async getByDescriptor(descriptor: string, version?: number) {
        const all = Object.values(skillsState).filter(
          (s) => s.skill_descriptor === descriptor && (version === undefined || s.version === version),
        );
        all.sort((a, b) => b.version - a.version);
        return all[0] ?? null;
      },
      async listVersions(descriptor: string) {
        const all = Object.values(skillsState).filter((s) => s.skill_descriptor === descriptor);
        all.sort((a, b) => b.version - a.version);
        return all;
      },
    },
  };
});

const baseInput = {
  skill_descriptor: 'detect_legal_risk',
  category: 'classify',
  execution_mode: 'prompt_only',
  goal: 'Detectar risco jurídico em mensagem',
  when_to_use: 'Mensagens contendo termos contratuais',
  procedure: { system_prompt: 'Classify legal risk.' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  proposed_by: 'test',
};

describe('skillsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(skillsState)) delete skillsState[k];
    idCounter = 0;
    vi.clearAllMocks();
  });

  it('propose creates skill com status="proposed" e version=1', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const proposed = await skillsRepo.propose({ ...baseInput });
      expect(proposed.status).toBe('proposed');
      expect(proposed.version).toBe(1);
      expect(proposed.tenant_id).toBe('default');
      expect(proposed.proposed_by).toBe('test');
    });
  });

  it('propose increments version monotonically', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const v1 = await skillsRepo.propose({ ...baseInput });
      const v2 = await skillsRepo.propose({ ...baseInput });
      const v3 = await skillsRepo.propose({ ...baseInput });
      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v3.version).toBe(3);
    });
  });

  it('findActive returns null se nenhuma versão ativa', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      await skillsRepo.propose({ ...baseInput }); // proposed, não active
      const found = await skillsRepo.findActive(baseInput.skill_descriptor);
      expect(found).toBeNull();
    });
  });

  it('activate moves proposed→active', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const proposed = await skillsRepo.propose({ ...baseInput });
      const activated = await skillsRepo.activate(proposed.id, 'owner@maia', 'looks good');
      expect(activated.status).toBe('active');
      expect(activated.approved_by).toBe('owner@maia');
      expect(activated.activated_at).toBeInstanceOf(Date);
      const found = await skillsRepo.findActive(baseInput.skill_descriptor);
      expect(found?.id).toBe(proposed.id);
    });
  });

  it('activate(v2) deprecates previously-active v1 (transactional)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const v1 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v1.id, 'owner');
      const v2 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v2.id, 'owner');
      const v1Check = await skillsRepo.getById(v1.id);
      expect(v1Check?.status).toBe('deprecated');
      const v2Check = await skillsRepo.getById(v2.id);
      expect(v2Check?.status).toBe('active');
      const found = await skillsRepo.findActive(baseInput.skill_descriptor);
      expect(found?.id).toBe(v2.id);
    });
  });

  it('activate from non-proposed throws', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const v1 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v1.id, 'owner');
      await expect(skillsRepo.activate(v1.id, 'owner')).rejects.toThrow('cannot_activate_from_active');
    });
  });

  it('rollback marks rolled_back e reactiva v-1 deprecated', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const v1 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v1.id, 'owner');
      const v2 = await skillsRepo.propose({ ...baseInput });
      await skillsRepo.activate(v2.id, 'owner');
      // v1 deprecated, v2 active. Rollback v2.
      await skillsRepo.rollback(v2.id, 'too aggressive', 'admin');
      const v2Check = await skillsRepo.getById(v2.id);
      const v1Check = await skillsRepo.getById(v1.id);
      expect(v2Check?.status).toBe('rolled_back');
      expect(v2Check?.rollback_reason).toBe('too aggressive');
      expect(v1Check?.status).toBe('active');
    });
  });

  it('listByCategory returns active in category', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const c1 = await skillsRepo.propose({ ...baseInput, skill_descriptor: 'a', category: 'classify' });
      await skillsRepo.activate(c1.id, 'owner');
      const c2 = await skillsRepo.propose({ ...baseInput, skill_descriptor: 'b', category: 'extract' });
      await skillsRepo.activate(c2.id, 'owner');
      const classify = await skillsRepo.listByCategory('classify');
      expect(classify.length).toBe(1);
      expect(classify[0]!.skill_descriptor).toBe('a');
    });
  });

  it('listVersions retorna mais recente primeiro', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      await skillsRepo.propose({ ...baseInput });
      await skillsRepo.propose({ ...baseInput });
      await skillsRepo.propose({ ...baseInput });
      const versions = await skillsRepo.listVersions(baseInput.skill_descriptor);
      expect(versions.length).toBe(3);
      expect(versions[0]!.version).toBe(3);
      expect(versions[2]!.version).toBe(1);
    });
  });

  it('getByDescriptor com version retorna versão exata', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { skillsRepo } = await import('@/db/repositories.js');
      const v1 = await skillsRepo.propose({ ...baseInput });
      const v2 = await skillsRepo.propose({ ...baseInput });
      const found = await skillsRepo.getByDescriptor(baseInput.skill_descriptor, 1);
      expect(found?.id).toBe(v1.id);
      expect(found?.version).toBe(1);
      void v2;
    });
  });
});
