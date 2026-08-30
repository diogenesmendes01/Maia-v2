/**
 * #513 (fatia D) — duas réplicas de PROCESSO, e `SIGKILL`.
 *
 * ═══ O buraco que esta suíte fecha ══════════════════════════════════════════
 *
 * `tests/reliability/README.md` diz, com todas as letras, o que faltava: "as
 * suítes atuais simulam réplicas concorrentes DENTRO DE UM MESMO PROCESSO, com
 * `worker_id` distinto. Um throw simulado ainda roda `finally`… Um `SIGKILL`
 * não roda nada disso." As fatias anteriores da #513 têm exatamente esse
 * limite: as duas "réplicas" de `channel-session-fence-real-db.spec.ts` são
 * dois `owner_instance_id` no mesmo `node`, e o que as separa é uma string.
 *
 * Aqui elas são dois PROCESSOS. Dois pids, dois `runtimeInstanceId()`, duas
 * conexões de Postgres, dois event loops. E o encerramento de um deles é um
 * `SIGKILL` de verdade — nenhum `finally`, nenhum handler, nenhum `release`.
 *
 * ═══ A propriedade central, e por que ela é observável NA HORA ══════════════
 *
 * Depois do `SIGKILL`, `channel_line_state` continua com
 * `session_owner_instance` do MORTO, com o mesmo `session_fencing_token` e com
 * o prazo que o último heartbeat dele gravou. Isso não exige esperar prazo
 * nenhum: é uma leitura imediata, e é precisamente o que distingue "matei o
 * processo" de "chamei `stop()`". O contraste está no `it` do `SIGTERM`, onde o
 * MESMO binário devolve a linha (`session_owner_instance` vira NULL) — sem esse
 * caso, "nenhum release rodou" também passaria num fixture que nunca soube
 * devolver nada.
 *
 * ═══ Por que o filho importa de `src/` ══════════════════════════════════════
 *
 * `tests/reliability/fixtures/replica-de-canal.ts` chama `acquireChannelLease`
 * e companhia DE VERDADE. Se ele reescrevesse o `INSERT … ON CONFLICT … WHERE`,
 * esta suíte continuaria verde depois de alguém apagar o `WHERE` de
 * `src/gateway/channel-lease.ts` — ela estaria provando o SQL do fixture. A
 * sonda vermelha da PR é justamente essa: apagar o `WHERE` de produção deixa a
 * réplica B entrar por cima de A viva, e o primeiro `it` fica vermelho.
 *
 * ═══ Uma armadilha do harness que vale nomear ══════════════════════════════
 *
 * `sanitizarValor()` redige por SUBSTRING do nome do campo, e `token` está na
 * lista. Um probe de `estavelDurante` com um campo `fencing_token` compararia
 * `[REDACTED]` com `[REDACTED]` e passaria SEMPRE — vácuo perfeito. Por isso
 * `fencing_token`/`session_fencing_token` entraram na lista de exceções
 * explícitas do sanitizador (o mesmo argumento que já valia para o
 * `claim_token` da #504), com o caso correspondente em
 * `tests/reliability/self-tests/sanitize-artifacts.spec.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ArtifactCollector } from '../reliability/harness/artifacts.js';
import { estavelDurante, eventually } from '../reliability/harness/eventually.js';
import { ProcessSupervisor, type SupervisedChild } from '../reliability/harness/process-supervisor.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const FIXTURE = resolve(AQUI, '..', 'reliability', 'fixtures', 'replica-de-canal.ts');
/**
 * O filho é `.ts` e importa `@/gateway/channel-lease.js`; quem resolve o alias
 * é o `tsconfig.json` da raiz, sob `tsx`.
 *
 * ─── E por que `--import tsx`, e NÃO o CLI do tsx ────────────────────────────
 *
 * `node node_modules/tsx/dist/cli.mjs filho.ts` não roda o filho: ele SPAWNA um
 * neto para aplicar os flags do loader. O pid que o `ProcessSupervisor`
 * registra passa a ser o do invólucro, e a garantia central dele — `SIGKILL` no
 * PID exato — mata o invólucro enquanto o processo que segura a lease continua
 * batendo o heartbeat. Medido aqui: com o CLI, `pa.pid` (6283) e `filho.pid`
 * (6272) divergiam, o "morto" renovava a posse para sempre e a réplica B nunca
 * assumia. Um teste de `SIGKILL` que não mata o processo certo é pior que
 * nenhum. `--import tsx` carrega o loader NO MESMO processo, e aí o pid do
 * supervisor é o pid do dono da linha — que é a premissa de tudo que esta
 * suíte afirma, e por isso ela é verificada caso a caso (`pa.pid === a.pid`).
 */
const CARREGADOR_TSX = '--import tsx';

const T = 'i513d-tenant';
const A = 'i513d-agent';

/**
 * TTL da posse. O piso do contrato é 5s (`assertChannelLeaseTtl`), e 6s dá
 * margem de 6x sobre o heartbeat de 1s: uma pausa de GC não pode fazer o dono
 * VIVO perder a linha, senão o vermelho deixa de falar sobre `SIGKILL`.
 */
const TTL_MS = 6_000;
const BATIDA_MS = 1_000;

let pool: pg.Pool;
let sup: ProcessSupervisor;
let artefatos: ArtifactCollector;
let canal: string;

interface Posse {
  owner: string | null;
  fencing_token: number;
  expira: Date | null;
}

async function posseNoBanco(): Promise<Posse> {
  const r = await pool.query<{
    o: string | null;
    t: string;
    e: Date | null;
  }>(
    `SELECT session_owner_instance AS o,
            session_fencing_token::text AS t,
            session_owner_lease_expires_at AS e
       FROM channel_line_state WHERE channel_id = $1`,
    [canal],
  );
  const linha = r.rows[0];
  if (!linha) return { owner: null, fencing_token: 0, expira: null };
  return { owner: linha.o, fencing_token: Number(linha.t), expira: linha.e };
}

/** O relógio é o do BANCO — o do processo do teste não decide prazo nenhum. */
async function jaVenceu(prazo: Date): Promise<boolean> {
  const r = await pool.query<{ v: boolean }>('SELECT $1::timestamptz <= now() AS v', [prazo]);
  return r.rows[0]!.v;
}

/** Toda linha estruturada de um prefixo, já parseada. */
function linhasDe(filho: SupervisedChild, prefixo: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const linha of filho.stdout.split('\n')) {
    const t = linha.trim();
    if (!t.startsWith(prefixo)) continue;
    try {
      out.push(JSON.parse(t.slice(prefixo.length).trim()) as Record<string, unknown>);
    } catch {
      // Uma linha parcial (o chunk cortou no meio) não é evento — o próximo
      // chunk a completa e ela reaparece inteira na próxima leitura.
    }
  }
  return out;
}

function ultimaLinhaDe(
  filho: SupervisedChild,
  prefixo: string,
): Record<string, unknown> | undefined {
  return linhasDe(filho, prefixo).at(-1);
}

function subirReplica(
  label: string,
  extra: Readonly<Record<string, string>> = {},
): SupervisedChild {
  return sup.spawn({
    label,
    script: FIXTURE,
    cwd: RAIZ,
    env: {
      // Acrescentado, não substituído: o que o worker do vitest já pediu
      // (limite de heap, por exemplo) continua valendo para o filho.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, CARREGADOR_TSX].filter(Boolean).join(' '),
      DATABASE_URL: process.env.TEST_DB_URL,
      TEST_DB_URL: process.env.TEST_DB_URL,
      NODE_ENV: 'test',
      MAIA_ENV: 'development',
      TEST_FI_TENANT_ID: T,
      TEST_FI_AGENT_ID: A,
      TEST_FI_CHANNEL_ID: canal,
      TEST_FI_TTL_MS: String(TTL_MS),
      TEST_FI_BATIDA_MS: String(BATIDA_MS),
      TEST_FI_INTERVALO_MS: '200',
      ...extra,
    },
    // Import a frio do grafo de produção sob `tsx`; o default de 15s do
    // supervisor já cobre, e 30s dá folga para a máquina compartilhada.
    readyTimeoutMs: 30_000,
  });
}

/** A carga do handshake, tipada no que este cenário lê. */
interface Prontidao {
  pid: number;
  owner_instance_id: string;
  held: boolean;
  result: string;
  fencing_token: number | null;
  held_by: string | null;
}

async function prontidaoDe(filho: SupervisedChild): Promise<Prontidao> {
  const carga = (await filho.esperarPronto(30_000)) as unknown as Prontidao;
  // A premissa de TODA esta suíte, cobrada em cada filho: o pid que o
  // supervisor vai matar é o pid do processo que segura a lease. Se um
  // invólucro voltar a se meter no meio (ver `CARREGADOR_TSX`), o vermelho
  // aparece aqui — e não como um `SIGKILL` que misteriosamente não derruba nada.
  expect(
    carga.pid,
    'o pid do dono da lease não é o pid supervisionado — o SIGKILL mataria um invólucro',
  ).toBe(filho.pid);
  return carga;
}

d('#513 (fatia D) — duas réplicas de PROCESSO e SIGKILL (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
      T,
    ]);
    await pool.query(
      'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
      [A, T],
    );
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM channel_line_state WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    await pool?.end();
  });

  beforeEach(async () => {
    artefatos = new ArtifactCollector('513-fatia-d-sigkill', 'sem-seed');
    sup = new ProcessSupervisor(artefatos);
    // Um canal NOVO por caso. É o que torna toda afirmação sobre o fence
    // ABSOLUTA (`token === 1`, `token === 2`) em vez de um delta sobre estado
    // compartilhado — que o `retry: 1` do `vitest.config.ts` lavaria.
    await pool.query('DELETE FROM channel_line_state WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    const r = await pool.query<{ id: string }>(
      `INSERT INTO channels(tenant_id, agent_id, channel_type, external_id, active)
       VALUES ($1, $2, 'whatsapp', $3, true) RETURNING id`,
      [T, A, `5511${String(Date.now()).slice(-8)}`],
    );
    canal = r.rows[0]!.id;
  });

  afterEach(async () => {
    await sup.dispose();
  });

  it(
    'réplica B (outro processo, outro pid) é RECUSADA enquanto a lease de A está viva',
    async () => {
      const a = subirReplica('replica-a');
      const pa = await prontidaoDe(a);

      // A é dona, e a identidade que ela gravou é a DELA — `<hostname>:<pid>`,
      // com o pid que o sistema operacional deu a este processo.
      expect(pa.held, `réplica A não conseguiu a posse: ${JSON.stringify(pa)}`).toBe(true);
      expect(pa.result).toBe('acquired');
      expect(pa.fencing_token).toBe(1);
      expect(pa.pid).toBe(a.pid);
      expect(pa.owner_instance_id.endsWith(`:${a.pid}`)).toBe(true);
      expect(await posseNoBanco()).toMatchObject({ owner: pa.owner_instance_id, fencing_token: 1 });

      const b = subirReplica('replica-b');
      const pb = await prontidaoDe(b);

      // ESTE é o ponto da fatia D: B é outro PROCESSO. Não é outro
      // `owner_instance_id` escolhido pelo teste — é outro pid, e portanto
      // outra identidade, produzida pelo mesmo `runtimeInstanceId()` de
      // produção.
      expect(b.pid).not.toBe(a.pid);
      expect(pb.owner_instance_id).not.toBe(pa.owner_instance_id);
      expect(pb.pid).toBe(b.pid);

      expect(pb.held, `réplica B entrou por cima de A viva: ${JSON.stringify(pb)}`).toBe(false);
      expect(pb.result).toBe('held_by_other');
      expect(pb.held_by).toBe(pa.owner_instance_id);

      // B continua tentando, e a posse NÃO se move. A invariante é negativa
      // ("nada mudou"), então `estavelDurante` é o instrumento certo — e ele
      // reprova no instante da mudança, não no fim da janela.
      // O PRAZO fica de fora do probe de propósito: A está VIVA e renovando, e
      // o prazo se mover é justamente o sinal de saúde dela. O que não pode
      // mudar é o par (dono, fence).
      await estavelDurante(
        async () => {
          const p = await posseNoBanco();
          return { owner: p.owner, fencing_token: p.fencing_token };
        },
        {
          label: 'a posse não muda de dono enquanto a lease de A está viva',
          janelaMs: 1_500,
          justificativa:
            'não existe evento de "takeover que não aconteceu"; a única prova é observar a janela',
        },
      );

      // E as tentativas de B são REAIS — sem isto, "a posse não mudou" também
      // passaria com um processo B que nunca chegou a pedir nada.
      const tentativas = linhasDe(b, '##fi-tentativa##');
      expect(
        tentativas.length,
        'réplica B não voltou a tentar — a estabilidade acima não provaria nada',
      ).toBeGreaterThanOrEqual(2);
      for (const t of tentativas) expect(t.result).toBe('held_by_other');
    },
    45_000,
  );

  it(
    'SIGKILL em A: nenhum release rodou, a posse continua registrada nele — e só depois do prazo B assume, com fence ESTRITAMENTE maior',
    async () => {
      const a = subirReplica('replica-a');
      const pa = await prontidaoDe(a);
      expect(pa.held).toBe(true);
      const b = subirReplica('replica-b');
      const pb = await prontidaoDe(b);
      expect(pb.held).toBe(false);

      const antes = await posseNoBanco();
      expect(antes.owner).toBe(pa.owner_instance_id);
      expect(antes.fencing_token).toBe(1);

      sup.hardKill(a);
      const enc = await a.esperarSaida(5_000);
      expect(enc.signal, 'o processo não morreu por SIGKILL').toBe('SIGKILL');
      expect(enc.code, 'houve código de saída — algum handler chegou a rodar').toBeNull();

      // ─── A propriedade central, lida NA HORA ─────────────────────────────
      const depois = await posseNoBanco();
      expect(
        depois.owner,
        'a posse do processo morto sumiu — algo devolveu a linha, e um SIGKILL não devolve nada',
      ).toBe(pa.owner_instance_id);
      expect(depois.fencing_token).toBe(antes.fencing_token);
      expect(depois.expira?.getTime()).toBe(antes.expira?.getTime());
      expect(
        await jaVenceu(depois.expira!),
        'a lease do morto já estava vencida no instante do kill — o caso não chegou a falar sobre SIGKILL',
      ).toBe(false);

      // Nenhum release rodou, e isto é verificável dos DOIS lados: o banco
      // (acima) e o stdout do filho, que jamais anunciou a devolução.
      expect(linhasDe(a, '##fi-devolucao##')).toHaveLength(0);

      // ─── E B, vivo do outro lado, continua RECUSADO enquanto o prazo do
      //     morto não vence. Um dono morto ainda segura a linha. ────────────
      await estavelDurante(async () => await posseNoBanco(), {
        label: 'a linha continua registrada no processo MORTO enquanto o prazo dele não vence',
        janelaMs: 1_000,
        justificativa:
          'a invariante é negativa: nenhum takeover antecipado. Só uma janela observada a prova',
      });
      expect(linhasDe(b, '##fi-posse##')).toHaveLength(0);

      // ─── Vencido o prazo, B assume ───────────────────────────────────────
      const posse = await eventually(() => ultimaLinhaDe(b, '##fi-posse##'), {
        label: 'réplica B assume a linha depois de a lease do morto vencer',
        timeoutMs: 20_000,
        intervalMs: 100,
        abortSignal: sup.sinalDeFalha,
        describeState: async () => ({
          banco: await posseNoBanco(),
          tentativas_de_b: linhasDe(b, '##fi-tentativa##').length,
        }),
      });

      expect(posse.result).toBe('taken_over');
      expect(
        Number(posse.fencing_token),
        'o fence não subiu na troca de dono — o dono antigo voltaria a valer',
      ).toBeGreaterThan(antes.fencing_token);
      // Absoluto, não delta: houve exatamente UMA sucessão neste canal.
      expect(Number(posse.fencing_token)).toBe(antes.fencing_token + 1);

      const final = await posseNoBanco();
      expect(final.owner).toBe(pb.owner_instance_id);
      expect(final.fencing_token).toBe(antes.fencing_token + 1);
      expect(await jaVenceu(final.expira!)).toBe(false);

      // E a tomada só foi possível porque o prazo venceu — B foi recusado
      // antes, de verdade, e não simplesmente entrou.
      expect(linhasDe(b, '##fi-tentativa##').length).toBeGreaterThanOrEqual(2);
    },
    60_000,
  );

  it(
    'o MESMO binário, encerrado com SIGTERM, DEVOLVE a linha — é isto que torna o caso do SIGKILL não-vazio',
    async () => {
      const a = subirReplica('replica-a');
      const pa = await prontidaoDe(a);
      expect(pa.held).toBe(true);
      expect((await posseNoBanco()).owner).toBe(pa.owner_instance_id);

      const enc = await sup.terminate(a, 5_000);
      expect(enc.signal, 'o filho precisou de SIGKILL — o handler de SIGTERM não rodou').toBeNull();
      expect(enc.code).toBe(0);

      const devolucao = ultimaLinhaDe(a, '##fi-devolucao##');
      expect(devolucao, 'o encerramento ordenado não anunciou devolução').toBeDefined();
      expect(devolucao!.devolvida).toBe(true);

      const depois = await posseNoBanco();
      expect(depois.owner, 'o shutdown ordenado não liberou a linha').toBeNull();
      expect(depois.expira).toBeNull();
      // O TOKEN sobrevive à devolução — é o que impede o dono antigo de
      // reapresentar um token velho como válido (migration 137).
      expect(depois.fencing_token).toBe(1);
    },
    45_000,
  );

  it(
    'SIGKILL entre uma batida e a seguinte: quem manda no failover é o prazo que o ÚLTIMO heartbeat gravou',
    async () => {
      // Batida mais lenta que o default alarga a janela entre renovações — é
      // dentro dela que o kill precisa cair.
      const a = subirReplica('replica-a', { TEST_FI_BATIDA_MS: '1500' });
      const pa = await prontidaoDe(a);
      expect(pa.held).toBe(true);

      // Esperamos DUAS batidas: a segunda prova que o prazo lido a seguir foi
      // escrito por um heartbeat, e não pela aquisição inicial.
      await eventually(() => linhasDe(a, '##fi-batida##').length >= 2, {
        label: 'a réplica A renovou a posse ao menos duas vezes antes do kill',
        timeoutMs: 20_000,
        intervalMs: 50,
        abortSignal: sup.sinalDeFalha,
        describeState: () => ({ batidas: linhasDe(a, '##fi-batida##') }),
      });
      for (const batida of linhasDe(a, '##fi-batida##')) expect(batida.resultado).toBe('renewed');

      const aposBatida = await posseNoBanco();
      sup.hardKill(a);
      expect((await a.esperarSaida(5_000)).signal).toBe('SIGKILL');

      // O prazo gravado pelo último heartbeat sobreviveu ao kill INTACTO: o
      // commit já era do banco, e não havia rollback a fazer.
      const depois = await posseNoBanco();
      expect(depois.owner).toBe(pa.owner_instance_id);
      expect(depois.fencing_token).toBe(aposBatida.fencing_token);
      expect(depois.expira?.getTime()).toBe(aposBatida.expira?.getTime());
      expect(
        await jaVenceu(depois.expira!),
        'a lease já estava vencida no instante do kill — o caso não observou a janela entre batidas',
      ).toBe(false);
      expect(linhasDe(a, '##fi-devolucao##')).toHaveLength(0);

      // Uma réplica que chega AGORA é recusada — e quem a recusa é um processo
      // que não existe mais.
      const c = subirReplica('replica-c');
      const pc = await prontidaoDe(c);
      expect(pc.held).toBe(false);
      expect(pc.held_by).toBe(pa.owner_instance_id);

      const posse = await eventually(() => ultimaLinhaDe(c, '##fi-posse##'), {
        label: 'a réplica C assume só depois do prazo escrito pelo último heartbeat de A',
        timeoutMs: 20_000,
        intervalMs: 100,
        abortSignal: sup.sinalDeFalha,
        describeState: async () => ({ banco: await posseNoBanco() }),
      });
      expect(posse.result).toBe('taken_over');
      expect(Number(posse.fencing_token)).toBe(aposBatida.fencing_token + 1);
      // No instante em que C tem a linha, o prazo do morto JÁ tinha vencido —
      // afirmado pelo relógio do banco, nunca pelo do processo do teste.
      expect(await jaVenceu(depois.expira!)).toBe(true);
    },
    60_000,
  );

  it(
    'o dono ANTIGO que volta com o token velho na mão é recusado nas QUATRO operações fenced',
    async () => {
      const a = subirReplica('replica-a');
      const pa = await prontidaoDe(a);
      expect(pa.held).toBe(true);
      expect(pa.fencing_token).toBe(1);

      sup.hardKill(a);
      expect((await a.esperarSaida(5_000)).signal).toBe('SIGKILL');

      const b = subirReplica('replica-b');
      const pb = await prontidaoDe(b);
      const posseDeB = await eventually(() => ultimaLinhaDe(b, '##fi-posse##'), {
        label: 'réplica B assume a linha do morto',
        timeoutMs: 20_000,
        intervalMs: 100,
        abortSignal: sup.sinalDeFalha,
        describeState: async () => ({ banco: await posseNoBanco() }),
      });
      expect(Number(posseDeB.fencing_token)).toBe(2);

      // O "dono antigo voltando": um processo NOVO reapresentando a identidade
      // e o token do processo que morreu. É o que uma partição de rede produz
      // quando o nó isolado volta — e o pid dele não precisa (nem pode) ser o
      // mesmo, por isso a identidade é passada explicitamente.
      const zumbi = subirReplica('zumbi', {
        TEST_FI_MODO: 'zumbi',
        TEST_FI_OWNER_ID: pa.owner_instance_id,
        TEST_FI_TOKEN: '1',
      });
      await prontidaoDe(zumbi);
      const veredito = await eventually(() => ultimaLinhaDe(zumbi, '##fi-zumbi##'), {
        label: 'o dono antigo reporta o veredito das quatro operações fenced',
        timeoutMs: 10_000,
        abortSignal: sup.sinalDeFalha,
        describeState: () => ({ stdout: zumbi.stdout, stderr: zumbi.stderr }),
      });

      expect(veredito.envio_autorizado, 'o dono antigo foi autorizado a ENVIAR').toBe(false);
      expect(veredito.heartbeat, 'o dono antigo conseguiu renovar a posse do sucessor').toBe(
        'not_owner',
      );
      expect(veredito.release_pegou, 'o dono antigo devolveu a linha do SUCESSOR').toBe(false);
      expect(veredito.retomada_held).toBe(false);
      expect(veredito.retomada).toBe('held_by_other');

      // E nada disso deixou marca: a linha continua de B, no mesmo fence.
      const final = await posseNoBanco();
      expect(final.owner).toBe(pb.owner_instance_id);
      expect(final.fencing_token).toBe(2);
      expect(await jaVenceu(final.expira!)).toBe(false);
    },
    60_000,
  );
});
