/**
 * Issue #516 — a CLI de migrations tem de DIZER o que falta na configuração.
 *
 * O handler de erro do `scripts/migrate.ts` redige tudo a classe do erro, e a
 * razão é boa: a mensagem de um erro do `pg` embute a connection string com
 * senha. Mas a regra pega larga engolia justamente a falha MAIS PROVÁVEL do
 * runner — configuração incompleta — e a transformava em
 * `migrate: unexpected failure (ConfigValidationError)`, que não diz o que
 * fazer. O contrato da #515 existe para produzir diagnóstico acionável; jogá-lo
 * fora no único ponto em que o operador o veria anula o contrato.
 *
 * `ConfigValidationError` é a única exceção, e é segura por construção: a
 * mensagem é montada só com nome de variável, regra e remediação
 * (`src/config/load.ts:59-68`) — nunca com o VALOR lido. É o mesmo formato que
 * `npm run config:check` já imprime.
 *
 * Este teste roda a CLI de verdade, num processo separado, porque o defeito
 * vivia no handler do entrypoint: nenhum teste que importa o módulo passa por
 * ele.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Executa a CLI com um ambiente deliberadamente incompleto. */
async function runMigrate(
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(
      'npx',
      ['tsx', join('scripts', 'migrate.ts'), 'status'],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
        timeout: 120_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('scripts/migrate.ts — erro de configuração é acionável', () => {
  it(
    'nomeia as variáveis faltantes e a remediação, em vez de só a classe do erro',
    async () => {
      const { code, stderr } = await runMigrate({
        // Só a URL: o serviço `migrator` também exige POSTGRES_USER/PASSWORD/DB.
        DATABASE_URL: 'postgres://u:p@localhost:5432/d',
      });

      // A regressão exata: a mensagem inteira reduzida à classe.
      expect(stderr).not.toMatch(/unexpected failure \(ConfigValidationError\)/);

      expect(stderr).toContain('POSTGRES_USER');
      expect(stderr).toContain('POSTGRES_PASSWORD');
      expect(stderr).toContain('POSTGRES_DB');
      // Remediação, não só o diagnóstico.
      expect(stderr).toMatch(/→/);
      // Exit 2 = uso/configuração inválida, distinto de 1 (falha do runner).
      expect(code).toBe(2);
    },
    180_000,
  );

  it(
    'não imprime o VALOR de nenhuma variável — nem a senha da connection string',
    async () => {
      const secret = 'senha-canario-nao-deve-vazar';
      const { stderr, stdout } = await runMigrate({
        DATABASE_URL: `postgres://u:${secret}@localhost:5432/d`,
      });

      // O canário prova a propriedade que justifica abrir a exceção: a
      // mensagem do ConfigValidationError é feita de METADADO, não de valor.
      expect(stderr).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    },
    180_000,
  );
});
