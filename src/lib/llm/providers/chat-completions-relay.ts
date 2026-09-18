/**
 * P06 (spec Maia+Hermes §9.1 itens 7-9) — RELAY de Chat Completions para o
 * gateway de inferência Hermes.
 *
 * Mora aqui porque é o único diretório onde o lint deixa importar o SDK de
 * provider. Não é um adapter da camada `executeLLM`: aquele escolhe o próprio
 * modelo, repete, cai para outro modelo e grava no ledger legado — tudo que o
 * §9.1 proíbe no caminho Hermes ("sem retry oculto no relay", "modelo
 * exatamente igual ao aprovado", "nenhum acesso direto ao provider" fora do
 * enforcement).
 *
 * ─── O que o relay garante ─────────────────────────────────────────────────
 *
 * UMA tentativa HTTP (`maxRetries: 0`), URL fixa da configuração, sem seguir
 * redirecionamento, sem streaming upstream (o gateway valida a resposta inteira
 * antes de expor ao filho). O corpo chega JÁ validado pelo gateway; o relay só
 * tira `stream`/`stream_options` e encaminha.
 *
 * ─── Onde falhou importa mais do que o quê ─────────────────────────────────
 *
 * `not_sent` só quando é PROVADO que nada saiu (sem credencial, corpo que o
 * SDK recusa antes do HTTP). Qualquer erro depois de a requisição poder ter
 * saído — timeout, abort, rede, 4xx, 5xx — é `failed_after_send`: o §9.1 diz
 * que "erros após envio não equivalem a custo zero", e a contabilidade trata
 * como exposição desconhecida.
 */
import OpenAI from 'openai';

export type RelayFailureCodeV1 =
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'rate_limit'
  | 'provider_4xx'
  | 'provider_5xx'
  | 'unexpected';

export type RelayOutcomeV1 =
  | { kind: 'ok'; raw: unknown }
  | { kind: 'not_sent'; code: 'configuration' | 'invalid_body' }
  | { kind: 'failed_after_send'; code: RelayFailureCodeV1 };

export interface ChatCompletionsRelayV1 {
  /** Rótulo não secreto do provider, para o ledger. */
  readonly provider: string;
  relay(
    body: Readonly<Record<string, unknown>>,
    opts: { signal: AbortSignal; timeout_ms: number },
  ): Promise<RelayOutcomeV1>;
}

function classify(err: unknown): RelayFailureCodeV1 {
  if (err instanceof OpenAI.APIUserAbortError) return 'aborted';
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof OpenAI.APIConnectionError) return 'network';
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    if (status === 429) return 'rate_limit';
    if (status === 408) return 'timeout';
    if (status >= 500) return 'provider_5xx';
    if (status >= 400) return 'provider_4xx';
  }
  return 'unexpected';
}

export function createChatCompletionsRelay(cfg: {
  provider: string;
  apiKey: string | undefined;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
}): ChatCompletionsRelayV1 {
  let client: OpenAI | null = null;
  const getClient = (): OpenAI | null => {
    if (!cfg.apiKey) return null;
    client ??= new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      maxRetries: 0,
      defaultHeaders: cfg.defaultHeaders,
      // URL fixa: um 30x não leva a credencial do provider para outro host.
      fetchOptions: { redirect: 'error' },
    });
    return client;
  };

  return {
    provider: cfg.provider,
    async relay(body, opts): Promise<RelayOutcomeV1> {
      const c = getClient();
      if (!c) return { kind: 'not_sent', code: 'configuration' };
      if (opts.signal.aborted) return { kind: 'not_sent', code: 'invalid_body' };
      const { stream: _stream, stream_options: _opts, ...rest } = body;
      void _stream;
      void _opts;
      const params = {
        ...rest,
        stream: false,
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
      // O `timeout` do SDK só vale até os cabeçalhos; um corpo que chega aos
      // poucos passaria do prazo do run. O prazo entra no SINAL, que também
      // corta a leitura do corpo.
      const prazo = AbortSignal.timeout(Math.max(1, opts.timeout_ms));
      const signal = AbortSignal.any([opts.signal, prazo]);
      try {
        const raw = await c.chat.completions.create(params, {
          signal,
          timeout: Math.max(1, opts.timeout_ms),
          maxRetries: 0,
        });
        return { kind: 'ok', raw };
      } catch (err) {
        if (opts.signal.aborted) return { kind: 'failed_after_send', code: 'aborted' };
        if (prazo.aborted) return { kind: 'failed_after_send', code: 'timeout' };
        return { kind: 'failed_after_send', code: classify(err) };
      }
    },
  };
}
