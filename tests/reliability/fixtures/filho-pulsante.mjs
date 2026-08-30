/**
 * Filho PULSANTE (issue #510, fatia B) — o instrumento que torna `SIGSTOP`
 * observável.
 *
 * "O processo foi congelado" é uma afirmação sobre algo que deixou de
 * acontecer, e não existe evento de "não aconteceu". A única forma de
 * observá-la é ter algo que acontece o tempo todo e verificar que PAROU — e
 * depois que VOLTOU, que é o que separa "congelei" de "matei".
 *
 * Um `setInterval` sem `unref` também segura o event loop vivo, de propósito:
 * um filho que sai sozinho não pode ser congelado nem hard-killed.
 */
const LINHA_PRONTO = '##harness-ready##';

let n = 0;

process.on('SIGTERM', () => {
  process.exit(0);
});

setInterval(() => {
  n += 1;
  process.stdout.write(`##fi-pulso## ${JSON.stringify({ n })}\n`);
}, 50);

process.stdout.write(`${LINHA_PRONTO} ${JSON.stringify({ pid: process.pid, papel: 'pulsante' })}\n`);
