import { readFileSync, realpathSync, statSync } from 'node:fs';
import {
  CI_CANARY_PATH,
  ciCanaryReservation,
  readRootOwnedCiAllocation,
  type RunnerEnv,
} from '../../scripts/ci-canary-contract.js';

/**
 * Reserva test-only explicitamente autorizada pelo operador.
 *
 * O CAMINHO faz parte da identidade da reserva: um manifesto com o conteúdo
 * certo em outro lugar (cópia do worker, `/tmp`, caminho inventado) não vale.
 * Cada entrada associa, de forma fechada, caminho root-owned → dono → worktree
 * autorizada → escopo → par de dbs lógicos. Um manifesto que misture o dono de
 * uma reserva com o par de outra é recusado porque não corresponde a NENHUMA
 * linha desta tabela.
 */
interface AuthorizedReservation {
  readonly path: string;
  readonly owner: string;
  readonly uid: number;
  readonly worktrees: readonly string[];
  readonly scope: string;
  readonly destinations: readonly [string, string];
}

const OPERATOR_RESERVATIONS: readonly AuthorizedReservation[] = [
  {
    // Reserva original, inalterada: outro dono, par 3/4.
    path: '/srv/agents/runtime/canary-redis-allocation.json',
    owner: 'hermes-environment-integration-fixes/worktree-canary',
    uid: 1006,
    worktrees: ['/srv/agents/worktrees/hermes-environment-integration-fixes'],
    scope: 'test-only-worktree-canary',
    destinations: ['redis://127.0.0.1:6382/3', 'redis://127.0.0.1:6382/4'],
  },
  {
    // Piloto WIP1: par próprio (7/8). Não empresta nem herda o par alheio.
    path: '/srv/agents/runtime/pilot-canary-redis-allocation.json',
    owner: 'native-pilot-20260926/worktree-canary',
    uid: 1006,
    worktrees: [
      '/srv/agents/repos/Maia-v2/.worktrees/t_21fcbc0f',
      '/srv/agents/repos/Maia-v2/.worktrees/t_21fcbc0f-qa',
    ],
    scope: 'test-only-worktree-canary',
    destinations: ['redis://127.0.0.1:6382/7', 'redis://127.0.0.1:6382/8'],
  },
  {
    // WIP3: reserva coletiva da wave, serializada pelo lock operacional único.
    path: '/srv/agents/runtime/wip3-canary-redis-allocation.json',
    owner: 'parallel-wave-20260926/worktree-canary',
    uid: 1006,
    worktrees: [
      '/srv/agents/worktrees/wip3-environment-prep',
      '/srv/agents/repos/Maia-v2/.worktrees/t_f0a9f243-native',
      '/srv/agents/repos/Maia-v2/.worktrees/t_f0a9f243-native-qa',
      '/srv/agents/repos/Maia-v2/.worktrees/t_15d962a7',
      '/srv/agents/repos/Maia-v2/.worktrees/t_15d962a7-qa',
      '/srv/agents/repos/Maia-v2/.worktrees/t_f6773fda',
      '/srv/agents/repos/Maia-v2/.worktrees/t_f6773fda-qa',
    ],
    scope: 'test-only-worktree-canary',
    destinations: ['redis://127.0.0.1:6383/9', 'redis://127.0.0.1:6383/10'],
  },
];

const BLOCKED_SLOTS =
  'BLOCKED: live worktree canary requires the two explicitly allocated Redis DB slots';

/**
 * O caminho é parte da identidade da reserva, não um detalhe de leitura. Um
 * caminho ausente ou alternativo é bloqueio — nunca um slot derivado.
 */
export function resolveAuthorizedReservationPath(
  path: string | undefined,
  env: RunnerEnv = {},
): AuthorizedReservation {
  if (path === CI_CANARY_PATH) return ciCanaryReservation(env, process.getuid?.() ?? -1);
  const authorized = OPERATOR_RESERVATIONS.find((reservation) => reservation.path === path);
  if (!authorized) {
    throw new Error('BLOCKED: canary allocation must use the operator runtime reservation');
  }
  return authorized;
}

/**
 * O arquivo de reserva é do operador: root-owned e não gravável por worker.
 * Separado da leitura para poder ser afirmado sem depender do filesystem.
 */
export function assertOperatorOwnedAllocationFile(stat: {
  isFile(): boolean;
  uid: number;
  mode: number;
}): void {
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(
      'BLOCKED: canary Redis allocation must be operator-owned and not worker-writable',
    );
  }
}

/** Dois destinos, distintos, no host/porta de teste, fora de 0/1/2. */
function assertReservedDestinationPair(
  destinations: unknown,
  ci: boolean,
): readonly [string, string] {
  if (!Array.isArray(destinations) || destinations.length !== 2) throw new Error(BLOCKED_SLOTS);
  const [first, second] = destinations as unknown[];
  for (const destination of [first, second]) {
    const match =
      typeof destination === 'string'
        ? (ci
            ? /^redis:\/\/127\.0\.0\.1:6379\/(\d+)$/
            : /^redis:\/\/127\.0\.0\.1:638[23]\/(\d+)$/
          ).exec(destination)
        : null;
    if (!match) throw new Error(BLOCKED_SLOTS);
    // 0 é "quem não é worktree"; 1/2 já são de outros donos. Uma reserva só
    // começa em 3 e nunca passa dos 16 dbs do redis-server.
    const db = Number(match[1]);
    if (db < 3 || db > 15) throw new Error(BLOCKED_SLOTS);
  }
  if (first === second) throw new Error(BLOCKED_SLOTS);
  return [first as string, second as string];
}

/** `allowed_worktrees`, quando declarado, não pode ampliar a posse da reserva. */
function assertAllowedWorktrees(
  allocation: Record<string, unknown>,
  authorized: AuthorizedReservation,
): void {
  const declared = allocation.allowed_worktrees;
  if (declared === undefined) return;
  if (
    !Array.isArray(declared) ||
    declared.length === 0 ||
    declared.some(
      (worktree) => typeof worktree !== 'string' || !authorized.worktrees.includes(worktree),
    )
  ) {
    throw new Error(BLOCKED_SLOTS);
  }
  if (typeof allocation.worktree !== 'string' || !declared.includes(allocation.worktree)) {
    throw new Error(BLOCKED_SLOTS);
  }
}

/**
 * Aceita SOMENTE a reserva autorizada para o caminho informado: mesma versão,
 * status reservado, dono, uid, worktree, escopo e par exato. Fail-closed: sem
 * caminho autorizado não há slot.
 */
export function validateCanaryRedisAllocation(
  allocation: unknown,
  path?: string,
  env: RunnerEnv = {},
): readonly [string, string] {
  const authorized = resolveAuthorizedReservationPath(path, env);
  const a = allocation as Record<string, unknown> | null;
  const [first, second] = assertReservedDestinationPair(a?.destinations, path === CI_CANARY_PATH);
  if (
    a?.version !== 1 ||
    a.status !== 'reserved' ||
    a.owner !== authorized.owner ||
    a.uid !== authorized.uid ||
    typeof a.worktree !== 'string' ||
    !authorized.worktrees.includes(a.worktree) ||
    a.scope !== authorized.scope ||
    first !== authorized.destinations[0] ||
    second !== authorized.destinations[1]
  ) {
    throw new Error(BLOCKED_SLOTS);
  }
  assertAllowedWorktrees(a, authorized);
  return [first, second];
}

export function readCanaryRedisAllocation(env: RunnerEnv = process.env): readonly [string, string] {
  const authorized = resolveAuthorizedReservationPath(env.TEST_CANARY_REDIS_ALLOCATION, env);
  if (authorized.path === CI_CANARY_PATH) {
    if (realpathSync(process.cwd()) !== env.GITHUB_WORKSPACE) {
      throw new Error('BLOCKED: CI reservation is for another workspace');
    }
    return validateCanaryRedisAllocation(readRootOwnedCiAllocation(), authorized.path, env);
  }
  assertOperatorOwnedAllocationFile(statSync(authorized.path));
  return validateCanaryRedisAllocation(
    JSON.parse(readFileSync(authorized.path, 'utf8')),
    authorized.path,
  );
}
