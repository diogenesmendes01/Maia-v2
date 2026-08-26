/**
 * Issue #630 (fatia A da épica #506) — superfície pública do outbox durável
 * de saída do turno.
 *
 * Consumidores previstos: #631 (commit transacional turno + outbound), #632
 * (delivery worker com claim/lease/fencing), #633 (recovery/sweeper/DLQ),
 * #634 (migração dos call sites de envio) e #635 (histórico/multipart).
 * Importe SEMPRE daqui — `contract.js` é detalhe interno de organização, do
 * mesmo jeito que em `src/runtime/turns/`.
 *
 * Camadas, na ordem em que as fatias as acrescentaram:
 *
 *   `contract.ts`   — #630: o contrato PURO (vocabulário, união Zod,
 *                     serialização canônica, as duas chaves). Sem `db`, sem
 *                     I/O, sem ALS, sem relógio.
 *   `turn-scope.ts` — #631: o `TurnHandle` visível para os limites de saída.
 *   `commit.ts`     — #631: a fronteira que o dispatcher atravessa antes de
 *                     qualquer chamada ao canal. É a única camada com efeito.
 *
 *   `delivery-contract.ts` — #632: o contrato PURO da entrega (elegibilidade do
 *                     claim, capability de idempotência do provedor,
 *                     normalização dos SETE desfechos, política de reenvio).
 *   `delivery-job.ts`      — #632: identidade determinística do job por
 *                     `outbound_id`. Puro, sem `bullmq`.
 *   `provider-adapter.ts`  — #632: união de #630 ⇒ primitiva de `LineOutput`,
 *                     e a limitação de chave nativa do Baileys encapsulada.
 *   `delivery.ts`          — #632: o CICLO. Segunda camada com efeito.
 *
 *   `recovery-contract.ts` — #633: o contrato PURO da recuperação (disposição
 *                     da reconciliação, teto de tentativas, risco de duplicata
 *                     do rearmamento manual, os dois sentidos da divergência
 *                     turno<->outbound). Puro, como os dois irmãos.
 *   `delivery-scope.ts`    — #633: a fronteira de confiança do job de entrega
 *                     (`outbound_id` -> escopo selado + destinatário). É
 *                     CROSS-TENANT por construção, como o resolvedor de #504.
 *   `delivery-consumer.ts` — #633: o consumidor da fila `outbound-delivery`.
 *                     Fino de propósito — resolve, abre escopo, chama o ciclo.
 *
 * A migração dos call sites (#634) e o multipart (#635) ainda não existem.
 *
 * O que fica FORA deste barril, e por quê: `src/db/repositories/outbound-recovery-repo.ts`
 * (importa `auditTx`, que fecharia ciclo com `@/db/repositories.js` — mesma
 * razão dos dois repositórios irmãos), `src/workers/outbound-recovery.ts` (é um
 * worker, não contrato) e `src/ops/outbound-rearm.ts` (é operação de operador).
 */
export * from './contract.js';
export * from './turn-scope.js';
export * from './commit.js';
export * from './delivery-contract.js';
export * from './delivery-job.js';
export * from './provider-adapter.js';
export * from './delivery.js';
export * from './recovery-contract.js';
export * from './delivery-scope.js';
export * from './delivery-consumer.js';
