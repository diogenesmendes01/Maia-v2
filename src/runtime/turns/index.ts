/**
 * Issue #503 — superfície pública da máquina de estados durável do turno.
 *
 * Consumidores previstos: #504 (claim/lease/fencing/jobId), #505 (FIFO por
 * conversa), #506 (outbox de resposta), #507 (deadline/cancelamento) e #510
 * (fault injection). Importe SEMPRE daqui — `contract.js` e `lifecycle.js` são
 * detalhe interno de organização.
 *
 * Camadas:
 *   contract  — vocabulário puro (estados, outcomes, transições, sanitização);
 *   lifecycle — fachada com flag de rollout, fail-soft, auditoria e métricas;
 *   agentTurnsRepo (src/db/repositories/turn-repos.ts) — única porta de escrita.
 */
export * from './contract.js';
export * from './lifecycle.js';
