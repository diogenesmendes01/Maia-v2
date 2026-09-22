/**
 * P09 (spec §7.7) — compilador e publicador.
 *
 * As duas propriedades que sustentam tudo aqui:
 *
 *  1. **Determinismo.** O digest é o que o wrapper confere antes de executar.
 *     Se a mesma skill compilasse para digests diferentes, a conferência
 *     passaria a reprovar publicação legítima — e o único jeito de fazê-la
 *     parar de reprovar seria afrouxá-la.
 *  2. **Imutabilidade.** Conteúdo diferente exige digest diferente. Sem isso,
 *     a mesma assinatura aprovaria duas coisas distintas, e a assinatura
 *     deixaria de significar algo.
 */
import { describe, it, expect, vi } from 'vitest';
import { compileSkillBundle, bundleTechnicalName } from '@/learning/compiler.js';
import type { SkillSourceV1 } from '@/learning/compiler.js';
import {
  publishBundle,
  revokeBundle,
  type PublicationRecordV1,
  type PublicationStoreV1,
} from '@/learning/publisher.js';

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const POLITICA_OK = {
  allowed_audience: ['owner'],
  data_scope: ['own_customer_data_only'],
  exposure_policy: 'internal_only',
  requires_auth_level: 'known_external',
  requires_confirmation: false,
};

function skill(over: Partial<SkillSourceV1> = {}): SkillSourceV1 {
  return {
    skill_id: '11111111-1111-4111-8111-111111111111',
    version: 3,
    tenant_id: 'tenant-A',
    agent_id: null,
    goal: 'Conferir saldo',
    when_to_use: 'Quando perguntarem do saldo',
    category: 'financeiro',
    procedure: 'Passo 1. Passo 2.',
    constraints: ['nunca inventar valor'],
    allowed_tools: ['query_balance', 'list_transactions'],
    applicable_to_role: ['consultor'],
    usage_policy: POLITICA_OK,
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    status: 'active',
    approved_by: 'founder-1',
    approved_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('compileSkillBundle — determinismo', () => {
  it('a mesma skill produz o MESMO digest, em execuções distintas', () => {
    const a = compileSkillBundle(skill());
    const b = compileSkillBundle(skill());
    expect(a.kind).toBe('compiled');
    expect(b.kind).toBe('compiled');
    expect(a.kind === 'compiled' && a.bundle.bundle_digest).toBe(
      b.kind === 'compiled' && b.bundle.bundle_digest,
    );
  });

  it('a ORDEM das listas de entrada não muda o digest', () => {
    // Se mudasse, duas gravações equivalentes no banco produziriam bundles
    // "diferentes" e a supersedência disparararia sem mudança real.
    const a = compileSkillBundle(skill({ allowed_tools: ['a_tool', 'b_tool'] }));
    const b = compileSkillBundle(skill({ allowed_tools: ['b_tool', 'a_tool'] }));
    expect(a.kind === 'compiled' && a.bundle.bundle_digest).toBe(
      b.kind === 'compiled' && b.bundle.bundle_digest,
    );
  });

  it('mudar o CONTEÚDO muda o digest', () => {
    const a = compileSkillBundle(skill());
    const b = compileSkillBundle(skill({ procedure: 'Passo 1. Passo 2. Passo 3.' }));
    expect(a.kind === 'compiled' && a.bundle.bundle_digest).not.toBe(
      b.kind === 'compiled' && b.bundle.bundle_digest,
    );
  });

  it('o nome técnico vem do UUID e da versão, nunca do texto da skill', () => {
    // §7.7.1: descriptor é preservado como DADO. Um nome derivado dele seria
    // conteúdo do outro lado virando caminho de diretório.
    const n = bundleTechnicalName('11111111-1111-4111-8111-111111111111', 3);
    expect(n).toBe('s_11111111111141118111111111111111_v3');
    expect(n).not.toContain('saldo');
  });
});

describe('compileSkillBundle — onde ele recusa', () => {
  it('política malformada BLOQUEIA', () => {
    // Uma política que não parseia é uma política que ninguém consegue
    // avaliar; publicar assim entregaria a skill sem regra.
    const r = compileSkillBundle(skill({ usage_policy: { allowed_audience: 'owner' } }));
    expect(r).toMatchObject({ kind: 'blocked', reason: 'usage_policy_malformed' });
  });

  it('política ausente cai no default CONSERVADOR, não em public_safe', () => {
    for (const vazio of [null, undefined, {}]) {
      const r = compileSkillBundle(skill({ usage_policy: vazio }));
      expect(r.kind).toBe('compiled');
      const pol =
        r.kind === 'compiled'
          ? (JSON.parse(r.bundle.files['references/usage-policy.json']) as {
              exposure_policy: string;
            })
          : null;
      expect(pol?.exposure_policy).toBe('internal_only');
      expect(pol?.exposure_policy).not.toBe('public_safe');
    }
  });

  it('wildcard em allowed_tools BLOQUEIA', () => {
    const r = compileSkillBundle(skill({ allowed_tools: ['query_*'] }));
    expect(r).toMatchObject({ kind: 'blocked', reason: 'wildcard_tool' });
  });

  it('skill não ativa não é publicável', () => {
    expect(compileSkillBundle(skill({ status: 'pending_review' }))).toMatchObject({
      kind: 'blocked',
      reason: 'not_approved',
    });
  });

  it('o default do canário exclui confirmação e exposição que exige aprovação', () => {
    // `evaluateUsagePolicy` DECLARA esses campos e não os executa como gates.
    // Publicar assim alegaria uma garantia que o avaliador não dá.
    expect(
      compileSkillBundle(skill({ usage_policy: { ...POLITICA_OK, requires_confirmation: true } })),
    ).toMatchObject({ kind: 'blocked', reason: 'confirmation_not_wired' });

    expect(
      compileSkillBundle(
        skill({ usage_policy: { ...POLITICA_OK, exposure_policy: 'approval_required' } }),
      ),
    ).toMatchObject({ kind: 'blocked', reason: 'exposure_requires_approval' });
  });

  it('o manifest NÃO expõe quem aprovou', () => {
    // §7.7.1: aprovação é metadado PRIVADO de governança. O bundle atravessa;
    // o nome de quem assinou fica do lado de cá.
    const r = compileSkillBundle(skill());
    expect(r.kind === 'compiled' && r.bundle.files['manifest.json']).not.toContain('founder-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function store(inicial: PublicationRecordV1[] = []) {
  const linhas = [...inicial];
  const s: PublicationStoreV1 = {
    findByDigest: async (d) => linhas.find((r) => r.bundle_digest === d) ?? null,
    listLiveFor: async ({ skill_id, target }) =>
      linhas.filter(
        (r) =>
          r.skill_id === skill_id &&
          r.revoked_at === null &&
          r.target.tenant_id === target.tenant_id &&
          r.target.agent_id === target.agent_id,
      ),
    insert: async (r) => {
      linhas.push({ ...r });
    },
    markRevoked: async ({ bundle_digest, revoked_at, reason }) => {
      const r = linhas.find((x) => x.bundle_digest === bundle_digest);
      if (r) {
        r.revoked_at = revoked_at;
        r.revoked_reason = reason;
      }
    },
  };
  return { store: s, linhas };
}

describe('publishBundle — imutabilidade e supersedência', () => {
  const alvo = { tenant_id: 'tenant-A', agent_id: null };

  it('republicar o MESMO digest é idempotente e não cria linha nova', async () => {
    const r = compileSkillBundle(skill());
    if (r.kind !== 'compiled') throw new Error('compilou não');
    const { store: st, linhas } = store();

    const base = {
      bundle: r.bundle,
      skill_id: 's',
      version: 3,
      target: alvo,
      approved_by: 'f',
      store: st,
    };
    const um = await publishBundle(base);
    const dois = await publishBundle(base);

    expect(um.kind).toBe('published');
    expect(dois.kind).toBe('idempotent');
    expect(linhas).toHaveLength(1);
  });

  it('publicar versão nova REVOGA a anterior viva do mesmo escopo', async () => {
    // Duas publicações vivas fariam a escolha de qual roda depender de quem lê
    // primeiro.
    const v3 = compileSkillBundle(skill({ version: 3 }));
    const v4 = compileSkillBundle(skill({ version: 4, procedure: 'outro' }));
    if (v3.kind !== 'compiled' || v4.kind !== 'compiled') throw new Error('compilou não');
    const { store: st, linhas } = store();

    await publishBundle({
      bundle: v3.bundle,
      skill_id: 's',
      version: 3,
      target: alvo,
      approved_by: 'f',
      store: st,
    });
    const r = await publishBundle({
      bundle: v4.bundle,
      skill_id: 's',
      version: 4,
      target: alvo,
      approved_by: 'f',
      store: st,
    });

    expect(r.kind === 'published' && r.superseded).toEqual([v3.bundle.bundle_digest]);
    expect(
      linhas.find((x) => x.bundle_digest === v3.bundle.bundle_digest)?.revoked_at,
    ).not.toBeNull();
  });

  it('digest REVOGADO não volta por republicação', async () => {
    // Nada distinguiria "voltou por decisão" de "voltou porque um pipeline
    // rodou de novo".
    const r = compileSkillBundle(skill());
    if (r.kind !== 'compiled') throw new Error('compilou não');
    const { store: st } = store();
    const base = {
      bundle: r.bundle,
      skill_id: 's',
      version: 3,
      target: alvo,
      approved_by: 'f',
      store: st,
    };

    await publishBundle(base);
    await revokeBundle({ bundle_digest: r.bundle.bundle_digest, reason: 'incidente', store: st });
    expect(await publishBundle(base)).toMatchObject({ kind: 'refused', reason: 'digest_revoked' });
  });
});

describe('revokeBundle — idempotente sem mover a data', () => {
  it('revogar duas vezes preserva a data ORIGINAL', async () => {
    const r = compileSkillBundle(skill());
    if (r.kind !== 'compiled') throw new Error('compilou não');
    const { store: st } = store();
    await publishBundle({
      bundle: r.bundle,
      skill_id: 's',
      version: 3,
      target: { tenant_id: 'tenant-A', agent_id: null },
      approved_by: 'f',
      store: st,
    });

    const t1 = new Date('2026-01-01T00:00:00.000Z');
    await revokeBundle({
      bundle_digest: r.bundle.bundle_digest,
      reason: 'a',
      store: st,
      now: () => t1,
    });
    const segunda = await revokeBundle({
      bundle_digest: r.bundle.bundle_digest,
      reason: 'b',
      store: st,
      now: () => new Date('2026-02-02T00:00:00.000Z'),
    });

    // A data responde "desde quando isto não valia mais?". Sobrescrevê-la a
    // cada retry moveria a resposta para a frente.
    expect(segunda).toMatchObject({ kind: 'already_revoked', at: t1.toISOString() });
  });

  it('revogar o que não existe não finge sucesso', async () => {
    const { store: st } = store();
    expect(await revokeBundle({ bundle_digest: 'nada', reason: 'x', store: st })).toEqual({
      kind: 'not_found',
    });
  });
});
