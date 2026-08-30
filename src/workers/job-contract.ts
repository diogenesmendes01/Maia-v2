/**
 * Contrato de concorrência do scheduler — issue #513 §9.
 *
 * ─── O problema que este arquivo resolve ──────────────────────────────────
 *
 * A issue #513 descreve o estado do baseline em uma frase: "alguns workers
 * possuem advisory lock ou row claiming, mas isso não é um contrato uniforme
 * para todos os jobs". Era verdade. `outbound_messages_sweeper` toma advisory
 * lock global; `scheduling_tick` confia no `FOR UPDATE SKIP LOCKED` dos repos;
 * `briefing_morning` não tem NADA e ENVIA MENSAGEM — duas réplicas de
 * scheduler mandariam dois bom-dia para o mesmo dono. A diferença entre os
 * três casos estava enterrada no cabeçalho de cada arquivo, em prosa, em
 * três idiomas de comentário diferentes. Um job novo nascia com a proteção
 * que o autor lembrasse de copiar.
 *
 * Este módulo transforma essa prosa em DADO obrigatório: todo job de
 * `src/workers/index.ts` declara o que faz (`effect`) e o que o protege
 * (`guard`). A regra que a issue exige — "jobs não idempotentes têm
 * single-flight/claim" — vira uma função que roda
 * (`validateJobRegistry`), e não uma tabela em markdown que envelhece.
 *
 * ─── Por que a validação é dado e não só tipo ─────────────────────────────
 *
 * O TypeScript já obriga o campo a existir: um job novo sem `effect`/`guard`
 * não COMPILA. O que o tipo não consegue exprimir é a relação entre os dois
 * campos ("side-effectful ⇒ guard != none") nem a coerência entre a
 * declaração e o código (`guard.lock` precisa aparecer no módulo do worker).
 * Essas duas são o trabalho de `validateJobRegistry`, exercitada por
 * `tests/unit/workers/job-contract.spec.ts`.
 *
 * PUREZA: este módulo é só tipos, constantes e funções puras. Ele NÃO importa
 * config, db, redis nem worker nenhum — é isso que permite que o teste de
 * arquitetura e o gerador de inventário o carreguem sem subir o mundo.
 */

// ---------------------------------------------------------------------------
// Grupos — o que substitui `phase: number` (issue #513 §5)
// ---------------------------------------------------------------------------

/**
 * Grupos operacionais explícitos.
 *
 * `phase: number` era um MECANISMO: `startWorkers(1)` — a única chamada em
 * produção, `src/index.ts` — descartava silenciosamente todo job com
 * `phase > 1`. O efeito colateral disso já mordeu o projeto três vezes, e as
 * três cicatrizes estão nos comentários de `src/workers/index.ts`: `mcp_sync`,
 * `channel_pairing` e `synthetic_probe` foram todos REBAIXADOS para phase 1
 * "de propósito", porque em phase 2 nunca rodavam e o console mostrava
 * operações pendentes para sempre. A fase deixou de significar "ordem de
 * rollout" e virou um booleano disfarçado de número.
 *
 * Um grupo diz o que o job FAZ e para quem, e a lista de grupos ativos é
 * configuração declarada (`MAIA_SCHEDULER_GROUPS`), impressa no boot. Um job
 * desligado passa a ser um fato visível, com nome, e não um `continue`.
 *
 * `phase` sobrevive como METADADO HISTÓRICO no registro (é o rastro de quando
 * cada job entrou), mas nada no runtime o lê.
 */
export const JOB_GROUPS = [
  /** Pipeline do turno: recuperação de inbound, debounce, pendências, workflows. */
  'turn-pipeline',
  /** Saída durável: outbox, sweeper do ledger, relayer de efeitos. */
  'outbound',
  /** Motor de agendamento (spec 18): tick, drain do outbox, backfill de séries. */
  'scheduling',
  /** Superfície de canal: pareamento de linha, ponte MCP, sonda sintética. */
  'channel',
  /** Vigilância do processo: saúde, auditoria, DLQ, custo, trace. */
  'monitoring',
  /** Faxina de dados: chaves de idempotência, inatividade, onboarding vencido. */
  'housekeeping',
  /** Operação externa: backup, retenção, drill de restore, TTL de export. */
  'ops-backup',
  /** Filas Postgres do console: playground e work loop de objetivos. */
  'console',
  /** Camada cognitiva em lote: sumarização, reflexão, padrões, memória. */
  'cognition',
  /** Ciclo de vida de procedimentos: reaper e matview de métricas. */
  'procedures',
  /** Iniciativa do agente para o usuário: briefings e drift. */
  'proactive',
  /** Governança assíncrona: escalada de gaps e triagem de pedidos de tool. */
  'governance',
] as const;
export type JobGroup = (typeof JOB_GROUPS)[number];

export type JobGroupSpec = {
  readonly group: JobGroup;
  /** Uma linha para o operador — aparece no inventário de boot e nos docs. */
  readonly description: string;
  /**
   * O grupo entra no conjunto default de `MAIA_SCHEDULER_GROUPS`?
   *
   * O default REPRODUZ EXATAMENTE o comportamento de `startWorkers(1)`: os
   * grupos ligados por default contêm só jobs que já rodavam (phase 1), e os
   * desligados só jobs que a fase já descartava. Trocar o mecanismo NÃO liga
   * nada novo — ligar é uma decisão de operação, tomada por env var, com o
   * grupo nomeado. Ver `docs/architecture/modules/workers.md`.
   */
  readonly defaultEnabled: boolean;
};

export const JOB_GROUP_SPECS: readonly JobGroupSpec[] = [
  {
    group: 'turn-pipeline',
    description: 'recuperação de inbound, fechamento de debounce, pendências e workflows',
    defaultEnabled: true,
  },
  {
    group: 'outbound',
    description: 'outbox durável, sweeper do ledger legado e relayer de efeitos',
    defaultEnabled: true,
  },
  {
    group: 'scheduling',
    description: 'motor de agendamento: tick, drain e backfill de séries',
    defaultEnabled: true,
  },
  {
    group: 'channel',
    description: 'pareamento de linha, ponte MCP e sonda sintética',
    defaultEnabled: true,
  },
  {
    group: 'monitoring',
    description: 'saúde, watcher de auditoria, DLQ, custo e runtime trace',
    defaultEnabled: true,
  },
  {
    group: 'housekeeping',
    description: 'faxina de idempotência, inatividade e onboarding vencido',
    defaultEnabled: true,
  },
  {
    group: 'ops-backup',
    description: 'backup noturno, retenção, drill de restore e TTL de export',
    defaultEnabled: true,
  },
  {
    group: 'console',
    description: 'filas Postgres do console (playground, work loop) — inertes desde sempre sob startWorkers(1)',
    defaultEnabled: false,
  },
  {
    group: 'cognition',
    description: 'lote cognitivo (sumarização, reflexão, padrões, memória, confiança)',
    defaultEnabled: false,
  },
  {
    group: 'procedures',
    description: 'reaper de execuções e refresh da matview de métricas',
    defaultEnabled: false,
  },
  {
    group: 'proactive',
    description: 'briefings e drift monitor — ESCREVEM PARA O USUÁRIO',
    defaultEnabled: false,
  },
  {
    group: 'governance',
    description: 'escalada de gaps e triagem de pedidos de ferramenta',
    defaultEnabled: false,
  },
];

/** Grupos ligados quando `MAIA_SCHEDULER_GROUPS` não é declarada. */
export const DEFAULT_JOB_GROUPS: readonly JobGroup[] = JOB_GROUP_SPECS.filter(
  (g) => g.defaultEnabled,
).map((g) => g.group);

export function getJobGroupSpec(group: JobGroup): JobGroupSpec {
  const spec = JOB_GROUP_SPECS.find((g) => g.group === group);
  // Fail-closed: um grupo sem spec é erro de programação, nunca um default
  // permissivo que ligaria um job silenciosamente.
  if (!spec) throw new Error(`unknown scheduler job group: ${String(group)}`);
  return spec;
}

/**
 * Resolve a lista declarada em `MAIA_SCHEDULER_GROUPS`.
 *
 * `all` liga TODOS os grupos (inclusive os default-off) — é o atalho honesto
 * para "quero o inventário inteiro", e é explícito. Nome desconhecido é ERRO,
 * não aviso: um typo em `MAIA_SCHEDULER_GROUPS=cognitin` que virasse "grupo
 * ignorado" desligaria um grupo inteiro em silêncio, que é exatamente o
 * defeito que esta fatia veio corrigir.
 */
export function parseJobGroups(raw: string | undefined | null): readonly JobGroup[] {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_JOB_GROUPS;
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (wanted.length === 1 && wanted[0] === 'all') return JOB_GROUPS;
  const unknown = wanted.filter((w) => !JOB_GROUPS.includes(w as JobGroup));
  if (unknown.length > 0) {
    throw new Error(
      `invalid scheduler job group(s): ${unknown.join(', ')} — expected one of: ${JOB_GROUPS.join(', ')} (or "all")`,
    );
  }
  // Dedup preservando a ordem canônica dos grupos, para que o inventário de
  // boot saia sempre na mesma ordem independente de como o operador escreveu.
  return JOB_GROUPS.filter((g) => wanted.includes(g));
}

// ---------------------------------------------------------------------------
// Classificação — issue #513 §9
// ---------------------------------------------------------------------------

/**
 * O que o job FAZ, do ponto de vista de duas réplicas rodando o mesmo tick.
 *
 * A taxonomia da issue tem seis nomes; eles não são um enum só, porque três
 * deles descrevem o EFEITO ("read-only", "idempotente", "side-effectful") e
 * três descrevem o MECANISMO que torna a concorrência segura ("row-claimed",
 * "global singleton", "per-tenant singleton"). Misturar os dois num único
 * campo produz declarações que não podem ser verificadas: "row-claimed" não
 * diz se o efeito é reversível, e "side-effectful" não diz o que o protege.
 * Separados, a regra da issue vira uma implicação checável entre os campos.
 */
export type JobEffect =
  /**
   * Nenhuma escrita em estado mutável compartilhado. Escrita append-only de
   * OBSERVAÇÃO (uma linha de histórico, um alerta) conta como read-only para
   * fins de concorrência: duas réplicas produzem duas observações, o que é
   * ruído, não corrupção.
   */
  | 'read-only'
  /**
   * Escreve, mas reexecutar converge: upsert, `ON CONFLICT DO NOTHING`,
   * `jobId` determinístico, compare-and-swap sobre o próprio estado.
   */
  | 'idempotent'
  /**
   * Efeito NÃO idempotente — tipicamente externo (mensagem no WhatsApp, issue
   * no GitHub, `pg_dump`, arquivo apagado). Executar duas vezes é um defeito
   * VISÍVEL para alguém de fora. A issue #513 exige que estes tenham
   * single-flight ou row claim; `validateJobRegistry` recusa o contrário.
   */
  | 'side-effectful';

/**
 * O que impede duas réplicas de fazerem o mesmo trabalho.
 *
 * `none` é uma declaração legítima — e por isso EXIGE `why`. Um job read-only
 * ou idempotente não precisa de lock, mas precisa dizer POR QUE não precisa,
 * no lugar onde a próxima pessoa vai procurar.
 */
export type JobGuard =
  | {
      readonly kind: 'none';
      /** Por que duas réplicas concorrentes são inofensivas neste job. */
      readonly why: string;
    }
  | {
      readonly kind: 'row-claim';
      /**
       * Como a linha é reivindicada — `FOR UPDATE SKIP LOCKED`, CAS de lease,
       * índice único. Texto livre curto: é o que o operador lê no runbook.
       */
      readonly claim: string;
      /** Tabela(s) reivindicadas. Vira o namespace lógico do claim. */
      readonly tables: readonly string[];
    }
  | {
      readonly kind: 'global-singleton';
      /**
       * Namespace do advisory lock. É uma STRING que precisa aparecer
       * literalmente no módulo do worker — é isso que o teste de arquitetura
       * confere, e é o que impede uma declaração de single-flight que não
       * existe no código.
       */
      readonly lock: string;
    }
  | {
      readonly kind: 'per-tenant-singleton';
      /** Namespace do advisory lock por (tenant, agent). Mesmo contrato. */
      readonly lock: string;
    };

/** Nome canônico da classificação da issue #513 §9, derivado dos dois campos. */
export function classifyJob(effect: JobEffect, guard: JobGuard): string {
  switch (guard.kind) {
    case 'row-claim':
      return 'row-claimed';
    case 'global-singleton':
      return 'global singleton';
    case 'per-tenant-singleton':
      return 'per-tenant singleton';
    case 'none':
      return effect === 'read-only' ? 'read-only' : 'idempotente';
  }
}

/**
 * Lacuna DECLARADA: job com efeito não idempotente que ainda não tem
 * single-flight nem claim.
 *
 * Por que isto existe em vez de simplesmente reprovar: o baseline TEM essas
 * lacunas — `pending_expirer` cancela uma aprovação e MANDA WhatsApp sem
 * nenhum claim, e roda de minuto em minuto hoje. Um contrato que reprovasse
 * tudo no primeiro commit seria desligado no segundo. Um contrato que as
 * ignorasse seria decoração.
 *
 * O desenho é uma CATRACA: a lacuna é typed, nomeada, aponta para a issue que
 * a rastreia, é IMPRESSA NO BOOT quando o job está habilitado, e o conjunto
 * de jobs que a carregam está CONGELADO no teste de arquitetura. Um job novo
 * não entra nesse conjunto — para ele, "não idempotente sem guard" é
 * reprovação, e é essa a regra da issue #513 §9 para tudo que nasce daqui em
 * diante.
 */
export type UnguardedGap = {
  /** Issue que rastreia o fechamento (ex.: `#513`). */
  readonly tracked_in: string;
  /** O que DUPLICA quando duas réplicas rodam o mesmo tick. Sem eufemismo. */
  readonly duplicates: string;
};

/** A parte do registro de jobs que este contrato governa. */
export type JobContract = {
  readonly name: string;
  readonly cron: string;
  readonly group: JobGroup;
  readonly effect: JobEffect;
  readonly guard: JobGuard;
  /**
   * Módulo que implementa o job, relativo a `src/workers/` (ex.:
   * `reflection-batch.ts`). É o que liga a declaração ao código: o teste de
   * arquitetura abre este arquivo e confere que o namespace de lock declarado
   * existe nele.
   */
  readonly module: string;
  /**
   * Presente SOMENTE quando `effect === 'side-effectful'` e `guard.kind ===
   * 'none'`. Ver `UnguardedGap`.
   */
  readonly unguarded?: UnguardedGap;
  /**
   * Metadado HISTÓRICO. Era o mecanismo operacional (`startWorkers(phase)`);
   * hoje nada no runtime o lê — quem decide o que sobe é `group`. Mantido
   * porque é o rastro de em que rollout cada job entrou.
   */
  readonly phase?: number;
};

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

export type JobContractViolation = {
  readonly job: string;
  readonly rule: string;
  readonly detail: string;
};

/**
 * Regras que o registro inteiro tem que satisfazer.
 *
 * Cada uma existe por um defeito concreto que ela impede:
 *
 *  - `unique-name`: dois jobs com o mesmo nome compartilhariam o guard de
 *    overlap de `runTick` (um Map por nome) e um esconderia o outro.
 *  - `non-idempotent-needs-guard`: É A REGRA DA ISSUE. Efeito externo não
 *    idempotente sem claim/lock duplica com duas réplicas.
 *  - `guard-none-needs-why`: um `none` sem justificativa é indistinguível de
 *    um esquecimento.
 *  - `lock-namespace-unique`: dois jobs de cron no MESMO lock global serializam
 *    entre si sem que ninguém tenha decidido isso — um backup segurando o
 *    varredor de privacidade é um incidente, não um projeto.
 *  - `read-only-has-no-lock`: um job declarado read-only que toma lock está
 *    mentindo em um dos dois campos.
 *  - `known-group`: grupo fora da lista não teria spec e não apareceria no
 *    inventário de boot.
 */
export function validateJobRegistry(jobs: readonly JobContract[]): JobContractViolation[] {
  const violations: JobContractViolation[] = [];
  const seenNames = new Set<string>();
  const seenLocks = new Map<string, string>();

  for (const job of jobs) {
    if (seenNames.has(job.name)) {
      violations.push({
        job: job.name,
        rule: 'unique-name',
        detail: 'outro job já registrou este nome',
      });
    }
    seenNames.add(job.name);

    if (!JOB_GROUPS.includes(job.group)) {
      violations.push({
        job: job.name,
        rule: 'known-group',
        detail: `grupo "${String(job.group)}" não está em JOB_GROUPS`,
      });
    }

    if (job.module.trim() === '' || !job.module.endsWith('.ts')) {
      violations.push({
        job: job.name,
        rule: 'module-declared',
        detail: `module deve apontar para um arquivo .ts sob src/workers/ (recebido: "${job.module}")`,
      });
    }

    if (job.effect === 'side-effectful' && job.guard.kind === 'none') {
      if (job.unguarded === undefined) {
        violations.push({
          job: job.name,
          rule: 'non-idempotent-needs-guard',
          detail:
            'job com efeito externo não idempotente precisa de row-claim, global-singleton ou per-tenant-singleton (issue #513 §9) — ou de uma lacuna DECLARADA em `unguarded`, e o conjunto de jobs que a carregam está congelado no teste de arquitetura',
        });
      } else if (
        job.unguarded.tracked_in.trim() === '' ||
        job.unguarded.duplicates.trim() === ''
      ) {
        violations.push({
          job: job.name,
          rule: 'unguarded-gap-is-specific',
          detail: 'lacuna declarada exige `tracked_in` (issue) e `duplicates` (o que duplica)',
        });
      }
    }

    if (job.unguarded !== undefined && !(job.effect === 'side-effectful' && job.guard.kind === 'none')) {
      violations.push({
        job: job.name,
        rule: 'unguarded-gap-only-when-unguarded',
        detail:
          'só um job side-effectful SEM guard declara `unguarded`; com guard, a lacuna já está fechada e a declaração mente',
      });
    }

    // `why` responde "por que duas réplicas são inofensivas". Um job com
    // lacuna DECLARADA não tem essa resposta — ele tem a oposta, em
    // `unguarded.duplicates` —, então exigir as duas seria pedir que o autor
    // escrevesse a mesma coisa duas vezes com sinais trocados.
    if (job.unguarded === undefined && job.guard.kind === 'none' && job.guard.why.trim() === '') {
      violations.push({
        job: job.name,
        rule: 'guard-none-needs-why',
        detail: 'guard `none` exige `why`: por que duas réplicas são inofensivas',
      });
    }

    if (job.effect === 'read-only' && job.guard.kind !== 'none') {
      violations.push({
        job: job.name,
        rule: 'read-only-has-no-lock',
        detail: `job read-only não deveria precisar de guard "${job.guard.kind}" — um dos dois campos está errado`,
      });
    }

    if (job.guard.kind === 'global-singleton' || job.guard.kind === 'per-tenant-singleton') {
      const lock = job.guard.lock;
      if (lock.trim() === '') {
        violations.push({
          job: job.name,
          rule: 'lock-namespace-declared',
          detail: `guard ${job.guard.kind} exige um namespace de lock não vazio`,
        });
      } else {
        const owner = seenLocks.get(lock);
        if (owner !== undefined) {
          violations.push({
            job: job.name,
            rule: 'lock-namespace-unique',
            detail: `namespace "${lock}" já é usado por "${owner}" — dois jobs de cron no mesmo lock serializam entre si sem decisão explícita`,
          });
        }
        seenLocks.set(lock, job.name);
      }
    }

    if (job.guard.kind === 'row-claim' && job.guard.tables.length === 0) {
      violations.push({
        job: job.name,
        rule: 'row-claim-declares-tables',
        detail: 'guard row-claim exige as tabelas reivindicadas',
      });
    }
  }

  return violations;
}
