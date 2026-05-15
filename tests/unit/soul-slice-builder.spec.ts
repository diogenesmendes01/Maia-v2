/**
 * P8b — Tests for buildSoulSlice.
 *
 * Mocks soulBiasesRepo.findActiveForScope to feed a deterministic set of
 * biases and validates: depth='none' → empty slice; activation_context
 * filtering (intent_in, role_in, domain_in, risk_level_min, channel_in);
 * ranking by strength then scope specificity; truncation to max_biases;
 * rendered_block contains the disclaimer; cache_key stable for same args.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type SoulBiasRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  scope: 'tenant' | 'agent' | 'role' | 'domain';
  scope_value: string;
  principle: string;
  guidance: string;
  origin: string;
  strength: string;
  activation_context: Record<string, unknown>;
  status: string;
  version: number;
  previous_version_id: string | null;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_at: Date | null;
  deprecated_at: Date | null;
  deprecated_reason: string | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  proposal_id: string | null;
  source_drift_alert_id: string | null;
  created_at: Date;
};

let mockBiases: SoulBiasRow[] = [];

vi.mock('@/control-plane/soul/soul-biases-repo.js', () => ({
  soulBiasesRepo: {
    findActiveForScope: vi.fn(async (args: { limit?: number } = {}) => {
      const limit = args.limit ?? 50;
      return mockBiases.slice(0, limit);
    }),
  },
}));

function makeBias(p: Partial<SoulBiasRow>): SoulBiasRow {
  return {
    id: p.id ?? `b-${Math.random().toString(36).slice(2, 8)}`,
    tenant_id: 'default',
    agent_id: 'default',
    scope: p.scope ?? 'tenant',
    scope_value: p.scope_value ?? '*',
    principle: p.principle ?? 'p',
    guidance: p.guidance ?? 'g',
    origin: p.origin ?? 'founder_explicit',
    strength: p.strength ?? '0.500',
    activation_context: p.activation_context ?? {},
    status: 'active',
    version: 1,
    previous_version_id: null,
    proposed_by: 'test',
    proposed_reason: null,
    approved_by: 'admin',
    approved_at: new Date(),
    activated_at: new Date(),
    deprecated_at: null,
    deprecated_reason: null,
    rolled_back_at: null,
    rollback_reason: null,
    proposal_id: null,
    source_drift_alert_id: null,
    created_at: new Date(),
  };
}

beforeEach(() => {
  mockBiases = [];
  vi.clearAllMocks();
});

describe('buildSoulSlice (P8b)', () => {
  it('depth="none" devolve slice vazio com rendered_block=null', async () => {
    mockBiases = [makeBias({ principle: 'x' })];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'none',
      max_biases: 5,
    });
    expect(slice.active_biases).toEqual([]);
    expect(slice.rendered_block).toBeNull();
    expect(slice.total_active).toBe(0);
    expect(slice.truncated_to).toBe(0);
  });

  it('max_biases=0 devolve slice vazio', async () => {
    mockBiases = [makeBias({ principle: 'x' })];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 0,
    });
    expect(slice.rendered_block).toBeNull();
  });

  it('filtra por domain_in — exclui bias domain quando current_domain não bate', async () => {
    mockBiases = [
      makeBias({
        principle: 'presenca_antes_de_fato',
        scope: 'domain',
        scope_value: 'condolencia',
        activation_context: { domain_in: ['condolencia'] },
      }),
      makeBias({ principle: 'universal' }),
    ];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
      current_domain: 'finance',
    });
    const principles = slice.active_biases.map((b) => b.principle);
    expect(principles).toContain('universal');
    expect(principles).not.toContain('presenca_antes_de_fato');
  });

  it('filtra por role_in — exclui bias role quando current_role não bate', async () => {
    mockBiases = [
      makeBias({
        principle: 'pergunta_antes',
        scope: 'role',
        scope_value: 'finance_advisor',
        activation_context: { role_in: ['finance_advisor'] },
      }),
    ];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const sliceNoRole = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
    });
    expect(sliceNoRole.active_biases).toHaveLength(0);

    const sliceWithRole = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
      current_role: 'finance_advisor',
    });
    expect(sliceWithRole.active_biases).toHaveLength(1);
  });

  it('filtra por intent_in — inclui apenas quando intent bate', async () => {
    mockBiases = [
      makeBias({
        principle: 'cuidado_em_luto',
        activation_context: { intent_in: ['condolencia', 'apoio_emocional'] },
      }),
    ];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const sliceMatch = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
      current_intent: 'condolencia',
    });
    expect(sliceMatch.active_biases).toHaveLength(1);

    const sliceMiss = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
      current_intent: 'pergunta_factual',
    });
    expect(sliceMiss.active_biases).toHaveLength(0);
  });

  it('filtra por risk_level_min — ativa quando current_risk_level >= min', async () => {
    mockBiases = [
      makeBias({
        principle: 'cautela',
        activation_context: { risk_level_min: 'medium' },
      }),
    ];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const low = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
      current_risk_level: 'low',
    });
    expect(low.active_biases).toHaveLength(0);

    const high = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
      current_risk_level: 'high',
    });
    expect(high.active_biases).toHaveLength(1);
  });

  it('ranqueia por strength DESC; tiebreak por scope specificity (domain > role > tenant)', async () => {
    mockBiases = [
      makeBias({ id: 'tenant_a', principle: 'A_tenant', scope: 'tenant', strength: '0.700' }),
      makeBias({ id: 'role_a', principle: 'A_role', scope: 'role', scope_value: 'r', strength: '0.700', activation_context: { role_in: ['r'] } }),
      makeBias({ id: 'domain_a', principle: 'A_domain', scope: 'domain', scope_value: 'd', strength: '0.700', activation_context: { domain_in: ['d'] } }),
      makeBias({ id: 'tenant_high', principle: 'B_highest', strength: '0.900' }),
    ];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 10,
      current_role: 'r',
      current_domain: 'd',
    });
    // strength=0.9 vem primeiro
    expect(slice.active_biases[0]!.principle).toBe('B_highest');
    // entre os 0.7, domain > role > tenant
    expect(slice.active_biases[1]!.principle).toBe('A_domain');
    expect(slice.active_biases[2]!.principle).toBe('A_role');
    expect(slice.active_biases[3]!.principle).toBe('A_tenant');
  });

  it('trunca para max_biases respeitando total_active', async () => {
    mockBiases = Array.from({ length: 12 }, (_, i) =>
      makeBias({ principle: `p${i}`, strength: '0.500' }),
    );
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 3,
    });
    expect(slice.truncated_to).toBe(3);
    expect(slice.active_biases.length).toBe(3);
    expect(slice.total_active).toBe(12);
  });

  it('rendered_block inclui disclaimer "inclinam, não bloqueiam"', async () => {
    mockBiases = [
      makeBias({ principle: 'humildade', guidance: 'prefira "parece que" a "é"' }),
    ];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
    });
    expect(slice.rendered_block).not.toBeNull();
    expect(slice.rendered_block).toContain('Orientação persistente');
    expect(slice.rendered_block).toContain('inclinam, não bloqueiam');
    expect(slice.rendered_block).toContain('(humildade)');
  });

  it('rendered_block é null quando nenhuma bias passa o filtro', async () => {
    mockBiases = [
      makeBias({
        principle: 'role_only',
        scope: 'role',
        activation_context: { role_in: ['advisor'] },
      }),
    ];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const slice = await buildSoulSlice({
      tenant_id: 'default',
      agent_id: 'default',
      depth: 'relevant',
      max_biases: 5,
      // sem current_role — bias com role_in NÃO ativa
    });
    expect(slice.rendered_block).toBeNull();
  });

  it('cache_key é estável para os mesmos args', async () => {
    mockBiases = [makeBias({ principle: 'p1' })];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const a = await buildSoulSlice({
      tenant_id: 't',
      agent_id: 'a',
      depth: 'relevant',
      max_biases: 5,
      current_role: 'r',
      current_intent: 'i',
      current_domain: 'd',
      current_risk_level: 'medium',
      current_channel: 'whatsapp',
    });
    const b = await buildSoulSlice({
      tenant_id: 't',
      agent_id: 'a',
      depth: 'relevant',
      max_biases: 5,
      current_role: 'r',
      current_intent: 'i',
      current_domain: 'd',
      current_risk_level: 'medium',
      current_channel: 'whatsapp',
    });
    expect(a.cache_key).toBe(b.cache_key);
  });

  it('cache_key muda quando contexto muda', async () => {
    mockBiases = [makeBias({ principle: 'p1' })];
    const { buildSoulSlice } = await import(
      '@/runtime/context-assembly/slice-builders/soul-slice-builder.js'
    );
    const a = await buildSoulSlice({
      tenant_id: 't',
      agent_id: 'a',
      depth: 'relevant',
      max_biases: 5,
      current_role: 'r1',
    });
    const b = await buildSoulSlice({
      tenant_id: 't',
      agent_id: 'a',
      depth: 'relevant',
      max_biases: 5,
      current_role: 'r2',
    });
    expect(a.cache_key).not.toBe(b.cache_key);
  });
});
