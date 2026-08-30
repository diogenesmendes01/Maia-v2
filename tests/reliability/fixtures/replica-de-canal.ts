/**
 * Issue #513 (fatia D) — uma RÉPLICA de verdade disputando a posse de uma linha.
 *
 * ─── Por que este filho é `.ts` e importa de `src/` ──────────────────────────
 *
 * Porque a alternativa esvazia o teste. Se o filho reescrevesse o `INSERT …
 * ON CONFLICT … WHERE` da posse, a suíte continuaria verde depois de alguém
 * apagar o `WHERE` de `src/gateway/channel-lease.ts` — ela estaria provando o
 * SQL do fixture, não o de produção. Aqui o filho chama
 * `acquireChannelLease` / `heartbeatChannelLease` / `releaseChannelLease` /
 * `assertChannelFence` REAIS, pelo mesmo caminho que `startLineSession` usa.
 * O preço é rodar sob `tsx` (o alias `@/` sai do `tsconfig.json` da raiz); o
 * ganho é que a sonda vermelha da fatia D acerta o call site de produção.
 *
 * ─── As duas réplicas são o MESMO código ────────────────────────────────────
 *
 * `TEST_FI_MODO=replica` é o caminho de A e o de B, sem ramo que as distinga.
 * Em produção o que separa duas réplicas é `runtimeInstanceId()` —
 * `<hostname>:<pid>` — e nada mais; um fixture com "modo dono" e "modo
 * pretendente" teria embutido no teste a resposta que o teste faz a pergunta.
 * Quem é dono aqui é decidido pelo PostgreSQL, exatamente como lá.
 *
 * ─── Por que existe um `release` no SIGTERM ─────────────────────────────────
 *
 * Ele é o DISCRIMINADOR da fatia D. "Depois do SIGKILL nenhum release rodou" só
 * significa alguma coisa se um release PODIA ter rodado: sem o handler abaixo,
 * a mesma afirmação passaria num fixture que simplesmente nunca devolve a
 * linha. Com ele, o mesmo binário, parado com SIGTERM, zera
 * `session_owner_instance` — e é a comparação entre os dois encerramentos que
 * separa "matei o processo" de "chamei stop()".
 *
 * ─── Protocolo de saída (stdout, uma linha por evento) ──────────────────────
 *
 *   ##harness-ready## {…}   handshake do ProcessSupervisor, com o resultado da
 *                           PRIMEIRA tentativa de aquisição
 *   ##fi-tentativa## {…}    uma tentativa recusada
 *   ##fi-posse## {…}        a tentativa que virou posse
 *   ##fi-batida## {…}       um heartbeat, com o resultado devolvido pelo banco
 *   ##fi-perda## {…}        o heartbeat que devolveu != 'renewed'
 *   ##fi-devolucao## {…}    o release do SIGTERM (nunca aparece após SIGKILL)
 *   ##fi-zumbi## {…}        o veredito das quatro operações do dono que voltou
 */
import {
  acquireChannelLease,
  assertChannelFence,
  channelOwnerInstanceId,
  heartbeatChannelLease,
  releaseChannelLease,
  type ChannelLeaseScope,
} from '@/gateway/channel-lease.js';

/** Os mesmos prefixos de `harness/process-supervisor.ts`. Repetidos de */
/** propósito: o fixture não deve arrastar o harness para dentro do filho. */
const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

function emitir(prefixo: string, carga: Record<string, unknown>): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} ausente — o filho não sabe qual linha disputar`);
  return v;
}

function numero(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${nome}="${v}" não é número`);
  return n;
}

const escopo: ChannelLeaseScope = {
  tenant_id: exigir('TEST_FI_TENANT_ID'),
  agent_id: exigir('TEST_FI_AGENT_ID'),
  channel_id: exigir('TEST_FI_CHANNEL_ID'),
};
const ttlMs = numero('TEST_FI_TTL_MS', 6_000);
const intervaloMs = numero('TEST_FI_INTERVALO_MS', 250);
const batidaMs = numero('TEST_FI_BATIDA_MS', 1_000);
const modo = process.env.TEST_FI_MODO ?? 'replica';
/**
 * Identidade do dono. Fora do modo `zumbi` ela é SEMPRE a real deste processo —
 * é o pid que separa esta réplica da outra, e forjá-la aqui devolveria o teste
 * ao mundo de "duas réplicas dentro de um processo" que a fatia D existe para
 * deixar para trás.
 */
const donoForjado = process.env.TEST_FI_OWNER_ID;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/** Estado que o handler de SIGTERM precisa para devolver a linha. */
let posseAtual: { fencing_token: number } | undefined;
let parar = false;

process.on('SIGTERM', () => {
  parar = true;
  void (async () => {
    if (posseAtual) {
      const devolvida = await releaseChannelLease(escopo, posseAtual.fencing_token);
      emitir('##fi-devolucao##', { devolvida, fencing_token: posseAtual.fencing_token });
    } else {
      emitir('##fi-devolucao##', { devolvida: false, motivo: 'nunca fui dono' });
    }
    process.exit(0);
  })();
});

/**
 * O laço de uma réplica: tenta a posse até conseguir e, tendo-a, renova.
 *
 * É a mesma forma da fatia B (`publishLocalSessionOwnership` renova sob fence e
 * larga o socket ao perder), reduzida ao que a fatia D observa: o banco.
 */
async function replica(): Promise<void> {
  const dono = channelOwnerInstanceId();
  let tentativas = 0;
  let anunciou = false;

  while (!parar) {
    tentativas += 1;
    const r = await acquireChannelLease(escopo, { ttlMs });
    if (!anunciou) {
      anunciou = true;
      emitir(LINHA_PRONTO, {
        papel: 'replica',
        pid: process.pid,
        owner_instance_id: dono,
        held: r.held,
        result: r.result,
        fencing_token: r.held ? r.fencing_token : null,
        held_by: r.held ? null : r.held_by,
        tentativas,
      });
    }
    if (r.held) {
      posseAtual = { fencing_token: r.fencing_token };
      emitir('##fi-posse##', {
        result: r.result,
        fencing_token: r.fencing_token,
        owner_instance_id: r.owner_instance_id,
        lease_expires_at: r.lease_expires_at.toISOString(),
        tentativas,
      });
      await bater(r.fencing_token);
      return;
    }
    emitir('##fi-tentativa##', { result: r.result, held_by: r.held_by, tentativas });
    await sleep(intervaloMs);
  }
}

/**
 * O heartbeat. Cada batida é ANUNCIADA antes de a próxima começar, e é essa
 * linha que o cenário usa para mirar o `SIGKILL` na janela entre uma renovação
 * e a seguinte.
 */
async function bater(token: number): Promise<void> {
  let n = 0;
  while (!parar) {
    await sleep(batidaMs);
    if (parar) return;
    n += 1;
    const resultado = await heartbeatChannelLease(escopo, token, { ttlMs });
    emitir('##fi-batida##', { n, resultado, fencing_token: token });
    if (resultado !== 'renewed') {
      posseAtual = undefined;
      emitir('##fi-perda##', { n, resultado, fencing_token: token });
      // Perder a posse NÃO é motivo para sair: um filho que morre sozinho
      // reprova o cenário no `ProcessSupervisor`, e o que queremos observar é
      // justamente que o ex-dono continua de pé sem conseguir escrever nada.
      await ociosidade();
      return;
    }
  }
}

/**
 * O dono antigo que "volta" — um processo NOVO com o token velho na mão.
 *
 * As quatro operações fenced são exercidas na ordem em que um dono ressuscitado
 * as tentaria, e nenhuma delas pode pegar. `TEST_FI_OWNER_ID` existe só aqui:
 * é o que permite reapresentar a identidade de um processo que já morreu sem
 * ter de ressuscitar o pid dele.
 */
async function zumbi(): Promise<void> {
  const dono = donoForjado ?? channelOwnerInstanceId();
  const token = numero('TEST_FI_TOKEN', 0);
  const opts = { ownerInstanceId: dono };

  const envio = await assertChannelFence(escopo, token, 'send', opts);
  const batida = await heartbeatChannelLease(escopo, token, { ttlMs, ...opts });
  const devolucao = await releaseChannelLease(escopo, token, opts);
  const retomada = await acquireChannelLease(escopo, { ttlMs, ...opts });

  // O veredito sai ANTES do handshake, de propósito: quem espera
  // `##harness-ready##` precisa encontrar `##fi-zumbi##` já no buffer. Na ordem
  // inversa, o cenário resolveria a prontidão e leria o veredito antes de o
  // chunk seguinte chegar.
  emitir('##fi-zumbi##', {
    owner_instance_id: dono,
    fencing_token: token,
    envio_autorizado: envio,
    heartbeat: batida,
    release_pegou: devolucao,
    retomada: retomada.result,
    retomada_held: retomada.held,
  });
  emitir(LINHA_PRONTO, { papel: 'zumbi', pid: process.pid, owner_instance_id: dono, token });
  await ociosidade();
}

/** Fica vivo sem trabalhar. Quem decide a morte deste filho é o cenário. */
async function ociosidade(): Promise<void> {
  while (!parar) await sleep(60_000);
}

async function main(): Promise<void> {
  if (modo === 'zumbi') {
    await zumbi();
    return;
  }
  await replica();
  await ociosidade();
}

main().catch((erro: unknown) => {
  const detalhe = erro instanceof Error ? erro.message : String(erro);
  // O marcador vai para stdout porque é ALI que o `ProcessSupervisor` lê o
  // protocolo; a pilha vai para stderr, que é o que entra no diagnóstico de
  // `SaidaInesperadaError`.
  process.stdout.write(`${LINHA_FATAL} ${detalhe}\n`);
  process.stderr.write(`${erro instanceof Error ? (erro.stack ?? erro.message) : String(erro)}\n`);
  process.exit(1);
});
