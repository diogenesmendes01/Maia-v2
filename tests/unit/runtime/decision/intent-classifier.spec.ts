import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  IntentClassifierImpl,
  type IntentClassifierDeps,
} from '@/runtime/decision/intent-classifier.ts';
import type {
  ContentResolver,
  HaikuClient,
  MetricsClient,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'ref_123', received_at: new Date() },
  };
}

function mkDeps(content: string, overrides?: Partial<IntentClassifierDeps>): IntentClassifierDeps {
  const contentResolver: ContentResolver = {
    text: vi.fn().mockResolvedValue(content),
  };
  const haiku: HaikuClient = {
    classify: vi
      .fn()
      .mockResolvedValue({ label: 'unknown', confidence: 0.5 }),
  };
  const metrics: MetricsClient = {
    increment: vi.fn(),
    recordHistogram: vi.fn(),
  };
  return { contentResolver, haiku, metrics, ...overrides };
}

describe('P9b — IntentClassifier (rules-first + Haiku fallback)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('matches greet pattern (olá, oi, bom dia)', async () => {
    const deps = mkDeps('olá, tudo bem?');
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(intent.label).toBe('greet');
    expect(intent.confidence).toBeGreaterThan(0.9);
    expect(deps.haiku.classify).not.toHaveBeenCalled();
  });

  it('matches help_request pattern (/ajuda)', async () => {
    const deps = mkDeps('/ajuda');
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(intent.label).toBe('help_request');
    expect(intent.confidence).toBeGreaterThanOrEqual(0.99);
  });

  it('matches balance_query (qual meu saldo)', async () => {
    const deps = mkDeps('qual meu saldo agora?');
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(intent.label).toBe('balance_query');
  });

  it('matches transfer_intent (transferir R$)', async () => {
    const deps = mkDeps('quero transferir R$ 100');
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(intent.label).toBe('transfer_intent');
  });

  it('matches cancel_request', async () => {
    const deps = mkDeps('cancelar a transferência por favor');
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(intent.label).toBe('cancel_request');
  });

  it('returns unknown low confidence for short text without calling Haiku', async () => {
    const deps = mkDeps('x');
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(intent.label).toBe('unknown');
    expect(intent.confidence).toBeLessThan(0.5);
    expect(deps.haiku.classify).not.toHaveBeenCalled();
  });

  it('calls Haiku when no heuristic matches and text is non-trivial', async () => {
    const deps = mkDeps('preciso de informações sobre minha conta corrente');
    (deps.haiku.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      label: 'information_request',
      confidence: 0.78,
      top3: ['information_request', 'balance_query', 'help_request'],
    });
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(deps.haiku.classify).toHaveBeenCalledTimes(1);
    expect(intent.label).toBe('information_request');
    expect(intent.alternatives).toEqual([
      'information_request',
      'balance_query',
      'help_request',
    ]);
  });

  it('returns unknown low confidence on Haiku error', async () => {
    const deps = mkDeps('this is some long ambiguous message about life');
    (deps.haiku.classify as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('timeout'),
    );
    const c = new IntentClassifierImpl(deps);
    const intent = await c.classify(mkBase());
    expect(intent.label).toBe('unknown');
    expect(intent.confidence).toBeLessThan(0.5);
    expect(deps.metrics?.increment).toHaveBeenCalledWith(
      'intent_classifier.llm_error',
    );
  });

  it('increments llm_calls metric only when calling Haiku', async () => {
    const deps1 = mkDeps('olá!');
    const c1 = new IntentClassifierImpl(deps1);
    await c1.classify(mkBase());
    expect(deps1.metrics?.increment).not.toHaveBeenCalledWith(
      'intent_classifier.llm_calls',
    );

    const deps2 = mkDeps('algum texto sem heurística clara aqui');
    (deps2.haiku.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      label: 'feedback',
      confidence: 0.65,
    });
    const c2 = new IntentClassifierImpl(deps2);
    await c2.classify(mkBase());
    expect(deps2.metrics?.increment).toHaveBeenCalledWith(
      'intent_classifier.llm_calls',
    );
  });
});
