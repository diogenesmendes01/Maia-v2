/**
 * Issue #504 §Contrato do job — a LEITURA DUAL e a métrica de versão acontecem
 * DENTRO do worker de produção.
 *
 * ─── Por que este arquivo existe, e por que não é de integração ─────────────
 *
 * A propriedade sob teste é "`startAgentWorker` classifica o payload e emite
 * `maia_turn_job_version_total` antes de entregar o trabalho ao processor". A
 * fila `agent` é REAL e COMPARTILHADA entre as suítes de integração, então
 * provar isso via Redis depende de qual worker (de qual processo) a BullMQ
 * escolhe para o job — e a suíte fica intermitente por um motivo que nada tem a
 * ver com a propriedade.
 *
 * Aqui só BullMQ e ioredis são stubados, e o stub serve para uma coisa:
 * CAPTURAR o handler que `startAgentWorker` constrói. O corpo executado é o de
 * produção, palavra por palavra — o parse, a métrica, a correlação e a caixa de
 * fatos. Mesmo padrão (e mesmo motivo) de
 * `tests/unit/gateway/queue-span-attribution.spec.ts`.
 *
 * O que continua sendo de integração, porque só o Redis prova:
 * `tests/integration/turn-job-v2-queue-real-redis.spec.ts` — que o PAYLOAD que
 * atravessa o transporte é `{version, turn_id}` e nada mais.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Job } from 'bullmq';
import type { ParsedAgentTurnJob } from '@/runtime/turns/job.js';

type WorkerHandler = (job: Job<unknown>) => Promise<void>;

const { capturedHandler, workerOn } = vi.hoisted(() => ({
  capturedHandler: { fn: null as WorkerHandler | null },
  workerOn: vi.fn(),
}));

vi.mock('bullmq', () => {
  class FakeQueue {
    add = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    waitUntilReady = vi.fn(async () => undefined);
  }
  class FakeWorker {
    on = workerOn;
    close = vi.fn(async () => undefined);
    constructor(_name: string, handler: WorkerHandler) {
      capturedHandler.fn = handler;
    }
  }
  return {
    Queue: FakeQueue,
    Worker: FakeWorker,
    DelayedError: class DelayedError extends Error {},
  };
});

vi.mock('ioredis', () => {
  class FakeRedis {
    status = 'ready';
    on() {
      return this;
    }
    quit = vi.fn(async () => undefined);
  }
  return { default: FakeRedis };
});

vi.mock('@/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { startAgentWorker } = await import('@/gateway/queue.js');
const { lifecycle } = await import('@/runtime/lifecycle/controller.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');
const { _resetLabelGuardForTests } = await import('@/observability/labels.js');
const { currentTraceId, tryGetCorrelation } = await import(
  '@/observability/correlation.js'
);

const TURN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MENSAGEM = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** O que o processor viu na última invocação — a saída do parse de produção. */
const seen: {
  parsed: ParsedAgentTurnJob | null;
  facts: { received_at_ms: number | null } | null;
  trace_id: string | null;
  corr_turn_id: string | null;
} = { parsed: null, facts: null, trace_id: null, corr_turn_id: null };

// UM worker é construído em todo o arquivo (`startAgentWorker` memoiza), e o
// processor só REGISTRA. Ele não decide nada: tudo que as asserções leem foi
// produzido pelo corpo de produção antes desta linha.
startAgentWorker(async (_job, parsed, facts) => {
  seen.parsed = parsed;
  seen.facts = facts;
  seen.trace_id = currentTraceId() ?? null;
  seen.corr_turn_id = tryGetCorrelation()?.turn_id ?? null;
  // Simula o consumidor V2 preenchendo a caixa depois de resolver o escopo.
  if (parsed.kind === 'v2') facts.received_at_ms = 1_700_000_000_000;
});

function job(data: unknown, id = 'job-1'): Job<unknown> {
  return { id, attemptsMade: 0, opts: { attempts: 3 }, data } as unknown as Job<unknown>;
}

async function versionSeries(): Promise<string> {
  return (await renderPrometheus())
    .split('\n')
    .filter((l) => l.startsWith('maia_turn_job_version_total'))
    .join('\n');
}

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
  lifecycle._resetForTests();
  lifecycle.transitionTo('ready');
  seen.parsed = null;
  seen.facts = null;
  seen.trace_id = null;
  seen.corr_turn_id = null;
});

describe('#504 — o worker de produção classifica o payload e mede a versão', () => {
  it('payload V2: o processor recebe `kind: v2` e a série sai com version="v2"', async () => {
    await capturedHandler.fn!(job({ version: 2, turn_id: TURN }));
    expect(seen.parsed).toEqual({ kind: 'v2', turn_id: TURN });
    expect(await versionSeries()).toContain('version="v2"');
  });

  it('payload V1: o processor recebe `kind: v1` e a série sai com version="v1"', async () => {
    await capturedHandler.fn!(job({ mensagem_id: MENSAGEM, turn_id: TURN }));
    expect(seen.parsed).toEqual({ kind: 'v1', mensagem_id: MENSAGEM, turn_id: TURN });
    expect(await versionSeries()).toContain('version="v1"');
  });

  it('payload irreconhecível é MEDIDO como `invalid` — não some em silêncio', async () => {
    // Este é o caso que obriga a métrica a viver no WORKER e não no consumidor:
    // o consumidor LANÇA num payload inválido, então uma emissão feita lá
    // dentro nunca sairia — e o critério de remoção do V1 ficaria cego
    // justamente para o payload fora de contrato.
    await capturedHandler.fn!(job({ lixo: true }, 'job-invalid'));
    expect(seen.parsed?.kind).toBe('invalid');
    expect(await versionSeries()).toContain('version="invalid"');
  });

  it('a série é atribuída pela camada de política: `system` no parse, nunca `default`', async () => {
    await capturedHandler.fn!(job({ version: 2, turn_id: TURN }));
    const texto = await versionSeries();
    expect(texto).toContain('tenant_id="system"');
    expect(texto).toContain('agent_id="system"');
    expect(texto).not.toContain('tenant_id="default"');
  });
});

describe('#504 — a correlação e os fatos do payload no worker', () => {
  it('V1: a semente do trace continua sendo `mensagem_id` (comportamento preservado)', async () => {
    await capturedHandler.fn!(job({ mensagem_id: MENSAGEM }));
    expect(seen.trace_id).toBe(MENSAGEM);
    // No V1 o `turn_id` da correlação sempre foi o id da MENSAGEM (#514).
    expect(seen.corr_turn_id).toBe(MENSAGEM);
  });

  it('V2: a janela pré-resolução usa o `turn_id`, e a correlação carrega o turno DE VERDADE', async () => {
    await capturedHandler.fn!(job({ version: 2, turn_id: TURN }));
    expect(seen.trace_id).toBe(TURN);
    expect(seen.corr_turn_id).toBe(TURN);
  });

  it('a caixa de fatos chega vazia no V2 e é o consumidor quem a preenche', async () => {
    await capturedHandler.fn!(job({ version: 2, turn_id: TURN }));
    // O processor (acima) preencheu — o que prova que a caixa é a MESMA
    // referência que `recordTurnOutcome` lê depois, e não uma cópia.
    expect(seen.facts?.received_at_ms).toBe(1_700_000_000_000);
  });

  it('a caixa de fatos já vem preenchida no V1, a partir do payload', async () => {
    await capturedHandler.fn!(job({ mensagem_id: MENSAGEM, received_at_ms: 1_234_567 }));
    expect(seen.facts?.received_at_ms).toBe(1_234_567);
  });
});

describe('#504 — o boot liga o consumidor dual ao worker', () => {
  /**
   * `src/index.ts` executa efeitos colaterais no import (sobe servidor, abre
   * sockets), então não dá para importá-lo e inspecionar o wiring. Esta é uma
   * asserção de TEXTO-FONTE, e é honesto dizer o que ela vale: ela pega a
   * REMOÇÃO acidental do wiring — alguém voltar `runAgentForMensagem` direto no
   * processor, que reintroduziria o caminho sem leitura dual — e não pega uma
   * reescrita equivalente com outro nome. É a rede mais barata para o único
   * ponto do fluxo que nenhum teste de comportamento alcança.
   */
  it('o processor registrado em `startAgentWorker` é `runAgentTurnJob`', async () => {
    const fonte = await readFile(new URL('../../../src/index.ts', import.meta.url), 'utf8');
    expect(fonte).toContain("import { runAgentTurnJob } from '@/runtime/turns/job-consumer.js'");
    expect(fonte).toMatch(/startAgentWorker\(async \(_job, parsed, facts\) => \{\s*await runAgentTurnJob\(parsed, facts\);/);
  });
});
