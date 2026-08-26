/**
 * Filho de referência do `ProcessSupervisor` (issue #510).
 *
 * Anuncia prontidão, fica vivo até receber SIGTERM e então sai com 0. É o
 * comportamento que um worker bem-comportado tem, e serve de CONTROLE: sem
 * ele, "o processo morreu" passaria também num harness que nunca conseguiu
 * subir processo nenhum.
 *
 * Um `setInterval` sem `unref` é o que segura o event loop vivo — de
 * propósito. Um filho que sai sozinho não pode ser hard-killed.
 */
const LINHA_PRONTO = '##harness-ready##';

process.on('SIGTERM', () => {
  process.exit(0);
});

setInterval(() => {}, 60_000);

process.stdout.write(`${LINHA_PRONTO} ${JSON.stringify({ pid: process.pid, papel: 'vivo' })}\n`);
