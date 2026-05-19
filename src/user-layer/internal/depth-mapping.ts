import type { UserDepth, KnowledgeDepth } from '../types.js';

const USER_DEPTH_LIMITS: Record<UserDepth, number> = {
  'none': 0,
  'minimal': 5,
  'relevant': 15,
  'deep': 50,
};

const KNOWLEDGE_DEPTH_LIMITS: Record<KnowledgeDepth, { facts: number; rules: number }> = {
  'none': { facts: 0, rules: 0 },
  'relevant': { facts: 10, rules: 5 },
  'deep': { facts: 50, rules: 30 },
};

export function getUserMaxItems(depth: UserDepth, override?: number): number {
  if (override !== undefined) return override;
  return USER_DEPTH_LIMITS[depth];
}

export function getKnowledgeMaxes(depth: KnowledgeDepth, override?: { facts?: number; rules?: number }) {
  const defaults = KNOWLEDGE_DEPTH_LIMITS[depth];
  return {
    facts: override?.facts ?? defaults.facts,
    rules: override?.rules ?? defaults.rules,
  };
}
