/**
 * Issue #738 — `resolveScope` resolve TODOS os grants, além de 500 profiles
 * DISTINTOS.
 *
 * ## O defeito
 *
 * `resolveScope` (`src/governance/permissions.ts`) faz duas leituras:
 * `permissoesRepo.forPessoa` e depois a leitura de perfis em lote. Até a #738 a
 * segunda era `profilesRepo.byIds(ids, limit = 500)`: dedup por `Set`, `ORDER BY
 * id`, `LIMIT 500`. Acima de 500 profiles DISTINTOS os excedentes eram cortados
 * pela ordenação de id, `resolveScope` não achava o profile daquelas permissões
 * e as descartava como "irresolúveis" — grants REAIS perdidos em silêncio, sem
 * erro e sem log. A precisão que o dono pediu: o corte era por profiles
 * distintos (o `Set` dedup), não por número de permissões — 501 permissões
 * apontando para 3 profiles NÃO reproduzem.
 *
 * ## O que esta spec prova
 *
 * Com um fake do repositório que devolve 501 permissões para 501 profiles
 * distintos, e um fake de perfis que devolve os 501, o escopo resolvido tem 501
 * entidades — em exatamente DUAS leituras, e sem passar pela leitura com teto.
 * O fake mantém a leitura ANTIGA (`byIds`, com o `LIMIT 500` reproduzido) por
 * um motivo só: provar que a fixture discrimina. Apontar `resolveScope` de
 * volta para ela (a sonda vermelha da PR) devolve 500, e o caso principal
 * reprova com `expected 500 to be 501`.
 *
 * O predicado de tenant da leitura real vive em SQL e é o assunto de
 * `tests/integration/resolve-scope-501-profiles-real-db.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Permissao, PermissionProfile, Pessoa } from '@/db/schema.js';
import { moduloDeProducao } from '../../helpers/modulo-de-producao.js';

const h = vi.hoisted(() => ({
  chamadas: { forPessoa: 0, forAuthorization: 0, byIds: 0 },
  /** Tamanho (em ids DISTINTOS) de cada lote que a leitura de perfis recebeu. */
  lotes: [] as number[],
  permissoes: [] as Permissao[],
  profiles: new Map<string, PermissionProfile>(),
}));

/** A parte comum das duas leituras do fake: dedup, filtro pelo que existe, ordem por id. */
function lerPerfis(ids: string[]): PermissionProfile[] {
  const distintos = Array.from(new Set(ids));
  h.lotes.push(distintos.length);
  return distintos
    .filter((id) => h.profiles.has(id))
    .sort()
    .map((id) => h.profiles.get(id)!);
}

vi.mock('@/db/repositories.js', () => ({
  permissoesRepo: {
    async forPessoa(_pessoa_id: string): Promise<Permissao[]> {
      h.chamadas.forPessoa++;
      return h.permissoes;
    },
  },
  profilesRepo: {
    /** A leitura de autorização da #738: sem teto. */
    async forAuthorization(ids: string[]): Promise<PermissionProfile[]> {
      h.chamadas.forAuthorization++;
      return lerPerfis(ids);
    },
    /**
     * A leitura ANTERIOR à #738, reproduzida com o teto que ela tinha
     * (`ORDER BY id LIMIT 500`). `resolveScope` NÃO pode chamá-la — o caso
     * "não passa pela leitura com teto" afirma isso — e ela fica aqui para o
     * contrafactual: é o que torna a fixture capaz de reprovar.
     */
    async byIds(ids: string[], limit = 500): Promise<PermissionProfile[]> {
      h.chamadas.byIds++;
      return lerPerfis(ids).slice(0, limit);
    },
  },
  pessoasRepo: {},
}));

vi.mock('@/config/env.js', () => ({ config: { TZ: 'America/Sao_Paulo' } }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const permissions = moduloDeProducao(() => import('@/governance/permissions.js'));
const repos = moduloDeProducao(() => import('@/db/repositories.js'));

const pessoa = { id: 'p-738', status: 'ativa' } as unknown as Pessoa;

/**
 * Semeia `n` permissões para `n` entidades, apontando para `perfis` profiles
 * distintos (round-robin quando `perfis < n`).
 */
function semear(n: number, perfis: number): { entidade_ids: string[]; profile_ids: string[] } {
  const profile_ids = Array.from({ length: perfis }, (_, i) => `prof-${String(i).padStart(4, '0')}`);
  h.profiles = new Map(
    profile_ids.map((id) => [
      id,
      {
        id,
        nome: id,
        acoes: ['read_balance'],
        limite_default: '200.00',
        tenant_id: 't0',
        agent_id: 'a0',
      } as unknown as PermissionProfile,
    ]),
  );
  const entidade_ids = Array.from({ length: n }, (_, i) => `ent-${String(i).padStart(4, '0')}`);
  h.permissoes = entidade_ids.map(
    (entidade_id, i) =>
      ({
        id: `perm-${i}`,
        pessoa_id: pessoa.id,
        entidade_id,
        profile_id: profile_ids[i % perfis]!,
        papel: 'operador',
        status: 'ativa',
        limites: {},
        tenant_id: 't0',
        agent_id: 'a0',
      }) as unknown as Permissao,
  );
  return { entidade_ids, profile_ids };
}

beforeEach(() => {
  h.chamadas = { forPessoa: 0, forAuthorization: 0, byIds: 0 };
  h.lotes = [];
});

describe('#738 — resolveScope não tem teto de profiles distintos', () => {
  it('resolve os 501 grants de 501 profiles DISTINTOS — nenhum descartado, em DUAS leituras, sem a leitura com teto', async () => {
    const { entidade_ids, profile_ids } = semear(501, 501);

    const scope = await permissions().resolveScope(pessoa);

    // 1. O número que a issue pede. Antes da correção: 500.
    expect(scope.entidades).toHaveLength(501);
    expect(scope.byEntity.size).toBe(501);

    // 2. Nada foi trocado de lugar: a ordem segue `perms`, byte-idêntica ao
    //    que o bloco de escopo renderiza, e cada grant carrega o SEU profile.
    expect(scope.entidades).toEqual(entidade_ids);
    for (const [i, eid] of entidade_ids.entries()) {
      expect(scope.byEntity.get(eid)!.profile.id).toBe(profile_ids[i]);
    }

    // 3. Exatamente duas round-trips (o orçamento da #525), a segunda com o
    //    LOTE inteiro — e ZERO passagens pela leitura com teto.
    expect(h.chamadas).toEqual({ forPessoa: 1, forAuthorization: 1, byIds: 0 });
    expect(h.lotes).toEqual([501]);
  });

  it('a precisão do dono: 501 permissões sobre 3 profiles nunca tocaram o teto — o corte era por profiles DISTINTOS', async () => {
    semear(501, 3);

    const scope = await permissions().resolveScope(pessoa);

    expect(scope.entidades).toHaveLength(501);
    // O `Set` dedup entrega 3 ids ao banco, não 501: é por isso que este caso
    // NÃO reproduz o defeito, e por isso a issue exige >500 profiles distintos.
    expect(h.lotes).toEqual([3]);
  });

  it('CONTRAFACTUAL: a leitura antiga, com teto, devolveria 500 dos 501 — a fixture discrimina', async () => {
    const { profile_ids } = semear(501, 501);
    const { profilesRepo } = repos();

    const semTeto = await profilesRepo.forAuthorization(profile_ids);
    const comTeto = await (
      profilesRepo as unknown as { byIds: (ids: string[]) => Promise<PermissionProfile[]> }
    ).byIds(profile_ids);

    expect(semTeto).toHaveLength(501);
    expect(comTeto).toHaveLength(500);
    // E o que a leitura com teto perde é decidido pela ORDEM DOS IDS, não por
    // autorização: some sempre o maior id, seja lá de quem for o grant.
    expect(comTeto.map((p) => p.id)).not.toContain('prof-0500');
  });
});
