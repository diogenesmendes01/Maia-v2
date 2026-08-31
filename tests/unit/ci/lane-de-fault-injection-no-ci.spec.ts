/**
 * Guard do job de CI da lane de fault injection (#510, fatia D).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O defeito que este job existe para fechar
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Até a fatia D, `grep -rn "reliability" .github/workflows/` não retornava uma
 * linha. O harness da #510, os cenários FI-04..FI-07 (fatia B) e FI-17/FI-18
 * (fatia C) rodavam SÓ na máquina de quem os escreveu. Um harness de injeção
 * de falha que não roda no CI não impede regressão nenhuma — ele documenta que
 * alguém, um dia, conseguiu quebrar o código de propósito.
 *
 * E o modo de falha é pior que "não roda": medido nesta árvore, SEM
 * `TEST_DB_URL`, a lane inteira sai assim —
 *
 *     executados=128  falharam=0  pulados=10
 *     $ npm run test:reliability ; echo $?
 *     0
 *
 * Verde. Os dez cenários de injeção de falha — os que provam que a entrega não
 * sai duas vezes — PULADOS, e o exit code diz 0. Um job que rodasse só a lane
 * seria teatro: bastaria o service container não subir para o gate aprovar.
 *
 * É por isso que o passo do piso usa `--max-pulados 0`, e não só `--min 1`:
 * `--min 1` fica satisfeito com os 128 self-tests do harness e NÃO veria os 10
 * cenários sumirem. Nesta lane não existe skip legítimo.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Anti-espelho
 * ─────────────────────────────────────────────────────────────────────────
 * O workflow é PARSEADO do disco; o `package.json` é lido do disco; e o guard
 * é EXECUTADO como processo filho contra resumos escritos em disco —
 * inclusive contra um resumo com a forma exata do "verde vazio" acima.
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
  readonly env?: Record<string, string>;
  readonly 'continue-on-error'?: boolean;
}
interface Job {
  readonly name?: string;
  readonly env?: Record<string, string>;
  readonly services?: Record<string, unknown>;
  readonly steps?: readonly Passo[];
}

function job(): Job {
  const w = parseYaml(readFileSync(WORKFLOW, 'utf8')) as { jobs?: Record<string, Job> };
  const j = w.jobs?.['reliability'];
  expect(j, 'o job `reliability` sumiu do workflow').toBeDefined();
  return j as Job;
}

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

function resumo(executados: number, falharam: number, pulados: number): string {
  return [
    '─'.repeat(72),
    'RESUMO DE DIAGNÓSTICO DOS TESTES (maia)',
    '─'.repeat(72),
    `executados=${executados}  falharam=${falharam}  pulados=${pulados}` +
      `  (pulado NÃO é passou — specs de integração fazem describe.skip sem TEST_DB_URL)`,
    '',
    'falhas: nenhuma.',
  ].join('\n');
}

function comArquivo<T>(conteudo: string, fn: (caminho: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'fi-lane-'));
  const caminho = join(dir, 'resumo.txt');
  writeFileSync(caminho, conteudo, 'utf8');
  try {
    return fn(caminho);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('#510 fatia D — a lane de fault injection roda no CI e é um GATE', () => {
  describe('`--max-pulados` no guard de volume', () => {
    it('REPROVA o verde vazio real da lane sem banco (128 executados, 10 pulados)', () => {
      // Estes são os números MEDIDOS nesta árvore rodando a lane sem
      // `TEST_DB_URL`. `--min 1` sozinho aprovaria: 128 > 1.
      const semBanco = resumo(128, 0, 10);

      const soPiso = comArquivo(semBanco, (f) => rodarGuard([f, '--min', '1']));
      expect(soPiso.code, 'o piso de executados sozinho NÃO vê os cenários sumirem').toBe(0);

      const comTeto = comArquivo(semBanco, (f) =>
        rodarGuard([f, '--min', '1', '--max-pulados', '0']),
      );
      expect(comTeto.code).toBe(1);
      expect(comTeto.saida).toMatch(/10 caso\(s\) PULADO\(s\), máximo tolerado 0/);
    });

    it('APROVA a lane completa com banco (138 executados, 0 pulados) — o controle', () => {
      // Números medidos com Postgres e Redis reais. Sem este controle, um guard
      // que reprovasse tudo passaria neste arquivo e travaria o CI.
      const r = comArquivo(resumo(138, 0, 0), (f) =>
        rodarGuard([f, '--min', '1', '--max-pulados', '0']),
      );
      expect(r.code).toBe(0);
      expect(r.saida).toMatch(/teto de pulados 0/);
    });

    it('sem `--max-pulados` o teto NÃO se aplica — o skip de integração segue legítimo', () => {
      const r = comArquivo(resumo(1131, 0, 69), (f) => rodarGuard([f, '--min', '1']));
      expect(r.code).toBe(0);
    });

    it('recusa `--max-pulados` inválido em vez de ignorá-lo', () => {
      // Um flag inválido silenciosamente ignorado é um gate desarmado por erro
      // de digitação.
      const r = comArquivo(resumo(138, 0, 0), (f) => rodarGuard([f, '--max-pulados', '-1']));
      expect(r.code).toBe(1);
      expect(r.saida).toMatch(/--max-pulados precisa ser um inteiro/);
    });
  });

  describe('a fiação do job no `.github/workflows/ci.yml`', () => {
    it('o job roda a lane E o piso, nesta ordem, e o piso é BLOQUEANTE com teto de pulados 0', () => {
      const passos = job().steps ?? [];
      const iLane = passos.findIndex((p) => (p.run ?? '').includes('npm run test:reliability'));
      const iPiso = passos.findIndex((p) => (p.run ?? '').includes('check-vitest-summary.ts'));

      expect(iLane, 'o job não roda `npm run test:reliability`').toBeGreaterThanOrEqual(0);
      expect(iPiso, 'o job não roda o piso de volume').toBeGreaterThanOrEqual(0);
      expect(iPiso, 'o piso precisa vir DEPOIS da lane que o alimenta').toBeGreaterThan(iLane);

      const piso = passos[iPiso]!;
      // `continue-on-error` transforma gate em aviso. É como gates morrem.
      expect(piso['continue-on-error']).toBeUndefined();
      expect(piso.run).toMatch(/--max-pulados\s+0/);

      const m = /--min\s+(\d+)/.exec(piso.run ?? '');
      expect(m, 'o piso não declara --min').not.toBeNull();
      expect(Number.parseInt(m?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(1);
    });

    it('o piso lê o MESMO arquivo que a lane escreve', () => {
      // Apontar para outro caminho seria um gate que nunca vê a rodada real.
      const passos = job().steps ?? [];
      const lane = passos.find((p) => (p.run ?? '').includes('npm run test:reliability'));
      const piso = passos.find((p) => (p.run ?? '').includes('check-vitest-summary.ts'));
      const destino = lane?.env?.['VITEST_SUMMARY_FILE'];
      expect(destino, 'a lane não declara VITEST_SUMMARY_FILE').toBeTruthy();
      expect(piso?.run).toContain(destino as string);
    });

    it('o job tem Postgres e Redis de VERDADE, e `DATABASE_URL` igual a `TEST_DB_URL`', () => {
      // Os cenários exigem `DATABASE_URL === TEST_DB_URL` para rodar. Divergir
      // não quebra o job: ele PULA tudo — e é o `--max-pulados 0` que
      // transforma isso em vermelho. As duas defesas se sustentam.
      const j = job();
      expect(Object.keys(j.services ?? {}).sort()).toEqual(['postgres', 'redis']);
      expect(j.env?.['TEST_DB_URL']).toBeTruthy();
      expect(j.env?.['DATABASE_URL']).toBe(j.env?.['TEST_DB_URL']);
      expect(j.env?.['REDIS_URL']).toBeTruthy();
    });

    it('o nome do job diz o que ele guarda', () => {
      expect(job().name).toMatch(/fault injection/i);
    });
  });

  describe('o script que o job chama', () => {
    it('`test:reliability` existe e roda a lane com `--retry=0`', () => {
      // `--retry=0` importa: um cenário de corrida que "passa na segunda
      // tentativa" é precisamente o defeito que ele deveria denunciar.
      const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const script = pkg.scripts?.['test:reliability'];
      expect(script, 'o job de CI chama um script que não existe').toBeTruthy();
      expect(script).toContain('tests/reliability');
      expect(script).toMatch(/--retry=0/);
    });
  });
});
