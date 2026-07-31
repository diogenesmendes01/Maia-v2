/**
 * Issue #503 — superfície pública da máquina de estados durável do turno.
 *
 * Consumidores previstos: #504 (claim/lease/fencing/jobId), #505 (FIFO por
 * conversa), #506 (outbox de resposta), #507 (deadline/cancelamento) e #510
 * (fault injection). Importe SEMPRE daqui — `contract.js` e `lifecycle.js` são
 * detalhe interno de organização.
 *
 * Camadas:
 *   contract          — vocabulário puro de estados (#503);
 *   claim             — vocabulário puro de posse: payload da fila, jobId
 *                       determinístico, elegibilidade e config de lease (#504);
 *   execution-context — o ALS que carrega o fence pelo pipeline (#504);
 *   lease             — o detentor da lease: claim, heartbeat, cancelamento (#504);
 *   lifecycle         — fachada com flag de rollout, fail-soft, auditoria e métricas;
 *   agentTurnsRepo (src/db/repositories/turn-repos.ts) — única porta de escrita.
 */
export * from './contract.js';
export * from './claim.js';
export * from './execution-context.js';
export * from './lease.js';
export * from './lifecycle.js';
