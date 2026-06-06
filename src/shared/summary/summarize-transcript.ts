/**
 * Issue #433 — `summarizeTranscript`: the SINGLE shared transcript-summarizer.
 *
 * BEFORE: the only summarization lived INLINE in the cron worker
 * (`src/workers/conversation-summarizer.ts`) — it built a transcript and called
 * the LLM for a prose summary, with no reusable entry point. A tool that wanted
 * to summarize would have had to duplicate the prompt + transcript formatting,
 * which this repo explicitly warns against (drift).
 *
 * AFTER: this module owns the transcript formatting + the LLM call + output
 * parsing. BOTH callers reuse it:
 *   - `src/workers/conversation-summarizer.ts` (refactored to call this; it uses
 *     only `.summary`, so its observable behavior — closing a stale conversation
 *     with a prose summary — is unchanged).
 *   - `conversation_summary_compose` (baseline.core tool, this issue) — wraps it.
 *   - `conversation_summary_generate` (sibling #431) will wrap it too.
 *
 * NOT prompt-identical, but behavior-preserving at the worker's CONTRACT: the
 * extraction switched the prompt to ask for STRICT JSON (and `max_tokens: 700`,
 * up from the worker's prior prose call) so the tools get structured fields. The
 * worker still consumes ONLY `.summary` — a ≤500-char prose string used to close
 * the conversa — and the JSON→prose fallback in `parseSummaryResponse` keeps that
 * summary populated even when the model returns prose. So the observable output
 * the worker stores is preserved; the underlying prompt/token budget is not
 * byte-for-byte the previous inline call.
 *
 * Domain-neutral by contract: it takes a minimal `{ direcao, conteudo }` message
 * shape (NOT a full `Mensagem`/DB row), no `ctx`, no repos — so any caller can
 * satisfy it. The cognitive-module instrumentation params are passed through so
 * the worker keeps the SAME `cognitive_module_log` row it emitted before.
 *
 * Output contract (issue #433): `{ summary, open_questions, decisions,
 * pending_actions }`. The LLM is asked for STRICT JSON; if it returns prose
 * instead (or the JSON is malformed), we FALL BACK to a summary-only result with
 * the raw text as `summary` and empty lists — preserving the worker's original
 * "a prose summary string is enough" behavior, never throwing on a soft LLM
 * failure.
 */
import { callLLM, type LLMResponse } from '@/lib/claude.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { logger } from '@/lib/logger.js';

/**
 * Minimal message shape the summarizer needs. A DB `Mensagem` row satisfies it
 * structurally (it has `direcao` + `conteudo`), but so does any caller-built
 * object — keeping the helper free of a DB-type dependency.
 */
export interface TranscriptMessage {
  /** 'in' = from the user, anything else = from the agent. */
  direcao: string;
  /** The textual content; null for media-only messages. */
  conteudo: string | null;
}

export interface SummarizeTranscriptOptions {
  /**
   * What the summary is FOR (steers the prompt). Defaults to the worker's
   * historical intent: decisions, facts, and pending items.
   */
  purpose?: string;
  /**
   * Hard cap on the `summary` string length (characters). Default 500 — the
   * exact bound the worker used before extraction (`.slice(0, 500)`).
   */
  maxChars?: number;
  /**
   * Cognitive-module instrumentation. The worker passes its original values so
   * the `cognitive_module_log` row is byte-for-byte the same as before.
   */
  module?: {
    name?: string;
    triggered_by?: 'sync_required' | 'sync_conditional' | 'async_event';
    timeoutMs?: number;
    conversa_id?: string;
  };
  /**
   * Per-pessoa cost attribution forwarded to `callLLM` (optional). Workers
   * outside any pessoa context leave it undefined.
   */
  pessoa_id?: string;
  /**
   * Test seam: override the raw LLM call. Defaults to `callLLM`. Lets unit tests
   * assert the helper is invoked WITHOUT hitting Anthropic, and lets the tool's
   * test stub a deterministic JSON response.
   */
  llmCall?: typeof callLLM;
}

export interface TranscriptSummary {
  /** A concise prose summary, capped at `maxChars`. */
  summary: string;
  /** Questions left open / unresolved in the conversation. */
  open_questions: string[];
  /** Decisions that were reached. */
  decisions: string[];
  /** Actions still pending / promised but not done. */
  pending_actions: string[];
}

const DEFAULT_PURPOSE =
  'decisões tomadas, fatos relevantes e pendências em aberto';
const DEFAULT_MAX_CHARS = 500;

/**
 * Render a `{ direcao, conteudo }[]` list into a `Usuário:`/`Maia:` transcript —
 * the SAME rendering the worker used inline (media-only messages become
 * `[mídia]`). Exported for reuse/testing by composing callers (#431).
 */
export function renderTranscript(messages: ReadonlyArray<TranscriptMessage>): string {
  return messages
    .map((m) => `${m.direcao === 'in' ? 'Usuário' : 'Maia'}: ${m.conteudo ?? '[mídia]'}`)
    .join('\n');
}

const EMPTY_SUMMARY: TranscriptSummary = {
  summary: '',
  open_questions: [],
  decisions: [],
  pending_actions: [],
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * Parse the LLM response into the structured contract. Tolerant: extracts the
 * first JSON object if the model wrapped it in prose; on ANY failure falls back
 * to treating the whole text as the `summary` (the worker's prior behavior).
 */
function parseSummaryResponse(raw: string, maxChars: number): TranscriptSummary {
  const text = raw.trim();
  if (text.length === 0) return { ...EMPTY_SUMMARY };

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as Record<string, unknown>;
      const summary = typeof obj.summary === 'string' ? obj.summary : '';
      // Only accept the JSON shape if it actually carried a summary string;
      // otherwise fall through to the prose fallback below.
      if (summary.trim().length > 0) {
        return {
          summary: summary.slice(0, maxChars),
          open_questions: asStringArray(obj.open_questions),
          decisions: asStringArray(obj.decisions),
          pending_actions: asStringArray(obj.pending_actions),
        };
      }
    } catch {
      // Malformed JSON → prose fallback.
    }
  }
  // Prose fallback: no parseable JSON. Keep the worker's "summary string is
  // enough" contract — store the (capped) prose, no structured fields.
  return { ...EMPTY_SUMMARY, summary: text.slice(0, maxChars) };
}

/**
 * Summarize a transcript into `{ summary, open_questions, decisions,
 * pending_actions }`. Empty input short-circuits to an empty result (no LLM
 * call). Wrapped in `runCognitiveModule` so latency/status are logged exactly as
 * the worker logged them; an LLM failure (timeout/null) yields the empty result
 * rather than throwing.
 */
export async function summarizeTranscript(
  messages: ReadonlyArray<TranscriptMessage>,
  opts: SummarizeTranscriptOptions = {},
): Promise<TranscriptSummary> {
  const transcript = renderTranscript(messages);
  if (transcript.trim().length === 0) {
    return { ...EMPTY_SUMMARY };
  }

  const purpose = opts.purpose ?? DEFAULT_PURPOSE;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const llmCall = opts.llmCall ?? callLLM;

  const system = [
    'Você é a Maia. Resuma a conversa abaixo em português, com foco em',
    `${purpose}.`,
    `O campo "summary" deve ter no máximo ${maxChars} caracteres. Não invente`,
    'informação que não esteja na conversa. Devolva JSON ESTRITO no formato:',
    '{"summary": "<resumo>", "open_questions": ["..."], "decisions": ["..."],',
    '"pending_actions": ["..."]}. Listas vazias quando não houver itens.',
  ].join(' ');

  const result = await runCognitiveModule<LLMResponse | null>(
    {
      name: opts.module?.name ?? 'conversation-summarizer',
      triggered_by: opts.module?.triggered_by ?? 'async_event',
      timeoutMs: opts.module?.timeoutMs ?? 30000,
      conversa_id: opts.module?.conversa_id,
      fallback: null,
    },
    () =>
      llmCall({
        system,
        messages: [{ role: 'user', content: transcript }],
        max_tokens: 700,
        temperature: 0.0,
        pessoa_id: opts.pessoa_id,
      }),
  );

  const res = result.output;
  if (!res) {
    logger.warn(
      { conversa_id: opts.module?.conversa_id, status: result.status },
      'summarize_transcript.llm_failed',
    );
    return { ...EMPTY_SUMMARY };
  }

  return parseSummaryResponse(res.content ?? '', maxChars);
}
