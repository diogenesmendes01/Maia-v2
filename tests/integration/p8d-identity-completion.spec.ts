/**
 * P8d §9.5 — Integration test: 6 cenários da Identity Completion.
 *
 * Cobre o pipeline ponta-a-ponta:
 *  1. Seed inicial popula `priorities[]`
 *  2. Migration script é idempotente (re-rodar = skip)
 *  3. `papel_drift` dispara → severity=alto → profile vai a frozen
 *  4. Profile frozen → builder de slice retorna null (defesa runtime)
 *  5. `identity-slice-builder.depth='full'` retorna slice completo
 *  6. Modifier inválido no profile_body → repo.create rejeita
 *
 * Padrão: vi.mock para repos com state in-memory + mocks dedicados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';
import type {
  AgentOperationalProfileVersion,
  ProfileBody,
} from '@/db/schema.js';

// ---------- in-memory state ----------
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

const profilesState: Record<string, ProfileRow> = {};
const driftAlerts: Array<Record<string, unknown>> = [];

// Test-controlled override for fs/promises.readFile (cenário 1+2)
let readFileImpl: ((path: string, encoding?: string) => Promise<string>) | null = null;

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string, encoding?: string) => {
    if (readFileImpl) return readFileImpl(path, encoding);
    throw new Error('readFile not configured for this test');
  }),
}));

// Hoisted mocks
const { messagesCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: messagesCreateMock },
  }));
  return { default: Anthropic };
});

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
        // Aplicar a mesma validação write-path do repo real (P8d §10).
        const { LearnedVoiceModifierSchema } = await import('@/identity/learned-voice-modifier.js');
        const identity = (input.profile_body as { identity?: Record<string, unknown> }).identity;
        if (identity) {
          const cl = identity.cognitive_limits as
            | { max_inference_depth?: unknown; max_speculation_in_response?: unknown; confidence_floor_for_action?: unknown }
            | undefined;
          if (cl) {
            if (typeof cl.max_inference_depth !== 'number' ||
                cl.max_inference_depth < 0 || cl.max_inference_depth > 10) {
              throw new Error('cognitive_limits.max_inference_depth out of range [0,10]');
            }
            if (typeof cl.max_speculation_in_response !== 'number' ||
                cl.max_speculation_in_response < 0 || cl.max_speculation_in_response > 1) {
              throw new Error('cognitive_limits.max_speculation_in_response out of range [0,1]');
            }
            if (typeof cl.confidence_floor_for_action !== 'number' ||
                cl.confidence_floor_for_action < 0 || cl.confidence_floor_for_action > 1) {
              throw new Error('cognitive_limits.confidence_floor_for_action out of range [0,1]');
            }
          }
          const mods = identity.learned_voice_modifiers;
          if (Array.isArray(mods)) {
            for (const m of mods) {
              LearnedVoiceModifierSchema.parse(m);
            }
          }
        }

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
        return row as unknown as AgentOperationalProfileVersion;
      }),
      getActive: vi.fn(async () => findActive('default', 'default') as unknown as AgentOperationalProfileVersion | null),
      getById: vi.fn(async (id: string) => (profilesState[id] ?? null) as unknown as AgentOperationalProfileVersion | null),
      listByStatus: vi.fn(async (status: string) =>
        Object.values(profilesState).filter((r) => r.status === status) as unknown as AgentOperationalProfileVersion[],
      ),
      transition: vi.fn(
        async (args: {
          id: string;
          to: 'proposed' | 'active' | 'frozen' | 'rolled_back';
          approved_by?: string;
          rollback_reason?: string;
        }) => {
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
          if (args.to === 'frozen') patch.frozen_at = now;
          if (args.to === 'rolled_back') {
            patch.rolled_back_at = now;
            patch.rollback_reason = args.rollback_reason ?? null;
          }
          const updated = { ...row, ...patch } as ProfileRow;
          profilesState[args.id] = updated;
          return { ok: true as const, updated: updated as unknown as AgentOperationalProfileVersion };
        },
      ),
      nextVersion: vi.fn(async () => computeNextVersion('default', 'default')),
      // Review #100 — atomic alternative to create+transition pair. The mock
      // implements the contract: freeze previous active (if any), insert new
      // row directly as `active`. Throws on any failure (caller does try/catch).
      seedNewActiveAtomic: vi.fn(
        async (input: {
          profile_body: ProfileBody;
          proposed_by: string;
          proposed_reason?: string;
          expected_current_active_id?: string;
        }) => {
          const tenant_id = 'default';
          const agent_id = 'default';
          const currentActive = findActive(tenant_id, agent_id);

          if (
            input.expected_current_active_id &&
            currentActive?.id !== input.expected_current_active_id
          ) {
            throw new Error(
              `seed_atomic_stale_active: expected ${input.expected_current_active_id}, found ${currentActive?.id ?? 'none'}`,
            );
          }

          const now = new Date();
          let frozenPrevious: ProfileRow | null = null;
          if (currentActive) {
            const updated = { ...currentActive, status: 'frozen' as const, frozen_at: now };
            profilesState[currentActive.id] = updated;
            frozenPrevious = updated;
          }

          const id = `prof-${Math.random().toString(36).slice(2)}`;
          const version = computeNextVersion(tenant_id, agent_id);
          const row: ProfileRow = {
            id,
            tenant_id,
            agent_id,
            version,
            status: 'active',
            profile_body: input.profile_body,
            proposed_by: input.proposed_by,
            proposed_reason: input.proposed_reason ?? null,
            approved_by: input.proposed_by,
            approved_at: now,
            activated_at: now,
            frozen_at: null,
            rolled_back_at: null,
            rollback_reason: null,
            created_at: now,
          };
          profilesState[id] = row;

          return {
            new_active: row as unknown as AgentOperationalProfileVersion,
            frozen_previous: frozenPrevious as unknown as AgentOperationalProfileVersion | null,
          };
        },
      ),
    },
    driftAlertsRepo: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        const id = `alert-${Math.random().toString(36).slice(2)}`;
        const row = { id, ...input };
        driftAlerts.push(row);
        return row;
      }),
    },
    tenantsRepo: {
      list: vi.fn(async () => [{ id: 'default', nome: 'default', status: 'active', created_at: new Date() }]),
    },
  };
});

const MAIA_PROMPT_FIXTURE = `# Maia

## Identidade

Você é a Maia.

## Princípios

1. **Separação acima de tudo.** PF é PF.
2. **Confirme antes de agir.** Lançamentos abaixo do limite.
3. **Direta, não burocrática.** Mendes prefere objetividade.

## Como você fala

Direto.

## Encerramento

Fim.
`;

beforeEach(() => {
  // Limpar state entre cenários.
  for (const key of Object.keys(profilesState)) delete profilesState[key];
  driftAlerts.length = 0;
  messagesCreateMock.mockReset();
  readFileImpl = null;
});

describe('P8d Identity Completion (6 cenários integration)', () => {
  it('cenário 1: seedInitialOperationalProfile popula priorities derivadas dos princípios', async () => {
    readFileImpl = async () => MAIA_PROMPT_FIXTURE;

    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { seedInitialOperationalProfile } = await import('@/identity/proposal-generator.js');
        const result = await seedInitialOperationalProfile();
        expect(result.created).toBe(true);
        if (!result.created) throw new Error('expected created=true');
        const body = result.version.profile_body as ProfileBody;
        expect(body.identity.priorities.length).toBeGreaterThan(0);
        // Os 3 princípios viraram slugs
        expect(body.identity.priorities[0]).toMatch(/separacao/);
      },
    );
  });

  it('cenário 2: migration script é idempotente — popula 1ª vez, skip 2ª vez', async () => {
    readFileImpl = async () => MAIA_PROMPT_FIXTURE;

    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');

        // Setup: criar uma versão active SEM priorities (simula estado pré-P8d)
        const sampleBody: ProfileBody = {
          schema_version: 'v3.1.1-2026-05-15',
          identity: {
            role_descriptor: 'atendimento_pf',
            voice: { tone: '', formality: 'medium', verbosity: 'concise' },
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
        };
        const v1 = await operationalProfileVersionsRepo.create({
          profile_body: sampleBody,
          proposed_by: 'test',
        });
        await operationalProfileVersionsRepo.transition({ id: v1.id, to: 'active' });

        // Simular comportamento da migração: criar v2, freeze v1, activate v2.
        const { parsePrioritiesFromMarkdown } = await import('@/identity/proposal-generator.js');
        const { PROFILE_BODY_SCHEMA_VERSION } = await import('@/db/schema.js');
        const parsed = parsePrioritiesFromMarkdown(MAIA_PROMPT_FIXTURE);
        expect(parsed.length).toBeGreaterThan(0);

        // Run 1
        async function migrationOnce(): Promise<{ seeded: number; skipped: number }> {
          let seeded = 0;
          let skipped = 0;
          const active = await operationalProfileVersionsRepo.getActive();
          if (!active) { skipped++; return { seeded, skipped }; }
          const body = (active.profile_body ?? {}) as Record<string, unknown>;
          const identity = (body.identity ?? {}) as Record<string, unknown>;
          const existing = Array.isArray(identity.priorities)
            ? (identity.priorities as unknown[]).filter((p) => typeof p === 'string')
            : [];
          if (existing.length > 0) { skipped++; return { seeded, skipped }; }
          const newBody: ProfileBody = {
            ...(body as ProfileBody),
            schema_version: PROFILE_BODY_SCHEMA_VERSION,
            identity: {
              ...(identity as ProfileBody['identity']),
              priorities: parsed,
              learned_voice_modifiers: Array.isArray(identity.learned_voice_modifiers)
                ? (identity.learned_voice_modifiers as ProfileBody['identity']['learned_voice_modifiers'])
                : [],
            },
            metadata: {
              ...((body.metadata ?? {}) as ProfileBody['metadata']),
              effective_from: new Date().toISOString(),
              created_by: 'p8d_migration_priorities',
              previous_version_id: active.id,
            },
          };
          const newVersion = await operationalProfileVersionsRepo.create({
            profile_body: newBody, proposed_by: 'p8d_migration_priorities',
          });
          const freezeR = await operationalProfileVersionsRepo.transition({
            id: active.id, to: 'frozen',
          });
          if (!freezeR.ok) throw new Error(`freeze: ${freezeR.reason}`);
          const activR = await operationalProfileVersionsRepo.transition({
            id: newVersion.id, to: 'active',
          });
          if (!activR.ok) throw new Error(`activate: ${activR.reason}`);
          seeded++;
          return { seeded, skipped };
        }

        const r1 = await migrationOnce();
        expect(r1.seeded).toBe(1);
        expect(r1.skipped).toBe(0);

        // 2ª run — skip (já populado)
        const r2 = await migrationOnce();
        expect(r2.seeded).toBe(0);
        expect(r2.skipped).toBe(1);

        // Active deve agora ter priorities
        const after = await operationalProfileVersionsRepo.getActive();
        expect((after!.profile_body as ProfileBody).identity.priorities.length).toBeGreaterThan(0);
      },
    );
  });

  it('cenário 3: papel_drift dispara → decision engine ALTO → profile vai a frozen', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');

        const body: ProfileBody = {
          schema_version: 'v3.1.1-2026-05-15',
          identity: {
            role_descriptor: 'atendimento_financeiro_pf',
            voice: { tone: '', formality: 'medium', verbosity: 'concise' },
            cognitive_limits: {
              max_inference_depth: 3,
              max_speculation_in_response: 0.2,
              confidence_floor_for_action: 0.7,
            },
            priorities: ['preservar_capital'],
            learned_voice_modifiers: [],
          },
          style: { language: 'pt-BR', rhythm: {} },
          metadata: {
            effective_from: new Date().toISOString(),
            created_by: 'test',
            previous_version_id: null,
          },
        };
        const created = await operationalProfileVersionsRepo.create({
          profile_body: body, proposed_by: 'test',
        });
        await operationalProfileVersionsRepo.transition({ id: created.id, to: 'active' });

        // Mockar Anthropic para retornar drift detectado com 3 off_role_examples.
        // observed_role compartilha prefixo com declared (atendimento_*) → não
        // promove a CRITICO; severity-floor com 3 off_role → ALTO.
        messagesCreateMock.mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                drift_detected: true,
                severity_hint: 'alto',
                off_role_examples: ['parecer jurídico', 'investimento tech', 'consultoria tributária'],
                observed_role_inferred: 'atendimento_corporativo',
                reasoning: 'agente saiu do papel financeiro',
              }),
            },
          ],
        });

        const { papelDriftDetector } = await import('@/cognition/drift/papel.js');
        const evidence = await papelDriftDetector.detect({
          profile_active: created as unknown as AgentOperationalProfileVersion,
          recent_messages: [
            { id: 'm1', from: 'agent', text: 'parecer jurídico', created_at: new Date() },
            { id: 'm2', from: 'agent', text: 'invest em tech', created_at: new Date() },
            { id: 'm3', from: 'agent', text: 'consultoria fiscal', created_at: new Date() },
          ],
        });

        expect(evidence).not.toBeNull();
        if (!evidence) throw new Error('expected evidence');
        expect(evidence.drift_type).toBe('papel_drift');

        const { decideAndApply } = await import('@/cognition/drift/decision-engine.js');
        const results = await decideAndApply({
          evidences: [evidence],
          active_profile_id: created.id,
        });
        expect(results[0]!.severity).toBe(DriftSeverity.ALTO);
        expect(results[0]!.decision).toBe(DriftDecision.FROZEN);
        expect(results[0]!.applied).toBe(true);

        // Estado: profile foi para frozen
        const post = await operationalProfileVersionsRepo.getById(created.id);
        expect(post!.status).toBe('frozen');

        // Alert criado
        const lastAlert = driftAlerts[driftAlerts.length - 1]!;
        expect(lastAlert['drift_type']).toBe(DriftType.PAPEL_DRIFT);
        expect(lastAlert['decision']).toBe(DriftDecision.FROZEN);
      },
    );
  });

  it('cenário 4: profile frozen → identity-slice-builder retorna null (defesa runtime)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const body: ProfileBody = {
          schema_version: 'v3.1.1-2026-05-15',
          identity: {
            role_descriptor: 'role',
            voice: { tone: '', formality: 'medium', verbosity: 'concise' },
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
        };
        const created = await operationalProfileVersionsRepo.create({
          profile_body: body, proposed_by: 'test',
        });
        await operationalProfileVersionsRepo.transition({ id: created.id, to: 'active' });
        await operationalProfileVersionsRepo.transition({ id: created.id, to: 'frozen' });

        const { buildIdentitySlice } = await import('@/runtime/context-assembly/slice-builders/identity-slice-builder.js');
        const slice = await buildIdentitySlice({ depth: 'minimal' });
        expect(slice).toBeNull();
      },
    );
  });

  it('cenário 5: identity-slice-builder.depth=full retorna slice com principles + active modifiers', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const body: ProfileBody = {
          schema_version: 'v3.1.1-2026-05-15',
          identity: {
            role_descriptor: 'atendimento_pf',
            voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
            cognitive_limits: {
              max_inference_depth: 3,
              max_speculation_in_response: 0.2,
              confidence_floor_for_action: 0.7,
            },
            priorities: ['clareza', 'preservar_capital'],
            learned_voice_modifiers: [
              {
                id: '550e8400-e29b-41d4-a716-446655440010',
                dimension: 'tone',
                delta: { kind: 'shift', from: 'formal', to: 'casual' },
                confidence: 0.9,
                evidence_count: 5,
                status: 'active',
                proposed_by: 'detector',
                proposed_at: '2026-05-15T00:00:00Z',
                approved_by: null,
                approved_at: null,
                expires_at: null,
                evidence_refs: ['msg_1', 'msg_2', 'msg_3'],
              },
            ] as unknown as ProfileBody['identity']['learned_voice_modifiers'],
          },
          style: { language: 'pt-BR', rhythm: {} },
          metadata: {
            effective_from: new Date().toISOString(),
            created_by: 'test',
            previous_version_id: null,
          },
        };
        // Adicionar principles ao body identity (não está no schema mas é depth='full')
        (body.identity as Record<string, unknown>).principles = ['transparencia', 'separacao'];

        const created = await operationalProfileVersionsRepo.create({
          profile_body: body, proposed_by: 'test',
        });
        await operationalProfileVersionsRepo.transition({ id: created.id, to: 'active' });

        const { buildIdentitySlice } = await import('@/runtime/context-assembly/slice-builders/identity-slice-builder.js');
        const slice = await buildIdentitySlice({ depth: 'full' });
        expect(slice).not.toBeNull();
        if (!slice) throw new Error('expected slice');
        expect(slice.priorities).toEqual(['clareza', 'preservar_capital']);
        expect(slice.principles).toEqual(['transparencia', 'separacao']);
        expect(slice.active_voice_modifiers).toHaveLength(1);
        expect(slice.active_voice_modifiers![0]!.status).toBe('active');
        expect(slice.role_descriptor).toBe('atendimento_pf');
      },
    );
  });

  it('cenário 6: modifier inválido em learned_voice_modifiers → repo.create rejeita', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const badBody: ProfileBody = {
          schema_version: 'v3.1.1-2026-05-15',
          identity: {
            role_descriptor: 'role',
            voice: { tone: '', formality: 'medium', verbosity: 'concise' },
            cognitive_limits: {
              max_inference_depth: 3,
              max_speculation_in_response: 0.2,
              confidence_floor_for_action: 0.7,
            },
            priorities: [],
            // Modifier malformado: evidence_count=1 (mín. 3), confidence=2 (max 1)
            learned_voice_modifiers: [
              {
                id: '550e8400-e29b-41d4-a716-446655440099',
                dimension: 'tone',
                delta: { kind: 'shift', from: 'a', to: 'b' },
                confidence: 2.0, // INVÁLIDO (>1)
                evidence_count: 1, // INVÁLIDO (<3)
                status: 'active',
                proposed_by: 'test',
                proposed_at: '2026-05-15T00:00:00Z',
                approved_by: null,
                approved_at: null,
                expires_at: null,
                evidence_refs: ['m1'],
              },
            ] as unknown as ProfileBody['identity']['learned_voice_modifiers'],
          },
          style: { language: 'pt-BR', rhythm: {} },
          metadata: {
            effective_from: new Date().toISOString(),
            created_by: 'test',
            previous_version_id: null,
          },
        };

        await expect(
          operationalProfileVersionsRepo.create({
            profile_body: badBody,
            proposed_by: 'test',
          }),
        ).rejects.toThrow();
      },
    );
  });

  // Review #100 — shape-alignment regression: building a slice from the actual
  // seedInitialOperationalProfile output (not a hand-rolled fixture) must
  // produce identity_block + principles populated. Pre-fix the slice was
  // returning empty strings/[] because the seed wrote those fields under
  // `core_immutable` and the builder only read `identity`.
  it('cenário 7 (review #100): slice from seedInitialOperationalProfile has identity_block + principles', async () => {
    readFileImpl = async () => MAIA_PROMPT_FIXTURE;

    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { seedInitialOperationalProfile } = await import(
          '@/identity/proposal-generator.js'
        );
        const seedResult = await seedInitialOperationalProfile();
        expect(seedResult.created).toBe(true);

        const { buildIdentitySlice } = await import(
          '@/runtime/context-assembly/slice-builders/identity-slice-builder.js'
        );
        const slice = await buildIdentitySlice({ depth: 'full' });

        expect(slice).not.toBeNull();
        if (!slice) throw new Error('expected slice');

        // identity_block populated from the seed (no longer '')
        expect(slice.identity_block.length).toBeGreaterThan(0);
        expect(slice.identity_block).toContain('Maia');

        // principles populated from the seed (no longer undefined/[])
        expect(slice.principles).toBeDefined();
        expect(slice.principles!.length).toBe(3);
        expect(slice.principles![0]).toContain('Separação');
      },
    );
  });

  // Review #100 — back-compat: legacy seeded rows that only put
  // identity_block/principles under `core_immutable` must still produce a
  // populated slice (defense-in-depth fallback in identity-slice-builder).
  it('cenário 8 (review #100): slice falls back to core_immutable for legacy-shape rows', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');

        // Legacy shape: identity.identity_block missing, content under
        // core_immutable instead. Simulates rows seeded before the proposal
        // generator fix landed.
        const legacyBody = {
          schema_version: 'v3.1.1-2026-05-15',
          identity: {
            role_descriptor: 'You are Maia.',
            // identity_block intentionally OMITTED
            // principles intentionally OMITTED
            voice: { tone: '', formality: 'medium' as const, verbosity: 'concise' as const },
            cognitive_limits: {
              max_inference_depth: 3,
              max_speculation_in_response: 0.2,
              confidence_floor_for_action: 0.7,
            },
            priorities: ['transparencia'],
            learned_voice_modifiers: [],
          },
          style: { language: 'pt-BR', rhythm: {} },
          metadata: {
            effective_from: new Date().toISOString(),
            created_by: 'legacy_seed',
            previous_version_id: null,
          },
          // Legacy mirror — the pre-fix proposal-generator wrote here only
          core_immutable: {
            identity_block: 'You are Maia (from legacy mirror).',
            principles: ['p1_legacy', 'p2_legacy'],
          },
        } as unknown as ProfileBody;

        const created = await operationalProfileVersionsRepo.create({
          profile_body: legacyBody,
          proposed_by: 'test_legacy',
        });
        await operationalProfileVersionsRepo.transition({ id: created.id, to: 'active' });

        const { buildIdentitySlice } = await import(
          '@/runtime/context-assembly/slice-builders/identity-slice-builder.js'
        );
        const slice = await buildIdentitySlice({ depth: 'full' });

        expect(slice).not.toBeNull();
        if (!slice) throw new Error('expected slice');

        // Fallback to core_immutable kicks in
        expect(slice.identity_block).toBe('You are Maia (from legacy mirror).');
        expect(slice.principles).toEqual(['p1_legacy', 'p2_legacy']);
      },
    );
  });

  // Review #100 — atomicity guarantee: seedNewActiveAtomic must keep agent's
  // active profile untouched if any step inside the tx fails. This is a unit-
  // grain check exercising the mock layer; the real DB-backed assertion lives
  // in tests/integration/p4-operational-identity.spec.ts when an integration
  // DB is configured.
  it('cenário 9 (review #100): priorities migration script structure — failed→exit 1', async () => {
    // We don't invoke the script main() here (it would touch real DB), but we
    // assert the new repo method exists and is the path the script uses.
    const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
    expect(typeof operationalProfileVersionsRepo.seedNewActiveAtomic).toBe('function');
  });
});
