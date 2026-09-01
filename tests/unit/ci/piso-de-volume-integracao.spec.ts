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
 * A segunda metade, #703 — o e2e de backend VOLTOU, e o guard mudou de forma
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A #701 removeu o alvo vazio; a #703 devolveu o alvo COM CONTEÚDO: três
 * jornadas de negócio ponta a ponta em `tests/e2e/jornadas-backend.spec.ts`,
 * o script `test:e2e` e um piso PRÓPRIO (`--min 3 --max-pulados 0`) no mesmo
 * job de integração.
 *
 * Isso reescreve o que este arquivo protege, e a mudança é deliberada. Antes
 * ele exigia a AUSÊNCIA de `test:e2e` e de `tests/e2e/` — a única defesa
 * possível enquanto não havia nada a rodar. Exigir ausência nunca foi o
 * objetivo: o defeito nunca foi "existe uma lane e2e", foi "existe uma lane
 * e2e que não executa nada e sai 0". Agora que a lane executa, o guard passa
 * a exigir as CONDIÇÕES que tornam a volta segura, que são mais fortes que a
 * ausência:
 *
 *   a. a lane está fiada no job (`npm run test:e2e`) e grava resumo próprio;
 *   b. o piso dela é BLOQUEANTE, lê ESSE resumo, exige `--min >= 3` (uma
 *      jornada por cenário nominal da #703) e `--max-pulados 0`;
 *   c. nenhum arquivo de `tests/e2e/` tem `describe.skip` INCONDICIONAL — a
 *      forma exata do defeito original.
 *
 * (c) é o que impede a regressão literal: um `describe.skip('…')` no topo
 * reprova este arquivo, e o piso reprova o job.
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
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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

    it('SEM `--max-pulados`, não reprova por pulados sozinhos — o default serve à rodada local', () => {
      // Sem banco, na máquina de quem desenvolve, a integração pula por
      // desenho. Um default de zero pulados quebraria o uso local e seria
      // desligado na primeira semana. Por isso o teto é OPCIONAL no guard e
      // ligado só onde a lane promete zero — ver o caso da fiação do CI.
      const r = comArquivo(resumo(1131, 0, 69), (f) => rodarGuard([f]));
      expect(r.code).toBe(0);
    });

    it('COM `--max-pulados 0`, a mesma rodada REPROVA — e a rodada sem pulados passa (controle)', () => {
      // O par que dá sentido ao caso acima: o mesmo resumo, a mesma
      // ferramenta, e o veredicto mudando só por causa do teto. Sem o
      // controle, "reprova sempre" também passaria neste `it`.
      const comPulados = comArquivo(resumo(1131, 0, 69), (f) =>
        rodarGuard([f, '--max-pulados', '0']),
      );
      expect(comPulados.code).toBe(1);
      expect(comPulados.saida).toMatch(/69 caso\(s\) PULADO\(s\)/);

      const semPulados = comArquivo(resumo(1207, 0, 0), (f) =>
        rodarGuard([f, '--max-pulados', '0']),
      );
      expect(semPulados.code).toBe(0);
    });
  });

  describe('a fiação no `.github/workflows/ci.yml`', () => {
    it('#703 — o job de integração roda a lane de jornadas e2e, e ela grava resumo PRÓPRIO', () => {
      const job = workflow().jobs?.['integration'];
      expect(job, 'job `integration` sumiu do workflow').toBeDefined();
      const passos = job?.steps ?? [];
      const lane = passos.find((p) => (p.run ?? '').includes('npm run test:e2e'));
      expect(lane, 'a lane de jornadas e2e (#703) sumiu do job de integração').toBeDefined();

      // Um gate não pode ser aviso.
      expect(lane?.['continue-on-error']).toBeUndefined();

      // Resumo PRÓPRIO: se a lane escrevesse no mesmo arquivo da integração,
      // o piso de 3 leria os ~1100 casos dela e aprovaria uma lane e2e vazia.
      const destino = (lane as { env?: Record<string, string> } | undefined)?.env?.[
        'VITEST_SUMMARY_FILE'
      ];
      expect(destino, 'a lane e2e não declara VITEST_SUMMARY_FILE').toBeTruthy();
      const integracao = passos.find((p) => (p.run ?? '').includes('npm run test:integration'));
      const destinoIntegracao = (integracao as { env?: Record<string, string> } | undefined)?.env?.[
        'VITEST_SUMMARY_FILE'
      ];
      expect(destino).not.toBe(destinoIntegracao);
    });

    it('#703 — a lane e2e tem piso PRÓPRIO, bloqueante, com --min >= 3 e --max-pulados 0', () => {
      const passos = workflow().jobs?.['integration']?.steps ?? [];
      const lane = passos.find((p) => (p.run ?? '').includes('npm run test:e2e'));
      const destino = (lane as { env?: Record<string, string> } | undefined)?.env?.[
        'VITEST_SUMMARY_FILE'
      ] as string;
      const piso = passos.find(
        (p) => (p.run ?? '').includes('check-vitest-summary.ts') && (p.run ?? '').includes(destino),
      );
      expect(piso, 'a lane e2e não tem passo de piso apontando para o resumo dela').toBeDefined();
      expect(piso?.['continue-on-error']).toBeUndefined();

      // `--min 3`: um por cenário nominal da #703 (R$ 50, R$ 25k, quarentena).
      // Apagar uma jornada tem de reprovar o job, não reduzir a cobertura em
      // silêncio.
      const min = /--min\s+(\d+)/.exec(piso?.run ?? '');
      expect(min, 'o piso da lane e2e não declara --min').not.toBeNull();
      expect(Number.parseInt(min?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(3);

      // `--max-pulados 0`: nesta lane o ÚNICO skip possível é o
      // `describe.skip` condicionado a `TEST_DB_URL`, e neste job Postgres e
      // Redis são obrigatórios. Skip aqui = infraestrutura ausente = falha.
      const max = /--max-pulados\s+(\d+)/.exec(piso?.run ?? '');
      expect(max, 'o piso da lane e2e não declara --max-pulados').not.toBeNull();
      expect(Number.parseInt(max?.[1] ?? '-1', 10)).toBe(0);
    });

    it('o NOME do job continua `integration (node X)` — e a razão mudou de lado', () => {
      // Antes da #703 o nome tinha de perder o `+ e2e` porque PROMETIA uma
      // cobertura inexistente. Agora a cobertura existe e o nome fica igual
      // por outro motivo, mais duro: o nome do job É o nome do check
      // obrigatório na proteção de branch. Renomeá-lo faria a proteção
      // esperar um check que ninguém publica — exatamente o aceite 4 da #703
      // ("um check obrigatório com nome errado nunca reporta").
      //
      // Prometer menos do que se entrega nunca foi o defeito; prometer mais
      // era. A asserção segue a mesma, a justificativa é que inverteu.
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

    it('o teto de pulados da lane de integração é ZERO — `--min` sozinho não vê cobertura sumir', () => {
      // `--min 1` reprova a rodada VAZIA e nada mais. Ele não vê mil e
      // duzentos casos rodarem enquanto dez somem — `executados` continua
      // muito acima do piso e o gate aprova. Nesta lane o skip não é escolha
      // do autor do teste: é o que 121 arquivos fazem quando `TEST_DB_URL` e
      // `DATABASE_URL` deixam de bater, ou quando o runtime de container
      // some. Perder a lane inteira para `describe.skip` sem uma linha
      // vermelha é o verde vazio que este piso existe para impedir.
      //
      // Zero não é meta: é o número que a lane JÁ tem (`executados=1207
      // falharam=0 pulados=0` nas duas pernas da matriz). O teto não aperta
      // nada hoje; impede que a perda seja silenciosa amanhã.
      const passos = workflow().jobs?.['integration']?.steps ?? [];
      const piso = passos.find((p) => (p.run ?? '').includes('check-vitest-summary.ts'));
      const teto = /--max-pulados\s+(\d+)/.exec(piso?.run ?? '');
      expect(
        teto,
        'o piso da integração voltou a aceitar qualquer número de pulados: ' +
          'uma lane que pula quando o banco falta passa a aprovar em silêncio',
      ).not.toBeNull();
      expect(Number.parseInt(teto?.[1] ?? '-1', 10)).toBe(0);
    });

    it('a lane de fault injection continua com o MESMO teto — o controle que impede regressão de um lado só', () => {
      // As duas lanes dependem da mesma infraestrutura obrigatória. Endurecer
      // uma e deixar a outra afrouxar seria trocar um buraco de lugar.
      const passos = workflow().jobs?.['reliability']?.steps ?? [];
      const piso = passos.find((p) => (p.run ?? '').includes('check-vitest-summary.ts'));
      expect(piso, 'o piso de volume sumiu da lane de fault injection').toBeDefined();
      const teto = /--max-pulados\s+(\d+)/.exec(piso?.run ?? '');
      expect(teto, 'a lane de fault injection perdeu o teto de pulados').not.toBeNull();
      expect(Number.parseInt(teto?.[1] ?? '-1', 10)).toBe(0);
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

  describe('o alvo `tests/e2e/` — #703', () => {
    it('o script `test:e2e` existe, aponta para `tests/e2e` e roda com --retry=0', () => {
      const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const script = pkg.scripts?.['test:e2e'];
      expect(script, 'o script `test:e2e` sumiu — a lane da #703 ficaria sem alvo').toBeTruthy();
      expect(script).toContain('tests/e2e');
      // Uma jornada que "passa na segunda tentativa" é o flake que esta lane
      // deveria denunciar. Mesma regra de `test:reliability`.
      expect(script).toContain('--retry=0');

      // O E2E do console tem script próprio e continua lá — o controle que
      // impede esta asserção de virar "nenhum e2e no repo".
      expect(pkg.scripts?.['test:admin-ui:e2e:ci']).toBeDefined();
    });

    it('NÃO existe `describe.skip` incondicional em `tests/e2e/` — a forma exata do defeito', () => {
      const dir = join(RAIZ, 'tests/e2e');
      const arquivos = readdirSync(dir).filter((f) => f.endsWith('.spec.ts'));
      expect(
        arquivos.length,
        '`tests/e2e/` sem nenhuma spec é o alvo vazio que a #701 removeu',
      ).toBeGreaterThan(0);

      for (const f of arquivos) {
        const texto = readFileSync(join(dir, f), 'utf8');
        // Só a forma CONDICIONAL é aceitável — `SHOULD_RUN ? describe :
        // describe.skip`, que reage a `TEST_DB_URL` ausente e que o
        // `--max-pulados 0` do CI transforma em vermelho. Um `describe.skip(`
        // literal (aberto parêntese logo depois) é o defeito de #438.
        const semComentarios = texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(
          /describe\.skip\s*\(/.test(semComentarios),
          `${f} tem \`describe.skip(\` INCONDICIONAL — é literalmente o defeito da #703`,
        ).toBe(false);
      }
    });
  });
});
