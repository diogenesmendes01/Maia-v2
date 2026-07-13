/**
 * Admin UI Setup — agents router.
 *
 * Procedures:
 *   - list           — list agents for a tenant
 *   - getById        — fetch a single agent
 *   - create         — create an agent AND seed agent_operational_profile_versions
 *                      v1 with status='proposed' AND append audit row, all in a
 *                      single transaction (agentsRepo.createWithSeedAndAudit).
 *   - updateProfile  — propose a new operational_profile_version for an existing
 *                      agent AND append audit row, in a single transaction
 *                      (operationalProfileVersionsRepo.proposeAndAuditAtomic).
 *                      Status='proposed' — the proposal still has to be
 *                      approved through the standard proposal-inbox flow.
 *
 * Notes:
 *   - All three mutations (create / updateProfile / approveProfile) now go
 *     through repo-level "atomic" methods that take explicit tenant_id/agent_id
 *     and wrap their writes in `withTx`. Codex review of PR #162 round 3
 *     (issue #166) closed the multi-write atomicity gap.
 *   - The tenant_id ALWAYS comes from the resolved ctx tenant (no body
 *     override for owner — only founder can supply a body tenantId).
 *   - We deliberately do NOT auto-activate the seeded profile. P8.5 invariant
 *     is "no profile activates without an approval"; admin-ui setup respects
 *     this — a freshly-created agent has no active profile until owner/founder
 *     approves the seed via `approveProfile` (agent detail → Versões tab, or
 *     the Identidades screen). Operational profile versions intentionally do
 *     NOT flow through the Proposal Inbox — see the approveProfile jsdoc.
 *   - role gate: founder or owner. analyst/viewer cannot create agents.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import { PROFILE_BODY_SCHEMA_VERSION, type ProfileBody } from '../../../db/schema.js';
import { ARCHETYPE_IDS, ARCHETYPE_PACK_MAP } from '../../../tools/archetype-packs.js';
import { BASE_AGENT_PACKS } from '../../../tools/base-agent-packs.js';
import { TOOL_PACKS, resolvePackTools } from '../../../tools/grant-math.js';

const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters/digits/_/- and start with alnum');

const AgentStatusSchema = z.enum(['active', 'suspended']);

const FormalitySchema = z.enum(['low', 'medium', 'high']);
const VerbositySchema = z.enum(['concise', 'medium', 'detailed']);

// Operational profile body shape (mirrors ProfileBody in schema.ts).
// We accept the user-visible subset and fill schema_version + metadata
// server-side.
//
// Issue #193 — `principles` is a distinct input from `priorities`:
//   - priorities: operational labels the agent should weight when prioritizing
//     actions (audited by papelDriftDetector — soft drift, no auto-freeze).
//   - principles: CORE VALUE CONTRACTS — inviolable behavioral guardrails
//     audited by valoresDetector. Violations floor to `alto` → `frozen`
//     (or `critico` → `rollback`) via the decision engine.
//   Because the two have radically different governance consequences, the
//   setup MUST keep them as separate inputs. The legacy resolver explicitly
//   forbids synthesizing principles from priorities (#189) and this router
//   MUST NOT auto-copy across the two arrays either.
const ProfileBodyInputSchema = z
  .object({
    identity: z.object({
      role_descriptor: z.string().min(1).max(500),
      voice: z.object({
        tone: z.string().min(1).max(200),
        formality: FormalitySchema,
        verbosity: VerbositySchema,
      }),
      cognitive_limits: z.object({
        max_inference_depth: z.number().int().min(0).max(10),
        max_speculation_in_response: z.number().min(0).max(1),
        confidence_floor_for_action: z.number().min(0).max(1),
      }),
      priorities: z.array(z.string().min(1).max(200)).max(20),
      // Optional — when empty/omitted, the resolver returns no principles and
      // valoresDetector skips with `no_principles_configured` (the existing,
      // intentional behavior introduced in #189/#191). Items mirror priorities'
      // 1..200 bounds.
      principles: z.array(z.string().min(1).max(200)).max(20).optional(),
    }),
    style: z.object({
      language: z.string().min(2).max(20),
      rhythm: z.record(z.string(), z.unknown()).default({}),
    }),
  })
  // Codex Adversarial Review of PR #201 round 1 [HIGH] — cross-field guard.
  //
  // Even with `principles` as a distinct input (#193), a client could submit
  // the SAME operational labels in both arrays. The legacy resolver surfaces
  // them as core_immutable principles → valoresDetector treats them as core
  // value contracts → the decision engine can freeze/rollback the profile
  // for ordinary priority drift. This is the symmetric, ingress-side hole
  // matching the resolver-side bug #189/#191 closed.
  //
  // We reject ANY overlap, comparing case-insensitively + trimmed. The
  // original strings are still PERSISTED as supplied; only the comparison is
  // normalized. Operators may not "spell around" the guard with case or
  // whitespace variants — semantically the same label cannot be both a soft
  // priority and an inviolable principle.
  //
  // UI warnings are not a trust boundary. This is the server-side gate.
  .superRefine((data, ctx) => {
    const principles = data.identity.principles;
    if (!principles || principles.length === 0) return;
    const normalize = (s: string) => s.trim().toLowerCase();
    const priorityKeys = new Map<string, string>();
    for (const p of data.identity.priorities) {
      priorityKeys.set(normalize(p), p);
    }
    principles.forEach((principle, idx) => {
      const key = normalize(principle);
      const collidingPriority = priorityKeys.get(key);
      if (collidingPriority !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['identity', 'principles', idx],
          message:
            `principle "${principle}" overlaps with priority "${collidingPriority}" ` +
            `(compared trimmed + case-insensitive). priorities are operational ` +
            `labels (soft, papelDriftDetector); principles are core value ` +
            `contracts (hard, valoresDetector — may auto-freeze). The same ` +
            `label cannot be both — pick one field.`,
        });
      }
    });
  })
  // Originally a safety gate (PR #201 round 2 [P2]) for a runtime hazard:
  // the IdentitySliceBuilder used to fall back to `identity.principles` for
  // `slice.priorities` when priorities was empty, so `priorities: []` +
  // non-empty `principles` would surface core value contracts as operational
  // priorities. PR #200 (#192) removed that fallback — the hazard is gone.
  //
  // The gate is KEPT deliberately as a product rule: there is no legitimate
  // "principles without priorities" workflow (principles are an addition on
  // top of, not a replacement for, operational priorities), and an agent
  // with declared core value contracts but no operational priorities is an
  // incoherent identity descriptor. The wizard mirrors this client-side
  // (validateIdentity in profile-form.tsx).
  .superRefine((data, ctx) => {
    const principles = data.identity.principles;
    if (!principles || principles.length === 0) return;
    if (data.identity.priorities.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity', 'priorities'],
        message:
          `priorities cannot be empty when principles are declared — principles ` +
          `are core value contracts layered ON TOP of operational priorities, ` +
          `not a replacement for them. Declare at least one priority alongside ` +
          `principles.`,
      });
    }
  });

const ListInputSchema = z.object({ tenantId: z.string().optional() });

const GetByIdInputSchema = z.object({
  tenantId: z.string().optional(),
  id: AgentIdSchema,
});

const CreateInputSchema = z.object({
  tenantId: z.string().optional(),
  id: AgentIdSchema,
  nome: z.string().min(1).max(200),
  status: AgentStatusSchema.optional(),
  profile_body: ProfileBodyInputSchema,
  proposed_reason: z.string().min(10).max(2000),
  // Issue #470 — função escolhida no wizard. Resolve para packs de domínio
  // (ARCHETYPE_PACK_MAP) compostos sobre BASE_AGENT_PACKS no grant inicial.
  // Opcional para compat: omitido ⇒ só o floor da plataforma (= 'custom').
  archetype: z.enum(ARCHETYPE_IDS).optional(),
});

const UpdateCapabilitiesInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  // Packs de PRODUTO desejados (catálogo TOOL_PACKS). Packs fora do catálogo
  // presentes no grant atual (ex.: mcp.<server>, geridos em /setup/mcp) são
  // PRESERVADOS — esta superfície não os gerencia. Pack desconhecido no input
  // é rejeitado (fail-closed), não ignorado.
  granted_packs: z.array(z.string().min(1).max(100)).max(50),
  // HARD deny — substitui a lista atual. Cada entrada deve ser uma tool
  // efetiva do novo conjunto (ou já estar negada hoje, para permitir manter
  // denies históricos de tools que saíram de visibilidade).
  denied_tools: z.array(z.string().min(1).max(200)).max(100),
  comment: z.string().min(10).max(1000),
});

const UpdateProfileInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  profile_body: ProfileBodyInputSchema,
  proposed_reason: z.string().min(10).max(2000),
});

const ApproveProfileInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  versionId: z.string().uuid(),
  comment: z.string().min(10).max(2000),
});

/**
 * Build a full ProfileBody from the user-supplied subset. `previous_version_id`
 * is null for the seed; for `updateProfile` we pass the current active id (if
 * any) so the chain links.
 *
 * `principlesOverride` lets `updateProfile` inject a preserved-from-active
 * principles array when the request omits the field. `create` and explicit
 * supply paths leave `principlesOverride` null, in which case we use
 * `input.identity.principles ?? []` (omission ⇒ no principles, matching the
 * #193 contract).
 */
function buildProfileBody(
  input: z.infer<typeof ProfileBodyInputSchema>,
  proposedBy: string,
  previousVersionId: string | null,
  principlesOverride: string[] | null = null,
): ProfileBody {
  // Issue #193 — persist `principles` at profile_body.identity.principles.
  // The legacy resolver (`src/identity/profile-legacy-resolver.ts`) reads this
  // path directly into `core_immutable.principles` for valoresDetector. When
  // the input omits principles on `create` we DO NOT fall back to priorities —
  // that is the explicit cross-domain contamination bug class fixed in #189/#191.
  // An empty principles array (or omission on create) intentionally leaves
  // the VALORES guardrail disabled, matching the resolver's contract: no true
  // principles configured → detector emits a one-shot observability log and
  // skips silently. Operators that want the guardrail must declare explicit
  // core principles in the wizard.
  //
  // Codex Adversarial Review of PR #201 round 2 [HIGH] — VALORES guardrail
  // data-loss on omitted principles in updateProfile:
  //   updateProfile rebuilds the next profile_body entirely from the request.
  //   Because `identity.principles` is optional, an older client / partial
  //   edit that updates a profile WITHOUT sending `principles` would propose
  //   a new version with empty principles. Once approved, valoresDetector
  //   sees zero principles → skips silently → guardrail disabled.
  //
  // Fix: `updateProfile` passes `principlesOverride` = activeVersion's
  // principles ONLY when the request OMITS `principles` (key undefined).
  // Explicit `principles: []` is honored (intentional audited clear: the
  // proposed profile_body shows principles=[], the diff against the active
  // body is captured implicitly through the version chain). Non-empty
  // principles in the request replace.
  const principles = principlesOverride ?? input.identity.principles ?? [];
  return {
    schema_version: PROFILE_BODY_SCHEMA_VERSION,
    identity: {
      role_descriptor: input.identity.role_descriptor,
      voice: input.identity.voice,
      cognitive_limits: input.identity.cognitive_limits,
      priorities: input.identity.priorities,
      principles,
      learned_voice_modifiers: [],
    } as ProfileBody['identity'] & { principles: string[] },
    style: {
      language: input.style.language,
      rhythm: input.style.rhythm,
    },
    metadata: {
      effective_from: new Date().toISOString(),
      created_by: proposedBy,
      previous_version_id: previousVersionId,
    },
  };
}

/**
 * Extract the active version's `identity.principles` array for preservation
 * on omit-on-update (#201 round 2 HIGH). Returns null when:
 *   - there is no active version (e.g., seed not yet approved); OR
 *   - the active version's profile_body has no `identity.principles` key
 *     (pre-#193 row); OR
 *   - the value is not an array of strings (defensive — refuse to inherit
 *     malformed data).
 *
 * Returning null is the signal to `buildProfileBody` that there is "nothing
 * to preserve from" — falls back to the request's own (possibly empty)
 * principles, which is the safe baseline.
 */
function extractActivePrinciples(activeProfileBody: unknown): string[] | null {
  if (!activeProfileBody || typeof activeProfileBody !== 'object') return null;
  const identity = (activeProfileBody as { identity?: unknown }).identity;
  if (!identity || typeof identity !== 'object') return null;
  const principles = (identity as { principles?: unknown }).principles;
  if (!Array.isArray(principles)) return null;
  if (!principles.every((p): p is string => typeof p === 'string')) return null;
  return principles;
}

export const agentsRouter = router({
  list: protectedProcedure.input(ListInputSchema).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await ctx.repos.agentsRepo.listByTenant(tenantId);
    return { items };
  }),

  getById: protectedProcedure.input(GetByIdInputSchema).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const agent = await ctx.repos.agentsRepo.findById(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
    if (agent.tenant_id !== tenantId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
    }
    return agent;
  }),

  /**
   * Read-only profile snapshot for the agent detail screen: the active
   * operational profile version (if any) plus pending `proposed` versions.
   * Exposes `profile_body` so the UI can prefill the edit form with the
   * currently-running identity instead of forcing the operator to retype it.
   */
  getProfileVersions: protectedProcedure
    .input(GetByIdInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const agent = await ctx.repos.agentsRepo.findById(input.id);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }
      const [active, proposed] = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: agent.id },
        async () =>
          Promise.all([
            ctx.repos.operationalProfileVersionsRepo.getActive(),
            ctx.repos.operationalProfileVersionsRepo.listByStatus('proposed'),
          ]),
      );
      const pick = (v: NonNullable<typeof active>) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        profile_body: v.profile_body,
        proposed_by: v.proposed_by,
        proposed_reason: v.proposed_reason,
        created_at: v.created_at,
      });
      return {
        active: active ? pick(active) : null,
        proposed: proposed.map(pick),
      };
    }),

  /**
   * Perfis propostos aguardando aprovação, agregados por agente — alimenta o
   * card "Perfis de agente" na tela Aprovações (/inbox). O perfil operacional
   * NÃO flui pelo Proposal Inbox (ver nota em approveProfile); este agregado
   * existe para que a fila "Aprovações" ao menos APONTE para onde a aprovação
   * acontece (aba Versões do agente), em vez de omitir perfis pendentes.
   * Cardinalidade: nº de agentes do tenant — pequeno; espelha o fan-out de
   * versions.listVersions.
   */
  pendingProfileApprovals: protectedProcedure
    .input(ListInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const agents = await ctx.repos.agentsRepo.listByTenant(tenantId);
      const items: Array<{
        agent_id: string;
        agent_nome: string;
        pending_count: number;
        oldest_created_at: Date;
      }> = [];
      for (const agent of agents) {
        const proposed = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: agent.id },
          async () => ctx.repos.operationalProfileVersionsRepo.listByStatus('proposed'),
        );
        if (proposed.length === 0) continue;
        items.push({
          agent_id: agent.id,
          agent_nome: agent.nome,
          pending_count: proposed.length,
          oldest_created_at: proposed.reduce(
            (min, p) => (p.created_at < min ? p.created_at : min),
            proposed[0]!.created_at,
          ),
        });
      }
      // Mais antigo primeiro — é o que está esperando há mais tempo.
      items.sort((a, b) => a.oldest_created_at.getTime() - b.oldest_created_at.getTime());
      return {
        items,
        total: items.reduce((sum, i) => sum + i.pending_count, 0),
      };
    }),

  /**
   * Issue #470 — capacidades efetivas do agente para exibição no console:
   * grant row (packs/tools/denied) + resolução pack→tools via o registry
   * (grant-math, fail-closed). Edição de packs/denies: updateCapabilities
   * (fase 4); aquisição de tools NOVAS continua via propostas.
   */
  getCapabilities: protectedProcedure
    .input(GetByIdInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const agent = await ctx.repos.agentsRepo.findById(input.id);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }
      const grant = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: agent.id },
        async () => ctx.repos.agentToolGrantsRepo.findForCurrentAgent(),
      );
      // Mesmo contrato do runtime (resolveGrantedToolNames): com row, o único
      // piso inamovível é baseline.core — domain.calendar é padrão de CRIAÇÃO
      // (BASE_AGENT_PACKS/coluna default), mas revogável via updateCapabilities;
      // unir BASE_AGENT_PACKS aqui exibiria calendar como concedido após uma
      // revogação. Sem row ⇒ floor da plataforma (o que uma row nova teria).
      const grantedPacks = grant
        ? [...new Set(['baseline.core', ...grant.granted_packs])]
        : [...BASE_AGENT_PACKS];
      const deniedTools = grant?.denied_tools ?? [];
      const deniedSet = new Set(deniedTools);
      const packs = grantedPacks.map((id) => {
        const def = TOOL_PACKS[id];
        return {
          id,
          name: def?.name ?? id,
          risk_level: def?.risk_level ?? null,
          tools: def ? [...def.tools] : [],
          known: def !== undefined,
        };
      });
      const effectiveTools = [
        ...new Set([
          ...resolvePackTools(grantedPacks),
          ...(grant?.granted_tools ?? []),
        ]),
      ].filter((t) => !deniedSet.has(t));
      return {
        packs,
        granted_tools: grant?.granted_tools ?? [],
        denied_tools: deniedTools,
        effective_tool_count: effectiveTools.length,
        effective_tools: effectiveTools,
        reason: grant?.reason ?? null,
      };
    }),

  /**
   * Edição de grants de packs de domínio + hard denies do agente — fase 4 do
   * relatório de complexidade. Segue a decisão da spec §2.8 inaugurada por
   * mcp.setAgentPack ("primeira superfície de EDIÇÃO de grants"): owner/founder,
   * audit direto — aqui com upsert+audit ATÔMICOS (updateWithAudit, mesma
   * classe de invariante do review do PR #491). Aquisição de tools NOVAS
   * continua no fluxo de propostas (capability_proposals); esta superfície só
   * compõe packs já existentes no catálogo e denies.
   *
   * Regras fail-closed:
   *   - pack desconhecido no input ⇒ BAD_REQUEST (não é ignorado);
   *   - `baseline.core` é sempre reinserido (piso de runtime — ver
   *     resolveGrantedToolNames); packs fora do catálogo (mcp.*) do grant
   *     atual são preservados;
   *   - denied_tools: cada entrada precisa ser tool efetiva do NOVO conjunto,
   *     tool avulsa concedida, ou já estar negada hoje.
   */
  updateCapabilities: protectedProcedure
    .input(UpdateCapabilitiesInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const agent = await ctx.repos.agentsRepo.findById(input.agentId);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      const unknownPacks = input.granted_packs.filter((p) => TOOL_PACKS[p] === undefined);
      if (unknownPacks.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Unknown pack(s): ${unknownPacks.join(', ')} — only catalog packs can be granted here`,
        });
      }

      const current = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: agent.id },
        async () => ctx.repos.agentToolGrantsRepo.findForCurrentAgent(),
      );

      // Preserva packs não-gerenciados por esta superfície (fora do catálogo,
      // ex.: mcp.<server> — geridos em /setup/mcp). Sem isso, um save aqui
      // revogaria silenciosamente o acesso MCP concedido em outra tela.
      const unmanagedPacks = (current?.granted_packs ?? []).filter(
        (p) => TOOL_PACKS[p] === undefined,
      );
      const nextPacks = [
        ...new Set(['baseline.core', ...input.granted_packs, ...unmanagedPacks]),
      ];

      const grantedTools = current?.granted_tools ?? [];
      const nextEffective = new Set([...resolvePackTools(nextPacks), ...grantedTools]);
      const currentDenied = new Set(current?.denied_tools ?? []);
      const invalidDenies = input.denied_tools.filter(
        (t) => !nextEffective.has(t) && !currentDenied.has(t),
      );
      if (invalidDenies.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `denied_tools contains name(s) not visible to this agent: ` +
            `${invalidDenies.join(', ')} — a hard deny targets an effective tool`,
        });
      }

      const updated = await ctx.repos.agentToolGrantsRepo.updateWithAudit({
        tenant_id: tenantId,
        agent_id: agent.id,
        grant: {
          granted_packs: nextPacks,
          granted_tools: grantedTools,
          denied_tools: [...new Set(input.denied_tools)],
          granted_by: ctx.userId,
          reason: input.comment,
        },
        audit: {
          actor_id: ctx.userId,
          actor_role: ctx.userRole,
          action: 'agent_capabilities_update',
          previous: current
            ? {
                granted_packs: current.granted_packs,
                granted_tools: current.granted_tools,
                denied_tools: current.denied_tools,
              }
            : null,
        },
      });

      return {
        granted_packs: updated.granted_packs,
        denied_tools: updated.denied_tools,
      };
    }),

  create: protectedProcedure.input(CreateInputSchema).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);

    const tenant = await ctx.repos.tenantsRepo.findById(tenantId);
    if (!tenant) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Tenant ${tenantId} not found` });
    }

    // Codex review of PR #162 round 3 (issue #166) — agent insert + seed
    // profile_version + audit are now wrapped in a single tx via
    // agentsRepo.createWithSeedAndAudit. A failure on any of the three
    // rolls back the other two, so we cannot leave an agent with no seed
    // profile (which would break /identities setup) nor an unaudited
    // governance change. Same pattern as `approveAndActivateAtomic`.
    //
    // Codex Adversarial Review on PR #187 round 1 (issue #184) — the
    // pre-flight `agentsRepo.findById` here is gone: the atomic helper now
    // catches the agents primary-key 23505 inside the tx and returns
    // `{ ok: false, reason: 'duplicate_id' }`, which we map to CONFLICT.
    // This closes the TOCTOU window where two concurrent creates both passed
    // the existence check and one ended up bubbling a pg unique violation as
    // a 500 instead of the documented CONFLICT.
    const profileBody = buildProfileBody(input.profile_body, ctx.userId, null);
    // Issue #470 — função → packs de domínio. Sem arquétipo (clientes
    // antigos) ou 'custom', o agente nasce só com o floor da plataforma.
    const archetype = input.archetype ?? 'custom';
    const extraPacks = [...(ARCHETYPE_PACK_MAP[archetype] ?? [])];
    const result = await ctx.repos.agentsRepo.createWithSeedAndAudit({
      agent: {
        id: input.id,
        tenant_id: tenantId,
        nome: input.nome,
        status: input.status ?? 'active',
      },
      seed_profile: {
        profile_body: profileBody,
        proposed_by: ctx.userId,
        proposed_reason: input.proposed_reason,
      },
      audit: {
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
      },
      grant: {
        extra_packs: extraPacks,
        archetype: input.archetype ?? null,
      },
    });

    if (!result.ok) {
      if (result.reason === 'duplicate_id') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Agent '${result.agent_id}' already exists`,
        });
      }
      // Exhaustiveness check — any future reason must be handled above.
      const _exhaustive: never = result.reason;
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `createWithSeedAndAudit failed: ${String(_exhaustive)}`,
      });
    }

    return {
      agent: result.agent,
      seed_profile: {
        id: result.seed_profile.id,
        version: result.seed_profile.version,
        status: result.seed_profile.status,
      },
    };
  }),

  updateProfile: protectedProcedure
    .input(UpdateProfileInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const agent = await ctx.repos.agentsRepo.findById(input.agentId);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      // Read current active version OUTSIDE the tx — it's only used to chain
      // previous_version_id into the profile_body metadata. Concurrent
      // approveProfile races are guarded inside `approveAndActivateAtomic`
      // via FOR UPDATE on the active row, so a stale read here is bounded
      // (worst case: previous_version_id chains to a now-frozen row, which
      // is still a valid lineage marker).
      const activeVersion = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: agent.id },
        async () => ctx.repos.operationalProfileVersionsRepo.getActive(),
      );

      // Codex Adversarial Review of PR #201 round 2 [HIGH] — preserve
      // active.identity.principles when the request OMITS the field
      // (`undefined`). Explicit `principles: []` is honored (intentional
      // audited clear: the resulting profile_body documents the change for
      // diff). See buildProfileBody jsdoc for the full contract.
      const principlesOverride =
        input.profile_body.identity.principles === undefined
          ? extractActivePrinciples(activeVersion?.profile_body)
          : null;

      const profileBody = buildProfileBody(
        input.profile_body,
        ctx.userId,
        activeVersion?.id ?? null,
        principlesOverride,
      );

      // Codex review of PR #162 round 3 (issue #166) — profile_version
      // insert + audit are now wrapped in a single tx via
      // operationalProfileVersionsRepo.proposeAndAuditAtomic. A failure on
      // either rolls back the other, so we cannot leave a proposal with no
      // audit row.
      //
      // Codex Adversarial Review of PR #171 — the atomic helper now locks
      // the parent agent row with FOR UPDATE to serialize version
      // allocation. If the agent was deleted between our findById above
      // and the lock acquisition, the helper returns { agent_missing: true }
      // and we translate to NOT_FOUND (same outcome as the upfront check).
      const result = await ctx.repos.operationalProfileVersionsRepo.proposeAndAuditAtomic({
        tenant_id: tenantId,
        agent_id: agent.id,
        profile_body: profileBody,
        proposed_by: ctx.userId,
        proposed_reason: input.proposed_reason,
        previous_active_id: activeVersion?.id ?? null,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
      });
      if ('agent_missing' in result) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      return {
        version: {
          id: result.version.id,
          version: result.version.version,
          status: result.version.status,
        },
        previous_version_id: result.previous_version_id,
      };
    }),

  /**
   * Approve a `proposed` agent_operational_profile_versions row, transitioning
   * it to `active` and atomically freezing the previous active version (if any).
   *
   * Codex review #162 round 2 ([high] x2) — uses
   * `operationalProfileVersionsRepo.approveAndActivateAtomic`, which wraps:
   *   - lock proposed row
   *   - lock incumbent active (if any) and freeze it
   *   - activate proposed
   *   - append admin_audit_log
   * in a single transaction so partial commits cannot leave runtime state
   * mutated without an audit row, AND so subsequent updateProfile approvals
   * don't get stuck on `already_has_active`.
   *
   * Architecture-lock semantics are NOT applied here — operational profile is
   * per-agent state, not part of the immutable identity_immutable_core. If we
   * later decide it warrants dual approval, switch this to a Proposal Inbox
   * source.
   */
  approveProfile: protectedProcedure
    .input(ApproveProfileInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const agent = await ctx.repos.agentsRepo.findById(input.agentId);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      const result = await ctx.repos.operationalProfileVersionsRepo.approveAndActivateAtomic({
        tenant_id: tenantId,
        agent_id: agent.id,
        id: input.versionId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        comment: input.comment,
      });

      if (!result.ok) {
        if (result.reason === 'not_found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Version not found' });
        }
        if (result.reason === 'agent_missing') {
          // Codex Adversarial Review of PR #171 round 3 — the agent was
          // deleted between findById above and the parent-agent FOR UPDATE
          // lock inside the tx. Same outcome as the upfront NOT_FOUND.
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
        }
        if (result.reason === 'invalid_source_status') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Version is not in proposed state; refresh and retry',
          });
        }
        // Codex Adversarial Review of PR #171 round 2 — predecessor mismatch.
        // The active profile changed between the time this proposal was
        // authored and now. Approving would silently overwrite the newer
        // approved version with stale content. Surface a CONFLICT with the
        // diff so the client can refresh + re-propose against the current
        // incumbent.
        if (result.reason === 'predecessor_conflict') {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              `Active profile changed since this proposal was authored ` +
              `(expected predecessor ${String(result.expected)}, current ${String(result.current)}). ` +
              `Refresh and re-propose against the current active version.`,
          });
        }
        // Codex Adversarial Review of PR #171 round 3 (#173) — migration 061
        // backfilled `metadata.previous_version_id = null` + `migrated_from_legacy: true`
        // for every legacy row. Without distinguishing migrated proposals
        // from intentional seeds, an explicit-null predecessor on a
        // migrated row would silently activate against an empty active
        // slot. Surface a distinct CONFLICT so the operator re-proposes
        // under the post-migration flow with a real predecessor link.
        if (result.reason === 'migrated_legacy_proposal') {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              `This proposal was created by the v3.1.1 legacy backfill and has ` +
              `no known predecessor lineage. Re-propose the change against the ` +
              `current active version before approving.`,
          });
        }
        // Codex Adversarial Review of PR #182 round 3 (#186) — explicit
        // `null` predecessor on a non-seed proposal. Rejected because
        // approving would create a v2+ active row with no lineage anchor
        // (bypassing the stale-predecessor guard). The most common case is
        // a recovery window — agent has frozen/rolled_back versions but no
        // active row — and the operator tried to use the normal approve
        // path instead of re-proposing against the last known version.
        // PRECONDITION_FAILED communicates "the request is structurally
        // wrong for the current state" better than CONFLICT (which implies
        // someone else changed the state under you).
        if (result.reason === 'missing_predecessor') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `Proposal v${result.proposed_version} has no predecessor lineage ` +
              `(metadata.previous_version_id is null), but it is not a ` +
              `v1 intentional seed. ` +
              (result.current_predecessor === null
                ? `There is no active version to chain from — if this agent has ` +
                  `frozen or rolled_back versions, re-propose the change against ` +
                  `the last known version explicitly.`
                : `Current active version is ${String(result.current_predecessor)} — ` +
                  `re-propose the change against it.`),
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Approval transition failed: ${result.reason}`,
        });
      }

      return {
        activated: result.activated,
        frozen_previous: result.frozen_previous,
      };
    }),
});
