/**
 * Reporter de diagnóstico — issue #545.
 *
 * Existe por dois problemas medidos, e resolve os dois com o mesmo relatório.
 *
 * 1. **O sumário do vitest é inalcançável no log do CI.** Numa falha, o log do
 *    job termina com o dump dos service containers de Postgres e Redis —
 *    centenas de linhas de `checkpoint complete` e de violações de constraint
 *    que são fixtures propositais. Quem lê o log pelo fim não chega ao
 *    sumário. Este reporter imprime, DEPOIS do reporter default, um bloco
 *    curto e auto-contido com o veredito; e, quando `VITEST_SUMMARY_FILE`
 *    está setado, grava o mesmo bloco em arquivo para o CI reimprimir num
 *    passo próprio, endereçável, no fim do job.
 *
 * 2. **Prazo estourado é invisível quando o `retry` o absorve.** O timeout do
 *    vitest NÃO aborta o corpo async: a tentativa estourada continua rodando e
 *    disputa mocks, linhas no banco e estado de módulo com a tentativa
 *    seguinte. Se a segunda tentativa passar, a rodada fica VERDE e ninguém
 *    fica sabendo que houve um corpo órfão competindo. O vitest guarda os
 *    erros de todas as tentativas mesmo num teste que terminou passando
 *    (`TestResultPassed.errors`), então dá para denunciar isso sem reprovar
 *    nada: a seção "prazos estourados" abaixo lista o teste, o número de
 *    tentativas e o aviso de corpo órfão.
 *
 * O relatório também lista os testes mais lentos. Isso não é enfeite: é o
 * controle compensatório do `testTimeout` de 20s (ver `vitest.config.ts`).
 * Um prazo largo deixa de pegar regressão de desempenho; a lista de lentos
 * devolve essa visibilidade sem transformar variação de agendamento em
 * vermelho.
 *
 * Nada aqui altera o veredito da rodada. O reporter é read-only sobre os
 * resultados — ele não reprova, não pula e não silencia nada.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Reporter, SerializedError, TestCase, TestModule } from 'vitest/node';

/** Assinatura textual do estouro de prazo do vitest, em test e em hook. */
import { relative, sep } from 'node:path';

const RE_TIMEOUT = /timed out in \d+\s*ms/i;

// As variáveis abaixo NÃO usam o prefixo `MAIA_` de propósito. O contrato de
// config (#515, `src/config/contract.ts`) falha FECHADO em qualquer `MAIA_*`
// desconhecida, e `loadConfig()` roda no import de vários módulos de produção —
// então um `MAIA_TEST_SUMMARY_FILE` no ambiente derruba a COLETA de ~200
// arquivos com `Invalid configuration: MAIA_TEST_SUMMARY_FILE [contract/unknown]`.
// Foi exatamente o que aconteceu na primeira versão deste arquivo, e foi a
// seção "ARQUIVOS QUE NÃO CARREGARAM" abaixo que denunciou.

const LIMIAR_LENTO_MS = Number(process.env.VITEST_SLOW_MS ?? 1_000);
const TOPO_LENTOS = Number(process.env.VITEST_SLOW_TOP ?? 15);
const TOPO_FALHAS = Number(process.env.VITEST_FAIL_TOP ?? 40);

interface Registro {
  readonly arquivo: string;
  readonly nome: string;
  readonly duracao: number;
  readonly tentativas: number;
  readonly estado: string;
  readonly flaky: boolean;
  readonly erros: readonly string[];
}

/**
 * Primeira linha COM CONTEÚDO da mensagem.
 *
 * O `?? texto` ingênuo devolvia `┌────────────┐` para os erros que vêm em caixa
 * desenhada (os helpers de testcontainers formatam assim), o que é o mesmo que
 * não dizer nada. Linhas feitas só de moldura, traço ou espaço são puladas.
 */
function primeiraLinha(texto: string | undefined): string {
  if (!texto) return '(sem mensagem)';
  const util = texto
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && /[\p{L}\p{N}]/u.test(l));
  return (util ?? texto.trim() ?? '(sem mensagem)').slice(0, 240);
}

function relativo(caminho: string): string {
  // `process.cwd()` usa `\\` no Windows enquanto `moduleId` chega normalizado
  // com `/`, então a concatenação ingênua nunca casava lá e o relatório
  // imprimia o caminho absoluto — pior referência copiável, e expõe o caminho
  // local de quem rodou. Achado do review da PR #566.
  const rel = relative(process.cwd(), caminho);
  return (rel === '' ? caminho : rel).split(sep).join('/');
}

export default class DiagnosticoReporter implements Reporter {
  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
  ): void {
    const registros: Registro[] = [];
    // Erros de COLETA — o arquivo nem chegou a ter testes. Sem esta coleta o
    // relatório diria "falhas: nenhuma" para um arquivo que não compilou, que é
    // pior do que não ter relatório. (Encontrado ao converter as specs de #545:
    // um import mal posicionado deixou o arquivo inteiro fora da rodada e o
    // bloco de diagnóstico dizia `executados=0 falharam=0`.)
    const naoCarregaram: { arquivo: string; erros: string[] }[] = [];

    for (const modulo of modules) {
      for (const teste of modulo.children.allTests()) {
        registros.push(this.registro(modulo, teste));
      }
      const erros = modulo.errors().map((e) => primeiraLinha(e.message));
      for (const suite of modulo.children.allSuites()) {
        erros.push(...suite.errors().map((e) => primeiraLinha(e.message)));
      }
      if (erros.length > 0) {
        naoCarregaram.push({ arquivo: relativo(modulo.moduleId), erros });
      }
    }

    const linhas = this.montar(
      registros,
      naoCarregaram,
      unhandledErrors.map((e) => primeiraLinha(e.message)),
    );
    // Sempre imprime — mesmo verde. O bloco é curto quando não há nada a
    // dizer, e a sua presença constante é o que faz o leitor confiar que a
    // ausência de uma seção significa ausência do problema.
    process.stdout.write(`\n${linhas.join('\n')}\n`);

    const destino = process.env.VITEST_SUMMARY_FILE;
    if (destino) {
      try {
        mkdirSync(dirname(destino), { recursive: true });
        writeFileSync(destino, `${linhas.join('\n')}\n`, 'utf8');
      } catch {
        // Um relatório que não grava não pode derrubar a rodada.
      }
    }

    const resumoGithub = process.env.GITHUB_STEP_SUMMARY;
    if (resumoGithub) {
      try {
        appendFileSync(resumoGithub, `\n\`\`\`\n${linhas.join('\n')}\n\`\`\`\n`, 'utf8');
      } catch {
        /* idem */
      }
    }
  }

  private registro(modulo: TestModule, teste: TestCase): Registro {
    const resultado = teste.result();
    const diag = teste.diagnostic();
    const erros = (resultado.errors ?? []).map((e) => primeiraLinha(e.message));
    return {
      arquivo: relativo(modulo.moduleId),
      nome: teste.fullName,
      duracao: diag?.duration ?? 0,
      // `retryCount` é o número de RE-tentativas; tentativas = 1 + retries.
      tentativas: (diag?.retryCount ?? 0) + 1,
      estado: resultado.state,
      flaky: diag?.flaky ?? false,
      erros,
    };
  }

  private montar(
    registros: readonly Registro[],
    naoCarregaram: readonly { arquivo: string; erros: string[] }[],
    errosSoltos: readonly string[],
  ): string[] {
    const out: string[] = [];
    const linha = '─'.repeat(72);
    out.push(linha);
    out.push('RESUMO DE DIAGNÓSTICO DOS TESTES (maia)');
    out.push(linha);

    const executados = registros.filter((r) => r.estado !== 'skipped').length;
    const pulados = registros.filter((r) => r.estado === 'skipped').length;
    const falhos = registros.filter((r) => r.estado === 'failed');
    out.push(
      `executados=${executados}  falharam=${falhos.length}  pulados=${pulados}` +
        `  (pulado NÃO é passou — specs de integração fazem describe.skip sem TEST_DB_URL)`,
    );

    // ── arquivos que nem carregaram ──────────────────────────────────────
    // Vem PRIMEIRO: um arquivo que não coletou não tem teste nenhum contado
    // acima, e "executados=N falharam=0" sobre o resto é uma leitura falsa.
    if (naoCarregaram.length > 0 || errosSoltos.length > 0) {
      out.push('');
      out.push(
        `ARQUIVOS QUE NÃO CARREGARAM / ERROS FORA DE TESTE: ` +
          `${naoCarregaram.length} arquivo(s), ${errosSoltos.length} erro(s) solto(s)`,
      );
      out.push('  Os contadores acima NÃO cobrem estes — nenhum caso deles chegou a rodar.');
      for (const m of naoCarregaram) {
        out.push(`  · ${m.arquivo}`);
        for (const e of m.erros) out.push(`      ${e}`);
      }
      for (const e of errosSoltos) out.push(`  · (sem arquivo) ${e}`);
    }

    // ── prazos estourados ────────────────────────────────────────────────
    const estouros = registros.filter((r) => r.erros.some((e) => RE_TIMEOUT.test(e)));
    // Prazo estourado FORA de um caso — `beforeAll`, `afterAll`, `beforeEach`,
    // erro solto. Estes não estão em `registros` (que vem de
    // `TestCase.result().errors`), e sem esta coleta o relatório dizia
    // "prazos estourados: nenhum" para uma rodada cujo único problema era um
    // hook estourado. É o achado do review da PR #566, e a ironia é exata:
    // esta PR MOVE os imports frios para `beforeAll`, ou seja, cria justamente
    // o modo de falha que o reporter era cego para ver.
    const estourosForaDeCaso: { arquivo: string; erro: string }[] = [];
    for (const m of naoCarregaram) {
      for (const e of m.erros) {
        if (RE_TIMEOUT.test(e)) estourosForaDeCaso.push({ arquivo: m.arquivo, erro: e });
      }
    }
    for (const e of errosSoltos) {
      if (RE_TIMEOUT.test(e)) estourosForaDeCaso.push({ arquivo: '(sem arquivo)', erro: e });
    }
    const totalEstouros = estouros.length + estourosForaDeCaso.length;
    out.push('');
    if (totalEstouros === 0) {
      out.push('prazos estourados: nenhum.');
    } else {
      out.push(`PRAZOS ESTOURADOS: ${totalEstouros}`);
      out.push(
        '  O timeout do vitest NÃO aborta o corpo async. A tentativa que estourou',
      );
      out.push(
        '  continua rodando e disputa mocks, linhas no banco e estado de módulo com',
      );
      out.push(
        '  o que vier depois. Qualquer outra falha nestes arquivos é suspeita de ser',
      );
      out.push('  consequência, não causa. Leia o prazo primeiro.');
      for (const r of estouros) {
        const marca = r.estado === 'passed' ? 'PASSOU MESMO ASSIM' : r.estado.toUpperCase();
        out.push(
          `  · ${r.arquivo} > ${r.nome}` +
            `\n      ${r.duracao.toFixed(0)}ms · tentativas=${r.tentativas} · ${marca}`,
        );
      }
    }

    // ── recuperados pelo retry ───────────────────────────────────────────
    // O comentário que justificava `retry: 1` afirmava que "uma falha de
    // verdade aparece na segunda tentativa também". Essa afirmação só é
    // verificável se a lista de testes que passaram SÓ na segunda tentativa
    // estiver visível. Sem ela, o retry é um silenciador: a rodada fica verde
    // e ninguém sabe que houve vermelho. Esta seção é essa lista.
    const recuperados = registros.filter((r) => r.flaky);
    out.push('');
    if (recuperados.length === 0) {
      out.push('recuperados pela segunda tentativa (retry): nenhum.');
    } else {
      out.push(`RECUPERADOS PELA SEGUNDA TENTATIVA (retry): ${recuperados.length}`);
      out.push('  Estes NÃO são verdes. São vermelhos que o `retry` absorveu.');
      for (const r of recuperados) {
        out.push(`  · ${r.arquivo} > ${r.nome}`);
        r.erros.forEach((e, i) => out.push(`      [tentativa ${i + 1}] ${e}`));
      }
    }

    // ── mais lentos ──────────────────────────────────────────────────────
    const lentos = [...registros]
      .filter((r) => r.duracao >= LIMIAR_LENTO_MS)
      .sort((a, b) => b.duracao - a.duracao)
      .slice(0, TOPO_LENTOS);
    out.push('');
    if (lentos.length === 0) {
      out.push(`testes acima de ${LIMIAR_LENTO_MS}ms: nenhum.`);
    } else {
      out.push(`MAIS LENTOS (acima de ${LIMIAR_LENTO_MS}ms, topo ${TOPO_LENTOS}):`);
      for (const r of lentos) {
        out.push(`  ${r.duracao.toFixed(0).padStart(7)}ms  ${r.arquivo} > ${r.nome}`);
      }
    }

    // ── falhas ───────────────────────────────────────────────────────────
    // Um arquivo que teve prazo estourado tem corpo órfão rodando. Qualquer
    // OUTRA falha do mesmo arquivo é suspeita de ser consequência disso, e o
    // relatório precisa dizer isso no lugar onde a pessoa lê a falha — não só
    // numa seção acima que ela pode não relacionar.
    const arquivosComEstouro = new Set(estouros.map((r) => r.arquivo));
    out.push('');
    if (falhos.length === 0 && naoCarregaram.length === 0 && errosSoltos.length === 0) {
      out.push('falhas: nenhuma.');
    } else if (falhos.length === 0) {
      // Não há caso vermelho, mas a rodada TEM problema: arquivo que não
      // carregou ou erro fora de teste. Dizer "falhas: nenhuma" aqui
      // contradiria o `Test Files N failed` do vitest logo acima, e produziria
      // exatamente a leitura falsa que este bloco existe para eliminar.
      // Achado do review da PR #566.
      out.push(
        `falhas: nenhum CASO vermelho, mas ${naoCarregaram.length} arquivo(s) não ` +
          `carregaram e ${errosSoltos.length} erro(s) solto(s) — a rodada NÃO passou.`,
      );
    } else {
      out.push(`FALHAS: ${falhos.length}`);
      for (const r of falhos.slice(0, TOPO_FALHAS)) {
        const suspeita =
          arquivosComEstouro.has(r.arquivo) && !r.erros.some((e) => RE_TIMEOUT.test(e))
            ? '   ⚠ suspeita de CONSEQUÊNCIA: houve prazo estourado neste arquivo'
            : '';
        out.push(`  · ${r.arquivo} > ${r.nome}${suspeita}`);
        r.erros.forEach((e, i) => out.push(`      [tentativa ${i + 1}] ${e}`));
      }
      if (falhos.length > TOPO_FALHAS) {
        out.push(`  … e mais ${falhos.length - TOPO_FALHAS} (veja o relatório completo acima)`);
      }
    }

    out.push(linha);
    return out;
  }
}
