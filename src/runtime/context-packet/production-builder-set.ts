/**
 * P8a — Production SliceBuilderSet factory.
 *
 * Wires the seven P8a slice builders. user/knowledge/policy/skill/tool still
 * bind STUB adapters even though their backing phases have since shipped
 * (P8c user-layer facade — `src/user-layer/`, P8e policy resolver —
 * `src/control-plane/policy/`, P9a skill registry —
 * `src/control-plane/skill-registry/`); wiring the real implementations here
 * is unblocked but was never done — PR #406 removed the
 * FEATURE_CONTEXT_PACKET_V1 hot path, leaving this assembly path unwired from
 * the agent loop (slated for the plumbing-teardown wave).
 *
 * Exported as a lazy singleton (created once on first call) so the builders
 * share the same InMemorySliceCache instance across turns in the process.
 *
 * P8b: soulBiasesRepoPort wired (real port backed by soulBiasesRepo).
 * Issue #206: realIdentityPort wired (real port backed by
 * operationalProfileVersionsRepo). Tenant/agent resolve via AsyncLocalStorage
 * inside the repo — the port adapter passes no tenant argument so the
 * tenant-isolation invariant cannot be violated by a confused caller.
 */

import { IdentitySliceBuilder } from '../context-assembly/slice-builders/identity-slice-builder.js';
import type {
  OperationalProfilePort,
  OperationalProfileRecord,
} from '../context-assembly/slice-builders/identity-slice-builder.js';
import { UserSliceBuilder } from '../context-assembly/slice-builders/user-slice-builder.js';
import {
  KnowledgeSliceBuilder,
  type KnowledgeRepoPort,
} from '../context-assembly/slice-builders/knowledge-slice-builder.js';
import {
  SoulSliceBuilder,
  soulBiasesRepoPort,
} from '../context-assembly/slice-builders/soul-slice-builder.js';
import {
  PolicySliceBuilder,
  stubPolicyDescriptorResolver,
} from '../context-assembly/slice-builders/policy-slice-builder.js';
import { SkillSliceBuilder } from '../context-assembly/slice-builders/skill-slice-builder.js';
import { ToolPermissionSliceBuilder } from '../context-assembly/slice-builders/tool-slice-builder.js';
import {
  AudienceSliceBuilder,
  type AudienceRepoPort,
} from '../context-assembly/slice-builders/audience-slice-builder.js';
import { InMemorySliceCache } from './cache/slice-cache.js';
import type { SliceBuilderSet } from './build-context-packet.js';
import {
  operationalProfileVersionsRepo,
  pessoasRepo,
  agentAudienceProfilesRepo,
} from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import type { Pessoa } from '@/db/schema.js';

// ─── Real Identity port (Issue #206) ──────────────────────────────────────────

/**
 * Real OperationalProfilePort backed by `operationalProfileVersionsRepo`.
 *
 * Issue #206: replaces the previous `stubIdentityPort` that always returned
 * `null`. With the stub in place, `IdentitySliceBuilder` always rendered
 * `EMPTY_IDENTITY` when `FEATURE_CONTEXT_PACKET_V1=true`, so migrated rows
 * (priorities=[], principles=[...]) never reached the prompt renderer.
 *
 * Tenant isolation:
 *   The underlying `operationalProfileVersionsRepo.getActive()` resolves
 *   `tenant_id` and `agent_id` from AsyncLocalStorage via
 *   `getCurrentTenant()` / `getCurrentAgent()`. Agent core wraps each turn
 *   in `runWithTenantContext` (`src/agent/core.ts`), so the active context
 *   is always present at the call site. The port adapter intentionally
 *   ignores its positional `tenant_id` / `agent_id` arguments — the
 *   AsyncLocalStorage value is the only trusted source. A confused caller
 *   passing a wrong tenant_id literal would be silently overridden by the
 *   context, preserving the inviolable tenant-isolation invariant.
 *
 * Status filter:
 *   Defense-in-depth: even though `operationalProfileVersionsRepo.getActive`
 *   already filters `WHERE status = 'active'`, we re-check
 *   `profile.status === 'active'` and treat any drift (frozen, rolled_back)
 *   as "no active profile". Mirrors `buildIdentitySlice()` in
 *   `identity-slice-builder.ts`.
 */
const realIdentityPort: OperationalProfilePort = {
  async getActive(_tenant_id: string, _agent_id: string) {
    const profile = await operationalProfileVersionsRepo.getActive();
    if (!profile || profile.status !== 'active') return null;
    return {
      id: profile.id,
      profile_body: profile.profile_body as OperationalProfileRecord['profile_body'],
    };
  },
};

const stubUserPort = {
  async getPessoa(_tenant_id: string, _pessoa_id: string | null) {
    return null;
  },
  async listMemories(
    _tenant_id: string,
    _pessoa_id: string | null,
    _opts: { depth: string; max_items: number },
  ) {
    return [];
  },
  async listBehavioralHints(_tenant_id: string, _pessoa_id: string | null) {
    return [];
  },
};

const stubKnowledgeRepo: KnowledgeRepoPort = {
  async listFacts() {
    return [];
  },
  async listRules() {
    return [];
  },
};

const stubSkillRepo = {
  async getSkillById(_tenant_id: string, _skill_id: string) {
    return null;
  },
  async listSkillSummaries(_tenant_id: string, _skill_ids: string[]) {
    return [];
  },
};

const stubToolRegistry = {
  async getToolDescriptor(_name: string) {
    return null;
  },
};

/**
 * Real audience port (issue #407) backed by `pessoasRepo` +
 * `agentAudienceProfilesRepo` + `resolveScope`. Tenant isolation: all three
 * resolve (tenant_id, agent_id) from AsyncLocalStorage; the port ignores any
 * caller-supplied scope, so a confused caller cannot read another agent's
 * audience.
 */
const realAudiencePort: AudienceRepoPort = {
  async getPessoa(contact_id: string) {
    return pessoasRepo.findById(contact_id);
  },
  async getProfile(contact_id: string) {
    return agentAudienceProfilesRepo.findByPessoa(contact_id);
  },
  async getAllowedEntityIds(pessoa: Pessoa) {
    const scope = await resolveScope(pessoa);
    return scope.entidades;
  },
};

// ─── Singleton ────────────────────────────────────────────────────────────────

/**
 * The 7 P8a slices assembled by `buildContextPacket` PLUS the #407 audience
 * builder. `audience` is NOT part of `SliceBuilderSet` (the orchestrator does
 * not yet assemble it — that is #410); it is exposed here so #410 and tests can
 * obtain the production-wired builder + shared cache from one place.
 */
export interface ProductionBuilderSet {
  builders: SliceBuilderSet;
  audience: AudienceSliceBuilder;
  cache: InMemorySliceCache;
}

let _singleton: ProductionBuilderSet | null = null;

export function getProductionBuilderSet(): ProductionBuilderSet {
  if (_singleton) return _singleton;

  const cache = new InMemorySliceCache();

  const builders: SliceBuilderSet = {
    identity: new IdentitySliceBuilder(
      realIdentityPort,
      cache,
    ) as unknown as SliceBuilderSet['identity'],
    user: new UserSliceBuilder(
      stubUserPort,
      cache,
    ) as unknown as SliceBuilderSet['user'],
    knowledge: new KnowledgeSliceBuilder(
      stubKnowledgeRepo,
      cache,
    ) as unknown as SliceBuilderSet['knowledge'],
    soul: new SoulSliceBuilder(
      soulBiasesRepoPort,
      cache,
    ) as unknown as SliceBuilderSet['soul'],
    policy: new PolicySliceBuilder(
      stubPolicyDescriptorResolver,
      cache,
    ) as unknown as SliceBuilderSet['policy'],
    skill: new SkillSliceBuilder(
      stubSkillRepo,
      cache,
    ) as unknown as SliceBuilderSet['skill'],
    tool: new ToolPermissionSliceBuilder(
      stubToolRegistry,
      cache,
    ) as unknown as SliceBuilderSet['tool'],
  };

  const audience = new AudienceSliceBuilder(realAudiencePort, cache);

  _singleton = { builders, audience, cache };
  return _singleton;
}
