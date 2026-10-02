/**
 * Fase 0 cap. 2 — repositório do store de evidência de aprovação (migration
 * 095). Toda query/mutation escopa tenant + agent via ALS; TODAS as
 * transições de estado são conditional UPDATE (CAS) — nunca leitura +
 * mutação em memória. Corrida entre dois consumidores tem exatamente um
 * vencedor (o UPDATE retorna 0 rows para o perdedor).
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { approval_requests, approval_decisions, engine_tool_calls } from '../schema.js';
import type { ApprovalRequest, ApprovalDecision } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';

export type ApprovalClass =
  | 'single_confirmation'
  | 'requester_plus_one_owner'
  | 'two_distinct_owners';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'claimed'
  | 'consumed'
  | 'execution_failed';

const OPEN_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'claimed'];

/**
 * §5.5.1 / SPEC-L1406 (SC05) — o instantâneo do journal que a política de
 * recovery do claim consome. Contagens e uma classe, não conteúdo de chamada: a
 * decisão não precisa saber QUAL operação foi tentada, só se algo pode ter
 * começado no mundo.
 *
 * `owner_call_linked` não é uma contagem a mais, é a diferença entre LER e NÃO
 * TER ONDE LER — e, mais que isso, entre ler sobre ESTE dono e ler sobre um
 * dono que já não existe. Todo o resto do instantâneo é respondido por linhas de
 * `engine_tool_calls` do pedido: sem nenhuma linha, `handler_started` e os dois
 * sinais de vitalidade são falsos por AUSÊNCIA DE FONTE, não por ausência de
 * início — e o caminho LEGADO (`dispatchTool`, `run === null`, o que roda em
 * produção) é exatamente esse caso.
 *
 * E uma linha QUALQUER do pedido não basta para provar coisa alguma sobre o
 * claim VIGENTE: o pedido pode ter sido aberto por um turno DURÁVEL (a call
 * antiga fica `approval_required`, terminal, ligada ao pedido) e depois
 * reivindicado/executado pelo caminho LEGADO, que não escreve call nenhuma. A
 * call antiga não tem carimbo e não é do dono, e lida como «prova de não início»
 * devolvia a autorização de um executor VIVO no handler (o QA-P8/F4). Por isso a
 * pergunta é feita com o token do claim: existe ao menos uma call do pedido
 * carregando o `approval_claim_token` do dono VIGENTE?
 */
export interface ApprovalClaimJournal {
  handler_started: boolean;
  effect_class: string | null;
  /**
   * Existe ao menos UMA call do journal carregando este `approval_request_id`
   * E o `approval_claim_token` do claim VIGENTE (o dono que se está tentando
   * reconciliar). `false` ⇒ não há observação sobre ESTE dono ⇒ não há prova de
   * não início ⇒ segurar.
   */
  owner_call_linked: boolean;
}

function scope() {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

/** Linha da leitura de vitalidade do executor (§5.5.1/SC05). */
type LivenessRow = { can_still_start: boolean; execution_in_flight: boolean };

export const approvalRequestsRepo = {
  /**
   * Cria um request. A partial unique (tenant, agent, fingerprint | status
   * aberto) garante no máximo um request aberto por intent; em corrida, o
   * perdedor recebe `null` e deve reler via `findOpenByFingerprint`.
   */
  async create(input: {
    requester_pessoa_id: string;
    entidade_id: string | null;
    conversa_id: string | null;
    mensagem_id: string | null;
    request_id: string | null;
    tool: string;
    operation_type: string;
    intent_payload: unknown;
    intent_hash: string;
    intent_hash_version: number;
    approval_class: ApprovalClass;
    required_approvals: number;
    fingerprint: string;
    expires_at: Date;
  }): Promise<ApprovalRequest | null> {
    const guarded = applyTenantGuard({ ...input, status: 'pending' as const });
    const rows = await db
      .insert(approval_requests)
      .values(guarded)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  },

  async byId(id: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select()
      .from(approval_requests)
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Request aberto (pending/approved/claimed) por referência curta AP-xxxxxxxx. */
  async findOpenByRefPrefix(prefix: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    if (!/^[0-9a-f]{8}$/.test(prefix)) return null;
    const rows = await db
      .select()
      .from(approval_requests)
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          inArray(approval_requests.status, OPEN_STATUSES),
          sql`${approval_requests.id}::text LIKE ${prefix + '%'}`,
        ),
      )
      .limit(2);
    // Prefixo ambíguo (2+ requests abertos) falha fechado.
    return rows.length === 1 ? (rows[0] ?? null) : null;
  },

  async findOpenByFingerprint(fingerprint: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select()
      .from(approval_requests)
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.fingerprint, fingerprint),
          inArray(approval_requests.status, OPEN_STATUSES),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** CAS pending → approved. */
  async markApproved(id: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'approved', approved_at: sql`now()`, updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, id),
          eq(approval_requests.status, 'pending'),
          sql`${approval_requests.expires_at} > now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** CAS pending → denied (terminal). */
  async markDenied(id: string): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'denied', denied_at: sql`now()`, updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, id),
          eq(approval_requests.status, 'pending'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * CAS approved → claimed. Exatamente um vencedor: o WHERE exige status
   * 'approved' + hash idêntico + não expirado (expiração pelo RELÓGIO DO
   * BANCO). O claim_token cerca o consume subsequente.
   */
  async claim(input: {
    id: string;
    claim_token: string;
    intent_hash: string;
  }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({
        status: 'claimed',
        claimed_at: sql`now()`,
        claim_token: input.claim_token,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'approved'),
          eq(approval_requests.intent_hash, input.intent_hash),
          sql`${approval_requests.expires_at} > now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** CAS claimed → consumed, cercado pelo claim_token (one-time). */
  async consume(input: {
    id: string;
    claim_token: string;
    result_ref: string | null;
  }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({
        status: 'consumed',
        consumed_at: sql`now()`,
        result_ref: input.result_ref,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'claimed'),
          eq(approval_requests.claim_token, input.claim_token),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * §5.5.1 / SPEC-L1406 (SC05) — O JOURNAL do pedido, na forma EXATA que a
   * política de recovery do claim consome (`classifyApprovalClaimRecovery`).
   *
   * ─── Por que a leitura é um AGREGADO e não "a call" ─────────────────────────
   *
   * Um pedido pode ser carregado por MAIS de uma call: a que reivindicou e caiu
   * (a que interessa aqui) e as que voltaram `approval_required` apontando para
   * o mesmo pedido. Responder por "uma call qualquer" escolheria a resposta pelo
   * acaso da ordenação. As duas perguntas que a política faz são EXISTENCIAIS e
   * é assim que elas são respondidas aqui:
   *
   *   * `handler_started` — existe alguma call deste pedido com carimbo de
   *     início? O carimbo é gravado ANTES da chamada física (§5.6.4), então ele
   *     é a única prova de que algo pode ter acontecido no mundo;
   *   * `effect_class` — `'abort_safe'` SOMENTE quando TODA call iniciada
   *     declara ausência de efeito (é a declaração que libera o carimbo de
   *     provar coisa alguma, a mesma régua de `classifyToolCancellation`).
   *     Qualquer outra coisa — inclusive classe nula, que é "não sei" — sai
   *     como a classe observada, e a política trata o resto como terminal.
   *
   *   * `owner_call_linked` — existe ALGUMA call deste pedido carregando o
   *     `approval_claim_token` do dono VIGENTE? É a pergunta anterior a todas as
   *     outras, e a única que a ausência total de linhas responde — mas ela não
   *     pergunta só «o journal tem o que dizer sobre este pedido?», e sim «o
   *     journal tem o que dizer sobre ESTE dono?». As duas perguntas coincidem no
   *     caminho LEGADO (`dispatchTool`, `run === null`), onde o pedido vive só no
   *     `approval_requests` e o journal não tem linha nenhuma para ele: sem esta
   *     resposta, «não há call carimbada» seria lido como prova de não início e a
   *     evidência de um executor VIVO voltaria a circular (o QA-P6/F3).
   *
   *     E divergem no cenário MISTO (o QA-P8/F4): pedido aberto pelo gateway
   *     DURÁVEL — deixando uma call antiga, já TERMINAL, ligada ao pedido — e
   *     execução pelo caminho LEGADO, que não escreve call. A call antiga não tem
   *     carimbo e não carrega o token do dono, então o escopo por token é o que
   *     separa «nada começou» de «não sei nada sobre quem está executando agora».
   *     Sem ele, a regra do release devolvia o claim de um handler em curso e a
   *     MESMA aprovação autorizava dois efeitos.
   *
   * ─── O que esta leitura NÃO é ───────────────────────────────────────────────
   *
   * Não é reconciliação e não decide nada: devolve contagens, sem o conteúdo de
   * nenhuma chamada, e não olha relógio. Idade não é prova de não início — a
   * ausência do carimbo é.
   */
  async claimJournal(input: {
    approval_request_id: string;
    /**
     * O token do claim VIGENTE — o dono que se está tentando reconciliar. É ele
     * que dá ESCOPO à leitura: uma call do pedido que não carregue este token
     * não é observação sobre este dono (nem sobre nenhum dono vivo). `null` cai
     * no mesmo lugar que «sem call»: nenhum token casa, `owner_call_linked` é
     * falso e a evidência é segurada — o lado seguro.
     */
    approval_claim_token: string | null;
  }): Promise<ApprovalClaimJournal> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select({
        iniciadas: sql<string>`count(*) FILTER (WHERE ${engine_tool_calls.handler_started_at} IS NOT NULL)`,
        com_efeito: sql<string>`count(*) FILTER (WHERE ${engine_tool_calls.handler_started_at} IS NOT NULL
          AND ${engine_tool_calls.effect_class} IS DISTINCT FROM 'abort_safe')`,
        classe: sql<string | null>`min(${engine_tool_calls.effect_class})
          FILTER (WHERE ${engine_tool_calls.handler_started_at} IS NOT NULL
            AND ${engine_tool_calls.effect_class} IS DISTINCT FROM 'abort_safe')`,
        /**
         * A pergunta do ESCOPO: alguma call deste pedido carrega o claim do dono
         * VIGENTE? `NULL` no lado do token não casa com nada (`= NULL` é NULL, e
         * `FILTER` não conta) — que é exatamente o comportamento fail-closed
         * querido: sem token não há dono a provar.
         */
        do_dono: sql<string>`count(*) FILTER (
          WHERE ${engine_tool_calls.approval_claim_token} IS NOT NULL
            AND ${engine_tool_calls.approval_claim_token} = ${input.approval_claim_token}::text)`,
      })
      .from(engine_tool_calls)
      .where(
        and(
          eq(engine_tool_calls.tenant_id, tenant_id),
          eq(engine_tool_calls.agent_id, agent_id),
          eq(engine_tool_calls.approval_request_id, input.approval_request_id),
        ),
      );
    const linha = rows[0];
    // A PRIMEIRA resposta é se o journal observou ESTE dono. Ela entra em TODOS
    // os ramos: sem call do dono, "não começou" não é um fato observado, é um
    // vazio — e a política não troca um vazio por prova.
    const owner_call_linked = Number(linha?.do_dono ?? 0) > 0;
    if (Number(linha?.iniciadas ?? 0) === 0) {
      return { owner_call_linked, handler_started: false, effect_class: null };
    }
    if (Number(linha?.com_efeito ?? 0) === 0) {
      return { owner_call_linked, handler_started: true, effect_class: 'abort_safe' };
    }
    return { owner_call_linked, handler_started: true, effect_class: linha?.classe ?? null };
  },

  /**
   * §5.5.1 / AC04 (SC05) — A VITALIDADE DO EXECUTOR DE UM CLAIM.
   *
   * A reconciliação de uma evidência presa em `claimed` precisa distinguir duas
   * situações que o status do pedido NÃO distingue: um dono que ainda pode agir
   * (e vai consumir/executar) de um dono que morreu no meio (e cuja autorização
   * tem de voltar a circular). Quem responde é o JOURNAL, e a resposta depende de
   * ONDE o dono parou:
   *
   *  - **Antes do marcador** (`can_still_start`): o que autoriza o dono a cruzar
   *    o limite do efeito é o FENCE do turno. A condição é LITERALMENTE a mesma
   *    que o marcador vai exigir (`engineRunsRepo.checarFenceDoRun`): turno
   *    `running`, com lease VIVA e com o claim que originou o run, run `running`,
   *    capacidades não revogadas e prazo válido. É o que o marcador responderia
   *    se fosse chamado neste instante.
   *
   *  - **Depois do marcador** (`execution_in_flight`): o handler pode estar
   *    rodando AGORA. O sinal de "em voo" é a RESERVA de idempotência do próprio
   *    efeito, que nasce antes do handler e é liquidada por quem executa: uma
   *    reserva `in_progress` ainda dentro do TTL significa dono vivo dentro do
   *    handler. A lease do turno NÃO serve aqui — quando o processo morre depois
   *    do marcador, o que ele deixa é justamente a reserva órfã.
   *
   * Os dois sinais existem porque os dois lados do marcador são perguntas
   * diferentes: antes, "ele ainda pode entrar?"; depois, "ele ainda está lá?".
   * Nenhum dos dois LIBERA efeito — ambos SEGURAM a evidência, que é a resposta
   * segura quando não se pode provar não início.
   *
   * Mora AQUI, ao lado de `claimJournal`, e não no repositório do engine: quem
   * consome é a política do claim, e o repositório de approvals é o que os
   * caminhos de aprovação já carregam — importar o repositório inteiro do engine
   * só para estas duas contagens ligaria a máquina de aprovação ao journal de
   * execução inteiro (e às suas dependências de módulo) sem necessidade.
   *
   * LIMITE declarado: um processo morto ANTES do marcador só é reconhecido
   * quando a lease vence. É o desenho do §5.5.1 — a lease é o que o crash deixa —
   * e não uma detecção de crash por si só.
   */
  async claimExecutorLiveness(input: {
    approval_request_id: string;
  }): Promise<{ can_still_start: boolean; execution_in_flight: boolean }> {
    const { tenant_id, agent_id } = scope();
    const res = await db.execute(sql`
      SELECT
        EXISTS (
          SELECT 1
            FROM engine_tool_calls c
            JOIN engine_runs r
              ON r.tenant_id = c.tenant_id AND r.agent_id = c.agent_id
             AND r.id = c.run_id
            JOIN agent_turns t
              ON t.tenant_id = r.tenant_id AND t.agent_id = r.agent_id
             AND t.id = r.turn_id
           WHERE c.tenant_id = ${tenant_id} AND c.agent_id = ${agent_id}
             AND c.approval_request_id = ${input.approval_request_id}::uuid
             AND c.state IN ('received', 'dispatching', 'handler_started')
             AND c.finished_at IS NULL
             AND r.phase = 'running'
             AND r.capabilities_revoked_at IS NULL
             AND r.deadline_at > clock_timestamp()
             AND r.origin_claim_token = t.claim_token
             AND r.origin_turn_attempt = t.attempt_count
             AND t.status = 'running'
             AND t.lease_expires_at IS NOT NULL
             AND t.lease_expires_at > clock_timestamp()
        ) AS can_still_start,
        EXISTS (
          SELECT 1
            FROM engine_tool_calls c
            JOIN idempotency_keys k
              ON k.tenant_id = c.tenant_id AND k.agent_id = c.agent_id
             AND k.tool_name = c.tool_name
             AND k.key = c.idempotency_key
           WHERE c.tenant_id = ${tenant_id} AND c.agent_id = ${agent_id}
             AND c.approval_request_id = ${input.approval_request_id}::uuid
             AND c.handler_started_at IS NOT NULL
             AND k.state = 'in_progress'
             AND k.expires_at > clock_timestamp()
        ) AS execution_in_flight`);
    const linhas = (res as unknown as { rows: LivenessRow[] }).rows ?? [];
    return {
      can_still_start: linhas[0]?.can_still_start === true,
      execution_in_flight: linhas[0]?.execution_in_flight === true,
    };
  },

  /**
   * CAS claimed → approved (devolve a evidência). SOMENTE para caminhos em
   * que o handler NÃO chegou a rodar (ex.: corrida de idempotência) — nunca
   * após execução iniciada.
   *
   * §5.5.1 / SPEC-L1406 (SC05) — a segunda condição do `WHERE` é a PROVA de
   * não início, e ela vive AQUI, no mesmo CAS, e não só na política: o handler
   * marcou `engine_tool_calls.handler_started_at` antes de tocar o mundo, e uma
   * vez marcado o journal afirma que o efeito pode ter acontecido. Devolver a
   * evidência nesse estado apagaria a única prova de que a operação aconteceu e
   * convidaria o dono a executá-la duas vezes. Sem journal (caminho legado, sem
   * call no `engine_tool_calls`) o `NOT EXISTS` é verdadeiro e o comportamento
   * não muda.
   *
   * Classe ABORT_SAFE é a exceção declarada: ela mesma afirma ausência de efeito
   * (`classifyToolCancellation`), então o carimbo não prova nada que obrigue a
   * segurar a evidência. Negar a devolução nesse caso deixaria um claim preso
   * para sempre por uma execução que não produziu efeito.
   */
  async releaseClaim(input: { id: string; claim_token: string }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'approved', claim_token: null, claimed_at: null, updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'claimed'),
          eq(approval_requests.claim_token, input.claim_token),
          sql`NOT EXISTS (
            SELECT 1 FROM ${engine_tool_calls} c
             WHERE c.tenant_id = ${approval_requests.tenant_id}
               AND c.agent_id = ${approval_requests.agent_id}
               AND c.approval_request_id = ${approval_requests.id}
               AND c.handler_started_at IS NOT NULL
               AND c.effect_class IS DISTINCT FROM 'abort_safe'
          )`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * §5.5.1 (SC05) — expiração LAZY de um pedido VENCIDO, por RELÓGIO DO BANCO.
   *
   * O sweeper (`expireDue`) cobre `pending` no tick do engine, mas não é
   * suficiente para o caminho de execução: entre o instante em que o TTL venceu
   * e o próximo tick, o pedido continua `open` — e `findOpenByFingerprint` o
   * devolveria como se valesse. Pior, um pedido que chegou a `approved` e venceu
   * sem ser executado não era coberto por ninguém: ficava preso na partial unique
   * do fingerprint, bloqueando um pedido novo da MESMA intenção.
   *
   * `approved` é incluído de propósito: vencimento é vencimento. A janela em que
   * a evidência podia ser consumida fechou, e `claim` já exige
   * `expires_at > now()`, então este CAS apenas dá ao pedido o estado terminal
   * que a regra do claim já implicava.
   *
   * Devolve a row quando ESTE chamador venceu o CAS; `null` quando o pedido não
   * estava vencido (ou mudou de estado no meio). Quem chama não pode concluir
   * nada de não ter vencido — pode ter perdido para uma decisão humana.
   */
  async expireIfDue(input: { id: string }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'expired', updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          inArray(approval_requests.status, ['pending', 'approved']),
          sql`${approval_requests.expires_at} <= now()`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** CAS claimed → execution_failed (terminal; nova aprovação exigida). */
  async markExecutionFailed(input: {
    id: string;
    claim_token: string;
  }): Promise<ApprovalRequest | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(approval_requests)
      .set({ status: 'execution_failed', updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.id, input.id),
          eq(approval_requests.status, 'claimed'),
          eq(approval_requests.claim_token, input.claim_token),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** Expira requests pending vencidos (relógio do banco). Retorna as rows. */
  async expireDue(): Promise<ApprovalRequest[]> {
    const { tenant_id, agent_id } = scope();
    return db
      .update(approval_requests)
      .set({ status: 'expired', updated_at: sql`now()` })
      .where(
        and(
          eq(approval_requests.tenant_id, tenant_id),
          eq(approval_requests.agent_id, agent_id),
          eq(approval_requests.status, 'pending'),
          lt(approval_requests.expires_at, sql`now()`),
        ),
      )
      .returning();
  },
};

export const approvalDecisionsRepo = {
  /**
   * Registra a decisão de um principal. Idempotente por (request, principal):
   * duplicate approve (mesmo por outro canal) não conta duas vezes — retorna
   * `null` no conflito.
   */
  async record(input: {
    request_id: string;
    principal_pessoa_id: string;
    principal_tipo: string;
    decision: 'approve' | 'deny';
    channel: string;
    reason: string | null;
  }): Promise<ApprovalDecision | null> {
    const guarded = applyTenantGuard(input);
    const rows = await db
      .insert(approval_decisions)
      .values(guarded)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  },

  async byRequest(request_id: string): Promise<ApprovalDecision[]> {
    const { tenant_id, agent_id } = scope();
    return db
      .select()
      .from(approval_decisions)
      .where(
        and(
          eq(approval_decisions.tenant_id, tenant_id),
          eq(approval_decisions.agent_id, agent_id),
          eq(approval_decisions.request_id, request_id),
        ),
      );
  },
};
