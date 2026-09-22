/**
 * G2 (spec §7.6.3) — `recallAuthorized`: recall como PROJEÇÃO AUTORIZADA.
 *
 * ─── O que o recall era ─────────────────────────────────────────────────────
 *
 * `recall({ query, escopo: string[] })`. O chamador montava a lista de escopos
 * e a consulta confiava nela. Em `recall_memory` a lista era:
 *
 *     ['global', `pessoa:${ctx.pessoa.id}`, ...entidades]
 *
 * Três coisas seguem daí, e as três são o mesmo defeito visto de ângulos
 * diferentes:
 *
 * 1. **A autorização era um argumento.** Quem chama decide o que pode ler, e
 *    um `escopo` a mais é acesso a mais. A spec diz a frase inteira: "Não
 *    exportar `escopo:string[]` como autorização."
 * 2. **`'global'` estava na lista.** Qualquer memória de escopo global voltava
 *    para qualquer interlocutor, sem ninguém ter publicado nada.
 * 3. **O conteúdo entregue vinha da cópia.** A consulta lia `agent_memories`
 *    sozinha e devolvia a coluna `conteudo` — o texto denormalizado no momento
 *    da indexação. Item canônico revogado, expirado ou em revisão continuava
 *    respondendo pelo vetor.
 *
 * ─── O que ele é agora ──────────────────────────────────────────────────────
 *
 * Um PRINCIPAL entra; o predicado do §7.6.3 decide. O predicado roda ANTES de
 * ordenar e limitar — `topK` sobre o conjunto inteiro seguido de filtro na
 * aplicação devolveria menos itens do que existem, de forma que depende do
 * acaso do ranking, e o §7.6.3 proíbe nominalmente.
 *
 * ─── O que ele deliberadamente não faz ──────────────────────────────────────
 *
 * Não lê memória compartilhada. O ramo "compartilhado" do predicado exige
 * publicação humana válida com escopo, audiência e versão — e isso depende do
 * publicador do P09, que não existe. Enquanto não existir, `recallAuthorized`
 * devolve SÓ o privado do titular. Preferir o ramo ausente a um ramo
 * aproximado é o ponto: um "compartilhado" implementado por aproximação seria
 * publicação implícita, que é exatamente o que o §7.8.4 proíbe.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { getEmbeddingProvider } from '@/lib/embeddings.js';
import { logger } from '@/lib/logger.js';

/**
 * Quem está pedindo. Substitui a lista de escopos.
 *
 * `pessoa_id` é o TITULAR cujo dado privado pode ser projetado — não o ator de
 * uma operação qualquer. A distinção é a mesma do G1: quem opera não é, por
 * isso, dono do que está sendo lido.
 */
export type RecallPrincipalV1 = {
  pessoa_id: string;
  /** Restringe a itens presos a esta conversa, quando houver. */
  conversa_id?: string | null;
};

export type RecallItemV1 = {
  /** Id do item CANÔNICO, não do vetor. */
  memory_entry_id: string;
  content: string;
  memory_type: string;
  score: number;
};

export type RecallAuthorizedInputV1 = {
  principal: RecallPrincipalV1;
  query: string;
  tipos?: string[];
  k?: number;
};

/**
 * Estados de ciclo de vida em que um item pode ser projetado ao modelo.
 *
 * Reusa a régua de visibilidade do KSM em vez de redigitar uma lista: uma
 * segunda definição de "visível" é como as duas divergem, e a que diverge para
 * mais é a que vaza.
 */
const ESTADOS_PROJETAVEIS = ['active', 'verified', 'reinforced', 'observed'] as const;

const K_PADRAO = 5;
/** Teto duro. Um `k` grande vindo do modelo não vira varredura. */
const K_MAXIMO = 50;

/**
 * Projeta memória AUTORIZADA para o principal.
 *
 * O predicado inteiro vive no SQL, e isso é deliberado: filtrar na aplicação
 * depois do `LIMIT` devolveria "os 5 mais parecidos, menos os que você não
 * pode ver" — um número de itens que varia com o ranking em vez de com a
 * autorização.
 */
export async function recallAuthorized(input: RecallAuthorizedInputV1): Promise<RecallItemV1[]> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  const provider = getEmbeddingProvider();
  const [emb] = await provider.embed([input.query]);
  if (!emb) return [];
  const vec = `[${emb.join(',')}]`;
  const limit = Math.min(Math.max(1, input.k ?? K_PADRAO), K_MAXIMO);

  const tiposFilter =
    input.tipos && input.tipos.length > 0
      ? sql`AND m.memory_type = ANY(${sql.param(input.tipos)})`
      : sql``;

  /**
   * A restrição por conversa.
   *
   * Um item preso a uma conversa (`m.conversa_id IS NOT NULL`) só pode ser
   * projetado DENTRO dela. Sem este predicado, uma memória de um atendimento
   * vazaria para o seguinte — mesmo titular, contexto diferente, e o §7.6.3
   * lista "restrições de conversa/canal satisfeitas" como parte do ramo
   * privado.
   */
  const conversa = input.principal.conversa_id ?? null;
  const conversaFilter =
    conversa === null
      ? sql`AND m.conversa_id IS NULL`
      : sql`AND (m.conversa_id IS NULL OR m.conversa_id = ${conversa}::uuid)`;

  try {
    const result = await db.execute<{
      memory_entry_id: string;
      content: string;
      memory_type: string;
      score: string;
    }>(sql`
      SELECT m.id AS memory_entry_id,
             m.content AS content,
             m.memory_type AS memory_type,
             1 - (v.embedding <=> ${vec}::vector) AS score
        FROM agent_memories v
        -- O JOIN é o fence. Vetor órfão — sem item canônico — não tem linha
        -- aqui e portanto não é elegível, que é como a 146 aposenta o índice
        -- independente sem apagar nada.
        JOIN memory_entry m
          ON  m.tenant_id = v.tenant_id
          AND m.agent_id  = v.agent_id
          AND m.id        = v.memory_entry_id
       WHERE v.tenant_id = ${tenant_id}
         AND v.agent_id  = ${agent_id}
         -- PRIVADO do titular. O ramo compartilhado exige publicação humana e
         -- não existe ainda; ver o cabeçalho deste módulo.
         AND m.subject_id = ${input.principal.pessoa_id}
         ${conversaFilter}
         -- Ciclo de vida permitido para projeção ao modelo.
         AND m.lifecycle_status = ANY(${sql.param([...ESTADOS_PROJETAVEIS])})
         -- Em revisão NÃO é projetável: revisão pendente é exatamente o estado
         -- em que ninguém decidiu ainda se o item pode ser usado.
         AND m.needs_review = false
         -- mention_allowed e a autorizacao de devolver CONTEÚDO BRUTO ao
         -- modelo. Um item pode existir e ser usado internamente sem que o
         -- texto dele possa ser repetido.
         AND m.mention_allowed = true
         -- Expiração: ausente por política, ou ainda no prazo.
         AND (m.expires_at IS NULL OR m.expires_at > now())
         ${tiposFilter}
       ORDER BY v.embedding <=> ${vec}::vector
       LIMIT ${limit}
    `);

    return result.rows.map((r) => ({
      memory_entry_id: String((r as { memory_entry_id: string }).memory_entry_id),
      // O conteúdo vem da linha CANÔNICA (`m.content`), nunca da cópia
      // denormalizada em `agent_memories.conteudo`. É a diferença entre
      // projetar o que o item diz hoje e repetir o que ele dizia quando foi
      // indexado.
      content: String((r as { content: string }).content),
      memory_type: String((r as { memory_type: string }).memory_type),
      score: Number((r as { score: string }).score),
    }));
  } catch (err) {
    // Falha de leitura NÃO devolve resultado parcial: devolver menos itens
    // silenciosamente faria o modelo responder com contexto incompleto sem
    // ninguém saber. Zero itens é honesto; o log é que conta o que houve.
    logger.warn({ err: (err as Error).message }, 'memory.recall_authorized_failed');
    return [];
  }
}
