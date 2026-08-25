/**
 * Issue #565 — o BOOT do processo de migration valida o subset `migrator`, e
 * não o contrato da aplicação.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que num processo separado
 * ─────────────────────────────────────────────────────────────────────────
 * O defeito que este arquivo trava não é "o loader do migrator aceita um
 * ambiente pequeno" — isso `tests/unit/config/loaders.spec.ts` já mede
 * chamando `loadMigrationConfig()` direto. É "o ENTRYPOINT que a plataforma
 * roda (`npm run db:migrate` = `tsx scripts/migrate.ts`) exige do container
 * de migration apenas o subset dele". Trocar `loadMigrationConfig()` por um
 * loader de aplicação em `scripts/migrate.ts` — ou fazer
 * `src/config/migration-config.ts` carregar o subset `runtime` — não quebra
 * nenhum teste que importe módulos: quebra o DEPLOY, num container que morre
 * cobrando `WHATSAPP_*`, `ANTHROPIC_API_KEY` e as seis `BACKUP_*` que ele
 * não usa. É o defeito da #596, do outro lado.
 *
 * Então aqui a CLI roda de verdade, com um ambiente que é EXATAMENTE o
 * `.env.migrator.prod.example` (lido do disco, os `__SET_ME__` preenchidos)
 * mais `PATH`/`HOME`. Nada de `.env.app`, nada herdado do shell do vitest.
 *
 * O banco aponta para uma porta fechada de propósito: o que se mede é o GATE
 * DE CONFIGURAÇÃO, que roda antes de qualquer round-trip. `migrate status`
 * nunca lança por banco inalcançável — ele imprime `readiness: unknown …
 * (ECONNREFUSED)` e sai 1 —, e é essa saída que prova que o processo
 * ATRAVESSOU o gate em vez de morrer nele.
 *
 * Exit codes de `scripts/migrate.ts`: 2 = configuração inválida
 * (`ConfigValidationError` / `MigratorSubsetError`), 1 = falha ou blocker do
 * runner, 0 = sucesso.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseEnvFile } from '@/config/env-file.js';
import { arquivoDoPacote } from '../../helpers/pkg-path.js';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Ver o cabeçalho de `migrate-config-error-surfacing.spec.ts`: nunca `npx`. */
const TSX_CLI = arquivoDoPacote('tsx', 'dist/cli.mjs', import.meta.url);

/**
 * O ambiente do recurso de migration separado: o arquivo do runbook, com os
 * `__SET_ME__` preenchidos e o DSN apontando para uma porta fechada.
 */
function ambienteDoRecursoDeMigration(): Record<string, string> {
  const declarado = parseEnvFile(
    readFileSync(resolve(repoRoot, '.env.migrator.prod.example'), 'utf8'),
  );
  return {
    ...declarado,
    DATABASE_URL: 'postgres://maia_prod:f4kepassw0rdf4ke@127.0.0.1:1/maia',
    POSTGRES_USER: 'maia_prod',
    POSTGRES_PASSWORD: 'f4kepassw0rdf4ke',
  };
}

type RunResult = { code: number; stdout: string; stderr: string; started: boolean };

async function runMigrate(env: Record<string, string>): Promise<RunResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [TSX_CLI, join('scripts', 'migrate.ts'), 'status'],
      {
        cwd: repoRoot,
        // `env -i` na prática: só PATH/HOME (que a IMAGEM dá ao container) e o
        // subset. Herdar `process.env` deixaria o teste vacuoso — o ambiente
        // do vitest carrega variáveis que o recurso de migration não tem.
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
        timeout: 120_000,
      },
    );
    return { code: 0, stdout, stderr, started: true };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    const started = typeof e.code === 'number';
    return {
      code: started ? (e.code as number) : -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      started,
    };
  }
}

/**
 * Chaves de APLICAÇÃO que o recurso de migration não recebe. Aqui a lista
 * literal é legítima: ela não define a invariante (isso é
 * `src/config/migrator-subset.ts`, por categoria) — ela é o texto que NÃO
 * pode aparecer numa mensagem de erro do migrator.
 */
const NUNCA_COBRADAS = [
  'WHATSAPP_NUMBER_MAIA',
  'OWNER_TELEFONE_WHATSAPP',
  'ANTHROPIC_API_KEY',
  'VOYAGE_API_KEY',
  'BACKUP_S3_SECRET_KEY',
  'NEXTAUTH_SECRET',
  'OIDC_ISSUER',
] as const;

describe('scripts/migrate.ts — o boot exige o subset `migrator`, não o da aplicação (#565)', () => {
  it(
    'sobe com o .env.migrator.prod.example e mais nada',
    async () => {
      const { code, stdout, stderr, started } = await runMigrate(ambienteDoRecursoDeMigration());

      expect(started, 'a CLI não chegou a executar').toBe(true);

      // Primeiro as asserções que NOMEIAM o defeito: quando o boot volta a
      // exigir o contrato da aplicação, é aqui que se lê o quê.
      for (const nome of NUNCA_COBRADAS) {
        expect(
          `${stdout}\n${stderr}`,
          `o migrator cobrou ${nome} — uma chave de aplicação num job que só aplica DDL`,
        ).not.toContain(nome);
      }
      expect(stderr).not.toContain('Invalid configuration for service');
      expect(stderr).not.toContain('profile/required');
      expect(
        code,
        `saiu ${code}; 2 é "configuração inválida" — o migrator estaria cobrando ` +
          'configuração que este recurso não tem',
      ).not.toBe(2);

      // E, por último, a asserção POSITIVA: o gate de configuração foi
      // atravessado e a única coisa que barrou o comando foi o banco fechado.
      // Sem ela o caso seria vacuoso — um processo que morresse antes também
      // produziria stderr sem os nomes de aplicação.
      expect(stdout, 'a CLI não chegou ao passo que fala com o banco').toContain('readiness:');
    },
    180_000,
  );

  it(
    'e ainda assim falha fechado sem DSN — o canário do caso acima',
    async () => {
      // Prova que o harness DETECTA falha de configuração. Sem ele,
      // "atravessou o gate" e "o gate sumiu" seriam o mesmo resultado.
      const { DATABASE_URL: _semDsn, ...semDatabaseUrl } = ambienteDoRecursoDeMigration();
      const { code, stderr, started } = await runMigrate(semDatabaseUrl);

      expect(started, 'a CLI não chegou a executar').toBe(true);
      expect(code, 'faltando o DSN, o migrator tem de recusar o boot').toBe(2);
      expect(stderr).toContain('DATABASE_URL');
      expect(stderr).toMatch(/→/);
    },
    180_000,
  );
});
