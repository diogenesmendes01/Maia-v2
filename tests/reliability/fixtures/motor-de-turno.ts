/**
 * Issue #510 (fatia E) — o PROCESSO que percorre o caminho de INGRESSO de
 * produção: persistir o inbound, enfileirar o turno, recuperar o que ficou
 * para trás.
 *
 * ─── Por que este filho importa de `src/` ───────────────────────────────────
 *
 * Pelo mesmo motivo de `replica-de-turno.ts` (fatia B) e `replica-de-entrega.ts`
 * (fatia C): se ele reescrevesse o `INSERT` do inbound, os cenários FI-01/02/03
 * continuariam verdes depois de alguém apagar o pre-check de `whatsapp_id` de
 * `mensagensRepo.createInbound` ou a derivação do `jobId` de `enqueueAgent` —
 * provariam o SQL do fixture.
 *
 * As três chamadas aqui são as MESMAS que `src/gateway/baileys.ts` e
 * `src/workers/message-recovery.ts` fazem:
 *
 *   `mensagensRepo.createInbound(input, { withTurn: true })`
 *        — `src/gateway/baileys.ts:1098` (a porta ÚNICA do ingresso, #505);
 *   `enqueueAgent({ mensagem_id, turn_id })`
 *        — `src/gateway/baileys.ts:1290` e `src/workers/message-recovery.ts:184`;
 *   `runMessageRecovery()`
 *        — o varredor INTEIRO, sem reimplementação de laço nenhum.
 *
 * ─── O SEAM de FI-02, e por que ele é honesto ──────────────────────────────
 *
 * `after_inbound_persist_before_enqueue` não tem call site em `src/` (e não
 * pode ter: o teste arquitetural de `self-tests/failpoints.spec.ts` proíbe que
 * qualquer nome do catálogo apareça lá). O que existe é o SEAM: em produção
 * `createInbound` e `enqueueAgent` são duas chamadas SEPARADAS e SEQUENCIAIS,
 * e a janela entre elas é real — está documentada no próprio `createReceivedTurnTx`
 * ("o Postgres grava `received`, o caller tenta o enqueue"). O gate cabe
 * exatamente ali, entre duas chamadas de produção, que é o mesmo padrão de
 * FI-04/05 (`acquireTurnLease` + `markRunning`) e FI-17/18
 * (`beginInlineDelivery` + `recordInlineDelivery`).
 *
 * ─── Protocolo de saída (stdout, uma linha por evento) ──────────────────────
 *
 *   ##harness-ready## {…}   handshake, com os IDs que o driver acompanha
 *   ##fi-ingresso## {…}     o veredito de `createInbound` (ids + `duplicate`)
 *   ##fi-gate## {…}         chegou ao failpoint / foi liberado dele
 *   ##fi-enqueue## {…}      cada `enqueueAgent`, com o jobId determinístico
 *   ##fi-recovery## {…}     o varredor de produção rodou
 */
import { mensagensRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { enqueueAgent } from '@/gateway/queue.js';
import { agentTurnJobId } from '@/runtime/turns/job.js';
import { runMessageRecovery } from '@/workers/message-recovery.js';
import { alcancar, barreira } from '../harness/failpoint-client.js';

/** Os mesmos prefixos de `harness/process-supervisor.ts`, repetidos de */
/** propósito: o fixture não arrasta o harness inteiro para dentro do filho. */
const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

function emitir(prefixo: string, carga: Record<string, unknown>): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} ausente — o filho não sabe o que fazer`);
  return v;
}

function numero(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${nome}="${v}" não é número`);
  return n;
}

const ACOES = ['ingresso', 'enfileirar', 'recuperar'] as const;
type Acao = (typeof ACOES)[number];

function acaoDoAmbiente(): Acao {
  const bruta = exigir('TEST_FI_ACAO');
  if (!(ACOES as readonly string[]).includes(bruta)) {
    throw new Error(`TEST_FI_ACAO="${bruta}" fora do vocabulário: ${ACOES.join(', ')}`);
  }
  return bruta as Acao;
}

const tenant_id = exigir('TEST_FI_TENANT_ID');
const agent_id = exigir('TEST_FI_AGENT_ID');
const acao = acaoDoAmbiente();
const nomeDaBarreira = process.env.TEST_FI_BARREIRA ?? '';
/** `sim` = para no failpoint entre persistir e enfileirar. */
const comGate = (process.env.TEST_FI_GATE ?? 'nao') === 'sim';
/** `sim` = depois do ingresso (e do gate) chama `enqueueAgent`. */
const enfileirarDepois = (process.env.TEST_FI_ENFILEIRAR ?? 'nao') === 'sim';
const repeticoes = numero('TEST_FI_REPETICOES', 1);

const noEscopo = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id, agent_id }, fn);

const dormir = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

let parar = false;
process.on('SIGTERM', () => {
  parar = true;
  process.exit(0);
});

/**
 * O INGRESSO, pela porta única de produção.
 *
 * `metadata.whatsapp_id` é a identidade do EVENTO do provedor — é ele que a
 * dedup de `createInbound` compara, e é por isso que duas réplicas que recebem
 * a mesma reentrega precisam receber o MESMO valor aqui. `metadata.telefone` é
 * a identidade remota de que a `stream_key` é derivada (#505); sem ele o
 * repositório recusa fail-closed, e a recusa seria o teste medindo a própria
 * fixture em vez da dedup.
 */
async function ingressar(): Promise<Record<string, unknown>> {
  const whatsapp_id = exigir('TEST_FI_WHATSAPP_ID');
  const telefone = exigir('TEST_FI_TELEFONE');
  const channel_id = exigir('TEST_FI_CHANNEL_ID');
  const conversa_id = process.env.TEST_FI_CONVERSA_ID ?? null;
  const conteudo = process.env.TEST_FI_CONTEUDO ?? 'mensagem de fault injection';

  const r = await noEscopo(() =>
    mensagensRepo.createInbound(
      {
        conversa_id,
        channel_id,
        direcao: 'in',
        tipo: 'texto',
        conteudo,
        midia_url: null,
        metadata: {
          whatsapp_id,
          remote_jid: `${telefone.replace(/^\+/, '')}@s.whatsapp.net`,
          telefone,
          pushname: null,
          timestamp_ms: Date.now(),
          media_mime: null,
          media_sha256: null,
          media_rejected: null,
          ingress_channel_id: channel_id,
          bot_line_external_id: null,
        },
        processada_em: null,
        ferramentas_chamadas: [],
        tokens_usados: null,
      },
      { withTurn: true },
    ),
  );

  const ids = {
    whatsapp_id,
    mensagem_id: r.row.id,
    turn_id: r.turn?.id ?? null,
    conversa_id: r.row.conversa_id,
    duplicate: r.duplicate,
    stream_key: r.row.stream_key,
    ingress_seq: r.row.ingress_seq === null ? null : Number(r.row.ingress_seq),
    job_id: r.turn ? agentTurnJobId(r.turn.id) : null,
  };
  emitir('##fi-ingresso##', ids);
  return ids;
}

/** `enqueueAgent` REAL, `repeticoes` vezes. O jobId sai da produção. */
async function enfileirar(mensagem_id: string, turn_id: string | null): Promise<void> {
  for (let i = 0; i < repeticoes; i += 1) {
    await noEscopo(() =>
      enqueueAgent({ mensagem_id, ...(turn_id ? { turn_id } : {}) }),
    );
    emitir('##fi-enqueue##', {
      tentativa: i + 1,
      mensagem_id,
      turn_id,
      job_id: turn_id ? agentTurnJobId(turn_id) : null,
    });
  }
}

async function main(): Promise<void> {
  // A LARGADA. Sem ela, quem chega primeiro ao banco é quem terminou de
  // importar o grafo de módulos primeiro — segundos de diferença que não têm
  // nada a ver com a dedup que o cenário quer provar.
  if (nomeDaBarreira !== '') await barreira(nomeDaBarreira);

  if (acao === 'recuperar') {
    // O varredor INTEIRO de produção — dispatcher cross-tenant incluído. Nada
    // de reimplementar o laço: um fixture que chamasse `findRecoverableTurns` e
    // `enqueueAgent` na mão continuaria verde depois de alguém apagar o
    // `enqueueAgent` de `runTurnRecoveryInner`.
    await runMessageRecovery();
    emitir('##fi-recovery##', { rodou: true });
    emitir(LINHA_PRONTO, { pid: process.pid, acao, ok: true });
    while (!parar) await dormir(200);
    return;
  }

  if (acao === 'enfileirar') {
    const mensagem_id = exigir('TEST_FI_MENSAGEM_ID');
    const turn_id = process.env.TEST_FI_TURN_ID ?? null;
    await enfileirar(mensagem_id, turn_id);
    emitir(LINHA_PRONTO, {
      pid: process.pid,
      acao,
      ok: true,
      mensagem_id,
      turn_id,
      job_id: turn_id ? agentTurnJobId(turn_id) : null,
      repeticoes,
    });
    while (!parar) await dormir(200);
    return;
  }

  const ids = await ingressar();
  // O handshake vem ANTES do gate de propósito: o cenário precisa dos IDs para
  // poder matar o processo no ponto exato — e um `SIGKILL` no gate deixaria o
  // cenário sem `turn_id` se o anúncio viesse depois.
  emitir(LINHA_PRONTO, { pid: process.pid, acao, ok: true, ...ids });

  if (comGate) {
    // O SEAM: a persistência JÁ COMITOU e o enqueue ainda não aconteceu. É a
    // janela que `createReceivedTurnTx` documenta e que o recovery existe para
    // fechar.
    emitir('##fi-gate##', {
      fase: 'chegando',
      failpoint: 'after_inbound_persist_before_enqueue',
    });
    await alcancar(
      'after_inbound_persist_before_enqueue',
      {
        turn_id: String(ids.turn_id ?? ''),
        mensagem_id: String(ids.mensagem_id),
        whatsapp_id: String(ids.whatsapp_id),
      },
      { timeoutMs: 120_000 },
    );
    emitir('##fi-gate##', {
      fase: 'liberado',
      failpoint: 'after_inbound_persist_before_enqueue',
    });
  }

  if (enfileirarDepois) {
    await enfileirar(String(ids.mensagem_id), (ids.turn_id as string | null) ?? null);
  }

  // Um filho que terminou o trabalho continua VIVO e calado. É o que permite ao
  // cenário afirmar que ele não gravou nada a mais — um filho que sai não
  // provaria isso, provaria só que ele saiu.
  while (!parar) await dormir(200);
}

main().catch((erro: unknown) => {
  // A `causa` importa: o driver do Drizzle embrulha o erro do PostgreSQL, e sem
  // ela o vermelho mostra a query inteira mas não a CONSTRAINT que a recusou —
  // que é justamente o que se precisa saber. Mesma lição de
  // `replica-de-entrega.ts` (fatia C).
  const causa = erro instanceof Error ? (erro.cause as { message?: string } | undefined) : undefined;
  const detalhe = [
    erro instanceof Error ? erro.name : 'desconhecido',
    causa?.message ?? (erro instanceof Error ? erro.message : String(erro)),
  ].join(': ');
  emitir(LINHA_FATAL, {
    erro: erro instanceof Error ? erro.message : String(erro),
    nome: erro instanceof Error ? erro.name : 'desconhecido',
    causa: causa?.message ?? null,
  });
  // O handshake com `ok: false` para que o cenário veja a CAUSA em vez de um
  // `esperarPronto` que estoura sem dizer nada.
  emitir(LINHA_PRONTO, { pid: process.pid, acao, ok: false, erro: detalhe });
  process.exitCode = 1;
});
