/**
 * Least privilege por process role — issue #513 §10.
 *
 * ─── O que a issue pede, e por que uma tabela em markdown não serve ───────
 *
 * A #513 lista o problema entre os impactos: "todos os processos recebem mais
 * secrets do que precisam". Hoje isso é literal — `docker-compose.yml` injeta
 * o `.env` INTEIRO no serviço `app`, e mesmo o `compose.prod.yml`, que já dá
 * um env file por SERVIÇO, entrega a mesma `.env.app` para um processo que só
 * serve HTTP e para um que abre socket WhatsApp e chama LLM. Um processo `api`
 * carrega `ANTHROPIC_API_KEY` e o caminho do auth state do Baileys sem ter uso
 * para nenhum dos dois.
 *
 * §10 dá os exemplos: a API não recebe credencial Baileys nem provider LLM; o
 * session owner não recebe chave de LLM; o agent worker não recebe auth state
 * do WhatsApp; o scheduler recebe somente o necessário AOS JOBS QUE RODA.
 *
 * Este módulo é a forma executável dessas frases. Ele NÃO filtra
 * `process.env` em runtime (isso quebraria o modo `all`, que ainda é o único
 * deployment real): ele é a FONTE do subset de cada role — o que o operador
 * põe em cada env file, o que o `compose.prod.yml` injeta, e o que
 * `tests/unit/runtime/lifecycle/role-config.spec.ts` verifica contra o
 * contrato de configuração (#515). Quando um secret novo entra no contrato sem
 * dono, o teste reprova; quando alguém dá LLM para o session owner, o teste
 * reprova.
 *
 * ─── Por que o recorte é por GRUPO do contrato, e não por variável ────────
 *
 * O contrato tem ~200 variáveis. Uma lista nominal por role seria uma quarta
 * cópia da mesma informação, e envelheceria na primeira variável nova. Os
 * grupos do contrato (`ConfigGroup`) já são o recorte por DOMÍNIO — `llm`,
 * `whatsapp`, `backup`, `speech` —, que é exatamente a granularidade em que a
 * pergunta "este processo precisa disso?" tem resposta. Variável nova herda o
 * dono do seu grupo, e mudar o dono é uma decisão de uma linha.
 *
 * PUREZA: só tipos, constantes e funções puras. Nada de `process.env`.
 */
import type { ConfigGroup } from '@/config/metadata.js';
import type { JobGroup } from '@/workers/job-contract.js';
import { PROCESS_ROLES, type ProcessRole } from '@/runtime/lifecycle/roles.js';

/**
 * O que TODO processo Maia lê, seja qual for o papel.
 *
 * O critério é estrito: entra aqui o que o processo usa antes de saber o que
 * vai fazer (identidade do profile, conexão com os datastores, ciclo de vida)
 * ou o que ele usa em qualquer caminho (flags, limites de governança, o canal
 * por onde um `safeFailure` grita, o trace da decisão). Nada aqui carrega
 * credencial de provider externo.
 */
export const COMMON_CONFIG_GROUPS: readonly ConfigGroup[] = [
  'core',
  'database',
  'redis',
  'lifecycle',
  'performance',
  'feature-flags',
  'governance',
  'alerts',
  'runtime-trace',
];

/**
 * Grupos de configuração que cada GRUPO DE JOBS do scheduler exige.
 *
 * É isto que torna "o scheduler recebe somente os secrets necessários aos
 * jobs" (§10) uma conta e não uma intenção: o subset do scheduler é derivado
 * de `MAIA_SCHEDULER_GROUPS`. Com o conjunto default, ele NÃO precisa de chave
 * de LLM, de Whisper nem de embeddings — essas só entram quando alguém liga
 * `cognition`, `console` ou `proactive`.
 */
export const JOB_GROUP_CONFIG: Readonly<Record<JobGroup, readonly ConfigGroup[]>> = {
  // `pending_reminder` e o tick de workflows NOTIFICAM por WhatsApp; enquanto
  // o outbound durável (#513 §7) não for o único caminho de saída, o scheduler
  // precisa do transporte. É a maior peça que sobra do least privilege dele.
  'turn-pipeline': ['outbox', 'whatsapp', 'routing'],
  outbound: ['outbox', 'whatsapp', 'routing'],
  scheduling: ['outbox', 'whatsapp', 'routing'],
  // O `synthetic_probe` fala pelo canal de sonda. O juiz por LLM (§1) é
  // opcional (`MAIA_PROBE_LLM_JUDGE`) e, quando ligado, exige também o grupo
  // `llm` — o único ponto do conjunto default onde isso acontece.
  channel: ['probe', 'whatsapp', 'routing'],
  monitoring: ['cost'],
  housekeeping: ['onboarding'],
  'ops-backup': ['backup'],
  console: ['llm', 'speech', 'embeddings', 'procedures'],
  cognition: ['llm', 'embeddings', 'procedures'],
  procedures: ['procedures'],
  proactive: ['llm', 'whatsapp', 'routing'],
  governance: ['tool-requests', 'llm', 'whatsapp', 'routing'],
};

/**
 * Grupos que cada role lê ALÉM dos comuns — para o scheduler, ver
 * `configGroupsForRole`, que soma os grupos de jobs habilitados.
 */
const ROLE_EXTRA_CONFIG_GROUPS: Readonly<Record<ProcessRole, readonly ConfigGroup[]>> = {
  // Compat de processo único: faz tudo, então lê tudo. É o modo que existe
  // hoje, e o alvo de rollback declarado da issue.
  all: [
    'llm',
    'speech',
    'embeddings',
    'whatsapp',
    'owner',
    'onboarding',
    'routing',
    'backup',
    'cost',
    'probe',
    'outbox',
    'procedures',
    'setup',
    'tool-requests',
  ],
  // §10, primeira frase: "API não recebe credencial Baileys nem provider LLM
  // se não precisar". Ela não precisa — no alvo da issue, o pareamento pedido
  // pela API vira COMANDO DURÁVEL para o session owner (§2), e o turno vira
  // job na fila. O que sobra é o token de bootstrap do `/setup` e a identidade
  // do dono, que a superfície administrativa exibe.
  api: ['setup', 'owner'],
  // "Agent worker não recebe auth state do WhatsApp": a resposta dele é
  // COMMIT, não send (§4/§7). Em compensação é o único que precisa do
  // caminho cognitivo inteiro.
  worker: ['llm', 'speech', 'embeddings', 'owner', 'onboarding', 'outbox', 'procedures', 'cost'],
  // O scheduler não tem extra fixo: o subset dele é função dos GRUPOS DE JOBS
  // habilitados (ver `configGroupsForRole`).
  scheduler: [],
  // "Session owner não recebe chaves LLM": ele normaliza, persiste e envia —
  // não pensa (§3). Recebe `setup` porque é ele quem escreve o auth state
  // durante o pareamento.
  'session-owner': ['whatsapp', 'routing', 'owner', 'setup', 'probe', 'outbox'],
};

/**
 * Os grupos de configuração que um processo neste papel tem direito de ler.
 *
 * @param schedulerJobGroups grupos de jobs que ESTE scheduler roda. Ignorado
 *        para os demais papéis. Omitido, o scheduler é tratado como se
 *        rodasse apenas os grupos passados — quem quiser o pior caso passa
 *        todos.
 */
export function configGroupsForRole(
  role: ProcessRole,
  schedulerJobGroups: readonly JobGroup[] = [],
): readonly ConfigGroup[] {
  const out = new Set<ConfigGroup>(COMMON_CONFIG_GROUPS);
  for (const g of ROLE_EXTRA_CONFIG_GROUPS[role]) out.add(g);
  if (role === 'scheduler' || role === 'all') {
    for (const jg of schedulerJobGroups) {
      for (const g of JOB_GROUP_CONFIG[jg]) out.add(g);
    }
  }
  return [...out];
}

/** Um processo neste papel pode ler variáveis deste grupo? */
export function roleReadsConfigGroup(
  role: ProcessRole,
  group: ConfigGroup,
  schedulerJobGroups: readonly JobGroup[] = [],
): boolean {
  return configGroupsForRole(role, schedulerJobGroups).includes(group);
}

/**
 * Invariantes de least privilege que a issue #513 §10 nomeia, como DADO.
 *
 * Estão aqui, e não só no teste, porque são o contrato — o teste é quem os
 * executa contra o registro de configuração real. Cada linha é uma frase da
 * issue que passa a ser falsificável.
 */
export const LEAST_PRIVILEGE_INVARIANTS: readonly {
  readonly role: ProcessRole;
  readonly denies: ConfigGroup;
  readonly why: string;
}[] = [
  { role: 'api', denies: 'llm', why: 'a API não decide nada: ela enfileira (§2)' },
  {
    role: 'api',
    denies: 'whatsapp',
    why: 'o pareamento pedido pela API vira comando durável para o session owner (§2)',
  },
  { role: 'api', denies: 'speech', why: 'transcrição é caminho cognitivo, não de ingresso' },
  { role: 'api', denies: 'backup', why: 'backup é papel de scheduler/operação' },
  {
    role: 'session-owner',
    denies: 'llm',
    why: 'o session owner transporta; não executa cognition nem tools de negócio (§3)',
  },
  { role: 'session-owner', denies: 'speech', why: 'idem: transcrição é do agent worker' },
  { role: 'session-owner', denies: 'embeddings', why: 'idem' },
  {
    role: 'worker',
    denies: 'whatsapp',
    why: 'o agent worker não possui credencial Baileys e não envia por socket (§4)',
  },
  {
    role: 'worker',
    denies: 'setup',
    why: 'o token de bootstrap pertence à superfície que o serve, não a quem drena a fila',
  },
  { role: 'worker', denies: 'backup', why: 'backup é papel de scheduler/operação' },
];

/** Todo papel conhecido — reexportado para os geradores e o teste. */
export { PROCESS_ROLES };
