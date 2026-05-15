/**
 * P4 Task 5 — proposal generator: seedInitialOperationalProfile.
 *
 * Esta é a ÚNICA situação onde criamos a primeira versão `active` do perfil
 * operacional via `create+transition`. Deterministico: lê `maia-prompt.md`,
 * decompõe num único `profile_body: ProfileBody` (v3.1.1) com 3 namespaces
 * (identity / style / metadata) e seeda v1 active.
 *
 * Padrão de mock: similar a operational-profile-versions-repo.spec.ts —
 * mockamos `@/db/repositories.js` com estado in-memory. Também mockamos
 * `node:fs/promises.readFile` para controlar o conteúdo do prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { ProfileBody, SelfState } from '@/db/schema.js';

type ProfileRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  version: number;
  status: 'proposed' | 'active' | 'frozen' | 'rolled_back';
  profile_body: ProfileBody;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_at: Date | null;
  frozen_at: Date | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  created_at: Date;
};

const makeEmptyProfileBody = (): ProfileBody => ({
  schema_version: 'v3.1.1-2026-05-15',
  identity: {
    role_descriptor: '',
    voice: { tone: '', formality: 'medium', verbosity: 'medium' },
    cognitive_limits: {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: [],
    learned_voice_modifiers: [],
  },
  style: { language: 'pt-BR', rhythm: {} },
  metadata: {
    effective_from: new Date().toISOString(),
    created_by: 'test',
    previous_version_id: null,
  },
});

const profilesState: Record<string, ProfileRow> = {};

// Test-controlled overrides for fs/promises.readFile so each test pode injetar
// o conteúdo do maia-prompt.md (ou simular falha).
let readFileImpl: ((path: string, encoding?: string) => Promise<string>) | null = null;

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string, encoding?: string) => {
    if (readFileImpl) return readFileImpl(path, encoding);
    throw new Error('readFile not configured for this test');
  }),
}));

// Mock para permitir injetar comportamento custom no transition (para o caso
// race: already_has_active).
let transitionOverride:
  | ((args: { id: string; to: string; approved_by?: string; rollback_reason?: string }) => Promise<{
      ok: false;
      reason: 'not_found' | 'invalid_transition' | 'already_has_active' | 'terminal';
    } | { ok: true; updated: ProfileRow }>)
  | null = null;

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );

  const computeNextVersion = (tenant_id: string, agent_id: string): number => {
    const rows = Object.values(profilesState).filter(
      (r) => r.tenant_id === tenant_id && r.agent_id === agent_id,
    );
    if (rows.length === 0) return 1;
    return Math.max(...rows.map((r) => r.version)) + 1;
  };

  const findActive = (tenant_id: string, agent_id: string): ProfileRow | null => {
    return (
      Object.values(profilesState).find(
        (r) => r.tenant_id === tenant_id && r.agent_id === agent_id && r.status === 'active',
      ) ?? null
    );
  };

  return {
    ...actual,
    operationalProfileVersionsRepo: {
      create: vi.fn(async (input: {
        profile_body: ProfileBody;
        proposed_by: string;
        proposed_reason?: string;
      }) => {
        const tenant_id = 'default';
        const agent_id = 'default';
        const id = `prof-${Math.random().toString(36).slice(2)}`;
        const version = computeNextVersion(tenant_id, agent_id);
        const row: ProfileRow = {
          id,
          tenant_id,
          agent_id,
          version,
          status: 'proposed',
          profile_body: input.profile_body,
          proposed_by: input.proposed_by,
          proposed_reason: input.proposed_reason ?? null,
          approved_by: null,
          approved_at: null,
          activated_at: null,
          frozen_at: null,
          rolled_back_at: null,
          rollback_reason: null,
          created_at: new Date(),
        };
        profilesState[id] = row;
        return row;
      }),
      getActive: vi.fn(async () => findActive('default', 'default')),
      getById: vi.fn(async (id: string) => profilesState[id] ?? null),
      listByStatus: vi.fn(async (status: string) =>
        Object.values(profilesState).filter((r) => r.status === status),
      ),
      transition: vi.fn(
        async (args: {
          id: string;
          to: 'proposed' | 'active' | 'frozen' | 'rolled_back';
          approved_by?: string;
          rollback_reason?: string;
        }) => {
          if (transitionOverride) return transitionOverride(args);
          const row = profilesState[args.id];
          if (!row) return { ok: false as const, reason: 'not_found' as const };
          const from = row.status;
          if (from === 'rolled_back') return { ok: false as const, reason: 'terminal' as const };
          if (from === args.to) return { ok: false as const, reason: 'invalid_transition' as const };

          const allowed: Record<string, string[]> = {
            proposed: ['active', 'frozen', 'rolled_back'],
            active: ['frozen', 'rolled_back'],
            frozen: ['active', 'rolled_back'],
          };
          if (!allowed[from]?.includes(args.to)) {
            return { ok: false as const, reason: 'invalid_transition' as const };
          }

          if (args.to === 'active') {
            const active = findActive(row.tenant_id, row.agent_id);
            if (active && active.id !== row.id) {
              return { ok: false as const, reason: 'already_has_active' as const };
            }
          }

          const now = new Date();
          const patch: Partial<ProfileRow> = { status: args.to };
          if (args.to === 'active') {
            if (!row.approved_at) {
              patch.approved_at = now;
              patch.approved_by = args.approved_by ?? row.approved_by;
            }
            patch.activated_at = now;
          }
          if (args.to === 'frozen') {
            patch.frozen_at = now;
          }
          if (args.to === 'rolled_back') {
            patch.rolled_back_at = now;
            patch.rollback_reason = args.rollback_reason ?? null;
          }
          const updated = { ...row, ...patch } as ProfileRow;
          profilesState[args.id] = updated;
          return { ok: true as const, updated };
        },
      ),
      nextVersion: vi.fn(async () => computeNextVersion('default', 'default')),
    },
  };
});

const MAIA_PROMPT_FIXTURE = `# Maia — System Prompt v0

> Header text.

## Identidade

Você é a **Maia**, assistente financeira pessoal do Mendes.

Você existe para que ele e a esposa não precisem mais acordar pensando "quanto eu tenho que pagar".

## Princípios

1. **Separação acima de tudo.** PF é PF. Cada empresa é uma entidade independente.

2. **Confirme antes de agir em coisas relevantes.** Lançamentos abaixo do limite confirmado podem ser registrados direto.

3. **Direta, não burocrática.** Mendes prefere objetividade.

## Como você fala

- Português brasileiro, registro coloquial-profissional
- Sem emojis (a menos que o interlocutor use)
- Sem "olá, tudo bem?" — vai direto ao ponto
- Frases curtas. Listagem só quando precisa

## Encerramento

Você é a Maia.
`;

describe('seedInitialOperationalProfile', () => {
  beforeEach(async () => {
    for (const k of Object.keys(profilesState)) delete profilesState[k];
    vi.clearAllMocks();
    readFileImpl = async () => MAIA_PROMPT_FIXTURE;
    transitionOverride = null;
    // Re-pin `getActive` to its default impl. `mockClear` (chamado por
    // `clearAllMocks`) só zera o histórico de chamadas; uma
    // `mockImplementation` setada em um teste anterior continuaria viva entre
    // testes se não fizermos isso.
    const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
    const findActive = () =>
      Object.values(profilesState).find(
        (r) => r.tenant_id === 'default' && r.agent_id === 'default' && r.status === 'active',
      ) ?? null;
    vi.mocked(operationalProfileVersionsRepo.getActive).mockImplementation(
      async () => findActive(),
    );
  });

  it('first seed creates active v1 with profile_body (v3.1.1) populated', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        const result = await seedInitialOperationalProfile();

        expect(result.created).toBe(true);
        if (!result.created) throw new Error('expected created=true');

        const v = result.version;
        expect(v.status).toBe('active');
        expect(v.version).toBe(1);
        expect(v.proposed_by).toBe('system_seed');
        expect(v.proposed_reason).toContain('initial seed');
        expect(v.approved_by).toBe('system_seed');
        expect(v.activated_at).toBeInstanceOf(Date);

        // profile_body v3.1.1: identity namespace
        const body = v.profile_body;
        expect(body.schema_version).toBe('v3.1.1-2026-05-15');
        expect(body.identity.role_descriptor).toContain('Você é a **Maia**');
        expect(Array.isArray(body.identity.priorities)).toBe(true);
        expect(body.identity.priorities.length).toBeGreaterThanOrEqual(3);
        expect(body.identity.priorities[0]).toContain('Separação');
        expect(body.identity.voice.tone).toContain('Português brasileiro');

        // style namespace
        expect(body.style.language).toBe('pt-BR');
        expect(body.style.rhythm).toEqual({});

        // metadata namespace
        expect(body.metadata.created_by).toBe('system_seed');
        expect(body.metadata.previous_version_id).toBeNull();
      },
    );
  });

  it('idempotency: when active already exists, returns { created: false, existing, already_active } without calling create/transition', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');

        // First seed
        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        const first = await seedInitialOperationalProfile();
        expect(first.created).toBe(true);

        // Reset spies so we can detect that create/transition NÃO foram chamadas no 2º seed
        vi.mocked(operationalProfileVersionsRepo.create).mockClear();
        vi.mocked(operationalProfileVersionsRepo.transition).mockClear();

        const second = await seedInitialOperationalProfile();
        expect(second.created).toBe(false);
        if (second.created) throw new Error('expected created=false');
        expect(second.reason).toBe('already_active');
        expect(second.existing.status).toBe('active');
        expect(second.existing.id).toBe((first as { created: true; version: ProfileRow }).version.id);

        // Critical: idempotência não deve chamar create/transition de novo
        expect(operationalProfileVersionsRepo.create).not.toHaveBeenCalled();
        expect(operationalProfileVersionsRepo.transition).not.toHaveBeenCalled();
      },
    );
  });

  it('self_state null → style.rhythm = {}', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        const result = await seedInitialOperationalProfile({ source_self_state: null });

        expect(result.created).toBe(true);
        if (!result.created) throw new Error('expected created=true');

        const body = result.version.profile_body;
        expect(body.style.rhythm).toEqual({});
        expect(body.identity.learned_voice_modifiers).toEqual([]);
      },
    );
  });

  it('self_state with resumo_aprendizados → style.rhythm includes resumo + versao_legacy', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        const fakeSelf: SelfState = {
          id: 'self-1',
          tenant_id: 'default',
          agent_id: 'default',
          versao: 42,
          system_prompt: 'whatever',
          resumo_aprendizados: 'Mendes prefere objetividade.',
          ativa: true,
          created_at: new Date(),
        };
        const result = await seedInitialOperationalProfile({ source_self_state: fakeSelf });

        expect(result.created).toBe(true);
        if (!result.created) throw new Error('expected created=true');

        const rhythm = result.version.profile_body.style.rhythm as {
          resumo: string;
          versao_legacy: number;
        };
        expect(rhythm.resumo).toBe('Mendes prefere objetividade.');
        expect(rhythm.versao_legacy).toBe(42);
      },
    );
  });

  it('maia-prompt.md missing/unreadable → throws seed_prompt_unavailable with path', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        readFileImpl = async () => {
          const err = new Error('ENOENT: no such file');
          (err as unknown as { code: string }).code = 'ENOENT';
          throw err;
        };
        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        await expect(
          seedInitialOperationalProfile({ source_prompt_path: 'src/identity/maia-prompt.md' }),
        ).rejects.toThrow(/seed_prompt_unavailable/);
      },
    );
  });

  it('race: transition returns already_has_active → returns { created: false, existing }', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');

        // Pre-populate state with an "active" row created by another agent/race
        const sneakRow: ProfileRow = {
          id: 'sneaky-active',
          tenant_id: 'default',
          agent_id: 'default',
          version: 99,
          status: 'active',
          profile_body: makeEmptyProfileBody(),
          proposed_by: 'race-condition',
          proposed_reason: null,
          approved_by: 'race',
          approved_at: new Date(),
          activated_at: new Date(),
          frozen_at: null,
          rolled_back_at: null,
          rollback_reason: null,
          created_at: new Date(),
        };

        // Simulate: getActive returns null first (when we check at the top), then
        // by the time we transition the just-created row, another process won.
        const getActiveMock = vi.mocked(operationalProfileVersionsRepo.getActive);
        let callCount = 0;
        getActiveMock.mockImplementation(async () => {
          callCount += 1;
          // 1st call (idempotency check at top): null
          if (callCount === 1) return null;
          // Subsequent calls (after transition failure): return the racing row
          return sneakRow;
        });

        // Force the transition to return already_has_active
        transitionOverride = async () => ({
          ok: false as const,
          reason: 'already_has_active' as const,
        });

        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        const result = await seedInitialOperationalProfile();
        expect(result.created).toBe(false);
        if (result.created) throw new Error('expected created=false');
        expect(result.reason).toBe('already_active');
        expect(result.existing.id).toBe('sneaky-active');
      },
    );
  });

  it('uses default prompt path when source_prompt_path is omitted', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const capturedPaths: string[] = [];
        readFileImpl = async (path: string) => {
          capturedPaths.push(path);
          return MAIA_PROMPT_FIXTURE;
        };
        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        await seedInitialOperationalProfile();
        expect(capturedPaths.length).toBeGreaterThan(0);
        expect(capturedPaths[0]).toContain('maia-prompt.md');
      },
    );
  });
});
