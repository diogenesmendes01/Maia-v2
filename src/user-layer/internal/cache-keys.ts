import crypto from 'crypto';

export function buildUserSliceCacheKey(args: {
  tenant_id: string;
  pessoa_id: string;
  depth: string;
  intent_label?: string;
  scope_hint?: string[];
}): string {
  const scopeHash = args.scope_hint ? crypto.createHash('sha256').update(JSON.stringify(args.scope_hint)).digest('hex').slice(0, 8) : 'default';
  const intentHash = args.intent_label ? crypto.createHash('sha256').update(args.intent_label).digest('hex').slice(0, 8) : 'none';
  return `user_slice:v1:${args.tenant_id}:${args.pessoa_id}:${args.depth}:${intentHash}:${scopeHash}`;
}

export function buildKnowledgeSliceCacheKey(args: {
  tenant_id: string;
  depth: string;
  scope_hint?: string[];
  domain?: string;
  intent_label?: string;
}): string {
  const scopeHash = args.scope_hint ? crypto.createHash('sha256').update(JSON.stringify(args.scope_hint)).digest('hex').slice(0, 8) : 'default';
  const intentHash = args.intent_label ? crypto.createHash('sha256').update(args.intent_label).digest('hex').slice(0, 8) : 'none';
  const domain = args.domain ?? 'global';
  return `knowledge_slice:v1:${args.tenant_id}:${args.depth}:${scopeHash}:${domain}:${intentHash}`;
}
