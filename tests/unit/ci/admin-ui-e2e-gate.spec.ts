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
 *   - a quarentena (`@pendente-runtime`) cresce em silêncio até o gate medir nada;
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
 * Depois da #623 sobrou UMA, e por um motivo que não é sessão nem fixture: o
 * QR e o código de pareamento são produzidos pelo worker `channel_pairing` do
 * RUNTIME, e o job `admin-ui` sobe só o console. O cabeçalho do arquivo traz a
 * medição (o router só grava um COMANDO em `channel_line_state`) e o critério
 * objetivo de saída. A tag também mudou — `@pendente-472` virou
 * `@pendente-runtime`, porque a #472 fechou e o motivo que resta é outro.
 *
 * A lista é FIXA de propósito: entrar ou sair dela tem de ser um diff que
 * alguém lê, não um efeito colateral de marcar mais um `describe`.
 */
const QUARENTENA = ['channel-lines-pairing.spec.ts'] as const;

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
    // `TEST_ADMIN_UI_MIN_TESTS=5` e vinte e dois casos novos, apagar as
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

  it('sobra pelo menos uma spec DENTRO do gate (senão o gate não mede nada)', () => {
    const noGate = arquivos.filter((f) => !QUARENTENA.includes(f as never));
    expect(
      noGate,
      'toda spec e2e ficou em quarentena — o projeto `smoke` rodaria vazio',
    ).not.toEqual([]);
  });
});
