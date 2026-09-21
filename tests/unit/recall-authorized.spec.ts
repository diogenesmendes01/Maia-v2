/**
 * G2 (spec §7.6.3) — `recallAuthorized`.
 *
 * O que este arquivo prende é o PREDICADO, e ele é prendido no SQL emitido —
 * não no resultado. A razão: se a checagem estivesse na aplicação, depois do
 * `LIMIT`, o recall devolveria "os 5 mais parecidos, menos os que você não
 * pode ver", e o número de itens passaria a depender do ranking em vez da
 * autorização. O §7.6.3 proíbe isso nominalmente ("ordenar/limitar sobre
 * conjunto elegível, nunca `topK(global)` seguido de filtro aplicativo").
 *
 * Então o teste olha a consulta: cada cláusula que falta aqui é uma porta
 * aberta lá.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executed: string[] = [];

vi.mock('@/db/client.js', () => ({
  db: {
    execute: vi.fn(async (q: unknown) => {
      /**
       * Drizzle monta a query como uma árvore de `queryChunks`, e um fragmento
       * `sql` interpolado vira um NÓ — não texto. Sem descer nele, as
       * cláusulas montadas condicionalmente (o filtro de conversa, o de tipos)
       * ficariam invisíveis para este teste, e ele passaria afirmando que
       * checou um predicado que nunca viu.
       */
      const texto = (n: unknown): string => {
        if (n === null || n === undefined) return '';
        const v = (n as { value?: unknown }).value;
        if (Array.isArray(v)) return v.join('');
        const filhos = (n as { queryChunks?: unknown[] }).queryChunks;
        if (Array.isArray(filhos)) return filhos.map(texto).join(' ');
        return '';
      };
      executed.push(texto(q));
      return { rows: [] };
    }),
  },
}));
vi.mock('@/db/tenant-context.js', () => ({
  getCurrentTenant: () => 'tenant-A',
  getCurrentAgent: () => 'agent-A',
}));
vi.mock('@/lib/embeddings.js', () => ({
  getEmbeddingProvider: () => ({ embed: async () => [[0.1, 0.2, 0.3]] }),
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { recallAuthorized } = await import('@/memory/recall-authorized.js');

const PRINCIPAL = { pessoa_id: '11111111-1111-4111-8111-111111111111' };

beforeEach(() => {
  executed.length = 0;
});

describe('recallAuthorized — o predicado vive no SQL', () => {
  it('projeta o conteúdo CANÔNICO, não a cópia denormalizada do vetor', async () => {
    await recallAuthorized({ principal: PRINCIPAL, query: 'saldo' });
    const sql = executed[0] ?? '';
    // A cópia é `agent_memories.conteudo`. Ela não pode ser a fonte: um item
    // canônico revogado ou editado deixaria o vetor respondendo pelo texto
    // antigo.
    expect(sql).toContain('m.content');
    expect(sql).not.toMatch(/v\.conteudo/);
  });

  it('exige o vínculo canônico — vetor órfão não é elegível', async () => {
    await recallAuthorized({ principal: PRINCIPAL, query: 'saldo' });
    const sql = executed[0] ?? '';
    expect(sql).toContain('JOIN');
    expect(sql).toContain('memory_entry');
    expect(sql).toContain('v.memory_entry_id');
  });

  it('filtra por titular, e NÃO por lista de escopos', async () => {
    await recallAuthorized({ principal: PRINCIPAL, query: 'saldo' });
    const sql = executed[0] ?? '';
    expect(sql).toContain('m.subject_id');
    // `escopo = ANY(...)` era a autorização antiga. Se ela voltar, este caso
    // cai — e é para cair.
    expect(sql).not.toMatch(/escopo\s*=\s*ANY/);
  });

  it('aplica ciclo de vida, revisão, menção e expiração ANTES do limite', async () => {
    await recallAuthorized({ principal: PRINCIPAL, query: 'saldo' });
    const sql = executed[0] ?? '';
    for (const clausula of [
      'm.lifecycle_status',
      'm.needs_review',
      'm.mention_allowed',
      'm.expires_at',
    ]) {
      expect(sql, `faltou ${clausula}`).toContain(clausula);
    }
    // A ordem importa: tudo isso antes de ORDER BY / LIMIT.
    const ondeWhere = sql.indexOf('m.mention_allowed');
    const ondeOrder = sql.indexOf('ORDER BY');
    expect(ondeWhere).toBeGreaterThan(-1);
    expect(ondeOrder).toBeGreaterThan(ondeWhere);
  });

  it('item preso a uma conversa não vaza para outra', async () => {
    await recallAuthorized({
      principal: { ...PRINCIPAL, conversa_id: '22222222-2222-4222-8222-222222222222' },
      query: 'saldo',
    });
    expect(executed[0] ?? '').toContain('m.conversa_id');
  });

  it('sem conversa no principal, só itens NÃO presos a conversa', async () => {
    await recallAuthorized({ principal: PRINCIPAL, query: 'saldo' });
    expect(executed[0] ?? '').toContain('m.conversa_id IS NULL');
  });

  it('falha de leitura devolve ZERO, não resultado parcial', async () => {
    const { db } = await import('@/db/client.js');
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('pg caiu'));
    const r = await recallAuthorized({ principal: PRINCIPAL, query: 'saldo' });
    // Resultado parcial faria o modelo responder com contexto incompleto sem
    // ninguém saber.
    expect(r).toEqual([]);
  });
});
