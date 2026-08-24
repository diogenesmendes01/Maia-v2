/**
 * Issue #505 — a fronteira fail-closed ancorada no CALL SITE DE PRODUÇÃO.
 *
 * ─── Por que este arquivo existe, e por que ele não é o teste puro ─────────
 *
 * `tests/unit/runtime/stream-key-canonical.spec.ts` prova que
 * `deriveStreamKey` recusa entrada incompleta. Isso é necessário e NÃO é
 * suficiente: uma função que recusa muito bem, mas que ninguém chama, deixa o
 * ingresso passando. A ARMADILHA DO ESPELHO é exatamente essa — um teste que
 * reconstrói o caminho com o próprio harness continua verde depois de alguém
 * deletar o caminho real.
 *
 * Este arquivo entra por `mensagensRepo.createInbound`, que é a ÚNICA porta de
 * produção por onde um inbound chega ao banco (`src/gateway/baileys.ts:1080`).
 * O que ele prova:
 *
 *   1. identidade irresolúvel ⇒ `StreamIdentityUnresolvedError` E NENHUM
 *      INSERT. A ausência do INSERT é a metade que importa: recusar depois de
 *      persistir seria fail-open com log bonito.
 *   2. a recusa é AUDITADA (`stream_ingress_rejected`) e medida;
 *   3. identidade resolvível ⇒ a mensagem é persistida COM `stream_key`,
 *      `stream_key_version` e `ingress_seq`, e a sequência é alocada DENTRO da
 *      mesma transação do INSERT;
 *   4. a dedup precede a alocação: uma reentrega detectada pelo pre-check nem
 *      abre transação, então não toca o contador.
 *
 * O `db` é substituído por um dublê que REGISTRA o que a produção mandou
 * escrever — ele não decide nada. Toda a lógica sob teste (derivação, recusa,
 * ordem das operações, montagem da row) é o código real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTableName, is, Param, SQL, StringChunk, Table } from 'drizzle-orm';
import { runWithTenantContext } from '@/db/tenant-context.js';

const auditMock = vi.fn().mockResolvedValue(undefined);
const counterMock = vi.fn();

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/observability/metrics.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, counter: counterMock };
});
vi.mock('@/config/env.js', () => ({
  config: { FEATURE_TURN_STREAM_KEY: true, FEATURE_TURN_STATE_MACHINE: false },
}));

/** Tudo o que a produção mandou o banco fazer, em ordem. */
type Operacao =
  | { kind: 'insert'; table: string; values: Record<string, unknown> }
  | { kind: 'execute'; sql: string; params: readonly unknown[] };

const operacoes: Operacao[] = [];
/** Próxima linha que o `select()` de dedup deve devolver (`[]` = não existe). */
let dedupRows: unknown[] = [];
/** `last_ingress_seq` que o UPSERT do contador devolve. */
let proximaSeq = 1;

function nomeDaTabela(table: unknown): string {
  try {
    return getTableName(table as never);
  } catch {
    return 'desconhecida';
  }
}

/**
 * Renderiza o `SQL` do drizzle em texto + parâmetros.
 *
 * NÃO é um dialeto: só percorre os `queryChunks` que a produção montou, para
 * que a asserção possa olhar o SQL REAL (nome de tabela, predicado de
 * conflito) em vez de confiar num objeto opaco.
 */
function renderSql(query: unknown): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const partes: string[] = [];
  const visita = (node: unknown): void => {
    if (is(node, StringChunk)) {
      partes.push((node as unknown as { value: string[] }).value.join(''));
      return;
    }
    if (is(node, Table)) {
      partes.push(getTableName(node as never));
      return;
    }
    if (is(node, Param)) {
      params.push((node as unknown as { value: unknown }).value);
      partes.push(`$${params.length}`);
      return;
    }
    if (is(node, SQL)) {
      for (const filho of (node as unknown as { queryChunks: unknown[] }).queryChunks) {
        visita(filho);
      }
      return;
    }
    // Valor JS cru interpolado no template (o drizzle só o embrulha em `Param`
    // quando o autor pede `sql.param`). Vira parâmetro aqui para que a
    // asserção possa olhar os VALORES ligados, não só o texto.
    params.push(node);
    partes.push(`$${params.length}`);
  };
  visita(query);
  return { sql: partes.join(''), params };
}

function fakeInsert(table: unknown) {
  const nome = nomeDaTabela(table);
  const chain = {
    values(v: Record<string, unknown>) {
      operacoes.push({ kind: 'insert', table: nome, values: v });
      return chain;
    },
    onConflictDoNothing() {
      return chain;
    },
    returning() {
      const ultima = operacoes.at(-1);
      const values = ultima && ultima.kind === 'insert' ? ultima.values : {};
      return Promise.resolve([{ id: 'row-id', state_version: 0, attempt_count: 0, ...values }]);
    },
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve([]).then(resolve);
    },
  };
  return chain;
}

function fakeSelect() {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(dedupRows),
  };
  return chain;
}

const fakeDb = {
  insert: fakeInsert,
  select: fakeSelect,
  execute: (query: unknown) => {
    // O único `execute` que este caminho dispara é o UPSERT do contador.
    const { sql, params } = renderSql(query);
    operacoes.push({ kind: 'execute', sql, params });
    return Promise.resolve({ rows: [{ last_ingress_seq: proximaSeq }] });
  },
};

vi.mock('@/db/client.js', () => ({
  db: fakeDb,
  withTx: (fn: (tx: unknown) => unknown) => fn(fakeDb),
  pgErrorCode: (err: unknown) => (err as { code?: string })?.code,
}));

const { mensagensRepo } = await import('@/db/repositories.js');

const ESCOPO = { tenant_id: 'primary', agent_id: 'primary' } as const;
const CANAL = '11111111-1111-4111-8111-111111111111';

function inbound(over: Record<string, unknown> = {}) {
  return {
    conversa_id: null,
    channel_id: CANAL,
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'oi',
    midia_url: null,
    metadata: { whatsapp_id: 'wa-1', remote_jid: '5511999998888@s.whatsapp.net', telefone: '+5511999998888' },
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
    ...over,
  } as never;
}

const inserts = (tabela: string) =>
  operacoes.filter((o): o is Extract<Operacao, { kind: 'insert' }> =>
    o.kind === 'insert' ? o.table === tabela : false,
  );
const upserts = () => operacoes.filter((o) => o.kind === 'execute');

beforeEach(() => {
  operacoes.length = 0;
  dedupRows = [];
  proximaSeq = 1;
  auditMock.mockClear();
  counterMock.mockClear();
});

describe('#505 — createInbound recusa identidade irresolúvel (call site real)', () => {
  it('sem channel_id: lança, NÃO persiste, audita e mede', async () => {
    await expect(
      runWithTenantContext(ESCOPO, () =>
        mensagensRepo.createInbound(inbound({ channel_id: null })),
      ),
    ).rejects.toMatchObject({ code: 'STREAM_IDENTITY_UNRESOLVED', reason: 'missing_channel' });

    // A METADE QUE IMPORTA: nada foi escrito.
    expect(inserts('mensagens')).toHaveLength(0);
    expect(upserts()).toHaveLength(0);

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'stream_ingress_rejected',
        metadata: expect.objectContaining({ reason: 'missing_channel' }),
      }),
    );
    expect(counterMock).toHaveBeenCalledWith(
      'maia_stream_ingress_rejected_total',
      expect.objectContaining({ reason: 'missing_channel' }),
    );
  });

  it('sem identidade remota: lança e não persiste', async () => {
    await expect(
      runWithTenantContext(ESCOPO, () =>
        mensagensRepo.createInbound(inbound({ metadata: { whatsapp_id: 'wa-2' } })),
      ),
    ).rejects.toMatchObject({ reason: 'missing_remote_identity' });
    expect(inserts('mensagens')).toHaveLength(0);
  });

  it("sob o literal 'default' o ingresso é RECUSADO — nunca vira stream genérica", async () => {
    // A invariante MUST nº 8. Se alguém trocar a recusa por um fallback
    // `'default'`, este caso vira o vermelho.
    await expect(
      runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, () =>
        mensagensRepo.createInbound(inbound()),
      ),
    ).rejects.toMatchObject({ reason: 'reserved_scope_literal' });
    expect(inserts('mensagens')).toHaveLength(0);
  });

  it('nenhuma métrica desta fronteira carrega stream_key, telefone ou jid como LABEL', async () => {
    await runWithTenantContext(ESCOPO, () => mensagensRepo.createInbound(inbound()));
    for (const [, labels] of counterMock.mock.calls) {
      for (const chave of Object.keys((labels ?? {}) as Record<string, unknown>)) {
        expect(['stream_key', 'remote_jid', 'jid', 'telefone', 'turn_id']).not.toContain(chave);
      }
    }
  });
});

describe('#505 — createInbound sequencia o ingresso resolvido', () => {
  it('persiste stream_key, versão e ingress_seq na row', async () => {
    proximaSeq = 7;
    await runWithTenantContext(ESCOPO, () => mensagensRepo.createInbound(inbound()));

    const [gravado] = inserts('mensagens');
    expect(gravado).toBeDefined();
    expect(gravado!.values).toMatchObject({
      stream_key: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
      stream_key_version: 1,
      ingress_seq: 7,
      tenant_id: 'primary',
      agent_id: 'primary',
    });
  });

  it('a alocação da sequência acontece ANTES do INSERT, na mesma transação', async () => {
    // A ordem é o que faz o rollback devolver o número: se o INSERT colidir na
    // unique de dedup, o UPSERT do contador aborta junto. Inverter a ordem (ou
    // tirar a alocação da transação) mataria essa propriedade.
    await runWithTenantContext(ESCOPO, () => mensagensRepo.createInbound(inbound()));
    const posUpsert = operacoes.findIndex((o) => o.kind === 'execute');
    const posInsert = operacoes.findIndex(
      (o) => o.kind === 'insert' && o.table === 'mensagens',
    );
    expect(posUpsert).toBeGreaterThanOrEqual(0);
    expect(posInsert).toBeGreaterThan(posUpsert);
  });

  it('o UPSERT do contador é escopado por tenant e agent', async () => {
    await runWithTenantContext(ESCOPO, () => mensagensRepo.createInbound(inbound()));
    const [alocacao] = upserts();
    expect(alocacao).toBeDefined();
    const sqlTexto = (alocacao as Extract<Operacao, { kind: 'execute' }>).sql;
    expect(sqlTexto).toContain('agent_stream_sequences');
    expect(sqlTexto).toContain('ON CONFLICT (tenant_id, agent_id, stream_key)');
    const params = (alocacao as Extract<Operacao, { kind: 'execute' }>).params;
    expect(params).toContain('primary');
  });

  it('DEDUP ANTES DA ALOCAÇÃO: reentrega detectada no pre-check não toca o contador', async () => {
    dedupRows = [{ id: 'ja-existe', stream_key: 'v1:abc', ingress_seq: 3 }];
    const r = await runWithTenantContext(ESCOPO, () => mensagensRepo.createInbound(inbound()));
    expect(r.duplicate).toBe(true);
    // Nenhuma transação, nenhuma alocação: a reentrega reusa a sequência que a
    // row original já carrega (§Acceptance: "Redelivery do mesmo evento não
    // recebe nova sequência").
    expect(upserts()).toHaveLength(0);
    expect(inserts('mensagens')).toHaveLength(0);
  });
});
