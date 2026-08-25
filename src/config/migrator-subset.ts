/**
 * A invariante do subset `migrator`: o que um job de DDL PODE carregar
 * (issue #565 — o recurso de migration separado do orquestrador real).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este módulo trava, e por que não é uma lista de nomes
 * ─────────────────────────────────────────────────────────────────────────
 * `entriesForService('migrator')` já responde "o que o migrator recebe".
 * O que faltava era uma afirmação sobre o que ele NUNCA pode receber — e a
 * forma óbvia de escrevê-la (uma allowlist/denylist de nomes copiada à mão)
 * é a que envelhece em silêncio: ela protege contra `WHATSAPP_NUMBER_MAIA`,
 * que alguém lembrou de listar, e não contra a `WHATSAPP_*` que for criada
 * na semana que vem.
 *
 * Aqui a invariante é expressa pela ORIGEM da chave, que é dado que o
 * contrato já carrega em cada `EnvVarSpec`:
 *
 *   1. `group` — o domínio de onde a variável vem (`llm`, `whatsapp`,
 *      `owner`, `backup`, `admin-ui`, …). O migrator só pode carregar
 *      `MIGRATOR_DOMAINS`: o processo (`core`) e o banco (`database`).
 *      Um grupo NOVO em `GROUP_ORDER` nasce proibido para o migrator sem
 *      ninguém editar este arquivo — é essa a propriedade que uma lista de
 *      nomes não tem;
 *   2. `MAIA_KEY_PREFIXES` (`src/config/metadata.ts`) — os namespaces que a
 *      Maia possui. Todos eles são de domínio de aplicação, com UMA exceção:
 *      `MAIA_`, que é o namespace da plataforma/processo (`MAIA_ENV`,
 *      `MAIA_BUILD_COMMIT`, `MAIA_CONFIG_STRICT_BOOT`). Um prefixo novo
 *      acrescentado àquela lista também nasce proibido aqui;
 *   3. `secret` — um segredo no subset do migrator só pode ser credencial de
 *      BANCO. Eixo próprio de propósito: o grupo `core` é permitido, e um
 *      segredo que aparecesse nele passaria pelo eixo (1).
 *
 * E o PISO, que é a outra metade da mesma invariante: um subset que encolhe
 * demais não é um raio de explosão menor, é um job quebrado. `DATABASE_URL`
 * tem de estar lá e tem de ser obrigatória em todos os profiles. Este eixo
 * NOMEIA a variável de propósito — o risco de envelhecer está no teto (o que
 * é proibido), não no piso (o que o processo comprovadamente lê:
 * `scripts/migrate.ts` monta o `pg.Pool` com `config.DATABASE_URL`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Onde isto roda
 * ─────────────────────────────────────────────────────────────────────────
 * `loadMigrationConfig()` (`src/config/migration-config.ts`) chama
 * `assertMigratorSubsetMinimal()` ANTES de validar o ambiente — ou seja, no
 * boot do processo de migration, que é o único call site de produção do
 * loader (`scripts/migrate.ts`). Um contrato que dê ao migrator uma chave de
 * aplicação não vira um deploy com raio de explosão maior: vira um migrator
 * que se recusa a rodar, com a variável e a regra nomeadas.
 *
 * A checagem é sobre DADO ESTÁTICO (o contrato compilado na imagem), então
 * ela é barata — 15 entradas — e determinística. O guard de CI
 * (`tests/unit/config/migrator-subset.spec.ts`) mede exatamente a mesma
 * função sobre exatamente o mesmo contrato; a diferença é só quando o
 * vermelho aparece.
 *
 * PURO: nada aqui lê `process.env`, disco ou rede.
 */
import { entriesForService } from '@/config/contract.js';
import {
  type ConfigGroup,
  type ConfigProblem,
  type EnvVarSpec,
  MAIA_KEY_PREFIXES,
  MAIA_PROFILES,
} from '@/config/metadata.js';

/**
 * Os domínios que um job de DDL pode carregar: o processo e o banco.
 *
 * `core` são os knobs do processo (`NODE_ENV`, `MAIA_ENV`, `TZ`,
 * `LOG_LEVEL`, `MAIA_BUILD_COMMIT`, `MAIA_CONFIG_STRICT_BOOT`) — o mínimo
 * para o processo resolver o profile, logar e se identificar numa build.
 * `database` é o destino do DDL, mais os quatro tetos de lock/statement da
 * #516, que só existem para o migrator.
 *
 * Tudo o mais é aplicação. Não há um terceiro grupo em discussão: um job que
 * aplica DDL não fala com cliente, não chama LLM, não faz backup e não
 * autentica ninguém.
 */
export const MIGRATOR_DOMAINS: readonly ConfigGroup[] = Object.freeze<ConfigGroup[]>([
  'core',
  'database',
]);

/**
 * O único namespace da Maia que não é de domínio de aplicação.
 *
 * Ele é da PLATAFORMA: `MAIA_ENV` decide o profile, `MAIA_BUILD_COMMIT` diz
 * qual build está rodando, `MAIA_CONFIG_STRICT_BOOT` é a escotilha de
 * rollback do próprio contrato. Todo o resto de `MAIA_KEY_PREFIXES`
 * (`WHATSAPP_`, `OWNER_`, `VOYAGE_`, `BACKUP_`, `OIDC_`, `ALERT_`, …) nomeia
 * um domínio de aplicação — e é por isso que a regra pode ser "nenhum outro"
 * em vez de uma lista de proibidos que alguém precisa manter.
 */
export const MIGRATOR_PLATFORM_PREFIX = 'MAIA_';

/**
 * O PISO: sem isto o job não é um job, é um processo que sai 0 sem migrar.
 * `scripts/migrate.ts` monta o `pg.Pool` com `config.DATABASE_URL`.
 */
export const MIGRATOR_FLOOR: readonly string[] = Object.freeze(['DATABASE_URL']);

/** Prefixos Maia que denunciam domínio de aplicação — derivados, não escritos. */
function applicationPrefixes(): readonly string[] {
  return MAIA_KEY_PREFIXES.filter((p) => p !== MIGRATOR_PLATFORM_PREFIX);
}

/**
 * Toda violação da invariante, para o subset informado.
 *
 * Sem argumento mede o CONTRATO REAL — é essa a chamada que o guard de CI e
 * o boot fazem. O parâmetro existe para o canário do próprio guard (provar
 * que ele acusa uma chave de aplicação fabricada), nunca para reconstruir o
 * subset a partir de uma cópia dele.
 */
export function migratorSubsetViolations(
  entries: readonly EnvVarSpec[] = entriesForService('migrator'),
): readonly ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const domains = new Set<ConfigGroup>(MIGRATOR_DOMAINS);
  const foreignPrefixes = applicationPrefixes();

  for (const spec of entries) {
    if (!domains.has(spec.group)) {
      problems.push({
        severity: 'error',
        variable: spec.name,
        rule: 'migrator/domain-foreign',
        message:
          `${spec.name} pertence ao domínio "${spec.group}", que é de aplicação — ` +
          `o subset \`migrator\` só carrega ${MIGRATOR_DOMAINS.join(' e ')}.`,
        remediation:
          `Remova 'migrator' de \`services\` em ${spec.name} (src/config/contract.ts). ` +
          'Um job que só aplica DDL não tem motivo para carregar configuração de aplicação — ' +
          'ver docs/runbooks/migrations.md.',
      });
    }

    const foreign = foreignPrefixes.find((p) => spec.name.startsWith(p));
    if (foreign !== undefined) {
      problems.push({
        severity: 'error',
        variable: spec.name,
        rule: 'migrator/namespace-foreign',
        message:
          `${spec.name} está no namespace "${foreign}", que nomeia um domínio de aplicação — ` +
          `o migrator só carrega "${MIGRATOR_PLATFORM_PREFIX}" entre os namespaces da Maia.`,
        remediation: `Remova 'migrator' de \`services\` em ${spec.name} (src/config/contract.ts).`,
      });
    }

    if (spec.secret && spec.group !== 'database') {
      problems.push({
        severity: 'error',
        variable: spec.name,
        rule: 'migrator/secret-not-database',
        message:
          `${spec.name} é um SEGREDO do domínio "${spec.group}" — o migrator só pode ` +
          'carregar credencial de banco.',
        remediation:
          `Remova 'migrator' de \`services\` em ${spec.name} (src/config/contract.ts). ` +
          'Um container de migration que vaze não pode vazar o que nunca recebeu.',
      });
    }
  }

  for (const required of MIGRATOR_FLOOR) {
    const spec = entries.find((s) => s.name === required);
    if (spec === undefined) {
      problems.push({
        severity: 'error',
        variable: required,
        rule: 'migrator/floor-missing',
        message:
          `${required} saiu do subset \`migrator\` — o processo de migration a LÊ ` +
          '(scripts/migrate.ts monta o pg.Pool com ela) e sem ela não migra nada.',
        remediation: `Declare 'migrator' em \`services\` de ${required} (src/config/contract.ts).`,
      });
      continue;
    }
    const optionalIn = MAIA_PROFILES.filter((p) => !(spec.requiredIn ?? []).includes(p));
    if (optionalIn.length > 0) {
      problems.push({
        severity: 'error',
        variable: required,
        rule: 'migrator/floor-optional',
        message:
          `${required} não é obrigatória no(s) profile(s) ${optionalIn.join(', ')} — ` +
          'o migrator falharia ABERTO, tentando migrar sem DSN em vez de recusar o boot.',
        remediation: `Declare \`requiredIn\` com os três profiles em ${required}.`,
      });
    }
  }

  return problems;
}

/**
 * Erro do CONTRATO, não do ambiente.
 *
 * Separado de `ConfigValidationError` (`src/config/load.ts`) de propósito: o
 * operador não conserta isto editando um `.env` — a correção é no
 * `src/config/contract.ts` desta build. A mensagem é feita só de NOME de
 * variável, grupo e regra; nenhum valor a atravessa, o que é o que permite a
 * `scripts/migrate.ts` imprimi-la inteira.
 */
export class MigratorSubsetError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    const body = problems
      .map(
        (p) =>
          `  - ${p.variable ?? '<contrato>'} [${p.rule}]: ${p.message}\n      → ${p.remediation}`,
      )
      .join('\n');
    super(
      'O subset `migrator` do contrato carrega configuração que um job de DDL não deve ter:\n' +
        body,
    );
    this.name = 'MigratorSubsetError';
    this.problems = problems;
  }
}

/** Fail-closed. Chamada por `loadMigrationConfig()` no boot do migrator. */
export function assertMigratorSubsetMinimal(
  entries: readonly EnvVarSpec[] = entriesForService('migrator'),
): void {
  const problems = migratorSubsetViolations(entries);
  if (problems.length > 0) throw new MigratorSubsetError(problems);
}
