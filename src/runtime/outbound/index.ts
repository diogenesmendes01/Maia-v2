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
 * Nesta fatia existe UMA camada só: o contrato puro (vocabulário, união Zod,
 * serialização canônica, as duas chaves). Não há fachada, repositório nem
 * worker — de propósito: a fatia é aditiva e NADA passa a ser enviado por
 * caminho novo.
 */
export * from './contract.js';
