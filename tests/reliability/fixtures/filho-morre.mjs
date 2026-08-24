/**
 * Filho que morre SOZINHO, sem o cenário ter pedido (issue #510).
 *
 * Exercita a garantia "child inesperadamente encerrado falha o cenário": o
 * supervisor precisa transformar esta saída num erro visível, e não deixar o
 * cenário esperar por um estado que ninguém mais vai produzir.
 *
 * Sai com 7 (número arbitrário e reconhecível) e escreve uma linha em stderr,
 * porque o diagnóstico do supervisor promete incluir as últimas linhas de
 * stderr — e uma promessa sem conteúdo para exibir não seria verificável.
 */
process.stderr.write('filho-morre: encerrando de proposito para o self-test\n');
process.exit(7);
