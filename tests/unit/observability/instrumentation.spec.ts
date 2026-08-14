import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #535 §2 — tool dispatch and context load.
 *
 * The load-bearing case is `classifyToolResult`. `dispatchTool` signals
 * governance denials by RETURNING `{ error }`, not by throwing, so a wrapper
 * that only catches would record every blocked tool as a success — and the
 * tool-error SLI would read 0% while the agent could not act at all.
 */
import {
  classifyToolResult,
  instrumentContextLoad,
  instrumentToolDispatch,
} from '../../../src/observability/instrumentation.js';
import {
  CONTEXT_LOAD_STAGE,
  CONTEXT_LOAD_STAGE_VALUES,
} from '../../../src/observability/taxonomy.js';
import { _resetForTests, renderPrometheus } from '../../../src/lib/metrics.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
});

describe('issue #535 — tool dispatch classification', () => {
  it('treats a plain value as success', () => {
    expect(classifyToolResult({ saldo: 100 })).toBe('ok');
    expect(classifyToolResult('texto')).toBe('ok');
    expect(classifyToolResult(null)).toBe('ok');
  });

  it.each(['forbidden', 'tool_not_granted', 'tool_disabled', 'no_entity_in_scope'])(
    'classifies %s as BLOCKED, not error',
    (error) => {
      // Governance refusing is the platform working. Folding it into `error`
      // would make a mis-scoped grant look like an outage — and would make the
      // real error rate unreadable underneath it.
      expect(classifyToolResult({ error })).toBe('blocked');
    },
  );

  it.each([
    'feature_disabled',
    'redis_unavailable_blocked',
    'approval_pending',
    'requires_confirmation',
    'requires_dual_approval',
    'mcp_tool_not_executable',
  ])('classifies the fail-closed refusal %s as BLOCKED, not error', (error) => {
    // These six were the actual defect: the dispatcher and the MCP bridge
    // return them for governance working exactly as designed, and every one of
    // them landed in the default `error` bucket — i.e. inside the numerator of
    // `MaiaToolErrorRateHigh`. The exhaustive proof that no seventh one is
    // hiding lives in `tool-error-codes.spec.ts`.
    expect(classifyToolResult({ error })).toBe('blocked');
  });

  it('classifies invalid_args separately from a broken tool', () => {
    // `invalid` tracks MODEL quality (it produced args Zod rejected); `error`
    // tracks OUR code. They move for opposite reasons.
    expect(classifyToolResult({ error: 'invalid_args' })).toBe('invalid');
    // Same axis: a hallucinated tool name is a malformed CALL, not an outage.
    expect(classifyToolResult({ error: 'unknown_tool' })).toBe('invalid');
  });

  it('keeps genuine operational failures in error', () => {
    expect(classifyToolResult({ error: 'execution_failed' })).toBe('error');
    expect(classifyToolResult({ error: 'mcp_call_failed' })).toBe('error');
    expect(classifyToolResult({ error: 'idempotency_payload_hash_collision' })).toBe('error');
  });

  it('classifies an unknown error string as error', () => {
    expect(classifyToolResult({ error: 'db_timeout' })).toBe('error');
  });

  it('ignores a non-string `error` field', () => {
    expect(classifyToolResult({ error: null })).toBe('ok');
    expect(classifyToolResult({ error: 0 })).toBe('ok');
  });
});

describe('issue #535 — instrumentToolDispatch', () => {
  it('returns the wrapped value untouched', async () => {
    await expect(instrumentToolDispatch('listar', async () => ({ ok: 1 }))).resolves.toEqual(
      { ok: 1 },
    );
  });

  it('emits counter + histogram with the tool and the outcome', async () => {
    await instrumentToolDispatch('listar_lancamentos', async () => ({ rows: [] }));
    const metrics = await renderPrometheus();
    expect(metrics).toMatch(/maia_tool_dispatch_total\{.*result="ok".*tool="listar_lancamentos"/);
    expect(metrics).toMatch(/maia_tool_duration_ms_count\{.*tool="listar_lancamentos"/);
  });

  it('records a RETURNED denial as blocked', async () => {
    await instrumentToolDispatch('criar_lancamento', async () => ({
      error: 'tool_not_granted',
    }));
    expect(await renderPrometheus()).toMatch(/maia_tool_dispatch_total\{.*result="blocked"/);
  });

  it('keeps a pending approval OUT of the error SLI series', async () => {
    // End to end through the metric, not just the classifier: a queue of
    // approvals waiting on humans must not appear in
    // `maia:tool_error_ratio:rate5m` (monitoring/alerts/slo.rules.yml).
    await instrumentToolDispatch('criar_lancamento', async () => ({
      error: 'approval_pending',
      details: { ref: 'AP-12345678' },
    }));
    const metrics = await renderPrometheus();
    expect(metrics).toMatch(/maia_tool_dispatch_total\{.*result="blocked"/);
    expect(metrics).not.toMatch(/maia_tool_dispatch_total\{.*result="error"/);
  });

  it('records a THROWN failure as error and rethrows', async () => {
    const boom = new Error('db down');
    await expect(
      instrumentToolDispatch('criar_lancamento', async () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    expect(await renderPrometheus()).toMatch(/maia_tool_dispatch_total\{.*result="error"/);
  });

  it('never lets a tool name become an unbounded label', async () => {
    // `tool` is budgeted at 200 distinct values; a bug that passes user input
    // as a tool name must degrade into `__overflow__`, not mint series.
    for (let i = 0; i < 260; i++) {
      await instrumentToolDispatch(`tool_${i}`, async () => 1);
    }
    const metrics = await renderPrometheus();
    expect(metrics).toContain('tool="__overflow__"');
    const distinct = new Set(
      [...metrics.matchAll(/maia_tool_dispatch_total\{[^}]*tool="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(distinct.size).toBeLessThanOrEqual(201);
  });

  it('sanitizes a tool name that looks like PII', async () => {
    await instrumentToolDispatch('5511987654321@s.whatsapp.net', async () => 1);
    const metrics = await renderPrometheus();
    expect(metrics).not.toContain('whatsapp.net');
    expect(metrics).toContain('tool="__sanitized__"');
  });
});

/**
 * Review da PR #554 — `instrumentContextLoad` emite SPAN e mais nada.
 *
 * Os dois casos que viviam aqui asseriam `maia_context_load_ms` e
 * `maia_context_slices_total`. As duas famílias foram aposentadas: a operação
 * embrulhada é `loadTurnContext`, que já publica duração e round-trips por
 * `recordTurnContextLoad` (`maia_turn_context_*`, #525). Duas famílias para uma
 * operação é a divergência que a taxonomia existe para impedir.
 *
 * O que sobrou tem que ser assertado pelo NEGATIVO — "nenhuma métrica nova" é
 * uma decisão de contrato, e contrato sem teste volta na primeira refatoração
 * que "aproveita que já estamos medindo aqui".
 *
 * A prova de que o span sai no caminho de produção NÃO está aqui: está em
 * `tests/integration/context-load-span-hot-path.spec.ts`, que entra pelo
 * `runAgentForMensagem`. Um spec que chama o wrapper direto passa com o call
 * site de produção apagado — foi exatamente esse buraco que a review pegou.
 */
describe('review da PR #554 — instrumentContextLoad é span-only', () => {
  it('não emite NENHUMA métrica — nem a família aposentada, nem outra', async () => {
    await instrumentContextLoad(CONTEXT_LOAD_STAGE.TURN_CONTEXT, async () => 'snapshot');
    const metrics = await renderPrometheus();
    expect(metrics).not.toContain('maia_context_load_ms');
    expect(metrics).not.toContain('maia_context_slices_total');
    // E nada foi só renomeado: o registry inteiro fica sem qualquer série
    // carregando o `stage` desta carga.
    expect(metrics).not.toContain('stage="turn_context"');
  });

  it('propaga o valor e relança o erro sem tocar em nenhuma série', async () => {
    expect(await instrumentContextLoad(CONTEXT_LOAD_STAGE.TURN_CONTEXT, async () => 42)).toBe(42);
    const boom = new Error('x');
    await expect(
      instrumentContextLoad(CONTEXT_LOAD_STAGE.TURN_CONTEXT, async () => Promise.reject(boom)),
      // Mesma INSTÂNCIA: o caminho fail-closed do turno ramifica no erro.
    ).rejects.toBe(boom);
    expect(await renderPrometheus()).not.toContain('maia_context');
  });

  /**
   * O `stage` TIPADO foi achado Medium da review da PR #554 e não pode
   * regredir para `stage: string`. Não dá para pinar isso com `@ts-expect-error`
   * num spec: `tsconfig.json` exclui `tests/`, então `npm run typecheck` nunca
   * olharia para o arquivo e a guarda seria decorativa.
   *
   * Então a guarda lê a ASSINATURA no fonte — mesmo padrão de
   * `tests/unit/config/no-direct-env-reads.spec.ts`, que confere no texto uma
   * regra que o compilador sozinho não cobra. Afrouxar o parâmetro devolveria a
   * fechadura do vocabulário ao regime de "ninguém erra", que não é controle.
   */
  it('mantém o parâmetro `stage` TIPADO — `string` reabriria o vocabulário', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../src/observability/instrumentation.ts'),
      'utf8',
    );
    const signature = /export async function instrumentContextLoad<T>\(\s*stage:\s*([A-Za-z]+)/.exec(
      src,
    );
    expect(signature, 'assinatura de instrumentContextLoad não encontrada').not.toBeNull();
    expect(signature![1]).toBe('ContextLoadStage');
  });

  it('o vocabulário fechado tem exatamente o stage da carga do turno', () => {
    // Um membro sem emissor é a falha "declarado lê como coberto" que a #535
    // abre. `packet` saiu junto com a instrumentação da montagem P8a.
    expect([...CONTEXT_LOAD_STAGE_VALUES]).toEqual([CONTEXT_LOAD_STAGE.TURN_CONTEXT]);
  });
});
