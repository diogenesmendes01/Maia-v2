/**
 * Config do vitest FILHO, usado só pela regressão do reporter
 * (`tests/reporters/diagnostico-reporter.spec.ts`).
 *
 * Existe porque a fixture não é `*.spec.ts` — se fosse, a suíte principal a
 * coletaria e falharia de propósito a cada rodada. Sem `include` próprio, o
 * filho rodava ZERO arquivos e o bloco de diagnóstico saía "nenhum" por
 * vacuidade: o teste passaria sem nunca exercer o reporter.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/reporters/fixtures/*.fixture.ts'],
    reporters: [
      'default',
      resolve(__dirname, '../../../tests/reporters/diagnostico-reporter.ts'),
    ],
  },
});
