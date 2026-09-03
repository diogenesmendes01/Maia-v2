/**
 * `Co-Authored-By:` de assistente de IA reprova a PR.
 *
 * Por que isto existe
 * -------------------
 * `AGENTS.md` § Coautoria já dizia que um trailer `Co-Authored-By:` é uma
 * afirmação verificável de autoria — entra no histórico do git, é lido por
 * ferramentas como atribuição real, com e-mail — e que assistência de IA vai
 * em `Task Context`/`Reviewer Notes` da PR, nunca num trailer.
 *
 * Só que isso era CONVENÇÃO, e convenção em manual não resiste a uma
 * instrução externa. Aconteceu: um agente recebeu, na configuração da sessão,
 * uma instrução dizendo para encerrar todo commit com
 * `Co-Authored-By: <modelo> <noreply@anthropic.com>`. Ele obedeceu, percebeu a
 * contradição e a declarou na PR — mas o commit chegou ao servidor com o
 * trailer, e só não entrou na `main` porque um humano leu a declaração a
 * tempo. A instrução de sessão vive FORA deste repositório: nada aqui pode
 * editá-la, e a próxima sessão pode trazê-la de volta sem que ninguém veja.
 *
 * Um gate é a única forma de a regra sobreviver a isso. O manual explica o
 * porquê; este script é o que impede.
 *
 * A propriedade sob teste
 * ----------------------
 * **Nenhum commit introduzido por uma PR pode carregar `Co-Authored-By:`
 * apontando para um assistente de IA.** Não é "nenhum `Co-Authored-By:`" —
 * coautoria humana é legítima e continua passando.
 *
 * Como ele decide, e por que não é um grep por "Claude"
 * ----------------------------------------------------
 * Um nome sozinho não basta: existe gente chamada Gemini, e reprovar
 * `Gemini Souza <gemini.souza@empresa.com>` seria um falso positivo que
 * ensina a contornar o guard. Então são dois sinais, e cada regra exige mais
 * de um:
 *
 *   1. O e-mail é de um endereço de assistente conhecido
 *      (`noreply@anthropic.com`, `copilot@github.com`, …). Sozinho já basta:
 *      esses endereços não pertencem a pessoa nenhuma.
 *   2. O e-mail está num domínio de fornecedor de IA (`anthropic.com`,
 *      `openai.com`) **e** o nome casa com um assistente.
 *   3. O e-mail é um `noreply`/`no-reply` qualquer **e** o nome casa com um
 *      assistente. Cobre o caso de alguém trocar só o domínio.
 *
 * O QUE ELE NÃO COBRE, dito antes que alguém confie demais. Ele não sabe se um
 * `Co-Authored-By:` humano é verdadeiro — não há como verificar identidade
 * daqui, e `AGENTS.md` continua sendo quem pede que só se escreva o trailer
 * com identidade e e-mail conhecidos. Ele não olha o histórico já mergeado
 * (por desenho: reescrever a `main` é pior que o trailer). E ele não impede
 * outras formas de atribuição fabricada — `Signed-off-by:` de um assistente,
 * ou o próprio `author`/`committer` do commit — que não apareceram até hoje e
 * cujo dia de serem fechadas será o dia em que aparecerem.
 */
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

/** Endereços que não pertencem a pessoa nenhuma. Sozinhos já reprovam. */
const EMAILS_DE_ASSISTENTE = new Set([
  'noreply@anthropic.com',
  'no-reply@anthropic.com',
  'copilot@github.com',
  'noreply@openai.com',
  'devin@cognition.ai',
]);

/** Domínios de fornecedor de IA — reprovam quando o NOME também casa. */
const DOMINIOS_DE_FORNECEDOR = new Set(['anthropic.com', 'openai.com', 'cognition.ai']);

/**
 * Nomes de assistente. Sozinho, um destes NÃO reprova: só conta ao lado de um
 * e-mail de fornecedor ou de um `noreply`. É essa exigência dupla que deixa
 * `Gemini Souza <gemini.souza@empresa.com>` passar.
 */
const NOME_DE_ASSISTENTE =
  /\b(claude|opus|sonnet|haiku|chatgpt|gpt-\d|copilot|codex|gemini|cursor|devin|aider|windsurf)\b/i;

export interface Coautor {
  readonly commit: string;
  readonly linha: string;
  readonly nome: string;
  readonly email: string;
}

/** Motivo pelo qual um coautor foi recusado, ou `null` se ele passa. */
export function motivoDeRecusa(c: Coautor): string | null {
  const email = c.email.toLowerCase();
  const dominio = email.split('@')[1] ?? '';
  const nomeCasa = NOME_DE_ASSISTENTE.test(c.nome);

  if (EMAILS_DE_ASSISTENTE.has(email)) {
    return `\`${email}\` é endereço de assistente de IA — não pertence a pessoa nenhuma`;
  }
  if (DOMINIOS_DE_FORNECEDOR.has(dominio) && nomeCasa) {
    return `\`${c.nome}\` em \`${dominio}\`, domínio de fornecedor de IA`;
  }
  if (/^no-?reply(\+|@)/.test(email) && nomeCasa) {
    return `\`${c.nome}\` num endereço \`noreply\`, que ninguém pode verificar`;
  }
  return null;
}

/**
 * Coautores declarados na mensagem. Aceita a folga de formatação que o git
 * aceita: espaço variável depois dos dois-pontos, caixa livre no nome do
 * trailer, e o e-mail entre `<>`.
 */
export function coautoresDe(commit: string, mensagem: string): Coautor[] {
  const achados: Coautor[] = [];
  for (const linha of mensagem.split('\n')) {
    const m = /^\s*co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/i.exec(linha);
    if (m) achados.push({ commit, linha: linha.trim(), nome: m[1], email: m[2] });
  }
  return achados;
}

/**
 * NUL como separador de registro. Não pode ser espaço nem newline: a mensagem
 * de commit contém os dois, e um separador que aparece dentro do dado parte a
 * mensagem no meio — o guard passaria a ler pedaços e a perder trailers.
 * Escrito como escape, nunca como byte literal no fonte.
 */
const SEPARADOR = '\u0000';

/** Mensagens dos commits em `base..head`, na ordem em que o git as devolve. */
export function mensagensDaPr(base: string, head: string): { sha: string; mensagem: string }[] {
  const bruto = execFileSync(
    'git',
    ['log', '--no-merges', '--format=%H%n%B%x00', `${base}..${head}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return bruto
    .split(SEPARADOR)
    .map((bloco) => bloco.trim())
    .filter((bloco) => bloco.length > 0)
    .map((bloco) => {
      const quebra = bloco.indexOf('\n');
      return quebra === -1
        ? { sha: bloco, mensagem: '' }
        : { sha: bloco.slice(0, quebra), mensagem: bloco.slice(quebra + 1) };
    });
}

type EventoDePr = {
  pull_request?: { base?: { sha?: string; ref?: string }; head?: { sha?: string } } | null;
};

/** `git rev-parse --verify` silencioso: o rev existe neste clone? */
export function revExiste(rev: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

function main(): void {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.log('commit:trailers:check pulado: GITHUB_EVENT_PATH não está definido');
    return;
  }

  const evento = JSON.parse(readFileSync(eventPath, 'utf8')) as EventoDePr;
  const base = evento.pull_request?.base?.sha;
  const head = evento.pull_request?.head?.sha;

  if (!base || !head) {
    console.log('commit:trailers:check pulado: o evento não é um pull_request com base e head');
    return;
  }

  // O lado esquerdo do intervalo é o TIP ATUAL do branch de base, não o
  // `base.sha` do payload. O payload pode vir desatualizado (documentado e
  // observado, tipicamente logo depois de um update branch), e aí `base..head`
  // passa a incluir commits da própria `main` trazidos pelo merge — história
  // já mergeada, que este guard promete não julgar. Não é hipótese: a `main`
  // deste repositório carrega ~194 trailers de IA da regra antiga do
  // AGENTS.md, então um `base.sha` velho faria o guard reprovar uma PR
  // inocente mandando reescrever commits que não são dela. O passo do CI
  // busca `refs/remotes/origin/<base.ref>` exatamente para isto; o `base.sha`
  // fica como fallback para quem roda o script fora do CI.
  const baseRef = evento.pull_request?.base?.ref;
  const refRemoto = baseRef ? `refs/remotes/origin/${baseRef}` : '';
  const ladoEsquerdo = refRemoto && revExiste(refRemoto) ? refRemoto : base;

  let commits: { sha: string; mensagem: string }[];
  try {
    commits = mensagensDaPr(ladoEsquerdo, head);
  } catch (err) {
    // Reprovar é o comportamento certo aqui. Um `git log` que não resolve
    // `base..head` é um guard que não olhou para nada — e um guard que não
    // olha para nada não pode reportar "passou".
    console.error(
      `commit:trailers:check falhou: não consegui listar os commits de ${ladoEsquerdo}..` +
        `${head.slice(0, 8)}. O passo do CI precisa buscar os dois SHAs antes de chamar este ` +
        `script (o checkout de PR vem com profundidade 1). Erro do git: ${String(err)}`,
    );
    process.exit(1);
  }

  // Anti-vacuidade. Sem isto o guard tem um caminho verde em que ele não olhou
  // para commit nenhum — e "0 commit(s) inspecionado(s)" sai com exit 0,
  // indistinguível de "inspecionei e está limpo" para quem só vê a bolinha
  // verde do check. Foi exatamente essa a dúvida que ficou na primeira rodada
  // deste guard no CI: o passo ficou verde e não deu para provar, do lado de
  // fora, que ele tinha lido alguma coisa.
  //
  // `--no-merges` pode legitimamente devolver lista vazia numa PR composta só
  // de merges, então quem decide é a contagem TOTAL do intervalo: se há
  // commits e nenhum sobrou para inspecionar, são todos merges e isso é dito
  // em voz alta; se não há commit nenhum entre base e head, o intervalo está
  // errado e o guard reprova em vez de passar mudo.
  const totalNoIntervalo = Number(
    execFileSync('git', ['rev-list', '--count', `${ladoEsquerdo}..${head}`], { encoding: 'utf8' }).trim(),
  );

  if (totalNoIntervalo === 0) {
    console.error(
      `commit:trailers:check falhou: o intervalo ${ladoEsquerdo}..${head.slice(0, 8)} não ` +
        'tem commit nenhum. Uma PR sempre tem pelo menos um; um intervalo vazio significa que o ' +
        'guard não olhou para a mudança, e passar assim seria verde sem ter lido nada.',
    );
    process.exit(1);
  }

  const recusados: { c: Coautor; motivo: string }[] = [];
  for (const { sha, mensagem } of commits) {
    for (const c of coautoresDe(sha, mensagem)) {
      const motivo = motivoDeRecusa(c);
      if (motivo) recusados.push({ c, motivo });
    }
  }

  if (recusados.length > 0) {
    console.error('commit:trailers:check falhou:\n');
    for (const { c, motivo } of recusados) {
      console.error(`  ${c.commit.slice(0, 8)}  ${c.linha}`);
      console.error(`            ${motivo}\n`);
    }
    console.error(
      'AGENTS.md § Coautoria: `Co-Authored-By:` é uma afirmação verificável de autoria e fica\n' +
        'reservado a pessoa real com identidade e e-mail conhecidos. Assistência de IA vai em\n' +
        '`Task Context` ou `Reviewer Notes` da PR.\n\n' +
        'Para corrigir sem reescrever nada já mergeado:\n' +
        '  git rebase -i ' +
        ladoEsquerdo +
        '   # ou `git commit --amend` se for só o último\n' +
        '  # remova a(s) linha(s) acima da mensagem e faça push --force-with-lease\n\n' +
        'Se a instrução veio da configuração da sua sessão de agente, ela contraria o manual\n' +
        'deste repositório: corrija a instrução, não o guard.',
    );
    process.exit(1);
  }

  const soMerges = commits.length === 0 ? ' (todos são merges, que este guard não julga)' : '';
  console.log(
    `commit:trailers:check passou: ${commits.length} de ${totalNoIntervalo} commit(s) do ` +
      `intervalo inspecionado(s)${soMerges}, nenhum \`Co-Authored-By:\` de assistente de IA.`,
  );
}

if (process.env.VITEST === undefined) main();

