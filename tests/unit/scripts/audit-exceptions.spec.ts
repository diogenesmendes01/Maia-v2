/**
 * Issue #526 — guard do ledger de exceções do `npm audit`.
 *
 * Exercita as funções puras de `scripts/check-audit-exceptions.ts` com
 * entradas sintéticas (sem rede, sem `npm audit`), MAIS uma checagem contra o
 * ledger real commitado: um ledger malformado ou vencido reprova aqui antes de
 * reprovar no CI.
 *
 * As funções importadas são as de PRODUÇÃO — nada de reimplementar a validação
 * no harness. Se `check-audit-exceptions.ts` perder uma regra, estes testes
 * ficam vermelhos.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  LEDGER_PATH,
  PROJECTS,
  ghsaFromUrl,
  isCalendarDate,
  keyOf,
  runAudit,
  type AuditSpawn,
  type Exec,
  parseAudit,
  validateAuditReport,
  validateLedger,
  findProblems,
  evaluateGuard,
  todayUtc,
  type AuditReader,
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

/** Metadata mínima, na forma que o npm >= 7 emite. */
const METADATA = {
  vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
};

/**
 * Relatório de SUCESSO com zero vulnerabilidades — a forma literal que
 * `npm audit --json` imprime num lockfile limpo (verificado com npm 10.9.7).
 * Este é o caso que precisa continuar PASSANDO: a distinção do guard é entre
 * "relatório válido dizendo que não há nada" e "não consegui obter relatório".
 */
const RELATORIO_LIMPO = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: METADATA,
};

/** Relatório de sucesso da raiz, com o advisory do esbuild que está no ledger. */
function relatorioComEsbuild(severity = 'moderate'): unknown {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      esbuild: {
        name: 'esbuild',
        severity,
        via: [
          {
            source: 1102341,
            name: 'esbuild',
            dependency: 'esbuild',
            title: 'esbuild enables any website to send any request to the development server',
            url: 'https://github.com/advisories/GHSA-67mh-4wv8-2f99',
            severity,
            range: '<=0.24.2',
          },
        ],
      },
      '@esbuild-kit/core-utils': { via: ['esbuild'] },
    },
    metadata: METADATA,
  };
}

/**
 * O payload que `npm audit --json` realmente escreve no stdout quando não
 * consegue falar com o registry — capturado de `npm audit --json
 * --registry=http://127.0.0.1:9/` (npm 10.9.7, exit 1).
 */
const RELATORIO_DE_ERRO = {
  message:
    'request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, ' +
    'reason: connect ECONNREFUSED 127.0.0.1:9',
  error: { summary: '', detail: '' },
};

const REPO_ROOT = process.cwd();

/** Leitor de audit falso, indexado pelo caminho do projeto relativo à raiz. */
function leitorFake(porProjeto: Record<string, unknown>): AuditReader {
  return (dir: string) => {
    const rel = relative(REPO_ROOT, dir) || '.';
    if (!(rel in porProjeto)) throw new Error(`projeto inesperado no teste: ${rel}`);
    return porProjeto[rel];
  };
}

const CONGELADO = new Date('2026-08-14T12:00:00Z');

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
      auditReportVersion: 2,
      metadata: METADATA,
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
    const { findings, errors } = parseAudit('.', raw);
    expect(errors).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.pkg).toBe('esbuild');
    expect(findings[0]!.advisory).toBe('GHSA-67mh-4wv8-2f99');
  });

  it('deduplica o mesmo advisory reportado em vários nós', () => {
    const via = {
      name: 'brace-expansion',
      url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
      title: 'DoS',
      severity: 'high',
    };
    const raw = {
      auditReportVersion: 2,
      metadata: METADATA,
      vulnerabilities: { 'brace-expansion': { via: [via, via, via] } },
    } as unknown;
    expect(parseAudit('.', raw).findings).toHaveLength(1);
  });

  it('aceita um relatório de SUCESSO com zero vulnerabilidades', () => {
    const { findings, errors } = parseAudit('src/admin-ui', RELATORIO_LIMPO);
    expect(errors).toEqual([]);
    expect(findings).toEqual([]);
  });
});

/**
 * O achado [High] da review: erro operacional do `npm audit` virava "zero
 * advisories" e o guard ficava VERDE. A validação é sobre a FORMA do relatório,
 * nunca sobre o exit code — o `npm audit` sai != 0 também quando ACHA
 * vulnerabilidade.
 */
describe('validateAuditReport — fail-closed sobre a forma do relatório', () => {
  it('aprova o relatório de sucesso com zero vulnerabilidades', () => {
    expect(validateAuditReport('src/admin-ui', RELATORIO_LIMPO)).toEqual([]);
  });

  it('aprova o relatório de sucesso COM vulnerabilidade', () => {
    expect(validateAuditReport('.', relatorioComEsbuild())).toEqual([]);
  });

  it('reprova o relatório de ERRO do npm', () => {
    const errors = validateAuditReport('src/admin-ui', RELATORIO_DE_ERRO);
    expect(errors.join('\n')).toContain('relatório de ERRO');
    expect(errors.join('\n')).toContain('ECONNREFUSED');
  });

  it('reprova relatório sem "vulnerabilities"', () => {
    const errors = validateAuditReport('.', { auditReportVersion: 2, metadata: METADATA });
    expect(errors.join('\n')).toContain('"vulnerabilities" ausente ou não é um objeto');
  });

  it('reprova "vulnerabilities" que não é objeto', () => {
    for (const v of [[], 'nenhuma', 0, null]) {
      const errors = validateAuditReport('.', {
        auditReportVersion: 2,
        metadata: METADATA,
        vulnerabilities: v,
      });
      expect(errors.join('\n')).toContain('"vulnerabilities" ausente ou não é um objeto');
    }
  });

  it('reprova relatório sem "auditReportVersion" e sem "metadata"', () => {
    const errors = validateAuditReport('.', { vulnerabilities: {} }).join('\n');
    expect(errors).toContain('"auditReportVersion" numérico');
    expect(errors).toContain('"metadata" ausente ou não é um objeto');
  });

  it('reprova o que nem objeto é', () => {
    expect(validateAuditReport('.', null).join('\n')).toContain('não é um objeto JSON');
    expect(validateAuditReport('.', []).join('\n')).toContain('veio array');
    expect(validateAuditReport('.', 'texto').join('\n')).toContain('veio string');
  });

  it('parseAudit NÃO devolve findings vazios em silêncio para relatório inválido', () => {
    // Sonda literal do dono: `parseAudit` chamada direto com o payload de erro
    // do npm devolvia `[]` — fail-open. Agora devolve o motivo.
    const { findings, errors } = parseAudit('src/admin-ui', RELATORIO_DE_ERRO);
    expect(findings).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('a invocação do npm audit precisa ATRAVESSAR a fronteira no Windows', () => {
  /**
   * Round 2 do review da #564. A correção anterior devolvia `'npm.cmd'` e o
   * teste afirmava exatamente isso — igualdade de string. Ficava verde
   * enquanto o comando continuava quebrado no Windows, porque `.cmd` é script
   * do `cmd.exe` e `execFileSync` não o executa sem shell: o `ENOENT` virava
   * `EINVAL`.
   *
   * A lição está no formato destes casos: eles observam o DESCRITOR DE SPAWN
   * inteiro que chega ao executor, não o nome do arquivo. Um teste de
   * cross-platform que só compara string não testa cross-platform.
   */
  it('no win32 a invocação pede shell — sem ele, .cmd dá EINVAL', () => {
    const visto: Array<{ spawn: AuditSpawn; cwd: string }> = [];
    const exec: Exec = (spawn, cwd) => {
      visto.push({ spawn, cwd });
      return JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} });
    };

    runAudit('/projeto/qualquer', exec, 'win32');

    expect(visto).toHaveLength(1);
    expect(
      visto[0]!.spawn.shell,
      'sem shell no win32, `npm`/`npm.cmd` não é executável por execFileSync',
    ).toBe(true);
    expect(visto[0]!.spawn.file).toBe('npm');
    expect(visto[0]!.spawn.args).toEqual(['audit', '--json']);
  });

  it('fora do win32 NÃO usa shell — é processo direto', () => {
    for (const plataforma of ['linux', 'darwin', 'freebsd']) {
      const visto: AuditSpawn[] = [];
      const exec: Exec = (spawn) => {
        visto.push(spawn);
        return JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} });
      };
      runAudit('/projeto', exec, plataforma);
      expect(visto[0]!.shell, `${plataforma} não deveria precisar de shell`).toBe(false);
      expect(visto[0]!.args).toEqual(['audit', '--json']);
    }
  });

  it('o diretório vai por cwd, NUNCA concatenado na linha de comando', () => {
    // É o que mantém `shell: true` sem superfície de injeção, e o que faz
    // caminho com espaço funcionar.
    const visto: Array<{ spawn: AuditSpawn; cwd: string }> = [];
    const exec: Exec = (spawn, cwd) => {
      visto.push({ spawn, cwd });
      return JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} });
    };

    runAudit('C:\\Program Files\\meu projeto', exec, 'win32');

    expect(visto[0]!.cwd).toBe('C:\\Program Files\\meu projeto');
    expect(visto[0]!.spawn.args.join(' ')).not.toContain('meu projeto');
    expect(visto[0]!.spawn.file).not.toContain('meu projeto');
  });

  it('EXECUÇÃO REAL na plataforma corrente: o npm responde de verdade', () => {
    // O único caso que atravessa a fronteira de processo. No Linux do CI ele
    // exercita o ramo sem shell; num runner Windows exercitaria o outro. É a
    // rede que os três casos acima, por serem observação de descritor, não dão.
    const relatorio = runAudit(process.cwd()) as { auditReportVersion?: unknown };
    expect(
      typeof relatorio.auditReportVersion,
      'o npm audit não devolveu um relatório utilizável na plataforma corrente',
    ).toBe('number');
  }, 120_000);
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

/**
 * Achado [Medium] da review: `severity` era validada no ledger mas nunca
 * comparada com o advisory real. Uma exceção aceita como `moderate` seguia
 * liberando o CI depois do GHSA ser reclassificado para `critical`.
 */
describe('findProblems — drift de severidade', () => {
  it('reprova advisory que ESCALOU de moderate para critical', () => {
    const escalado: Finding = { ...FINDING, severity: 'critical' };
    const problems = findProblems([escalado], [OK], '2026-08-14').join('\n');
    expect(problems).toContain('severidade DIVERGENTE (ESCALOU)');
    expect(problems).toContain('foi aceito como "moderate"');
    expect(problems).toContain('reporta "critical"');
  });

  it('reprova também quando a severidade CAI — o ledger passou a mentir', () => {
    const rebaixado: Finding = { ...FINDING, severity: 'low' };
    const problems = findProblems([rebaixado], [OK], '2026-08-14').join('\n');
    expect(problems).toContain('severidade DIVERGENTE');
    expect(problems).not.toContain('ESCALOU');
  });

  it('o drift é UM diagnóstico, não "advisory sem exceção" + "exceção obsoleta"', () => {
    // A severidade fica fora da CHAVE de propósito: se entrasse, quem lesse o
    // CI procuraria uma linha que existe e está quase certa.
    const escalado: Finding = { ...FINDING, severity: 'critical' };
    const problems = findProblems([escalado], [OK], '2026-08-14');
    expect(problems).toHaveLength(1);
    expect(problems.join('\n')).not.toContain('advisory sem exceção registrada');
    expect(problems.join('\n')).not.toContain('exceção OBSOLETA');
  });

  it('drift e vencimento são fatos independentes e aparecem os dois', () => {
    const escalado: Finding = { ...FINDING, severity: 'high' };
    const vencida = { ...OK, expires: '2026-08-13' };
    const problems = findProblems([escalado], [vencida], '2026-08-14').join('\n');
    expect(problems).toContain('severidade DIVERGENTE');
    expect(problems).toContain('exceção VENCIDA');
  });

  it('severidade ilegível no relatório não casa com nenhuma exceção', () => {
    const semSeveridade: Finding = { ...FINDING, severity: 'unknown' };
    expect(findProblems([semSeveridade], [OK], '2026-08-14').join('\n')).toContain(
      'severidade DIVERGENTE',
    );
  });
});

/**
 * O guard inteiro, com o ledger REAL commitado e o `npm audit` injetado.
 * Reproduz o cenário concreto descrito na review: o audit da raiz encontra o
 * `esbuild` conhecido (que casa com a exceção), o audit do admin-ui devolve
 * JSON de erro, não há exceção obsoleta — e antes da correção `runGuard`
 * PASSAVA.
 */
describe('evaluateGuard — o cenário concreto da review', () => {
  it('passa quando os dois lockfiles devolvem relatório válido', () => {
    const { problems } = evaluateGuard(
      REPO_ROOT,
      CONGELADO,
      leitorFake({ '.': relatorioComEsbuild(), 'src/admin-ui': RELATORIO_LIMPO }),
    );
    expect(problems).toEqual([]);
  });

  it('REPROVA quando o admin-ui devolve relatório de ERRO e a raiz está casada', () => {
    const { problems } = evaluateGuard(
      REPO_ROOT,
      CONGELADO,
      leitorFake({ '.': relatorioComEsbuild(), 'src/admin-ui': RELATORIO_DE_ERRO }),
    );
    expect(problems.length).toBeGreaterThan(0);
    const texto = problems.join('\n');
    expect(texto).toContain('npm audit --json em "src/admin-ui"');
    expect(texto).toContain('relatório de ERRO');
    // E não inventa "exceção obsoleta" sobre um lockfile que ninguém conseguiu ler.
    expect(texto).not.toContain('exceção OBSOLETA');
  });

  it('REPROVA quando é a RAIZ que falha, mesmo com o admin-ui limpo', () => {
    const { problems } = evaluateGuard(
      REPO_ROOT,
      CONGELADO,
      leitorFake({ '.': RELATORIO_DE_ERRO, 'src/admin-ui': RELATORIO_LIMPO }),
    );
    expect(problems.join('\n')).toContain('npm audit --json em "."');
  });

  it('REPROVA quando o leitor levanta erro (npm ausente, stdout não-JSON)', () => {
    const explode: AuditReader = (dir) => {
      if (dir.endsWith('admin-ui')) throw new Error('spawnSync npm ENOENT');
      return relatorioComEsbuild();
    };
    const { problems } = evaluateGuard(REPO_ROOT, CONGELADO, explode);
    expect(problems.join('\n')).toContain('não pôde ser executado: spawnSync npm ENOENT');
  });

  it('REPROVA quando o advisory do ledger real escala para critical', () => {
    const { problems } = evaluateGuard(
      REPO_ROOT,
      CONGELADO,
      leitorFake({ '.': relatorioComEsbuild('critical'), 'src/admin-ui': RELATORIO_LIMPO }),
    );
    expect(problems.join('\n')).toContain('severidade DIVERGENTE (ESCALOU)');
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
