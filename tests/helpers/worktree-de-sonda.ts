/**
 * Issue #571, revisão da PR #597 — worktrees DE VERDADE para testar o
 * derivador de escopo.
 *
 * ## Por que este arquivo existe
 *
 * A revisão apontou que o gate verde da #571 não executava o caminho de
 * worktree. No checkout do CI (e no `main` local) `.git` é um DIRETÓRIO,
 * `resolveWorktreeScope()` devolve `null`, e os únicos casos que consultavam o
 * escopo real faziam `return` nesse estado. Ou seja: alocação, reciclagem,
 * descoberta do git dir comum e duas rodadas simultâneas nunca rodavam. O
 * resto do arquivo usava um escopo FIXO de mentira, que não detecta corrida
 * nenhuma.
 *
 * A prova pedida — e a que este helper viabiliza — é comportamental: criar
 * `git worktree`s temporárias, disparar PROCESSOS SEPARADOS em paralelo contra
 * o mesmo registro de slots e afirmar que cada root sai com um db distinto.
 * Processo separado é requisito, não capricho: a memoização de
 * `resolveWorktreeScope()` é por processo, e um teste single-process com mocks
 * não pode observar o interleaving de dois `unlink` concorrentes.
 *
 * ## Onde isso acontece
 *
 * Num repositório git NOVO, criado com `git init` dentro de `os.tmpdir()`.
 * Nunca no repositório real: o registro de slots vive em `<commonGitDir>/
 * maia-redis-slots/`, e escrever ali de dentro de um teste mexeria na posse de
 * dezenas de worktrees vivas. O repo de sonda tem `.git` próprio, logo
 * registro próprio, logo nada a poluir.
 *
 * Roda no runner do GitHub Actions: só depende de `git` (que o
 * `actions/checkout` já exige) e de `node`.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arquivoDoPacote } from './pkg-path.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

/** Os módulos que a sonda precisa ter DENTRO do repo temporário. */
const MODULOS = ['worktree-scope.ts', 'lock-de-diretorio.ts'] as const;

/** O que a sonda imprime em stdout (uma linha de JSON). */
export interface RespostaDaSonda {
  readonly ok: boolean;
  readonly escopo: {
    readonly root: string;
    readonly slug: string;
    readonly redisDb: number;
    readonly commonGitDir: string;
  } | null;
  readonly ambiente: Readonly<Record<string, string>> | null;
  readonly erro?: string;
}

export interface RepoDeSonda {
  /** Raiz temporária de tudo — some no `destruir()`. */
  readonly base: string;
  /** O `.git` COMUM que as worktrees de sonda compartilham. */
  readonly gitDirComum: string;
  /** O registro de slots deste repo — isolado do registro do repo real. */
  readonly dirDeSlots: string;
  /** Cria uma `git worktree` de verdade e devolve a raiz dela. */
  criarWorktree(nome: string): string;
  destruir(): void;
}

function git(args: readonly string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.name=sonda', '-c', 'user.email=sonda@invalid', ...args], {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      // O repo de sonda não pode herdar hooks, templates ou aliases da máquina
      // de quem roda: o teste tem de dizer a mesma coisa aqui e no runner.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

/**
 * Um repositório git novo, com `tests/helpers/` copiado de verdade (os módulos
 * sob teste) e uma sonda que imprime o escopo resolvido.
 */
export function criarRepoDeSonda(): RepoDeSonda {
  const base = mkdtempSync(join(tmpdir(), 'wt571-probe-'));
  const origem = join(base, 'origem');
  mkdirSync(join(origem, 'tests', 'helpers'), { recursive: true });

  for (const m of MODULOS) copyFileSync(join(AQUI, m), join(origem, 'tests', 'helpers', m));
  writeFileSync(join(origem, 'tests', 'helpers', 'sonda.ts'), FONTE_DA_SONDA, 'utf8');

  git(['init', '-q', '-b', 'main'], origem);
  git(['add', '-A'], origem);
  git(['commit', '-q', '-m', 'sonda'], origem);

  const criadas: string[] = [];
  return {
    base,
    gitDirComum: join(origem, '.git'),
    dirDeSlots: join(origem, '.git', 'maia-redis-slots'),
    criarWorktree(nome: string): string {
      const alvo = join(base, nome);
      git(['worktree', 'add', '-q', '-b', nome, alvo], origem);
      criadas.push(alvo);
      return alvo;
    },
    destruir(): void {
      // `rm -rf` na base inteira remove o repo E as worktrees dele de uma vez.
      // Não há `git worktree remove` a fazer: o repositório que as registra
      // está dentro do que estamos apagando.
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Dispara UMA sonda por root, todas em processos separados, todas soltas no
 * mesmo instante.
 *
 * A sincronização é um PONTO DE ENCONTRO em disco, não um horário combinado.
 * A primeira versão marcava um instante fixo no futuro e torcia para todo
 * mundo ter bootado até lá — com uma dúzia de `tsx` numa máquina de 4 vCPU o
 * boot passa de um segundo e varia, então as sondas começavam espalhadas por
 * vários segundos e a corrida nunca acontecia: o teste ficava verde sem ter
 * exercido nada, que é exatamente o defeito que ele existe para não repetir.
 *
 * Com o rendezvous, cada sonda anuncia que chegou e só avança quando TODAS
 * chegaram. O custo de boot sai da conta e a largada é simultânea de verdade.
 */
export async function rodarSondas(
  roots: readonly string[],
  ambiente: Readonly<Record<string, string>> = {},
): Promise<RespostaDaSonda[]> {
  const tsx = arquivoDoPacote('tsx', 'dist/cli.mjs', import.meta.url);
  const encontro = mkdtempSync(join(tmpdir(), 'wt571-largada-'));

  try {
    return await Promise.all(
      roots.map(
        (root) =>
          new Promise<RespostaDaSonda>((resolve, reject) => {
            const filho = spawn(process.execPath, [tsx, join(root, 'tests/helpers/sonda.ts')], {
              cwd: root,
              env: {
                ...process.env,
                ...ambiente,
                SONDA_ENCONTRO: encontro,
                SONDA_QUANTAS: String(roots.length),
                // O escopo tem de estar LIGADO na sonda, aconteça o que
                // acontecer no ambiente de quem roda a suíte.
                TEST_WORKTREE_SCOPE: 'on',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let saida = '';
            let erro = '';
            filho.stdout.on('data', (c: Buffer) => (saida += c.toString()));
            filho.stderr.on('data', (c: Buffer) => (erro += c.toString()));
            filho.on('error', reject);
            filho.on('exit', (code) => {
              const linha = saida.trim().split('\n').at(-1) ?? '';
              try {
                resolve(JSON.parse(linha) as RespostaDaSonda);
              } catch {
                reject(
                  new Error(
                    `sonda em ${root} saiu ${code} sem JSON legível.\nstdout:\n${saida}\nstderr:\n${erro}`,
                  ),
                );
              }
            });
          }),
      ),
    );
  } finally {
    rmSync(encontro, { recursive: true, force: true });
  }
}

/**
 * O programa da sonda. Fica como string porque ele precisa existir DENTRO do
 * repo temporário (é de lá que `import.meta.url` sobe até achar o `.git` que
 * define o escopo) — um arquivo committed no repo real não serviria.
 */
const FONTE_DA_SONDA = `/* Gerado por tests/helpers/worktree-de-sonda.ts — issue #571. */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTestEnv, resolveWorktreeScope } from './worktree-scope.js';

// Ponto de encontro: anuncia a chegada e espera TODAS as sondas chegarem. É o
// que faz a largada ser simultânea apesar do boot do Node ser lento e
// irregular. O teto de tempo evita que uma sonda que morreu no boot deixe as
// outras esperando para sempre.
const encontro = process.env.SONDA_ENCONTRO;
const quantas = Number(process.env.SONDA_QUANTAS ?? '1');
if (encontro) {
  writeFileSync(join(encontro, String(process.pid)), '');
  const limite = Date.now() + 60_000;
  while (readdirSync(encontro).length < quantas && Date.now() < limite) {
    /* rendezvous */
  }
}

try {
  const escopo = resolveWorktreeScope();
  const ambiente = escopo === null ? null : resolveTestEnv(process.env, escopo);
  process.stdout.write(JSON.stringify({ ok: true, escopo, ambiente }) + '\\n');
} catch (e) {
  const erro = e instanceof Error ? e.message : String(e);
  process.stdout.write(JSON.stringify({ ok: false, escopo: null, ambiente: null, erro }) + '\\n');
}
`;
