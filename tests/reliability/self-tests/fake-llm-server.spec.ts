/**
 * Issue #510 — self-tests do `FakeLlmServer`.
 *
 * ─── O caso que justifica o módulo ───────────────────────────────────────────
 *
 * "o fake LLM registra abort", nas palavras da issue. FI-21 pergunta se o
 * deadline CANCELA trabalho real ou se apenas faz o cliente parar de esperar —
 * duas coisas que um teste com mock não consegue distinguir, porque num mock
 * não existe socket.
 *
 * A distinção é observável exatamente aqui: quando o cliente derruba a
 * conexão, o servidor recebe `close` na resposta ANTES de tê-la terminado. Um
 * cliente que só ignora a resposta (sem `AbortSignal`) deixa a requisição
 * terminar normalmente e `abortado` fica `false`. Por isso o caso do aborto vem
 * acompanhado do seu CONTROLE: sem o controle, `abortado === true` passaria
 * também numa implementação que marca tudo como abortado.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CABECALHO_TENTATIVA, CABECALHO_TURNO, FakeLlmServer } from '../fakes/fake-llm-server.js';
import { eventually } from '../harness/eventually.js';

let servidor: FakeLlmServer;
let base: string;

beforeEach(async () => {
  servidor = new FakeLlmServer();
  base = await servidor.iniciar();
});

afterEach(async () => {
  await servidor.parar();
});

describe('#510 harness — FakeLlmServer: aborto observável', () => {
  it('registra ABORT quando o cliente cancela uma requisição pendurada', async () => {
    servidor.roteirizar([{ kind: 'pendurar' }]);
    const controle = new AbortController();

    const promessa = fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { [CABECALHO_TURNO]: 't-abort', [CABECALHO_TENTATIVA]: '1' },
      body: JSON.stringify({ mensagens: [] }),
      signal: controle.signal,
    });
    // Sem espera cega: só cancelamos DEPOIS que o servidor confirmou ter
    // recebido a chamada.
    await eventually(() => servidor.historico().length === 1, {
      label: 'o fake recebeu a requisição pendurada',
      timeoutMs: 5_000,
    });

    controle.abort();
    await expect(promessa).rejects.toThrow();

    const chamada = await eventually(() => servidor.abortos()[0], {
      label: 'o fake registra o aborto',
      timeoutMs: 5_000,
      describeState: () => servidor.historico(),
    });

    expect(chamada.turnId).toBe('t-abort');
    expect(chamada.attempt).toBe(1);
    expect(chamada.kind).toBe('pendurar');
    expect(chamada.abortado).toBe(true);
    expect(chamada.respondida).toBe(false);
    expect(chamada.finalizadaEmMs).toBeGreaterThanOrEqual(chamada.recebidaEmMs);
  });

  it('CONTROLE: uma requisição que completa NÃO é marcada como abortada', async () => {
    // Sem este caso, "registra abort" passaria também numa implementação que
    // marca toda chamada como abortada.
    servidor.roteirizar([{ kind: 'ok', texto: 'pronto' }]);
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { [CABECALHO_TURNO]: 't-ok', [CABECALHO_TENTATIVA]: '1' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    await r.json();

    expect(servidor.abortos()).toHaveLength(0);
    const [chamada] = servidor.historico();
    expect(chamada?.abortado).toBe(false);
    expect(chamada?.respondida).toBe(true);
  });
});

describe('#510 harness — FakeLlmServer: roteiro', () => {
  it('entrega resposta válida, inválida, retryable, terminal e rate limit na ORDEM', async () => {
    servidor.roteirizar([
      { kind: 'ok', texto: 'primeira' },
      { kind: 'invalid' },
      { kind: 'error', status: 503 },
      { kind: 'terminal', status: 400 },
      { kind: 'rate_limit', retryAfterS: 2 },
    ]);

    const r1 = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    expect(r1.status).toBe(200);
    expect((await r1.json()).content[0].text).toBe('primeira');

    const r2 = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    // Estruturalmente inválida: 200 no HTTP, mas sem `content`. É o fail-closed
    // do PARSE do SUT que o cenário quer exercitar, não um erro de transporte.
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ nao_e_isso: true });

    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(503);
    expect((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(400);

    const r5 = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    expect(r5.status).toBe(429);
    expect(r5.headers.get('retry-after')).toBe('2');

    expect(servidor.historico().map((c) => c.kind)).toEqual([
      'ok',
      'invalid',
      'error',
      'terminal',
      'rate_limit',
    ]);
  });

  it('conta chamadas por turno/tentativa SEM olhar o conteúdo', async () => {
    // A issue exige contagem por `turn_id/attempt` "sem depender do conteúdo".
    // Os três corpos abaixo são diferentes de propósito; a contagem não muda.
    servidor.definirPadrao({ kind: 'ok', texto: 'x', inputTokens: 1, outputTokens: 1, delayMs: 0 });
    for (const [attempt, corpo] of [
      ['1', '{"a":1}'],
      ['1', '{"b":[1,2,3]}'],
      ['2', '{}'],
    ] as const) {
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { [CABECALHO_TURNO]: 't-conta', [CABECALHO_TENTATIVA]: attempt },
        body: corpo,
      });
    }
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { [CABECALHO_TURNO]: 't-outro', [CABECALHO_TENTATIVA]: '1' },
      body: '{}',
    });

    expect(servidor.chamadasDe('t-conta')).toBe(3);
    expect(servidor.chamadasDe('t-conta', 1)).toBe(2);
    expect(servidor.chamadasDe('t-conta', 2)).toBe(1);
    expect(servidor.chamadasDe('t-outro')).toBe(1);
    // O corpo entra como TAMANHO, nunca como texto.
    const bytes = servidor.historico().map((c) => c.bytesDeEntrada);
    expect(bytes.every((b) => b >= 0)).toBe(true);
    expect(bytes[1]).toBeGreaterThan(bytes[2] as number);
  });

  it('stream parcial entrega pedaços e PARA no meio, sem fechar', async () => {
    servidor.roteirizar([{ kind: 'stream_parcial', pedacos: 2, intervaloMs: 5 }]);
    const controle = new AbortController();
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      body: '{}',
      signal: controle.signal,
    });
    expect(r.headers.get('content-type')).toContain('text/event-stream');

    const leitor = r.body?.getReader();
    const primeiro = await leitor?.read();
    expect(new TextDecoder().decode(primeiro?.value)).toContain('content_block_delta');

    // O stream NÃO termina sozinho — é esse o ponto. Cancelamos para o teardown
    // não pendurar, e o servidor registra o aborto.
    controle.abort();
    await eventually(() => servidor.abortos().length === 1, {
      label: 'o fake registra o aborto do stream parcial',
      timeoutMs: 5_000,
    });
  });

  it('quando o roteiro esvazia, cai no padrão em vez de travar o SUT', async () => {
    servidor.roteirizar([{ kind: 'ok', texto: 'unica' }]);
    await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    expect((await r.json()).content[0].text).toBe('ok');
  });

  it('não existe caminho de saída para a internet neste fake', async () => {
    // Garantia estrutural, verificada no fonte: nenhum `fetch`, `http.request`
    // ou `https` de saída. O fake serve; ele nunca chama.
    const { readFileSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const aqui = dirname(fileURLToPath(import.meta.url));
    const fonte = readFileSync(
      resolve(join(aqui, '..', 'fakes', 'fake-llm-server.ts')),
      'utf8',
    );
    expect(fonte).not.toMatch(/\bfetch\s*\(/);
    expect(fonte).not.toMatch(/\bhttps?\.request\s*\(/);
    expect(fonte).not.toMatch(/from 'node:https'/);
  });
});
