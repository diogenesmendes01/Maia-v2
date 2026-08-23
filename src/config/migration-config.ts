/**
 * Migration-runner configuration subset (issue #515; consumed by #516).
 *
 * The migrator gets Postgres + core process knobs and NOTHING else — no LLM
 * keys, no WhatsApp session, no S3 credentials, no alert transports. That is
 * the whole point of a per-service manifest: a migration container that leaks
 * cannot leak what it was never given.
 *
 * Side-effect free at import time.
 */
import { loadServiceConfig, type LoadOptions, type ServiceConfig } from '@/config/load.js';
import { manifestForService } from '@/config/services.js';
import type { MaiaProfile } from '@/config/metadata.js';
import type { RunOptions } from '@/migrations/runner.js';

export type MigrationConfig = ServiceConfig<'migrator'>;

/** Load + validate the migrator's configuration. Throws `ConfigValidationError`. */
export function loadMigrationConfig(options: LoadOptions = {}): MigrationConfig {
  return loadServiceConfig('migrator', options);
}

/**
 * Projeção contrato → `RunOptions` do runner (issue #516, pendência do runbook).
 *
 * Existe para que `src/migrations/` continue **sem ler `process.env`**: a
 * biblioteca recebe os tetos por injeção e mantém os próprios defaults para
 * quem a chama sem configuração (testes, `maia doctor`). Quem traduz ambiente
 * em opção é este adaptador, e o único caminho de produção que o chama é
 * `scripts/migrate.ts`.
 *
 * `0` significa **desligado** nos dois timeouts de statement, e é traduzido
 * para `null` — a forma com que o runner já expressa "sem teto". A tradução é
 * explícita em vez de aproveitar o fato de que `SET ... = 0` também desliga no
 * Postgres, porque `null` é o que o TIPO diz, e um leitor não deve precisar
 * conhecer a semântica do `SET` para conferir a intenção.
 *
 * Preserva EXATAMENTE o comportamento anterior aos defaults do contrato:
 * 30000 / 500 / 10000 / sem teto.
 */
export function migrationRunOptions(config: MigrationConfig): RunOptions {
  return {
    waitMs: config.MIGRATION_LOCK_WAIT_MS,
    pollMs: config.MIGRATION_LOCK_POLL_MS,
    lockTimeoutMs: config.MIGRATION_LOCK_TIMEOUT_MS === 0 ? null : config.MIGRATION_LOCK_TIMEOUT_MS,
    statementTimeoutMs:
      config.MIGRATION_STATEMENT_TIMEOUT_MS === 0 ? null : config.MIGRATION_STATEMENT_TIMEOUT_MS,
  };
}

/** Variables the migrator is allowed to read, for a given profile. */
export function migrationManifest(profile: MaiaProfile) {
  return manifestForService('migrator', profile);
}
