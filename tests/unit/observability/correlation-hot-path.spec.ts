/**
 * Issue #514 §1 — the correlation contract as observed by the HOT PATH
 * callers: the queue payload stamper and the two context builders that used
 * to mint divergent trace ids.
 */
import { describe, it, expect } from 'vitest';
import { withCorrelation } from '../../../src/gateway/job-correlation.js';
import { buildBaseContextPacketFromTurn } from '../../../src/runtime/decision/build-base-context.js';
import {
  deriveTraceId,
  runWithCorrelation,
} from '../../../src/observability/correlation.js';
import type { Mensagem, Conversa, Pessoa } from '../../../src/db/schema.js';

const MSG_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';

function turnFixture() {
  const inbound = {
    id: MSG_ID,
    tipo: 'texto',
    created_at: new Date('2026-07-01T10:00:00.000Z'),
  } as unknown as Mensagem;
  const conversa = { id: 'conv-1' } as unknown as Conversa;
  const pessoa = { id: 'pessoa-1' } as unknown as Pessoa;
  return {
    inbound,
    conversa,
    pessoa,
    tenant_id: 'acme',
    agent_id: 'a1',
    channel_id: 'ch-1',
    active_procedure_execution_id: null,
  };
}

describe('queue payload correlation stamping', () => {
  it('stamps a derived trace id and an arm timestamp', () => {
    const before = Date.now();
    const job = withCorrelation({ mensagem_id: MSG_ID });
    expect(job.mensagem_id).toBe(MSG_ID);
    expect(job.trace_id).toBe(deriveTraceId(MSG_ID));
    expect(job.enqueued_at_ms).toBeGreaterThanOrEqual(before);
  });

  it('a caller-supplied trace id WINS (recovery re-enqueue keeps the root)', () => {
    const job = withCorrelation({ mensagem_id: MSG_ID, trace_id: 'root-from-recovery' });
    expect(job.trace_id).toBe('root-from-recovery');
  });

  it('re-enqueueing the same message always lands on the same root trace', () => {
    // This is what makes "recovery preserves the root trace" free: no state to
    // carry between the crash and the sweep.
    const a = withCorrelation({ mensagem_id: MSG_ID });
    const b = withCorrelation({ mensagem_id: MSG_ID });
    expect(a.trace_id).toBe(b.trace_id);
  });

  it('carries received_at_ms through when the caller knows it', () => {
    const job = withCorrelation({ mensagem_id: MSG_ID, received_at_ms: 999 });
    expect(job.received_at_ms).toBe(999);
  });
});

describe('buildBaseContextPacketFromTurn — one trace id per turn', () => {
  it('adopts the ambient correlation trace id', async () => {
    await runWithCorrelation({ trace_id: 'root-1', turn_id: MSG_ID }, async () => {
      const packet = buildBaseContextPacketFromTurn(turnFixture());
      expect(packet.trace_id).toBe('root-1');
    });
  });

  it('falls back to the inbound row id — byte-identical to the pre-#514 behaviour', () => {
    const packet = buildBaseContextPacketFromTurn(turnFixture());
    expect(packet.trace_id).toBe(MSG_ID);
  });

  it('a retry under a new attempt keeps the SAME packet trace id', async () => {
    const seen: string[] = [];
    for (const attempt of [1, 2, 3]) {
      await runWithCorrelation(
        { seed: MSG_ID, turn_id: MSG_ID, attempt, origin: 'queue' },
        async () => {
          seen.push(buildBaseContextPacketFromTurn(turnFixture()).trace_id);
        },
      );
    }
    expect(new Set(seen).size).toBe(1);
  });

  it('does not leak the trace id across concurrent turns', async () => {
    const [a, b] = await Promise.all([
      runWithCorrelation({ trace_id: 'root-A' }, async () =>
        buildBaseContextPacketFromTurn(turnFixture()).trace_id,
      ),
      runWithCorrelation({ trace_id: 'root-B' }, async () =>
        buildBaseContextPacketFromTurn(turnFixture()).trace_id,
      ),
    ]);
    expect(a).toBe('root-A');
    expect(b).toBe('root-B');
  });
});
