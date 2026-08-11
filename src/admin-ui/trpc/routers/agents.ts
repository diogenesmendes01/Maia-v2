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
 *   - Both mutations (create / updateProfile) go through repo-level "atomic"
 *     methods that take explicit tenant_id/agent_id and wrap their writes in
 *     `withTx`. Codex review of PR #162 round 3 (issue #166) closed the
 *     multi-write atomicity gap.
 *   - The tenant_id ALWAYS comes from the resolved ctx tenant (no body
 *     override for owner — only founder can supply a body tenantId).
 *   - We deliberately do NOT auto-activate the seeded profile. P8.5 invariant
 *     is "no profile activates without an approval"; admin-ui setup respects
 *     this — a freshly-created agent has no active profile until the seed is
 *     approved. Spec perfil-inbox v4 fase C: a DECISÃO de perfis vive só no
 *     motor unificado (`proposals.approve`/`reject` — /inbox e aba Versões
 *     chamam o mesmo endpoint); o shim `approveProfile` e o card bespoke
 *     `pendingProfileApprovals` foram removidos junto com a flag.
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
// Módulo puro (sem registry/db) — mesma gramática de nome que o bridge usa em
// runtime, para o console não inventar um nome de tool MCP diferente (#481).
import { mcpToolName } from '../../../tools/mcp-tool-names.js';

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
      // `principles` é campo canônico desde v3.1.2 (spec perfil-inbox §1.2) —
      // sem cast: o tipo ProfileBody admite o campo diretamente.
      principles,
      learned_voice_modifiers: [],
    },
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

/** Entrada de pack no contrato de `getCapabilities`. */
type CapabilityPack = {
  id: string;
  name: string;
  risk_level: string | null;
  tools: string[];
  known: boolean;
  /** true = pack de servidor externo (MCP), gerido em /setup/mcp. */
  external: boolean;
};

/**
 * Dependências mínimas (estruturais) de `resolveMcpPacks` — evita amarrar o
 * helper ao tipo completo do contexto tRPC e mantém o mock dos testes enxuto.
 */
type McpCapabilityCtx = {
  repos: {
    mcpServersRepo: {
      listByTenant(tenant_id: string): Promise<Array<{ name: string; status: string }>>;
    };
    mcpServerToolsRepo: {
      listExecutable(args: {
        tenant_id: string;
      }): Promise<Array<{ tool_name: string; risk_class: string; server_name: string }>>;
    };
  };
};

const MCP_PACK_PREFIX = 'mcp.';
const RISK_ORDER = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Issue #481 item 3 — resolve os packs `mcp.<server>` do grant contra as SoTs
 * de MCP. Retorna um mapa pack_id → entrada pronta para o card.
 *
 * Fail-soft por design: se as SoTs de MCP não responderem, cada pack MCP cai
 * na entrada "crua" (id, 0 tools) — o card degrada como hoje em vez de a tela
 * inteira de capacidades quebrar. NÃO é fail-open de segurança: nada aqui
 * concede acesso; a execução é revalidada no bridge a cada chamada.
 */
async function resolveMcpPacks(
  ctx: McpCapabilityCtx,
  tenantId: string,
  grantedPacks: readonly string[],
): Promise<Map<string, CapabilityPack>> {
  const out = new Map<string, CapabilityPack>();
  const mcpPackIds = grantedPacks.filter(
    (id) => TOOL_PACKS[id] === undefined && id.startsWith(MCP_PACK_PREFIX),
  );
  if (mcpPackIds.length === 0) return out;

  let sots:
    | [
        Array<{ name: string; status: string }>,
        Array<{ tool_name: string; risk_class: string; server_name: string }>,
      ]
    | null;
  try {
    sots = await Promise.all([
      ctx.repos.mcpServersRepo.listByTenant(tenantId),
      ctx.repos.mcpServerToolsRepo.listExecutable({ tenant_id: tenantId }),
    ]);
  } catch {
    sots = null;
  }
  if (sots === null) return out;
  const [servers, executable] = sots;

  const serverByName = new Map(servers.map((s) => [s.name, s]));
  const toolsByServer = new Map<string, Array<{ tool_name: string; risk_class: string }>>();
  for (const t of executable) {
    const list = toolsByServer.get(t.server_name);
    if (list) list.push(t);
    else toolsByServer.set(t.server_name, [t]);
  }

  for (const packId of mcpPackIds) {
    const serverName = packId.slice(MCP_PACK_PREFIX.length);
    const server = serverByName.get(serverName);
    const tools = toolsByServer.get(serverName) ?? [];
    // Pack apontando para server inexistente/removido: mantém o id cru, que
    // é o sinal honesto de "grant órfão" para o operador.
    if (!server) {
      out.set(packId, {
        id: packId,
        name: packId,
        risk_level: null,
        tools: [],
        known: false,
        external: true,
      });
      continue;
    }
    const risk = tools.reduce<string | null>((acc, t) => {
      const a = acc === null ? -1 : RISK_ORDER.indexOf(acc as (typeof RISK_ORDER)[number]);
      const b = RISK_ORDER.indexOf(t.risk_class as (typeof RISK_ORDER)[number]);
      return b > a ? t.risk_class : acc;
    }, null);
    out.set(packId, {
      id: packId,
      // Server desativado ainda aparece — mas o operador precisa ver POR QUE
      // o pack não rende ferramentas (listExecutable já exclui server
      // inativo, então `tools` vem vazia).
      name: server.status === 'active' ? `MCP · ${serverName}` : `MCP · ${serverName} (desativado)`,
      risk_level: risk,
      tools: tools.map((t) => mcpToolName(serverName, t.tool_name)),
      known: true,
      external: true,
    });
  }
  return out;
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
   * Issue #470 — capacidades efetivas do agente para exibição no console:
   * grant row (packs/tools/denied) + resolução pack→tools via o registry
   * (grant-math, fail-closed). Edição de packs/denies: updateCapabilities
   * (fase 4); aquisição de tools NOVAS continua via propostas.
   *
   * Issue #481 item 3 — packs `mcp.<server>` NÃO vivem no catálogo estático
   * (são dados por tenant, criados em /setup/mcp). Antes caíam no ramo
   * "desconhecido" e apareciam no card com o id cru e 0 ferramentas. Agora
   * são resolvidos contra as SoTs de MCP: nome do server (mcp_servers) e
   * ferramentas realmente EXECUTÁVEIS (aprovadas + read-only + server ativo,
   * `mcpServerToolsRepo.listExecutable`) — a mesma lista que o bridge usa em
   * runtime, então o console não promete o que o dispatcher recusaria.
   *
   * `effective_tools`/`effective_tool_count` continuam sendo SÓ tools do
   * REGISTRY, de propósito: (a) a visibilidade MCP é gated por
   * FEATURE_MCP_TOOLS no processo do runtime (default OFF) e capada por
   * turno, e (b) `denied_tools` não se aplica a nomes `mcp:*` (o bridge não
   * consulta hard-denies) — contá-las aqui prometeria um controle que não
   * existe. Os packs externos são marcados com `external: true` para o card
   * poder explicar a diferença.
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
      const mcpPacks = await resolveMcpPacks(ctx, tenantId, grantedPacks);
      const packs = grantedPacks.map((id) => {
        const def = TOOL_PACKS[id];
        if (def) {
          return {
            id,
            name: def.name ?? id,
            risk_level: def.risk_level ?? null,
            tools: [...def.tools],
            known: true,
            external: false,
          };
        }
        return (
          mcpPacks.get(id) ?? {
            id,
            name: id,
            risk_level: null,
            tools: [] as string[],
            known: false,
            external: false,
          }
        );
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

      // Review do PR #494 [medium]: todo o read-modify-write roda dentro da
      // transação do helper, com o grant atual lido sob FOR UPDATE — a
      // preservação de packs não-gerenciados e a validação de denies são
      // computadas contra o estado SERIALIZADO, não contra um snapshot que
      // outro writer (ex.: toggle MCP em /setup/mcp) pode ter invalidado.
      const result = await ctx.repos.agentToolGrantsRepo.updateWithAudit({
        tenant_id: tenantId,
        agent_id: agent.id,
        compute: (current) => {
          // Preserva packs não-gerenciados por esta superfície (fora do
          // catálogo, ex.: mcp.<server> — geridos em /setup/mcp). Sem isso,
          // um save aqui revogaria silenciosamente o acesso MCP concedido
          // em outra tela.
          const unmanagedPacks = (current?.granted_packs ?? []).filter(
            (p) => TOOL_PACKS[p] === undefined,
          );
          const nextPacks = [
            ...new Set(['baseline.core', ...input.granted_packs, ...unmanagedPacks]),
          ];
          const grantedTools = current?.granted_tools ?? [];
          const nextEffective = new Set([
            ...resolvePackTools(nextPacks),
            ...grantedTools,
          ]);
          const currentDenied = new Set(current?.denied_tools ?? []);
          const invalidDenies = input.denied_tools.filter(
            (t) => !nextEffective.has(t) && !currentDenied.has(t),
          );
          if (invalidDenies.length > 0) {
            return { ok: false, reject: { invalid_denies: invalidDenies } };
          }
          return {
            ok: true,
            granted_packs: nextPacks,
            granted_tools: grantedTools,
            denied_tools: [...new Set(input.denied_tools)],
          };
        },
        granted_by: ctx.userId,
        reason: input.comment,
        audit: {
          actor_id: ctx.userId,
          actor_role: ctx.userRole,
          action: 'agent_capabilities_update',
        },
      });

      if (!result.ok) {
        const reject = result.reject as { invalid_denies?: string[] };
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            `denied_tools contains name(s) not visible to this agent: ` +
            `${(reject.invalid_denies ?? []).join(', ')} — a hard deny targets an effective tool`,
        });
      }

      return {
        granted_packs: result.grant.granted_packs,
        denied_tools: result.grant.denied_tools,
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
      // approval races are guarded inside `approveAndActivateInTx` (motor
      // unificado) via FOR UPDATE on the active row, so a stale read here is bounded
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

});
