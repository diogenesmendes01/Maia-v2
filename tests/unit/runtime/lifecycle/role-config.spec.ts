/**
 * Least privilege por role, verificado contra o contrato de configuração —
 * issue #513 §10.
 *
 * As frases da issue ("API não recebe credencial Baileys nem provider LLM",
 * "session owner não recebe chaves LLM", "agent worker não recebe auth state
 * do WhatsApp") deixam de ser prosa e viram asserção sobre o conjunto de
 * variáveis que cada papel tem direito de ler.
 *
 * O teste também fecha as duas frestas por onde uma tabela de least privilege
 * apodrece: variável nova de runtime SEM DONO (ninguém a lê, ou todo mundo lê
 * "por via das dúvidas") e um grupo do contrato que some sem que o mapa saiba.
 */
import { describe, it, expect } from 'vitest';
import { ENV_CONTRACT } from '../../../../src/config/contract.js';
import { GROUP_ORDER, type ConfigGroup } from '../../../../src/config/metadata.js';
import { PROCESS_ROLES } from '../../../../src/runtime/lifecycle/roles.js';
import {
  COMMON_CONFIG_GROUPS,
  JOB_GROUP_CONFIG,
  LEAST_PRIVILEGE_INVARIANTS,
  configGroupsForRole,
  roleReadsConfigGroup,
} from '../../../../src/runtime/lifecycle/role-config.js';
import {
  DEFAULT_JOB_GROUPS,
  JOB_GROUPS,
} from '../../../../src/workers/job-contract.js';

/** Grupos que existem no contrato E têm ao menos uma variável do `runtime`. */
const RUNTIME_GROUPS: ConfigGroup[] = [
  ...new Set(
    Object.values(ENV_CONTRACT)
      .filter((v) => (v.services as readonly string[]).includes('runtime'))
      .map((v) => v.group),
  ),
];

function varsOfGroup(group: ConfigGroup): string[] {
  return Object.values(ENV_CONTRACT)
    .filter((v) => v.group === group && (v.services as readonly string[]).includes('runtime'))
    .map((v) => v.name);
}

describe('least privilege por process role (#513 §10)', () => {
  it('as invariantes nomeadas na issue são verdadeiras', () => {
    const quebradas = LEAST_PRIVILEGE_INVARIANTS.filter((inv) =>
      // Pior caso para o scheduler: todos os grupos de jobs ligados. Nenhuma
      // invariante da lista é sobre o scheduler hoje, mas se uma for
      // acrescentada ela precisa valer com o scheduler cheio, não só vazio.
      roleReadsConfigGroup(inv.role, inv.denies, JOB_GROUPS),
    ).map((inv) => `${inv.role} não deveria ler o grupo "${inv.denies}": ${inv.why}`);
    expect(quebradas).toEqual([]);
  });

  it('a API não enxerga nenhum secret de LLM nem o auth state do WhatsApp', () => {
    // A forma NOMINAL da invariante acima: se alguém re-homologar
    // ANTHROPIC_API_KEY para outro grupo, a asserção por grupo continuaria
    // verde e esta aqui não.
    const daApi = new Set(configGroupsForRole('api').flatMap(varsOfGroup));
    for (const proibida of [
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'OPENAI_API_KEY',
      'BAILEYS_AUTH_DIR',
    ]) {
      expect(daApi.has(proibida), `api não pode receber ${proibida}`).toBe(false);
    }
  });

  it('o session owner não enxerga chave de LLM', () => {
    const dele = new Set(configGroupsForRole('session-owner').flatMap(varsOfGroup));
    expect(dele.has('ANTHROPIC_API_KEY')).toBe(false);
    expect(dele.has('OPENROUTER_API_KEY')).toBe(false);
    // ... mas enxerga o transporte, senão não é session owner.
    expect(dele.has('BAILEYS_AUTH_DIR')).toBe(true);
  });

  it('o agent worker não enxerga o auth state do WhatsApp', () => {
    const dele = new Set(configGroupsForRole('worker').flatMap(varsOfGroup));
    expect(dele.has('BAILEYS_AUTH_DIR')).toBe(false);
    expect(dele.has('ANTHROPIC_API_KEY')).toBe(true);
  });

  /**
   * O ponto operacional de §10 aplicado ao scheduler: o subset dele é função
   * de `MAIA_SCHEDULER_GROUPS`. Com o conjunto default (o que reproduz
   * `startWorkers(1)`), ele NÃO precisa de chave de LLM.
   */
  it('o scheduler default não precisa de chave de LLM; ligar `cognition` muda isso', () => {
    const padrao = new Set(configGroupsForRole('scheduler', DEFAULT_JOB_GROUPS).flatMap(varsOfGroup));
    expect(padrao.has('ANTHROPIC_API_KEY')).toBe(false);

    const comCognicao = new Set(
      configGroupsForRole('scheduler', [...DEFAULT_JOB_GROUPS, 'cognition']).flatMap(varsOfGroup),
    );
    expect(comCognicao.has('ANTHROPIC_API_KEY')).toBe(true);
  });

  it('o scheduler default ainda precisa do transporte WhatsApp — e isso é o resto de trabalho, não um descuido', () => {
    // `pending_reminder`, o tick de workflows e o drain do outbox NOTIFICAM
    // direto. Enquanto o outbound durável (#513 §7) não for o único caminho de
    // saída, tirar `whatsapp` do scheduler não reduz privilégio: quebra o job.
    // Este teste existe para que a mudança seja DELIBERADA quando §7 fechar.
    const padrao = configGroupsForRole('scheduler', DEFAULT_JOB_GROUPS);
    expect(padrao).toContain('whatsapp');
  });

  it('todo grupo de jobs declara de quais grupos de config ele depende', () => {
    for (const jg of JOB_GROUPS) {
      expect(JOB_GROUP_CONFIG[jg], `JOB_GROUP_CONFIG["${jg}"]`).toBeDefined();
    }
  });

  it('nenhuma variável de runtime fica sem dono', () => {
    // Pior caso: um scheduler com todos os grupos de jobs. Se nem assim
    // alguém lê o grupo, ele é órfão — ou a variável não pertence ao runtime,
    // ou o mapa está desatualizado. As duas hipóteses merecem um humano.
    const cobertos = new Set<ConfigGroup>(
      PROCESS_ROLES.flatMap((r) => configGroupsForRole(r, JOB_GROUPS)),
    );
    const orfaos = RUNTIME_GROUPS.filter((g) => !cobertos.has(g));
    expect(orfaos).toEqual([]);
  });

  it('`all` é superset de todo papel — é o modo de rollback', () => {
    const todos = new Set(configGroupsForRole('all', JOB_GROUPS));
    for (const role of PROCESS_ROLES) {
      const faltando = configGroupsForRole(role, JOB_GROUPS).filter((g) => !todos.has(g));
      expect(faltando, `grupos que ${role} lê e \`all\` não`).toEqual([]);
    }
  });

  it('todo grupo citado no mapa existe no contrato', () => {
    const conhecidos = new Set(GROUP_ORDER.map((g) => g.group));
    const citados = new Set<ConfigGroup>([
      ...COMMON_CONFIG_GROUPS,
      ...PROCESS_ROLES.flatMap((r) => configGroupsForRole(r, JOB_GROUPS)),
      ...Object.values(JOB_GROUP_CONFIG).flat(),
    ]);
    const inventados = [...citados].filter((g) => !conhecidos.has(g));
    expect(inventados).toEqual([]);
  });
});
