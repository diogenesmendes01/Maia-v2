/**
 * Sonda sintética (spec 2026-07-17 §1) — identidade FIXA do recurso de sonda.
 *
 * Estes ids são LITERAIS de código, casados 1:1 com o seed da migração 094.
 * São constantes (não env) DE PROPÓSITO: o blast radius do §1.3 (silenciar um
 * tenant real por env mal configurada) some quando o alvo do sink é
 * compile-time e imutável. O boot fail-fast (§1.3) ainda revalida no DB que o
 * triplete é exclusivamente sintético — defense-in-depth, não a única linha.
 *
 * Tenant/agent = '__probe__' (≠ 'primary'/'default'/'system'; passa os guards
 * de tenant-context). O canal nasce INATIVO com is_synthetic=true — um canal
 * ATIVO de tenant ≠ primary derrubaria `findPrimaryCatchAllChannel` para
 * multi_tenant:true e quebraria o ingresso REAL (§1.2/§1.7.7).
 */

export const PROBE_TENANT_ID = '__probe__';
export const PROBE_AGENT_ID = '__probe__';
export const PROBE_CHANNEL_ID = 'eebe5268-875d-58e0-b727-7bb6589c947e';

/** Linha E.164 do canal (external_id) — o exact-match do ingresso. Faixa ITU +999. */
export const PROBE_LINE_E164 = '+999000999001';
/** Telefone do "cliente de teste" (remoteJid do inbound). ≠ linha, ≠ OWNER/MAIA. */
export const PROBE_CLIENT_TEL = '+999000999002';

export const PROBE_PESSOA_ID = '5a2d2130-7bf8-5870-b0d6-1ee7775c1f47';
export const PROBE_ENTIDADE_ID = '46691ceb-2a90-5eef-ba77-445763433efb';
export const PROBE_CONTA_ID = '21e4d7f3-ae55-574b-923b-eaa2345db9ec';

/** Contexto ALS do tenant/agent da sonda. */
export const PROBE_CONTEXT = { tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID } as const;

/** Triplete completo do canal de sonda (o alvo exato do sink de outbound). */
export const PROBE_SCOPE = {
  tenant_id: PROBE_TENANT_ID,
  agent_id: PROBE_AGENT_ID,
  channel_id: PROBE_CHANNEL_ID,
} as const;

/** JID do remetente sintético (`<dígitos>@s.whatsapp.net`). */
export function probeClientJid(): string {
  return `${PROBE_CLIENT_TEL.replace(/^\+/, '')}@s.whatsapp.net`;
}

/**
 * O escopo casa EXATAMENTE o triplete do canal de sonda? Usado pelo sink
 * (§1.3): a interceptação exige o triplete completo — nunca `tenant_id`
 * sozinho, que teria blast radius sobre um tenant real inteiro.
 */
export function isProbeScope(scope: {
  tenant_id: string;
  agent_id: string;
  channel_id: string;
}): boolean {
  return (
    scope.tenant_id === PROBE_TENANT_ID &&
    scope.agent_id === PROBE_AGENT_ID &&
    scope.channel_id === PROBE_CHANNEL_ID
  );
}
