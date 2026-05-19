export type UserDepth = 'none' | 'minimal' | 'relevant' | 'deep';
export type KnowledgeDepth = 'none' | 'relevant' | 'deep';

export type KnowledgeLifecycleStatus =
  | 'proposed'
  | 'pending_review'
  | 'ephemeral'
  | 'observed'
  | 'reinforced'
  | 'verified'
  | 'active'
  | 'deprecated'
  | 'revoked';

// ────────────────────────────────────────────────────────────
// UserSlice — interlocutor, perfil, memórias, hints (SEM learned_rules)
// ────────────────────────────────────────────────────────────
export interface UserSlice {
  depth: UserDepth;

  interlocutor: {
    pessoa_id: string;
    nome_preferido: string;
    apelido?: string;
    tipo: string;
    status: 'ativa' | 'pausada' | 'arquivada';
  };

  profile: {
    preferencias: Record<string, unknown>;
    modelo_mental: Record<string, unknown>;
    observacoes_curta?: string;
  };

  memories: Array<{
    id: string;
    conteudo: string;
    memory_type: string;
    scope: string;
    sensitivity: 'low' | 'medium' | 'high';
    proactive_use: boolean;
    mention_allowed: boolean;
    confidence: number;
    lifecycle_status: KnowledgeLifecycleStatus;
    created_at: string;
  }>;

  behavioral_hints: Array<{
    id: string;
    hint: string;
    scope: string;
    confidence: number;
    lifecycle_status: KnowledgeLifecycleStatus;
  }>;

  meta: {
    cache_hit: boolean;
    truncated: boolean;
    items_total: number;
    items_returned: number;
  };
}

// ────────────────────────────────────────────────────────────
// KnowledgeSlice — facts + rules (operacional do tenant, SEM memórias)
// ────────────────────────────────────────────────────────────
export interface KnowledgeSlice {
  depth: KnowledgeDepth;

  facts: Array<{
    key: string;
    value: unknown;
    scope: 'global' | 'tenant' | 'domain' | 'entity';
    confidence: number;
    source: string;
    lifecycle_status: KnowledgeLifecycleStatus;
  }>;

  rules: Array<{
    id: string;
    context: string;
    action: string;
    confidence: number;
    lifecycle_status: KnowledgeLifecycleStatus;
  }>;

  meta: {
    cache_hit: boolean;
    truncated: boolean;
    facts_total: number;
    rules_total: number;
  };
}
