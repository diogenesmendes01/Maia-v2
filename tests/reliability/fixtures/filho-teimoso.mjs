/**
 * Filho que anuncia prontidão e IGNORA SIGTERM (issue #510).
 *
 * Exercita a escalada de `terminate()`: SIGTERM, prazo de graça, e só então o
 * SIGKILL — pelo MESMO caminho guardado por PID que `hardKill` usa. Um harness
 * que escalasse por outro caminho teria dois lugares capazes de matar, e só um
 * deles com a tranca.
 */
const LINHA_PRONTO = '##harness-ready##';

process.on('SIGTERM', () => {
  process.stderr.write('filho-teimoso: recebi SIGTERM e vou ignorar\n');
});

setInterval(() => {}, 60_000);

process.stdout.write(`${LINHA_PRONTO} ${JSON.stringify({ pid: process.pid, papel: 'teimoso' })}\n`);
