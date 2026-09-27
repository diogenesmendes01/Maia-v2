/**
 * SC12-A — contrato estático dos artefatos da decisão D08.
 *
 * ─── O que este arquivo prende ───────────────────────────────────────────────
 *
 * A fatia SC12-A entrega DOCUMENTO + inventário, não schema. O risco de um
 * artefato assim é silencioso e conhecido: o inventário envelhece, as linhas
 * citadas deixam de existir, e a recomendação do ADR passa a ser lida como se
 * ainda descrevesse o código. Este teste transforma a revalidação em contrato
 * executável:
 *
 *  1. o SHA declarado nos dois inventários é o SHA-base desta wave e é
 *     SHA de verdade (40 hex);
 *  2. CADA citação (path + linha + texto) continua válida na árvore testada —
 *     as 228 citações portadas são reconferidas aqui, linha por linha;
 *  3. o inventário cobre as CATEGORIAS que a decisão precisa distinguir (SQL
 *     raw, ORM, caller indireto, promoter, settings, fixture, migration
 *     histórica) e separa comentário de linha viva;
 *  4. o ADR compara as opções, recomenda UMA e NÃO decide: o estado é pendente
 *     do reviewer, e nenhuma linha autoriza DDL nesta PR;
 *  5. não existe segunda cópia autoritativa dos mesmos fatos no repositório.
 *
 * ─── O que ele deliberadamente NÃO prova ────────────────────────────────────
 *
 * Não prova comportamento em banco (isso é `tests/integration/refinement-sc12-a-
 * real-db.spec.ts`) nem certifica SQL dinâmico/externo. Um inventário textual
 * não substitui a verificação em runtime; ele é a lista do que precisa ser
 * revalidado quando a implementação chegar.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DECISIONS = join(RAIZ, 'docs/architecture/decisions');
const ADR = join(DECISIONS, 'ADR-D08-proposal.md');
const INVENTARIO_WRITERS = join(DECISIONS, 'd08-writers-inventory.json');
const INVENTARIO_CONSUMERS = join(DECISIONS, 'd08-consumers-inventory.json');

/** SHA-base desta wave (o mesmo declarado no card e no ADR). */
const SHA_BASE = 'd9553dec5b7b43338b6dd62dbbf047001a1924cc';

type Cita = { path: string; line: number; text: string };

type Meta = {
  revalidated_at_sha: string;
  adr: string;
  evidence_item_status: Record<string, number>;
  writer_range_or_symbol_issues: unknown[];
};

type WriterEntry = {
  path: string;
  lines: number[];
  operation: string;
  action: string;
  mechanism: string;
  exists_at_sha: boolean;
  line_range_status: string;
  symbol_status: string;
  symbol_declared: string | null;
};

type Hit = Cita & { status: string; kind_hit: string; mechanism: string };

type TestRead = {
  path: string;
  lines: number[];
  covers: string;
  does_not_prove: string;
  exists_at_sha: boolean;
  line_range_status: string;
  mechanism: string;
};

type Consumer = {
  path: string;
  exists: boolean;
  owner: string;
  policy: string;
  mechanism: string;
  evidence: Cita[];
};

const normalizar = (s: string): string => String(s).replace(/\s+/g, ' ').trim();

function ler(rel: string): string[] | null {
  const abs = resolve(RAIZ, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8').split('\n') : null;
}

/** Reconfere a citação contra a árvore TESTADA (não contra a semente). */
function citaVale(c: Cita): boolean {
  const linhas = ler(c.path);
  if (!linhas) return false;
  const alvo = normalizar(c.text);
  const naLinha = linhas[c.line - 1];
  if (naLinha === undefined) return false;
  const normalizada = normalizar(naLinha);
  return normalizada === alvo || normalizada.includes(alvo);
}

const writers = JSON.parse(readFileSync(INVENTARIO_WRITERS, 'utf8')) as {
  metadata: Meta;
  fact_writers: WriterEntry[];
  raw_search_hits_including_comments: Hit[];
  additional_direct_writer_hits: Hit[];
  tests_read_statically: TestRead[];
};
const consumers = JSON.parse(readFileSync(INVENTARIO_CONSUMERS, 'utf8')) as {
  metadata: Meta;
  consumers: Consumer[];
};
const adr = readFileSync(ADR, 'utf8');

describe('SC12-A — inventários D08 são SHA-scoped e continuam válidos', () => {
  it('declara o SHA-base desta wave, como SHA de verdade', () => {
    for (const doc of [writers, consumers]) {
      expect(doc.metadata.revalidated_at_sha).toBe(SHA_BASE);
      expect(doc.metadata.revalidated_at_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(doc.metadata.adr).toBe('docs/architecture/decisions/ADR-D08-proposal.md');
    }
  });

  it('toda citação portada (path/linha/texto) ainda casa na árvore testada', () => {
    const citacoes: Cita[] = [];
    for (const h of writers.raw_search_hits_including_comments) citacoes.push(h);
    for (const h of writers.additional_direct_writer_hits) citacoes.push(h);
    for (const c of consumers.consumers) for (const e of c.evidence) citacoes.push(e);

    expect(citacoes.length).toBeGreaterThan(200);

    const falhas = citacoes.filter((c) => !citaVale(c));
    expect(
      falhas.map((f) => `${f.path}:${f.line} :: ${f.text.slice(0, 60)}`),
      'citação do inventário que não casa mais com a árvore',
    ).toEqual([]);
  });

  it('os dois inventários foram revalidados contra os MESMOS itens (contagem coerente)', () => {
    const soma =
      (writers.metadata.evidence_item_status.confirmed ?? 0) +
      (writers.metadata.evidence_item_status.confirmed_substring ?? 0) +
      (consumers.metadata.evidence_item_status.confirmed ?? 0) +
      (consumers.metadata.evidence_item_status.confirmed_substring ?? 0);
    expect(soma).toBeGreaterThan(200);
    // Nenhum item ficou por revalidar em nenhum dos dois.
    for (const doc of [writers, consumers]) {
      const st = doc.metadata.evidence_item_status;
      expect(st.text_not_found ?? 0).toBe(0);
      expect(st.file_missing ?? 0).toBe(0);
    }
  });

  it('cada writer declarado continua existindo na faixa citada, com o símbolo conferido', () => {
    expect(writers.fact_writers.length).toBeGreaterThanOrEqual(13);
    for (const w of writers.fact_writers) {
      expect(w.exists_at_sha, `${w.path} não existe`).toBe(true);
      expect(['range_present', 'range_partial'], `${w.path} faixa ${w.lines}`).toContain(
        w.line_range_status,
      );
      if (w.symbol_declared) {
        expect(
          ['symbol_present_at_sha', 'no_symbol_declared'],
          `${w.path} símbolo ${w.symbol_declared}`,
        ).toContain(w.symbol_status);
      }
    }
    expect(writers.metadata.writer_range_or_symbol_issues).toEqual([]);
  });
});

describe('SC12-A — o inventário distingue os mecanismos que D08 precisa separar', () => {
  const mecanismos = new Set([
    ...writers.fact_writers.map((w) => w.mechanism),
    ...writers.raw_search_hits_including_comments.map((h) => h.mechanism),
    ...writers.additional_direct_writer_hits.map((h) => h.mechanism),
    ...consumers.consumers.map((c) => c.mechanism),
  ]);

  it.each([
    'raw_sql_operational',
    'orm_repository',
    'ksm_facade_orm',
    'indirect_caller_legacy',
    'ksm_promoter',
    'settings_dual_read',
    'benchmark_fixture',
    'historical_migration',
  ])('cobre a categoria %s', (categoria) => {
    expect(mecanismos.has(categoria), `categoria ausente: ${categoria}`).toBe(true);
  });

  it('separa referência em comentário de linha viva', () => {
    const tipos = new Set(writers.raw_search_hits_including_comments.map((h) => h.kind_hit));
    expect(tipos.has('comment_or_reference')).toBe(true);
    expect(tipos.has('code')).toBe(true);
  });

  it('nomeia o que as suítes existentes NÃO provam', () => {
    expect(writers.tests_read_statically.length).toBeGreaterThanOrEqual(7);
    for (const t of writers.tests_read_statically) {
      expect(t.exists_at_sha, `${t.path} não existe`).toBe(true);
      expect(String(t.does_not_prove).length).toBeGreaterThan(0);
    }
  });

  it('a migration histórica é marcada como não editável', () => {
    const historica = writers.fact_writers.find((w) =>
      w.path.startsWith('migrations/062_global_settings_down.sql'),
    );
    expect(historica, 'migration 062 down não está no inventário').toBeTruthy();
    expect(historica!.mechanism).toBe('historical_migration');
    // A ação registrada na semente é em inglês ("never edit historical
    // migration"); o contrato aqui é que ela PROÍBA edição, não o idioma.
    expect(historica!.action).toMatch(/never edit|n[ãa]o editar|nunca editar/i);
    expect(historica!.action).toMatch(/append-only/i);
  });
});

describe('SC12-A — o ADR propõe, compara e NÃO decide', () => {
  it('declara o SHA-base e a pendência de decisão', () => {
    expect(adr).toContain(SHA_BASE);
    expect(adr).toContain('DECISÃO PENDENTE');
    expect(adr).toContain('SC12-A');
  });

  it('compara alterar a unique com histórico/ponteiro corrente', () => {
    expect(adr).toMatch(/unique/i);
    expect(adr).toMatch(/ponteiro corrente/i);
    expect(adr).toMatch(/hist[óo]rico/i);
  });

  it('traz recomendação explícita e registra que a decisão é do reviewer', () => {
    expect(adr).toMatch(/^## Recomendação/m);
    expect(adr).toMatch(/reviewer/i);
    // Nenhum estado de aceite: D08 não foi decidido nesta PR.
    expect(adr).not.toMatch(/^Status \| Accepted/m);
  });

  it('não autoriza DDL destrutivo nem escolhe número de migration nesta PR', () => {
    expect(adr).toContain('Sem DDL');
    expect(adr).not.toMatch(/\bDROP TABLE\b/);
    expect(adr).not.toMatch(/\bDROP COLUMN\b/);
    expect(adr).not.toMatch(/\bALTER TABLE\b/);
    expect(adr).toMatch(/não escolhe n[úu]mero de migration/i);
  });
});

describe('SC12-A — uma única cópia autoritativa dos fatos', () => {
  it('não existe segundo inventário/ADR D08 no repositório', () => {
    const alvos = ['d08-writers-inventory.json', 'd08-consumers-inventory.json', 'ADR-D08-proposal.md'];
    const achados = new Map<string, string[]>(alvos.map((a) => [a, []]));
    const ignorar = new Set(['node_modules', '.git', 'dist', '.worktrees', 'coverage']);

    const varrer = (dir: string): void => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        if (ignorar.has(entrada.name)) continue;
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) varrer(caminho);
        else if (achados.has(entrada.name)) achados.get(entrada.name)!.push(caminho);
      }
    };
    varrer(RAIZ);

    for (const [nome, caminhos] of achados) {
      expect(caminhos, `cópia duplicada de ${nome}`).toHaveLength(1);
      expect(caminhos[0]!.startsWith(DECISIONS)).toBe(true);
    }
  });
});