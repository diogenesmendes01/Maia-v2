/**
 * Issue #510 — superfície pública dos oracles. Um cenário importa DAQUI.
 */
export {
  FAMILIAS_DE_INVARIANTE,
  InvarianteVioladaError,
  InvariantOracle,
  verificarFenceDeTokenDeposto,
  verificarInvariantes,
  verificarProgresso,
} from './invariant-oracle.js';
export type {
  EscopoEsperado,
  FamiliaDeInvariante,
  FotoDuravel,
  LinhaDeAuditoria,
  LinhaDeSaida,
  LinhaDeTurno,
  OpcoesDeVerificacao,
  OpcoesDoOracle,
  ViolacaoDeInvariante,
} from './invariant-oracle.js';
