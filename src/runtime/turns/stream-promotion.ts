/**
 * Issue #627 (fatia D da #505) — o SINAL da promoção: a única porta por onde um
 * turno eleito para avançar é acordado.
 *
 * ─── A frase que este módulo torna estrutural ─────────────────────────────
 *
 * "A BullMQ é **wake-up, não fonte de verdade**." A decisão de quem avança é
 * uma linha do PostgreSQL (`agent_turns.promoted_at`, migration 127), gravada
 * na mesma transação que a produziu. Este módulo faz UMA coisa depois disso:
 * bate na fila. Se a batida falhar, nada se perde — o varredor de recovery
 * encontra o turno promovido e sem job e fecha o buraco (§12 do runbook).
 *
 * ─── Por que um módulo separado, e não duas linhas em `lifecycle.ts` ──────
 *
 * `src/gateway/queue.ts` abre a conexão `ioredis` NO IMPORT (`new IORedis(...)`
 * no escopo do módulo). `lifecycle.ts` é carregado por dezenas de specs
 * unitárias e pelo grafo compartilhado; um `import` estático de lá para cá
 * faria toda uma delas abrir um socket para o Redis só por tocar a máquina de
 * estados. Daí o `await import()` DENTRO da função — o mesmo padrão de
 * `src/runtime/lifecycle/shutdown-sequence.ts` e de
 * `src/runtime/lifecycle/readiness.ts`, e pela mesma razão. O módulo da fila só
 * é carregado quando existe promoção de verdade para sinalizar.
 *
 * ─── Por que os TRÊS fatos saem daqui juntos ──────────────────────────────
 *
 * Métrica, log estruturado e `audit_log` para o MESMO evento, num lugar só —
 * a mesma regra que `reportFenceRejection` (src/runtime/turns/lease.ts) segue,
 * e pela mesma razão: três callers fazendo isso à mão é como um deles acaba sem
 * auditoria, e a que falta é sempre a do caminho raro.
 */
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import type { StreamClaimRecovery } from './claim.js';
import { recordStreamPromotion } from './stream-metrics.js';

/**
 * DE ONDE veio a promoção. Vocabulário fechado — vira `metadata.source` da
 * `audit_log`, nunca label de métrica.
 *
 *  - `terminal` — o predecessor chegou a estado terminal e elegeu o sucessor na
 *    mesma transação do CAS. É o caminho da issue;
 *  - `stream_claim_recovery` — o claim EXPIRADO de um turno da stream foi
 *    recuperado dentro da transação de um claim (#625). O turno recuperado é o
 *    head e acabou de perder o único wake-up que tinha (o job do dono morto);
 *  - `recovery_reconciliation` — o varredor encontrou um turno PROMOVIDO cujo
 *    sinal não chegou à fila e o re-armou. É a reconciliação de "commit feito,
 *    enqueue não feito".
 */
export type StreamPromotionSource =
  | 'terminal'
  | 'stream_claim_recovery'
  | 'recovery_reconciliation';

/**
 * Sinaliza a BullMQ para um turno já PROMOVIDO no banco, e registra os três
 * fatos.
 *
 * ─── Por que nunca lança ──────────────────────────────────────────────────
 *
 * O caller é sempre um caminho que JÁ TERMINOU o trabalho importante: o turno
 * anterior foi concluído e comitado, ou o claim foi decidido. Propagar uma
 * falha de Redis daqui transformaria "a conversa vai demorar um ciclo do
 * varredor" em "a conclusão do turno anterior falhou", que é infinitamente pior
 * — e MENTIRA, porque ela não falhou.
 *
 * O preço é explícito e medido: `maia_stream_promotion_total{result="enqueue_failed"}`.
 * Ele não é um erro esquecido, é o começo de uma reconciliação — e o par a
 * vigiar é `enqueue_failed` sem `recovered` acompanhando, que significa
 * varredor parado, não promoção quebrada.
 */
export async function signalStreamPromotion(
  promotion: StreamClaimRecovery,
  args: { source: StreamPromotionSource; promoted_by_turn_id?: string },
): Promise<void> {
  // A AUDITORIA ANTES DO SINAL, e a ordem não é estética: a `audit_log` é o
  // registro durável de que a plataforma DECIDIU promover. Auditar depois do
  // enqueue deixaria a janela em que o job existe e nenhuma trilha explica de
  // onde ele veio — que é exatamente a pergunta feita durante um incidente.
  await audit({
    acao: 'turn_promoted',
    ...(promotion.conversa_id ? { conversa_id: promotion.conversa_id } : {}),
    alvo_id: promotion.turn_id,
    metadata: {
      source: args.source,
      status_before: promotion.status_before,
      status_after: promotion.status_after,
      ...(args.promoted_by_turn_id ? { promoted_by_turn_id: args.promoted_by_turn_id } : {}),
    },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'stream.turn_promoted_audit_failed'),
  );

  try {
    // `await import` — ver o cabeçalho: `@/gateway/queue.js` conecta ao Redis no
    // import, e este módulo é alcançado pelo grafo da máquina de estados.
    const { enqueueAgent } = await import('@/gateway/queue.js');
    // `turn_id` no payload é o que torna o `jobId` DETERMINÍSTICO (#504): duas
    // promoções do mesmo turno — a conclusão e o varredor, por exemplo — armam
    // o MESMO job, e a BullMQ ignora o segundo `add`. É o que faz "promover de
    // forma idempotente" valer também no transporte, e não só no banco.
    await enqueueAgent({
      mensagem_id: promotion.representative_message_id,
      turn_id: promotion.turn_id,
    });
    recordStreamPromotion(args.source === 'recovery_reconciliation' ? 'recovered' : 'promoted');
    logger.info(
      {
        turn_id: promotion.turn_id,
        source: args.source,
        promoted_by: args.promoted_by_turn_id ?? null,
        status_before: promotion.status_before,
      },
      'stream.turn_promoted',
    );
  } catch (err) {
    recordStreamPromotion('enqueue_failed');
    // `warn`, não `error`: a decisão está COMITADA e o varredor a reconcilia.
    // Um `ops_alert` aqui pediria intervenção humana para algo que o sistema
    // conserta sozinho em um ciclo — e alerta que se resolve sozinho é como se
    // ensina o plantão a ignorar alerta.
    logger.warn(
      {
        turn_id: promotion.turn_id,
        source: args.source,
        err: (err as Error).message,
      },
      'stream.turn_promotion_enqueue_failed',
    );
  }
}

/**
 * A conclusão terminou e NÃO havia sucessor a promover.
 *
 * Contado, e não silenciado, porque `promoted` sozinho não distingue "as
 * conversas estão acabando" de "a promoção parou de rodar". O denominador é o
 * sinal: `promoted / (promoted + no_successor)` é a fração de conclusões que
 * destravaram fila, e ela cai a zero exatamente quando alguém desliga a flag
 * sem querer.
 */
export function noteNoSuccessor(): void {
  recordStreamPromotion('no_successor');
}

/**
 * O VARREDOR fechou o buraco: encontrou um turno PROMOVIDO cujo wake-up não
 * chegou à fila, e o re-armou.
 *
 * ─── Por que isto existe como evento, e não como silêncio ─────────────────
 *
 * É a prova operacional da frase que sustenta a fatia: *a BullMQ é wake-up, não
 * fonte de verdade*. Um turno promovido e sem job é um estado NORMAL e
 * transitório do protocolo — acontece toda vez que um processo morre entre o
 * commit e o `enqueueAgent`. O que não pode acontecer é ele ser permanente, e a
 * única forma de saber a diferença é contar as reconciliações.
 *
 * `enqueue_failed` subindo COM `recovered` acompanhando é o sistema
 * funcionando. `enqueue_failed` sem `recovered` é o varredor parado — e essa é
 * a leitura que nenhum log solto daria.
 *
 * ─── O falso positivo conhecido, e por que ele é estreito ─────────────────
 *
 * Um turno re-armado pela recuperação de claim expirado volta a `retryable` com
 * `next_attempt_at = now()`, então ele é elegível para o varredor IMEDIATAMENTE.
 * Se o varredor rodar entre o `enqueueAgent` bem-sucedido e o claim que o
 * consome, ele conta uma reconciliação que não era necessária (o `jobId`
 * determinístico faz o segundo `add` ser ignorado, então não há trabalho
 * duplicado — só uma contagem a mais). A janela é de milissegundos contra um
 * período de varredura de minutos, e fechá-la exigiria consultar a fila a
 * partir do banco — trocar um contador levemente pessimista por uma dependência
 * do Redis dentro do varredor. Para o caminho da conclusão (turno `queued`) o
 * falso positivo não existe: o varredor exige `created_at <= now - 2min`.
 */
export async function notePromotionReconciled(args: {
  turn_id: string;
  conversa_id: string | null;
  status: string;
}): Promise<void> {
  recordStreamPromotion('recovered');
  logger.warn(
    { turn_id: args.turn_id, status: args.status, source: 'recovery_reconciliation' },
    'stream.turn_promotion_reconciled',
  );
  await audit({
    acao: 'turn_promoted',
    ...(args.conversa_id ? { conversa_id: args.conversa_id } : {}),
    alvo_id: args.turn_id,
    metadata: {
      source: 'recovery_reconciliation' satisfies StreamPromotionSource,
      status_before: args.status,
      status_after: args.status,
    },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'stream.turn_promoted_audit_failed'),
  );
}

/**
 * Uma tentativa STALE tentou concluir o turno — e, com isso, liberar o sucessor
 * — e foi RECUSADA.
 *
 * É a falha nº 9 da issue-mãe vista de frente: *"takeover após lease expirado
 * permite ao worker antigo liberar o sucessor"*. Aqui ela não acontece, e o
 * fato de não ter acontecido precisa ser VISÍVEL: sem esta linha, um zumbi
 * recusado e um turno que simplesmente não tinha sucessor produziriam
 * exatamente o mesmo silêncio.
 *
 * A recusa em si já foi registrada por `reportFenceRejection`
 * (`maia_turn_fence_rejected_total` + `turn_fence_rejected`) — o que se
 * acrescenta aqui é a leitura de ESCALONAMENTO: "uma promoção deixou de
 * acontecer porque quem tentou não era mais o dono". Duas séries, dois fatos:
 * a primeira responde "quantas escritas de zumbi foram barradas?", esta
 * responde "quantas vezes a fila deixou de andar por causa disso?".
 */
export async function reportPromotionFenceRejected(args: {
  turn_id: string;
  operation: string;
  attempt: number;
}): Promise<void> {
  recordStreamPromotion('fence_rejected');
  logger.warn(
    {
      turn_id: args.turn_id,
      operation: args.operation,
      attempt: args.attempt,
      ops_alert: true,
    },
    'stream.turn_promotion_rejected',
  );
  await audit({
    acao: 'turn_promotion_rejected',
    alvo_id: args.turn_id,
    metadata: { operation: args.operation, attempt: args.attempt, reason: 'stale_claim' },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'stream.turn_promotion_rejected_audit_failed'),
  );
}
