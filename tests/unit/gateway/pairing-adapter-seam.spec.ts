/**
 * A COSTURA do adapter de canal do pareamento — issue #623.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A propriedade que este arquivo guarda
 * ─────────────────────────────────────────────────────────────────────────
 * Provar posse de uma linha é o que AUTORIZA essa linha a rotear
 * (`src/setup/line-pairing.ts`: a PairingSession casa o número real com o
 * declarado, promove o auth state e ativa o canal). Um adapter de canal FALSO
 * é, por definição, "posse provada por socket falso" — fail-open no exato
 * ponto em que a autorização nasce.
 *
 * O job do console precisa desse adapter falso (a #518 proíbe linha WhatsApp
 * real no CI). O que este arquivo fixa é COMO ele é escolhido:
 *
 *   - por CONSTRUÇÃO do `LineSessionManager`, a partir de um entrypoint que
 *     só o teste executa (`tests/admin-ui/e2e/_runtime/`);
 *   - NUNCA por chave de configuração. Uma `MAIA_*` que trocasse o adapter
 *     seria configuração DOCUMENTADA do produto — um interruptor que desliga
 *     a prova de posse, alcançável por env var em qualquer container.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Como a propriedade é medida (nada é reconstruído)
 * ─────────────────────────────────────────────────────────────────────────
 *   1. DINÂMICO, e exaustivo por construção: o módulo é carregado com um
 *      `config` em que TODA chave responde `true` (um Proxy). Se existisse
 *      qualquer variável capaz de trocar o adapter, este é o ambiente em que
 *      ela estaria ligada — e o adapter continua sendo o Baileys.
 *   2. CONTRAFACTUAL: instalado o adapter falso, o manager passa a usá-lo.
 *      Sem este caso o de cima seria verde por vacuidade.
 *   3. FONTE, lida do disco: `src/gateway/line-session-manager.ts` só lê duas
 *      variáveis do contrato, e nenhuma delas fala de adapter. Um
 *      `config.MAIA_FAKE_*` novo fica vermelho aqui.
 *   4. GRAFO: nada sob `src/` nem sob `scripts/` alcança o adapter falso nem
 *      chama o instalador — o único chamador é o entrypoint de teste.
 *   5. ARTEFATO: o `Dockerfile` da raiz é lido do disco; `tests/` não é
 *      copiado para a imagem, então o adapter falso não existe em produção.
 *
 * [declaração]: este arquivo carrega o módulo de produção, lê o seu
 * código-fonte, o contrato de config e o Dockerfile. Ele não sobe runtime
 * nenhum.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CONTRACT_ENTRIES, TOMBSTONES } from '@/config/contract.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const MANAGER_SRC = join(REPO_ROOT, 'src/gateway/line-session-manager.ts');
const DOCKERFILE = join(REPO_ROOT, 'Dockerfile');
const ADAPTER_FALSO_REL = 'tests/admin-ui/e2e/_runtime/adaptador-de-canal-falso.ts';
const ENTRYPOINT_REL = 'tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts';

/** O nome da função instaladora — a única porta para trocar o adapter. */
const INSTALADOR = 'installPairingChannelAdapter';

const { makeSocketMock, useAuthStateMock } = vi.hoisted(() => ({
  makeSocketMock: vi.fn(() => ({
    ev: { on: vi.fn() },
    end: vi.fn(),
    user: undefined,
    requestPairingCode: vi.fn(),
  })),
  useAuthStateMock: vi.fn(async () => ({ state: {}, saveCreds: vi.fn() })),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: makeSocketMock,
  useMultiFileAuthState: useAuthStateMock,
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
}));

/**
 * `config` com TODA chave ligada. Não é um mock de conveniência: é o ambiente
 * mais permissivo que o contrato conseguiria produzir, e é contra ele que o
 * caso principal afirma "nenhuma configuração troca o adapter".
 */
vi.mock('@/config/env.js', () => ({
  config: new Proxy(
    {},
    {
      get: () => true,
      has: () => true,
    },
  ),
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getLineSessionManager,
  installPairingChannelAdapter,
  _resetLineSessionManagerForTests,
  type PairingChannelAdapter,
} from '@/gateway/line-session-manager.js';

const AUTH_DIR = '/tmp/maia-pairing-seam-spec';
const CANAL = '0b0e8a1c-1111-4222-8333-444455556666';

async function abrirPeloManager(): Promise<void> {
  await getLineSessionManager()
    ._adapterForTests()
    .open({ channel_id: CANAL, auth_dir: AUTH_DIR, declared_line: '+5511900002222' });
}

describe('[declaração] o adapter de canal NÃO é alcançável por configuração (#623)', () => {
  let salvo: NodeJS.ProcessEnv;

  beforeEach(() => {
    salvo = { ...process.env };
    _resetLineSessionManagerForTests();
    makeSocketMock.mockClear();
    useAuthStateMock.mockClear();
  });

  afterEach(() => {
    _resetLineSessionManagerForTests();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, salvo);
  });

  it('com TODA variável do contrato ligada, o manager continua abrindo pelo Baileys', async () => {
    // As duas pontas do ambiente ao mesmo tempo: `process.env` com cada nome
    // do contrato (e cada tombstone) setado, e um `config` que responde
    // `true` para qualquer chave. Se alguma variável escolhesse o adapter,
    // ela estaria ligada aqui.
    for (const nome of [...CONTRACT_ENTRIES.map((e) => e.name), ...TOMBSTONES.map((t) => t.name)]) {
      process.env[nome] = 'true';
    }
    expect(
      Object.keys(process.env).length,
      'nenhuma variável setada — a varredura virou no-op',
    ).toBeGreaterThan(50);

    await abrirPeloManager();

    expect(
      makeSocketMock,
      'o manager deixou de abrir o socket pelo Baileys num ambiente que só ' +
        'difere do de produção por ter TODAS as variáveis ligadas',
    ).toHaveBeenCalledTimes(1);
    expect(useAuthStateMock).toHaveBeenCalledWith(AUTH_DIR);
  });

  it('CONTRAFACTUAL: instalado, o adapter falso É usado (sem isto o caso acima é vácuo)', async () => {
    const aberturas: string[] = [];
    const falso: PairingChannelAdapter = {
      open: ({ channel_id }) => {
        aberturas.push(channel_id);
        return Promise.resolve({
          sock: { ev: { on: () => undefined } } as never,
          saveCreds: () => Promise.resolve(),
        });
      },
    };

    installPairingChannelAdapter(falso);
    await abrirPeloManager();

    expect(aberturas).toEqual([CANAL]);
    expect(
      makeSocketMock,
      'o adapter instalado não substituiu o Baileys — a costura não é uma costura',
    ).not.toHaveBeenCalled();
  });

  it('instalar DEPOIS de o manager existir é erro, não um no-op silencioso', () => {
    getLineSessionManager();
    expect(() => installPairingChannelAdapter({ open: () => Promise.reject(new Error('x')) }))
      .toThrow(/installed too late|ANTES do primeiro/i);
  });

  it('instalar duas vezes é erro — nunca "o último vence" em silêncio', () => {
    const adapter: PairingChannelAdapter = { open: () => Promise.reject(new Error('x')) };
    installPairingChannelAdapter(adapter);
    expect(() => installPairingChannelAdapter(adapter)).toThrow(/já foi instalado/i);
  });
});

describe('[declaração] o contrato de config não conhece a costura (#623)', () => {
  const fonte = readFileSync(MANAGER_SRC, 'utf8');

  /** O código, sem comentários — este arquivo é quase todo prosa. */
  const codigo = fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

  it('o módulo da costura lê exatamente duas variáveis, e nenhuma é sobre adapter', () => {
    const lidas = [...codigo.matchAll(/\bconfig\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
    expect(new Set(lidas), 'anti-vacuidade: nenhuma leitura de config encontrada').not.toEqual(
      new Set([]),
    );
    expect(
      [...new Set(lidas)].sort(),
      'o LineSessionManager passou a ler outra variável do contrato. Se ela ' +
        'escolhe adapter, a prova de posse virou configuração — que é ' +
        'exatamente o que esta spec existe para impedir.',
    ).toEqual(['BAILEYS_AUTH_DIR', 'MAIA_MULTI_LINE']);
  });

  it('o módulo da costura não lê `process.env` por fora do contrato', () => {
    expect(
      codigo,
      'uma leitura crua de process.env aqui contornaria o contrato inteiro — ' +
        'inclusive a varredura de chave desconhecida do boot',
    ).not.toMatch(/process\.env/);
  });

  it('nenhuma entrada do contrato (nem tombstone) fala de adapter/socket de pareamento', () => {
    const suspeitas = [...CONTRACT_ENTRIES, ...TOMBSTONES].filter((e) =>
      /FAKE|MOCK|STUB|PAIRING_ADAPTER|CHANNEL_ADAPTER|PAIRING_SOCKET/i.test(e.name),
    );
    expect(
      suspeitas.map((e) => e.name),
      'apareceu no contrato uma variável com cara de escolher o adapter de ' +
        'canal. A costura é por construção; se ela virou config, esta é a ' +
        'linha que o diff precisa mostrar.',
    ).toEqual([]);
  });
});

/** Imports ESTÁTICOS de valor — os que rodam no load do módulo. */
function importsEstaticos(arquivo: string): string[] {
  const texto = readFileSync(arquivo, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)(\s+type)?\s([^;]*?)\sfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    if (m[1]) continue;
    const clausula = m[2]!;
    const nomeados = /^\s*\{([\s\S]*)\}\s*$/.exec(clausula);
    if (nomeados) {
      const specs = nomeados[1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (specs.length > 0 && specs.every((s) => /^type\s/.test(s))) continue;
    }
    out.push(m[3]!);
  }
  // `import('...')` dinâmico também carrega — aqui ele conta, porque o que
  // se mede é ALCANCE, não custo de boot.
  for (const d of texto.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(d[1]!);
  return out;
}

function arquivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === '.next') continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) out.push(...arquivosTs(caminho));
    else if (/\.(ts|tsx|mts|cts)$/.test(entrada)) out.push(caminho);
  }
  return out;
}

describe('[declaração] nada de produção alcança o adapter falso (#623)', () => {
  const produzidos = [
    ...arquivosTs(join(REPO_ROOT, 'src')),
    ...arquivosTs(join(REPO_ROOT, 'scripts')),
  ];

  it('encontra arquivos para inspecionar (anti-vacuidade)', () => {
    expect(produzidos.length).toBeGreaterThan(100);
  });

  it('nenhum arquivo de `src/` ou `scripts/` importa o adapter falso', () => {
    const alcancam = produzidos.filter((f) =>
      importsEstaticos(f).some((spec) => /adaptador-de-canal-falso|_runtime\//.test(spec)),
    );
    expect(
      alcancam.map((f) => relative(REPO_ROOT, f)),
      'código de produção passou a alcançar o adapter falso',
    ).toEqual([]);
  });

  it(`o único chamador de \`${INSTALADOR}\` é o entrypoint de teste`, () => {
    const chamadores = produzidos.filter((f) => {
      if (f === MANAGER_SRC) return false; // é onde ele é DEFINIDO
      return new RegExp(`${INSTALADOR}\\s*\\(`).test(readFileSync(f, 'utf8'));
    });
    expect(
      chamadores.map((f) => relative(REPO_ROOT, f)),
      'alguém em src/ ou scripts/ passou a instalar um adapter de canal — o ' +
        'caminho para a prova de posse falsa deixou de ser só o entrypoint de teste',
    ).toEqual([]);

    const entrypoint = readFileSync(join(REPO_ROOT, ENTRYPOINT_REL), 'utf8');
    expect(
      entrypoint,
      'o entrypoint de teste deixou de instalar o adapter — o grafo acima ' +
        'ficaria verde por não haver instalador nenhum',
    ).toContain(`${INSTALADOR}(`);
  });
});

describe('[declaração] o adapter falso não entra na imagem de produção (#623)', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');

  /** Origens que o estágio `runtime` copia do build, relativas à raiz do repo. */
  const copiadas = [...dockerfile.matchAll(/^COPY\s+--from=\S+\s+(\S+)\s+(\S+)\s*$/gm)]
    .map(([, origem]) => origem!.replace(/^\/app\//, ''))
    .filter((o) => !o.startsWith('/'));

  it('o Dockerfile foi lido de verdade (anti-vacuidade)', () => {
    expect(copiadas.length).toBeGreaterThan(3);
    expect(copiadas).toContain('src');
  });

  it('`tests/` não é copiado para a imagem', () => {
    expect(
      copiadas.filter((o) => o === 'tests' || o.startsWith('tests/')),
      'o Dockerfile passou a copiar `tests/` — o adapter de canal falso ' +
        'estaria DENTRO do container de produção, a um `node` de distância da ' +
        'prova de posse',
    ).toEqual([]);
    expect(ADAPTER_FALSO_REL.startsWith('tests/')).toBe(true);
    expect(ENTRYPOINT_REL.startsWith('tests/')).toBe(true);
  });

  it('o build de `dist/` não compila `tests/`', () => {
    // `dist/` É copiado; se `tests/` entrasse no `include` do tsconfig, o
    // adapter falso chegaria à imagem por dentro do bundle compilado.
    const tsconfig = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8')) as {
      include?: string[];
      exclude?: string[];
      compilerOptions?: { rootDir?: string };
    };
    expect(tsconfig.include ?? []).toEqual(['src/**/*']);
    expect(tsconfig.exclude ?? []).toContain('tests');
    expect(tsconfig.compilerOptions?.rootDir).toBe('src');
  });
});
