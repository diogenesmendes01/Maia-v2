/**
 * `npm run test:integration:setup` / `:teardown` — issue #571, revisão da PR #597.
 *
 * ## O achado
 *
 * A #571 passou a mandar CADA worktree rodar `test:integration:setup`, mas o
 * `docker-compose.yml` fixa `container_name: maia-postgres` / `maia-redis` e as
 * portas 5432/6379 no host. O nome do projeto do Compose, por default, vem do
 * nome do DIRETÓRIO — ou seja, cada worktree pedia uma PILHA PRÓPRIA com nomes
 * e portas GLOBAIS. A segunda worktree a tentar subir batia em "container name
 * already in use". O bring-up documentado colidia entre árvores.
 *
 * ## O modelo escolhido, e por quê
 *
 * **(a) Infra física COMPARTILHADA, um coordenador só.** Um Postgres e um
 * Redis para o host inteiro; o isolamento entre worktrees acontece uma camada
 * acima — banco por worktree e db lógico do Redis por worktree, que é
 * exatamente o que a #571 construiu (`tests/helpers/worktree-scope.ts`).
 *
 * A alternativa (b) — projeto, containers e portas derivados por worktree —
 * foi recusada com motivo: ela obriga a propagar a porta escolhida para
 * `DATABASE_URL`, `TEST_DB_URL`, `REDIS_URL`, o `.env`, o runner de migrations
 * e o `psql` de diagnóstico de cada árvore; multiplica por ~60 o consumo de
 * memória e de disco de datastore numa máquina de dev; e RESOLVE UM PROBLEMA
 * QUE JÁ ESTÁ RESOLVIDO — duas worktrees não se enxergam hoje por causa do
 * banco/db lógico, não por causa do container. O que faltava não era mais
 * infra: era o bring-up parar de fingir que cada árvore tem a sua.
 *
 * ## O que isso obriga
 *
 *  - **project name FIXO** (`maia-v2`, o mesmo que o Compose já derivava do
 *    checkout principal — então nenhum volume existente é órfão). Declarado no
 *    topo do `docker-compose.yml` e repetido aqui em `--project-name`, para o
 *    comportamento não depender de qual diretório invocou o comando.
 *  - **`up` idempotente e seguro em concorrência**: a segunda worktree que
 *    subir encontra a pilha de pé e sai 0. A seção crítica roda sob um mutex em
 *    disco compartilhado por todas as árvores do host, porque dois
 *    `docker compose up` simultâneos criando o MESMO container é uma corrida no
 *    daemon, não no Compose.
 *  - **`down` é operação de COORDENADOR, não de worktree.** `docker compose
 *    down -v` apaga o Postgres e o Redis de TODO MUNDO — inclusive das dezenas
 *    de rodadas em andamento nas outras árvores. Ele passa a exigir consentimento
 *    explícito (`TEST_INFRA_TEARDOWN=yes`), e a recusa diz por quê.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { comLockDeDiretorio } from '../tests/helpers/lock-de-diretorio.js';

/**
 * Nome do projeto do Compose, FIXO. É o mesmo valor que o Compose derivaria do
 * diretório do checkout principal (`/…/Maia-v2` → `maia-v2`), de propósito:
 * quem já tem a pilha de pé continua com os mesmos volumes.
 */
export const NOME_DO_PROJETO = 'maia-v2';

/** Os serviços que a suíte de integração precisa — e só eles. */
export const SERVICOS = ['postgres', 'redis'] as const;

/** Consentimento explícito para destruir a infra compartilhada do host. */
export const CONSENTIMENTO_TEARDOWN = 'TEST_INFRA_TEARDOWN';

/** Mutex entre worktrees. `/tmp` é do HOST, que é o escopo certo da pilha. */
export const CAMINHO_DO_LOCK = join(tmpdir(), 'maia-test-infra.lock');

/**
 * Por que o teardown deve ser recusado — ou `null` quando pode seguir.
 *
 * Função pura, e é ela que o teste exercita: um guard que só existe dentro de
 * um `main()` não é verificável sem Docker.
 */
export function motivoParaRecusarTeardown(
  ambiente: Readonly<Record<string, string | undefined>>,
): string | null {
  if (ambiente[CONSENTIMENTO_TEARDOWN] === 'yes') return null;
  return [
    `Recusado: \`docker compose down -v\` destrói o Postgres e o Redis do HOST INTEIRO`,
    `(projeto ${NOME_DO_PROJETO}), não os desta worktree.`,
    'A infra de teste é COMPARTILHADA por decisão registrada — o isolamento entre',
    'árvores é o banco e o db lógico por worktree (README § Isolamento por worktree),',
    'não o container. Derrubá-la enquanto outra árvore roda apaga a rodada dela.',
    `Se você é o coordenador e é isso mesmo: ${CONSENTIMENTO_TEARDOWN}=yes npm run test:integration:teardown`,
  ].join(' ');
}

/** `docker compose …` com o projeto fixo, herdando stdio. */
function compose(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const filho = spawn('docker', ['compose', '--project-name', NOME_DO_PROJETO, ...args], {
      stdio: 'inherit',
    });
    filho.on('error', reject);
    filho.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function up(): Promise<number> {
  // `up -d --wait` já é idempotente para uma pilha de pé (sai 0 assim que os
  // healthchecks passam). O mutex cobre o outro caso: duas worktrees CRIANDO o
  // mesmo container ao mesmo tempo, que é corrida no daemon do Docker.
  const r = comLockDeDiretorio(
    CAMINHO_DO_LOCK,
    () => compose(['up', '-d', '--wait', ...SERVICOS]),
    // Subir Postgres + Redis do zero e passar nos healthchecks leva dezenas de
    // segundos; a espera e a validade têm de caber isso, senão a segunda
    // worktree quebra o lock da primeira no meio do `up`.
    { esperaMaximaMs: 300_000, validadeMs: 600_000, passoMs: 500 },
  );
  if (!r.ok) {
    console.error(
      `#571: outra worktree está subindo a infra compartilhada (lock ${CAMINHO_DO_LOCK}) ` +
        'e não liberou a tempo. Tente de novo, ou apague o lock se tiver certeza de que ' +
        'nenhum `docker compose up` está em curso.',
    );
    return 1;
  }
  return r.valor;
}

async function down(): Promise<number> {
  const recusa = motivoParaRecusarTeardown(env);
  if (recusa) {
    console.error(recusa);
    return 1;
  }
  const r = comLockDeDiretorio(CAMINHO_DO_LOCK, () => compose(['down', '-v']), {
    esperaMaximaMs: 300_000,
    validadeMs: 600_000,
    passoMs: 500,
  });
  return r.ok ? r.valor : 1;
}

async function main(): Promise<void> {
  const comando = argv[2];
  if (comando === 'up') exit(await up());
  if (comando === 'down') exit(await down());
  console.error('uso: tsx scripts/test-infra.ts <up|down>');
  exit(2);
}

// Só executa quando invocado como programa: o spec importa este módulo para
// exercitar o guard, e importar não pode subir nem derrubar nada.
const invocado = argv[1] ? pathToFileURL(argv[1]).href : '';
if (invocado === import.meta.url || invocado === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  await main();
}
