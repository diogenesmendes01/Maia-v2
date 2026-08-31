/**
 * Guard do PISO DE VOLUME da rodada de integração.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O defeito que este arquivo existe para não deixar voltar
 * ─────────────────────────────────────────────────────────────────────────
 *
 * O job de integração do CI chamava, desde a PR #438, um passo `Run e2e
 * tests` → `npm run test:e2e` → `vitest run tests/e2e`. Havia UM arquivo lá:
 * `tests/e2e/smoke.spec.ts`, com `describe.skip` HARDCODED (não condicional a
 * ambiente) e três casos cujos corpos eram comentários — `// 1) seed owner`,
 * `// 2) inject inbound message`, `// 3) assert outbound contains "Lançado"`.
 *
 * Medido nesta árvore, antes da correção:
 *
 *     executados=0  falharam=0  pulados=3
 *     $ npm run test:e2e ; echo $?
 *     0
 *
 * Verde. E o nome do job — `integration + e2e (node X)` — anunciava para
 * qualquer leitor da lista de checks uma cobertura ponta-a-ponta que não
 * existia. Um check obrigatório que passa por ausência de trabalho é pior que
 * nenhum check: ele consome a confiança que deveria produzir.
 *
 * A correção tem três partes, e este arquivo protege as três:
 *
 *   1. o passo vazio saiu, junto com o script `test:e2e` e o arquivo de spec;
 *   2. o nome do job passou a dizer o que ele faz (`integration (node X)`);
 *   3. no lugar entrou um PISO sobre a integração que de fato roda —
 *      `scripts/check-vitest-summary.ts`, que reprova `executados=0`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Anti-espelho
 * ─────────────────────────────────────────────────────────────────────────
 * Nada aqui é reconstruído a partir de uma cópia do que se espera. O workflow
 * é PARSEADO do disco; o `package.json` é lido do disco; e o guard é
 * EXECUTADO de verdade, como processo filho, contra resumos escritos em disco
 * — inclusive contra o resumo REAL que a suíte vazia produzia. Se o guard
 * parar de reprovar, este arquivo fica vermelho.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const RAIZ = resolve(__dirname, '../../..');
const WORKFLOW = join(RAIZ, '.github/workflows/ci.yml');
const GUARD = join(RAIZ, 'scripts/check-vitest-summary.ts');

interface Passo {
  readonly name?: string;
  readonly run?: string;
  readonly 'continue-on-error'?: boolean;
}
interface Job {
  readonly name?: string;
  readonly steps?: readonly Passo[];
}
interface Workflow {
  readonly jobs?: Record<string, Job>;
}

function workflow(): Workflow {
  return parseYaml(readFileSync(WORKFLOW, 'utf8')) as Workflow;
}

/**
 * Roda o guard como processo separado e devolve código de saída e saída.
 * `execFileSync` estoura quando o filho sai != 0, então o status vem do erro.
 */
function rodarGuard(args: readonly string[]): { code: number; saida: string } {
  try {
    const out = execFileSync(process.execPath, [GUARD, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, saida: out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, saida: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Um resumo no formato exato que `diagnostico-reporter.ts` grava. */
function resumo(executados: number, falharam: number, pulados: number, extra = ''): string {
  return [
    '─'.repeat(72),
    'RESUMO DE DIAGNÓSTICO DOS TESTES (maia)',
    '─'.repeat(72),
    `executados=${executados}  falharam=${falharam}  pulados=${pulados}` +
      `  (pulado NÃO é passou — specs de integração fazem describe.skip sem TEST_DB_URL)`,
    extra,
    '',
    'prazos estourados: nenhum.',
    '',
    'falhas: nenhuma.',
  ].join('\n');
}

function comArquivo<T>(conteudo: string, fn: (caminho: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'piso-volume-'));
  const caminho = join(dir, 'resumo.txt');
  writeFileSync(caminho, conteudo, 'utf8');
  try {
    return fn(caminho);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('piso de volume da rodada de integração', () => {
  describe('o guard `scripts/check-vitest-summary.ts`', () => {
    it('REPROVA executados=0 — e APROVA a mesma rodada com trabalho (controle)', () => {
      // O caso principal: é literalmente o resumo que `npm run test:e2e`
      // produzia, com os três casos pulados do smoke.spec.ts.
      const vazio = comArquivo(resumo(0, 0, 3), (f) => rodarGuard([f]));
      expect(vazio.code).toBe(1);
      expect(vazio.saida).toMatch(/executou 0 caso\(s\)/);

      // O CONTROLE não é decoração: sem ele, um guard que reprovasse TUDO
      // passaria neste arquivo e derrubaria o CI inteiro.
      const cheio = comArquivo(resumo(1131, 0, 69), (f) => rodarGuard([f]));
      expect(cheio.code).toBe(0);
      expect(cheio.saida).toMatch(/1131 executado\(s\)/);
    });

    it('REPROVA a seção ARQUIVOS QUE NÃO CARREGARAM mesmo com executados alto e falharam=0', () => {
      // Este é o modo de falha que `falharam=0` NÃO cobre: um arquivo que nem
      // compilou não tem caso nenhum contado em `executados`. Já aconteceu
      // nesta árvore — um `entidades.id` duplicado derrubou o `beforeAll` de
      // outra spec e os goldens dela apareceram como "pulados".
      const naoCarregou = [
        'ARQUIVOS QUE NÃO CARREGARAM / ERROS FORA DE TESTE: 1 arquivo(s), 0 erro(s) solto(s)',
        '  Os contadores acima NÃO cobrem estes — nenhum caso deles chegou a rodar.',
        '  · tests/integration/alguma.spec.ts',
        '      duplicate key value violates unique constraint "entidades_pkey"',
      ].join('\n');
      const r = comArquivo(resumo(900, 0, 0, naoCarregou), (f) => rodarGuard([f]));
      expect(r.code).toBe(1);
      expect(r.saida).toMatch(/ARQUIVOS QUE NÃO CARREGARAM/);
    });

    it('REPROVA resumo ausente e resumo sem a linha de contadores', () => {
      // Ausência de resumo é falha, não "nada a verificar": o arquivo só some
      // quando o runner morreu antes de escrevê-lo.
      const ausente = rodarGuard([join(tmpdir(), 'nao-existe-piso-volume.txt')]);
      expect(ausente.code).toBe(1);
      expect(ausente.saida).toMatch(/não foi possível ler o resumo/);

      // E se o reporter mudar de formato, o guard fica CEGO — então ele tem
      // de gritar em vez de aprovar por não ter achado o que checar.
      const semLinha = comArquivo('qualquer coisa que não é resumo\n', (f) => rodarGuard([f]));
      expect(semLinha.code).toBe(1);
      expect(semLinha.saida).toMatch(/não traz a linha de contadores/);
    });

    it('respeita um piso maior que 1 e recusa `--min` inválido', () => {
      const abaixo = comArquivo(resumo(5, 0, 0), (f) => rodarGuard([f, '--min', '10']));
      expect(abaixo.code).toBe(1);
      const acima = comArquivo(resumo(50, 0, 0), (f) => rodarGuard([f, '--min', '10']));
      expect(acima.code).toBe(0);

      const invalido = comArquivo(resumo(50, 0, 0), (f) => rodarGuard([f, '--min', '0']));
      expect(invalido.code).toBe(1);
      expect(invalido.saida).toMatch(/--min precisa ser um inteiro/);
    });

    it('NÃO reprova por pulados sozinhos — o skip de integração sem TEST_DB_URL é legítimo', () => {
      // Um piso de zero pulados aqui quebraria o uso local e seria desligado
      // na primeira semana. O piso que importa é o de EXECUTADOS.
      const r = comArquivo(resumo(1131, 0, 69), (f) => rodarGuard([f]));
      expect(r.code).toBe(0);
    });
  });

  describe('a fiação no `.github/workflows/ci.yml`', () => {
    it('o job de integração NÃO tem mais passo de e2e de backend', () => {
      const job = workflow().jobs?.['integration'];
      expect(job, 'job `integration` sumiu do workflow').toBeDefined();
      const runs = (job?.steps ?? []).map((p) => p.run ?? '').join('\n');
      expect(runs).not.toMatch(/npm run test:e2e/);
      expect(runs).not.toMatch(/vitest run tests\/e2e/);
    });

    it('o NOME do job não promete e2e que ele não roda', () => {
      // O nome é o que aparece na lista de checks da PR e na proteção de
      // branch. Um nome que promete cobertura inexistente é a parte do
      // defeito que mais longe chega.
      const nome = workflow().jobs?.['integration']?.name ?? '';
      expect(nome).toMatch(/^integration \(node /);
      expect(nome).not.toMatch(/e2e/i);
    });

    it('o piso de volume está fiado, é BLOQUEANTE e aponta para o resumo que a integração grava', () => {
      const passos = workflow().jobs?.['integration']?.steps ?? [];
      const piso = passos.find((p) => (p.run ?? '').includes('check-vitest-summary.ts'));
      expect(piso, 'o passo do piso de volume sumiu do job de integração').toBeDefined();

      // `continue-on-error` transforma gate em aviso. É como gates morrem.
      expect(piso?.['continue-on-error']).toBeUndefined();

      // O piso tem de ler o MESMO arquivo que o passo de integração escreve —
      // apontar para outro caminho é um gate que nunca vê a rodada real.
      const integracao = passos.find((p) => (p.run ?? '').includes('npm run test:integration'));
      const destino = (integracao as { env?: Record<string, string> } | undefined)?.env?.[
        'VITEST_SUMMARY_FILE'
      ];
      expect(destino, 'o passo de integração não declara VITEST_SUMMARY_FILE').toBeTruthy();
      expect(piso?.run).toContain(destino as string);

      // E o piso tem de ser >= 1: `--min 0` seria o gate desarmado por edição.
      const m = /--min\s+(\d+)/.exec(piso?.run ?? '');
      expect(m, 'o passo do piso não declara --min').not.toBeNull();
      expect(Number.parseInt(m?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(1);
    });

    it('o E2E do console segue intacto — a correção é do e2e de BACKEND', () => {
      // A remoção do e2e vazio não pode levar junto o E2E que de fato roda.
      const admin = workflow().jobs?.['admin-ui'];
      expect(admin, 'job `admin-ui` sumiu').toBeDefined();
      const runs = (admin?.steps ?? []).map((p) => p.run ?? '').join('\n');
      // `test:admin-ui:e2e:ci` → `scripts/admin-ui-e2e.sh`, que monta o
      // artefato standalone, sobe o `server.js` de produção e exige o piso de
      // volume do Playwright (`scripts/check-playwright-run.ts`).
      expect(runs).toMatch(/npm run test:admin-ui:e2e:ci/);
    });
  });

  describe('o que sobrou no repositório', () => {
    it('não há mais script `test:e2e` nem `tests/e2e/` — um alvo vazio é um convite a recriar o verde falso', () => {
      const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(pkg.scripts?.['test:e2e']).toBeUndefined();

      // O E2E do console tem script próprio e continua lá — o controle que
      // impede esta asserção de virar "nenhum e2e no repo".
      expect(pkg.scripts?.['test:admin-ui:e2e:ci']).toBeDefined();
    });
  });
});
