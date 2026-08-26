/**
 * Filho que sobe, fica vivo e NUNCA anuncia prontidão (issue #510).
 *
 * Exercita o prazo de handshake de startup: o supervisor precisa estourar com
 * diagnóstico (rótulo, prazo, últimas linhas de stdout/stderr) em vez de
 * pendurar o cenário.
 *
 * Ele imprime ruído em stdout justamente para provar que o supervisor
 * distingue "saiu alguma coisa" de "saiu a LINHA do protocolo".
 */
setInterval(() => {}, 60_000);
process.stdout.write('filho-mudo: subi, mas nao falo o protocolo\n');
