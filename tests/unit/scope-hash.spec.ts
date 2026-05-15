import { describe, it, expect } from 'vitest';
import { hashScope } from '../../src/agent/scope-hash.js';
import type { ResolvedPermission } from '../../src/governance/permissions.js';

/**
 * Tests for the scope-hash helper. The hash is used by prompt-builder to
 * detect state-change between turns (issue #73). It must be deterministic,
 * order-independent across entidades, and sensitive to the fields that drive
 * what the LLM is told about the conversation's scope.
 */

const FIXED_DATES = {
  permissao_created: new Date('2026-01-01T00:00:00Z'),
};

function mkPerm(opts: {
  entidade_id: string;
  profile_id: string;
  permissao_status?: 'ativa' | 'inativa';
  valor_max?: number;
}): ResolvedPermission {
  return {
    permissao: {
      id: 'perm-' + opts.entidade_id,
      pessoa_id: 'pessoa-1',
      entidade_id: opts.entidade_id,
      papel: 'dono',
      profile_id: opts.profile_id,
      acoes_permitidas: [],
      limites: {},
      status: opts.permissao_status ?? 'ativa',
      created_at: FIXED_DATES.permissao_created,
    },
    profile: {
      id: opts.profile_id,
      nome: opts.profile_id,
      acoes: ['*'],
      limite_default: '0',
      descricao: null,
      created_at: FIXED_DATES.permissao_created,
    },
    effective_limits: { valor_max: opts.valor_max ?? 0 },
  };
}

function mkScope(perms: ResolvedPermission[]) {
  const byEntity = new Map<string, ResolvedPermission>();
  const entidades: string[] = [];
  for (const rp of perms) {
    byEntity.set(rp.permissao.entidade_id!, rp);
    entidades.push(rp.permissao.entidade_id!);
  }
  return { entidades, byEntity };
}

describe('hashScope', () => {
  it('returns the same hash for the same scope', () => {
    const s = mkScope([mkPerm({ entidade_id: 'ent-1', profile_id: 'prof-a', valor_max: 1000 })]);
    expect(hashScope(s)).toBe(hashScope(s));
  });

  it('is independent of entidade insertion order', () => {
    const a = mkScope([
      mkPerm({ entidade_id: 'ent-1', profile_id: 'prof-a' }),
      mkPerm({ entidade_id: 'ent-2', profile_id: 'prof-b' }),
    ]);
    const b = mkScope([
      mkPerm({ entidade_id: 'ent-2', profile_id: 'prof-b' }),
      mkPerm({ entidade_id: 'ent-1', profile_id: 'prof-a' }),
    ]);
    expect(hashScope(a)).toBe(hashScope(b));
  });

  it('changes when a new entidade enters the scope (Repro 1 of #73)', () => {
    const empty = mkScope([]);
    const withPf = mkScope([mkPerm({ entidade_id: 'ent-pf', profile_id: 'owner' })]);
    expect(hashScope(empty)).not.toBe(hashScope(withPf));
  });

  it('changes when the profile assigned to an entidade changes', () => {
    const a = mkScope([mkPerm({ entidade_id: 'ent-1', profile_id: 'profile-a' })]);
    const b = mkScope([mkPerm({ entidade_id: 'ent-1', profile_id: 'profile-b' })]);
    expect(hashScope(a)).not.toBe(hashScope(b));
  });

  it('changes when the permission status changes (e.g., ativa → inativa)', () => {
    const ativa = mkScope([
      mkPerm({ entidade_id: 'ent-1', profile_id: 'prof', permissao_status: 'ativa' }),
    ]);
    const inativa = mkScope([
      mkPerm({ entidade_id: 'ent-1', profile_id: 'prof', permissao_status: 'inativa' }),
    ]);
    expect(hashScope(ativa)).not.toBe(hashScope(inativa));
  });

  it('changes when valor_max effective limit changes', () => {
    const lo = mkScope([mkPerm({ entidade_id: 'ent-1', profile_id: 'p', valor_max: 100 })]);
    const hi = mkScope([mkPerm({ entidade_id: 'ent-1', profile_id: 'p', valor_max: 1000 })]);
    expect(hashScope(lo)).not.toBe(hashScope(hi));
  });

  it('returns a stable non-empty string for the empty scope', () => {
    const h = hashScope(mkScope([]));
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});
