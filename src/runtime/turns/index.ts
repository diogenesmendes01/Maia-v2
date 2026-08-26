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
// #504 — contexto de execução AMBIENTE da tentativa (posse propagada aos
// limites de efeito). Exportado aqui porque `core.ts`, o dispatcher e o
// outbound o consomem, e a regra da fachada é "importe sempre daqui".
export * from './execution-context.js';
// #505 — identidade de STREAM do ingresso. `stream-key` é a derivação PURA
// (versionada, sem I/O); `stream-ingress` é a fronteira fail-closed que audita,
// mede e recusa. O gateway consome `isStreamIdentityUnresolved` para derrubar o
// ingresso com trilha em vez de deixá-lo virar erro opaco de listener.
export * from './stream-key.js';
export * from './stream-ingress.js';
// #627 — a PROMOÇÃO do sucessor: o sinal (BullMQ), a métrica e a auditoria de
// quem avança quando o head termina. Fica na fachada porque o varredor de
// recovery (`src/workers/message-recovery.ts`) é consumidor de primeira classe
// da reconciliação, e a regra do barril é "importe sempre daqui".
export * from './stream-promotion.js';
