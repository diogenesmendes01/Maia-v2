/**
 * Issue #510 (fatia B) — o TRANSPORTE do failpoint: como o processo filho
 * anuncia `reached` e como o cenário responde.
 *
 * ═══ Por que faltava, e por que ele é o que torna a injeção não-vácua ═══════
 *
 * A fatia A entregou o `FailpointGateRegistry`: o lado do CENÁRIO do protocolo
 * (armar, receber `reached`, resolver quem espera). O que não existia era o
 * outro lado do fio. Sem transporte, um "cenário de fault injection" só
 * consegue injetar o que o próprio processo de teste consegue simular — e um
 * `throw` simulado ainda roda `finally`, ainda fecha o pool, ainda cancela o
 * timer do heartbeat. É exatamente a crítica que `tests/reliability/README.md`
 * já fazia às suítes de #504, e ela vale igualmente para um harness sem fio.
 *
 * ═══ HTTP local, e não IPC ══════════════════════════════════════════════════
 *
 * A issue admite "IPC/HTTP local/DB". A escolha aqui é HTTP em `127.0.0.1` com
 * porta efêmera, por três razões concretas:
 *
 *  1. **IPC mudaria o `stdio` de TODO filho.** `ProcessSupervisor` spawna com
 *     `['ignore','pipe','pipe']`. Acrescentar um canal `ipc` liga o filho ao
 *     pai por um handle que mantém o event loop do PAI vivo — num runner de
 *     testes isso é um worker do vitest que não termina. O custo apareceria em
 *     filhos que nem usam failpoint.
 *  2. **O DB seria o meio menos confiável justamente nos cenários que
 *     importam.** Vários failpoints existem para observar o instante em que a
 *     conexão do worker com o Postgres é a coisa que falha. Um canal de
 *     controle que depende dela some junto com o que ele deveria observar.
 *  3. **A env var já existe e já foi pensada assim.** `FAILPOINT_ENDPOINT_ENV`
 *     (`TEST_RELIABILITY_FAILPOINT_URL`) está no catálogo desde a fatia A, com
 *     o comentário "onde o filho anuncia `reached` e escuta liberação".
 *
 * ═══ A resposta DIFERIDA é o handshake ══════════════════════════════════════
 *
 * `POST /reached` não responde na hora quando existe um gate `pause` armado: a
 * resposta HTTP fica ABERTA até o cenário chamar `liberar()`. É isso que faz o
 * protocolo da issue funcionar sem um único `sleep`:
 *
 *   1. o cenário arma `pause` no failpoint;
 *   2. o filho chega lá, anuncia, e PARA — bloqueado no `await fetch`;
 *   3. `waitForReached()` do cenário resolve com os IDs anunciados;
 *   4. o cenário faz o que quiser com um processo PARADO num ponto exato —
 *      inclusive `hardKill`, que é o caso interessante;
 *   5. `liberar()` (ou o `dispose()`) devolve a resposta e o filho segue.
 *
 * Um `sleep(500)` no lugar do passo 3 seria a diferença entre "matei o worker
 * DEPOIS do claim e ANTES do running" e "matei o worker em algum lugar por
 * ali" — e é a segunda que produz cenário flaky e prova nenhuma.
 *
 * ═══ Segurança ═════════════════════════════════════════════════════════════
 *
 * O servidor herda as trancas do catálogo e acrescenta duas próprias:
 *
 *  - `assertFailpointsAllowed()` roda no `iniciar()`. Perfil de produção não
 *    sobe servidor nenhum, sem opt-out.
 *  - escuta em `127.0.0.1` e em porta EFÊMERA, nunca em `0.0.0.0`. Não há
 *    superfície pública, que é requisito nominal da issue.
 *  - todo request precisa do header `x-fi-token` com o token SORTEADO desta
 *    rodada. Ele não protege contra atacante (é loopback); protege contra
 *    ACIDENTE — um filho que herdou `TEST_RELIABILITY_FAILPOINTS` do ambiente
 *    de outro job não consegue armar nada aqui e diz por quê.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { ArtifactCollector } from './artifacts.js';
import {
  FAILPOINT_ENABLE_ENV,
  FAILPOINT_ENDPOINT_ENV,
  FAILPOINT_TOKEN_ENV,
  FailpointGateRegistry,
  assertFailpointsAllowed,
  parseFailpointName,
  type FailpointAction,
  type FailpointName,
  type ReachedEvent,
} from './failpoints.js';

/** Caminho do anúncio de failpoint. Não há rota de leitura — nada a enumerar. */
export const ROTA_REACHED = '/failpoint/reached';

/**
 * Caminho da BARREIRA — e por que ela NÃO é um failpoint.
 *
 * Um failpoint é um ponto do código de PRODUÇÃO com nome no catálogo. Uma
 * barreira é o contrário disso: é o cenário segurando o tiro de largada de
 * várias réplicas para que a corrida aconteça de verdade. Ela não descreve
 * nada da produção, então não pode entrar num catálogo cuja função é justamente
 * ser a lista fechada dos pontos que a produção tem.
 *
 * Ela existe porque a issue exige que corridas sejam liberadas "por
 * barrier/gate, não por sleep": duas réplicas que só sobem e tentam produzem um
 * vencedor por ordem de boot — o mais rápido a importar o grafo de módulos —, e
 * isso não é corrida, é sorteio de tempo de import.
 */
export const ROTA_BARREIRA = '/failpoint/barreira';

/** Header do token por rodada. */
export const HEADER_TOKEN = 'x-fi-token';

/**
 * O que o servidor devolve ao filho. `release` é o único que manda seguir em
 * frente; os outros são a falha injetada.
 *
 * `pause` NÃO aparece aqui de propósito: do ponto de vista do filho, uma pausa
 * é a AUSÊNCIA de resposta. Ter um valor `pause` no fio convidaria um cliente
 * a dormir por conta própria — que é o `sleep` cego voltando pela janela.
 */
export const RESPOSTAS_DE_FAILPOINT = ['release', 'error', 'disconnect', 'kill'] as const;
export type RespostaDeFailpoint = (typeof RESPOSTAS_DE_FAILPOINT)[number];

/** Um anúncio que está PARADO esperando decisão do cenário. */
export interface AnuncioPendente {
  readonly failpoint: FailpointName;
  readonly context: Readonly<Record<string, string | number>>;
  readonly desdeMs: number;
}

interface Parado {
  failpoint: FailpointName;
  context: Readonly<Record<string, string | number>>;
  desdeMs: number;
  responder: (resposta: RespostaDeFailpoint) => void;
}

export class FailpointServerError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FailpointServerError';
  }
}

/**
 * O lado do CENÁRIO. Envolve o `FailpointGateRegistry` (que continua puro e
 * testável sem rede) e acrescenta só o fio.
 */
export class FailpointServer {
  readonly registry: FailpointGateRegistry;
  readonly token: string;
  private readonly servidor: Server;
  private readonly artefatos: ArtifactCollector | undefined;
  private readonly parados: Parado[] = [];
  private readonly naBarreira = new Map<string, Array<() => void>>();
  private readonly t0 = Date.now();
  private porta = 0;
  private fechado = false;

  private constructor(
    servidor: Server,
    token: string,
    registry: FailpointGateRegistry,
    artefatos: ArtifactCollector | undefined,
  ) {
    this.servidor = servidor;
    this.token = token;
    this.registry = registry;
    this.artefatos = artefatos;
  }

  /**
   * Sobe o servidor. Recusa CEDO em perfil de produção — antes de abrir socket
   * nenhum.
   *
   * O `env` que a tranca examina é montado aqui e não lido de `process.env`: o
   * servidor É quem sorteia o token e liga a flag, então pedir que o ambiente
   * do processo de teste já os tivesse seria uma cerimônia circular. A condição
   * que importa — perfil de produção — continua vindo do ambiente real.
   */
  static async iniciar(
    opts: { artefatos?: ArtifactCollector; registry?: FailpointGateRegistry } = {},
  ): Promise<FailpointServer> {
    const token = randomBytes(16).toString('hex');
    assertFailpointsAllowed(
      { ...process.env, [FAILPOINT_ENABLE_ENV]: '1', [FAILPOINT_TOKEN_ENV]: token },
      token,
    );

    const registry = opts.registry ?? new FailpointGateRegistry();
    const servidor = createServer();
    const alvo = new FailpointServer(servidor, token, registry, opts.artefatos);
    servidor.on('request', (req, res) => {
      alvo.atender(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      servidor.once('error', reject);
      // `127.0.0.1` explícito e porta 0 (efêmera). Nunca `0.0.0.0`: a issue
      // exige "sem endpoint público", e o default do Node escutaria em todas
      // as interfaces.
      servidor.listen(0, '127.0.0.1', () => {
        servidor.removeListener('error', reject);
        resolve();
      });
    });
    const endereco = servidor.address() as AddressInfo;
    alvo.porta = endereco.port;
    // Um servidor de controle NUNCA deve segurar o event loop do runner: se o
    // cenário esquecer o `fechar()`, o worker do vitest ainda termina.
    servidor.unref();
    opts.artefatos?.evento('failpoint.server_up', { porta: endereco.port });
    return alvo;
  }

  get url(): string {
    return `http://127.0.0.1:${this.porta}`;
  }

  /**
   * As variáveis que um filho precisa para falar com ESTE servidor. Passe
   * direto em `SpawnOptions.env` — junto com `ReliabilityEnvironment.envDoFilho()`.
   */
  envDoFilho(): Record<string, string> {
    return {
      [FAILPOINT_ENABLE_ENV]: '1',
      [FAILPOINT_TOKEN_ENV]: this.token,
      [FAILPOINT_ENDPOINT_ENV]: this.url,
    };
  }

  /** Delegação direta ao registry — o cenário não precisa conhecer os dois. */
  arm(failpoint: string, action: FailpointAction = 'pause', remaining = 1): void {
    this.registry.arm(failpoint, action, remaining);
    this.artefatos?.evento('failpoint.armed', { failpoint, action, remaining });
  }

  disarm(failpoint: string): boolean {
    return this.registry.disarm(failpoint);
  }

  async waitForReached(
    failpoint: string,
    opts: { timeoutMs?: number; desde?: number } = {},
  ): Promise<ReachedEvent> {
    return await this.registry.waitForReached(failpoint, opts);
  }

  /** Anúncios PARADOS agora. É o que o vermelho de um cenário imprime. */
  pendentes(): readonly AnuncioPendente[] {
    return this.parados.map((p) => ({
      failpoint: p.failpoint,
      context: p.context,
      desdeMs: p.desdeMs,
    }));
  }

  /**
   * Devolve a resposta HTTP de quem está parado num failpoint.
   *
   * Retorna QUANTOS foram liberados — e não `void` — porque "liberei" e "não
   * havia ninguém parado" são fatos diferentes, e um cenário que confunde os
   * dois passa a esperar por um filho que nunca chegou ao ponto.
   */
  liberar(failpoint: string, resposta: RespostaDeFailpoint = 'release'): number {
    const nome = parseFailpointName(failpoint);
    let liberados = 0;
    for (let i = this.parados.length - 1; i >= 0; i -= 1) {
      const p = this.parados[i];
      if (!p || p.failpoint !== nome) continue;
      this.parados.splice(i, 1);
      p.responder(resposta);
      liberados += 1;
    }
    this.artefatos?.evento('failpoint.released', { failpoint: nome, resposta, liberados });
    return liberados;
  }

  /** Quantos filhos estão PARADOS neste failpoint AGORA. */
  paradosEm(failpoint: string): number {
    const nome = parseFailpointName(failpoint);
    return this.parados.filter((p) => p.failpoint === nome).length;
  }

  /**
   * Espera `quantos` filhos ESTACIONAREM no failpoint antes de soltá-lo.
   *
   * Existe porque `liberar()` sobre um gate vazio devolve 0 — e um cenário que
   * chama `liberar()` logo depois de observar um sinal INDIRETO está apostando
   * que o filho já chegou. Foi exatamente isso que reprovou a FI-17 no CI:
   *
   *     ❯ fi-outbound-entrega.spec.ts:359
   *       expect(servidor.liberar('after_provider_accept_before_delivery_persist'))
   *       - 1
   *       + 0
   *
   * O cenário esperava o ledger do provider marcar o efeito lógico e SOLTAVA o
   * gate seguinte. Só que o filho registra o efeito no provider e SÓ DEPOIS
   * estaciona no gate: entre uma coisa e outra há uma janela, invisível numa
   * máquina ociosa e real num runner carregado. Esperar o sinal certo — o filho
   * parado ALI — fecha a janela em vez de estreitá-la.
   *
   * Mesmo contrato do `esperarNaBarreira`: sem `sleep` cego, e o estouro diz
   * quantos chegaram, porque "ninguém chegou" e "chegou um só" pedem
   * investigações diferentes.
   */
  async esperarParadoEm(failpoint: string, quantos = 1, timeoutMs = 30_000): Promise<void> {
    const nome = parseFailpointName(failpoint);
    const limite = Date.now() + timeoutMs;
    for (;;) {
      if (this.paradosEm(nome) >= quantos) return;
      if (Date.now() > limite) {
        throw new FailpointServerError(
          `failpoint "${nome}": esperei ${quantos} filho(s) PARADO(s) em ${timeoutMs}ms e ` +
            `chegaram ${this.paradosEm(nome)}. Parados agora: ` +
            `${JSON.stringify(this.pendentes())}. Soltar um gate vazio devolve 0 e faz o ` +
            'cenário seguir esperando por um filho que nunca chegou ao ponto.',
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Quantas réplicas estão paradas nesta barreira AGORA. */
  naBarreiraContagem(nome: string): number {
    return (this.naBarreira.get(nome) ?? []).length;
  }

  /**
   * Espera `quantos` filhos chegarem à barreira. Sem `sleep`: ou eles chegam,
   * ou estoura com quantos chegaram — que é o diagnóstico de "a réplica B nem
   * subiu".
   */
  async esperarNaBarreira(nome: string, quantos: number, timeoutMs = 30_000): Promise<void> {
    const limite = Date.now() + timeoutMs;
    for (;;) {
      if (this.naBarreiraContagem(nome) >= quantos) return;
      if (Date.now() > limite) {
        throw new FailpointServerError(
          `barreira "${nome}": esperei ${quantos} réplica(s) em ${timeoutMs}ms e chegaram ` +
            `${this.naBarreiraContagem(nome)}. Uma réplica que não chega à barreira não corre — ` +
            'e uma "corrida" de um participante só não prova exclusão mútua nenhuma.',
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** O tiro de largada. Devolve quantos partiram. */
  abrirBarreira(nome: string): number {
    const fila = this.naBarreira.get(nome) ?? [];
    this.naBarreira.delete(nome);
    for (const soltar of fila) soltar();
    this.artefatos?.evento('barreira.aberta', { nome, participantes: fila.length });
    return fila.length;
  }

  /**
   * Fecha o servidor. Idempotente.
   *
   * Libera todo mundo que estava parado ANTES de fechar o socket: um filho
   * bloqueado num `await fetch` que nunca responde ficaria vivo até o prazo
   * dele, e o `dispose()` do supervisor teria de escalar para `SIGKILL` — o
   * que sujaria o exit code de todo cenário que usa failpoint.
   */
  async fechar(): Promise<void> {
    if (this.fechado) return;
    this.fechado = true;
    for (const p of this.parados.splice(0)) p.responder('release');
    for (const nome of [...this.naBarreira.keys()]) this.abrirBarreira(nome);
    this.registry.dispose();
    await new Promise<void>((resolve) => {
      this.servidor.close(() => {
        resolve();
      });
      // `closeAllConnections` porque `close()` sozinho espera as conexões
      // keep-alive dos filhos morrerem — e um filho que já foi SIGKILLado
      // deixa a sua para trás.
      this.servidor.closeAllConnections?.();
    });
    this.artefatos?.evento('failpoint.server_down', {});
  }

  private agoraMs(): number {
    return Date.now() - this.t0;
  }

  private atender(req: IncomingMessage, res: ServerResponse): void {
    const rota = req.url ?? '';
    if (req.method !== 'POST' || (rota !== ROTA_REACHED && rota !== ROTA_BARREIRA)) {
      responder(res, 404, { erro: 'rota_desconhecida' });
      return;
    }
    if (req.headers[HEADER_TOKEN] !== this.token) {
      // 403 e não 401: não há autenticação a negociar. O filho ou é desta
      // rodada, ou não é.
      this.artefatos?.evento('failpoint.token_recusado', {});
      responder(res, 403, { erro: 'token_invalido' });
      return;
    }

    let bruto = '';
    req.setEncoding('utf8');
    req.on('data', (pedaco: string) => {
      bruto += pedaco;
      // Um corpo grande aqui é bug do filho, não payload legítimo: o contrato
      // é um nome e um punhado de IDs.
      if (bruto.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let corpo: { failpoint?: unknown; context?: unknown; barreira?: unknown };
      try {
        corpo = JSON.parse(bruto || '{}') as typeof corpo;
      } catch {
        responder(res, 400, { erro: 'json_invalido' });
        return;
      }

      if (rota === ROTA_BARREIRA) {
        const nomeBarreira = String(corpo.barreira ?? '');
        if (nomeBarreira === '') {
          responder(res, 400, { erro: 'barreira_sem_nome' });
          return;
        }
        const soltar = (): void => {
          responder(res, 200, { action: 'release' });
        };
        this.naBarreira.set(nomeBarreira, [...(this.naBarreira.get(nomeBarreira) ?? []), soltar]);
        this.artefatos?.evento('barreira.chegou', {
          nome: nomeBarreira,
          na_barreira: this.naBarreiraContagem(nomeBarreira),
        });
        res.on('close', () => {
          const fila = this.naBarreira.get(nomeBarreira);
          if (!fila) return;
          const i = fila.indexOf(soltar);
          if (i >= 0) fila.splice(i, 1);
        });
        return;
      }

      let nome: FailpointName;
      try {
        nome = parseFailpointName(String(corpo.failpoint ?? ''));
      } catch (erro) {
        // Failpoint inexistente falha CEDO e do lado do FILHO — a issue pede
        // isso nominalmente nos testes do próprio harness.
        responder(res, 400, {
          erro: 'failpoint_desconhecido',
          detalhe: erro instanceof Error ? erro.message : String(erro),
        });
        return;
      }
      const context = normalizarContexto(corpo.context);
      const { action } = this.registry.reached(nome, context);
      this.artefatos?.evento('failpoint.reached', { failpoint: nome, context, action: action ?? 'release' });

      if (action === undefined || action === 'release') {
        responder(res, 200, { action: 'release' });
        return;
      }
      if (action === 'error' || action === 'disconnect' || action === 'kill') {
        responder(res, 200, { action });
        return;
      }
      // `pause`: a resposta fica ABERTA. É o handshake inteiro.
      const parado: Parado = {
        failpoint: nome,
        context,
        desdeMs: this.agoraMs(),
        responder: (resposta) => {
          responder(res, 200, { action: resposta });
        },
      };
      this.parados.push(parado);
      res.on('close', () => {
        const i = this.parados.indexOf(parado);
        if (i >= 0) this.parados.splice(i, 1);
      });
    });
  }
}

function responder(res: ServerResponse, status: number, corpo: unknown): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto) });
  res.end(texto);
}

/**
 * O contexto do anúncio é DADO, não texto livre: só string e número, e nada de
 * objeto aninhado. Um `context` largo viraria o caminho por onde payload de
 * usuário chega ao artefato sem passar pelo sanitizador do lado certo.
 */
function normalizarContexto(bruto: unknown): Readonly<Record<string, string | number>> {
  if (typeof bruto !== 'object' || bruto === null) return {};
  const saida: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') saida[k] = v;
  }
  return saida;
}
