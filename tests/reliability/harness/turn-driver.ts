/**
 * Issue #510 (fatia E) — `TurnDriver`: injeta um inbound de VERDADE e
 * acompanha os IDs (`mensagem_id`, `turn_id`, `conversa_id`, job da BullMQ) até
 * o estado terminal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que faltava, e por que sem isto FI-01/02/03 não existiam
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Os cenários das fatias B e C começam do MEIO: `turnoNovo()` e `saidaNova()`
 * fazem `INSERT` direto em `agent_turns`/`outbound_messages`, porque o que
 * estava sob prova era o CLAIM, e o setup podia ser um `INSERT`. FI-01, FI-02 e
 * FI-03 não podem fazer isso — o que está sob prova é justamente a FRONTEIRA
 * DE ENTRADA:
 *
 *   FI-01 pergunta se o MESMO evento entregue duas vezes vira um ingresso só.
 *         Um `INSERT` fabricado responderia sobre o `INSERT` do teste.
 *   FI-02 pergunta se o turno sobrevive a um crash entre persistir e
 *         enfileirar. A janela só existe porque são duas chamadas.
 *   FI-03 pergunta se N enfileiramentos do mesmo turno viram um job. Sem o
 *         produtor real (`enqueueAgent`) não há `jobId` determinístico a testar.
 *
 * ═══ A divisão: o driver OBSERVA, o filho EXECUTA ══════════════════════════
 *
 * Toda chamada de PRODUÇÃO acontece num processo FILHO
 * (`fixtures/motor-de-turno.ts`), pela mesma razão das fatias anteriores — e
 * por uma razão a mais, específica desta:
 *
 * `ReliabilityEnvironment` cria um banco EXCLUSIVO da suíte
 * (`<base>_fi_<slug>`), e o processo do vitest continua apontando para o banco
 * da worktree. Um driver que chamasse `mensagensRepo.createInbound` aqui
 * escreveria no banco ERRADO e o cenário afirmaria sobre linhas que ninguém
 * leu. O filho recebe `env.envDoFilho()` e portanto o banco certo por
 * construção.
 *
 * O que o driver faz no processo do teste é só LER: um `pg.Pool` no banco da
 * suíte e a fila `agent` REAL da BullMQ. As duas leituras usam vocabulário de
 * produção — `parseAgentTurnJob` para classificar o payload do job,
 * `isTerminalTurnStatus` para decidir o que é terminal — porque uma cópia
 * dessas listas continuaria verde depois de a produção mudar.
 *
 * ═══ Nenhum `sleep` ════════════════════════════════════════════════════════
 *
 * Toda espera é `eventually` com prazo e diagnóstico. `esperarEstado` imprime a
 * linha inteira do turno no vermelho; `esperarJobs` imprime os jobs observados.
 * O único lugar em que tempo de relógio aparece como grandeza é
 * `envelhecerTurno`, e ele tem um bloco próprio explicando o que fabrica e o
 * que NÃO fabrica.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { agentQueue } from '@/gateway/queue.js';
import { agentTurnJobId, parseAgentTurnJob } from '@/runtime/turns/job.js';
import { isTerminalTurnStatus, isTurnStatus, type TurnStatus } from '@/runtime/turns/contract.js';
import { eventually } from './eventually.js';
import { ProcessSupervisor, type SupervisedChild } from './process-supervisor.js';
import type { FailpointServer } from './failpoint-transport.js';
import type { ReliabilityEnvironment } from './environment.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
/** O filho que faz as chamadas de produção. Caminho ABSOLUTO. */
export const FIXTURE_DO_MOTOR = resolve(AQUI, '..', 'fixtures', 'motor-de-turno.ts');

/**
 * `--import tsx`, e NÃO o CLI do tsx: o CLI spawna um NETO para aplicar os
 * flags do loader, e o pid que o `ProcessSupervisor` registra passa a ser o do
 * invólucro. Um `SIGKILL` mataria a casca enquanto o processo real segue vivo.
 * A armadilha está documentada em `tests/reliability/README.md` (#513, fatia D)
 * e é cobrada caso a caso (`carga.pid === filho.pid`).
 */
const CARREGADOR_TSX = '--import tsx';

/**
 * Estados de job que a BullMQ 6 sabe listar.
 *
 * `'paused'` saiu de propósito: na 6.x pausar grava um campo no hash
 * `bull:agent:meta` e os jobs FICAM em `wait`, então `getJobs(['paused'])`
 * devolve `[]` sempre. Manter o nome não protegeria nada e esconderia a
 * mudança — a mesma decisão de `tests/integration/turn-job-id-real-redis.spec.ts`.
 */
const ESTADOS_DE_JOB = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'completed',
  'failed',
] as const;

/** O evento do provedor que este cenário vai injetar. */
export interface AlvoDeIngresso {
  /** Identidade do EVENTO no provedor — é o que a dedup de #505 compara. */
  readonly whatsapp_id: string;
  /** Identidade REMOTA (E.164). Deriva a `stream_key`; distinta por alvo. */
  readonly telefone: string;
  readonly conversa_id: string;
  readonly pessoa_id: string;
  readonly conteudo: string;
}

/** O que o motor devolve depois de percorrer o ingresso de produção. */
export interface IdsDoTurno {
  readonly pid: number;
  readonly ok: boolean;
  readonly whatsapp_id: string;
  readonly mensagem_id: string;
  /**
   * `null` quando o ingresso foi DEDUPADO: o caminho de duplicata de
   * `createInbound` devolve a row original e NÃO cria turno — que é
   * exatamente a invariante de FI-01, vista de dentro do processo perdedor.
   */
  readonly turn_id: string | null;
  readonly conversa_id: string | null;
  readonly duplicate: boolean;
  readonly stream_key: string | null;
  readonly ingress_seq: number | null;
  /** `agentTurnJobId(turn_id)` — o id determinístico de #504; `null` sem turno. */
  readonly job_id: string | null;
  readonly erro?: string;
}

/** A linha durável do turno, como o cenário a lê. */
export interface LinhaDoTurno {
  status: string;
  outcome: string | null;
  attempt_count: number;
  state_version: number;
  claim_token: string | null;
  claimed_by: string | null;
  conversa_id: string | null;
  stream_key: string | null;
  representative_message_id: string;
  lease_expires_at: Date | null;
  next_attempt_at: Date | null;
  created_at: Date;
}

/** Um job da fila `agent`, já classificado pelo parser de PRODUÇÃO. */
export interface JobObservado {
  readonly id: string | undefined;
  readonly nome: string;
  readonly estado: string;
  readonly versao: 'v1' | 'v2' | 'invalid';
  readonly turn_id: string | null;
  readonly mensagem_id: string | null;
}

export interface OpcoesDoTurnDriver {
  env: ReliabilityEnvironment;
  pool: pg.Pool;
  sup: ProcessSupervisor;
  servidor: FailpointServer;
  tenant_id: string;
  agent_id: string;
  /** Rótulo da linha (`channels.external_id`). Único por driver. */
  linha?: string;
}

/** Env extra que um cenário pode empilhar sobre o do motor. */
export type EnvDoMotor = Readonly<Record<string, string>>;

export class TurnDriver {
  readonly tenant_id: string;
  readonly agent_id: string;
  /** `channels.id` da linha desta suíte. A `stream_key` de #505 o exige. */
  readonly channel_id: string;

  private readonly env: ReliabilityEnvironment;
  private readonly pool: pg.Pool;
  private readonly sup: ProcessSupervisor;
  private readonly servidor: FailpointServer;
  /** Jobs que ESTE driver pode limpar. A fila `agent` é compartilhada. */
  private readonly jobsArmados = new Set<string>();

  private constructor(opts: OpcoesDoTurnDriver & { channel_id: string }) {
    this.env = opts.env;
    this.pool = opts.pool;
    this.sup = opts.sup;
    this.servidor = opts.servidor;
    this.tenant_id = opts.tenant_id;
    this.agent_id = opts.agent_id;
    this.channel_id = opts.channel_id;
  }

  /**
   * Semeia a LINHA (`channels`) desta suíte e devolve o driver.
   *
   * A linha é obrigatória e não é cerimônia: `deriveStreamKey` recusa
   * `missing_channel` sem ela (#505), porque desde a migration 090 a conversa é
   * escopada por canal. Um driver sem linha faria todo ingresso ser recusado
   * fail-closed, e o cenário mediria a recusa em vez da dedup.
   */
  static async criar(opts: OpcoesDoTurnDriver): Promise<TurnDriver> {
    const linha = opts.linha ?? `+5511${String(Date.now()).slice(-9)}`;
    const r = await opts.pool.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, display_name, active)
       VALUES ($1, $2, 'whatsapp', $3, 'FI linha', true)
       RETURNING id::text AS id`,
      [opts.tenant_id, opts.agent_id, linha],
    );
    return new TurnDriver({ ...opts, channel_id: r.rows[0]!.id });
  }

  /**
   * Um alvo NOVO: pessoa, conversa e telefone próprios.
   *
   * O telefone é distinto por alvo de propósito. Com head-of-line ligado
   * (`FEATURE_TURN_HEAD_OF_LINE`, default ON) dois alvos no MESMO telefone
   * compartilhariam `stream_key`, e o segundo turno ficaria atrás do primeiro
   * na fila da stream — um bloqueio legítimo de produção que, dentro de um
   * cenário, apareceria como "o turno não avançou" sem nenhuma relação com a
   * falha injetada.
   */
  async criarAlvo(rotulo = 'fi'): Promise<AlvoDeIngresso> {
    const telefone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const p = await this.pool.query<{ id: string }>(
      `INSERT INTO pessoas (tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1, $2, $3, $4, 'dono', 'ativa') RETURNING id::text AS id`,
      [this.tenant_id, this.agent_id, `Alvo ${rotulo}`, telefone],
    );
    const c = await this.pool.query<{ id: string }>(
      `INSERT INTO conversas (tenant_id, agent_id, pessoa_id, status)
       VALUES ($1, $2, $3, 'ativa') RETURNING id::text AS id`,
      [this.tenant_id, this.agent_id, p.rows[0]!.id],
    );
    return {
      whatsapp_id: `FI-${rotulo}-${randomUUID()}`,
      telefone,
      pessoa_id: p.rows[0]!.id,
      conversa_id: c.rows[0]!.id,
      conteudo: `ingresso de fault injection (${rotulo})`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OS PROCESSOS
  // ─────────────────────────────────────────────────────────────────────────

  /** Sobe um motor com a ação `ingresso`. Não espera prontidão. */
  subirIngresso(label: string, alvo: AlvoDeIngresso, extra: EnvDoMotor = {}): SupervisedChild {
    return this.spawn(label, {
      TEST_FI_ACAO: 'ingresso',
      TEST_FI_WHATSAPP_ID: alvo.whatsapp_id,
      TEST_FI_TELEFONE: alvo.telefone,
      TEST_FI_CHANNEL_ID: this.channel_id,
      TEST_FI_CONVERSA_ID: alvo.conversa_id,
      TEST_FI_CONTEUDO: alvo.conteudo,
      ...extra,
    });
  }

  /** Sobe um motor com a ação `enfileirar`. Não espera prontidão. */
  subirEnfileirador(
    label: string,
    alvo: { mensagem_id: string; turn_id: string },
    extra: EnvDoMotor = {},
  ): SupervisedChild {
    this.jobsArmados.add(agentTurnJobId(alvo.turn_id));
    return this.spawn(label, {
      TEST_FI_ACAO: 'enfileirar',
      TEST_FI_MENSAGEM_ID: alvo.mensagem_id,
      TEST_FI_TURN_ID: alvo.turn_id,
      ...extra,
    });
  }

  /** Sobe um motor que roda `runMessageRecovery()` — o varredor de produção. */
  subirRecuperador(label: string, extra: EnvDoMotor = {}): SupervisedChild {
    return this.spawn(label, { TEST_FI_ACAO: 'recuperar', ...extra });
  }

  /**
   * O handshake, com a premissa de todo `SIGKILL` desta família cobrada: o pid
   * que anunciou é o pid supervisionado, e não o de um invólucro.
   */
  async prontidao(filho: SupervisedChild, timeoutMs = 45_000): Promise<IdsDoTurno> {
    const carga = (await filho.esperarPronto(timeoutMs)) as unknown as IdsDoTurno;
    if (carga.pid !== filho.pid) {
      throw new Error(
        `o pid anunciado por "${filho.label}" (${String(carga.pid)}) não é o pid supervisionado ` +
          `(${filho.pid}) — um SIGKILL mataria um invólucro. Ver a armadilha do CLI do tsx ` +
          'em tests/reliability/README.md.',
      );
    }
    if (carga.ok === false) {
      throw new Error(
        `o motor "${filho.label}" falhou antes de terminar a ação: ${carga.erro ?? '(sem motivo)'}`,
      );
    }
    if (typeof carga.turn_id === 'string') this.jobsArmados.add(agentTurnJobId(carga.turn_id));
    return carga;
  }

  /** Sobe UM motor de ingresso e espera os IDs. O atalho do caso simples. */
  async injetar(label: string, alvo: AlvoDeIngresso, extra: EnvDoMotor = {}): Promise<IdsDoTurno> {
    return await this.prontidao(this.subirIngresso(label, alvo, extra));
  }

  /** Roda o varredor de produção UMA vez e espera ele terminar. */
  async recuperar(label: string): Promise<void> {
    await this.prontidao(this.subirRecuperador(label));
  }

  private spawn(label: string, env: EnvDoMotor): SupervisedChild {
    return this.sup.spawn({
      label,
      script: FIXTURE_DO_MOTOR,
      cwd: process.cwd(),
      env: {
        ...this.env.envDoFilho(),
        ...this.servidor.envDoFilho(),
        // Acrescentado, não substituído: o que o worker do vitest já pediu
        // continua valendo para o filho.
        NODE_OPTIONS: [process.env.NODE_OPTIONS, CARREGADOR_TSX].filter(Boolean).join(' '),
        TEST_FI_TENANT_ID: this.tenant_id,
        TEST_FI_AGENT_ID: this.agent_id,
        ...env,
      },
      // Import a frio do grafo de produção sob `tsx` numa máquina compartilhada.
      readyTimeoutMs: 45_000,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AS LEITURAS
  // ─────────────────────────────────────────────────────────────────────────

  async linhaDoTurno(turn_id: string): Promise<LinhaDoTurno> {
    const r = await this.pool.query<LinhaDoTurno>(
      `SELECT status, outcome, attempt_count::int AS attempt_count,
              state_version::int AS state_version, claim_token::text AS claim_token,
              claimed_by, conversa_id::text AS conversa_id, stream_key,
              representative_message_id::text AS representative_message_id,
              lease_expires_at, next_attempt_at, created_at
         FROM agent_turns WHERE id = $1`,
      [turn_id],
    );
    const linha = r.rows[0];
    if (!linha) throw new Error(`turno ${turn_id} sumiu do banco`);
    return linha;
  }

  /** Quantos INGRESSOS (rows de `mensagens`) o mesmo evento produziu. */
  async ingressosDoEvento(whatsapp_id: string): Promise<
    Array<{ id: string; turn_id: string | null; ingress_seq: number | null }>
  > {
    const r = await this.pool.query<{
      id: string;
      turn_id: string | null;
      ingress_seq: number | null;
    }>(
      `SELECT m.id::text AS id, t.id::text AS turn_id, m.ingress_seq::int AS ingress_seq
         FROM mensagens m
         LEFT JOIN agent_turns t ON t.representative_message_id = m.id
        WHERE m.tenant_id = $1 AND m.agent_id = $2
          AND m.metadata->>'whatsapp_id' = $3
        ORDER BY m.created_at`,
      [this.tenant_id, this.agent_id, whatsapp_id],
    );
    return r.rows;
  }

  /** Os turnos LÓGICOS desta stream — a pergunta de FI-01, vista do banco. */
  async turnosDaStream(stream_key: string): Promise<Array<{ id: string; status: string }>> {
    const r = await this.pool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM agent_turns
        WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3
        ORDER BY created_at`,
      [this.tenant_id, this.agent_id, stream_key],
    );
    return r.rows;
  }

  async processadaEm(mensagem_id: string): Promise<Date | null> {
    const r = await this.pool.query<{ processada_em: Date | null }>(
      `SELECT processada_em FROM mensagens WHERE id = $1`,
      [mensagem_id],
    );
    if (r.rowCount === 0) throw new Error(`mensagem ${mensagem_id} sumiu do banco`);
    return r.rows[0]!.processada_em;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // A FILA
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Os jobs da fila `agent` que pertencem a ESTE turno.
   *
   * A varredura é por PAYLOAD, não por `jobId`. A diferença decide se o cenário
   * de FI-03 é honesto: perguntar `getJob(agentTurnJobId(turn_id))` responderia
   * "existe UM" também num mundo em que a derivação determinística foi apagada
   * e os quatro enfileiramentos criaram quatro jobs com ids aleatórios —
   * `getJob` simplesmente não acharia nenhum deles e o cenário ficaria vermelho
   * pelo motivo ERRADO ("0 to be 1"). Varrendo a fila e classificando o payload
   * com `parseAgentTurnJob` (o parser de PRODUÇÃO), o vermelho passa a ser
   * "esperava 1 job, achei 4" — que é o defeito.
   *
   * A fila é COMPARTILHADA com outras suítes: o filtro por `turn_id`/
   * `mensagem_id` é o que impede este driver de contar trabalho alheio.
   */
  async jobsDoTurno(alvo: { turn_id: string; mensagem_id?: string }): Promise<JobObservado[]> {
    const jobs = await agentQueue.getJobs([...ESTADOS_DE_JOB], 0, -1);
    const observados: JobObservado[] = [];
    for (const job of jobs) {
      const parsed = parseAgentTurnJob(job.data);
      const turn_id = parsed.kind === 'invalid' ? null : (parsed.turn_id ?? null);
      const mensagem_id = parsed.kind === 'v1' ? parsed.mensagem_id : null;
      const meu =
        turn_id === alvo.turn_id.toLowerCase() ||
        (alvo.mensagem_id !== undefined && mensagem_id === alvo.mensagem_id.toLowerCase());
      if (!meu) continue;
      observados.push({
        id: job.id,
        nome: job.name,
        estado: await job.getState(),
        versao: parsed.kind,
        turn_id,
        mensagem_id,
      });
    }
    return observados;
  }

  /** Espera a fila ter EXATAMENTE `quantos` jobs deste turno. */
  async esperarJobs(
    alvo: { turn_id: string; mensagem_id?: string },
    quantos: number,
    opts: { timeoutMs?: number; label?: string } = {},
  ): Promise<JobObservado[]> {
    return await eventually(
      async () => {
        const jobs = await this.jobsDoTurno(alvo);
        return jobs.length === quantos ? jobs : undefined;
      },
      {
        label: opts.label ?? `a fila tem ${quantos} job(s) do turno ${alvo.turn_id}`,
        timeoutMs: opts.timeoutMs ?? 30_000,
        intervalMs: 100,
        describeState: async () => await this.jobsDoTurno(alvo),
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AS ESPERAS
  // ─────────────────────────────────────────────────────────────────────────

  /** Espera o turno chegar a um dos `estados`. Devolve a linha observada. */
  async esperarEstado(
    turn_id: string,
    estados: readonly string[],
    opts: { timeoutMs?: number; label?: string } = {},
  ): Promise<LinhaDoTurno> {
    return await eventually(
      async () => {
        const linha = await this.linhaDoTurno(turn_id);
        return estados.includes(linha.status) ? linha : undefined;
      },
      {
        label: opts.label ?? `o turno ${turn_id} chega a ${estados.join('|')}`,
        timeoutMs: opts.timeoutMs ?? 30_000,
        intervalMs: 100,
        describeState: async () => await this.linhaDoTurno(turn_id),
      },
    );
  }

  /**
   * Espera o turno chegar a QUALQUER estado terminal.
   *
   * O vocabulário vem de `isTerminalTurnStatus`, importado da produção: uma
   * lista própria aqui continuaria verde depois de alguém acrescentar um
   * estado terminal novo à máquina — que é exatamente o momento em que o
   * harness deveria falar.
   */
  async esperarTerminal(
    turn_id: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<LinhaDoTurno> {
    return await eventually(
      async () => {
        const linha = await this.linhaDoTurno(turn_id);
        if (!isTurnStatus(linha.status)) {
          throw new Error(
            `o turno ${turn_id} está em "${linha.status}", que não é um estado da máquina de #503`,
          );
        }
        return isTerminalTurnStatus(linha.status as TurnStatus) ? linha : undefined;
      },
      {
        label: `o turno ${turn_id} chega a um estado TERMINAL`,
        timeoutMs: opts.timeoutMs ?? 60_000,
        intervalMs: 100,
        describeState: async () => await this.linhaDoTurno(turn_id),
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // O ÚNICO RELÓGIO FABRICADO — e o que ele NÃO fabrica
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Envelhece o `created_at` do turno no BANCO.
   *
   * ═══ O que isto fabrica ════════════════════════════════════════════════
   *
   * A IDADE da linha, e só ela. `runMessageRecovery` só considera um turno
   * `received`/`queued` depois de `STUCK_AFTER_MS` — uma constante de módulo de
   * `src/workers/message-recovery.ts`, hoje 2 minutos, sem env que a
   * parametrize. Um cenário que esperasse esse prazo de verdade custaria dois
   * minutos por caso e transformaria a lane num soak.
   *
   * ═══ O que isto NÃO fabrica, e é o ponto ═══════════════════════════════
   *
   * A REGRA de elegibilidade continua inteira: quem decide se o turno é
   * recuperável é `findRecoverableTurns` (estado + head-of-line + poison), e
   * quem o rearma é `enqueueAgent` — as duas de produção, nenhuma tocada aqui.
   * O `UPDATE` mexe numa coluna de tempo; não mexe em `status`, não cria job,
   * não escreve `queued_at`.
   *
   * E o cenário não precisa que se acredite nisso: FI-02 roda o varredor ANTES
   * do envelhecimento e afirma que ele NÃO rearma nada. Essa é a prova de que a
   * regra de idade está viva e barrando — e é o que separa "envelheci a linha"
   * de "desliguei a checagem".
   */
  async envelhecerTurno(turn_id: string, idadeMs: number): Promise<void> {
    const r = await this.pool.query(
      `UPDATE agent_turns
          SET created_at = now() - ($2::bigint || ' milliseconds')::interval
        WHERE id = $1 AND status IN ('received', 'queued')`,
      [turn_id, String(Math.trunc(idadeMs))],
    );
    if (r.rowCount !== 1) {
      throw new Error(
        `envelhecerTurno: esperava 1 linha em received/queued para ${turn_id}, ` +
          `o UPDATE tocou ${String(r.rowCount)}. Envelhecer um turno já reivindicado ` +
          'mudaria o que o cenário está observando em vez de só adiantar o relógio dele.',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FAXINA
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Remove da fila `agent` só os jobs que ESTE driver armou.
   *
   * Nunca `obliterate`/`drain`: a fila é real e compartilhada com outras suítes
   * do mesmo db lógico do Redis — a mesma regra que
   * `tests/integration/turn-job-id-real-redis.spec.ts` já segue. O banco morre
   * com o `DROP DATABASE` do ambiente; o Redis não, então a limpeza da fila é
   * responsabilidade explícita de quem armou.
   */
  async limparJobs(): Promise<void> {
    for (const id of this.jobsArmados) {
      await agentQueue
        .getJob(id)
        .then((j) => j?.remove())
        .catch(() => undefined);
    }
    this.jobsArmados.clear();
  }
}
