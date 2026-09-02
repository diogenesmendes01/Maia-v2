/**
 * O guard que impede `Co-Authored-By:` de assistente de IA nos commits de uma PR.
 *
 * O defeito que ele fecha aconteceu de verdade: a configuração de uma sessão de
 * agente mandava encerrar todo commit com
 * `Co-Authored-By: <modelo> <noreply@anthropic.com>`, contrariando
 * `AGENTS.md` § Coautoria. O agente obedeceu e declarou a contradição na PR — o
 * commit só não entrou na `main` porque um humano leu a declaração. A instrução
 * vive fora deste repositório e pode voltar; o gate é o que sobrevive a ela.
 *
 * Este spec tem duas metades que valem por igual. As recusas provam que o guard
 * morde; os **controles** provam que ele não é uma rede que pega tudo — um guard
 * que reprovasse coautoria humana seria removido na primeira semana, e aí a
 * regra não valeria nada. É por isso que `Gemini Souza <gemini@empresa.com>`
 * está aqui: um grep por nome de modelo reprovaria essa pessoa.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

import {
  coautoresDe,
  motivoDeRecusa,
  mensagensDaPr,
} from '../../../scripts/check-commit-trailers.js';

/** `Co-Authored-By:` que o guard TEM de recusar, com o porquê de cada um. */
const RECUSADOS: readonly { linha: string; porque: string }[] = [
  {
    linha: 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    porque: 'é literalmente o trailer que a instrução de sessão mandava escrever',
  },
  {
    linha: 'Co-Authored-By: Claude <claude@anthropic.com>',
    porque: 'domínio de fornecedor + nome de assistente, mesmo sem ser `noreply`',
  },
  {
    linha: 'Co-Authored-By: Copilot <copilot@github.com>',
    porque: 'endereço de assistente conhecido, num domínio que NÃO é de fornecedor de IA',
  },
  {
    linha: 'Co-Authored-By: GPT-4 <noreply@qualquercoisa.example>',
    porque: 'trocar o domínio não conserta: `noreply` + nome de assistente continua reprovando',
  },
  {
    linha: 'co-authored-by:   Claude Opus 5   <noreply@anthropic.com>  ',
    porque: 'caixa e espaçamento são folga que o git aceita — o guard não pode ser burlado por isso',
  },
];

/** `Co-Authored-By:` que o guard TEM de deixar passar. */
const ACEITOS: readonly { linha: string; porque: string }[] = [
  {
    linha: 'Co-Authored-By: Diógenes Mendes <diogenes.mendes01@gmail.com>',
    porque: 'coautoria humana verificável é exatamente o que AGENTS.md quer preservar',
  },
  {
    linha: 'Co-Authored-By: Gemini Souza <gemini.souza@empresa.com>',
    porque:
      'pessoa real cujo nome casa com um modelo. Um grep por nome a reprovaria, e um falso ' +
      'positivo desses é o que faz alguém arrancar o guard',
  },
  {
    linha: 'Co-Authored-By: Ana Lima <12345+analima@users.noreply.github.com>',
    porque: '`noreply` do GitHub é o endereço normal de quem esconde o e-mail; sem nome de modelo, passa',
  },
];

describe('Co-Authored-By de assistente de IA reprova a PR', () => {
  for (const { linha, porque } of RECUSADOS) {
    it(`RECUSA — ${linha.trim()} (${porque})`, () => {
      const achados = coautoresDe('abc1234', linha);
      // Anti-vacuidade: se o parser não achasse o trailer, `motivoDeRecusa`
      // nunca seria chamado e o teste passaria sem ter olhado para nada.
      expect(achados, `o parser não reconheceu "${linha}" como trailer`).toHaveLength(1);
      expect(motivoDeRecusa(achados[0]), `"${linha}" deveria ser recusado`).not.toBeNull();
    });
  }

  for (const { linha, porque } of ACEITOS) {
    it(`ACEITA — ${linha.trim()} (${porque})`, () => {
      const achados = coautoresDe('abc1234', linha);
      expect(achados, `o parser não reconheceu "${linha}" como trailer`).toHaveLength(1);
      expect(
        motivoDeRecusa(achados[0]),
        `"${linha}" foi recusado, mas é coautoria legítima. Um guard que reprova pessoa real ` +
          'é um guard que alguém desliga.',
      ).toBeNull();
    });
  }

  it('uma mensagem sem nenhum trailer não produz coautor — nem recusa', () => {
    expect(coautoresDe('abc1234', 'fix: algo\n\ncorpo qualquer\n')).toEqual([]);
  });
});

describe('mensagensDaPr lê os commits do intervalo sem partir a mensagem', () => {
  /** Repositório de verdade: é o único jeito de exercer o `git log` e o NUL. */
  function repoTemporario(): { dir: string; base: string; head: string; limpar: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'trailers-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'teste@exemplo.invalid');
    git('config', 'user.name', 'Teste');
    git('config', 'commit.gpgsign', 'false');

    writeFileSync(join(dir, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');

    // Mensagem com PARÁGRAFOS e linha em branco: é o caso que um separador mal
    // escolhido (espaço, newline) partiria no meio, fazendo o guard perder o
    // trailer que vem lá no fim.
    writeFileSync(join(dir, 'a.txt'), 'um\n');
    git('add', '.');
    git(
      'commit',
      '--quiet',
      '-m',
      'feat: assunto\n\ncorpo com uma linha em branco acima\ne outra linha\n\n' +
        'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    );

    writeFileSync(join(dir, 'a.txt'), 'dois\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'chore: sem trailer nenhum');
    const head = git('rev-parse', 'HEAD');

    return { dir, base, head, limpar: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /**
   * Roda o SCRIPT como o CI roda: processo próprio, `GITHUB_EVENT_PATH`
   * apontando para um payload de evento. É o único jeito de exercer `main()` —
   * e é onde mora a asserção anti-vacuidade, que nenhuma função pura alcança.
   */
  function rodarScript(dir: string, base: string, head: string): { code: number; saida: string } {
    const evento = join(dir, 'evento.json');
    writeFileSync(evento, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
    const script = join(import.meta.dirname, '../../../scripts/check-commit-trailers.ts');
    // Caminho ABSOLUTO do CLI do tsx: o `cwd` do subprocesso é o repositório
    // temporário (o script lê o git do diretório corrente), e de lá um
    // especificador nu como `tsx` não resolve.
    const require_ = createRequire(import.meta.url);
    const tsx = join(dirname(require_.resolve('tsx/package.json')), 'dist/cli.mjs');
    const r = spawnSync(process.execPath, [tsx, script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: evento, VITEST: undefined },
    });
    return { code: r.status ?? -1, saida: `${r.stdout}${r.stderr}` };
  }

  it('REPROVA quando o intervalo não tem commit nenhum — verde vazio é pior que vermelho', () => {
    const repo = repoTemporario();
    try {
      // base === head: o guard não teria olhado para mudança nenhuma.
      const { code, saida } = rodarScript(repo.dir, repo.head, repo.head);
      expect(code, `esperava exit 1, veio ${code}. Saída:\n${saida}`).toBe(1);
      expect(saida).toContain('não tem commit nenhum');
    } finally {
      repo.limpar();
    }
  });

  it('quando passa, diz QUANTOS commits inspecionou — a bolinha verde sozinha não prova leitura', () => {
    const repo = repoTemporario();
    try {
      // O commit do meio tem o trailer, então este intervalo só pode ser o
      // último commit — que está limpo.
      const anterior = execFileSync('git', ['-C', repo.dir, 'rev-parse', 'HEAD~1'], {
        encoding: 'utf8',
      }).trim();
      const { code, saida } = rodarScript(repo.dir, anterior, repo.head);
      expect(code, `esperava exit 0. Saída:\n${saida}`).toBe(0);
      expect(saida).toContain('1 de 1 commit(s) do intervalo inspecionado(s)');
    } finally {
      repo.limpar();
    }
  });

  it('acha o trailer no fim de uma mensagem de vários parágrafos, e só os commits do intervalo', () => {
    const repo = repoTemporario();
    try {
      const cwd = process.cwd();
      process.chdir(repo.dir);
      try {
        const commits = mensagensDaPr(repo.base, repo.head);

        expect(commits, 'o intervalo base..head tem exatamente os dois commits novos').toHaveLength(
          2,
        );

        const coautores = commits.flatMap((c) => coautoresDe(c.sha, c.mensagem));
        expect(
          coautores,
          'o trailer está na última linha de uma mensagem com linhas em branco — se o separador ' +
            'de registro fosse newline ou espaço, ele teria sido perdido aqui',
        ).toHaveLength(1);
        expect(motivoDeRecusa(coautores[0])).not.toBeNull();

        // O commit de base NÃO entra: o guard não julga histórico já mergeado.
        expect(commits.map((c) => c.sha)).not.toContain(repo.base);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      repo.limpar();
    }
  });
});
