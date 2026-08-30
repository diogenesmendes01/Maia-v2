/**
 * Issue #510 — superfície pública do harness de fault injection.
 *
 * Um cenário FI importa DAQUI, nunca de um arquivo interno. O motivo é o mesmo
 * de qualquer barrel de fronteira: quando os cenários FI-01..FI-25 existirem,
 * mudar a implementação de um primitivo não deve custar 25 edições.
 *
 * O que esta fatia entrega (passos 1–4 do rollout da issue): ambiente isolado,
 * supervisor de processos com hard kill por PID exato, `eventually`,
 * `ArtifactCollector` sanitizado, catálogo tipado de failpoints e os dois
 * fakes. O `InvariantOracle`, os cenários FI e os perfis de CI ficam FORA — a
 * issue #510 segue aberta depois desta entrega.
 */
export {
  FAILPOINTS,
  FAILPOINT_ACTIONS,
  FAILPOINT_ENABLE_ENV,
  FAILPOINT_ENDPOINT_ENV,
  FAILPOINT_ENV_PREFIX,
  FAILPOINT_TOKEN_ENV,
  DuplicateGateError,
  FailpointGateRegistry,
  FailpointsForbiddenError,
  HandshakeTimeoutError,
  UnknownFailpointError,
  assertFailpointsAllowed,
  ehPerfilDeProducao,
  failpointActionSchema,
  failpointNameSchema,
  failpointsHabilitados,
  parseFailpointName,
} from './failpoints.js';
export type { ArmedGate, FailpointAction, FailpointName, ReachedEvent } from './failpoints.js';

export {
  FailpointServer,
  FailpointServerError,
  HEADER_TOKEN,
  RESPOSTAS_DE_FAILPOINT,
  ROTA_BARREIRA,
  ROTA_REACHED,
} from './failpoint-transport.js';
export type { AnuncioPendente, RespostaDeFailpoint } from './failpoint-transport.js';

export {
  FailpointInjectedError,
  FailpointTransportError,
  alcancar,
  barreira,
  injecaoLigada,
} from './failpoint-client.js';
export type { AcaoLocal, OpcoesDeAlcance } from './failpoint-client.js';

export { EventuallyTimeoutError, estavelDurante, eventually } from './eventually.js';
export type { EventuallyOptions } from './eventually.js';

export { REDACTED, chaveSensivel, jsonSanitizado, sanitizarTexto, sanitizarValor } from './sanitize.js';

export { ArtifactCollector, diretorioPadraoDeArtefatos } from './artifacts.js';
export type { CabecalhoDeArtefato, EventoDeTimeline, SaidaDeProcesso } from './artifacts.js';

export {
  ForeignPidError,
  LINHA_FATAL,
  LINHA_PRONTO,
  ProcessSupervisor,
  ProntidaoTimeoutError,
  SaidaInesperadaError,
  SupervisedChild,
} from './process-supervisor.js';
export type { Encerramento, SpawnOptions } from './process-supervisor.js';

export {
  AlvoDestrutivoInvalidoError,
  HOSTS_PERMITIDOS_ENV,
  MARCADOR_DE_BANCO,
  PREFIXO_DE_FILA,
  ReliabilityEnvironment,
  assertAlvoDestrutivo,
  nomeDeBancoDaSuite,
  prefixoDeFilaDaSuite,
  resolverAlvoDaSuite,
  suiteSlug,
} from './environment.js';
export type { AlvoDestrutivo, EstadoDoAmbiente, OpcoesDoAmbiente, SeedDeTenant } from './environment.js';

export { SEED_ENV, SeededRandom, ordemDeFaults, seedDaRodada } from './seeded-faults.js';
