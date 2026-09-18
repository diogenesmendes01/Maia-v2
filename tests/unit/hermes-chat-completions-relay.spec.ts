/**
 * P06 — relay de Chat Completions: UMA tentativa, sem streaming upstream, sem
 * seguir redirecionamento, e "onde falhou" classificado de forma conservadora.
 * Roda contra servidores HTTP locais de verdade, com o SDK real.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatCompletionsRelay } from '@/lib/llm/providers/chat-completions-relay.js';
import { startStubProvider, type StubProvider } from '../helpers/hermes-stub-provider.js';

const stubs: StubProvider[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

const BODY = {
  model: 'maia-stub-model',
  messages: [{ role: 'user', content: 'oi' }],
  max_tokens: 64,
  stream: true,
  stream_options: { include_usage: true },
};

const opts = () => ({ signal: new AbortController().signal, timeout_ms: 2_000 });

async function server(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`;
}

describe('createChatCompletionsRelay', () => {
  it('sem credencial: not_sent, nada sai', async () => {
    const relay = createChatCompletionsRelay({
      provider: 'x',
      apiKey: undefined,
      baseURL: 'http://127.0.0.1:9/v1',
    });
    expect(await relay.relay(BODY, opts())).toEqual({ kind: 'not_sent', code: 'configuration' });
  });

  it('encaminha sem streaming e devolve a resposta crua', async () => {
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'olá' }] });
    stubs.push(stub);
    const relay = createChatCompletionsRelay({ provider: 'x', apiKey: 'k', baseURL: stub.baseUrl });
    const out = await relay.relay(BODY, opts());
    expect(out.kind).toBe('ok');
    const req = stub.requests.find((r) => r.path.endsWith('/chat/completions'))!;
    expect(req.body.stream).toBe(false);
    expect(req.body).not.toHaveProperty('stream_options');
    expect(req.body.model).toBe('maia-stub-model');
    expect(req.headers.authorization).toBe('<redigido>');
    if (out.kind === 'ok') {
      expect((out.raw as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('olá');
    }
  });

  it('5xx é failed_after_send, com UMA tentativa só', async () => {
    const stub = await startStubProvider({
      script: [{ kind: 'error', status: 500, body: { error: { message: 'x' } } }],
    });
    stubs.push(stub);
    const relay = createChatCompletionsRelay({ provider: 'x', apiKey: 'k', baseURL: stub.baseUrl });
    expect(await relay.relay(BODY, opts())).toEqual({
      kind: 'failed_after_send',
      code: 'provider_5xx',
    });
    expect(stub.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(1);
  });

  it('429 e 4xx também são depois do envio (custo não é zero por suposição)', async () => {
    const stub = await startStubProvider({
      script: [
        { kind: 'error', status: 429, body: { error: { message: 'x' } } },
        { kind: 'error', status: 400, body: { error: { message: 'x' } } },
      ],
    });
    stubs.push(stub);
    const relay = createChatCompletionsRelay({ provider: 'x', apiKey: 'k', baseURL: stub.baseUrl });
    expect(await relay.relay(BODY, opts())).toEqual({ kind: 'failed_after_send', code: 'rate_limit' });
    expect(await relay.relay(BODY, opts())).toEqual({
      kind: 'failed_after_send',
      code: 'provider_4xx',
    });
  });

  it('timeout é failed_after_send', async () => {
    const baseURL = await server(() => {
      /* nunca responde */
    });
    const relay = createChatCompletionsRelay({ provider: 'x', apiKey: 'k', baseURL });
    const out = await relay.relay(BODY, { signal: new AbortController().signal, timeout_ms: 200 });
    expect(out).toEqual({ kind: 'failed_after_send', code: 'timeout' });
  });

  it('prazo vale também para o CORPO: cabeçalho cedo e corpo aos poucos não passam do prazo', async () => {
    const baseURL = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const t = setInterval(() => res.write(' '), 100);
      setTimeout(() => {
        clearInterval(t);
        res.end('{}');
      }, 3_000);
    });
    const relay = createChatCompletionsRelay({ provider: 'x', apiKey: 'k', baseURL });
    const t0 = Date.now();
    const out = await relay.relay(BODY, { signal: new AbortController().signal, timeout_ms: 400 });
    expect(out).toEqual({ kind: 'failed_after_send', code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('abort do chamador durante o envio é failed_after_send', async () => {
    const baseURL = await server(() => undefined);
    const relay = createChatCompletionsRelay({ provider: 'x', apiKey: 'k', baseURL });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    expect(await relay.relay(BODY, { signal: ac.signal, timeout_ms: 5_000 })).toEqual({
      kind: 'failed_after_send',
      code: 'aborted',
    });
  });

  it('redirecionamento não é seguido: a credencial não vai para outro host', async () => {
    let chegouNoDestino = false;
    const destino = await server((_req, res) => {
      chegouNoDestino = true;
      res.end('{}');
    });
    const origem = await server((_req, res) => {
      res.writeHead(307, { location: `${destino}/chat/completions` });
      res.end();
    });
    const relay = createChatCompletionsRelay({ provider: 'x', apiKey: 'k', baseURL: origem });
    const out = await relay.relay(BODY, opts());
    expect(out.kind).toBe('failed_after_send');
    expect(chegouNoDestino).toBe(false);
  });
});
