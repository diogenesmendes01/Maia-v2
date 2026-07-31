/**
 * Issue #512 — process role contract (consumed by #513).
 *
 * The point of this suite is that the contract is DATA, checkable without
 * booting anything: which components a role starts (`owns`) and which ones
 * gate its readiness (`requires`). #513 splits the topology by reading these
 * two sets, so a silent drift here would let a worker-only process announce
 * readiness on a component it does not have.
 */
import { describe, it, expect } from 'vitest';
import {
  PROCESS_ROLES,
  LIFECYCLE_COMPONENTS,
  JOB_GROUPS,
  ROLE_CONTRACTS,
  getRoleContract,
  parseProcessRole,
  roleOwns,
  roleRequires,
  roleRunsJobGroup,
} from '../../../src/runtime/lifecycle/roles.js';

describe('process role contract', () => {
  it('declares a contract for every role, keyed consistently', () => {
    for (const role of PROCESS_ROLES) {
      const contract = ROLE_CONTRACTS[role];
      expect(contract).toBeDefined();
      expect(contract.role).toBe(role);
      expect(contract.description.length).toBeGreaterThan(0);
    }
  });

  it('only references known components in owns/requires', () => {
    for (const role of PROCESS_ROLES) {
      const { owns, requires } = getRoleContract(role);
      for (const c of [...owns, ...requires]) {
        expect(LIFECYCLE_COMPONENTS).toContain(c);
      }
    }
  });

  it('never requires a component the role does not own (it could never go ready)', () => {
    for (const role of PROCESS_ROLES) {
      const { owns, requires } = getRoleContract(role);
      for (const c of requires) expect(owns).toContain(c);
    }
  });

  it('makes config/db/schema/redis mandatory for EVERY role', () => {
    for (const role of PROCESS_ROLES) {
      for (const c of ['config', 'db', 'schema', 'redis'] as const) {
        expect(roleRequires(role, c)).toBe(true);
      }
    }
  });

  it('role=all is the single-process compat mode: owns every component', () => {
    expect([...ROLE_CONTRACTS.all.owns].sort()).toEqual([...LIFECYCLE_COMPONENTS].sort());
  });

  it('api does not gate readiness on the agent worker, cron or WhatsApp', () => {
    expect(roleRequires('api', 'agent_worker')).toBe(false);
    expect(roleRequires('api', 'cron_scheduler')).toBe(false);
    expect(roleRequires('api', 'whatsapp_session')).toBe(false);
    // …but it enqueues, so the queue must be reachable.
    expect(roleRequires('api', 'queue')).toBe(true);
    expect(roleRequires('api', 'http')).toBe(true);
  });

  it('worker gates on the agent worker but never on HTTP or WhatsApp', () => {
    expect(roleRequires('worker', 'agent_worker')).toBe(true);
    expect(roleRequires('worker', 'http')).toBe(false);
    expect(roleRequires('worker', 'whatsapp_session')).toBe(false);
    expect(roleOwns('worker', 'http')).toBe(false);
  });

  it('scheduler gates on the cron scheduler only', () => {
    expect(roleRequires('scheduler', 'cron_scheduler')).toBe(true);
    expect(roleRequires('scheduler', 'agent_worker')).toBe(false);
    expect(roleRequires('scheduler', 'whatsapp_session')).toBe(false);
  });

  it('session-owner gates on the WhatsApp session and the queue it enqueues to', () => {
    expect(roleRequires('session-owner', 'whatsapp_session')).toBe(true);
    expect(roleRequires('session-owner', 'queue')).toBe(true);
    expect(roleRequires('session-owner', 'agent_worker')).toBe(false);
  });

  /**
   * Issue #513 — o scheduler ENFILEIRA (`message_recovery`,
   * `unrouted_recovery`). Sem `queue` no contrato, `src/index.ts` fase 7
   * retorna cedo e esses crons rodavam contra uma fila que nunca foi
   * construída.
   */
  it('scheduler owns the queue it produces onto', () => {
    expect(roleOwns('scheduler', 'queue')).toBe(true);
    // Produz, nunca consome — como `api`.
    expect(roleOwns('scheduler', 'agent_worker')).toBe(false);
  });

  /**
   * Issue #513 — a ponte Admin→runtime do pareamento (#518) é um CRON, mas
   * mexe no Map de sessões Baileys. Sem `cron_scheduler` no session-owner, um
   * deploy separado deixava o dono do socket incomandável: a posse nunca era
   * publicada e o `stop_line` endereçado ia parar numa réplica sem socket.
   */
  it('session-owner owns the cron machinery its session-bound jobs need', () => {
    expect(roleOwns('session-owner', 'cron_scheduler')).toBe(true);
    expect(roleRequires('session-owner', 'cron_scheduler')).toBe(true);
  });
});

describe('job groups — issue #513 §5', () => {
  it('declares a group list for every role', () => {
    for (const role of PROCESS_ROLES) {
      const { jobGroups } = getRoleContract(role);
      for (const g of jobGroups) expect(JOB_GROUPS).toContain(g);
    }
  });

  it('a role that runs ANY group owns the cron machinery', () => {
    for (const role of PROCESS_ROLES) {
      if (getRoleContract(role).jobGroups.length === 0) continue;
      expect(roleOwns(role, 'cron_scheduler'), role).toBe(true);
    }
  });

  it('a role that runs the SESSION group owns the socket those jobs reach for', () => {
    for (const role of PROCESS_ROLES) {
      if (!roleRunsJobGroup(role, 'session')) continue;
      expect(roleOwns(role, 'whatsapp_session'), role).toBe(true);
    }
  });

  it('every group has exactly ONE non-compat runner — no duplicate crons', () => {
    // `all` runs everything by design; among the split roles each group must
    // have a single owner, or a split deployment double-fires the job.
    for (const group of JOB_GROUPS) {
      const runners = PROCESS_ROLES.filter(
        (r) => r !== 'all' && roleRunsJobGroup(r, group),
      );
      expect(runners, group).toHaveLength(1);
    }
  });

  it('the split roles together cover every group `all` covers', () => {
    const split = new Set(
      PROCESS_ROLES.filter((r) => r !== 'all').flatMap((r) => [
        ...getRoleContract(r).jobGroups,
      ]),
    );
    expect([...split].sort()).toEqual([...ROLE_CONTRACTS.all.jobGroups].sort());
  });

  it('api and worker schedule nothing', () => {
    expect(ROLE_CONTRACTS.api.jobGroups).toEqual([]);
    expect(ROLE_CONTRACTS.worker.jobGroups).toEqual([]);
  });
});

describe('parseProcessRole — fail-closed', () => {
  it('defaults to the documented compat mode when unset', () => {
    expect(parseProcessRole(undefined)).toBe('all');
    expect(parseProcessRole(null)).toBe('all');
    expect(parseProcessRole('')).toBe('all');
  });

  it('accepts every declared role', () => {
    for (const role of PROCESS_ROLES) expect(parseProcessRole(role)).toBe(role);
  });

  it('THROWS on an unknown role instead of falling back to a permissive default', () => {
    expect(() => parseProcessRole('workers')).toThrow(/invalid process role/i);
    expect(() => parseProcessRole('default')).toThrow(/invalid process role/i);
  });

  it('getRoleContract fails closed on a value that crossed a type boundary', () => {
    expect(() => getRoleContract('nope' as never)).toThrow(/unknown process role/i);
  });
});
