/**
 * Issue #571, revisão da PR #597 — a prova COMPORTAMENTAL do isolamento.
 *
 * ## O que a revisão apontou
 *
 * O gate verde da #571 não executava o caminho de worktree. No checkout do CI
 * `.git` é diretório, `resolveWorktreeScope()` devolve `null`, e os únicos
 * casos que consultavam o escopo real faziam `return` nesse estado. Alocação,
 * reciclagem, descoberta do git dir comum e duas rodadas simultâneas nunca
 * rodaram sob gate. A corrida de reciclagem — dois processos concluindo
 * "abandonado" a partir da MESMA observação e ambos saindo com o mesmo db —
 * era invisível para um teste single-process com escopo de mentira.
 *
 * ## O que este arquivo faz
 *
 * Cria `git worktree`s DE VERDADE num repositório temporário e dispara
 * PROCESSOS SEPARADOS em paralelo contra o mesmo registro de slots. Processo
 * separado é requisito: a memoização é por processo, e o interleaving de dois
 * `unlink` só existe entre processos.
 *
 * Três cenários, e o terceiro é o que fecha o achado:
 *
 *  1. slot livre — duas árvores, dois processos, dbs/bancos/URLs distintos;
 *  2. dono ausente — o slot de uma worktree que sumiu do disco é reciclado;
 *  3. **serialização** — com o mutex de reciclagem tomado por outro, ninguém
 *     recicla. É o GATE da corrida, é determinístico, e não depende de tempo:
 *     qualquer reciclagem que não passe pelo mutex reprova. Ver o comentário
 *     longo do caso, inclusive por que a primeira tentativa (um ponto de pausa
 *     dentro do alocador) media menos do que prometia;
 *  4. revalidação — um slot que deixou de estar abandonado é declinado;
 *  5. slot stale DISPUTADO — todos os slots pré-semeados como abandonados e
 *     uma sonda por slot, todas soltas no mesmo instante. Rede SECUNDÁRIA: a
 *     taxa de detecção dele é instável (medida no comentário do caso).
 *
 * Todo caso afirma `escopo !== null`. **Cair no caminho `scope === null` é
 * falha**, não motivo para `return` — foi assim que os 8 checks verdes da PR
 * original não provaram nada.
 *
 * ## O que ele NÃO faz
 *
 * Não toca no registro de slots do repositório real (`<repo>/.git/
 * maia-redis-slots/`): o repo de sonda tem `.git` próprio. Não conecta em
 * Postgres nem em Redis — a não-observabilidade cruzada com infra ao vivo é
 * `tests/integration/worktree-isolamento-canario.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caminhoDoLockDeReciclagem, reciclarSlot } from '../../helpers/worktree-scope.js';
import {
  criarRepoDeSonda,
  rodarSondas,
  type RepoDeSonda,
  type RespostaDaSonda,
} from '../../helpers/worktree-de-sonda.js';

/** Boot de Node + tsx, N processos em paralelo, várias rodadas. */
const PRAZO = 180_000;

let repo: RepoDeSonda;

beforeEach(() => {
  repo = criarRepoDeSonda();
});

afterEach(() => {
  repo.destruir();
});

/** Escreve um arquivo de posse com a idade pedida. */
function semearSlot(idx: number, dono: string, idadeMs: number): void {
  mkdirSync(repo.dirDeSlots, { recursive: true });
  const arquivo = join(repo.dirDeSlots, String(idx));
  writeFileSync(arquivo, dono, 'utf8');
  const quando = new Date(Date.now() - idadeMs);
  utimesSync(arquivo, quando, quando);
}

/** Os arquivos de posse hoje no disco, `<índice> → <dono>`. */
function posseNoDisco(): Map<number, string> {
  const mapa = new Map<number, string>();
  for (const entry of readdirSync(repo.dirDeSlots)) {
    const idx = Number.parseInt(entry, 10);
    if (!Number.isInteger(idx)) continue;
    mapa.set(idx, readFileSync(join(repo.dirDeSlots, entry), 'utf8').trim());
  }
  return mapa;
}

/**
 * A afirmação central, e ela é sobre TODAS as sondas de uma vez: ninguém caiu
 * no caminho nulo, ninguém estourou, e cada root saiu com um db só dele.
 */
function exigirIsolamento(respostas: readonly RespostaDaSonda[], roots: readonly string[]): void {
  for (const [i, r] of respostas.entries()) {
    expect(r.erro ?? '', `sonda ${roots[i]} estourou`).toBe('');
    expect(r.ok, `sonda ${roots[i]} não completou`).toBe(true);
    // O ponto do achado: um caso que aceita `null` não exercita nada.
    expect(r.escopo, `sonda ${roots[i]} caiu no caminho scope === null`).not.toBeNull();
    expect(r.escopo?.root).toBe(roots[i]);
    expect(r.escopo?.commonGitDir).toBe(repo.gitDirComum);
  }

  const dbs = respostas.map((r) => r.escopo?.redisDb);
  expect(new Set(dbs).size, `dbs do Redis repetidos: ${JSON.stringify(dbs)}`).toBe(dbs.length);

  const slugs = respostas.map((r) => r.escopo?.slug);
  expect(new Set(slugs).size, `slugs repetidos: ${JSON.stringify(slugs)}`).toBe(slugs.length);

  const bancos = respostas.map((r) => r.ambiente?.POSTGRES_DB);
  expect(new Set(bancos).size, `bancos repetidos: ${JSON.stringify(bancos)}`).toBe(bancos.length);

  const urls = respostas.map((r) => r.ambiente?.REDIS_URL);
  expect(new Set(urls).size, `URLs de Redis repetidas: ${JSON.stringify(urls)}`).toBe(urls.length);

  // E o disco tem de concordar com o que cada sonda afirmou possuir: um slot
  // cujo conteúdo aponta para outra árvore é posse fantasma.
  const posse = posseNoDisco();
  for (const r of respostas) {
    expect(posse.get(r.escopo?.redisDb ?? -1), `slot ${r.escopo?.redisDb} não nomeia o dono`).toBe(
      r.escopo?.root,
    );
  }
}

/** Espera um arquivo aparecer, sem prender a thread do teste. */
async function esperarArquivo(caminho: string, prazoMs = 60_000): Promise<void> {
  const limite = Date.now() + prazoMs;
  while (!existsSync(caminho)) {
    if (Date.now() > limite) throw new Error(`nada apareceu em ${caminho} em ${prazoMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('#571 — duas rodadas simultâneas em worktrees de verdade', () => {

  it(
    'slot livre: cada árvore sai com banco, ledger e db do Redis próprios',
    async () => {
      const roots = [repo.criarWorktree('wt-a'), repo.criarWorktree('wt-b')];
      const respostas = await rodarSondas(roots);
      exigirIsolamento(respostas, roots);

      // O ledger de migrations mora DENTRO do banco: bancos distintos são
      // ledgers distintos. É esta a metade da #571 que o nome do banco carrega.
      const [a, b] = respostas;
      expect(a.ambiente?.POSTGRES_DB).toMatch(/_wt_wt_a_[0-9a-f]{8}$/);
      expect(b.ambiente?.POSTGRES_DB).toMatch(/_wt_wt_b_[0-9a-f]{8}$/);
      expect(a.ambiente?.DATABASE_URL).not.toBe(b.ambiente?.DATABASE_URL);
    },
    PRAZO,
  );

  it(
    'dono ausente: o slot de uma worktree que sumiu do disco é reciclado',
    async () => {
      semearSlot(1, join(repo.base, 'arvore-que-nao-existe-mais'), 0);
      const roots = [repo.criarWorktree('wt-c')];
      const respostas = await rodarSondas(roots);
      exigirIsolamento(respostas, roots);
      expect(respostas[0].escopo?.redisDb, 'o slot 1 estava livre e devia ter sido reusado').toBe(1);
    },
    PRAZO,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * O GUARD da corrida — determinístico, e sobre o CONTRATO, não sobre tempo.
   *
   * ## Por que a primeira tentativa não servia
   *
   * A versão anterior deste caso expunha um ponto de pausa DENTRO do alocador
   * (`pausarNaDecisaoDeReciclar`) e o usava para parar uma sonda "entre a
   * observação e o ato". Ele reprovava a formulação do defeito que eu tinha
   * escrito — e passava, 0/12, contra o bloco LITERAL da PR #597. O motivo é
   * estrutural, não de calibração: aquele bloco faz a PRÓPRIA leitura do dono
   * (`readFileSync` + `statSync`) DEPOIS do ponto de pausa. A sonda lenta
   * acordava, relia, via a posse nova e fresca da outra árvore, e declinava
   * corretamente. O hook só atravessa a observação que ele por acaso precede,
   * e onde uma regressão futura coloca a SUA observação não é algo que este
   * arquivo possa controlar. Um guard cuja validade depende disso mede menos
   * do que promete, então o hook saiu do código sob teste.
   *
   * ## O que este caso faz no lugar
   *
   * Afirma o CONTRATO que torna a corrida impossível — "a reciclagem é
   * serializada pelo mutex do diretório" — observando-o de fora, pelo sistema
   * de arquivos, sem nenhum gancho no alocador:
   *
   *   1. o teste toma o mutex de reciclagem (`mkdir`, o mesmo primitivo);
   *   2. dispara uma sonda contra um slot ocupado e abandonado;
   *   3. espera o aviso de chegada que a SONDA emite (no programa dela, não no
   *      código sob teste) — sem esse aviso o caso REPROVA, em vez de passar
   *      vazio;
   *   4. com o mutex ainda na mão, exige que o slot continue nomeando o dono
   *      antigo e que a sonda não tenha terminado;
   *   5. solta o mutex e exige que a sonda então recicle e saia com aquele
   *      slot — o que prova que ela estava BLOQUEADA, e não desviada.
   *
   * Qualquer reciclagem que não passe pelo mutex — inclusive o bloco literal
   * da PR #597, que nem sabe que o lock existe — reivindica o slot no passo 4
   * e reprova. Não há tempo envolvido: só posse de um mutex.
   *
   * Medido, com o bloco literal da PR #597 reintroduzido no lugar da chamada
   * ao mutex: **12/12 vermelho**. Sem defeito: **0/12**. E com o aviso de
   * chegada da sonda suprimido (a coordenação falhando), o caso REPROVA em
   * 15s com `nada apareceu em …/cheguei` — nunca passa vazio.
   * ───────────────────────────────────────────────────────────────────────── */
  it(
    'a reciclagem é SERIALIZADA: com o mutex na mão de outro, ninguém recicla',
    async () => {
      const aviso = mkdtempSync(join(tmpdir(), 'wt571-aviso-'));
      const fantasma = join(repo.base, 'dono-que-sumiu');
      try {
        semearSlot(1, fantasma, 7 * 60 * 60 * 1000);
        const root = repo.criarWorktree('wt-bloqueada');
        const lock = caminhoDoLockDeReciclagem(repo.gitDirComum);

        // 1. o teste toma o mutex — o mesmo `mkdir` que o alocador usa.
        mkdirSync(lock, { recursive: true });

        let terminou = false;
        const promessa = rodarSondas([root], { SONDA_AVISO: aviso }).then((r) => {
          terminou = true;
          return r;
        });

        try {
          // 3. prova de que a sonda ENTROU no alocador. Se não vier, o caso
          //    estoura aqui — é o oposto de virar no-op silencioso.
          // 15s é ~10x o boot medido da sonda (0.4–1.5s): generoso para o
          //     runner e ainda rápido o bastante para a REPROVAÇÃO por falta
          //     de coordenação ser legível em vez de parecer travamento.
          await esperarArquivo(join(aviso, 'cheguei'), 15_000);
          // Margem enorme para o punhado de syscalls entre o aviso e a
          // tentativa de reciclagem, e MUITO abaixo da validade do mutex
          // (30s) e da espera do alocador (10s), para o lock não ser quebrado
          // nem a espera expirar por conta própria.
          await new Promise((r) => setTimeout(r, 2_000));

          // 4. o observável do contrato.
          expect(
            readFileSync(join(repo.dirDeSlots, '1'), 'utf8').trim(),
            'o slot foi reciclado enquanto o mutex de reciclagem estava tomado',
          ).toBe(fantasma);
          expect(terminou, 'a sonda alocou sem esperar o mutex').toBe(false);
        } finally {
          // 5. solta e deixa a sonda seguir.
          rmSync(lock, { recursive: true, force: true });
        }

        const [resposta] = await promessa;
        exigirIsolamento([resposta], [root]);
        expect(
          resposta.escopo?.redisDb,
          'depois do mutex livre ela tinha de reciclar o MESMO slot — se pegou outro, estava desviando, não bloqueando',
        ).toBe(1);
      } finally {
        rmSync(aviso, { recursive: true, force: true });
      }
    },
    PRAZO,
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * A segunda defesa, também determinística: a decisão é REVALIDADA sob o
   * mutex. É ela que faz o alocador declinar quando o slot deixou de estar
   * abandonado entre o pré-teste barato e o momento de agir — e foi
   * exatamente ela que segurou a formulação literal da PR #597 no cenário
   * acima. Aqui a revalidação é exercitada direto, sem depender de tempo.
   * ───────────────────────────────────────────────────────────────────────── */
  it('a reciclagem declina um slot que deixou de estar abandonado', () => {
    const vivo = join(repo.base, 'arvore-viva');
    mkdirSync(vivo, { recursive: true });
    semearSlot(1, join(repo.base, 'fantasma'), 7 * 60 * 60 * 1000);

    // O estado mudou depois do pré-teste: agora o slot é de uma árvore que
    // existe e acabou de tocar o mtime.
    writeFileSync(join(repo.dirDeSlots, '1'), vivo, 'utf8');

    expect(reciclarSlot(join(repo.dirDeSlots, '1'), join(repo.base, 'outra'))).toBe(false);
    expect(readFileSync(join(repo.dirDeSlots, '1'), 'utf8').trim()).toBe(vivo);
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * Caso ESTATÍSTICO — supridor de variantes, NÃO o gate.
   *
   * Ele joga 12 processos contra 12 slots abandonados e depende do escalonador
   * do sistema para produzir o interleaving ruim. Isso acha variantes de tempo
   * que o caso determinístico acima não modela, e por isso ele fica. Mas a
   * taxa de detecção dele NÃO é confiável, e o número é medido, não estimado:
   *
   *   bloco literal da PR #597, 12 execuções ......................... 6/12
   *   outra formulação do mesmo defeito, 10 execuções ................ 9/10
   *   mesma máquina, sob outra carga ................................. ~2/8
   *   sem defeito, 12 execuções (falso vermelho) ..................... 0/12
   *
   * Medições da MESMA regressão no MESMO host foram de 90% a 25%. Essa
   * dispersão é o argumento: um gate cuja sensibilidade depende da carga da
   * máquina não protege critério de aceite — no runner do CI o perfil é outro
   * de novo, e ninguém sabe qual. Quem protege é o caso de SERIALIZAÇÃO acima
   * (12/12 contra a formulação literal). Este aqui é rede secundária, e custa
   * ~6.3s dos ~11s do arquivo.
   * ───────────────────────────────────────────────────────────────────────── */
  it(
    'slot stale disputado: N processos, N slots abandonados, N dbs distintos',
    async () => {
      // 6 slots (TEST_REDIS_DATABASES=7 ⇒ índices 1..6) e 6 sondas: toda sonda
      // é OBRIGADA a reciclar, e não sobra folga para uma disputa perdida
      // passar despercebida. Se duas sondas ficarem com o mesmo slot, ou o
      // conjunto de dbs repete, ou alguém estoura por falta de índice.
      const QUANTAS = 12;

      for (let rodada = 0; rodada < 3; rodada++) {
        if (rodada > 0) {
          repo.destruir();
          repo = criarRepoDeSonda();
        }
        const vivaMasParada = join(repo.base, 'parada');
        mkdirSync(vivaMasParada, { recursive: true });

        const roots: string[] = [];
        for (let i = 0; i < QUANTAS; i++) roots.push(repo.criarWorktree(`wt-${rodada}-${i}`));

        for (let idx = 1; idx <= QUANTAS; idx++) {
          // Metade abandonada por sumiço do dono, metade por validade vencida
          // com o dono ainda no disco: os dois motivos de reciclagem entram na
          // mesma disputa.
          const dono = idx % 2 === 0 ? vivaMasParada : join(repo.base, `fantasma-${idx}`);
          semearSlot(idx, dono, 7 * 60 * 60 * 1000);
        }

        // 7 ⇒ índices 1..6. Sem folga: uma disputa perdida vira db repetido ou
        // estouro por falta de slot, e as duas coisas reprovam.
        const respostas = await rodarSondas(roots, { TEST_REDIS_DATABASES: '13' });
        exigirIsolamento(respostas, roots);
        expect(
          new Set(respostas.map((r) => r.escopo?.redisDb)),
          'com 6 slots e 6 sondas a saída tem de ser a permutação de 1..6',
        ).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
      }
    },
    PRAZO,
  );

  it(
    'a base do Redis e do Postgres do AMBIENTE atravessa os processos intacta',
    async () => {
      // Achado da revisão: o setup global limpava um endpoint e os workers
      // usavam outro. Aqui a base customizada entra pelo ambiente e a sonda —
      // outro processo, outra worktree — devolve o que ela USARIA. Só o índice
      // do db e o nome do banco podem mudar.
      const roots = [repo.criarWorktree('wt-x'), repo.criarWorktree('wt-y')];
      const respostas = await rodarSondas(roots, {
        REDIS_URL: 'rediss://cache:s3nh%40@redis.interno:6380/4',
        TEST_DB_URL: 'postgres://outro_user:outra%40senha@pg.interno:5433/base_custom',
      });
      exigirIsolamento(respostas, roots);

      for (const r of respostas) {
        expect(r.ambiente?.REDIS_URL).toBe(
          `rediss://cache:s3nh%40@redis.interno:6380/${r.escopo?.redisDb}`,
        );
        const pg = new URL(r.ambiente?.DATABASE_URL ?? '');
        expect(pg.host).toBe('pg.interno:5433');
        expect(pg.username).toBe('outro_user');
        expect(pg.pathname).toBe(`/base_custom_wt_${r.escopo?.slug}`);
        expect(r.ambiente?.POSTGRES_USER).toBe('outro_user');
        expect(r.ambiente?.POSTGRES_PASSWORD).toBe('outra@senha');
        // As specs de integração afirmam esta igualdade antes de rodar.
        expect(r.ambiente?.TEST_DB_URL).toBe(r.ambiente?.DATABASE_URL);
      }
    },
    PRAZO,
  );
});
