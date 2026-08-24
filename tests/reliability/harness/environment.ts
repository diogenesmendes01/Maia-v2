/**
 * Issue #510 — `ReliabilityEnvironment`: Postgres, Redis, migrations e seeds
 * isolados por suíte, e uma faxina que só consegue acertar o que ela criou.
 *
 * ═══ A decisão: service containers do CI, NÃO Testcontainers ═══════════════
 *
 * A issue manda escolher e documentar. A escolha é **reusar a infraestrutura já
 * provisionada** (service containers no CI, pilha compartilhada local) e
 * isolar por **banco + prefixo de fila**, não por container. O argumento
 * completo está em `tests/reliability/README.md`; o resumo operacional é:
 *
 *  - o job `integration` do CI já sobe `pgvector/pgvector:pg16` e `redis:7`
 *    como service containers, e o `docker daemon` NÃO está disponível dentro
 *    dele. Testcontainers exigiria um job novo, com Docker-in-Docker, e o
 *    tempo de subir container por suíte se somaria ao de aplicar 125+
 *    migrations em cada um;
 *  - a #571 já resolveu o isolamento por worktree com banco próprio e db
 *    lógico do Redis próprio. Reusar esse mecanismo dá equivalência
 *    local/CI de graça — a MESMA função (`resolveTestEnv`) decide o alvo nos
 *    dois lugares;
 *  - o que Testcontainers daria a mais é isolamento de PROCESSO do servidor.
 *    Nenhum cenário FI da matriz precisa derrubar o Postgres inteiro; os que
 *    modelam "Postgres indisponível" derrubam a CONEXÃO do worker, que é
 *    fiel ao modo como a falha acontece em produção e não exige matar o
 *    servidor de todo mundo.
 *
 * O `@testcontainers/postgresql` continua no `package.json` e continua servindo
 * a única spec que o usa. Esta decisão não o remove; ela decide que o harness
 * de confiabilidade não depende dele.
 *
 * ═══ Por que a faxina é a parte perigosa ═══════════════════════════════════
 *
 * `DROP DATABASE` e `DEL` em massa são as duas operações deste repositório com
 * potencial de destruir trabalho alheio — há ~60 worktrees contra o MESMO
 * Postgres e o MESMO Redis. Por isso `assertAlvoDestrutivo()` roda ANTES de
 * qualquer comando destrutivo e verifica quatro coisas independentes: perfil
 * não é produção, host está na lista, o NOME DO BANCO carrega o marcador
 * `_fi_` que só este harness produz, e o prefixo de fila casa com o padrão do
 * harness. Falhar qualquer uma aborta sem executar nada.
 *
 * A faxina do Redis é por `SCAN`+`DEL` no prefixo, nunca `FLUSHDB`: o db lógico
 * é da WORKTREE, e outras suítes da mesma árvore podem estar rodando nele.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { arquivoDoPacote } from '../../helpers/pkg-path.js';
import {
  databaseNameOf,
  resolveTestEnv,
  resolveWorktreeScope,
  sanitizarUrl,
} from '../../helpers/worktree-scope.js';
import { ArtifactCollector } from './artifacts.js';
import { sanitizarTexto } from './sanitize.js';

/**
 * O marcador que separa um banco DESTE harness de qualquer outro banco do
 * servidor. Ele aparece no nome do banco e é condição necessária para
 * `DROP DATABASE`.
 */
export const MARCADOR_DE_BANCO = '_fi_';

/** Prefixo de fila do harness. Condição necessária para a faxina do Redis. */
export const PREFIXO_DE_FILA = 'fi_';

/**
 * Hosts onde é aceitável destruir. `localhost`/loopback cobre a worktree e o
 * service container do CI (que o runner expõe em `localhost`). Um host novo
 * entra por env — com prefixo `TEST_`, ver `failpoints.ts`.
 */
export const HOSTS_PERMITIDOS_ENV = 'TEST_RELIABILITY_ALLOWED_DB_HOSTS';
const HOSTS_PADRAO = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** Nomes que nunca são alvo, mesmo que alguém consiga fabricar o marcador. */
const NOMES_PROIBIDOS = new Set(['postgres', 'template0', 'template1', 'maia', 'maia_prod']);

export class AlvoDestrutivoInvalidoError extends Error {
  readonly motivos: readonly string[];
  constructor(motivos: readonly string[], alvo: { database: string; host: string; queuePrefix: string }) {
    super(
      `Faxina RECUSADA para database="${alvo.database}" host="${alvo.host}" ` +
        `queuePrefix="${alvo.queuePrefix}". Motivos: ${motivos.join('; ')}.`,
    );
    this.name = 'AlvoDestrutivoInvalidoError';
    this.motivos = motivos;
  }
}

function hostsPermitidos(env: Readonly<Record<string, string | undefined>>): string[] {
  const extra = (env[HOSTS_PERMITIDOS_ENV] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...HOSTS_PADRAO, ...extra];
}

/**
 * Slug estável e curto a partir do nome da suíte. Só `[a-z0-9_]`, porque é
 * identificador de banco Postgres e prefixo de chave do Redis ao mesmo tempo.
 */
export function suiteSlug(nome: string): string {
  const s = nome
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  if (s.length === 0) throw new Error(`Nome de suíte sem caractere utilizável: ${JSON.stringify(nome)}`);
  return s;
}

/**
 * Nome do banco desta suíte. O limite de identificador do Postgres é 63 bytes;
 * estourá-lo faz o servidor TRUNCAR em silêncio, e um nome truncado é um nome
 * que o `assertAlvoDestrutivo` pode não reconhecer mais. Truncamos nós, com o
 * marcador preservado.
 */
export function nomeDeBancoDaSuite(base: string, nomeDaSuite: string): string {
  const slug = suiteSlug(nomeDaSuite);
  const sufixo = `${MARCADOR_DE_BANCO}${slug}`;
  const espacoParaBase = 63 - sufixo.length;
  if (espacoParaBase < 1) {
    throw new Error(`Nome de suíte longo demais para caber num identificador do Postgres: ${nomeDaSuite}`);
  }
  return `${base.slice(0, espacoParaBase)}${sufixo}`;
}

/** Prefixo de fila BullMQ desta suíte. */
export function prefixoDeFilaDaSuite(nomeDaSuite: string): string {
  return `${PREFIXO_DE_FILA}${suiteSlug(nomeDaSuite)}`;
}

export interface AlvoDestrutivo {
  databaseUrl: string;
  queuePrefix: string;
}

/**
 * A tranca. Roda antes de `DROP DATABASE`, antes de `TRUNCATE` e antes de
 * qualquer `DEL` no Redis. Não devolve booleano de propósito — quem chama não
 * tem como esquecer de checar.
 */
export function assertAlvoDestrutivo(
  alvo: AlvoDestrutivo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const motivos: string[] = [];

  let host = '(ilegível)';
  let database = '(ilegível)';
  try {
    const u = new URL(alvo.databaseUrl);
    host = u.hostname.toLowerCase();
    database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    motivos.push('databaseUrl não é uma URL válida');
  }

  if (env.MAIA_ENV === 'production' || env.NODE_ENV === 'production') {
    motivos.push('o processo está em perfil de produção (MAIA_ENV/NODE_ENV = production)');
  }
  if (host !== '(ilegível)' && !hostsPermitidos(env).includes(host)) {
    motivos.push(
      `host "${host}" não está na lista de destinos destrutíveis ` +
        `(${hostsPermitidos(env).join(', ')}; amplie por ${HOSTS_PERMITIDOS_ENV})`,
    );
  }
  if (database !== '(ilegível)') {
    if (NOMES_PROIBIDOS.has(database)) {
      motivos.push(`"${database}" está na lista de bancos que nunca são alvo`);
    }
    if (!database.includes(MARCADOR_DE_BANCO)) {
      motivos.push(
        `o nome do banco não carrega o marcador "${MARCADOR_DE_BANCO}" — ` +
          'só bancos criados por este harness são destruídos por ele',
      );
    }
    if (!/^[a-z0-9_]+$/.test(database)) {
      motivos.push(`"${database}" tem caractere fora de [a-z0-9_]`);
    }
  }
  if (!new RegExp(`^${PREFIXO_DE_FILA}[a-z0-9_]+$`).test(alvo.queuePrefix)) {
    motivos.push(
      `o prefixo de fila "${alvo.queuePrefix}" não casa com "${PREFIXO_DE_FILA}<slug>" — ` +
        'a faxina do Redis é por prefixo, e um prefixo largo apagaria fila de outra árvore',
    );
  }

  if (motivos.length > 0) {
    throw new AlvoDestrutivoInvalidoError(motivos, { database, host, queuePrefix: alvo.queuePrefix });
  }
}

export interface SeedDeTenant {
  tenantId: string;
  agentId: string;
}

export interface OpcoesDoAmbiente {
  /** Nome da suíte — vira o slug do banco e do prefixo de fila. */
  suite: string;
  /** Tenants/agents explícitos. A issue exige que sejam distintos e nomeados. */
  tenants?: readonly SeedDeTenant[];
  artefatos?: ArtifactCollector;
  /** Prazo do runner de migrations. Default 300s (125+ migrations num banco novo). */
  migrationTimeoutMs?: number;
}

export interface EstadoDoAmbiente {
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly redisUrl: string;
  readonly queuePrefix: string;
  readonly tenants: readonly SeedDeTenant[];
}

/**
 * Resolve o alvo desta suíte SEM tocar em nada. Pura o suficiente para o
 * self-test rodar sem Postgres — e é por isso que a tranca da faxina pode ser
 * provada numa máquina sem infra.
 */
export function resolverAlvoDaSuite(
  suite: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { databaseUrl: string; databaseName: string; redisUrl: string; queuePrefix: string } {
  const scope = resolveWorktreeScope();
  const ambiente = resolveTestEnv(env, scope);
  const baseUrl = ambiente.DATABASE_URL;
  const base = databaseNameOf(baseUrl);
  const databaseName = nomeDeBancoDaSuite(base, suite);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return {
    databaseUrl: url.toString(),
    databaseName,
    redisUrl: ambiente.REDIS_URL,
    queuePrefix: prefixoDeFilaDaSuite(suite),
  };
}

/** Conexão de manutenção: o MESMO servidor, no banco `postgres`. */
function urlDeManutencao(scopedUrl: string): string {
  const url = new URL(scopedUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * O ambiente vivo. Só existe quando há Postgres e Redis de verdade — em
 * máquina sem infra, `criar()` falha CEDO e com mensagem acionável, jamais
 * vira `skip` silencioso (a issue proíbe isso nominalmente para o job
 * obrigatório).
 */
export class ReliabilityEnvironment {
  readonly estado: EstadoDoAmbiente;
  private readonly artefatos: ArtifactCollector | undefined;
  private derrubado = false;
  private criado = false;

  private constructor(estado: EstadoDoAmbiente, artefatos: ArtifactCollector | undefined) {
    this.estado = estado;
    this.artefatos = artefatos;
  }

  static async criar(opts: OpcoesDoAmbiente): Promise<ReliabilityEnvironment> {
    const alvo = resolverAlvoDaSuite(opts.suite);
    const tenants = opts.tenants ?? [
      { tenantId: `fi-${suiteSlug(opts.suite)}-a`, agentId: `fi-${suiteSlug(opts.suite)}-agent-a` },
      { tenantId: `fi-${suiteSlug(opts.suite)}-b`, agentId: `fi-${suiteSlug(opts.suite)}-agent-b` },
    ];
    // A tranca roda ANTES de criar: se o alvo não for destruível, ele também
    // não é criável — não queremos deixar um banco que a faxina não alcança.
    assertAlvoDestrutivo({ databaseUrl: alvo.databaseUrl, queuePrefix: alvo.queuePrefix });

    const env = new ReliabilityEnvironment(
      {
        databaseUrl: alvo.databaseUrl,
        databaseName: alvo.databaseName,
        redisUrl: alvo.redisUrl,
        queuePrefix: alvo.queuePrefix,
        tenants,
      },
      opts.artefatos,
    );
    await env.provisionar(opts.migrationTimeoutMs ?? 300_000);
    return env;
  }

  private async provisionar(migrationTimeoutMs: number): Promise<void> {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: urlDeManutencao(this.estado.databaseUrl) });
    await admin.connect();
    try {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        this.estado.databaseName,
      ]);
      if (rowCount === 0) {
        await admin.query(`CREATE DATABASE "${this.estado.databaseName.replace(/"/g, '""')}"`);
      }
    } finally {
      await admin.end();
    }
    this.criado = true;
    this.artefatos?.evento('env.database_ready', { database: this.estado.databaseName });

    await this.migrar(migrationTimeoutMs);
    await this.semear();
    this.artefatos?.evento('env.ready', {
      database: this.estado.databaseName,
      queuePrefix: this.estado.queuePrefix,
      tenants: this.estado.tenants.map((t) => `${t.tenantId}/${t.agentId}`),
    });
  }

  /**
   * MESMO runner de `scripts/migrate.ts` que o `tests/globalSetup.ts` usa —
   * não uma reimplementação. Um schema montado por caminho paralelo é um
   * schema que pode divergir do de produção sem ninguém notar.
   */
  private async migrar(timeoutMs: number): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const tsx = arquivoDoPacote('tsx', 'dist/cli.mjs', import.meta.url);
    const u = new URL(this.estado.databaseUrl);
    await run(process.execPath, [tsx, 'scripts/migrate.ts', 'up'], {
      cwd: resolveWorktreeScope()?.root ?? process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MAIA_ENV: 'development',
        DATABASE_URL: this.estado.databaseUrl,
        POSTGRES_USER: u.username,
        POSTGRES_PASSWORD: decodeURIComponent(u.password),
        POSTGRES_DB: this.estado.databaseName,
      },
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  /**
   * Seeds tenant/agent EXPLÍCITOS. A issue exige que nenhum cenário dependa do
   * literal `default` — os IDs saem daqui, nomeados, e o oracle afirma sobre
   * eles.
   */
  private async semear(): Promise<void> {
    const pg = (await import('pg')).default;
    const cliente = new pg.Client({ connectionString: this.estado.databaseUrl });
    await cliente.connect();
    try {
      for (const t of this.estado.tenants) {
        await cliente.query(
          `INSERT INTO tenants (id, nome) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [t.tenantId, `FI ${t.tenantId}`],
        );
        await cliente.query(
          `INSERT INTO agents (id, tenant_id, nome) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [t.agentId, t.tenantId, `FI ${t.agentId}`],
        );
      }
    } finally {
      await cliente.end();
    }
  }

  /**
   * Variáveis que um processo filho precisa para apontar para ESTE ambiente.
   * Passe direto em `SpawnOptions.env`.
   */
  envDoFilho(extra: Readonly<Record<string, string | undefined>> = {}): Record<string, string | undefined> {
    return {
      NODE_ENV: 'test',
      MAIA_ENV: 'development',
      DATABASE_URL: this.estado.databaseUrl,
      TEST_DB_URL: this.estado.databaseUrl,
      REDIS_URL: this.estado.redisUrl,
      TEST_RELIABILITY_QUEUE_PREFIX: this.estado.queuePrefix,
      ...extra,
    };
  }

  /**
   * Faxina IDEMPOTENTE. Segunda chamada é no-op; nenhuma chamada joga.
   *
   * As falhas de teardown vão para a timeline do artefato em vez de reprovarem
   * a suíte, porque um teardown que reprova esconde a causa real do vermelho —
   * mas elas ficam REGISTRADAS, que é o que a issue pede.
   */
  async derrubar(): Promise<void> {
    if (this.derrubado) return;
    this.derrubado = true;

    try {
      assertAlvoDestrutivo({
        databaseUrl: this.estado.databaseUrl,
        queuePrefix: this.estado.queuePrefix,
      });
    } catch (erro) {
      // Recusa de tranca NÃO é engolida: é o único caso em que a faxina grita.
      this.artefatos?.evento('teardown.recusado', {
        erro: sanitizarTexto(erro instanceof Error ? erro.message : String(erro)),
      });
      throw erro;
    }

    await this.limparRedis();
    await this.derrubarBanco();
  }

  private async limparRedis(): Promise<void> {
    try {
      const IORedis = (await import('ioredis')).default;
      const cliente = new IORedis(this.estado.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        retryStrategy: () => null,
      });
      cliente.on('error', () => {});
      try {
        await cliente.connect();
        // SCAN + DEL no PREFIXO. Nunca `FLUSHDB`: o db lógico é da worktree e
        // pode estar em uso por outra suíte da mesma árvore.
        let cursor = '0';
        do {
          const [proximo, chaves] = await cliente.scan(
            cursor,
            'MATCH',
            `${this.estado.queuePrefix}*`,
            'COUNT',
            500,
          );
          cursor = proximo;
          if (chaves.length > 0) await cliente.del(...chaves);
        } while (cursor !== '0');
      } finally {
        cliente.disconnect();
      }
    } catch (erro) {
      this.artefatos?.evento('teardown.error', {
        etapa: 'redis',
        alvo: this.estado.queuePrefix,
        erro: sanitizarTexto(erro instanceof Error ? erro.message : String(erro)),
      });
    }
  }

  private async derrubarBanco(): Promise<void> {
    if (!this.criado) return;
    try {
      const pg = (await import('pg')).default;
      const admin = new pg.Client({ connectionString: urlDeManutencao(this.estado.databaseUrl) });
      await admin.connect();
      try {
        // `WITH (FORCE)` derruba conexões pendentes de um filho que morreu por
        // SIGKILL sem fechar o pool — sem isso o DROP fica preso e a suíte
        // seguinte herda o banco.
        await admin.query(`DROP DATABASE IF EXISTS "${this.estado.databaseName.replace(/"/g, '""')}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
      this.artefatos?.evento('env.database_dropped', { database: this.estado.databaseName });
    } catch (erro) {
      // Uma tentativa a mais: o `WITH (FORCE)` do Postgres 13+ costuma
      // resolver, mas uma conexão nascendo na mesma janela ainda ganha a
      // corrida. Uma retentativa curta cobre isso sem virar laço.
      await sleep(250);
      try {
        const pg = (await import('pg')).default;
        const admin = new pg.Client({ connectionString: urlDeManutencao(this.estado.databaseUrl) });
        await admin.connect();
        try {
          await admin.query(`DROP DATABASE IF EXISTS "${this.estado.databaseName.replace(/"/g, '""')}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      } catch (erro2) {
        this.artefatos?.evento('teardown.error', {
          etapa: 'drop_database',
          alvo: this.estado.databaseName,
          erro: sanitizarTexto(erro2 instanceof Error ? erro2.message : String(erro2)),
          primeiroErro: sanitizarTexto(erro instanceof Error ? erro.message : String(erro)),
        });
      }
    }
  }

  /** Descrição sanitizada para o relatório do cenário. */
  descricao(): Record<string, unknown> {
    return {
      database: this.estado.databaseName,
      servidor: sanitizarUrl(this.estado.databaseUrl),
      redis: sanitizarUrl(this.estado.redisUrl),
      queuePrefix: this.estado.queuePrefix,
      tenants: this.estado.tenants.map((t) => `${t.tenantId}/${t.agentId}`),
    };
  }
}
