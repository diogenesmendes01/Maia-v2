/**
 * P9a Task 5 — procedure_adapter mode tests.
 *
 * Verifica:
 *  - lookup por procedure_definition_id direto
 *  - lookup por procedure_descriptor (fallback)
 *  - throw quando não há ref
 *  - retorna envelope { procedure_execution_id, procedure_definition_id, status }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    procedureDefinitionsRepo: {
      ...actual.procedureDefinitionsRepo,
      findActiveByName: vi.fn(),
      findById: vi.fn(),
    },
    procedureExecutionsRepo: {
      ...actual.procedureExecutionsRepo,
      create: vi.fn(),
    },
  };
});

import { procedureAdapterMode } from '@/skills/modes/procedure-adapter.js';
import { procedureDefinitionsRepo, procedureExecutionsRepo } from '@/db/repositories.js';

const mockSkill = {
  id: 'skill-pa-1',
  skill_descriptor: 'collect_missing_cpf',
  version: 2,
  procedure: { procedure_definition_id: 'def-123' },
} as any;

describe('procedureAdapterMode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws procedure_definition_not_found when no ref in procedure', async () => {
    await expect(
      procedureAdapterMode({
        skill: { ...mockSkill, procedure: {} },
        input: {},
        resolvedPolicies: [],
      }),
    ).rejects.toThrow('procedure_definition_not_found');
  });

  it('looks up by procedure_descriptor (fallback)', async () => {
    vi.mocked(procedureDefinitionsRepo.findActiveByName).mockResolvedValue({
      id: 'def-from-descriptor',
      version_number: 5,
    } as any);
    vi.mocked(procedureDefinitionsRepo.findById).mockResolvedValue({
      id: 'def-from-descriptor',
      version_number: 5,
    } as any);
    vi.mocked(procedureExecutionsRepo.create).mockResolvedValue({
      id: 'exec-1',
      status: 'in_progress',
    } as any);
    const out = await procedureAdapterMode({
      skill: { ...mockSkill, procedure: { procedure_descriptor: 'collect_cpf' } },
      input: { cpf: '?' },
      resolvedPolicies: [],
    });
    expect(procedureDefinitionsRepo.findActiveByName).toHaveBeenCalledWith('collect_cpf');
    expect(out.procedure_execution_id).toBe('exec-1');
    expect(out.procedure_definition_id).toBe('def-from-descriptor');
  });

  it('starts execution with definition version + initial state', async () => {
    vi.mocked(procedureDefinitionsRepo.findById).mockResolvedValue({
      id: 'def-123',
      version_number: 7,
    } as any);
    vi.mocked(procedureExecutionsRepo.create).mockResolvedValue({
      id: 'exec-2',
      status: 'in_progress',
    } as any);
    const out = await procedureAdapterMode({
      skill: mockSkill,
      input: { foo: 'bar' },
      resolvedPolicies: [],
      conversa_id: 'conv-1',
    });
    expect(procedureExecutionsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        definition_id: 'def-123',
        definition_version: 7,
        conversa_id: 'conv-1',
        status: 'in_progress',
        execution_state: { input: { foo: 'bar' } },
      }),
    );
    expect(out).toEqual({
      procedure_execution_id: 'exec-2',
      procedure_definition_id: 'def-123',
      status: 'in_progress',
    });
  });
});
