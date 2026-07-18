/**
 * Sonda sintética (spec §1.3) — GATE de armamento do sink de outbound.
 *
 * O sink na fronteira `LineOutput` (buildOutput) só intercepta quando (a) este
 * gate está ARMADO e (b) o escopo casa o triplete de sonda (isProbeScope). O
 * gate é armado UMA vez, no boot (src/index.ts), e SÓ depois da validação
 * fail-fast provar no DB que o canal configurado é exclusivamente sintético
 * (is_synthetic=true, tenant ≠ primary, dedicado). Ou seja: o marcador
 * is_synthetic é verificado no arm-time — um triplet match em runtime já
 * implica canal sintético, sem custo de uma leitura por envio.
 *
 * Com a flag off (ou boot sem validar) o gate NUNCA arma, então o sink é
 * inerte e nenhum outbound real é afetado. Um escopo que casa o triplete mas
 * cujo canal NÃO é sintético jamais chega aqui: o boot teria FALHADO antes de
 * armar (fail-fast), e sem arm o sink não intercepta.
 */

let armed = false;

/** Arma o sink. Chamado só pelo boot APÓS a validação fail-fast (§1.3). */
export function armProbeSink(): void {
  armed = true;
}

export function isProbeSinkArmed(): boolean {
  return armed;
}

/** Test-only: controla o estado de armamento entre casos. */
export function _setProbeSinkArmedForTests(value: boolean): void {
  armed = value;
}
