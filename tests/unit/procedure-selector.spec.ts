import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

const mockAssignments: any[] = [];
const mockDefinitions: Record<string, any> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    procedureAssignmentsRepo: {
      ...actual.procedureAssignmentsRepo,
      listForTarget: vi.fn(async () => mockAssignments),
    },
    procedureDefinitionsRepo: {
      ...actual.procedureDefinitionsRepo,
      findById: vi.fn(async (id: string) => mockDefinitions[id] ?? null),
    },
    cognitiveModuleLogRepo: { record: vi.fn(async () => {}), recentByModule: vi.fn(async () => []) },
  };
});

import { selectProcedure } from '@/cognition/procedure-selector.js';
import { callLLM } from '@/lib/claude.js';

describe('selectProcedure', () => {
  beforeEach(() => {
    mockAssignments.length = 0;
    for (const k of Object.keys(mockDefinitions)) delete mockDefinitions[k];
    vi.clearAllMocks();
  });

  it('current_execution presente → decision=continue por default', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await selectProcedure({
        conversa_id: 'c1',
        current_message: 'oi tudo bem?',
        current_execution: { id: 'exec-1', definition_id: 'def-1', status: 'in_progress' } as any,
      });
      expect(result.decision).toBe('continue');
    });
  });

  it('sem assignments → decision=none', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await selectProcedure({
        conversa_id: 'c1',
        current_message: 'oi',
        current_execution: null,
      });
      expect(result.decision).toBe('none');
    });
  });

  it('1 assignment match → decision=start com selected_procedure_id', async () => {
    const defId = 'def-qualify';
    mockAssignments.push({ id: 'a1', definition_id: defId, definition_version: 1, target_type: 'agent', target_id: 'default', enabled: true });
    mockDefinitions[defId] = {
      id: defId,
      nome: 'qualify-lead',
      version_number: 1,
      status: 'active',
      intencao: 'Qualificar lead',
      when_apply: { tags: ['lead_new'] },
      steps: [{ id: 'step-1' }],
    };
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({ matches: true, confidence: 0.85, reason: 'matches lead_new tag' }),
    });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await selectProcedure({
        conversa_id: 'c1',
        current_message: 'oi tudo bom?',
        current_execution: null,
      });
      expect(result.decision).toBe('start');
      expect(result.selected_procedure_id).toBe(defId);
    });
  });
});
