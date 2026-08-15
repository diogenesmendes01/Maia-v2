/**
 * Issue #526 — ledger de exceções do `npm audit`.
 *
 * Contexto
 * --------
 * O job `dependency-audit` do CI roda `npm audit --omit=dev --audit-level=high`
 * nos dois lockfiles. Esse gate resolve o problema que a #526 abriu (produção,
 * high+), mas cria dois silêncios:
 *
 *   (a) `--omit=dev` apaga a árvore de desenvolvimento inteira. Um `critical`
 *       de RCE no vitest do admin-ui viveu meses sem que nada no CI o
 *       mencionasse — foi encontrado à mão, não pela esteira.
 *   (b) `--audit-level=high` deixa `moderate` de PRODUÇÃO passar sem registro.
 *
 * Silêncio não é decisão. Este guard converte os dois em uma escolha explícita:
 * TODO advisory que o `npm audit` reporta em qualquer um dos dois lockfiles
 * precisa ou estar corrigido, ou ter uma linha no ledger
 * `security/audit-exceptions.json` com motivo, dono e data de expiração.
 *
 * Regras (qualquer uma reprova):
 *   1. advisory reportado sem entrada no ledger  → vulnerabilidade nova, não aceita
 *   2. entrada do ledger vencida (`expires` < hoje) → a exceção precisa ser renovada
 *      ou o problema corrigido; ninguém deferiu "para sempre"
 *   3. entrada do ledger que não casa com nenhum advisory → exceção obsoleta,
 *      deve ser removida (senão o ledger vira folclore)
 *   4. entrada malformada (campo faltando, data inválida, severidade inválida,
 *      `issue` que não é URL de issue deste repositório com número)
 *   5. severidade do advisory ACIMA do teto registrado na exceção
 *      (`max_severity`) → a decisão foi tomada para um risco menor, precisa ser
 *      tomada de novo
 *   6. `npm audit` que não devolveu um relatório de auditoria reconhecível
 *      → não sabemos nada sobre aquele lockfile; ver "Fail-closed" abaixo
 *
 * A regra 3 é o que impede o ledger de crescer para sempre: assim que o
 * advisory some (upgrade, remoção do pacote), o CI EXIGE a limpeza da linha.
 *
 * A regra 3 e a regra 5 miram coisas diferentes. A 3 cuida do ledger que não
 * encolhe. A 5 cuida do RISCO: `max_severity` é um TETO, não uma igualdade — a
 * linha registra "esta exceção foi decidida para risco de até X". Enquanto o
 * npm reporta X ou menos, a decisão escrita ainda cobre o que está lá e o CI
 * não tem o que perguntar. Quando o npm reporta ACIMA de X, a justificativa
 * passa a cobrir um risco menor do que o real e alguém precisa decidir de novo.
 *
 * A versão anterior comparava por IGUALDADE e reprovava também na QUEDA de
 * severidade. Isso produzia ruído sem risco: um `moderate` reclassificado para
 * `low` continua dentro do que o dono aceitou, e reprovar ali só ensinava a
 * tratar o vermelho do guard como burocracia — o pior que pode acontecer com um
 * guard de segurança. Se a queda merecer atualizar o texto do `reason`, isso é
 * higiene de ledger, não motivo para travar o CI.
 *
 * O campo antigo `severity` NÃO é aceito como sinônimo: um ledger com o nome
 * velho reprova na validação, com instrução de renomear. Aceitar os dois nomes
 * deixaria a mesma linha sendo lida como igualdade por quem escreveu antes e
 * como teto pelo guard — que é exatamente a meia-verdade que este arquivo
 * existe para não ter. Fail-closed também vale para o formato.
 *
 * Fail-closed
 * -----------
 * O `npm audit` sai com código != 0 QUANDO ENCONTRA vulnerabilidade, então o
 * exit status não distingue "achei coisa" de "não consegui auditar" e por isso
 * é ignorado. A distinção que vale é a FORMA do relatório: um relatório de
 * sucesso do npm >= 7 traz `auditReportVersion` (que precisa ser exatamente
 * `2`, a única forma que este parser sabe ler — ver `AUDIT_REPORT_VERSION`),
 * `vulnerabilities` (objeto, possivelmente VAZIO) e `metadata`. Uma falha de registry/auth/serviço traz um
 * objeto sem nenhum desses campos e com `error` — verificado com npm 10.9.7
 * apontado para um registry morto, exit 1, stdout:
 *
 *   {"message":"request to http://127.0.0.1:9/-/npm/v1/security/audits/quick
 *    failed, reason: connect ECONNREFUSED 127.0.0.1:9",
 *    "error":{"summary":"","detail":""}}
 *
 * Sem checagem de forma esse payload atravessa o parser como "zero advisories"
 * e o guard fica VERDE — fail-OPEN num guard cuja razão de existir é ser
 * fail-closed. `validateAuditReport()` separa "relatório válido dizendo que não
 * há nada" (passa) de "não consegui obter relatório" (reprova).
 *
 * Invocação
 * ---------
 * Local: `npm run audit:exceptions:check` (via tsx, como os outros scripts).
 * CI:    `node scripts/check-audit-exceptions.ts` — o job `dependency-audit`
 *        não roda `npm ci` de propósito (lê o lockfile direto, sem serviços),
 *        então não há `tsx` disponível lá. Node >= 22.18 remove as anotações de
 *        tipo nativamente, então este arquivo é escrito só com sintaxe apagável
 *        (sem `enum`, sem `namespace`, sem parâmetro-propriedade) e roda
 *        direto. Manter assim ao editar.
 *
 * As funções puras são exportadas para
 * `tests/unit/scripts/audit-exceptions.spec.ts` exercitá-las sem rede.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Caminho do ledger, relativo à raiz do repo. */
export const LEDGER_PATH = 'security/audit-exceptions.json';

/**
 * Os dois projetos npm do repo. `npm audit` só enxerga um lockfile por vez, e
 * foi exatamente por isso que um `critical` do Next passou despercebido antes
 * da #521 — ver o comentário do job `dependency-audit` em ci.yml.
 */
export const PROJECTS: readonly string[] = ['.', 'src/admin-ui'];

export const SEVERITIES: readonly string[] = ['info', 'low', 'moderate', 'high', 'critical'];

/**
 * A ÚNICA versão de relatório que `parseAudit` sabe ler.
 *
 * Decisão 20 do dono: exigir o valor 2, não "algum número". A v1 (npm 6) trazia
 * `advisories` + `actions` em vez de `vulnerabilities` indexado por pacote com
 * `via[]`; uma v3 futura pode trazer outra coisa qualquer. Aceitar qualquer
 * número deixaria `parseAudit` varrer uma forma que não conhece, achar zero
 * findings e devolver VERDE — o mesmo fail-open que a checagem de forma existe
 * para não ter. Quando o npm publicar uma v3, o caminho é ler a forma nova e
 * mudar este arquivo, não afrouxar a comparação.
 */
export const AUDIT_REPORT_VERSION = 2;

/**
 * Forma exigida do campo `issue`: URL de uma issue DESTE repositório, com
 * número.
 *
 * Decisão 22 do dono: "a exceção deve apontar para uma issue aberta
 * específica". O campo aceitava qualquer string — `"n/a"`, `"ver o slack"`, um
 * número solto — e uma exceção sem alvo rastreável não tem para onde vencer:
 * quando `expires` chega, ninguém sabe onde está o trabalho que a encerraria.
 *
 * O que esta checagem NÃO faz, e por quê
 * --------------------------------------
 * Ela valida a FORMA, não o ESTADO. Não distingue issue aberta de fechada — a
 * URL da #526 (fechada) tem exatamente a mesma forma que a da #574 (aberta).
 *
 * Isso é deliberado, não esquecimento. Saber se a issue está aberta exige uma
 * chamada à API do GitHub, e este guard roda no job `dependency-audit`, que de
 * propósito não faz `npm ci` nem recebe credencial de API — e roda também na
 * máquina de quem desenvolve, offline. Uma checagem de estado aqui seria:
 *
 *   - flaky por rede (o guard reprovaria por indisponibilidade do GitHub, não
 *     por risco de segurança — e um guard que grita sem motivo é ignorado); e
 *   - fail-open na prática, porque a única saída sã para "não consegui
 *     consultar" seria deixar passar.
 *
 * Então a exigência de "aberta" vive onde ela pode ser cumprida: na MENSAGEM de
 * erro, lida por gente, e na revisão de quem aprova a PR que mexe no ledger. O
 * que a máquina consegue garantir sozinha — que existe um alvo específico e
 * clicável neste repositório — ela garante.
 */
export const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/diogenesmendes01\/Maia-v2\/issues\/[1-9]\d*$/;

/** Um advisory concreto encontrado pelo `npm audit` em um dos lockfiles. */
export interface Finding {
  /** Diretório do projeto (`.` ou `src/admin-ui`). */
  readonly project: string;
  /** Pacote em que o advisory foi publicado (ex.: `esbuild`). */
  readonly pkg: string;
  /** Identificador GHSA (ex.: `GHSA-67mh-4wv8-2f99`). */
  readonly advisory: string;
  readonly severity: string;
  readonly title: string;
}

/** Uma exceção aceita, com dono e prazo. */
export interface Exception {
  readonly project: string;
  readonly pkg: string;
  readonly advisory: string;
  /**
   * TETO de severidade aceito, não igualdade: o guard só reprova quando o `npm
   * audit` reporta ALGO ACIMA disto. Renomeado de `severity` justamente para o
   * nome não sugerir a comparação errada — ver regra 5 no topo.
   */
  readonly max_severity: string;
  readonly reason: string;
  readonly owner: string;
  readonly issue: string;
  /** `YYYY-MM-DD`. Depois desta data o CI reprova até renovar ou corrigir. */
  readonly expires: string;
}

/**
 * Leitura de um relatório do `npm audit --json`: ou os findings, ou o motivo
 * pelo qual aquele relatório não pode ser usado. Nunca as duas coisas — quando
 * `errors` não está vazio, `findings` vem VAZIO de propósito, e quem chama tem
 * de tratar isso como reprovação, não como ausência de vulnerabilidade.
 */
export interface AuditRead {
  readonly findings: Finding[];
  readonly errors: string[];
}

/** Chave de casamento entre finding e exceção. */
export function keyOf(x: { project: string; pkg: string; advisory: string }): string {
  return `${x.project}|${x.pkg}|${x.advisory}`;
}

/** Extrai o id GHSA de uma URL de advisory. `null` se não houver. */
export function ghsaFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = url.match(/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})/);
  return m ? m[1]! : null;
}

/** Descrição curta do que veio, para a mensagem de erro não virar enigma. */
function describeValue(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'array';
  return typeof raw;
}

/** Resumo do payload de erro do npm, truncado para não poluir o log do CI. */
function summarizeNpmError(r: Record<string, unknown>): string {
  const msg = typeof r.message === 'string' && r.message.trim() !== '' ? r.message : null;
  const detail = msg ?? JSON.stringify(r.error);
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}

/**
 * Valida que `raw` é um relatório de auditoria BEM-SUCEDIDO do `npm audit
 * --json`, e não uma falha operacional disfarçada.
 *
 * A validação é sobre a FORMA, nunca sobre o exit code (ver "Fail-closed" no
 * topo). Três campos precisam existir, e os três existem num relatório de
 * sucesso com ZERO vulnerabilidades — que é justamente o caso que precisa
 * continuar passando:
 *
 *   {"auditReportVersion":2,"vulnerabilities":{},"metadata":{...}}
 *
 * Um payload de erro do npm não tem nenhum dos três, e ainda traz `error`.
 * Exigir os três (em vez de só recusar `error`) protege também contra saídas
 * futuras ou desconhecidas: o que não for reconhecivelmente um relatório
 * reprova, em vez de ser lido como "nada encontrado".
 *
 * Devolve a lista de problemas (vazia = relatório utilizável).
 */
export function validateAuditReport(project: string, raw: unknown): string[] {
  const where = `npm audit --json em "${project}"`;
  const comoAgir =
    'Isto NÃO é "zero advisories", é ausência de auditoria: o guard reprova até ' +
    'conseguir um relatório válido daquele lockfile.';

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [`${where}: a saída não é um objeto JSON (veio ${describeValue(raw)}). ${comoAgir}`];
  }

  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (r.error !== undefined) {
    errors.push(
      `${where}: o npm devolveu um relatório de ERRO — ${summarizeNpmError(r)}. ${comoAgir}`,
    );
  }
  if (r.auditReportVersion !== AUDIT_REPORT_VERSION) {
    errors.push(
      `${where}: "auditReportVersion" é ${JSON.stringify(r.auditReportVersion) ?? 'undefined'} e ` +
        `este parser só sabe ler a versão ${AUDIT_REPORT_VERSION}. Um relatório de outra ` +
        `versão tem FORMA diferente, e lê-lo com o parser da v${AUDIT_REPORT_VERSION} produziria ` +
        `zero findings em vez de um erro. Atualize este script para a nova forma (a v2 indexa ` +
        `"vulnerabilities" por pacote, com "via[]" trazendo url/title/severity) antes de ` +
        `aceitá-la. ${comoAgir}`,
    );
  }
  const vulns = r.vulnerabilities;
  if (typeof vulns !== 'object' || vulns === null || Array.isArray(vulns)) {
    errors.push(
      `${where}: campo "vulnerabilities" ausente ou não é um objeto (veio ` +
        `${describeValue(vulns)}). ${comoAgir}`,
    );
  }
  const metadata = r.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    errors.push(
      `${where}: campo "metadata" ausente ou não é um objeto (veio ` +
        `${describeValue(metadata)}). ${comoAgir}`,
    );
  }

  return errors;
}

/**
 * Converte a saída de `npm audit --json` em findings, DEPOIS de validar que a
 * saída é mesmo um relatório de auditoria (`validateAuditReport`).
 *
 * Só entram os `via` que são OBJETO — esses carregam o advisory de verdade
 * (`url`, `title`, `severity`). Os `via` string ("este pacote é vulnerável
 * porque depende daquele") são derivados: `@esbuild-kit/core-utils` não tem
 * advisory próprio, ele herda o do `esbuild`. Exigir uma linha de ledger para
 * cada nó derivado inflaria o ledger sem acrescentar decisão nenhuma — o que se
 * aceita é o advisory, não cada aresta do grafo.
 */
export function parseAudit(project: string, raw: unknown): AuditRead {
  const errors = validateAuditReport(project, raw);
  if (errors.length > 0) return { findings: [], errors };

  const out: Finding[] = [];
  const seen = new Set<string>();
  const report = raw as { vulnerabilities: Record<string, unknown> };
  for (const entry of Object.values(report.vulnerabilities)) {
    const v = entry as { via?: unknown[] };
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const o = via as { name?: unknown; url?: unknown; title?: unknown; severity?: unknown };
      const advisory = ghsaFromUrl(o.url);
      if (!advisory) continue;
      const pkg = typeof o.name === 'string' ? o.name : '(desconhecido)';
      const finding: Finding = {
        project,
        pkg,
        advisory,
        severity: typeof o.severity === 'string' ? o.severity : 'unknown',
        title: typeof o.title === 'string' ? o.title : '',
      };
      const k = keyOf(finding);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(finding);
    }
  }
  return { findings: out.sort((a, b) => keyOf(a).localeCompare(keyOf(b))), errors: [] };
}

/**
 * `true` só para uma data de calendário que EXISTE.
 *
 * `Date.parse('2026-02-31T00:00:00Z')` não devolve NaN: o V8 normaliza para
 * 2026-03-03. Uma exceção com `expires: "2026-02-31"` ganharia três dias de
 * vida silenciosos e, pior, deixaria no ledger uma data que ninguém escreveu de
 * propósito — num arquivo cujo valor inteiro é ser lido por humanos. Aqui os
 * componentes são reconstruídos em UTC e comparados com o que foi escrito.
 */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Valida a forma do ledger. Retorna a lista de problemas (vazia = íntegro). */
export function validateLedger(parsed: unknown): { exceptions: Exception[]; errors: string[] } {
  const errors: string[] = [];
  const exceptions: Exception[] = [];

  if (!Array.isArray(parsed)) {
    return { exceptions, errors: [`${LEDGER_PATH}: o conteúdo precisa ser um array JSON`] };
  }

  const required = [
    'project',
    'pkg',
    'advisory',
    'max_severity',
    'reason',
    'owner',
    'issue',
    'expires',
  ];
  const seen = new Set<string>();

  for (let i = 0; i < parsed.length; i += 1) {
    const row = parsed[i] as Record<string, unknown>;
    const where = `${LEDGER_PATH}[${i}]`;
    if (typeof row !== 'object' || row === null) {
      errors.push(`${where}: entrada precisa ser um objeto`);
      continue;
    }
    // Campo antigo: reprova ANTES de reclamar de `max_severity` ausente, senão
    // o diagnóstico seria "faltou um campo" quando o fato é "este campo mudou
    // de nome E de semântica". A mensagem tem de dizer as duas coisas.
    if ('severity' in row) {
      errors.push(
        `${where}: o campo "severity" foi renomeado para "max_severity" e passou a ser um ` +
          `TETO, não uma igualdade — o guard só reprova quando o npm audit reporta severidade ` +
          `ACIMA dele. Renomeie "severity" para "max_severity" nesta entrada e confirme que o ` +
          `valor ainda é o maior risco que você aceita para este advisory.`,
      );
      continue;
    }
    let ok = true;
    for (const f of required) {
      if (typeof row[f] !== 'string' || (row[f] as string).trim() === '') {
        errors.push(`${where}: campo "${f}" ausente ou vazio`);
        ok = false;
      }
    }
    if (!ok) continue;

    const e = row as unknown as Exception;
    if (!PROJECTS.includes(e.project)) {
      errors.push(`${where}: project "${e.project}" não é um dos projetos (${PROJECTS.join(', ')})`);
      continue;
    }
    if (!SEVERITIES.includes(e.max_severity)) {
      errors.push(`${where}: max_severity "${e.max_severity}" inválida (${SEVERITIES.join(', ')})`);
      continue;
    }
    if (!/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(e.advisory)) {
      errors.push(`${where}: advisory "${e.advisory}" não tem a forma GHSA-xxxx-xxxx-xxxx`);
      continue;
    }
    if (!ISSUE_URL_PATTERN.test(e.issue)) {
      errors.push(
        `${where}: issue "${e.issue}" não é uma URL de issue deste repositório com número ` +
          `(esperado https://github.com/diogenesmendes01/Maia-v2/issues/<n>). A exceção precisa ` +
          `apontar para uma issue ABERTA e específica — é ela que recebe o trabalho quando ` +
          `"expires" chegar. O guard só consegue verificar a FORMA da URL: que a issue está ` +
          `mesmo aberta é responsabilidade de quem escreve e de quem revisa o ledger.`,
      );
      continue;
    }
    if (!isCalendarDate(e.expires)) {
      errors.push(`${where}: expires "${e.expires}" não é uma data YYYY-MM-DD válida`);
      continue;
    }
    const k = keyOf(e);
    if (seen.has(k)) {
      errors.push(`${where}: entrada duplicada para ${k}`);
      continue;
    }
    seen.add(k);
    exceptions.push(e);
  }

  return { exceptions, errors };
}

/**
 * Cruza findings x exceções. `today` entra por parâmetro para o spec poder
 * congelar o relógio. Puro: quem chama traz os dois lados.
 */
export function findProblems(
  findings: readonly Finding[],
  exceptions: readonly Exception[],
  today: string,
): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, Exception>();
  for (const e of exceptions) byKey.set(keyOf(e), e);

  const found = new Set(findings.map(keyOf));

  for (const f of findings) {
    const e = byKey.get(keyOf(f));
    if (!e) {
      problems.push(
        `advisory sem exceção registrada: ${f.project} → ${f.pkg} [${f.severity}] ` +
          `${f.advisory} (${f.title || 'sem título'}). Corrija o lockfile ou registre a ` +
          `exceção em ${LEDGER_PATH} com motivo, dono e expires.`,
      );
      continue;
    }
    // A severidade NÃO entra na chave de propósito: se entrasse, um drift
    // viraria dois problemas contraditórios para a mesma linha ("advisory sem
    // exceção registrada" + "exceção OBSOLETA"), e quem lesse o CI procuraria
    // uma linha que existe e está quase certa. Como comparação, o diagnóstico é
    // único e diz exatamente qual campo editar.
    const nivel = SEVERITIES.indexOf(f.severity);
    if (nivel < 0) {
      // Fail-closed obrigatório aqui. `indexOf` devolve -1 para uma severidade
      // que não sabemos ler, e -1 nunca é MAIOR que o teto: sem este ramo, um
      // relatório com severidade ilegível (campo ausente, valor novo do npm)
      // passaria batido justamente por ser incompreensível.
      problems.push(
        `severidade "${f.severity}" não está na escala conhecida (${SEVERITIES.join(', ')}): ` +
          `${f.project} → ${f.pkg} ${f.advisory}. Sem conseguir situá-la na escala, o guard ` +
          `não consegue compará-la com o teto "${e.max_severity}" e reprova.`,
      );
    } else if (nivel > SEVERITIES.indexOf(e.max_severity)) {
      problems.push(
        `severidade ACIMA do teto aceito: ${f.project} → ${f.pkg} ${f.advisory} foi aceito ` +
          `com teto "${e.max_severity}" e o npm audit hoje reporta "${f.severity}". A decisão ` +
          `de ${e.owner} vale para um risco menor. Reavalie e atualize "max_severity" e ` +
          `"reason" em ${LEDGER_PATH}, ou corrija o advisory. (Uma QUEDA de severidade não ` +
          `reprova: o teto continua cobrindo o risco.)`,
      );
    }
    if (e.expires < today) {
      problems.push(
        `exceção VENCIDA em ${e.expires} (hoje ${today}): ${e.project} → ${e.pkg} ` +
          `${e.advisory}. Dono: ${e.owner}. Renove com nova justificativa ou corrija.`,
      );
    }
  }

  for (const e of exceptions) {
    if (!found.has(keyOf(e))) {
      problems.push(
        `exceção OBSOLETA: ${e.project} → ${e.pkg} ${e.advisory} não aparece mais no ` +
          `npm audit. Remova a linha de ${LEDGER_PATH} — ledger que não encolhe vira folclore.`,
      );
    }
  }

  return problems.sort();
}

/** `YYYY-MM-DD` em UTC. */
export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Como INVOCAR o `npm audit` na plataforma atual — arquivo, argumentos e se
 * precisa de shell.
 *
 * Round 2 do review da PR #564. A primeira correção trocou `'npm'` por
 * `'npm.cmd'` no Windows e isso resolvia o `ENOENT` — mas produzia `EINVAL`,
 * porque `.cmd` é script do `cmd.exe` e `execFileSync` não o executa sem
 * shell. O teste anterior só afirmava que a função devolvia a string
 * `'npm.cmd'`, então ficava verde sem nunca atravessar a fronteira de
 * processo. Duas lições, e a segunda é a que importa: uma correção
 * cross-platform testada só por igualdade de string não é testada.
 *
 * `shell: true` aqui NÃO é superfície de injeção: o comando e os argumentos são
 * constantes literais, e o diretório do projeto entra por `cwd` — nunca
 * concatenado na linha de comando, então caminho com espaço também não é
 * problema.
 */
export interface AuditSpawn {
  readonly file: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export function auditSpawn(platform: string = process.platform): AuditSpawn {
  return { file: 'npm', args: ['audit', '--json'], shell: platform === 'win32' };
}

/** Assinatura do executor, para o teste observar a chamada REAL sem Windows. */
export type Exec = (spawn: AuditSpawn, cwd: string) => string;

const defaultExec: Exec = (spawn, cwd) =>
  execFileSync(spawn.file, [...spawn.args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: spawn.shell,
  });

export function runAudit(
  projectDir: string,
  exec: Exec = defaultExec,
  platform: string = process.platform,
): unknown {
  let stdout: string;
  try {
    stdout = exec(auditSpawn(platform), projectDir);
  } catch (err) {
    const e = err as { stdout?: string };
    if (typeof e.stdout !== 'string' || e.stdout.trim() === '') throw err;
    stdout = e.stdout;
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `saída de \`npm audit --json\` não é JSON (${(err as Error).message}): ${stdout.slice(0, 300)}`,
      { cause: err },
    );
  }
}

/** Como o guard obtém o relatório de um projeto. Injetável para o spec. */
export type AuditReader = (projectDir: string) => unknown;

/** O veredito do guard, sem efeito colateral de processo. */
export interface GuardResult {
  /** Vazio = verde. */
  readonly problems: string[];
  readonly findings: Finding[];
  readonly exceptions: Exception[];
}

/**
 * Todo o trabalho do guard, sem tocar em `process`. `audit` entra por parâmetro
 * para o spec simular relatório de erro ou lockfile limpo sem rede.
 */
export function evaluateGuard(
  repoRoot: string,
  now: Date,
  audit: AuditReader = runAudit,
): GuardResult {
  const ledgerRaw = readFileSync(join(repoRoot, LEDGER_PATH), 'utf8');
  let parsedLedger: unknown;
  try {
    parsedLedger = JSON.parse(ledgerRaw);
  } catch (err) {
    return {
      problems: [`${LEDGER_PATH}: JSON inválido (${(err as Error).message})`],
      findings: [],
      exceptions: [],
    };
  }

  const { exceptions, errors } = validateLedger(parsedLedger);

  const findings: Finding[] = [];
  const auditErrors: string[] = [];
  for (const project of PROJECTS) {
    let raw: unknown;
    try {
      raw = audit(join(repoRoot, project));
    } catch (err) {
      auditErrors.push(
        `npm audit --json em "${project}" não pôde ser executado: ${(err as Error).message}`,
      );
      continue;
    }
    const read = parseAudit(project, raw);
    auditErrors.push(...read.errors);
    findings.push(...read.findings);
  }

  // Se UM dos lockfiles não pôde ser auditado, o cruzamento com o ledger não
  // vale: as entradas daquele projeto apareceriam como "exceção OBSOLETA", o
  // que é mentira — o advisory pode continuar lá, só não conseguimos olhar.
  // Reprova com o motivo real e não inventa diagnóstico em cima do escuro.
  if (auditErrors.length > 0) {
    return { problems: [...errors, ...auditErrors], findings, exceptions };
  }

  return {
    problems: [...errors, ...findProblems(findings, exceptions, todayUtc(now))],
    findings,
    exceptions,
  };
}

function fail(message: string): never {
  console.error(`\n✖ check-audit-exceptions falhou:\n${message}\n`);
  process.exit(1);
}

export function runGuard(repoRoot: string, now: Date, audit: AuditReader = runAudit): void {
  const { problems, findings, exceptions } = evaluateGuard(repoRoot, now, audit);

  if (problems.length > 0) {
    fail(problems.map((p) => `  - ${p}`).join('\n'));
  }

  console.log(
    `check-audit-exceptions passou: ${PROJECTS.length} lockfiles auditados com relatório ` +
      `válido, ${findings.length} advisory(s), ${exceptions.length} exceção(ões) registrada(s) — ` +
      `todas dentro do teto de severidade aceito e dentro do prazo.`,
  );
}

/**
 * Só roda `main()` quando este arquivo é o entrypoint — não quando o spec
 * importa os helpers puros. Mesma técnica de scripts/check-migration-reservations.ts.
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  runGuard(process.cwd(), new Date());
}
