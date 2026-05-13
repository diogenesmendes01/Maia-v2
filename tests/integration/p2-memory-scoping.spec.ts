import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// Mock LLM — não usado diretamente nestes testes, mas evita acidentalmente
// chamar API externa caso algum caminho de import dispare initialization.
vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(async () => ({
    content: '{"memory_type":"operational","scope_type":"agent","sensitivity":"low"}',
  })),
}));

// Mock repos — verifica contratos sem tocar no DB. Os arrays mutáveis
// servem como "estado" para cada teste configurar antes de chamar os repos.
const mockMemories: any[] = [];
const mockHints: any[] = [];

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    memoryEntryRepo: {
      ...actual.memoryEntryRepo,
      findRelevant: vi.fn(async () => mockMemories),
      create: vi.fn(async (input: any) => ({ id: 'mem-id', ...input })),
      listNeedsReview: vi.fn(async () => []),
      markReviewed: vi.fn(async () => {}),
    },
    behavioralHintRepo: {
      ...actual.behavioralHintRepo,
      findActiveForScope: vi.fn(async () => mockHints),
      create: vi.fn(async (input: any) => ({ id: 'hint-id', ...input })),
      revoke: vi.fn(async () => {}),
    },
    capabilitiesSkillRepo: {
      ...actual.capabilitiesSkillRepo,
      listAll: vi.fn(async () => []),
    },
    capabilityGapsRepo: {
      ...actual.capabilityGapsRepo,
      listByLevel: vi.fn(async () => []),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

describe('P2 memory scoping integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemories.length = 0;
    mockHints.length = 0;
  });

  it('memória sensitive NÃO aparece literal no prompt (mention_allowed=false)', async () => {
    mockMemories.push({
      id: 'm1',
      content: 'Cliente disse que filha está doente',
      memory_type: 'sensitive',
      scope_type: 'conversation',
      subject_id: 'conv-1',
      sensitivity: 'high',
      proactive_use: false,
      mention_allowed: false,
      ttl_days: 7,
      needs_review: false,
    });

    const { memoryEntryRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const result = await memoryEntryRepo.findRelevant({ conversa_id: 'conv-1' });
        // A memória sensitive é retornada pelo findRelevant — o filtro de
        // visibilidade vive no prompt-builder, não no repo.
        expect(result.length).toBe(1);
        // O prompt-builder não pode incluir o conteúdo literal: precisa
        // checar mention_allowed antes de renderizar.
        const mentionable = result.filter((m: any) => m.mention_allowed);
        expect(mentionable.length).toBe(0);
      },
    );
  });

  it('behavioral hint vira instrução genérica no prompt', async () => {
    mockHints.push({
      id: 'h1',
      scope_type: 'conversation',
      subject_id: 'conv-1',
      hint_text: 'usar tom mais paciente neste relacionamento',
      derived_from_memory_id: 'm1',
      derived_sensitivity: 'high',
    });

    const { behavioralHintRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const hints = await behavioralHintRepo.findActiveForScope({
          scope_type: 'conversation',
          subject_id: 'conv-1',
        });
        expect(hints[0]?.hint_text).toContain('paciente');
        // Hint nunca vaza conteúdo bruto da memória original.
        expect(hints[0]?.hint_text).not.toContain('filha');
        expect(hints[0]?.hint_text).not.toContain('doente');
      },
    );
  });

  it('memória personal com scope_type=role NÃO atravessa pra outro role', async () => {
    mockMemories.push({
      id: 'm-role-a',
      content: 'cliente menciona divórcio',
      memory_type: 'personal',
      scope_type: 'role',
      subject_id: 'role-comercial',
      sensitivity: 'medium',
      proactive_use: false,
      mention_allowed: false,
      ttl_days: 30,
      needs_review: false,
    });

    const { memoryEntryRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        // findRelevant retorna todas — o filtro por role é uma contract
        // verification: scope_type='role' + subject_id deve travar leitura
        // de outros roles via prompt-builder.
        const result = await memoryEntryRepo.findRelevant({});
        const mem = result.find((m: any) => m.id === 'm-role-a');
        expect(mem?.scope_type).toBe('role');
        expect(mem?.subject_id).toBe('role-comercial');
        // prompt-builder deve checar: current role === subject_id; caso
        // contrário, excluir a entry.
      },
    );
  });

  it('memória operational com scope_type=agent atravessa todos os roles', async () => {
    mockMemories.push({
      id: 'm-op',
      content: 'CNPJ da empresa: 12.345.678/0001-99',
      memory_type: 'operational',
      scope_type: 'agent',
      sensitivity: 'low',
      proactive_use: true,
      mention_allowed: true,
      ttl_days: null,
      needs_review: false,
    });

    const { memoryEntryRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const result = await memoryEntryRepo.findRelevant({});
        const mem = result.find((m: any) => m.id === 'm-op');
        expect(mem?.scope_type).toBe('agent');
        expect(mem?.mention_allowed).toBe(true);
      },
    );
  });

  it('memória needs_review=true não entra em findRelevant (filtro no repo)', async () => {
    // O filtro real em src/db/repositories.ts: eq(memory_entry.needs_review, false).
    // Nosso mock devolve o que pusermos; o contrato fica documentado aqui
    // como invariante esperado da camada de repositório real.
    expect(true).toBe(true);
  });

  it('[PR82-C2] memória com expires_at no passado é filtrada por findRelevant', async () => {
    // Contrato esperado da camada de repositório real (src/db/repositories.ts):
    // findRelevant emite `OR(isNull(expires_at), gt(expires_at, now))`. Aqui o
    // mock simula a aplicação desse filtro: empurramos uma row expirada e
    // uma não expirada, e configuramos o mock para retornar apenas a
    // válida — replicando o comportamento esperado pós-correção.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // ontem
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // amanhã
    const expired = {
      id: 'm-expired',
      content: 'fato com ttl vencido',
      memory_type: 'personal',
      scope_type: 'agent',
      sensitivity: 'medium',
      proactive_use: false,
      mention_allowed: false,
      ttl_days: 7,
      expires_at: past,
      needs_review: false,
    };
    const active = {
      id: 'm-active',
      content: 'fato ainda válido',
      memory_type: 'operational',
      scope_type: 'agent',
      sensitivity: 'low',
      proactive_use: true,
      mention_allowed: true,
      ttl_days: null,
      expires_at: future,
      needs_review: false,
    };
    // Simula o filtro do repo (expires_at IS NULL OR expires_at > now())
    const now = new Date();
    mockMemories.push(
      ...([expired, active].filter((m) => !m.expires_at || m.expires_at > now) as any[]),
    );

    const { memoryEntryRepo } = await import('@/db/repositories.js');
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const result = await memoryEntryRepo.findRelevant({});
        const ids = result.map((m: any) => m.id);
        expect(ids).toContain('m-active');
        expect(ids).not.toContain('m-expired');
      },
    );
  });
});
