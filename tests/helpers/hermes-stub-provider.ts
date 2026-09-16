/**
 * P00.4 (spec §11.3.2) — PROVIDER **STUB** compatível com Chat Completions.
 *
 * ─── O que este arquivo é, e o que ele NUNCA pode ser apresentado como ──────
 *
 * É um servidor HTTP local que responde no formato de Chat Completions com
 * conteúdo ROTEIRIZADO pelo teste. Ele existe para exercitar o motor REAL do
 * Hermes (loop, registry, cancelamento, compressão) de forma determinística e
 * sem chamada paga.
 *
 * Ele **não é um modelo**. Nenhum resultado obtido com ele pode ser reportado
 * como “resposta do provedor real” (spec §11.3.2 exige identificar
 * explicitamente o que é stub). O gate de provider real continua pendente de
 * orçamento aprovado (decisão D02).
 *
 * ─── Por que ele também é um INSTRUMENTO DE MEDIÇÃO ────────────────────────
 *
 * A pendência D09 da spec é “formato efetivo do request SDK/auxiliares”. Este
 * stub registra cada requisição recebida — corpo inteiro, cabeçalhos filtrados,
 * caminho — e é assim que se descobre, com evidência, quais campos o cliente
 * pinado realmente envia (`max_tokens` vs `max_completion_tokens`,
 * `stream_options`, `tool_choice`, extras) e qual é a superfície de ferramentas
 * EFETIVAMENTE enviada ao provedor (gate T53: igualdade exata com o manifest,
 * não subconjunto).
 *
 * Suporta streaming (o cliente do Hermes streama por default) e resposta única.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Uma resposta roteirizada. O teste enfileira uma por chamada esperada. */
export type StubScriptedTurn =
  | { kind: 'text'; content: string; finish_reason?: 'stop' | 'length' }
  | {
      kind: 'tool_calls';
      calls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
    }
  | { kind: 'error'; status: number; body: Record<string, unknown> };

export type StubRequestRecord = {
  path: string;
  method: string;
  /** Cabeçalhos relevantes, com Authorization REDIGIDO. */
  headers: Record<string, string>;
  /** Corpo tal como chegou (JSON já parseado). */
  body: Record<string, unknown>;
  /** Nomes de ferramentas oferecidos nesta chamada, na ordem enviada. */
  toolNames: string[];
  received_at_ms: number;
};

export type StubProvider = {
  /** Base URL para o cliente (sem barra final), ex.: `http://127.0.0.1:53123/v1`. */
  baseUrl: string;
  port: number;
  /** Requisições recebidas, em ordem. */
  requests: StubRequestRecord[];
  /** Enfileira mais respostas roteirizadas. */
  enqueue(...turns: StubScriptedTurn[]): void;
  /** Quantas respostas ainda não foram consumidas. */
  pending(): number;
  close(): Promise<void>;
};

const MODEL_ID = 'maia-stub-model';

function redactHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') continue;
    // A chave de inferência NUNCA é registrada: a evidência que interessa é que
    // ela CHEGOU, não o valor dela (§8.6.1 proíbe segredo em trilha).
    out[k] = k.toLowerCase() === 'authorization' ? '<redigido>' : v;
  }
  return out;
}

function toolNamesOf(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  const nomes: string[] = [];
  for (const t of tools) {
    const fn = (t as { function?: { name?: unknown } }).function;
    if (fn && typeof fn.name === 'string') nomes.push(fn.name);
  }
  return nomes;
}

function chatCompletionBody(turn: StubScriptedTurn, id: string): Record<string, unknown> {
  const base = {
    id,
    object: 'chat.completion',
    created: 1_760_000_000,
    model: MODEL_ID,
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
  if (turn.kind === 'text') {
    return {
      ...base,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: turn.content },
          finish_reason: turn.finish_reason ?? 'stop',
        },
      ],
    };
  }
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: turn.calls.map((c, i) => ({
            id: c.id ?? `call_stub_${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

/** Mesma resposta, em SSE — o formato que o cliente pinado usa por default. */
function streamChunks(turn: StubScriptedTurn, id: string): string[] {
  const head = { id, object: 'chat.completion.chunk', created: 1_760_000_000, model: MODEL_ID };
  const linhas: string[] = [];
  const push = (delta: Record<string, unknown>, finish: string | null): void => {
    linhas.push(
      `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  };
  if (turn.kind === 'text') {
    push({ role: 'assistant' }, null);
    push({ content: turn.content }, null);
    push({}, turn.finish_reason ?? 'stop');
  } else if (turn.kind === 'tool_calls') {
    push({ role: 'assistant' }, null);
    turn.calls.forEach((c, i) => {
      push(
        {
          tool_calls: [
            {
              index: i,
              id: c.id ?? `call_stub_${i}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            },
          ],
        },
        null,
      );
    });
    push({}, 'tool_calls');
  }
  // `include_usage` costuma vir em `stream_options`; mandar sempre é inofensivo
  // e dá material para o ledger de custo do gateway (§9.2) ser exercitado.
  linhas.push(
    `data: ${JSON.stringify({ ...head, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`,
  );
  linhas.push('data: [DONE]\n\n');
  return linhas;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const partes: Buffer[] = [];
  for await (const c of req) partes.push(c as Buffer);
  if (partes.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { __unparsed__: true };
  }
}

/**
 * Sobe o stub em `127.0.0.1` numa porta efêmera. Só escuta em loopback: este
 * processo não abre superfície de rede.
 */
export async function startStubProvider(opts: {
  script?: StubScriptedTurn[];
  /** Falha explicitamente quando o roteiro acaba, em vez de improvisar texto. */
  onExhausted?: 'error' | 'empty_text';
} = {}): Promise<StubProvider> {
  const fila: StubScriptedTurn[] = [...(opts.script ?? [])];
  const requests: StubRequestRecord[] = [];
  let contador = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = req.url ?? '/';
      const body = req.method === 'POST' ? await readBody(req) : {};
      requests.push({
        path: url,
        method: req.method ?? 'GET',
        headers: redactHeaders(req.headers),
        body,
        toolNames: toolNamesOf(body),
        received_at_ms: requests.length, // ordem, não relógio: mantém o teste determinístico
      });

      if (url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: MODEL_ID, object: 'model', owned_by: 'maia-stub' }],
          }),
        );
        return;
      }

      if (!url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `rota não suportada pelo stub: ${url}` } }));
        return;
      }

      const turn = fila.shift();
      if (!turn) {
        if ((opts.onExhausted ?? 'error') === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message:
                  'roteiro do stub esgotado: o motor pediu mais inferências do que o teste previu',
                type: 'stub_script_exhausted',
              },
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(chatCompletionBody({ kind: 'text', content: '' }, 'stub_empty')));
        return;
      }

      if (turn.kind === 'error') {
        res.writeHead(turn.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(turn.body));
        return;
      }

      const id = `stub_${++contador}`;
      if (body.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for (const linha of streamChunks(turn, id)) res.write(linha);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chatCompletionBody(turn, id)));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    enqueue: (...turns: StubScriptedTurn[]) => fila.push(...turns),
    pending: () => fila.length,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
