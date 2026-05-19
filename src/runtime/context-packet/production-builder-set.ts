/**
 * P8a — Production SliceBuilderSet factory.
 *
 * Wires the seven P8a slice builders with stub adapters for sub-phases that are
 * not yet shipped (P8b Soul, P8c User facade, P8e Policy resolver).
 * Real adapters will replace the stubs in those phases.
 *
 * Exported as a lazy singleton (created once on first call) so the builders
 * share the same InMemorySliceCache instance across turns in the process.
 *
 * P8b: soulBiasesRepoPort wired (real port backed by soulBiasesRepo).
 * TODO(P8c): replace stub user repo with real user-layer facade.
 * TODO(P8e): replace stubPolicyDescriptorResolver with real resolver.
 */

import { IdentitySliceBuilder } from '../context-assembly/slice-builders/identity-slice-builder.js';
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
import { InMemorySliceCache } from './cache/slice-cache.js';
import type { SliceBuilderSet } from './build-context-packet.js';

// ─── Stub repo adapters (replaced in later phases) ───────────────────────────

const stubIdentityPort = {
  async getActive(_tenant_id: string) {
    return null;
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

// ─── Singleton ────────────────────────────────────────────────────────────────

let _singleton: { builders: SliceBuilderSet; cache: InMemorySliceCache } | null = null;

export function getProductionBuilderSet(): {
  builders: SliceBuilderSet;
  cache: InMemorySliceCache;
} {
  if (_singleton) return _singleton;

  const cache = new InMemorySliceCache();

  const builders: SliceBuilderSet = {
    identity: new IdentitySliceBuilder(
      stubIdentityPort,
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

  _singleton = { builders, cache };
  return _singleton;
}
