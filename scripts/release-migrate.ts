/**
 * `npm run release:migrate` — o gate de migration para orquestradores que não
 * têm `service_completed_successfully` (issue #565).
 *
 * ```bash
 * npm run release:migrate
 * ```
 *
 * Adaptador FINO sobre `src/migrations/release-gate.ts`, na mesma divisão que
 * `scripts/migrate.ts` usa com `src/migrations/`: toda a decisão está na
 * biblioteca (pura, testada); aqui ficam as três coisas que um CLI pode fazer
 * — falar com o sistema operacional, imprimir e escolher o exit code.
 *
 * ONDE ISTO É COLADO: no campo de comando pré-deploy do painel, ou
 * encadeado no comando de start (`npm run release:migrate && exec node
 * dist/index.js`). Ver `docs/runbooks/deploy-prod.md` §7, que também diz o
 * que ali foi executado e o que NÃO foi.
 *
 * Exit codes: os do migrator, propagados sem alteração (`scripts/migrate.ts`
 * — 0 sucesso/já-atualizado, 1 falha ou blocker, 2 configuração inválida),
 * mais 1 para qualquer falha do próprio gate.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runReleaseGate, type MigratorOutcome } from '@/migrations/release-gate.js';

/**
 * Importado direto do arquivo, e não de `@/migrations/index.js`: o índice
 * arrasta o runner, o `pg` e o descobridor de migrations para dentro de um
 * processo cujo trabalho inteiro é gerar um filho. O filho carrega tudo isso
 * de novo, e é ele quem precisa.
 */

/** Uma linha JSON por evento — o mesmo formato de `scripts/migrate.ts`. */
function emit(event: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...detail }));
}

/**
 * Executa o comando com o ambiente JÁ filtrado.
 *
 * `env` substitui o ambiente inteiro do filho — não é um merge sobre o do
 * pai. É essa substituição que faz o filtro valer alguma coisa.
 *
 * `stdio: 'inherit'`: o log do migrator (eventos `migration.applied`,
 * `migration.blocked`, a mensagem do `ConfigValidationError`) vai direto para
 * o log do deploy. Um gate que engole a saída do que ele bloqueou obriga o
 * operador a reproduzir a falha para saber o que houve.
 */
function run(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<MigratorOutcome> {
  return new Promise<MigratorOutcome>((resolve, reject) => {
    const child = spawn(command[0] as string, [...command.slice(1)], {
      env: { ...env },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal !== null) resolve({ kind: 'signal', signal });
      // `code === null` sem sinal não deveria acontecer; se acontecer, é
      // desconhecido, e desconhecido bloqueia.
      else resolve({ kind: 'exit', code: code ?? 1 });
    });
  });
}

export async function main(): Promise<number> {
  return runReleaseGate({ source: process.env, run, emit });
}

/**
 * Só roda quando este arquivo É o entrypoint — mesma guarda de
 * `scripts/migrate.ts` (`isDirectInvocation`), replicada em vez de importada
 * para não carregar o subsistema de migrations no processo pai.
 */
function isEntrypoint(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // `runReleaseGate` não lança. Se algo chegou aqui, o gate não rodou —
      // e "não rodou" tem de bloquear igual a "falhou".
      const cls = err instanceof Error ? err.constructor.name : 'UnknownError';
      console.error(`release-migrate: unexpected failure (${cls})`);
      process.exitCode = 1;
    },
  );
}
