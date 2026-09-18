/**
 * P07 (spec §5.7.3, §6.7.2 item 6, §6.7.3 item 1) — o `HermesJournalPortV1`
 * sobre `engineRunsRepo`.
 *
 * O escopo do repositório vem do ALS, e aqui o ALS é aberto com o tenant e o
 * agente do `RunBinding` — o objeto que a Maia montou depois do claim. Nunca do
 * frame do worker: o hook do supervisor roda em callback de pipe, e o contexto
 * de quem lançou não é herdado de forma confiável até lá.
 *
 * O repositório entra por parâmetro para que este módulo não arraste o cliente
 * de banco para quem só precisa do tipo.
 */
import type { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { HermesJournalPortV1 } from './hermes-engine.js';

type EngineRunsRepo = Pick<typeof engineRunsRepo, 'recordTerminalProposal' | 'revokeRunCapabilities'>;

/** `actor_ref` da revogação quando o supervisor já não é dono do turno. */
export const HERMES_SUPERVISOR_ACTOR_REF = 'hermes-supervisor';

export function createHermesJournalPort(repo: EngineRunsRepo): HermesJournalPortV1 {
  return {
    async recordTerminal({ binding, proposal }) {
      const res = await runWithTenantContext(
        { tenant_id: binding.tenant_id, agent_id: binding.agent_id },
        () =>
          repo.recordTerminalProposal({
            run_id: binding.run_id,
            turn_id: binding.turn_id,
            origin_claim_token: binding.origin_claim_token,
            proposal,
          }),
      );
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },

    async revokeCapabilities({ binding, reason_code }) {
      const scope = { tenant_id: binding.tenant_id, agent_id: binding.agent_id };
      const asOwner = await runWithTenantContext(scope, () =>
        repo.revokeRunCapabilities({
          run_id: binding.run_id,
          turn_id: binding.turn_id,
          actor: { kind: 'turn_owner', origin_claim_token: binding.origin_claim_token },
          reason_code,
        }),
      );
      if (asOwner.ok) return;
      // Revogar só ESTREITA. Se o dono já perdeu a posse (é justamente quando
      // mais se precisa revogar), a revogação segue como recuperação.
      if (asOwner.reason === 'not_found') return;
      await runWithTenantContext(scope, () =>
        repo.revokeRunCapabilities({
          run_id: binding.run_id,
          turn_id: binding.turn_id,
          actor: { kind: 'recovery', actor_ref: HERMES_SUPERVISOR_ACTOR_REF },
          reason_code,
        }),
      );
    },
  };
}
