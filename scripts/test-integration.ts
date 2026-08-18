/**
 * `npm run test:integration` — issue #571.
 *
 * O que este wrapper existe para eliminar: a linha do README que mandava o
 * desenvolvedor colar `TEST_DB_URL=postgres://…` à mão antes de cada rodada.
 * Colar à mão tem duas consequências ruins, e a segunda é a da #571:
 *
 *  1. quem esquece roda a suíte inteira em `describe.skip` e lê "0 falhas"
 *     como se fosse verde;
 *  2. quem lembra cola a MESMA url em todas as worktrees — que é exatamente
 *     como ~46 agentes passaram a disputar um banco só.
 *
 * Aqui a variável é preenchida sozinha com o valor de referência, e
 * `tests/setup.ts` a reescreve para o banco desta worktree. O desenvolvedor
 * não exporta nada, e não existe URL compartilhada para ele copiar.
 *
 * Um `TEST_DB_URL` já definido no ambiente é RESPEITADO (é assim que se aponta
 * para outro host/porta) — ele também passa pelo escopo da worktree.
 *
 * Argumentos extras são repassados ao vitest:
 *   npm run test:integration -- tests/integration/leak.spec.ts
 */
import { spawn } from 'node:child_process';
import { arquivoDoPacote } from '../tests/helpers/pkg-path.js';
import { BASE_TEST_DB_URL } from '../tests/helpers/worktree-scope.js';

const extra = process.argv.slice(2);
const alvo = extra.length > 0 ? extra : ['tests/integration'];

const filho = spawn(
  process.execPath,
  [arquivoDoPacote('vitest', 'vitest.mjs'), 'run', ...alvo, '--no-coverage'],
  {
    stdio: 'inherit',
    env: { ...process.env, TEST_DB_URL: process.env.TEST_DB_URL ?? BASE_TEST_DB_URL },
  },
);

filho.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
