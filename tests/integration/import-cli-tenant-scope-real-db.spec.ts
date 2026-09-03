/**
 * Issue #720 — as CLIs de importação (`npm run import:ofx` e a família
 * `import:list|show|apply`) contra Postgres REAL, executadas como PROCESSO
 * FILHO.
 *
 * ## O que esta spec prova
 *
 *  1. **A ingestão voltou a existir.** `import:ofx` estava MORTA desde
 *     `migrations/083_drop_default_column_default.sql`: o insert em
 *     `import_runs` omitia `tenant_id`/`agent_id` (NOT NULL, sem default desde
 *     a 083) e nenhum caminho entrava em `runWithTenantContext`. Com o código
 *     de antes do conserto, o caso (1) abaixo reprova com uma das DUAS mortes
 *     reais, dependendo do arquivo:
 *       - arquivo COM lançamentos → `MissingTenantContextError` em
 *         `reconcile()` → `transacoesRepo.byScope()` → `getCurrentTenant()`;
 *       - arquivo VAZIO → `ERROR: null value in column "tenant_id" of relation
 *         "import_runs" violates not-null constraint` (SQLSTATE 23502).
 *  2. **Escopo declarado é VERIFICADO contra o dono da linha.** Cada caso de
 *     recusa carrega um CONTROLE que TEM DE PASSAR no MESMO `it` — sem ele,
 *     uma CLI que recusasse SEMPRE (inclusive quebrada) também passaria, e o
 *     caso não provaria nada.
 *  3. **`import:apply` está sob teste.** Ele era inalcançável (nenhuma run era
 *     criada); agora é alcançável, então é exercido aqui de ponta a ponta.
 *  4. **O `UPDATE` sem escopo não volta.** O caso (4) planta o ataque exato que
 *     o `WHERE id = $1` permitia: uma `import_entry` do tenant A cujo
 *     `matched_transacao_id` aponta para uma `transacao` do tenant B
 *     (`transacoes.id` é PK GLOBAL). Se alguém reintroduzir o predicado só por
 *     id, a linha do tenant B é sobrescrita e o caso fica VERMELHO.
 *
 * ## Por que processo FILHO e não a função exportada
 *
 * A prova precisa ser do BINÁRIO que o operador roda (`npm run import:ofx`),
 * não de um helper interno: parsing de argumentos, fail-closed por argumento
 * ausente, código de saída e a entrada em `runWithTenantContext` são todos
 * parte do defeito. Um teste que importasse só o núcleo continuaria verde se o
 * `main()` deixasse de abrir o escopo. O custo é o boot do `tsx` + do subset
 * `runtime` do contrato por invocação (medido: ~2–4s), e é por isso que cada
 * `it` declara prazo próprio em vez de contar com os 20s do
 * `vitest.config.ts`.
 *
 * ## Skip
 *
 * Sem `TEST_DB_URL` (ou com `DATABASE_URL` diferente dela) a suíte faz
 * `describe.skip` — a lane unit-only continua passando sem Postgres. `pulado`
 * NÃO é `passou`: o bloco de diagnóstico no fim da rodada traz os três números.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { arquivoDoPacote } from '../helpers/pkg-path.js';

const execFileAsync = promisify(execFile);

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Prazo por caso: cada `it` dispara de 1 a 4 processos filhos, e cada um paga
// o boot do `tsx` + do contrato de configuração. Medido nesta máquina entre
// 2s e 4s por invocação; 120s dá folga de ~4x para o pior caso (4 invocações)
// sem virar prazo infinito.
const PRAZO_MS = 120_000;

// ---------------------------------------------------------------------------
// Identificadores
//
// `tenants.id`/`agents.id` são PKs GLOBAIS de texto — um id genérico colidiria
// com o seed de outra suíte, então tudo aqui é namespaced por `imp720`.
// `entidades.id`/`contas_bancarias.id`/`pessoas.id`/`transacoes.id` também são
// PKs GLOBAIS (não escopadas por tenant), então NADA aqui usa uuid fixo: as
// linhas nascem com `gen_random_uuid()` e são reencontradas por NOME.
// ---------------------------------------------------------------------------
const TENANT_A = 'imp720cli-tenant-a';
const AGENT_A = 'imp720cli-agent-a';
const TENANT_B = 'imp720cli-tenant-b';
const AGENT_B = 'imp720cli-agent-b';

const RAIZ = resolve(__dirname, '../..');
const TSX = arquivoDoPacote('tsx', 'dist/cli.mjs', import.meta.url);
const SCRIPT_OFX = join(RAIZ, 'scripts/import-ofx.ts');
const SCRIPT_REVIEW = join(RAIZ, 'scripts/import-review.ts');

let pool: pg.Pool;
let dir: string;
let contaA: string;
let contaB: string;
let pessoaA: string;
let entidadeA: string;
let entidadeB: string;

/**
 * Ambiente do processo filho.
 *
 * O boot fail-closed do subset `runtime` (`@/config/env.js`, issue #596) exige
 * `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` no profile `development`
 * (que é onde `NODE_ENV=test` cai — ver `src/config/profiles.ts`). O processo
 * do vitest não os tem; derivamos da MESMA `TEST_DB_URL` que o resto da rodada
 * usa, para que o filho fale com o banco DESTA worktree (#571) e não com outro.
 */
function envDoFilho(): NodeJS.ProcessEnv {
  const url = new URL(process.env.TEST_DB_URL as string);
  return {
    ...process.env,
    DATABASE_URL: process.env.TEST_DB_URL,
    POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    POSTGRES_DB: url.pathname.replace(/^\//, ''),
  };
}

type Saida = { code: number; stdout: string; stderr: string };

async function rodarCli(script: string, args: string[]): Promise<Saida> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, script, ...args], {
      cwd: RAIZ,
      env: envDoFilho(),
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

/** Apaga tudo que estas duas tuplas possam ter deixado — inclusive de uma rodada que morreu no meio. */
async function limpar(): Promise<void> {
  const tenants = [TENANT_A, TENANT_B];
  await pool.query('DELETE FROM import_entries WHERE tenant_id = ANY($1::text[])', [tenants]);
  await pool.query('DELETE FROM import_runs WHERE tenant_id = ANY($1::text[])', [tenants]);
  await pool.query('DELETE FROM transacoes WHERE tenant_id = ANY($1::text[])', [tenants]);
  await pool.query('DELETE FROM audit_log WHERE tenant_id = ANY($1::text[])', [tenants]);
  // `audit_log.pessoa_id` tem FK para `pessoas`, e uma row de auditoria pode
  // ter aterrissado no bucket `system` (é o que `audit()` faz quando NÃO há
  // contexto ativo — exatamente o caso do código de antes do conserto). Sem
  // este DELETE por pessoa, a limpeza de `pessoas` reprova por FK.
  await pool.query(
    'DELETE FROM audit_log WHERE pessoa_id IN (SELECT id FROM pessoas WHERE tenant_id = ANY($1::text[]))',
    [tenants],
  );
  await pool.query('DELETE FROM contas_bancarias WHERE tenant_id = ANY($1::text[])', [tenants]);
  await pool.query('DELETE FROM pessoas WHERE tenant_id = ANY($1::text[])', [tenants]);
  await pool.query('DELETE FROM entidades WHERE tenant_id = ANY($1::text[])', [tenants]);
}

/** Extrato OFX com N lançamentos. `marca` entra no FITID para deixar cada arquivo com sha256 próprio. */
function ofx(marca: string, n = 2): string {
  const linhas: string[] = [];
  for (let i = 1; i <= n; i++) {
    linhas.push(
      [
        '<STMTTRN>',
        `<TRNTYPE>${i % 2 === 0 ? 'CREDIT' : 'DEBIT'}`,
        `<DTPOSTED>2026010${i}`,
        `<TRNAMT>${i % 2 === 0 ? '' : '-'}${(100 + i).toFixed(2)}`,
        `<FITID>${marca}-${i}`,
        `<MEMO>LANCAMENTO ${marca} ${i}`,
        '</STMTTRN>',
      ].join('\n'),
    );
  }
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    '',
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
    '<DTSTART>20260101',
    '<DTEND>20260131',
    ...linhas,
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n');
}

async function arquivoOfx(marca: string, n = 2): Promise<string> {
  const p = join(dir, `${marca}.ofx`);
  await writeFile(p, ofx(marca, n), 'utf8');
  return p;
}

/** Insere uma `transacao` pendente e devolve o id. Usada para plantar o alvo cross-tenant. */
async function seedTransacao(
  tenant: string,
  agent: string,
  entidade: string,
  conta: string,
  descricao: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO transacoes
       (tenant_id, agent_id, entidade_id, conta_id, natureza, valor,
        data_competencia, status, descricao, origem)
     VALUES ($1,$2,$3,$4,'despesa','101.00','2026-01-01','pendente',$5,'manual')
     RETURNING id`,
    [tenant, agent, entidade, conta, descricao],
  );
  return rows[0]!.id;
}

/**
 * Planta uma `import_run` + uma `import_entry` 'matched' DIRETO no banco,
 * apontando para `alvo`. É assim que o ataque do caso (4) é montado: o
 * `matched_transacao_id` é um uuid vindo de uma LINHA DE DADOS, não de um
 * argumento do operador, então ele pode apontar para fora do escopo.
 */
async function seedRunComPonteiro(alvo: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO import_runs
       (tenant_id, agent_id, pessoa_id, entidade_id, conta_id, fonte,
        arquivo_sha256, arquivo_nome, total_lancamentos, matched, status)
     VALUES ($1,$2,$3,$4,$5,'ofx',$6,'plantado.ofx',1,1,'pending_review')
     RETURNING id`,
    [TENANT_A, AGENT_A, pessoaA, entidadeA, contaA, randomUUID().replace(/-/g, '')],
  );
  const run_id = rows[0]!.id;
  await pool.query(
    `INSERT INTO import_entries
       (tenant_id, agent_id, import_run_id, ordem, tipo_oper, valor, data_oper,
        fitid, memo, status, matched_transacao_id)
     VALUES ($1,$2,$3,1,'debit','101.00','2026-01-01',$4,'plantado','matched',$5)`,
    [TENANT_A, AGENT_A, run_id, `fit-${run_id}`, alvo],
  );
  return run_id;
}

d('#720 — CLIs de importação sob escopo de tenant (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await ensureTenantAgent(TENANT_A, AGENT_A);
    await ensureTenantAgent(TENANT_B, AGENT_B);
    await limpar();

    const ent = await pool.query<{ id: string; tenant_id: string }>(
      `INSERT INTO entidades(tenant_id, agent_id, nome, tipo) VALUES
         ($1,$2,'imp720 Entidade A','pf'), ($3,$4,'imp720 Entidade B','pf')
       RETURNING id, tenant_id`,
      [TENANT_A, AGENT_A, TENANT_B, AGENT_B],
    );
    entidadeA = ent.rows.find((r) => r.tenant_id === TENANT_A)!.id;
    entidadeB = ent.rows.find((r) => r.tenant_id === TENANT_B)!.id;

    const cta = await pool.query<{ id: string; tenant_id: string }>(
      `INSERT INTO contas_bancarias(tenant_id, agent_id, entidade_id, banco, apelido, tipo) VALUES
         ($1,$2,$3,'bco','imp720-conta-a','cc'), ($4,$5,$6,'bco','imp720-conta-b','cc')
       RETURNING id, tenant_id`,
      [TENANT_A, AGENT_A, entidadeA, TENANT_B, AGENT_B, entidadeB],
    );
    contaA = cta.rows.find((r) => r.tenant_id === TENANT_A)!.id;
    contaB = cta.rows.find((r) => r.tenant_id === TENANT_B)!.id;

    const pes = await pool.query<{ id: string; tenant_id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo) VALUES
         ($1,$2,'imp720 Pessoa A','+5511972000001','dono'),
         ($3,$4,'imp720 Pessoa B','+5511972000002','dono')
       RETURNING id, tenant_id`,
      [TENANT_A, AGENT_A, TENANT_B, AGENT_B],
    );
    pessoaA = pes.rows.find((r) => r.tenant_id === TENANT_A)!.id;

    dir = await mkdtemp(join(tmpdir(), 'imp720-'));
  }, PRAZO_MS);

  afterAll(async () => {
    if (pool) {
      await limpar();
      await pool.query('DELETE FROM agents WHERE id = ANY($1::text[])', [[AGENT_A, AGENT_B]]);
      await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[TENANT_A, TENANT_B]]);
      await pool.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  }, PRAZO_MS);

  it(
    '(1) import:ofx cria a run e as entries sob a tupla declarada — o caminho que estava MORTO desde a 083',
    async () => {
      const file = await arquivoOfx('caso1');
      const r = await rodarCli(SCRIPT_OFX, [
        `--tenant=${TENANT_A}`,
        `--agent=${AGENT_A}`,
        `--pessoa=${pessoaA}`,
        `--conta=${contaA}`,
        `--file=${file}`,
      ]);
      expect(`${r.code} ${r.stderr}`).toBe('0 ');
      expect(r.stdout).toMatch(/imported run=[0-9a-f-]{36}: total=2/);

      const runs = await pool.query<{ id: string; tenant_id: string; agent_id: string }>(
        'SELECT id, tenant_id, agent_id FROM import_runs WHERE conta_id = $1',
        [contaA],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]!.tenant_id).toBe(TENANT_A);
      expect(runs.rows[0]!.agent_id).toBe(AGENT_A);

      const entries = await pool.query<{ tenant_id: string; agent_id: string }>(
        'SELECT tenant_id, agent_id FROM import_entries WHERE import_run_id = $1',
        [runs.rows[0]!.id],
      );
      expect(entries.rows).toHaveLength(2);
      for (const e of entries.rows) {
        expect(e.tenant_id).toBe(TENANT_A);
        expect(e.agent_id).toBe(AGENT_A);
      }
    },
    PRAZO_MS,
  );

  it(
    '(2) o escopo declarado é verificado contra o dono da conta — recusa a conta alheia E aceita a própria, no MESMO it',
    async () => {
      // ── CONTROLE: a mesma invocação, com a conta QUE PERTENCE ao escopo
      //    declarado, precisa SUCEDER. Sem ele, uma CLI que recusasse tudo
      //    (inclusive uma quebrada) passaria neste caso.
      const fileCtrl = await arquivoOfx('caso2-controle');
      const controle = await rodarCli(SCRIPT_OFX, [
        `--tenant=${TENANT_A}`,
        `--agent=${AGENT_A}`,
        `--pessoa=${pessoaA}`,
        `--conta=${contaA}`,
        `--file=${fileCtrl}`,
      ]);
      expect(`controle: ${controle.code} ${controle.stderr}`).toBe('controle: 0 ');

      // ── SONDA: mesma tupla declarada, conta do OUTRO tenant → recusa.
      const fileSonda = await arquivoOfx('caso2-sonda');
      const sonda = await rodarCli(SCRIPT_OFX, [
        `--tenant=${TENANT_A}`,
        `--agent=${AGENT_A}`,
        `--pessoa=${pessoaA}`,
        `--conta=${contaB}`,
        `--file=${fileSonda}`,
      ]);
      expect(sonda.code).not.toBe(0);
      expect(sonda.stderr).toContain('não existe sob o escopo declarado');

      // E nada foi escrito para a conta do tenant B.
      const doB = await pool.query('SELECT id FROM import_runs WHERE conta_id = $1', [contaB]);
      expect(doB.rows).toHaveLength(0);

      // ── SONDA 2: sem --tenant/--agent a CLI falha FECHADA (exit 2), sem
      //    default e sem escrever.
      const semEscopo = await rodarCli(SCRIPT_OFX, [
        `--pessoa=${pessoaA}`,
        `--conta=${contaA}`,
        `--file=${fileSonda}`,
      ]);
      expect(semEscopo.code).toBe(2);
      expect(semEscopo.stderr).toContain('--tenant');
    },
    PRAZO_MS,
  );

  it(
    '(3) import:apply roda sob escopo — recusa a run alheia E aplica a própria, no MESMO it',
    async () => {
      const file = await arquivoOfx('caso3');
      const ing = await rodarCli(SCRIPT_OFX, [
        `--tenant=${TENANT_A}`,
        `--agent=${AGENT_A}`,
        `--pessoa=${pessoaA}`,
        `--conta=${contaA}`,
        `--file=${file}`,
      ]);
      expect(`${ing.code} ${ing.stderr}`).toBe('0 ');
      const run_id = /imported run=([0-9a-f-]{36})/.exec(ing.stdout)![1]!;

      // ── SONDA: o tenant B não enxerga nem aplica a run do tenant A.
      const listaB = await rodarCli(SCRIPT_REVIEW, [
        'list',
        `--tenant=${TENANT_B}`,
        `--agent=${AGENT_B}`,
      ]);
      expect(listaB.code).toBe(0);
      expect(listaB.stdout).not.toContain(run_id);

      const applyB = await rodarCli(SCRIPT_REVIEW, [
        'apply',
        `--tenant=${TENANT_B}`,
        `--agent=${AGENT_B}`,
        `--run=${run_id}`,
      ]);
      expect(applyB.code).not.toBe(0);
      expect(applyB.stderr).toContain('não existe sob o escopo declarado');

      const meio = await pool.query<{ status: string }>(
        'SELECT status FROM import_runs WHERE id = $1',
        [run_id],
      );
      expect(meio.rows[0]!.status).toBe('pending_review');

      // ── CONTROLE: o dono aplica, e as transações nascem com a tupla certa.
      const applyA = await rodarCli(SCRIPT_REVIEW, [
        'apply',
        `--tenant=${TENANT_A}`,
        `--agent=${AGENT_A}`,
        `--run=${run_id}`,
      ]);
      expect(`controle: ${applyA.code} ${applyA.stderr}`).toBe('controle: 0 ');
      expect(applyA.stdout).toContain('created=2');
      expect(applyA.stdout).toContain('status=aplicado');

      const criadas = await pool.query<{ tenant_id: string; agent_id: string }>(
        `SELECT tenant_id, agent_id FROM transacoes
          WHERE metadata->>'import_run_id' = $1`,
        [run_id],
      );
      expect(criadas.rows).toHaveLength(2);
      for (const t of criadas.rows) {
        expect(t.tenant_id).toBe(TENANT_A);
        expect(t.agent_id).toBe(AGENT_A);
      }
    },
    PRAZO_MS,
  );

  it(
    '(4) o UPDATE de transacoes é escopado — ponteiro cross-tenant NÃO sobrescreve a linha do outro tenant, e o ponteiro legítimo é aplicado, no MESMO it',
    async () => {
      // Alvos: um em cada tenant, ambos 'pendente' e sem data_pagamento.
      const alvoA = await seedTransacao(TENANT_A, AGENT_A, entidadeA, contaA, 'imp720 alvo A');
      const alvoB = await seedTransacao(TENANT_B, AGENT_B, entidadeB, contaB, 'imp720 alvo B');

      // ── CONTROLE: entry do tenant A apontando para a transação do tenant A.
      //    Precisa ser APLICADA — senão "recusa sempre" também passaria.
      const runCtrl = await seedRunComPonteiro(alvoA);
      const ctrl = await rodarCli(SCRIPT_REVIEW, [
        'apply',
        `--tenant=${TENANT_A}`,
        `--agent=${AGENT_A}`,
        `--run=${runCtrl}`,
      ]);
      expect(`controle: ${ctrl.code} ${ctrl.stderr}`).toBe('controle: 0 ');
      const depoisA = await pool.query<{ status: string; data_pagamento: string | null }>(
        'SELECT status, data_pagamento FROM transacoes WHERE id = $1',
        [alvoA],
      );
      expect(depoisA.rows[0]!.status).toBe('paga');
      expect(depoisA.rows[0]!.data_pagamento).not.toBeNull();

      // ── SONDA: entry do tenant A apontando para a transação do tenant B.
      //    Este é o ataque que `WHERE id = $1` permitia. A CLI tem de recusar
      //    e a linha do tenant B tem de ficar INTACTA.
      const runSonda = await seedRunComPonteiro(alvoB);
      const sonda = await rodarCli(SCRIPT_REVIEW, [
        'apply',
        `--tenant=${TENANT_A}`,
        `--agent=${AGENT_A}`,
        `--run=${runSonda}`,
      ]);
      // A asserção do VAZAMENTO vem ANTES da do código de saída de propósito:
      // é ela que tem de nomear o defeito quando o `WHERE id = $1` voltar. Com
      // o predicado só por id, a linha do tenant B é sobrescrita e a CLI ainda
      // sai com 0 — o dano aparece aqui primeiro.
      const depoisB = await pool.query<{
        status: string;
        data_pagamento: string | null;
        confirmada_em: Date | null;
        metadata: Record<string, unknown>;
      }>('SELECT status, data_pagamento, confirmada_em, metadata FROM transacoes WHERE id = $1', [
        alvoB,
      ]);
      const b = depoisB.rows[0]!;
      expect(b.status).toBe('pendente');
      expect(b.data_pagamento).toBeNull();
      expect(b.confirmada_em).toBeNull();
      expect(b.metadata).not.toHaveProperty('import_run_id');

      expect(sonda.code).not.toBe(0);

      // A transação abortou inteira: a run da sonda continua pendente e a
      // entry não foi marcada como resolvida.
      const runDepois = await pool.query<{ status: string }>(
        'SELECT status FROM import_runs WHERE id = $1',
        [runSonda],
      );
      expect(runDepois.rows[0]!.status).toBe('pending_review');
      const entryDepois = await pool.query<{ resolved_at: Date | null }>(
        'SELECT resolved_at FROM import_entries WHERE import_run_id = $1',
        [runSonda],
      );
      expect(entryDepois.rows[0]!.resolved_at).toBeNull();
    },
    PRAZO_MS,
  );
});
