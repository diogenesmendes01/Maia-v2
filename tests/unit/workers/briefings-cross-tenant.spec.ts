/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the 3
 * briefing workers (`briefing_morning` / `briefing_evening` / `briefing_weekly`).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * These briefings are HIGH-SENSITIVITY: they READ financial data
 * (`entidadesRepo`/`contasRepo`/`transacoesRepo`) and SEND a message to the
 * owner. A cross-tenant leak would mail one tenant's balances to ANOTHER
 * tenant's owner — a severe isolation breach.
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. Each `run*Briefing` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples owning an active owner
 *      (`pessoasRepo.listTenantAgentPairsWithActiveOwner`) and runs the period's
 *      inner ONCE PER tuple inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist the
 *      inner never runs under `default`.
 *
 *   3. Behavior-preserving in single-tenant mode; empty enumeration → no-op;
 *      fail-isolated per tuple.
 *
 *   4. DATA + RECIPIENT ISOLATION (the test that proves no financial leak):
 *      with entidades/contas/pessoas seeded for BOTH tenant A and tenant B,
 *      running the morning briefing for tuple A builds a body from ONLY tenant
 *      A's entities/accounts and sends ONLY to tenant A's active owner. Tenant
 *      B's entities never appear in the body and tenant B's owner never receives
 *      a message. The reads go through the REAL repos
 *      (`entidadesRepo.list`/`contasRepo.byEntity`/`listOwners`→`pessoasRepo.list`)
 *      against a store that evaluates the REAL drizzle predicate, so a missing
 *      tenant binding would surface as a cross-tenant row in the result.
 *
 * Strategy: a single store-backed `@/db/client.js` mock serves both blocks. The
 * DISPATCH block leaves the store EMPTY (inner reads resolve to `[]`) and a thin
 * wrapper records the ACTIVE tenant context at each `db.select()` call site. The
 * ISOLATION block seeds entidades/contas/pessoas for A and B and lets the REAL
 * inner run, capturing every outbound send. Only the dispatcher-enumeration
 * helper is overridden; the financial repos + `listOwners` are REAL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';
import {
  parsePredicate,
  rowMatches,
  type StoreRow,
} from './_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };

let enumeratedPairs: Pair[] = [];
/** Context active each time an inner financial `db.select()` fires. */
const contextsSeen: Pair[] = [];
let throwForTuple: Set<string> = new Set();

const listActiveOwnerPairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

/**
 * Minimal multi-table store backing `@/db/client.js`'s `db`. Each `select()`
 * resolves `from(table).where(pred)` by EVALUATING the drizzle predicate the
 * REAL repo built (via the shared `parsePredicate`/`rowMatches`), so an unscoped
 * read would leak other tenants' rows. Reads are awaited directly on `.where()`
 * (the briefing repos call no `.limit()`/`.orderBy()`); `.then` makes the chain
 * awaitable, and `.limit()`/`.orderBy()` are supported defensively.
 */
function makeMultiTableStore() {
  // Keyed by drizzle table object identity (the value passed to `.from(...)`).
  const tables = new Map<unknown, StoreRow[]>();
  const seed = (table: unknown, rows: StoreRow[]) => tables.set(table, rows.map((r) => ({ ...r })));
  const clear = () => tables.clear();

  const select = vi.fn(() => {
    const ctx = tryGetCurrentContext();
    if (!ctx) {
      throw new Error(
        'briefing inner SELECT ran outside tenant context — getCurrentTenant would throw in prod',
      );
    }
    contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
    const key = `${ctx.tenant_id}|${ctx.agent_id}`;
    if (throwForTuple.has(key)) throw new Error(`synthetic briefing failure for ${key}`);

    let table: unknown;
    let predicate: unknown;
    const run = (): StoreRow[] => {
      const rows = (table !== undefined && tables.get(table)) || [];
      if (predicate === undefined) return rows;
      const terms = parsePredicate(predicate);
      return rows.filter((row) => rowMatches(row, terms, new Date()));
    };
    const chain: Record<string, unknown> = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: (p: unknown) => {
        predicate = p;
        return chain;
      },
      orderBy: () => chain,
      limit: (n: number) => {
        const out = run().slice(0, n);
        return Object.assign(Promise.resolve(out), chain);
      },
      then: (resolve: (v: StoreRow[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return chain;
  });

  return { db: { select }, seed, clear, select };
}

const store = makeMultiTableStore();

vi.mock('@/db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => store.db.select(...args),
  },
}));

// Keep the REAL repos (so the briefing inner's reads exercise the REAL drizzle
// WHERE predicate against the store) and override ONLY the dispatcher-enumeration
// helper used by the worker.
vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories.js')>();
  return {
    ...actual,
    pessoasRepo: {
      ...actual.pessoasRepo,
      listTenantAgentPairsWithActiveOwner: listActiveOwnerPairsMock,
    },
  };
});

// Captura o COMPROMISSO de saída para provar destinatário e não-entrega
// cruzada. Resolve sempre — estes specs provam isolamento por tupla, não
// resolução de canal.
//
// Issue #506: `sendToOwners` NÃO chama mais o canal. Ela compromete o briefing
// no ledger durável de agendamento (`enqueueProactiveNotice` →
// `outboxRepo.enqueue`), e o drain de agendamento entrega depois. Então o ponto
// de captura desceu do `line.sendText` para o ENQUEUE — que é o instante em que
// o briefing passa a existir para o PostgreSQL, e é sob a ALS da tupla que ele
// é gravado. Todas as asserções de destinatário/corpo valem igual.
const sentMessages: Array<{ jid: string; text: string; dedupe_key: string }> = [];
const enqueueProactiveNoticeMock = vi.fn(
  async (input: { jid: string; text: string; dedupe_key: string }) => {
    sentMessages.push({ jid: input.jid, text: input.text, dedupe_key: input.dedupe_key });
    return 'enqueued' as const;
  },
);
vi.mock('@/runtime/outbound/proactive-notice.js', () => ({
  enqueueProactiveNotice: enqueueProactiveNoticeMock,
}));
// Tripwire DUPLO: nada neste worker deve tocar a fronteira de saída nem a
// primitiva crua do gateway. Se algum caminho voltar a enviar direto, a captura
// abaixo entra no MESMO `sentMessages` e as asserções de contagem flagram o
// desvio — e a trava arquitetural de #634 reprova o módulo em paralelo.
const forCurrentAgentChannelMock = vi.fn(async () => ({
  sendText: async (jid: string, text: string) => {
    sentMessages.push({ jid, text, dedupe_key: 'DESVIO:envio_direto' });
    return null;
  },
}));
vi.mock('@/gateway/line-output.js', () => ({
  forCurrentAgentChannel: forCurrentAgentChannelMock,
}));
vi.mock('@/gateway/baileys.js', () => ({
  sendOutboundText: vi.fn(async (jid: string, text: string) => {
    sentMessages.push({ jid, text, dedupe_key: 'DESVIO:envio_direto' });
    return undefined;
  }),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

const BRIEFINGS = [
  { name: 'morning', run: async () => (await import('@/workers/briefings.js')).runMorningBriefing() },
  { name: 'evening', run: async () => (await import('@/workers/briefings.js')).runEveningBriefing() },
  { name: 'weekly', run: async () => (await import('@/workers/briefings.js')).runWeeklyBriefing() },
] as const;

beforeEach(() => {
  enumeratedPairs = [];
  contextsSeen.length = 0;
  sentMessages.length = 0;
  throwForTuple = new Set();
  listActiveOwnerPairsMock.mockClear();
  forCurrentAgentChannelMock.mockClear();
  enqueueProactiveNoticeMock.mockClear();
  store.select.mockClear();
  // DISPATCH tests run with an EMPTY store (inner reads → []); the ISOLATION
  // block seeds it in its own beforeEach.
  store.clear();
});

describe.each(BRIEFINGS)(
  'Issue #345 — runBriefing[$name] is per-tenant scoped (no default/default leak)',
  ({ run }) => {
    it('MULTI-TENANT — inner runs once per enumerated tuple under its own context', async () => {
      enumeratedPairs = [A, B];

      await run();

      expect(listActiveOwnerPairsMock).toHaveBeenCalledTimes(1);
      // Each tuple's inner fires at least one financial SELECT (entidades).
      const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
      expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
    });

    it('NO default/default — inner SELECT never runs under the legacy sentinel when real tuples exist', async () => {
      enumeratedPairs = [A, B];

      await run();

      expect(contextsSeen.length).toBeGreaterThan(0);
      for (const c of contextsSeen) {
        expect(c.tenant_id).not.toBe('default');
        expect(c.agent_id).not.toBe('default');
      }
    });

    it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs under default', async () => {
      enumeratedPairs = [DEFAULT];

      await run();

      expect(contextsSeen.length).toBeGreaterThan(0);
      for (const c of contextsSeen) {
        expect(c).toEqual(DEFAULT);
      }
    });

    it('EMPTY enumeration → no-op (no inner SELECT, no send)', async () => {
      enumeratedPairs = [];

      await run();

      expect(store.select).not.toHaveBeenCalled();
      expect(contextsSeen).toHaveLength(0);
      expect(sentMessages).toHaveLength(0);
    });

    it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
      enumeratedPairs = [A, B];
      throwForTuple = new Set(['tenant-A|agent-A']);

      await expect(run()).resolves.toBeUndefined();

      // Tenant-B's inner still ran (its context was seen) despite A throwing.
      const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
      expect(seen.has('tenant-B|agent-B')).toBe(true);
    });

    it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
      enumeratedPairs = [A];

      await expect(run()).resolves.toBeUndefined();
      for (const c of contextsSeen) expect(c).toEqual(A);
    });

    it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
      enumeratedPairs = [B];

      await runWithTenantContext(A, run);

      expect(contextsSeen.length).toBeGreaterThan(0);
      for (const c of contextsSeen) expect(c).toEqual(B);
    });
  },
);

/**
 * DATA + RECIPIENT ISOLATION — drives the REAL morning-briefing inner for tuple
 * A ONLY, against a store seeded with entidades/contas/pessoas for BOTH tenant A
 * and tenant B. Proves the briefing body is built from ONLY tenant-A's financial
 * rows and is delivered to ONLY tenant-A's active owner.
 *
 * This is the #345 regression lever for these high-sensitivity workers: before
 * the fix `entidadesRepo.list()` had no tenant predicate (and `contasRepo.byEntity`
 * scoped by `entidade_id` alone), so a per-tuple run would read tenant-B's
 * entities/accounts and fold their balances into the message mailed to tenant-A's
 * owner. The assertions below would fail in that world (tenant-B's entity name in
 * the body / a send to tenant-B's owner jid).
 */
describe('Issue #345 — morning briefing reads + sends for ONLY the current tenant/agent', () => {
  // Drizzle table objects (identity-keyed in the store).
  let entidades: unknown;
  let contas_bancarias: unknown;
  let pessoas: unknown;

  const ent = (over: Partial<StoreRow>): StoreRow => ({
    id: 'e',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    nome: 'Entidade',
    status: 'ativa',
    ...over,
  });
  const conta = (over: Partial<StoreRow>): StoreRow => ({
    id: 'k',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    entidade_id: 'e',
    saldo_atual: '0',
    ...over,
  });
  const pessoa = (over: Partial<StoreRow>): StoreRow => ({
    id: 'p',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    nome: 'Dono',
    tipo: 'dono',
    status: 'ativa',
    telefone_whatsapp: '+550000',
    ...over,
  });

  beforeEach(async () => {
    contextsSeen.length = 0;
    sentMessages.length = 0;
    const schema = await import('@/db/schema.js');
    entidades = schema.entidades;
    contas_bancarias = schema.contas_bancarias;
    pessoas = schema.pessoas;

    store.seed(entidades, [
      ent({ id: 'A-ent', tenant_id: 'tenant-A', agent_id: 'agent-A', nome: 'Acme A' }),
      // Tenant B entity (MUST never appear in tenant-A's briefing body).
      ent({ id: 'B-ent', tenant_id: 'tenant-B', agent_id: 'agent-B', nome: 'Beta B' }),
      // Tenant A but a DIFFERENT agent (MUST be excluded too).
      ent({ id: 'A-otherAgent', tenant_id: 'tenant-A', agent_id: 'agent-Z', nome: 'Zeta Z' }),
    ]);
    store.seed(contas_bancarias, [
      conta({ id: 'A-conta', tenant_id: 'tenant-A', agent_id: 'agent-A', entidade_id: 'A-ent', saldo_atual: '1000.10' }),
      // Tenant B account hanging off tenant-B's entity (must never be summed for A).
      conta({ id: 'B-conta', tenant_id: 'tenant-B', agent_id: 'agent-B', entidade_id: 'B-ent', saldo_atual: '9999.99' }),
    ]);
    store.seed(pessoas, [
      pessoa({ id: 'A-owner', tenant_id: 'tenant-A', agent_id: 'agent-A', telefone_whatsapp: '+5511111', tipo: 'dono', status: 'ativa' }),
      // Tenant B owner (MUST never receive tenant-A's briefing).
      pessoa({ id: 'B-owner', tenant_id: 'tenant-B', agent_id: 'agent-B', telefone_whatsapp: '+5522222', tipo: 'dono', status: 'ativa' }),
    ]);
  });

  it('builds the body from ONLY tenant-A entities/accounts and sends ONLY to tenant-A owner', async () => {
    enumeratedPairs = [A];

    const { runMorningBriefing } = await import('@/workers/briefings.js');
    await runMorningBriefing();

    // Exactly one send — to tenant-A's owner jid (derived from the current tuple).
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg.jid).toBe('5511111@s.whatsapp.net');
    // Issue #506 — o briefing virou LINHA DE LEDGER, e a chave de dedupe prova
    // as três dimensões da idempotência: período, dia e dono. Uma segunda
    // execução do cron no mesmo dia colide na chave e NÃO manda o briefing de
    // novo — o que o `line.sendText` anterior não conseguia oferecer.
    expect(msg.dedupe_key).toMatch(/^briefing:morning:\d{4}-\d{2}-\d{2}:/);
    // Tenant-B's owner jid was never contacted.
    expect(sentMessages.some((m) => m.jid === '5522222@s.whatsapp.net')).toBe(false);

    // Body reflects ONLY tenant-A's entity + balance …
    expect(msg.text).toContain('Acme A');
    expect(msg.text).toContain('1.000,10'); // tenant-A account balance, BR-formatted
    // … and NOTHING from tenant B (entity name or its account balance).
    expect(msg.text).not.toContain('Beta B');
    expect(msg.text).not.toContain('9.999,99');
    // … nor from tenant-A's OTHER agent.
    expect(msg.text).not.toContain('Zeta Z');

    // Every financial SELECT in the run fired under tenant-A's context only.
    expect(contextsSeen.length).toBeGreaterThan(0);
    for (const c of contextsSeen) expect(c).toEqual(A);

    // Issue #506: a fronteira de saída não é mais tocada por este worker. A
    // linha é resolvida DEPOIS, pelo drain de agendamento, a partir da row
    // comprometida — então zero chamadas aqui é a asserção certa, e ela é o
    // tripwire que pega uma reintrodução de envio direto.
    expect(forCurrentAgentChannelMock).not.toHaveBeenCalled();
  });

  it('a tuple with active owners but no entities still sends an (empty-body) briefing — no under-delivery', async () => {
    // Re-seed: tenant-A has an owner but ZERO entities; tenant-B still has data.
    store.seed(entidades, [
      ent({ id: 'B-only', tenant_id: 'tenant-B', agent_id: 'agent-B', nome: 'Beta B' }),
    ]);
    enumeratedPairs = [A];

    const { runMorningBriefing } = await import('@/workers/briefings.js');
    await runMorningBriefing();

    // Owner still briefed (recipient is owner-defined, not data-defined) …
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.jid).toBe('5511111@s.whatsapp.net');
    // … with no tenant-B leakage in the body.
    expect(sentMessages[0]!.text).not.toContain('Beta B');
  });
});
