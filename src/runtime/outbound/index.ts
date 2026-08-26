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
 * O delivery worker (#632), o recovery/DLQ (#633), a migração dos call sites
 * (#634) e o multipart (#635) ainda não existem.
 */
export * from './contract.js';
export * from './turn-scope.js';
export * from './commit.js';
