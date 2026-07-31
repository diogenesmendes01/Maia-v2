/**
 * Issue #513 §5/§9 — o registro de crons é FILTRADO PELO PAPEL do processo.
 *
 * ── O bug que esta suíte trava ─────────────────────────────────────────
 *
 * A #512 entregou o contrato de papéis e a #518 entregou a ponte durável
 * Admin→runtime do pareamento. Cada uma está correta isolada, e juntas tinham
 * um buraco que só aparecia quando a topologia era DE FATO separada:
 *
 * `channel_pairing` é um job de CRON, mas todo efeito dele atravessa o Map de
 * sessões Baileys em memória de `src/gateway/line-sessions.ts`. Com
 * `MAIA_PROCESS_ROLE=scheduler` ele rodava num processo onde esse Map está
 * VAZIO. Consequências, todas silenciosas:
 *
 *   1. a posse de sessão nunca era publicada (o heartbeat lia uma lista
 *      vazia), então `target_instance` ficava NULL;
 *   2. um `stop_line` ENDEREÇADO era então reivindicado pelo scheduler, que
 *      chamava `stopLineSession()` no Map vazio e CONFIRMAVA o comando — o
 *      operador via "desabilitada" e a linha seguia respondendo pelo
 *      session-owner. É exatamente o P1 que a rodada 2 do PR #528 fechou,
 *      ressuscitado pela topologia;
 *   3. `promoteReadyVerifiedLines()` tentava ABRIR sockets Baileys no
 *      scheduler, violando o critério de aceite "Scheduler não abre sockets".
 *
 * O gate é declarativo dos dois lados: cada job nomeia seu GRUPO, cada papel
 * nomeia os grupos que roda, e `jobsForRole` cruza os dois. Fail-closed — um
 * job sem grupo declarado vai para `maintenance`, onde não há socket para ele
 * estragar.
 *
 * O grupo é deliberadamente SEPARADO de `owns`: o `session-owner` POSSUI
 * `cron_scheduler` (precisa da maquinaria para a ponte de pareamento), mas não
 * é responsável pela manutenção. Derivar o grupo de `owns` faria cada sweeper
 * rodar N+1 vezes num deploy separado — uma no scheduler e uma em cada
 * session-owner.
 */
import { describe, it, expect } from 'vitest';
import { JOBS, jobsForRole, jobGroup } from '../../../src/workers/index.js';
import {
  PROCESS_ROLES,
  JOB_GROUPS,
  roleRunsJobGroup,
} from '../../../src/runtime/lifecycle/roles.js';

/** Jobs cujo efeito atravessa o socket Baileys, direta ou indiretamente. */
const SESSION_BOUND = [
  'channel_pairing',
  'outbox_drain',
  'idempotency_outbox_relayer',
  'pending_reminder',
  'synthetic_probe',
  'briefing_morning',
  'briefing_evening',
  'briefing_weekly',
];

const names = (jobs: { name: string }[]): string[] => jobs.map((j) => j.name);

describe('classificação dos jobs por grupo de topologia', () => {
  it('todo job declara um grupo CONHECIDO', () => {
    for (const job of JOBS) {
      expect(JOB_GROUPS, job.name).toContain(jobGroup(job));
    }
  });

  it('só existem duas classes hoje: manutenção pura e ligado ao socket', () => {
    const distinct = new Set(JOBS.map(jobGroup));
    expect([...distinct].sort()).toEqual(['maintenance', 'session']);
  });

  it('todo job que toca o socket está marcado como tal', () => {
    for (const name of SESSION_BOUND) {
      const job = JOBS.find((j) => j.name === name);
      expect(job, `job ${name} sumiu do registro`).toBeDefined();
      expect(jobGroup(job!), name).toBe('session');
    }
  });

  it('nenhum OUTRO job foi marcado como ligado ao socket sem estar nesta lista', () => {
    // Guarda contra a marcação por reflexo: colocalizar um cron com o socket
    // custa escalabilidade, então cada adição tem que ser deliberada.
    const marked = JOBS.filter((j) => jobGroup(j) === 'session').map(
      (j) => j.name,
    );
    expect(marked.sort()).toEqual([...SESSION_BOUND].sort());
  });

  it('nomes de job são únicos (o guard de overlap indexa por nome)', () => {
    const seen = new Set(JOBS.map((j) => j.name));
    expect(seen.size).toBe(JOBS.length);
  });
});

describe('jobsForRole — inventário explícito por papel', () => {
  it('scheduler NÃO recebe nenhum job que precise do socket WhatsApp', () => {
    const { scheduled } = jobsForRole('scheduler', 1);
    for (const job of scheduled) {
      expect(jobGroup(job), job.name).toBe('maintenance');
    }
    // O caso concreto que motivou a issue.
    expect(names(scheduled)).not.toContain('channel_pairing');
  });

  it('session-owner recebe a ponte de pareamento — sem ela ninguém o comanda', () => {
    const { scheduled } = jobsForRole('session-owner', 1);
    expect(names(scheduled)).toContain('channel_pairing');
  });

  it('session-owner NÃO recebe os crons de manutenção pura', () => {
    const { scheduled } = jobsForRole('session-owner', 1);
    for (const job of scheduled) {
      expect(jobGroup(job), job.name).toBe('session');
    }
    expect(names(scheduled)).not.toContain('nightly_backup');
    expect(names(scheduled)).not.toContain('trace_matview_refresh');
  });

  it('scheduler + session-owner cobrem, juntos, exatamente o que `all` roda', () => {
    // Nenhum job pode CAIR NO VÃO da separação: um job que nenhum papel roda
    // é uma funcionalidade desligada em silêncio pelo deploy.
    const all = names(jobsForRole('all', 1).scheduled).sort();
    const split = [
      ...names(jobsForRole('scheduler', 1).scheduled),
      ...names(jobsForRole('session-owner', 1).scheduled),
    ].sort();
    expect(split).toEqual(all);
  });

  it('a união dos papéis cobre o registro INTEIRO em qualquer fase', () => {
    for (const phase of [1, 2, 3, 4, 5]) {
      const all = names(jobsForRole('all', phase).scheduled).sort();
      const split = [
        ...names(jobsForRole('scheduler', phase).scheduled),
        ...names(jobsForRole('session-owner', phase).scheduled),
      ].sort();
      expect(split, `fase ${phase}`).toEqual(all);
    }
  });

  it('api e worker não agendam cron algum — não declaram grupo nenhum', () => {
    expect(jobsForRole('api', 1).scheduled).toEqual([]);
    expect(jobsForRole('worker', 1).scheduled).toEqual([]);
  });

  it('`all` continua rodando tudo: o modo de compatibilidade da #512 é intacto', () => {
    const { scheduled, skipped } = jobsForRole('all', 1);
    expect(scheduled.length).toBe(JOBS.filter((j) => j.phase <= 1).length);
    // Em `all` nada é pulado POR PAPEL — só por fase.
    expect(skipped.filter((s) => s.reason === 'role')).toEqual([]);
  });

  it('o inventário reporta o motivo de cada job pulado (fase vs papel)', () => {
    const { scheduled, skipped } = jobsForRole('scheduler', 1);
    // Toda entrada do registro aparece exatamente uma vez, agendada ou pulada
    // com motivo — é isso que torna o log de boot uma resposta completa a
    // "este processo está rodando o quê?".
    expect(scheduled.length + skipped.length).toBe(JOBS.length);
    for (const s of skipped) {
      if (s.reason === 'phase') expect(s.job.phase).toBeGreaterThan(1);
      else expect(roleRunsJobGroup('scheduler', jobGroup(s.job))).toBe(false);
    }
  });

  it('fail-closed: nenhum papel agenda um job de um grupo que ele não roda', () => {
    for (const role of PROCESS_ROLES) {
      for (const job of jobsForRole(role, 5).scheduled) {
        expect(roleRunsJobGroup(role, jobGroup(job)), `${role}/${job.name}`).toBe(true);
      }
    }
  });
});
