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
 *   4. entrada malformada (campo faltando, data inválida, severidade inválida)
 *
 * A regra 3 é o que impede o ledger de crescer para sempre: assim que o
 * advisory some (upgrade, remoção do pacote), o CI EXIGE a limpeza da linha.
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
  readonly severity: string;
  readonly reason: string;
  readonly owner: string;
  readonly issue: string;
  /** `YYYY-MM-DD`. Depois desta data o CI reprova até renovar ou corrigir. */
  readonly expires: string;
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

/**
 * Converte a saída de `npm audit --json` em findings.
 *
 * Só entram os `via` que são OBJETO — esses carregam o advisory de verdade
 * (`url`, `title`, `severity`). Os `via` string ("este pacote é vulnerável
 * porque depende daquele") são derivados: `@esbuild-kit/core-utils` não tem
 * advisory próprio, ele herda o do `esbuild`. Exigir uma linha de ledger para
 * cada nó derivado inflaria o ledger sem acrescentar decisão nenhuma — o que se
 * aceita é o advisory, não cada aresta do grafo.
 */
export function parseAudit(project: string, raw: unknown): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const report = raw as { vulnerabilities?: Record<string, unknown> };
  const vulns = report.vulnerabilities ?? {};
  for (const entry of Object.values(vulns)) {
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
  return out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** Valida a forma do ledger. Retorna a lista de problemas (vazia = íntegro). */
export function validateLedger(parsed: unknown): { exceptions: Exception[]; errors: string[] } {
  const errors: string[] = [];
  const exceptions: Exception[] = [];

  if (!Array.isArray(parsed)) {
    return { exceptions, errors: [`${LEDGER_PATH}: o conteúdo precisa ser um array JSON`] };
  }

  const required = ['project', 'pkg', 'advisory', 'severity', 'reason', 'owner', 'issue', 'expires'];
  const seen = new Set<string>();

  for (let i = 0; i < parsed.length; i += 1) {
    const row = parsed[i] as Record<string, unknown>;
    const where = `${LEDGER_PATH}[${i}]`;
    if (typeof row !== 'object' || row === null) {
      errors.push(`${where}: entrada precisa ser um objeto`);
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
    if (!SEVERITIES.includes(e.severity)) {
      errors.push(`${where}: severity "${e.severity}" inválida (${SEVERITIES.join(', ')})`);
      continue;
    }
    if (!/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(e.advisory)) {
      errors.push(`${where}: advisory "${e.advisory}" não tem a forma GHSA-xxxx-xxxx-xxxx`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires) || Number.isNaN(Date.parse(`${e.expires}T00:00:00Z`))) {
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
 * Roda `npm audit --json` num projeto. O `npm audit` sai com código != 0
 * QUANDO ENCONTRA vulnerabilidade, então o status é ignorado de propósito e o
 * que vale é o JSON no stdout.
 */
export function runAudit(projectDir: string): unknown {
  let stdout: string;
  try {
    stdout = execFileSync('npm', ['audit', '--json'], {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: string };
    if (typeof e.stdout !== 'string' || e.stdout.trim() === '') throw err;
    stdout = e.stdout;
  }
  return JSON.parse(stdout);
}

function fail(message: string): never {
  console.error(`\n✖ check-audit-exceptions falhou:\n${message}\n`);
  process.exit(1);
}

export function runGuard(repoRoot: string, now: Date): void {
  const ledgerRaw = readFileSync(join(repoRoot, LEDGER_PATH), 'utf8');
  let parsedLedger: unknown;
  try {
    parsedLedger = JSON.parse(ledgerRaw);
  } catch (err) {
    fail(`  - ${LEDGER_PATH}: JSON inválido (${(err as Error).message})`);
  }

  const { exceptions, errors } = validateLedger(parsedLedger);

  const findings: Finding[] = [];
  for (const project of PROJECTS) {
    findings.push(...parseAudit(project, runAudit(join(repoRoot, project))));
  }

  const problems = [...errors, ...findProblems(findings, exceptions, todayUtc(now))];

  if (problems.length > 0) {
    fail(problems.map((p) => `  - ${p}`).join('\n'));
  }

  console.log(
    `check-audit-exceptions passou: ${findings.length} advisory(s) nos ${PROJECTS.length} ` +
      `lockfiles, ${exceptions.length} exceção(ões) registrada(s) e todas dentro do prazo.`,
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
