/**
 * Issue #510 — self-tests do `ProcessSupervisor`.
 *
 * ─── O que está sendo provado, e por que estes casos e não outros ────────────
 *
 * O supervisor existe para uma coisa: dar `SIGKILL` num processo de verdade,
 * no PID certo, e transformar tudo o mais em vermelho legível. Os casos abaixo
 * cobrem as duas faces disso:
 *
 *  - a face útil: o filho sobe, anuncia prontidão, morre quando mandam, e o
 *    encerramento gracioso escala para SIGKILL quando o filho ignora SIGTERM;
 *  - a face perigosa: um PID que não é nosso é RECUSADO, e o processo alheio
 *    continua vivo depois da recusa — verificado, não assumido.
 *
 * A segunda tranca (PID já encerrado) é a que quase nunca é testada e é
 * exatamente como um harness acerta processo alheio sem jamais usar glob: o
 * sistema operacional reatribui o número em segundos.
 *
 * Estes casos sobem PROCESSOS DE VERDADE. Eles não usam Postgres nem Redis, e
 * por isso rodam na lane padrão (`npm test`) — a prova de hard kill não pode
 * depender de infraestrutura que a máquina de quem revisa talvez não tenha.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ForeignPidError,
  ProcessSupervisor,
  ProntidaoTimeoutError,
  SaidaInesperadaError,
} from '../harness/process-supervisor.js';
import { ArtifactCollector } from '../harness/artifacts.js';
import { estavelDurante, eventually } from '../harness/eventually.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(AQUI, '..', 'fixtures');
const VIVO = join(FIXTURES, 'filho-vivo.mjs');
const MORRE = join(FIXTURES, 'filho-morre.mjs');
const MUDO = join(FIXTURES, 'filho-mudo.mjs');
const TEIMOSO = join(FIXTURES, 'filho-teimoso.mjs');
const PULSANTE = join(FIXTURES, 'filho-pulsante.mjs');

const supervisores: ProcessSupervisor[] = [];
function novoSupervisor(artefatos?: ArtifactCollector): ProcessSupervisor {
  const s = new ProcessSupervisor(artefatos);
  supervisores.push(s);
  return s;
}

afterEach(async () => {
  while (supervisores.length > 0) {
    const s = supervisores.pop();
    await s?.dispose();
  }
});

/** `true` enquanto o PID existir. `kill(pid, 0)` não envia sinal — só testa. */
function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('#510 harness — ProcessSupervisor: ciclo de vida', () => {
  it('sobe um filho de verdade, recebe o handshake de prontidão e o mata por PID', async () => {
    // CONTROLE de todo o resto do arquivo: sem ele, "o processo morreu"
    // passaria também num harness que nunca conseguiu subir processo nenhum.
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'vivo', script: VIVO });

    expect(filho.pid).toBeGreaterThan(0);
    const carga = await filho.esperarPronto(10_000);
    expect(carga.papel).toBe('vivo');
    expect(carga.pid).toBe(filho.pid);
    expect(pidVivo(filho.pid)).toBe(true);

    sup.hardKill(filho);
    const enc = await filho.esperarSaida(5_000);
    expect(enc.signal).toBe('SIGKILL');
    expect(filho.vivo).toBe(false);
    await eventually(() => !pidVivo(filho.pid), {
      label: 'PID sai da tabela de processos após SIGKILL',
      timeoutMs: 5_000,
    });
  });

  it('recusa dois filhos com o mesmo label', () => {
    const sup = novoSupervisor();
    sup.spawn({ label: 'dup', script: VIVO });
    expect(() => sup.spawn({ label: 'dup', script: VIVO })).toThrow(/mesmo label/);
  });

  it('prazo de prontidão estoura com diagnóstico quando o filho nunca anuncia', async () => {
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'mudo', script: MUDO });

    // Esperar a linha de RUÍDO antes de cronometrar o prazo é o que torna este
    // caso determinístico. A versão anterior corria o prazo de 300ms contra o
    // boot a frio do Node e ficava vermelha quando os 7 arquivos da suíte
    // rodavam em paralelo: o filho ainda não tinha escrito nada, e o
    // diagnóstico corretamente dizia "(vazio)". Subir o prazo esconderia a
    // corrida; observar a precondição a elimina.
    await eventually(() => filho.stdout.includes('nao falo o protocolo'), {
      label: 'o filho mudo já imprimiu o ruído (precondição do diagnóstico)',
      timeoutMs: 10_000,
      describeState: () => ({ stdout: filho.stdout, stderr: filho.stderr }),
    });

    const erro = await filho.esperarPronto(150).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ProntidaoTimeoutError);
    const msg = (erro as Error).message;
    expect(msg).toContain('"mudo"');
    expect(msg).toContain('150ms');
    // O diagnóstico traz o que o filho REALMENTE imprimiu — é o que distingue
    // "não subiu" de "subiu e não fala o protocolo".
    expect(msg).toContain('nao falo o protocolo');
  });

  it('encerramento gracioso escala para SIGKILL quando o filho ignora SIGTERM', async () => {
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'teimoso', script: TEIMOSO });
    await filho.esperarPronto(10_000);

    const enc = await sup.terminate(filho, 300);
    expect(enc.signal).toBe('SIGKILL');
    expect(filho.stderr).toContain('recebi SIGTERM e vou ignorar');
  });
});

describe('#510 harness — ProcessSupervisor: saída inesperada reprova o cenário', () => {
  it('um filho que morre sozinho vira erro visível e aborta as esperas', async () => {
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'morre', script: MORRE });

    const enc = await filho.esperarSaida(5_000);
    expect(enc.code).toBe(7);

    // 1) O supervisor guarda a causa, e ela é reportável de forma síncrona.
    expect(() => sup.assertNenhumaSaidaInesperada()).toThrow(SaidaInesperadaError);
    expect(() => sup.assertNenhumaSaidaInesperada()).toThrow(/"morre"/);
    expect(() => sup.assertNenhumaSaidaInesperada()).toThrow(/code=7/);
    // O stderr do filho entra no diagnóstico — sem isso, "code=7" não diz nada.
    expect(() => sup.assertNenhumaSaidaInesperada()).toThrow(/de proposito para o self-test/);

    // 2) E o sinal de falha aborta um `eventually` que estivesse esperando por
    // um estado que ninguém mais vai produzir. É a diferença entre reprovar em
    // 20ms com a causa e reprovar em 30s com "expected 0 to be 1".
    expect(sup.sinalDeFalha.aborted).toBe(true);
    const erroDaEspera = await eventually(() => false, {
      label: 'estado que nunca chega',
      timeoutMs: 30_000,
      abortSignal: sup.sinalDeFalha,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((erroDaEspera as Error).message).toContain('foi ABORTADO');
  });

  it('a morte PEDIDA pelo cenário não dispara o sinal de falha', async () => {
    // O discriminador: sem `autorizarSaida`, todo `hardKill` do próprio cenário
    // reprovaria o cenário. Este caso prova que o supervisor distingue.
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'vivo', script: VIVO });
    await filho.esperarPronto(10_000);
    sup.hardKill(filho);
    await filho.esperarSaida(5_000);

    expect(sup.sinalDeFalha.aborted).toBe(false);
    expect(() => sup.assertNenhumaSaidaInesperada()).not.toThrow();
  });
});

describe('#510 harness — hard kill NUNCA atinge processo alheio', () => {
  it('PID que este supervisor não criou é RECUSADO, e o processo alheio sobrevive', async () => {
    // O "processo alheio" é real: subimos um `node` DIRETO, fora do supervisor,
    // exatamente como um agente vizinho na mesma máquina teria.
    const alheio = spawn(process.execPath, [VIVO], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pidAlheio = alheio.pid;
    if (typeof pidAlheio !== 'number') throw new Error('o processo alheio não subiu');

    try {
      await eventually(() => pidVivo(pidAlheio), {
        label: 'processo alheio está vivo antes da tentativa',
        timeoutMs: 5_000,
      });

      const sup = novoSupervisor();
      // O supervisor tem UM filho próprio — assim a recusa não pode ser
      // confundida com "supervisor vazio recusa tudo".
      const proprio = sup.spawn({ label: 'proprio', script: VIVO });
      await proprio.esperarPronto(10_000);

      expect(() => sup.hardKill(pidAlheio)).toThrow(ForeignPidError);
      expect(() => sup.hardKill(pidAlheio)).toThrow(/não foi criado por este ProcessSupervisor/);
      expect(() => sup.hardKill(pidAlheio)).toThrow(/nome, glob ou varredura/);

      // A afirmação que importa: o alheio CONTINUA VIVO depois da recusa.
      expect(pidVivo(pidAlheio)).toBe(true);
      expect(alheio.exitCode).toBeNull();
      expect(alheio.signalCode).toBeNull();

      // E o supervisor continua capaz de matar o que é dele — senão a recusa
      // teria sido "não mata nada", que passaria por engano.
      sup.hardKill(proprio);
      expect((await proprio.esperarSaida(5_000)).signal).toBe('SIGKILL');
      expect(pidVivo(pidAlheio)).toBe(true);
    } finally {
      alheio.kill('SIGKILL');
    }
  });

  it('PID de filho JÁ ENCERRADO é recusado — a tranca contra reuso de PID', async () => {
    // Um PID liberado pode ser reatribuído pelo SO em segundos. Matar "o PID
    // que era do nosso filho" depois que ele morreu é como um harness acerta
    // processo alheio sem nunca usar glob.
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'vivo', script: VIVO });
    await filho.esperarPronto(10_000);
    const pid = filho.pid;

    sup.hardKill(filho);
    await filho.esperarSaida(5_000);

    expect(() => sup.hardKill(pid)).toThrow(/já encerrou/);
    expect(() => sup.hardKill(pid)).toThrow(/reatribuído/);
    expect(sup.pidsSobPosse()).not.toContain(pid);
  });
});

describe('#510 harness (fatia B) — congelar/descongelar: o zumbi que o SIGKILL não modela', () => {
  /** Quantos pulsos o filho já imprimiu. */
  function pulsos(saida: string): number {
    return saida.split('\n').filter((l) => l.trim().startsWith('##fi-pulso##')).length;
  }

  it('a plataforma precisa DECLARAR que congela — não se assume', () => {
    expect(ProcessSupervisor.suportaCongelamento('linux')).toBe(true);
    expect(ProcessSupervisor.suportaCongelamento('darwin')).toBe(true);
    // No Windows o Node aceita o sinal e o sistema não o implementa. Um cenário
    // que dependesse de congelamento ali passaria VACUAMENTE — nada congela, a
    // lease nunca vence, e o teste "não observa violação".
    expect(ProcessSupervisor.suportaCongelamento('win32')).toBe(false);
  });

  it('`SIGSTOP` PARA o filho e `SIGCONT` o devolve — vivo o tempo todo', async () => {
    if (!ProcessSupervisor.suportaCongelamento()) return;
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'pulsante', script: PULSANTE });
    await filho.esperarPronto(10_000);

    // CONTROLE: ele pulsa antes.
    await eventually(() => pulsos(filho.stdout) >= 3, {
      label: 'o filho pulsa antes de ser congelado',
      timeoutMs: 5_000,
    });

    sup.congelar(filho);
    // A invariante é NEGATIVA ("parou de pulsar"), e por isso a janela é o
    // único instrumento — ela reprova no instante do primeiro pulso a mais.
    const congelado = await estavelDurante(() => pulsos(filho.stdout), {
      label: 'o filho congelado não pulsa',
      janelaMs: 600,
      intervalMs: 50,
      justificativa:
        'não existe evento de "pulso que não aconteceu"; a única prova é observar a janela',
    });
    // E ele NÃO morreu — é isso que separa congelar de matar.
    expect(filho.vivo).toBe(true);
    expect(pidVivo(filho.pid)).toBe(true);

    sup.descongelar(filho);
    await eventually(() => pulsos(filho.stdout) > congelado, {
      label: 'o filho descongelado volta a pulsar',
      timeoutMs: 5_000,
      describeState: () => ({ congelado, agora: pulsos(filho.stdout) }),
    });
  }, 30_000);

  it('congelar um PID alheio é RECUSADO, e o processo alheio segue rodando', async () => {
    // A mesma tranca de `hardKill`, e ela importa MAIS aqui: um processo
    // congelado por engano não some da lista de ninguém — ele só para de
    // responder, e quem o operava não tem como saber por quê.
    const alheio = spawn(process.execPath, [VIVO], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pidAlheio = alheio.pid;
    if (typeof pidAlheio !== 'number') throw new Error('o processo alheio não subiu');
    try {
      await eventually(() => pidVivo(pidAlheio), {
        label: 'processo alheio está vivo antes da tentativa',
        timeoutMs: 5_000,
      });
      const sup = novoSupervisor();
      const proprio = sup.spawn({ label: 'proprio', script: PULSANTE });
      await proprio.esperarPronto(10_000);

      const forjado = { pid: pidAlheio, label: 'nao-e-meu' } as unknown as Parameters<
        ProcessSupervisor['congelar']
      >[0];
      expect(() => sup.congelar(forjado)).toThrow(ForeignPidError);
      expect(pidVivo(pidAlheio)).toBe(true);

      // E o supervisor continua capaz de congelar o que é DELE — senão a
      // recusa teria sido "não congela nada", que passaria por engano.
      sup.congelar(proprio);
      expect(proprio.vivo).toBe(true);
      sup.descongelar(proprio);
    } finally {
      alheio.kill('SIGKILL');
    }
  }, 30_000);

  it('congelar um filho JÁ ENCERRADO é recusado — a tranca contra reuso de PID', async () => {
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'efemero', script: PULSANTE });
    await filho.esperarPronto(10_000);
    sup.hardKill(filho);
    await filho.esperarSaida(5_000);
    expect(() => sup.congelar(filho)).toThrow(/já encerrou/);
    expect(() => sup.descongelar(filho)).toThrow(/reatribuído/);
  }, 30_000);
});

describe('#510 harness — teardown idempotente', () => {
  it('`dispose()` duas vezes executa o corpo UMA vez', async () => {
    // O `afterEach` do cenário e o `afterAll` da suíte chamam os dois, e nenhum
    // deveria precisar saber do outro.
    //
    // "Não jogou" seria fraco demais como asserção: uma segunda passagem sem
    // guard também não joga, porque a lista de vivos já está vazia — ela apenas
    // volta a varrer o registro e a tocar PIDs que o SO já liberou. Por isso a
    // afirmação é sobre a CONTAGEM de execuções e sobre o evento único no
    // artefato.
    const artefatos = new ArtifactCollector('self-test-teardown', 'seed-fixa');
    const sup = novoSupervisor(artefatos);
    const filho = sup.spawn({ label: 'vivo', script: VIVO });
    await filho.esperarPronto(10_000);
    const pid = filho.pid;

    await sup.dispose();
    expect(sup.execucoesDeDispose).toBe(1);
    expect(filho.vivo).toBe(false);
    await eventually(() => !pidVivo(pid), {
      label: 'PID some depois do primeiro dispose',
      timeoutMs: 5_000,
    });

    await expect(sup.dispose()).resolves.toBeUndefined();
    await expect(sup.dispose()).resolves.toBeUndefined();
    expect(sup.execucoesDeDispose).toBe(1);
    expect(artefatos.timeline().filter((e) => e.tipo === 'teardown.dispose')).toHaveLength(1);

    // E o supervisor descartado recusa novos filhos, em vez de vazar processo.
    expect(() => sup.spawn({ label: 'tarde', script: VIVO })).toThrow(/já foi descartado/);
  });

  it('`dispose()` de um supervisor sem filhos executa o corpo UMA vez', async () => {
    const sup = novoSupervisor();
    await expect(sup.dispose()).resolves.toBeUndefined();
    await expect(sup.dispose()).resolves.toBeUndefined();
    expect(sup.execucoesDeDispose).toBe(1);
  });

  it('`dispose()` NÃO dispara o sinal de falha dos filhos que ele mesmo derruba', async () => {
    const sup = novoSupervisor();
    const filho = sup.spawn({ label: 'teimoso', script: TEIMOSO });
    await filho.esperarPronto(10_000);
    // Graça curta: o filho ignora SIGTERM de propósito, e o que este caso
    // afirma é a NÃO-emissão do sinal de falha, não a duração da escalada
    // (essa é o caso de `terminate` acima).
    await sup.dispose(200);
    expect(sup.sinalDeFalha.aborted).toBe(false);
    expect(filho.vivo).toBe(false);
  });
});

describe('#510 harness — o supervisor alimenta o artefato', () => {
  it('timeline registra spawn, ready e exit, com PID', async () => {
    const artefatos = new ArtifactCollector('self-test-supervisor', 'seed-fixa');
    const sup = novoSupervisor(artefatos);
    const filho = sup.spawn({ label: 'vivo', script: VIVO });
    await filho.esperarPronto(10_000);
    sup.hardKill(filho);
    await filho.esperarSaida(5_000);

    const tipos = artefatos.timeline().map((e) => e.tipo);
    expect(tipos).toContain('process.spawn');
    expect(tipos).toContain('process.ready');
    expect(tipos).toContain('process.hard_kill');
    expect(tipos).toContain('process.exit');

    const relatorio = artefatos.relatorio() as { processos: Array<Record<string, unknown>> };
    const p = relatorio.processos.find((x) => x.label === 'vivo');
    expect(p?.pid).toBe(filho.pid);
    expect(p?.signal).toBe('SIGKILL');
  });
});
