/**
 * Teste de ARQUITETURA do registro de schedulers — issue #513 §9.
 *
 * A issue pede que a classificação de concorrência de cada job deixe de ser
 * prosa no cabeçalho de cada arquivo e vire contrato uniforme e VERIFICÁVEL.
 * Este arquivo é a metade verificável. Ele reprova, entre outras coisas:
 *
 *   - job novo com efeito externo não idempotente e sem claim/lock;
 *   - job que DECLARA um advisory lock que não existe no módulo dele;
 *   - dois jobs de cron no mesmo namespace de lock (serialização acidental);
 *   - job cujo grupo não existe, ou cujo módulo não existe em disco;
 *   - a troca de `phase` por grupos ligando (ou desligando) algum job por
 *     acidente — o conjunto default tem que reproduzir `startWorkers(1)`
 *     EXATAMENTE.
 *
 * Nada aqui toca banco, Redis ou rede: o contrato (`job-contract.ts`) é puro,
 * e o registro é carregado uma vez por arquivo via `moduloDeProducao`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_JOB_GROUPS,
  JOB_GROUPS,
  JOB_GROUP_SPECS,
  classifyJob,
  parseJobGroups,
  validateJobRegistry,
  type JobContract,
} from '../../../src/workers/job-contract.js';
import { moduloDeProducao } from '../../helpers/modulo-de-producao.js';

const WORKERS_DIR = join(process.cwd(), 'src', 'workers');

const registro = moduloDeProducao(() => import('../../../src/workers/index.js'));

/**
 * Jobs que HOJE têm efeito não idempotente sem single-flight nem row claim.
 *
 * Esta lista é uma CATRACA, não uma permissão. Ela existe porque o baseline
 * chegou aqui com essas lacunas, e um contrato que reprovasse tudo no primeiro
 * commit seria desligado no segundo.
 *
 * O que o congelamento garante: um job NOVO não entra nesta lista sem alguém
 * editar este arquivo e explicar por quê. Para tudo que nasce daqui em diante,
 * "não idempotente sem guard" é reprovação.
 *
 * Quando uma lacuna for fechada (CAS no repo, advisory lock por tenant), o
 * nome SAI daqui e o teste passa a exigir que ele não volte. **A lista SÓ
 * ENCOLHE.**
 *
 * ─── De catorze para nove ────────────────────────────────────────────────────
 *
 * Cinco nomes saíram, e nenhum por reescrita de texto — em cada um o efeito
 * passou a ser reivindicado por linha:
 *
 *   `pending_expirer` e `workflow_engine_tick` — os dois compartilhavam
 *   `expireDueDualApprovals()`, que cancelava com `setStatus` incondicional e
 *   mandava WhatsApp. Essa era a lacuna que NÃO precisava de duas réplicas:
 *   dois jobs distintos no mesmo processo bastavam, e o solicitante recebia
 *   dois avisos. A #691 pôs um CAS (`workflowsRepo.expireIfDue`) e amarrou a
 *   auditoria e o envio a ele. Os outros ramos dos dois jobs — `expireDue` de
 *   `pending_questions` e de `approval_requests` — já eram CAS antes.
 *
 *   `briefing_morning`, `briefing_evening` e `briefing_weekly` — a #506 tirou
 *   o `sendText` direto e passou a comprometer cada aviso em `outbox_messages`
 *   com `dedup_key` por período/dia/pessoa, sobre o índice único parcial
 *   `idx_outbox_dedup`. Duas execuções colidem na chave; uma grava.
 *
 * O comentário anterior deste bloco citava o `pending_expirer` como o exemplo
 * da lacuna. Citava certo na época e passou a mentir depois da #691 — por isso
 * o exemplo saiu daqui: um texto que nomeia um caso concreto envelhece junto
 * com ele.
 */
const LACUNAS_CONGELADAS = [
  'conversation_summarizer',
  'pattern_detector',
  'legacy_memory_reclassifier',
  'procedure_candidate_consumer',
  'knowledge_state_promoter',
  'drift_monitor',
  'gap_escalation_monitor',
  'tool_request_issue_relayer',
  'tool_request_closure_monitor',
] as const;

describe('contrato de concorrência dos schedulers (#513 §9)', () => {
  it('todo job do registro satisfaz o contrato', () => {
    const violations = validateJobRegistry(registro().JOBS);
    // A mensagem tem que ser legível sozinha: quem quebrar isto vai ler o
    // diff de um job novo, não este arquivo.
    expect(
      violations.map((v) => `${v.job}: ${v.rule} — ${v.detail}`),
      'jobs fora do contrato de #513 §9',
    ).toEqual([]);
  });

  it('cada job aponta para um módulo que EXISTE em src/workers/', () => {
    const faltando = registro()
      .JOBS.filter((j: JobContract) => !existsSync(join(WORKERS_DIR, j.module)))
      .map((j: JobContract) => `${j.name} -> ${j.module}`);
    expect(faltando).toEqual([]);
  });

  /**
   * A regra mais forte do arquivo: uma declaração de single-flight que não
   * existe no código é PIOR que nenhuma declaração — ela produz confiança
   * falsa exatamente onde a issue quer garantia. Aqui a declaração é conferida
   * contra o texto do módulo que implementa o job.
   */
  it('todo lock declarado aparece literalmente no módulo do job', () => {
    const mentiras: string[] = [];
    for (const job of registro().JOBS as JobContract[]) {
      if (job.guard.kind !== 'global-singleton' && job.guard.kind !== 'per-tenant-singleton') {
        continue;
      }
      const fonte = readFileSync(join(WORKERS_DIR, job.module), 'utf8');
      if (!fonte.includes(job.guard.lock)) {
        mentiras.push(
          `${job.name} declara lock "${job.guard.lock}", que não aparece em src/workers/${job.module}`,
        );
      }
    }
    expect(mentiras).toEqual([]);
  });

  it('o conjunto de lacunas não-guardadas está congelado', () => {
    const atuais = (registro().JOBS as JobContract[])
      .filter((j) => j.unguarded !== undefined)
      .map((j) => j.name)
      .sort();
    expect(atuais).toEqual([...LACUNAS_CONGELADAS].sort());
  });

  it('toda lacuna aponta para a issue que a rastreia e diz o que duplica', () => {
    for (const job of registro().JOBS as JobContract[]) {
      if (!job.unguarded) continue;
      expect(job.unguarded.tracked_in, job.name).toMatch(/^#\d+$/);
      expect(job.unguarded.duplicates.length, job.name).toBeGreaterThan(40);
    }
  });

  it('nenhum namespace de lock é compartilhado por dois jobs de cron', () => {
    const porLock = new Map<string, string[]>();
    for (const job of registro().JOBS as JobContract[]) {
      if (job.guard.kind !== 'global-singleton' && job.guard.kind !== 'per-tenant-singleton') {
        continue;
      }
      porLock.set(job.guard.lock, [...(porLock.get(job.guard.lock) ?? []), job.name]);
    }
    const compartilhados = [...porLock.entries()].filter(([, jobs]) => jobs.length > 1);
    expect(compartilhados).toEqual([]);
  });

  it('nomes de job são únicos (o guard de overlap é indexado por nome)', () => {
    const nomes = (registro().JOBS as JobContract[]).map((j) => j.name);
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it('toda classificação da issue §9 é expressável e nenhuma sobra sem uso', () => {
    const usadas = new Set(
      (registro().JOBS as JobContract[]).map((j) => classifyJob(j.effect, j.guard)),
    );
    // As seis categorias da issue, menos `side-effectful` (que não é uma
    // classificação estável e sim a condição que exige guard): um registro que
    // deixasse de exercitar uma delas indicaria que a taxonomia virou
    // decoração.
    expect([...usadas].sort()).toEqual(
      ['global singleton', 'idempotente', 'per-tenant singleton', 'read-only', 'row-claimed'].sort(),
    );
  });
});

describe('grupos substituem phase sem mudar o que roda (#513 §5)', () => {
  it('o conjunto default reproduz EXATAMENTE o antigo startWorkers(1)', () => {
    // A prova de que a troca de mecanismo é uma refatoração e não um rollout:
    // job ligado por default <=> job que `phase <= 1` agendava.
    const divergentes = (registro().JOBS as JobContract[])
      .filter((j) => {
        const ligadoAgora = DEFAULT_JOB_GROUPS.includes(j.group);
        const ligadoAntes = (j.phase ?? 1) <= 1;
        return ligadoAgora !== ligadoAntes;
      })
      .map((j) => `${j.name} (grupo ${j.group}, phase ${String(j.phase)})`);
    expect(divergentes).toEqual([]);
  });

  it('todo grupo declarado tem spec e pelo menos um job', () => {
    const jobs = registro().JOBS as JobContract[];
    for (const g of JOB_GROUPS) {
      expect(JOB_GROUP_SPECS.some((s) => s.group === g), `spec de ${g}`).toBe(true);
      expect(jobs.filter((j) => j.group === g).length, `jobs em ${g}`).toBeGreaterThan(0);
    }
  });

  it('startWorkers agenda só os grupos pedidos e devolve o inventário', () => {
    const mod = registro();
    mod._resetWorkerStateForTests();
    try {
      const inv = mod.startWorkers({ groups: ['ops-backup'] });
      const esperados = (mod.JOBS as JobContract[])
        .filter((j) => j.group === 'ops-backup')
        .map((j) => j.name);
      expect(inv.scheduled).toEqual(esperados);
      expect(inv.groups_disabled).not.toContain('ops-backup');
      // Nenhum job de ops-backup é `unguarded` — todos estão sob OPS_LOCK_KEYS.
      expect(inv.unguarded_enabled).toEqual([]);
      expect(inv.skipped.length).toBe(mod.JOBS.length - esperados.length);
    } finally {
      mod._resetWorkerStateForTests();
    }
  });

  it('o inventário DENUNCIA os jobs habilitados sem guard', () => {
    const mod = registro();
    mod._resetWorkerStateForTests();
    try {
      const inv = mod.startWorkers({ groups: ['proactive'] });
      // Sobrou UM. Os três briefings saíram da lista porque a #506 passou a
      // comprometê-los em `outbox_messages` com `dedup_key` por
      // período/dia/pessoa: a colisão na chave é o claim deles. O
      // `drift_monitor` continua aplicando decisão de drift sem lock por
      // (tenant, agent), e é o único do grupo que o boot ainda precisa
      // denunciar.
      //
      // Este caso é o que impede a lista de encolher por descuido: se alguém
      // marcar um job como guardado sem guardá-lo de fato, o nome some daqui
      // e o teste fica vermelho pedindo explicação.
      expect(inv.unguarded_enabled.sort()).toEqual(['drift_monitor']);
    } finally {
      mod._resetWorkerStateForTests();
    }
  });
});

describe('parseJobGroups', () => {
  it('vazio/ausente devolve o conjunto default', () => {
    expect(parseJobGroups(undefined)).toEqual(DEFAULT_JOB_GROUPS);
    expect(parseJobGroups('')).toEqual(DEFAULT_JOB_GROUPS);
    expect(parseJobGroups('   ')).toEqual(DEFAULT_JOB_GROUPS);
  });

  it('`all` liga todos os grupos, inclusive os default-off', () => {
    expect(parseJobGroups('all')).toEqual(JOB_GROUPS);
  });

  it('normaliza para a ordem canônica e deduplica', () => {
    expect(parseJobGroups('outbound, turn-pipeline ,outbound')).toEqual([
      'turn-pipeline',
      'outbound',
    ]);
  });

  it('nome desconhecido é ERRO — nunca um grupo silenciosamente ignorado', () => {
    // Fail-closed (AGENTS.md §4.2): um typo que virasse "grupo ignorado"
    // desligaria um grupo inteiro em silêncio, que é o defeito que a #513
    // veio corrigir.
    expect(() => parseJobGroups('cognitin')).toThrow(/invalid scheduler job group/);
    expect(() => parseJobGroups('turn-pipeline,nope')).toThrow(/nope/);
  });
});

describe('validateJobRegistry — as regras, em isolamento', () => {
  const base: JobContract = {
    name: 'j',
    cron: '* * * * *',
    group: 'monitoring',
    effect: 'idempotent',
    guard: { kind: 'none', why: 'converge' },
    module: 'health-monitor.ts',
  };

  it('reprova efeito não idempotente sem guard e sem lacuna declarada', () => {
    const v = validateJobRegistry([{ ...base, effect: 'side-effectful' }]);
    expect(v.map((x) => x.rule)).toContain('non-idempotent-needs-guard');
  });

  it('aceita a mesma coisa quando a lacuna é DECLARADA', () => {
    const v = validateJobRegistry([
      {
        ...base,
        effect: 'side-effectful',
        guard: { kind: 'none', why: '' },
        unguarded: { tracked_in: '#513', duplicates: 'manda a mesma mensagem duas vezes' },
      },
    ]);
    expect(v).toEqual([]);
  });

  it('reprova lacuna declarada em job que JÁ tem guard (declaração mente)', () => {
    const v = validateJobRegistry([
      {
        ...base,
        effect: 'side-effectful',
        guard: { kind: 'global-singleton', lock: 'X' },
        unguarded: { tracked_in: '#513', duplicates: 'nada, na verdade' },
      },
    ]);
    expect(v.map((x) => x.rule)).toContain('unguarded-gap-only-when-unguarded');
  });

  it('reprova guard `none` sem justificativa', () => {
    const v = validateJobRegistry([{ ...base, guard: { kind: 'none', why: '' } }]);
    expect(v.map((x) => x.rule)).toContain('guard-none-needs-why');
  });

  it('reprova job read-only que toma lock', () => {
    const v = validateJobRegistry([
      { ...base, effect: 'read-only', guard: { kind: 'global-singleton', lock: 'X' } },
    ]);
    expect(v.map((x) => x.rule)).toContain('read-only-has-no-lock');
  });

  it('reprova dois jobs no mesmo namespace de lock', () => {
    const v = validateJobRegistry([
      { ...base, name: 'a', effect: 'side-effectful', guard: { kind: 'global-singleton', lock: 'L' } },
      { ...base, name: 'b', effect: 'side-effectful', guard: { kind: 'global-singleton', lock: 'L' } },
    ]);
    expect(v.map((x) => x.rule)).toContain('lock-namespace-unique');
  });

  it('reprova nome duplicado', () => {
    const v = validateJobRegistry([base, base]);
    expect(v.map((x) => x.rule)).toContain('unique-name');
  });

  it('reprova row-claim sem tabelas', () => {
    const v = validateJobRegistry([
      { ...base, effect: 'side-effectful', guard: { kind: 'row-claim', claim: 'CAS', tables: [] } },
    ]);
    expect(v.map((x) => x.rule)).toContain('row-claim-declares-tables');
  });

  it('reprova módulo não declarado', () => {
    const v = validateJobRegistry([{ ...base, module: '' }]);
    expect(v.map((x) => x.rule)).toContain('module-declared');
  });
});
