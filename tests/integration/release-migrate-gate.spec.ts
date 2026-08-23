/**
 * Issue #565 — o gate de migration fora do Compose, EXECUTADO.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que este arquivo existe, e o que ele prova que o unitário não prova
 * ─────────────────────────────────────────────────────────────────────────
 * `tests/unit/migrations/release-gate.spec.ts` exercita a biblioteca com um
 * `run` injetado: ele prova a decisão (qual comando, qual ambiente, qual exit
 * code) sem nunca criar um processo. A #565 pede prova de RUNTIME — "um
 * migrate que falha tem de impedir a subida, demonstrado". Então aqui:
 *
 *   - o comando é o documentado (`npm run release:migrate`), num processo de
 *     verdade, contra um Postgres de verdade, num banco DESCARTÁVEL criado e
 *     apagado por este arquivo;
 *   - a filtragem do ambiente é medida por um DISCRIMINADOR, não por
 *     inspeção: `MAIA_*` desconhecida no ambiente faz `loadMigrationConfig()`
 *     recusar e o migrator sair 2 (`src/config/validate.ts`, regra
 *     `contract/unknown`). Mesmo comando, mesmo banco, mesma variável: SEM o
 *     gate sai 2, COM o gate sai 0. A diferença é o filtro, e não há como
 *     esse teste passar sem ele;
 *   - o encadeamento `gate && consumidor` é rodado num shell: com o ledger
 *     quebrado o consumidor NÃO executa, e o marcador que ele escreveria não
 *     existe no disco. Esse é o análogo executável de
 *     `service_completed_successfully` para um orquestrador que não a tem.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE ESTE ARQUIVO NÃO PROVA
 * ─────────────────────────────────────────────────────────────────────────
 * Que um painel de deploy (Coolify) chama este comando antes do rollout e
 * desiste quando ele sai != 0. Isso exige uma instância do painel, não existe
 * neste host, e está marcado como NÃO VERIFICADO em
 * `docs/runbooks/deploy-prod.md` §7. Um teste que "provasse" isso estaria
 * mentindo.
 *
 * Sem `TEST_DB_URL` o arquivo faz `describe.skip` — pulado NÃO é passou.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const REPO_ROOT = resolve(__dirname, '../..');
const ADMIN_URL = process.env.TEST_DB_URL;
const d = ADMIN_URL ? describe : describe.skip;

/**
 * 60s por caso. Medido nesta máquina: um run completo do gate contra banco
 * vazio (npm → tsx → 125 migrations) leva ~5s, e o caminho bloqueado ~2s. A
 * folga cobre um runner de CI mais lento sem cegar regressão — o teto do
 * arquivo continua sendo uma ordem de grandeza abaixo do que uma suíte de
 * deploy custaria.
 */
const CASE_TIMEOUT_MS = 60_000;

/** Nome único: o banco `maia_test` é compartilhado e não pode ser tocado. */
const DISPOSABLE_DB = `maia_relgate_${process.pid}_${Date.now()}`;

function disposableUrl(): string {
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${DISPOSABLE_DB}`;
  return url.toString();
}

/** Migrations forward que ESTE checkout empacota — o alvo do ledger. */
function forwardMigrationCount(): number {
  return readdirSync(join(REPO_ROOT, 'migrations')).filter(
    (f) => f.endsWith('.sql') && !f.endsWith('_down.sql'),
  ).length;
}

/**
 * O ambiente que um painel com UM editor de variáveis por aplicação entrega
 * ao passo de migration: o subset do migrator MAIS os segredos de `app`.
 * Nenhum valor aqui é real.
 *
 * A forma `fixture-fixture-*` mantém a entropia de Shannon abaixo de 3.5, que
 * é o corte da regra `generic-api-key` do gitleaks — ver a nota equivalente em
 * `tests/unit/migrations/release-gate.spec.ts`.
 */
function orchestratorEnv(extra: Record<string, string> = {}): Record<string, string> {
  const url = new URL(disposableUrl());
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/root',
    NODE_ENV: 'production',
    MAIA_ENV: 'production',
    DATABASE_URL: disposableUrl(),
    POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    POSTGRES_DB: DISPOSABLE_DB,
    TZ: 'America/Sao_Paulo',
    // Segredos que o migrator não pode receber (#515) — chegam aqui porque o
    // painel não sabe injetar "só um pedaço".
    ANTHROPIC_API_KEY: 'fixture-fixture-llm',
    BACKUP_S3_SECRET_KEY: 'fixture-fixture-s3',
    NEXTAUTH_SECRET: 'fixture-fixture-auth',
    ...extra,
  };
}

interface Ran {
  readonly status: number;
  readonly output: string;
}

function run(command: string, args: readonly string[], env: Record<string, string>): Ran {
  const r = spawnSync(command, [...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    // O gate usa `stdio: 'inherit'` para o filho; aqui capturamos os dois
    // lados para poder afirmar sobre o log que o operador veria.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** O comando documentado em `docs/runbooks/deploy-prod.md` §7. */
const GATE = ['npm', 'run', 'release:migrate'] as const;
/** O migrator cru — o que roda HOJE quando alguém pula o gate. */
const RAW = ['npm', 'run', 'db:migrate'] as const;

d('release gate (#565) — executado contra um Postgres real', () => {
  let admin: pg.Pool;
  let disposable: pg.Pool | null = null;
  let markerDir = '';

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE "${DISPOSABLE_DB}"`);
    disposable = new pg.Pool({ connectionString: disposableUrl() });
    markerDir = mkdtempSync(join(tmpdir(), 'maia-relgate-'));
  });

  afterAll(async () => {
    await disposable?.end().catch(() => undefined);
    // Sem isto o DROP falha com "is being accessed by other users" e o banco
    // descartável fica para trás num Postgres compartilhado.
    await admin
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [DISPOSABLE_DB])
      .catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${DISPOSABLE_DB}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  });

  async function ledgerCount(status: string): Promise<number> {
    const r = await (disposable as pg.Pool).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migrations WHERE status = $1`,
      [status],
    );
    return Number(r.rows[0]?.n ?? '-1');
  }

  it(
    'caminho feliz: sai 0, aplica o schema inteiro e NOMEIA o que reteve',
    async () => {
      const ran = run(GATE[0], GATE.slice(1), orchestratorEnv());
      expect(ran.status, `saída do gate:\n${ran.output}`).toBe(0);
      expect(await ledgerCount('applied')).toBe(forwardMigrationCount());

      // O relatório do gate: nomes retidos, nunca valores.
      expect(ran.output).toContain('"event":"release_gate.env_scrubbed"');
      // A lista EXATA, e não um `toContain` do nome solto: com o filtro
      // desligado o nome continuaria aparecendo — na lista `passed`. Medido:
      // este caso passava verde com a allowlist neutralizada até a asserção
      // virar a lista inteira.
      expect(ran.output).toContain(
        '"withheld_contract":["ANTHROPIC_API_KEY","BACKUP_S3_SECRET_KEY","NEXTAUTH_SECRET"]',
      );
      expect(ran.output).toContain('"event":"release_gate.passed"');
      for (const secret of ['fixture-fixture-llm', 'fixture-fixture-s3', 'fixture-fixture-auth']) {
        expect(ran.output, 'um valor de segredo apareceu no log do deploy').not.toContain(secret);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'a filtragem é REAL: a mesma variável derruba o migrator cru e não chega nele pelo gate',
    async () => {
      // `MAIA_LEFTOVER_FROM_APP_ENV` não existe no contrato. `validate.ts`
      // recusa qualquer chave `MAIA_*` desconhecida (regra `contract/unknown`),
      // então o migrator que a RECEBE sai 2 antes de tocar no banco.
      const polluted = orchestratorEnv({ MAIA_LEFTOVER_FROM_APP_ENV: '1' });

      const raw = run(RAW[0], RAW.slice(1), polluted);
      expect(raw.status, `o migrator cru deveria recusar:\n${raw.output}`).toBe(2);
      expect(raw.output).toContain('MAIA_LEFTOVER_FROM_APP_ENV');
      expect(raw.output).toContain('contract/unknown');

      const gated = run(GATE[0], GATE.slice(1), polluted);
      expect(
        gated.status,
        `mesma variável, mesmo comando, mesmo banco — o gate deveria tê-la retido:\n${gated.output}`,
      ).toBe(0);
      // O gate a reteve — e a NOMEIA, na categoria própria: quem lê o log do
      // deploy precisa saber que a variável existe e que o migrator a teria
      // recusado.
      expect(gated.output).toContain('"withheld_unknown_maia":["MAIA_LEFTOVER_FROM_APP_ENV"]');
      expect(gated.output).not.toContain('contract/unknown');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'um migrate que FALHA sai != 0 (ledger sujo, o blocker que a #516 desenhou)',
    async () => {
      const head = await (disposable as pg.Pool).query<{ id: string }>(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      );
      const id = head.rows[0]?.id;
      expect(id, 'o caminho feliz precisa ter rodado antes deste caso').toBeTruthy();
      await (disposable as pg.Pool).query(`UPDATE schema_migrations SET status = 'dirty' WHERE id = $1`, [id]);

      const ran = run(GATE[0], GATE.slice(1), orchestratorEnv());
      expect(ran.status, `um ledger sujo tem de bloquear:\n${ran.output}`).not.toBe(0);
      expect(ran.output).toContain('"event":"migration.blocked"');
      expect(ran.output).toContain('"event":"release_gate.failed"');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'com o gate falhando, o consumidor encadeado NÃO executa',
    async () => {
      // O ledger continua sujo (caso anterior). `gate && consumidor` é a
      // tradução de `service_completed_successfully` para um orquestrador que
      // só sabe rodar um comando de start: quem faz o `&&` valer é o shell.
      const marker = join(markerDir, 'consumer-started');
      expect(existsSync(marker)).toBe(false);

      const ran = run('sh', ['-c', `${GATE.join(' ')} && printf started > "$MAIA_TEST_MARKER"`], {
        ...orchestratorEnv(),
        MAIA_TEST_MARKER: marker,
      });

      expect(ran.status, `o encadeamento deveria falhar:\n${ran.output}`).not.toBe(0);
      // Pelo motivo certo: o blocker de migration, e não uma recusa de
      // configuração provocada pela própria variável de marcação.
      expect(ran.output).toContain('"event":"migration.blocked"');
      expect(
        existsSync(marker),
        'o consumidor rodou depois de um migrate que falhou — o gate não segurou nada',
      ).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'com o gate passando, o consumidor encadeado executa',
    async () => {
      // A outra metade: um teste que só mostra o consumidor parado não
      // distingue "o gate bloqueou" de "o encadeamento nunca funciona".
      await (disposable as pg.Pool).query(`UPDATE schema_migrations SET status = 'applied' WHERE status = 'dirty'`);
      const marker = join(markerDir, 'consumer-started-ok');

      const ran = run('sh', ['-c', `${GATE.join(' ')} && printf started > "$MAIA_TEST_MARKER"`], {
        ...orchestratorEnv(),
        MAIA_TEST_MARKER: marker,
      });

      expect(ran.status, `saída:\n${ran.output}`).toBe(0);
      expect(existsSync(marker)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});
