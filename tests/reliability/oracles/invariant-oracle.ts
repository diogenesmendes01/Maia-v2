/**
 * Issue #510 (fatia B) — o ORACLE de invariantes: o que um cenário de fault
 * injection pergunta ao estado durável depois de ter quebrado alguma coisa.
 *
 * ═══ O risco que este módulo existe para remover ════════════════════════════
 *
 * Um harness de fault injection é fácil de fazer VÁCUO: injeta a falha, nada
 * quebra, e o teste passa afirmando nada. O antídoto não é "mais asserts" — é
 * um conjunto de invariantes NOMEADAS, verificadas sobre o estado durável, que
 * um cenário não escolhe a dedo. Se a falha injetada não produzir reação,
 * alguma destas afirmações precisa ficar vermelha; se nenhuma ficar, o cenário
 * não estava provando nada e isso vira visível.
 *
 * ═══ A separação que torna o oracle testável ═══════════════════════════════
 *
 * `coletar()` faz I/O e não decide nada. `verificarInvariantes()` decide tudo e
 * não faz I/O — recebe uma FOTO e devolve violações. A consequência prática é
 * a que interessa: os self-tests do oracle plantam uma linha outbound
 * duplicada e uma mutação cross-tenant DENTRO de uma foto sintética, sem banco,
 * e afirmam que o oracle as encontra.
 *
 * Isso não é conveniência. A linha duplicada é IMPOSSÍVEL de inserir no
 * Postgres real — `outbound_messages_logical_dedupe_uq` é um índice único
 * parcial, e é justamente essa a proteção. Um oracle que só pudesse ser
 * exercitado contra o banco nunca teria como provar que sabe detectar a
 * duplicata: o banco recusa fabricá-la. Com a checagem pura, a pergunta "o
 * oracle detecta?" tem resposta, e a resposta é um teste vermelho quando a
 * checagem é removida.
 *
 * ═══ O vocabulário vem de `src/`, sempre ════════════════════════════════════
 *
 * `TURN_STATUSES`, `TERMINAL_OUTCOMES`, `STREAM_OCCUPYING_STATUSES`,
 * `statusForOutcome` — tudo importado da produção. Um oracle com listas
 * próprias continuaria verde depois de alguém acrescentar um estado novo à
 * máquina, que é exatamente o momento em que ele deveria falar.
 */
import type pg from 'pg';
import {
  TERMINAL_OUTCOMES,
  TURN_STATUSES,
  isTerminalTurnStatus,
  isTurnStatus,
  type TerminalTurnStatus,
} from '@/runtime/turns/contract.js';
import { STREAM_OCCUPYING_STATUSES } from '@/runtime/turns/claim.js';
import { statusForOutcome } from '@/runtime/outbound/delivery-contract.js';
import { OUTBOUND_DELIVERY_OUTCOMES } from '@/runtime/outbound/contract.js';
import { sanitizarValor } from '../harness/sanitize.js';

// ---------------------------------------------------------------------------
// A FOTO
// ---------------------------------------------------------------------------

export interface LinhaDeTurno {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: string;
  outcome: string | null;
  attempt_count: number;
  state_version: number;
  claim_token: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  stream_key: string | null;
  superseded_by_turn_id: string | null;
}

export interface LinhaDeSaida {
  id: string;
  tenant_id: string;
  agent_id: string;
  turn_id: string | null;
  sequence_in_turn: number | null;
  logical_dedupe_key: string | null;
  payload_hash: string | null;
  status: string;
  delivery_outcome: string | null;
}

export interface LinhaDeAuditoria {
  id: string;
  tenant_id: string;
  agent_id: string;
  acao: string;
  alvo_id: string | null;
}

export interface EscopoEsperado {
  tenant_id: string;
  agent_id: string;
}

/**
 * Tudo que o oracle sabe num instante. `agoraDoBanco` é o relógio do
 * PostgreSQL e não o do processo de teste: toda condição de lease é comparada
 * contra ele, porque é o único relógio comparável entre réplicas — a mesma
 * regra que `claimNextEligibleTurn` segue em produção.
 */
export interface FotoDuravel {
  colhidaEm: string;
  agoraDoBanco: string;
  escopoEsperado: readonly EscopoEsperado[];
  turnos: readonly LinhaDeTurno[];
  saidas: readonly LinhaDeSaida[];
  auditorias: readonly LinhaDeAuditoria[];
}

// ---------------------------------------------------------------------------
// VIOLAÇÕES
// ---------------------------------------------------------------------------

export const FAMILIAS_DE_INVARIANTE = ['turno', 'fifo', 'outbound', 'seguranca', 'operacao'] as const;
export type FamiliaDeInvariante = (typeof FAMILIAS_DE_INVARIANTE)[number];

/**
 * Uma violação. `invariante` é um identificador ESTÁVEL — ele aparece no
 * relatório do cenário e é o que um runbook cita. `detalhe` é orientado à
 * invariante ("dois claims válidos no mesmo turno"), nunca um dump opaco.
 */
export interface ViolacaoDeInvariante {
  readonly familia: FamiliaDeInvariante;
  readonly invariante: string;
  readonly detalhe: string;
  readonly evidencia: Record<string, unknown>;
}

export class InvarianteVioladaError extends Error {
  readonly violacoes: readonly ViolacaoDeInvariante[];
  constructor(cenario: string, violacoes: readonly ViolacaoDeInvariante[]) {
    super(
      `${cenario}: ${violacoes.length} invariante(s) violada(s).\n` +
        violacoes
          .map((v) => `  · [${v.familia}] ${v.invariante}: ${v.detalhe} ${JSON.stringify(v.evidencia)}`)
          .join('\n'),
    );
    this.name = 'InvarianteVioladaError';
    this.violacoes = violacoes;
  }
}

export interface OpcoesDeVerificacao {
  /**
   * A rodada ACABOU? Liga `operacao.turno_orfao`.
   *
   * Fora dessa declaração a checagem seria ruído: um turno `received` esperando
   * um worker é o estado normal do meio da rodada, e o mesmo turno `received`
   * depois de o cenário afirmar que tudo convergiu é um turno PERDIDO. Só o
   * cenário sabe qual dos dois momentos é este, então ele diz.
   */
  exigirConvergencia?: boolean;
}

// ---------------------------------------------------------------------------
// AS CHECAGENS — puras
// ---------------------------------------------------------------------------

/**
 * Todas as invariantes, sobre uma foto. Pura: sem I/O, sem relógio local, sem
 * ordem entre as checagens.
 */
export function verificarInvariantes(
  foto: FotoDuravel,
  opts: OpcoesDeVerificacao = {},
): ViolacaoDeInvariante[] {
  return [
    ...checarTurno(foto),
    ...checarFifo(foto),
    ...checarOutbound(foto),
    ...checarSeguranca(foto),
    ...checarOperacao(foto, opts),
  ];
}

function violacao(
  familia: FamiliaDeInvariante,
  invariante: string,
  detalhe: string,
  evidencia: Record<string, unknown>,
): ViolacaoDeInvariante {
  return { familia, invariante, detalhe, evidencia: sanitizarValor(evidencia) as Record<string, unknown> };
}

function checarTurno(foto: FotoDuravel): ViolacaoDeInvariante[] {
  const out: ViolacaoDeInvariante[] = [];
  for (const t of foto.turnos) {
    if (!isTurnStatus(t.status)) {
      out.push(
        violacao('turno', 'turno.status_conhecido', 'status fora da máquina de estados de #503', {
          turn_id: t.id,
          status: t.status,
          conhecidos: TURN_STATUSES,
        }),
      );
      continue;
    }

    // Outcome só existe em estado terminal, e só o da lista daquele estado.
    if (isTerminalTurnStatus(t.status)) {
      const permitidos = TERMINAL_OUTCOMES[t.status as TerminalTurnStatus];
      if (t.outcome === null || !permitidos.includes(t.outcome as never)) {
        out.push(
          violacao(
            'turno',
            'turno.outcome_coerente',
            `estado terminal "${t.status}" com outcome que ele não admite`,
            { turn_id: t.id, status: t.status, outcome: t.outcome, permitidos },
          ),
        );
      }
    } else if (t.outcome !== null) {
      out.push(
        violacao('turno', 'turno.outcome_coerente', 'outcome gravado em estado NÃO terminal', {
          turn_id: t.id,
          status: t.status,
          outcome: t.outcome,
        }),
      );
    }

    if (t.attempt_count < 0) {
      out.push(
        violacao('turno', 'turno.attempt_nao_negativo', 'attempt_count negativo', {
          turn_id: t.id,
          attempt_count: t.attempt_count,
        }),
      );
    }

    // O claim é um TUPLO: quem, com que token, até quando. Uma row com parte
    // dele é um claim gravado pela metade — e um claim pela metade é
    // exatamente o rastro que um `UPDATE` não atômico deixaria.
    //
    // ─── Por que a regra do tuplo vale só ENQUANTO o turno está vivo ───────
    //
    // A conclusão terminal LIBERA a posse e PRESERVA `claimed_by`, de
    // propósito: `clearClaim` (`src/db/repositories/turn-repos.ts`) anula
    // `claim_token` e `lease_expires_at` e deixa o dono gravado — "a posse
    // morre com a tentativa; `claimed_by` fica para a forense". Cobrar o tuplo
    // completo num turno terminal acusaria TODO turno concluído, e um oracle
    // que grita em toda rodada normal é um oracle que ninguém lê. (Foi FI-14,
    // o primeiro cenário desta lane a levar um turno até `dead_letter`, que
    // encontrou isso.)
    //
    // A invariante que vale no terminal é a outra metade, e ela é mais forte
    // que o tuplo: NENHUMA posse viva sobrevive ao fim do turno. Um
    // `claim_token` ou uma `lease_expires_at` em turno terminal é um dono para
    // trabalho que já acabou — e é o que faria a varredura de lease vencida
    // "recuperar" um turno concluído quando o prazo passasse.
    if (isTerminalTurnStatus(t.status)) {
      if (t.claim_token !== null || t.lease_expires_at !== null) {
        out.push(
          violacao('turno', 'turno.posse_liberada_no_terminal', 'turno TERMINAL com posse viva', {
            turn_id: t.id,
            status: t.status,
            claim_token: t.claim_token,
            lease_expires_at: t.lease_expires_at,
          }),
        );
      }
    } else {
      const partes = [t.claim_token, t.claimed_by, t.lease_expires_at];
      const presentes = partes.filter((p) => p !== null).length;
      if (presentes !== 0 && presentes !== partes.length) {
        out.push(
          violacao('turno', 'turno.claim_completo', 'claim gravado pela metade (token/dono/lease)', {
            turn_id: t.id,
            claim_token: t.claim_token,
            claimed_by: t.claimed_by,
            lease_expires_at: t.lease_expires_at,
          }),
        );
      }
    }

    if (t.status === 'superseded' && t.superseded_by_turn_id === null) {
      out.push(
        violacao('turno', 'turno.superseded_aponta_absorvedor', 'turno `superseded` sem absorvedor', {
          turn_id: t.id,
        }),
      );
    }
  }
  return out;
}

/**
 * FIFO: no máximo UM turno ativo por stream.
 *
 * O índice único parcial `agent_turns_stream_active_uq` já garante isso no
 * banco — e é exatamente por isso que o oracle o verifica de novo. Um cenário
 * cuja única testemunha fosse o índice ficaria verde no dia em que a migration
 * que o cria não rodasse; aqui a afirmação é independente do mecanismo que a
 * sustenta.
 */
function checarFifo(foto: FotoDuravel): ViolacaoDeInvariante[] {
  const ocupantes = new Map<string, string[]>();
  for (const t of foto.turnos) {
    if (t.stream_key === null) continue;
    if (!(STREAM_OCCUPYING_STATUSES as readonly string[]).includes(t.status)) continue;
    const chave = `${t.tenant_id}/${t.agent_id}/${t.stream_key}`;
    ocupantes.set(chave, [...(ocupantes.get(chave) ?? []), t.id]);
  }
  const out: ViolacaoDeInvariante[] = [];
  for (const [chave, ids] of ocupantes) {
    if (ids.length > 1) {
      out.push(
        violacao('fifo', 'fifo.um_ativo_por_stream', 'mais de um turno ATIVO na mesma stream', {
          stream: chave,
          turnos: ids,
          estados_ocupantes: STREAM_OCCUPYING_STATUSES,
        }),
      );
    }
  }
  return out;
}

function checarOutbound(foto: FotoDuravel): ViolacaoDeInvariante[] {
  const out: ViolacaoDeInvariante[] = [];

  // UMA linha por saída LÓGICA. É a invariante central de #506, e a que uma
  // falha injetada entre o outbox e a entrega tende a quebrar.
  const porChave = new Map<string, LinhaDeSaida[]>();
  for (const s of foto.saidas) {
    if (s.logical_dedupe_key === null) continue;
    const chave = `${s.tenant_id}/${s.agent_id}/${s.logical_dedupe_key}`;
    porChave.set(chave, [...(porChave.get(chave) ?? []), s]);
  }
  for (const [chave, linhas] of porChave) {
    if (linhas.length > 1) {
      out.push(
        violacao('outbound', 'outbound.uma_linha_por_saida_logica', 'duas linhas para a MESMA saída lógica', {
          logical_dedupe_key: chave,
          ids: linhas.map((l) => l.id),
          hashes: linhas.map((l) => l.payload_hash),
        }),
      );
    }
  }

  // Duas saídas com a mesma posição no mesmo turno significam que a ordem da
  // resposta multipart deixou de ser total — e ordem parcial num multipart é
  // uma mensagem entregue fora de sequência.
  const porPosicao = new Map<string, string[]>();
  for (const s of foto.saidas) {
    if (s.turn_id === null || s.sequence_in_turn === null) continue;
    const chave = `${s.turn_id}#${s.sequence_in_turn}`;
    porPosicao.set(chave, [...(porPosicao.get(chave) ?? []), s.id]);
  }
  for (const [chave, ids] of porPosicao) {
    if (ids.length > 1) {
      out.push(
        violacao('outbound', 'outbound.sequencia_unica_no_turno', 'duas saídas na mesma posição do turno', {
          posicao: chave,
          ids,
        }),
      );
    }
  }

  for (const s of foto.saidas) {
    if (s.delivery_outcome === null) continue;
    if (!(OUTBOUND_DELIVERY_OUTCOMES as readonly string[]).includes(s.delivery_outcome)) {
      out.push(
        violacao('outbound', 'outbound.desfecho_conhecido', 'delivery_outcome fora do vocabulário de #506', {
          outbound_id: s.id,
          delivery_outcome: s.delivery_outcome,
        }),
      );
      continue;
    }
    // "aceito pelo provedor" NÃO é "o usuário recebeu". A tradução autoritativa
    // é `statusForOutcome` — importada, não copiada: uma cópia continuaria
    // afirmando o mapa antigo depois de a política mudar.
    const esperado = statusForOutcome(s.delivery_outcome as never);
    if (esperado === 'delivery_unknown' && s.status !== 'delivery_unknown' && s.status !== 'reconciling') {
      out.push(
        violacao(
          'outbound',
          'outbound.desconhecido_nao_e_entregue',
          `desfecho "${s.delivery_outcome}" deixa a entrega DESCONHECIDA, mas a linha está em "${s.status}"`,
          { outbound_id: s.id, status: s.status, delivery_outcome: s.delivery_outcome, esperado },
        ),
      );
    }
  }

  return out;
}

/**
 * Isolamento. É a checagem que uma injeção de falha cross-tenant precisa
 * quebrar, e a issue a exige em TODA fronteira.
 *
 * `default` tem tratamento próprio porque ele não é um tenant qualquer: é o
 * fallback histórico da plataforma, e uma linha que caiu nele é uma resolução
 * de escopo que falhou em silêncio.
 */
function checarSeguranca(foto: FotoDuravel): ViolacaoDeInvariante[] {
  const permitidos = new Set(foto.escopoEsperado.map((e) => `${e.tenant_id}/${e.agent_id}`));
  const out: ViolacaoDeInvariante[] = [];

  const conferir = (tipo: string, id: string, tenant_id: string, agent_id: string): void => {
    const par = `${tenant_id}/${agent_id}`;
    if (!permitidos.has(par)) {
      out.push(
        violacao('seguranca', 'seguranca.escopo_declarado', `${tipo} fora do escopo declarado do cenário`, {
          tipo,
          id,
          encontrado: par,
          esperados: [...permitidos],
        }),
      );
    }
    if (tenant_id === 'default' || agent_id === 'default') {
      out.push(
        violacao('seguranca', 'seguranca.sem_fallback_default', `${tipo} caiu no escopo "default"`, {
          tipo,
          id,
          tenant_id,
          agent_id,
        }),
      );
    }
  };

  for (const t of foto.turnos) conferir('turno', t.id, t.tenant_id, t.agent_id);
  for (const s of foto.saidas) conferir('outbound', s.id, s.tenant_id, s.agent_id);
  for (const a of foto.auditorias) conferir('audit', a.id, a.tenant_id, a.agent_id);
  return out;
}

function checarOperacao(foto: FotoDuravel, opts: OpcoesDeVerificacao): ViolacaoDeInvariante[] {
  if (!opts.exigirConvergencia) return [];
  const agora = Date.parse(foto.agoraDoBanco);
  const out: ViolacaoDeInvariante[] = [];
  for (const t of foto.turnos) {
    if (isTurnStatus(t.status) && isTerminalTurnStatus(t.status)) continue;
    const leaseViva = t.lease_expires_at !== null && Date.parse(t.lease_expires_at) > agora;
    const retryAgendado = t.next_attempt_at !== null;
    if (leaseViva || retryAgendado) continue;
    out.push(
      violacao(
        'operacao',
        'operacao.turno_orfao',
        'turno não terminal, sem lease viva e sem retry agendado — ninguém o possui e ninguém o acordará',
        {
          turn_id: t.id,
          status: t.status,
          lease_expires_at: t.lease_expires_at,
          next_attempt_at: t.next_attempt_at,
          agora_do_banco: foto.agoraDoBanco,
        },
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// PROGRESSO — o que só duas fotos conseguem dizer
// ---------------------------------------------------------------------------

/**
 * Invariantes que dependem do TEMPO, e por isso não cabem numa foto só.
 *
 * A mais importante é a terceira: um estado terminal não volta atrás. É a
 * forma observável de "mutação stale" — um worker que perdeu a posse e escreveu
 * assim mesmo aparece aqui como um turno que era `completed` e voltou a
 * `running`, ou como um `state_version` que regrediu.
 */
export function verificarProgresso(
  antes: FotoDuravel,
  depois: FotoDuravel,
): ViolacaoDeInvariante[] {
  const out: ViolacaoDeInvariante[] = [];
  const porId = new Map(antes.turnos.map((t) => [t.id, t]));
  for (const d of depois.turnos) {
    const a = porId.get(d.id);
    if (!a) continue;

    if (d.attempt_count < a.attempt_count) {
      out.push(
        violacao('turno', 'turno.attempt_monotonico', 'attempt_count REGREDIU', {
          turn_id: d.id,
          antes: a.attempt_count,
          depois: d.attempt_count,
        }),
      );
    }
    if (d.state_version < a.state_version) {
      out.push(
        violacao('turno', 'turno.versao_monotonica', 'state_version REGREDIU', {
          turn_id: d.id,
          antes: a.state_version,
          depois: d.state_version,
        }),
      );
    }
    if (
      isTurnStatus(a.status) &&
      isTerminalTurnStatus(a.status) &&
      isTurnStatus(d.status) &&
      !isTerminalTurnStatus(d.status)
    ) {
      out.push(
        violacao('turno', 'turno.terminal_nao_volta', 'turno TERMINAL voltou a estado não terminal', {
          turn_id: d.id,
          antes: a.status,
          depois: d.status,
        }),
      );
    }
  }
  return out;
}

/**
 * NENHUMA gravação por um token que já não é o vigente.
 *
 * É a invariante de FENCING vista de fora do código: o cenário guarda o token
 * do dono deposto e afirma que, depois do takeover, nada na linha mudou por
 * conta dele. A prova positiva vem do par (`state_version` congelado desde o
 * takeover + `claim_token` diferente do deposto).
 */
export function verificarFenceDeTokenDeposto(
  depois: FotoDuravel,
  deposto: { turn_id: string; claim_token: string; state_version_no_takeover: number },
): ViolacaoDeInvariante[] {
  const t = depois.turnos.find((x) => x.id === deposto.turn_id);
  if (!t) {
    return [
      violacao('turno', 'turno.deposto_existe', 'o turno do token deposto sumiu da foto', {
        turn_id: deposto.turn_id,
      }),
    ];
  }
  const out: ViolacaoDeInvariante[] = [];
  if (t.claim_token === deposto.claim_token) {
    out.push(
      violacao('turno', 'turno.token_deposto_nao_volta', 'o token deposto voltou a ser o vigente', {
        turn_id: t.id,
        claim_token: t.claim_token,
      }),
    );
  }
  if (t.state_version !== deposto.state_version_no_takeover) {
    out.push(
      violacao(
        'turno',
        'turno.sem_mutacao_stale',
        'a linha mudou depois do takeover — alguém gravou sem ser o dono corrente',
        {
          turn_id: t.id,
          state_version_no_takeover: deposto.state_version_no_takeover,
          state_version_agora: t.state_version,
        },
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// O COLETOR — a única parte com I/O
// ---------------------------------------------------------------------------

export interface OpcoesDoOracle {
  pool: pg.Pool;
  escopo: readonly EscopoEsperado[];
  /** Restringe a foto a estes turnos. Sem isso, o cenário veria o resíduo de outras suítes. */
  turnIds?: readonly string[];
}

export class InvariantOracle {
  private readonly pool: pg.Pool;
  private readonly escopo: readonly EscopoEsperado[];
  private readonly turnIds: readonly string[] | undefined;

  constructor(opts: OpcoesDoOracle) {
    if (opts.escopo.length === 0) {
      throw new Error(
        'InvariantOracle sem escopo esperado: `seguranca.escopo_declarado` não teria contra o que comparar, ' +
          'e a checagem de isolamento viraria decoração.',
      );
    }
    this.pool = opts.pool;
    this.escopo = opts.escopo;
    this.turnIds = opts.turnIds;
  }

  /**
   * Lê o estado durável. Escopado pelos tenants/agents declarados — e, quando o
   * cenário informa `turnIds`, também por eles.
   *
   * `agoraDoBanco` sai do MESMO `SELECT now()` que abre a coleta: comparar
   * lease contra `Date.now()` do processo de teste mediria o skew entre dois
   * relógios junto com a invariante.
   */
  async coletar(): Promise<FotoDuravel> {
    const tenants = this.escopo.map((e) => e.tenant_id);
    const agents = this.escopo.map((e) => e.agent_id);
    const filtroTurno = this.turnIds ? ' AND id = ANY($3::uuid[])' : '';
    const args: unknown[] = this.turnIds ? [tenants, agents, this.turnIds] : [tenants, agents];

    const agora = await this.pool.query<{ agora: string }>('SELECT now()::text AS agora');

    const turnos = await this.pool.query<LinhaDeTurno>(
      `SELECT id::text, tenant_id, agent_id, status, outcome,
              attempt_count::int AS attempt_count, state_version::int AS state_version,
              claim_token::text, claimed_by,
              lease_expires_at::text, next_attempt_at::text,
              stream_key, superseded_by_turn_id::text
         FROM agent_turns
        WHERE tenant_id = ANY($1::text[]) AND agent_id = ANY($2::text[])${filtroTurno}
        ORDER BY created_at`,
      args,
    );

    const filtroSaida = this.turnIds ? ' AND turn_id = ANY($3::uuid[])' : '';
    const saidas = await this.pool.query<LinhaDeSaida>(
      `SELECT id::text, tenant_id, agent_id, turn_id::text,
              sequence_in_turn::int AS sequence_in_turn,
              logical_dedupe_key, payload_hash, status, delivery_outcome
         FROM outbound_messages
        WHERE tenant_id = ANY($1::text[]) AND agent_id = ANY($2::text[])${filtroSaida}
        ORDER BY created_at`,
      args,
    );

    const filtroAudit = this.turnIds ? ' AND alvo_id = ANY($3::uuid[])' : '';
    const auditorias = await this.pool.query<LinhaDeAuditoria>(
      `SELECT id::text, tenant_id, agent_id, acao, alvo_id::text
         FROM audit_log
        WHERE tenant_id = ANY($1::text[]) AND agent_id = ANY($2::text[])${filtroAudit}
        ORDER BY created_at`,
      args,
    );

    return {
      colhidaEm: new Date().toISOString(),
      agoraDoBanco: agora.rows[0]?.agora ?? new Date().toISOString(),
      escopoEsperado: this.escopo,
      turnos: turnos.rows,
      saidas: saidas.rows,
      auditorias: auditorias.rows,
    };
  }

  /** Colhe e verifica. Lança com TODAS as violações, nunca só a primeira. */
  async assertInvariantes(cenario: string, opts: OpcoesDeVerificacao = {}): Promise<FotoDuravel> {
    const foto = await this.coletar();
    const violacoes = verificarInvariantes(foto, opts);
    if (violacoes.length > 0) throw new InvarianteVioladaError(cenario, violacoes);
    return foto;
  }
}
