/**
 * `maia doctor` — PostgreSQL checks (issue #517 §3, "PostgreSQL").
 *
 * Every statement here goes through `ctx.postgres`, which wraps it in
 * `BEGIN READ ONLY … ROLLBACK` (`src/ops/doctor/postgres.ts`). A check author
 * cannot opt out of that, which is the point: read-only is a property of the
 * handle, not of the author's care.
 *
 * The schema verdict is NOT computed here. `postgres.schema_readiness`
 * delegates to `getSchemaReadiness()` (#516), the module that owns the
 * question, and reports its blockers verbatim — head, dirty, orphaned
 * `running`, checksum mismatch, checksum unknown, a migration the database
 * applied that this build does not ship. Re-deriving any of that from
 * `schema_migrations` here would be a second, divergent source of truth for
 * the single decision that gates production traffic.
 */
import { errorClass } from '../runner.js';
import { pass, skip, type DoctorCheck, type DoctorContext, type DoctorResult } from '../types.js';

/**
 * `--online` was asked for and there is no Postgres handle — a FAILURE, not a
 * skip, and this is the whole point of the distinction.
 *
 * The runner already turns every networked check into `skip` when the run is
 * offline, so reaching this branch means the operator DID ask for connected
 * checks and the CLI could not build a pool: `DATABASE_URL` absent or empty.
 * Reporting `skip` there is how `doctor --online --only postgres` used to skip
 * all six Postgres checks and still exit 0 saying `PRONTO` — a green gate over
 * a dependency it never opened.
 */
function noPostgresHandle(): DoctorResult {
  return {
    status: 'fail',
    summary: 'nenhum handle de Postgres foi aberto: `--online` foi pedido e DATABASE_URL está ausente ou vazia',
    evidence: { handle_open: false, requested_online: true },
    remediation: [
      'Defina DATABASE_URL no ambiente DESTE container e rode de novo com `--online`.',
      'Isto não é um `skip`: a dependência selecionada não foi exercida, então o gate não pode sair verde.',
    ],
  };
}

/** Server floor. Postgres 16 is what `compose.prod.yml` and CI both run. */
export const MINIMUM_PG_SERVER_VERSION_NUM = 160000;

/** Above this the local/server clock gap is worth an operator's attention. */
export const CLOCK_DRIFT_WARN_MS = 2_000;

export const connectivityCheck: DoctorCheck = {
  id: 'postgres.connectivity',
  category: 'postgres',
  criticality: 'blocker',
  describes: 'o banco responde a um SELECT trivial dentro do deadline',
  deadlineMs: 5_000,
  requiresNetwork: true,
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.postgres) return noPostgresHandle();
    const started = performance.now();
    let rows: readonly { one: number }[];
    try {
      rows = await ctx.postgres.query<{ one: number }>('SELECT 1 AS one');
    } catch (err) {
      // CLASS only, never the message: a `pg` error message embeds the whole
      // DSN, password included.
      const cls = errorClass(err);
      return {
        status: 'fail',
        summary: `Postgres inalcançável (${cls})`,
        evidence: { error_class: cls, latency_ms: Math.round(performance.now() - started) },
        remediation: [
          'Confirme que o serviço `postgres` está de pé e que host/porta de DATABASE_URL são alcançáveis a partir deste container.',
          cls === '28P01' || cls === '28000'
            ? 'A classe do erro indica AUTENTICAÇÃO: usuário ou senha do DATABASE_URL não conferem.'
            : cls === '3D000'
              ? 'A classe do erro indica BANCO INEXISTENTE: o nome do banco no DATABASE_URL não existe neste servidor.'
              : 'Verifique também regras de rede/firewall e se o container subiu na mesma rede do compose.',
        ],
      };
    }
    const latency = Math.round(performance.now() - started);
    if (rows[0]?.one !== 1) {
      return {
        status: 'fail',
        summary: 'o banco respondeu, mas não com o resultado esperado de `SELECT 1`',
        evidence: { latency_ms: latency },
        remediation: ['Verifique se o DATABASE_URL aponta para um PostgreSQL e não para um proxy.'],
      };
    }
    return pass(`conectado em ${latency}ms`, { latency_ms: latency });
  },
};

/**
 * The doctor proving its OWN read-only posture, in the report, on every run.
 *
 * `transaction_read_only` is what Postgres will actually enforce for the
 * statements the other checks issue. Printing it turns "read-only" from a
 * claim in a doc into evidence in the artifact the operator keeps.
 */
export const readOnlySessionCheck: DoctorCheck = {
  id: 'postgres.read_only_session',
  category: 'postgres',
  criticality: 'blocker',
  describes: 'as consultas do doctor rodam em transação READ ONLY imposta pelo servidor',
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['postgres.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.postgres) return noPostgresHandle();
    // `current_setting`, not `SHOW`: `SHOW transaction_read_only` names its
    // column after the GUC, and aliasing is not allowed on `SHOW`.
    const rows = await ctx.postgres.query<{ read_only: string }>(
      "SELECT current_setting('transaction_read_only') AS read_only",
    );
    const value = rows[0]?.read_only ?? 'unknown';
    if (value !== 'on') {
      return {
        status: 'fail',
        summary: `as consultas do doctor NÃO estão em transação read-only (transaction_read_only=${value})`,
        evidence: { transaction_read_only: value },
        remediation: [
          'Isto é um defeito do próprio doctor, não do ambiente: `readOnlyPostgres()` deveria abrir `BEGIN READ ONLY`. Não confie no resultado desta execução.',
        ],
      };
    }
    return pass('transação READ ONLY confirmada pelo servidor', { transaction_read_only: value });
  },
};

export const serverVersionCheck: DoctorCheck = {
  id: 'postgres.server_version',
  category: 'postgres',
  criticality: 'blocker',
  describes: `o servidor é PostgreSQL >= ${Math.floor(MINIMUM_PG_SERVER_VERSION_NUM / 10000)}`,
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['postgres.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.postgres) return noPostgresHandle();
    const rows = await ctx.postgres.query<{ num: string; version: string }>(
      "SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version",
    );
    const num = Number(rows[0]?.num ?? 0);
    const version = rows[0]?.version ?? 'unknown';
    if (!Number.isFinite(num) || num === 0) {
      return {
        status: 'fail',
        summary: 'não foi possível ler a versão do servidor',
        remediation: ['Verifique as permissões do usuário do doctor sobre `current_setting`.'],
      };
    }
    if (num < MINIMUM_PG_SERVER_VERSION_NUM) {
      return {
        status: 'fail',
        summary: `PostgreSQL ${version} está abaixo do piso suportado`,
        evidence: { server_version: version, server_version_num: num, minimum: MINIMUM_PG_SERVER_VERSION_NUM },
        remediation: [
          'Suba o servidor para a linha 16 antes de aplicar migrations desta release (`compose.prod.yml` fixa `postgres:16`).',
        ],
      };
    }
    return pass(`PostgreSQL ${version}`, { server_version: version, server_version_num: num });
  },
};

export const pgvectorCheck: DoctorCheck = {
  id: 'postgres.pgvector',
  category: 'postgres',
  criticality: 'blocker',
  describes: 'a extensão pgvector está INSTALADA neste banco',
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['postgres.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.postgres) return noPostgresHandle();
    const installed = await ctx.postgres.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    if (installed.length > 0) {
      return pass(`pgvector ${installed[0]?.extversion ?? '?'} instalada`, {
        extversion: installed[0]?.extversion ?? 'unknown',
      });
    }
    const available = await ctx.postgres.query<{ default_version: string }>(
      "SELECT default_version FROM pg_available_extensions WHERE name = 'vector'",
    );
    return {
      status: 'fail',
      summary:
        available.length > 0
          ? 'pgvector está disponível no servidor mas NÃO instalada neste banco'
          : 'pgvector não está instalada e não está disponível neste servidor',
      evidence: { installed: false, available: available.length > 0 },
      remediation:
        available.length > 0
          ? ['Rode o migrator: a migration 001 executa `CREATE EXTENSION IF NOT EXISTS vector`.']
          : [
              'Use uma imagem de Postgres com pgvector (`pgvector/pgvector:pg16`) ou instale o pacote no servidor. O doctor é read-only e não cria extensões.',
            ],
    };
  },
};

export const schemaReadinessCheck: DoctorCheck = {
  id: 'postgres.schema_readiness',
  category: 'postgres',
  criticality: 'blocker',
  describes:
    'o schema aplicado é compatível com ESTA build: head, dirty, running órfão e checksums',
  deadlineMs: 10_000,
  requiresNetwork: true,
  dependsOn: ['postgres.connectivity'],
  async run(ctx: DoctorContext, signal: AbortSignal): Promise<DoctorResult> {
    if (!ctx.schemaReadiness) {
      return {
        status: 'fail',
        summary:
          'o veredito de schema não foi ligado a um pool: `--online` foi pedido e DATABASE_URL está ausente ou vazia',
        evidence: { handle_open: false, requested_online: true },
        remediation: [
          'Defina DATABASE_URL no ambiente DESTE container e rode de novo com `--online`.',
          'Isto não é um `skip`: o estado do schema não foi consultado, então o gate não pode sair verde.',
        ],
      };
    }
    const verdict = await ctx.schemaReadiness(signal);
    const evidence = {
      state: verdict.state,
      expected_head: verdict.expected_head ?? 'unknown',
      applied_head: verdict.applied_head ?? 'none',
      pending: verdict.pending_count,
      dirty: verdict.dirty_count,
      blockers: [...new Set(verdict.blockers.map((b) => b.kind))].join(',') || 'none',
    };
    if (verdict.ready) {
      return pass(`schema pronto no head ${verdict.applied_head ?? 'unknown'}`, evidence);
    }
    return {
      status: 'fail',
      summary: verdict.reason ?? 'o estado do schema não pôde ser determinado',
      evidence,
      remediation: [
        'Rode o job de migration desta release ANTES de subir a aplicação (`npm run db:migrate`, ou o serviço `migrate` do compose).',
        'Para o detalhe por migration, sem alterar nada: `npm run db:migrate -- status`.',
        'Um estado `dirty` ou `checksum_mismatch` exige `migrate repair` explícito e auditado — o doctor é read-only e nunca repara.',
      ],
    };
  },
};

export const clockDriftCheck: DoctorCheck = {
  id: 'postgres.clock_drift',
  category: 'postgres',
  criticality: 'advisory',
  describes: 'o relógio deste processo e o do servidor de banco não divergiram',
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['postgres.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.postgres) return noPostgresHandle();
    // `clock_timestamp()`, not `now()`: `now()` is the TRANSACTION start time
    // and would fold our own round trip into the "drift".
    const before = Date.now();
    const rows = await ctx.postgres.query<{ ts: Date | string }>(
      'SELECT clock_timestamp() AS ts',
    );
    const after = Date.now();
    const raw = rows[0]?.ts;
    const serverMs = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    if (!Number.isFinite(serverMs)) {
      return skip('o servidor não devolveu um timestamp interpretável');
    }
    // Half the round trip is the honest correction for one-way latency.
    const localMs = before + (after - before) / 2;
    const drift = Math.round(serverMs - localMs);
    const evidence = { drift_ms: drift, round_trip_ms: after - before, threshold_ms: CLOCK_DRIFT_WARN_MS };
    if (Math.abs(drift) > CLOCK_DRIFT_WARN_MS) {
      return {
        status: 'warn',
        summary: `relógio do banco difere ${drift}ms do relógio local`,
        evidence,
        remediation: [
          'Sincronize NTP nos dois hosts. Janelas de lease, deduplicação e expiração comparam timestamps entre processos.',
        ],
      };
    }
    return pass(`relógios alinhados (${drift}ms)`, evidence);
  },
};

export const POSTGRES_CHECKS: readonly DoctorCheck[] = [
  connectivityCheck,
  readOnlySessionCheck,
  serverVersionCheck,
  pgvectorCheck,
  schemaReadinessCheck,
  clockDriftCheck,
];
