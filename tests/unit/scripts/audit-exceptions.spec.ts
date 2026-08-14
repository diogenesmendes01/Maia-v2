/**
 * Issue #526 — guard do ledger de exceções do `npm audit`.
 *
 * Exercita as funções puras de `scripts/check-audit-exceptions.ts` com
 * entradas sintéticas (sem rede, sem `npm audit`), MAIS uma checagem contra o
 * ledger real commitado: um ledger malformado ou vencido reprova aqui antes de
 * reprovar no CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEDGER_PATH,
  PROJECTS,
  ghsaFromUrl,
  isCalendarDate,
  keyOf,
  npmExecutable,
  parseAudit,
  validateLedger,
  findProblems,
  todayUtc,
  type Exception,
  type Finding,
} from '../../../scripts/check-audit-exceptions.js';

const OK: Exception = {
  project: '.',
  pkg: 'esbuild',
  advisory: 'GHSA-67mh-4wv8-2f99',
  severity: 'moderate',
  reason: 'só na árvore de dev; correção exige major deferido',
  owner: 'diogenesmendes01',
  issue: 'https://github.com/diogenesmendes01/Maia-v2/issues/526',
  expires: '2099-01-01',
};

const FINDING: Finding = {
  project: '.',
  pkg: 'esbuild',
  advisory: 'GHSA-67mh-4wv8-2f99',
  severity: 'moderate',
  title: 'esbuild dev server aceita requisição de qualquer origem',
};

describe('ghsaFromUrl', () => {
  it('extrai o id de uma URL de advisory', () => {
    expect(ghsaFromUrl('https://github.com/advisories/GHSA-67mh-4wv8-2f99')).toBe(
      'GHSA-67mh-4wv8-2f99',
    );
  });

  it('devolve null para o que não é URL de advisory', () => {
    expect(ghsaFromUrl(undefined)).toBeNull();
    expect(ghsaFromUrl('https://example.com/nada')).toBeNull();
  });
});

describe('parseAudit', () => {
  it('extrai um finding por advisory OBJETO, ignorando os `via` string', () => {
    const raw = {
      vulnerabilities: {
        esbuild: {
          via: [
            {
              name: 'esbuild',
              url: 'https://github.com/advisories/GHSA-67mh-4wv8-2f99',
              title: 'dev server',
              severity: 'moderate',
            },
          ],
        },
        // Nó derivado: vulnerável só porque depende do esbuild. Sem advisory
        // próprio, não deve exigir linha de ledger.
        '@esbuild-kit/core-utils': { via: ['esbuild'] },
        'drizzle-kit': { via: ['@esbuild-kit/esm-loader', 'esbuild'] },
      },
    } as unknown;
    const found = parseAudit('.', raw);
    expect(found).toHaveLength(1);
    expect(found[0]!.pkg).toBe('esbuild');
    expect(found[0]!.advisory).toBe('GHSA-67mh-4wv8-2f99');
  });

  it('deduplica o mesmo advisory reportado em vários nós', () => {
    const via = {
      name: 'brace-expansion',
      url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
      title: 'DoS',
      severity: 'high',
    };
    const raw = {
      vulnerabilities: {
        'brace-expansion': { via: [via, via, via] },
      },
    } as unknown;
    expect(parseAudit('.', raw)).toHaveLength(1);
  });

  it('aceita um relatório sem vulnerabilidade nenhuma', () => {
    expect(parseAudit('src/admin-ui', { vulnerabilities: {} })).toEqual([]);
    expect(parseAudit('src/admin-ui', {})).toEqual([]);
  });
});

describe('npmExecutable — o comando documentado precisa rodar no Windows', () => {
  it('usa npm.cmd no win32', () => {
    // `execFileSync` não passa por shell nem resolve PATHEXT: com 'npm' o
    // Windows dá `spawnSync npm ENOENT` e o guard morre antes de auditar.
    expect(npmExecutable('win32')).toBe('npm.cmd');
  });

  it('usa npm nos demais', () => {
    expect(npmExecutable('linux')).toBe('npm');
    expect(npmExecutable('darwin')).toBe('npm');
    expect(npmExecutable('freebsd')).toBe('npm');
  });

  it('sem argumento, decide pela plataforma corrente', () => {
    expect(npmExecutable()).toBe(npmExecutable(process.platform));
  });
});

describe('isCalendarDate', () => {
  it('recusa data calendárica impossível que o Date.parse normalizaria', () => {
    // `new Date('2026-02-31T00:00:00Z')` vira 2026-03-03 no V8 — 3 dias de
    // exceção que ninguém escreveu.
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
    expect(isCalendarDate('2026-01-00')).toBe(false);
    expect(isCalendarDate('2026-01-32')).toBe(false);
  });

  it('aceita datas reais, inclusive 29/02 em ano bissexto', () => {
    expect(isCalendarDate('2026-11-12')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-28')).toBe(true);
  });

  it('recusa o que não tem a forma YYYY-MM-DD', () => {
    expect(isCalendarDate('12/11/2026')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
  });
});

describe('validateLedger', () => {
  it('aceita uma entrada bem formada', () => {
    const { exceptions, errors } = validateLedger([OK]);
    expect(errors).toEqual([]);
    expect(exceptions).toHaveLength(1);
  });

  it('reprova campo obrigatório ausente', () => {
    const { errors } = validateLedger([{ ...OK, owner: '' }]);
    expect(errors.join('\n')).toContain('campo "owner" ausente ou vazio');
  });

  it('reprova projeto fora dos dois lockfiles conhecidos', () => {
    const { errors } = validateLedger([{ ...OK, project: 'src/outro' }]);
    expect(errors.join('\n')).toContain('não é um dos projetos');
  });

  it('reprova advisory que não tem forma de GHSA', () => {
    const { errors } = validateLedger([{ ...OK, advisory: 'CVE-2026-1234' }]);
    expect(errors.join('\n')).toContain('não tem a forma GHSA');
  });

  it('reprova data de expiração malformada', () => {
    const { errors } = validateLedger([{ ...OK, expires: '12/11/2026' }]);
    expect(errors.join('\n')).toContain('não é uma data YYYY-MM-DD válida');
  });

  it('reprova data calendárica impossível (2026-02-31)', () => {
    const { exceptions, errors } = validateLedger([{ ...OK, expires: '2026-02-31' }]);
    expect(errors.join('\n')).toContain('expires "2026-02-31" não é uma data YYYY-MM-DD válida');
    expect(exceptions).toEqual([]);
  });

  it('reprova entradas duplicadas para a mesma chave', () => {
    const { errors } = validateLedger([OK, OK]);
    expect(errors.join('\n')).toContain('entrada duplicada');
  });

  it('reprova conteúdo que não é array', () => {
    const { errors } = validateLedger({ exceptions: [] });
    expect(errors.join('\n')).toContain('precisa ser um array JSON');
  });
});

describe('findProblems', () => {
  it('passa quando todo advisory tem exceção dentro do prazo', () => {
    expect(findProblems([FINDING], [OK], '2026-08-14')).toEqual([]);
  });

  it('reprova advisory novo, sem exceção registrada', () => {
    expect(findProblems([FINDING], [], '2026-08-14').join('\n')).toContain(
      'advisory sem exceção registrada',
    );
  });

  it('reprova exceção vencida', () => {
    const expirada = { ...OK, expires: '2026-08-13' };
    expect(findProblems([FINDING], [expirada], '2026-08-14').join('\n')).toContain(
      'exceção VENCIDA',
    );
  });

  it('aceita exceção que vence exatamente hoje', () => {
    const hoje = { ...OK, expires: '2026-08-14' };
    expect(findProblems([FINDING], [hoje], '2026-08-14')).toEqual([]);
  });

  it('reprova exceção obsoleta — o advisory sumiu do audit', () => {
    expect(findProblems([], [OK], '2026-08-14').join('\n')).toContain('exceção OBSOLETA');
  });

  it('não confunde o mesmo advisory em projetos diferentes', () => {
    const noAdmin: Finding = { ...FINDING, project: 'src/admin-ui' };
    const problems = findProblems([noAdmin], [OK], '2026-08-14');
    expect(problems.join('\n')).toContain('advisory sem exceção registrada');
    expect(problems.join('\n')).toContain('exceção OBSOLETA');
  });
});

describe('keyOf / todayUtc', () => {
  it('a chave junta projeto, pacote e advisory', () => {
    expect(keyOf(OK)).toBe('.|esbuild|GHSA-67mh-4wv8-2f99');
  });

  it('todayUtc formata em YYYY-MM-DD', () => {
    expect(todayUtc(new Date('2026-08-14T23:59:59.999Z'))).toBe('2026-08-14');
  });
});

describe('ledger real commitado', () => {
  const raw = readFileSync(join(process.cwd(), LEDGER_PATH), 'utf8');

  it('é JSON válido e estruturalmente íntegro', () => {
    const { errors } = validateLedger(JSON.parse(raw));
    expect(errors).toEqual([]);
  });

  it('não tem exceção já vencida no momento em que a suíte roda', () => {
    const { exceptions } = validateLedger(JSON.parse(raw));
    const hoje = todayUtc(new Date());
    const vencidas = exceptions.filter((e) => e.expires < hoje);
    expect(vencidas.map((e) => `${e.pkg} ${e.advisory} venceu em ${e.expires}`)).toEqual([]);
  });

  it('só referencia os projetos que o CI audita', () => {
    const { exceptions } = validateLedger(JSON.parse(raw));
    for (const e of exceptions) expect(PROJECTS).toContain(e.project);
  });
});
