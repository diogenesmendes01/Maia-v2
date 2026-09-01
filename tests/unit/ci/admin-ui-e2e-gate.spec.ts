/**
 * Guard do gate do console (#472 parte A — pré-requisito de #604 e #605).
 *
 * O job `admin-ui` de `.github/workflows/ci.yml` é o que faz um `next build`
 * quebrado e uma regressão de runtime do console REPROVAREM a PR. Este arquivo
 * existe porque um gate de CI tem exatamente as mesmas doenças de qualquer
 * outro código — só que a doença aqui é sempre silenciosa:
 *
 *   - alguém marca o passo com `continue-on-error` "só pra destravar" e o
 *     gate vira aviso;
 *   - alguém tira o `--min` do guard de volume e "0 tests" volta a ser verde;
 *   - o bloco de env do build do CI e o do `src/admin-ui/Dockerfile` se
 *     separam, e o CI passa a construir num ambiente que a imagem de produção
 *     não tem (foi assim que o bloco do Dockerfile ficou desatualizado a ponto
 *     de o build da imagem do console estar QUEBRADO sem ninguém notar);
 *   - a quarentena (`@pendente-runtime`) cresce em silêncio até o gate medir
 *     nada — ou um arquivo inteiro fica marcado por causa de UM caso que
 *     precisa de infra, levando junto os que não precisavam;
 *   - o typecheck volta para ANTES do build, e os tipos que o `next build`
 *     GERA (`.next/types/**`, o contrato de rota do Next 16) deixam de ser
 *     checados sem que nada fique vermelho;
 *   - o E2E volta para `next start`, e o CI passa a medir um servidor que
 *     ninguém executa — o artefato de produção é `.next/standalone`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Anti-espelho
 * ─────────────────────────────────────────────────────────────────────────
 * Uma spec de workflow que reconstrói o YAML esperado a partir da própria
 * cópia dele passa mesmo quando o workflow real muda. Aqui NADA é reconstruído:
 *
 *   - o workflow é PARSEADO de verdade (parser YAML, `jobs['admin-ui'].steps`),
 *     lido do disco;
 *   - o contrato do artefato (entrypoint e destino do estático) sai do PRÓPRIO
 *     `src/admin-ui/Dockerfile`, também lido do disco;
 *   - e o bloco `env:` do passo de E2E não é comparado com um literal: ele é
 *     EXECUTADO contra `register()` de `src/admin-ui/instrumentation.ts` — a
 *     função de produção que o Next awaita antes do primeiro request. Se o
 *     bloco do workflow deixar de bootar o console, este arquivo fica
 *     vermelho.
 *
 * [declaração]: este arquivo LÊ o workflow, o Dockerfile, o tsconfig e as
 * specs, e EXECUTA o gate de boot do console contra o env do workflow. Ele não
 * executa o CI — o que ele impede é o gate ser desarmado por edição.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONTRACT_ENTRIES, TOMBSTONES } from '@/config/contract.js';
import { register } from '@/admin-ui/instrumentation.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const CI_YML = join(REPO_ROOT, '.github/workflows/ci.yml');
const DOCKERFILE = join(REPO_ROOT, 'src/admin-ui/Dockerfile');
const SCRIPT_E2E = join(REPO_ROOT, 'scripts/admin-ui-e2e.sh');
const TSCONFIG_ADMIN = join(REPO_ROOT, 'src/admin-ui/tsconfig.json');
const E2E_DIR = join(REPO_ROOT, 'tests/admin-ui/e2e');

/** A tag como o Playwright a vê: dentro do título de um `test.describe`. */
const TAG_NO_DESCRIBE = /^test\.describe\(.*@pendente-runtime/m;

const ci = readFileSync(CI_YML, 'utf8');
const dockerfile = readFileSync(DOCKERFILE, 'utf8');
const scriptE2e = readFileSync(SCRIPT_E2E, 'utf8');
/**
 * O script SEM as linhas de comentário. O cabeçalho dele explica por que o
 * E2E deixou de usar `next start`, e uma varredura sobre o texto cru leria
 * essa explicação como se fosse o comando.
 */
const scriptE2eExecutavel = scriptE2e
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** Nomes dos passos, para as mensagens de erro. */
const PASSO_BUILD = 'Build do console (next build)';
const PASSO_ARTEFATO = 'Artefato do build existe';
const PASSO_TYPECHECK = 'Typecheck do console PÓS-BUILD (tsc --noEmit)';
const PASSO_E2E = 'E2E do console (Playwright, projeto `smoke`)';
const PASSO_QUARENTENA = 'Quarentena da suíte e2e (o que NÃO foi medido)';

/**
 * Specs e2e que estão FORA do gate.
 *
 * VAZIA. As dez jornadas do console são gate bloqueante — pareamento incluído.
 *
 * A última que restava era `channel-lines-pairing.spec.ts`, e o motivo dela
 * não era sessão nem fixture: o QR e o código de pareamento são produzidos
 * pelo worker `channel_pairing` do RUNTIME, e o job `admin-ui` subia só o
 * console. O critério objetivo de saída que aquele cabeçalho escreveu foi
 * cumprido — o passo de E2E agora sobe um SEGUNDO processo
 * (`tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts`, papel
 * `scheduler` + grupo `channel`) com um adapter de canal FALSO injetado na
 * construção do `LineSessionManager`, e gera um `MAIA_STAGING_KEYRING`
 * efêmero compartilhado pelos dois. As duas afirmações têm caso próprio mais
 * abaixo, contra o workflow e o script lidos do disco.
 *
 * A lista continua existindo, e vazia ela é MAIS forte, não menos: qualquer
 * `describe` que volte a carregar a tag reprova a comparação abaixo. Entrar na
 * quarentena tem de ser um diff que alguém lê.
 */
const QUARENTENA = [] as const;

/**
 * Quantos CASOS a quarentena inteira contém hoje.
 *
 * A lista acima é por arquivo, e por arquivo ela só impede que a quarentena
 * ganhe um ARQUIVO novo em silêncio. Foi exatamente por dentro de um arquivo
 * já marcado que a décima jornada perdeu dois casos que não precisavam de
 * infra nenhuma: o denominador comum não aparece num diff de lista.
 *
 * Zero, e o zero é conferido: um `test(` novo dentro de um arquivo marcado
 * reprova aqui, e a correção é uma das duas — ou o caso não depende de infra
 * ausente e nasce bloqueante, ou ele depende, o cabeçalho do arquivo ganha o
 * motivo DELE numa linha `FORA DO GATE: <título>` e este número sobe num diff
 * que alguém lê.
 */
const QUARENTENA_CASOS = 0;

// ---------------------------------------------------------------------------
// Leitura do workflow — PARSE de verdade, não reconstrução
// ---------------------------------------------------------------------------

interface PassoDoWorkflow {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Record<string, unknown>;
  readonly 'continue-on-error'?: boolean;
}

/** Passos do job `admin-ui`, na ORDEM em que o GitHub os executa. */
function passosDoJob(): readonly PassoDoWorkflow[] {
  const wf = parseYaml(ci) as { jobs?: Record<string, { steps?: PassoDoWorkflow[] }> };
  const job = wf.jobs?.['admin-ui'];
  if (!job) throw new Error('job `admin-ui` não existe em .github/workflows/ci.yml');
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('job `admin-ui` sem `steps:` — a varredura viraria no-op');
  }
  return steps;
}

const PASSOS = passosDoJob();

/** Índice do passo pelo `name:`. -1 quando não existe. */
function indiceDoPasso(nome: string): number {
  return PASSOS.findIndex((p) => p.name === nome);
}

function passo(nome: string): PassoDoWorkflow {
  const i = indiceDoPasso(nome);
  if (i === -1) {
    throw new Error(
      `passo não encontrado no job admin-ui: "${nome}". Passos existentes: ` +
        PASSOS.map((p) => p.name ?? p.uses ?? '<sem nome>').join(' | '),
    );
  }
  return PASSOS[i]!;
}

/** Bloco `env:` de um passo, com todo valor normalizado para string. */
function envDoPasso(nome: string): Record<string, string> {
  const bloco = passo(nome).env;
  if (!bloco || Object.keys(bloco).length === 0) {
    throw new Error(`passo "${nome}" não tem bloco env:`);
  }
  return Object.fromEntries(Object.entries(bloco).map(([k, v]) => [k, String(v)]));
}

/** Bloco `ENV` do estágio `build` do Dockerfile do console. */
function envDoDockerfileBuild(): Record<string, string> {
  const linhas = dockerfile.split('\n');
  const inicio = linhas.findIndex((l) => /^FROM .* AS build$/.test(l.trim()));
  const fim = linhas.findIndex((l, i) => i > inicio && /^FROM /.test(l.trim()));
  expect(inicio, 'estágio `AS build` não encontrado no Dockerfile').toBeGreaterThan(-1);

  const out: Record<string, string> = {};
  for (let i = inicio; i < (fim === -1 ? linhas.length : fim); i++) {
    const m = /^ENV\s+([A-Z][A-Z0-9_]*)=(.*)$/.exec(linhas[i]!);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/**
 * O contrato do ARTEFATO, extraído do Dockerfile — que é a fonte da verdade
 * sobre o que roda em produção.
 */
function contratoDoArtefato(): {
  entrypoint: string;
  origemStandalone: string;
  destinoEstatico: string;
} {
  const cmd = /^CMD\s+\["node",\s*"([^"]+)"\]\s*$/m.exec(dockerfile);
  if (!cmd) throw new Error('Dockerfile do console sem `CMD ["node", "…"]`');

  const copias = [...dockerfile.matchAll(/^COPY\s+--from=build\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$/gm)];
  const standalone = copias.find(([, origem]) => origem!.endsWith('.next/standalone'));
  const estatico = copias.find(([, origem]) => origem!.endsWith('.next/static'));
  if (!standalone || !estatico) {
    throw new Error(
      'Dockerfile do console sem os dois COPY do artefato (.next/standalone e .next/static)',
    );
  }
  // O Dockerfile fala em caminhos do estágio `build` (`/app/…`); o script fala
  // em caminhos relativos à raiz do repo. `/app` É a raiz do repo no estágio
  // build (`WORKDIR /app` + `COPY . .`), então tirar o prefixo é a tradução
  // exata — e não uma normalização de conveniência.
  return {
    entrypoint: cmd[1]!,
    origemStandalone: standalone[1]!.replace(/^\/app\//, ''),
    // `./src/admin-ui/.next/static` -> `src/admin-ui/.next/static`
    destinoEstatico: estatico[2]!.replace(/^\.\//, ''),
  };
}

/** Valor de uma atribuição `NOME="valor"` no script do E2E. */
function varDoScript(nome: string): string {
  const m = new RegExp(`^${nome}="([^"]*)"$`, 'm').exec(scriptE2eExecutavel);
  if (!m) throw new Error(`scripts/admin-ui-e2e.sh não define ${nome}="…"`);
  return m[1]!;
}

// ---------------------------------------------------------------------------

describe('[declaração] o job `admin-ui` do CI existe e é bloqueante', () => {
  it('o workflow declara o job e ele roda o build, o typecheck e o e2e do console', () => {
    const comandos = PASSOS.map((p) => p.run ?? '').join('\n');
    expect(comandos).toContain('npm run admin:build');
    expect(comandos).toContain('npm run admin:typecheck');
    expect(comandos).toContain('npm run test:admin-ui:e2e:ci');
  });

  it('nenhum passo de veredito desarma o gate (continue-on-error ou `|| true`)', () => {
    // Só os passos que PRODUZEM veredito. Os de legibilidade (quarentena,
    // relatório) podem e devem ser tolerantes.
    const passosDeVeredito = [PASSO_BUILD, PASSO_ARTEFATO, PASSO_TYPECHECK, PASSO_E2E];
    for (const nome of passosDeVeredito) {
      const p = passo(nome);
      expect(p['continue-on-error'], `passo bloqueante marcado como tolerante: ${nome}`).not.toBe(
        true,
      );
      // Um `|| true` no `run:` desarma tanto quanto o `continue-on-error` —
      // e não aparece no campo que o teste acima olha.
      expect(p.run ?? '', `passo bloqueante engolindo o código de saída: ${nome}`).not.toMatch(
        /\|\|\s*(true|:)|;\s*true\s*$/m,
      );
    }
    // Também precisa existir o passo de migrations, que não tem nome fixo aqui
    // porque só interessa que ele seja bloqueante.
    const migrate = PASSOS.find((p) => (p.run ?? '').includes('npm run db:migrate'));
    expect(migrate, 'o job perdeu o passo de migrations').toBeDefined();
    expect(migrate!['continue-on-error']).not.toBe(true);
  });

  it('o browser é instalado pelo próprio workflow', () => {
    // No CI o Chromium NÃO vem pronto. Sem este passo o job reprovaria com
    // "Executable doesn't exist" — falha de ambiente disfarçada de falha de
    // teste.
    const comandos = PASSOS.map((p) => p.run ?? '').join('\n');
    expect(comandos).toContain('npx playwright install --with-deps chromium');
  });

  it('o piso de testes executados está armado (um job com 0 teste é reprovação)', () => {
    const env = envDoPasso(PASSO_E2E);
    const minimo = Number.parseInt(env.TEST_ADMIN_UI_MIN_TESTS ?? '', 10);
    expect(
      Number.isInteger(minimo) && minimo > 0,
      'TEST_ADMIN_UI_MIN_TESTS ausente ou <= 0: sem piso, "Running 0 tests" ' +
        'sai com código 0 e o gate fica verde sem medir nada',
    ).toBe(true);
  });

  it('o piso cobre TODOS os casos que estão fora da quarentena (#623)', () => {
    // Um piso que não acompanha a suíte é um piso que não protege nada: com
    // `TEST_ADMIN_UI_MIN_TESTS=5` e vinte e seis casos novos, apagar as
    // jornadas do checkout continuaria verde. A contagem é ESTÁTICA (as
    // chamadas `test(` das specs fora da quarentena) e a comparação é `>=`
    // porque o piso é piso: adicionar caso não obriga a mexer no workflow,
    // mas PERDER casos passa a reprovar.
    const minimo = Number.parseInt(envDoPasso(PASSO_E2E).TEST_ADMIN_UI_MIN_TESTS ?? '', 10);
    const casos = readdirSync(E2E_DIR)
      .filter((f) => f.endsWith('.spec.ts'))
      .filter((f) => !QUARENTENA.includes(f as never))
      .reduce((total, f) => {
        const fonte = readFileSync(join(E2E_DIR, f), 'utf8');
        return total + (fonte.match(/^\s+test\(/gm) ?? []).length;
      }, 0);
    expect(casos, 'nenhum caso encontrado — a contagem virou no-op').toBeGreaterThan(0);
    expect(
      minimo,
      `TEST_ADMIN_UI_MIN_TESTS=${minimo} não cobre os ${casos} casos fora da ` +
        `quarentena. Se a suíte encolheu de propósito, o número no workflow ` +
        `desce junto — num diff que alguém lê.`,
    ).toBeGreaterThanOrEqual(casos);
  });

  it('o script SEMEIA as fixtures das jornadas antes de medir (#623)', () => {
    // Sem semeadura as jornadas autenticadas medem telas vazias e reprovam com
    // "elemento não encontrado" — a causa três camadas depois do efeito. O
    // passo é parte do script, não do workflow, para valer igual na máquina de
    // quem desenvolve.
    expect(
      scriptE2eExecutavel,
      'scripts/admin-ui-e2e.sh parou de semear as fixtures das jornadas',
    ).toContain('scripts/seed-admin-ui-e2e-fixtures.ts');
  });

  it('a quarentena que sobrou aparece no log do job', () => {
    // O passo é de LEGIBILIDADE (continue-on-error), mas se ele procurar uma
    // tag que não existe mais o log fica mudo justamente sobre o que não foi
    // medido.
    const run = passo(PASSO_QUARENTENA).run ?? '';
    expect(run).toContain('@pendente-runtime');
  });

  it('nenhuma variável do job usa um namespace reservado da Maia por engano', async () => {
    // A armadilha documentada: `ADMIN_UI_`, `MAIA_`, `FEATURE_`, `BACKUP_`,
    // `OWNER_`, ... são namespaces do contrato, e uma chave DESCONHECIDA sob
    // eles reprova o boot de todo processo Maia do job. As que aparecem aqui
    // precisam existir no contrato; as de teste usam prefixo neutro `TEST_`.
    const { isMaiaNamespacedKey, isUnknownMaiaKey } = await Promise.all([
      import('@/config/metadata.js'),
      import('@/config/contract.js'),
    ]).then(([meta, contrato]) => ({
      isMaiaNamespacedKey: meta.isMaiaNamespacedKey,
      isUnknownMaiaKey: contrato.isUnknownMaiaKey,
    }));

    const chaves = PASSOS.flatMap((p) => Object.keys(p.env ?? {}));
    expect(chaves.length, 'nenhuma variável encontrada — a varredura virou no-op').toBeGreaterThan(
      10,
    );

    const desconhecidas = chaves.filter((k) => isMaiaNamespacedKey(k) && isUnknownMaiaKey(k));
    expect(
      desconhecidas,
      `chaves sob namespace da Maia que o contrato não conhece (o boot reprova ` +
        `com contract/unknown): ${desconhecidas.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * O SEGUNDO PROCESSO e o KEYRING — issue #623.
 *
 * Os dois fatos que tiraram a jornada de pareamento da quarentena, cada um com
 * o seu modo de falha silenciosa:
 *
 *   - o runtime some do script e as quatro jornadas passam a reprovar em
 *     timeout esperando um QR que ninguém produz (ou, pior, alguém "conserta"
 *     mandando-as de volta para a quarentena);
 *   - o keyring vira literal no bloco `env:` do workflow. Isso não é estilo:
 *     `env:` entra na HISTÓRIA do repositório, e é a história que o gitleaks
 *     varre. Material de chave commitado não sai mais de lá nem revertendo o
 *     commit.
 */
describe('[declaração] o passo de E2E sobe DOIS processos e GERA o keyring (#623)', () => {
  it('nenhum bloco `env:` do workflow carrega material de chave de pareamento', () => {
    // O workflow INTEIRO, não só o job `admin-ui`: um `env:` de job ou de
    // workflow alcança todo processo, e a proibição vale igual.
    const wf = parseYaml(ci) as {
      env?: Record<string, unknown>;
      jobs?: Record<string, { env?: Record<string, unknown>; steps?: PassoDoWorkflow[] }>;
    };
    const blocos: Array<Record<string, unknown>> = [];
    if (wf.env) blocos.push(wf.env);
    for (const job of Object.values(wf.jobs ?? {})) {
      if (job.env) blocos.push(job.env);
      for (const p of job.steps ?? []) if (p.env) blocos.push(p.env);
    }
    expect(blocos.length, 'nenhum bloco env: encontrado — a varredura virou no-op').toBeGreaterThan(
      5,
    );
    const chaves = blocos.flatMap((b) => Object.keys(b));
    expect(
      chaves.filter((k) => k === 'MAIA_STAGING_KEYRING'),
      'MAIA_STAGING_KEYRING apareceu num bloco `env:`. Ela é material de chave: ' +
        'o gitleaks varre a HISTÓRIA do repositório, e um segredo commitado ' +
        'não é removível por revert. Gere-a no `run:` do passo (openssl rand) ' +
        'e exporte para os dois processos.',
    ).toEqual([]);
  });

  it('o passo de E2E GERA o keyring e o exporta para os dois processos', () => {
    const run = passo(PASSO_E2E).run ?? '';
    expect(
      run,
      'o passo deixou de gerar o keyring. Sem ele `isPairingMaterialConfigured()` ' +
        'devolve false, o console desabilita o CTA "Parear" e as quatro ' +
        'jornadas de pareamento reprovam em "botão desabilitado".',
    ).toMatch(/openssl\s+rand/);
    expect(run).toMatch(/export\s+[^\n]*MAIA_STAGING_KEYRING/);
    expect(run).toMatch(/MAIA_STAGING_ACTIVE_KEY_ID/);
    // O valor gerado nunca deve aparecer cru no log do job.
    expect(run, 'o keyring gerado não está mascarado no log').toContain('::add-mask::');
  });

  it('o script exige o keyring — não degrada para "pareamento indisponível" em silêncio', () => {
    expect(
      scriptE2eExecutavel,
      'scripts/admin-ui-e2e.sh parou de exigir MAIA_STAGING_KEYRING. Sem a ' +
        'exigência, um job sem keyring rodaria a suíte inteira e reprovaria ' +
        'nas jornadas de pareamento com a mensagem errada.',
    ).toMatch(/MAIA_STAGING_KEYRING/);
  });

  it('o script EXECUTA o runtime com o grupo de jobs `channel` e o papel `scheduler`', () => {
    expect(
      varDoScript('RUNTIME_ENTRYPOINT'),
      'scripts/admin-ui-e2e.sh perdeu o entrypoint do segundo processo — o ' +
        'worker `channel_pairing` é quem produz o QR e o código',
    ).toBe('tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts');
    // EXECUTA, e não apenas declara. MEDIDO: trocando só a linha do `exec` por
    // um `sleep`, a asserção anterior (que olhava o texto do script) seguia
    // verde e o runtime nunca subia — o mesmo formato do caso que já cobre
    // `exec node "$SERVIDOR_REL"` para o console.
    expect(
      scriptE2eExecutavel,
      'o script declara o entrypoint do runtime mas não o executa',
    ).toMatch(/exec node --import tsx "\$RUNTIME_ENTRYPOINT"/);
    // `node --import tsx` e NÃO `npx tsx`: o wrapper spawna um segundo
    // processo, e o `kill` do trap alcança só o pai. MEDIDO: com `npx tsx`,
    // cada execução deixava um runtime órfão vivo reivindicando comandos com
    // o keyring da rodada anterior.
    expect(
      scriptE2eExecutavel,
      'o runtime voltou a subir por `npx tsx` — o trap não consegue encerrar o ' +
        'processo neto, e o órfão continua reivindicando comandos da fila',
    ).not.toMatch(/npx\s+tsx\s+"\$RUNTIME_ENTRYPOINT"/);
    expect(scriptE2eExecutavel).toMatch(/MAIA_SCHEDULER_GROUPS=channel/);
    expect(scriptE2eExecutavel).toMatch(/MAIA_PROCESS_ROLE=scheduler/);
    // Esperar a PRONTIDÃO, e não dormir: a suíte não pode começar numa janela
    // em que o cron de canal ainda não existe.
    expect(
      scriptE2eExecutavel,
      'o script não espera o runtime ficar pronto — a primeira jornada mediria ' +
        'uma fila que ninguém drena',
    ).toContain('maia.ready');
  });

  it('o entrypoint do runtime do job fica FORA do que a imagem copia', () => {
    // O adapter de canal falso é "prova de posse fabricada": ele não pode
    // existir no artefato de produção. O Dockerfile da raiz copia dist/,
    // migrations/, scripts/ e src/ — `tests/` não entra, e é por isso que o
    // entrypoint mora lá. A checagem completa (grafo de imports + Dockerfile)
    // está em `tests/unit/gateway/pairing-adapter-seam.spec.ts`.
    expect(varDoScript('RUNTIME_ENTRYPOINT')).toMatch(/^tests\//);
  });
});

describe('[declaração] o typecheck do console roda DEPOIS do build e é bloqueante', () => {
  it('a ordem dos passos é build -> artefato -> typecheck', () => {
    const iBuild = indiceDoPasso(PASSO_BUILD);
    const iTypecheck = indiceDoPasso(PASSO_TYPECHECK);
    expect(iBuild, `passo sumiu do job: ${PASSO_BUILD}`).toBeGreaterThan(-1);
    expect(iTypecheck, `passo sumiu do job: ${PASSO_TYPECHECK}`).toBeGreaterThan(-1);
    expect(
      iTypecheck,
      'o typecheck do console voltou para ANTES do `next build`. Metade do que ' +
        'ele checa só existe DEPOIS: `.next/types/**` é gerado pelo build e é ' +
        'onde o Next 16 declara o contrato de cada rota (`params` virou ' +
        '`Promise`). Antes do build o glob casa zero arquivo e o passo fica ' +
        'verde sem olhar para o framework.',
    ).toBeGreaterThan(iBuild);
  });

  it('o tsconfig do console NÃO exclui `.next` — senão o typecheck pós-build é decorativo', () => {
    const tsconfig = JSON.parse(readFileSync(TSCONFIG_ADMIN, 'utf8')) as {
      include?: string[];
      exclude?: string[];
    };
    const exclui = tsconfig.exclude ?? [];
    const reintroduzido = exclui.filter((p) => /(^|\/)\.next(\/|$)/.test(p));
    expect(
      reintroduzido,
      'src/admin-ui/tsconfig.json voltou a excluir `.next`. `exclude` VENCE ' +
        '`include`, então os tipos gerados pelo `next build` deixam de ser ' +
        'checados e o passo de typecheck pós-build passa a não medir nada. ' +
        'MEDIDO: revertendo `params: Promise<{id}>` para `params: {id}` em ' +
        '`app/proposals/[id]/page.tsx`, com `.next` no exclude o `tsc --noEmit` ' +
        'sai 0; sem ele, reprova em `.next/types/app/proposals/[id]/page.ts` ' +
        'com TS2344.',
    ).toEqual([]);

    // O contrafactual: sem o `include` dos tipos gerados, tirar o `.next` do
    // `exclude` também não bastaria.
    expect(
      tsconfig.include ?? [],
      'o tsconfig do console precisa continuar incluindo os tipos gerados',
    ).toContain('.next/types/**/*.ts');
  });

  it('o passo de artefato confere o STANDALONE, não só o BUILD_ID', () => {
    // Um build que emite BUILD_ID mas perde `output: "standalone"` produz uma
    // imagem sem entrypoint — e o E2E abaixo não teria o que subir.
    const run = passo(PASSO_ARTEFATO).run ?? '';
    expect(run).toContain('src/admin-ui/.next/BUILD_ID');
    expect(run).toContain('src/admin-ui/.next/standalone/');
    expect(run).toContain('src/admin-ui/.next/static');
  });
});

describe('[declaração] o E2E roda o ARTEFATO STANDALONE, o mesmo do Dockerfile', () => {
  const artefato = contratoDoArtefato();

  it('o passo de E2E continua sendo o script que sobe o artefato', () => {
    expect(passo(PASSO_E2E).run).toContain('npm run test:admin-ui:e2e:ci');
  });

  it('o script sobe o entrypoint declarado no `CMD` do Dockerfile', () => {
    // O caminho NÃO é escrito duas vezes: sai do Dockerfile e é comparado com
    // o que o script executa. Mudar um sem o outro fica vermelho.
    expect(
      varDoScript('SERVIDOR_REL'),
      `o script precisa subir o mesmo entrypoint do container (${artefato.entrypoint})`,
    ).toBe(artefato.entrypoint);
    expect(scriptE2eExecutavel, 'o script não executa o entrypoint com `node`').toMatch(
      /exec node "\$SERVIDOR_REL"/,
    );
    expect(
      varDoScript('STANDALONE'),
      `a raiz do artefato precisa ser a mesma que o Dockerfile copia para /app ` +
        `(${artefato.origemStandalone})`,
    ).toBe(artefato.origemStandalone);
  });

  it('o script monta `.next/static` na posição que o Dockerfile usa', () => {
    expect(varDoScript('ESTATICO_DESTINO')).toBe(
      `$STANDALONE/${artefato.destinoEstatico}`,
    );
    expect(scriptE2eExecutavel, 'o script não copia o estático para dentro do artefato').toMatch(
      /cp -R "src\/admin-ui\/\.next\/static" "\$ESTATICO_DESTINO"/,
    );
  });

  it('o script NÃO usa mais `next start`', () => {
    // MEDIDO nesta árvore: sem o `.next/static` dentro do artefato, 2 dos 5
    // testes do `smoke` reprovam (hidratação e o canário de jornada pública).
    // Com `next start` esse defeito é invisível — o servidor lê o `.next` da
    // árvore de trabalho, onde o estático já está no lugar.
    expect(
      scriptE2eExecutavel,
      'o E2E voltou para `next start`: ele serve o `.next` da árvore de ' +
        'trabalho com o node_modules inteiro ao alcance, e nunca reproduz nem ' +
        'um módulo que o tracer do Next não seguiu nem um `.next/static` fora ' +
        'de posição. O artefato de produção é `.next/standalone`.',
    ).not.toMatch(/next start/);
  });
});

describe('[declaração] o env de build do CI não pode divergir do Dockerfile', () => {
  it('o bloco do passo de build é exatamente o do estágio `build` da imagem', () => {
    const doCi = envDoPasso(PASSO_BUILD);
    const doDocker = envDoDockerfileBuild();

    expect(
      Object.keys(doDocker).length,
      'o estágio build do Dockerfile não tem ENV — a varredura virou no-op',
    ).toBeGreaterThan(10);

    // O CI constrói o console com o MESMO ambiente da imagem de produção. Se
    // divergirem, o CI passa a medir um build que ninguém faz — e foi
    // divergência assim que deixou o build da imagem quebrado por meses.
    expect(doCi).toEqual(doDocker);
  });
});

/**
 * O bloco `env:` do passo de E2E, EXECUTADO contra o gate de boot real.
 *
 * Este é o caso que impede a repetição das duas quebras anteriores do job
 * (`ConfigValidationError` por perfil `staging` sem OIDC, e
 * `profile/node-env-contradiction` por `MAIA_ENV=development` com
 * `NODE_ENV=production`). Ele não compara o bloco com um literal: ele chama
 * `register()` de `src/admin-ui/instrumentation.ts` — a função que o Next
 * awaita em `BaseServer.prepare()` — com o ambiente que o workflow declara.
 *
 * `NODE_ENV=production` é FORÇADO aqui porque o artefato força: o `server.js`
 * que o `next build` gera abre com `process.env.NODE_ENV = 'production'`, antes
 * do `require('next')` e muito antes de `register()`. Medir o bloco sem essa
 * linha seria medir um processo que não existe.
 */
describe('[declaração] o env do E2E boota o console SOB O ARTEFATO STANDALONE', () => {
  const CONTRACT_NAMES = CONTRACT_ENTRIES.map((s) => s.name);
  const TOMBSTONE_NAMES = TOMBSTONES.map((t) => t.name);
  let salvo: NodeJS.ProcessEnv;

  beforeEach(() => {
    salvo = { ...process.env };
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, salvo);
  });

  /** Ambiente do processo = o bloco do workflow, e nada do ambiente de quem roda. */
  function usarEnvDoWorkflow(extra: Record<string, string> = {}): Record<string, string> {
    for (const key of [...CONTRACT_NAMES, ...TOMBSTONE_NAMES]) delete process.env[key];
    for (const key of Object.keys(process.env)) {
      if (/^(MAIA_|FEATURE_)/.test(key)) delete process.env[key];
    }
    const env = {
      ...envDoPasso(PASSO_E2E),
      // O que o `server.js` do standalone impõe, e o que o Next seta no
      // processo do servidor.
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
      ...extra,
    };
    Object.assign(process.env, env);
    return env;
  }

  it('`register()` resolve com o bloco `env:` que o workflow declara', async () => {
    usarEnvDoWorkflow();
    await expect(register()).resolves.toBeUndefined();
  });

  it('o profile declarado é estrito — `development` não sobrevive ao artefato', () => {
    const env = envDoPasso(PASSO_E2E);
    expect(
      env.MAIA_ENV,
      'com o artefato standalone o `NODE_ENV` é `production` por construção; ' +
        '`MAIA_ENV=development` reprova o boot em `profile/node-env-contradiction`',
    ).not.toBe('development');
    expect(['staging', 'production']).toContain(env.MAIA_ENV);
    if (env.NODE_ENV !== undefined) expect(env.NODE_ENV).toBe('production');
  });

  it('o gate NÃO é desligado pela escotilha do contrato', () => {
    // `MAIA_CONFIG_STRICT_BOOT=false` faria `assertAdminBootConfig()` pular
    // `loadAdminConfig()` inteiro. Seria a saída fácil para o conflito
    // "artefato de produção × perfil que boota sem OIDC" — e seria
    // exatamente o desarme que este arquivo existe para impedir.
    const env = envDoPasso(PASSO_E2E);
    expect(env.MAIA_CONFIG_STRICT_BOOT).toBeUndefined();
  });

  it('o slug de tenant do E2E não é o literal `default`', () => {
    // O slug vai direto para `appUsersRepo.getByEmail(tenant, email)` em
    // `auth-resolver.ts`: ele É o `tenant_id` num caminho dinâmico.
    const env = envDoPasso(PASSO_E2E);
    const slugs = (env.OIDC_TENANT_SLUGS ?? '').split(',').map((s) => s.trim());
    expect(slugs).not.toContain('default');
  });

  it('o contrafactual: tirar uma `OIDC_*` do bloco REPROVA o boot', async () => {
    // Anti-vacuidade do caso principal. Se este caso ficasse verde, o `register()`
    // acima não estaria medindo nada.
    usarEnvDoWorkflow();
    delete process.env.OIDC_ISSUER;
    await expect(register()).rejects.toThrow(/OIDC_ISSUER/);
  });
});

describe('[declaração] a quarentena `@pendente-runtime` não cresce em silêncio', () => {
  const arquivos = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'));

  it('encontra specs para inspecionar (anti-vacuidade)', () => {
    expect(arquivos.length).toBeGreaterThan(QUARENTENA.length);
  });

  it('a lista de arquivos em quarentena é exatamente a declarada', () => {
    // A marca é a TAG no título do `describe` — é o que o `grep`/`grepInvert`
    // do Playwright enxerga. Uma menção ao identificador num comentário (a
    // spec do gate cita a issue) não põe ninguém em quarentena.
    const marcados = arquivos
      .filter((f) => TAG_NO_DESCRIBE.test(readFileSync(join(E2E_DIR, f), 'utf8')))
      .sort();
    expect(
      marcados,
      'entrar ou sair da quarentena tem de ser um diff visível nesta lista, ' +
        'não um efeito colateral de marcar/desmarcar um describe',
    ).toEqual([...QUARENTENA].sort());
  });

  it('a quarentena não cresce POR DENTRO de um arquivo já marcado (#623)', () => {
    // O caso que a contabilidade por arquivo não pega. Enquanto a lista acima
    // só olha nomes de arquivo, um caso novo dentro do arquivo marcado nasce
    // fora do gate sem aparecer em diff nenhum — que é exatamente como dois
    // casos que só precisavam de sessão e fixture ficaram anos sem rodar,
    // carregados pelo denominador comum dos que precisavam do runtime.
    const casos = QUARENTENA.reduce((total, f) => {
      const fonte = readFileSync(join(E2E_DIR, f), 'utf8');
      return total + (fonte.match(/^\s+test\(/gm) ?? []).length;
    }, 0);
    expect(
      casos,
      `a quarentena tem ${casos} casos e QUARENTENA_CASOS declara ` +
        `${QUARENTENA_CASOS}. Caso novo aqui só é legítimo com o motivo DELE ` +
        `escrito no cabeçalho do arquivo; caso que não depende do runtime vai ` +
        `para uma spec bloqueante. Nos dois desfechos este número muda num ` +
        `diff que alguém lê.`,
    ).toBe(QUARENTENA_CASOS);
  });

  it('cada caso em quarentena tem o motivo DELE escrito no cabeçalho (#623)', () => {
    // Anti-denominador-comum, do lado da prosa — e conferido pelo TÍTULO, não
    // pela contagem. "Este arquivo depende do runtime" é a frase que manteve
    // dois casos fora do gate sem que ninguém conseguisse checar se ela valia
    // para todos; renomear um caso sem revisitar o motivo dele reproduziria a
    // mesma meia-verdade, e é isso que a comparação de títulos impede.
    if (QUARENTENA.length === 0) {
      // A quarentena vazia não torna este caso decorativo: ela move a
      // afirmação para "não há motivo a justificar PORQUE não há caso fora do
      // gate". As duas metades precisam concordar — uma lista vazia com
      // `QUARENTENA_CASOS > 0` seria contabilidade quebrada.
      expect(QUARENTENA_CASOS).toBe(0);
      const comMotivo = arquivos.filter((f) =>
        /^ \* {3}FORA DO GATE: /m.test(readFileSync(join(E2E_DIR, f), 'utf8')),
      );
      expect(
        comMotivo,
        'um arquivo ainda declara motivo de quarentena, mas a quarentena está ' +
          'vazia. Ou o motivo sobrou de um estado antigo (apague-o), ou o ' +
          'arquivo devia estar marcado e não está.',
      ).toEqual([]);
      return;
    }
    for (const f of QUARENTENA) {
      const fonte = readFileSync(join(E2E_DIR, f), 'utf8');
      const cabecalho = fonte.split('*/')[0] ?? '';
      const declarados = [...cabecalho.matchAll(/^ \* {3}FORA DO GATE: (.+)$/gm)]
        .map((m) => m[1]!.trim())
        .sort();
      const reais = [...fonte.matchAll(/^\s+test\(\s*'([^']+)'/gm)]
        .map((m) => m[1]!)
        .sort();
      expect(reais.length, `${f}: nenhum \`test(\` encontrado — a checagem virou no-op`)
        .toBeGreaterThan(0);
      expect(
        declarados,
        `${f}: o cabeçalho justifica [${declarados.join(' | ')}] mas o arquivo ` +
          `tem [${reais.join(' | ')}]. Cada caso fora do gate carrega o motivo ` +
          `DELE numa linha \`FORA DO GATE: <título do test>\`.`,
      ).toEqual(reais);
    }
  });

  it('sobra pelo menos uma spec DENTRO do gate (senão o gate não mede nada)', () => {
    const noGate = arquivos.filter((f) => !QUARENTENA.includes(f as never));
    expect(
      noGate,
      'toda spec e2e ficou em quarentena — o projeto `smoke` rodaria vazio',
    ).not.toEqual([]);
  });
});
