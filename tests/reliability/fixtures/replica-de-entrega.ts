/**
 * Issue #510 (fatia C) — uma RÉPLICA DE DELIVERY WORKER de verdade, disputando
 * uma linha do outbox e falando com um provider que vive FORA deste processo.
 *
 * ─── Por que este filho importa de `src/` ───────────────────────────────────
 *
 * Pelo mesmo motivo de `replica-de-turno.ts` (fatia B) e `replica-de-canal.ts`
 * (#513, fatia D): se ele reescrevesse o `UPDATE … WHERE` do claim de entrega,
 * os cenários FI-17/FI-18 continuariam verdes depois de alguém apagar o
 * `CASE WHEN status = 'sending' THEN 'sending' ELSE 'claimed' END` de
 * `src/db/repositories/outbound-delivery-repo.ts` — provariam o SQL do fixture.
 *
 * Aqui ele chama `beginInlineDelivery` e `recordInlineDelivery` REAIS (as
 * mesmas que `src/agent/output-dispatch.ts` chama). O claim, a disposição
 * `delivery_unknown`, o `markSending` fenced e a gravação do desfecho são todos
 * código de produção.
 *
 * ─── Por que o provider vive em OUTRO processo, e por que isso é o ponto ────
 *
 * A suíte in-process que já existe
 * (`tests/integration/outbound-delivery-claim-lease-fence-real-db.spec.ts`)
 * conta chamadas num objeto fake que mora no MESMO processo do worker. Quando
 * o cenário é "o worker morre com a chamada em voo", esse contador morre JUNTO
 * com o worker — ele não pode ser a autoridade sobre "o sucessor reenviou?",
 * porque ele deixa de existir exatamente no instante que interessa.
 *
 * O ledger de `fake-channel-provider-server.mjs` SOBREVIVE ao `SIGKILL` do
 * worker, então `physical_call_count` e `logical_effect_count` continuam
 * legíveis depois da morte. É a única forma honesta de afirmar "o efeito
 * aconteceu UMA vez" atravessando um crash.
 *
 * ─── Protocolo de saída (stdout, uma linha por evento) ──────────────────────
 *
 *   ##harness-ready## {…}   handshake, com o resultado do claim de entrega
 *   ##fi-posse## {…}        o veredito de `beginInlineDelivery`
 *   ##fi-gate## {…}         chegou ao failpoint / foi liberado dele
 *   ##fi-envio## {…}        o que o provider respondeu (ou não respondeu)
 *   ##fi-desfecho## {…}     o desfecho gravado por `recordInlineDelivery`
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  beginInlineDelivery,
  recordInlineDelivery,
  type InlineDeliveryHandle,
} from '@/runtime/outbound/delivery.js';
import { alcancar, barreira } from '../harness/failpoint-client.js';

const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

function emitir(prefixo: string, carga: Record<string, unknown>): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} ausente — o filho não sabe o que entregar`);
  return v;
}

function numero(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${nome}="${v}" não é número`);
  return n;
}

const tenant_id = exigir('TEST_FI_TENANT_ID');
const agent_id = exigir('TEST_FI_AGENT_ID');
const outbound_id = exigir('TEST_FI_OUTBOUND_ID');
const providerUrl = exigir('TEST_FI_PROVIDER_URL');
const idempotency_key = exigir('TEST_FI_IDEMPOTENCY_KEY');
const payload_hash = exigir('TEST_FI_PAYLOAD_HASH');
const nomeDaBarreira = process.env.TEST_FI_BARREIRA ?? '';
const leaseMs = numero('TEST_FI_LEASE_MS', 6_000);
/** `sim` = chama o provider depois do gate; `nao` = só reivindica e para. */
const enviar = process.env.TEST_FI_ENVIAR ?? 'sim';

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
 * A chamada física ao provider. `fetch` sem retry NENHUM de propósito: um
 * retry aqui dentro produziria duas chamadas físicas para um efeito lógico e
 * poluiria justamente o número que o cenário mede.
 */
async function chamarProvider(): Promise<{ status: number; corpo: unknown; erro?: string }> {
  try {
    const r = await fetch(`${providerUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key, payload_hash, tenant_id, agent_id }),
    });
    const corpo: unknown = await r.json().catch(() => ({}));
    return { status: r.status, corpo };
  } catch (e) {
    // `accept_then_drop`: o efeito ACONTECEU e a resposta nunca chegou. Este
    // ramo é o `timeout_unknown` de produção, e NÃO pode virar "falhou".
    return { status: 0, corpo: null, erro: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  // A LARGADA. Sem ela, quem vence a corrida do claim é quem terminou de
  // importar o grafo de módulos primeiro — segundos de diferença que não têm
  // nada a ver com a exclusão mútua que o cenário quer provar.
  if (nomeDaBarreira !== '') await barreira(nomeDaBarreira);

  let handle: InlineDeliveryHandle | null = null;
  // Sem inicializador: os DOIS caminhos abaixo (sucesso e recusa) atribuem,
  // e um valor inicial aqui seria letra morta que esconde um terceiro caminho.
  let motivo: string;
  let claim_token: string | null = null;
  let attempt: number | null = null;

  try {
    handle = await noEscopo(() => beginInlineDelivery(outbound_id, leaseMs));
    motivo = handle.claim ? 'acquired' : 'sem_linha_duravel';
    claim_token = handle.claim?.claim_token ?? null;
    attempt = handle.claim ? Number(handle.claim.attempt) : null;
  } catch (e) {
    // `DeliveryFenceError` — a posse foi NEGADA. É o caminho do perdedor da
    // corrida (FI-17) e o do sucessor de uma chamada em voo (FI-18). O nome do
    // erro e a razão são o que distingue os dois, e por isso vão ao stdout.
    motivo = e instanceof Error ? `recusado:${e.name}` : 'recusado:desconhecido';
    // A `cause` importa: o driver embrulha o erro do PostgreSQL, e sem ela o
    // diagnóstico do vermelho mostra a query mas não a CONSTRAINT que a
    // recusou — que é justamente o que se precisa saber.
    const causa = e instanceof Error ? (e.cause as { message?: string } | undefined) : undefined;
    emitir('##fi-posse##', {
      acquired: false,
      motivo,
      detalhe: e instanceof Error ? e.message : String(e),
      causa: causa?.message ?? null,
    });
  }

  if (handle?.claim) {
    emitir('##fi-posse##', { acquired: true, claim_token, attempt, motivo });
  }

  emitir(LINHA_PRONTO, {
    pid: process.pid,
    acquired: handle?.claim != null,
    claim_token,
    attempt,
    motivo,
  });

  if (!handle?.claim) {
    // Uma réplica que perdeu a posse continua VIVA e calada. É o que permite
    // ao cenário afirmar que ela não chamou o provider — uma réplica que sai
    // não provaria isso, provaria só que ela saiu.
    while (!parar) await dormir(200);
    return;
  }

  // GATE 1 — depois do claim e do `markSending`, ANTES da chamada ao canal.
  // É aqui que FI-17 segura o vencedor para fotografar a corrida já decidida.
  emitir('##fi-gate##', { fase: 'chegando', failpoint: 'after_outbound_claim_before_send' });
  await alcancar(
    'after_outbound_claim_before_send',
    { outbound_id, attempt: attempt ?? -1, claim_token: claim_token ?? '' },
    { timeoutMs: 120_000 },
  );
  emitir('##fi-gate##', { fase: 'liberado', failpoint: 'after_outbound_claim_before_send' });

  if (enviar !== 'sim') {
    while (!parar) await dormir(200);
    return;
  }

  const resposta = await chamarProvider();
  emitir('##fi-envio##', {
    status: resposta.status,
    erro: resposta.erro ?? null,
    idempotency_key,
  });

  // GATE 2 — o provider JÁ registrou o efeito; nada foi persistido ainda.
  // É aqui que FI-18 mata o processo: o efeito externo existe e o banco não
  // sabe. Um `SIGKILL` neste ponto é a janela mais perigosa do caminho de
  // saída inteiro.
  emitir('##fi-gate##', {
    fase: 'chegando',
    failpoint: 'after_provider_accept_before_delivery_persist',
  });
  await alcancar(
    'after_provider_accept_before_delivery_persist',
    { outbound_id, attempt: attempt ?? -1, claim_token: claim_token ?? '' },
    { timeoutMs: 120_000 },
  );
  emitir('##fi-gate##', {
    fase: 'liberado',
    failpoint: 'after_provider_accept_before_delivery_persist',
  });

  // O desfecho HONESTO: uma resposta que nunca chegou é `timeout_unknown`, e
  // não `rejected_*`. Quem decide o STATUS é `statusForOutcome`, em produção —
  // o fixture só reporta o que observou na rede.
  const outcome = resposta.erro
    ? 'timeout_unknown'
    : resposta.status >= 200 && resposta.status < 300
      ? 'accepted_confirmed'
      : 'rejected_retryable';

  const provider_message_id =
    resposta.corpo && typeof resposta.corpo === 'object'
      ? ((resposta.corpo as Record<string, unknown>).provider_message_id as string | undefined)
      : undefined;

  await noEscopo(() =>
    recordInlineDelivery(handle, {
      outcome,
      payload_type: 'text',
      ...(provider_message_id ? { provider_message_id } : {}),
    }),
  );
  emitir('##fi-desfecho##', { outcome, provider_message_id: provider_message_id ?? null });

  while (!parar) await dormir(200);
}

main().catch((erro: unknown) => {
  emitir(LINHA_FATAL, {
    erro: erro instanceof Error ? erro.message : String(erro),
    nome: erro instanceof Error ? erro.name : 'desconhecido',
  });
  process.exitCode = 1;
});
