/**
 * P02.1 (spec §5.2, §5.3.1, §5.4.2) — `MaiaEngine`: o motor LOCAL atrás da porta.
 *
 * ─── Por que o motor local também passa pela porta ──────────────────────────
 *
 * A porta não existe por causa do Hermes. Ela existe para que "o desfecho do
 * turno" deixe de ser "o que a função retornou": hoje `runReActLoop` raciocina,
 * executa ferramentas, DESPACHA a resposta e devolve um veredito de entrega
 * tudo junto, e quem chama não tem como distinguir "o modelo não produziu
 * texto" de "o envio falhou antes de sair". O motor local é o primeiro cliente
 * da fronteira — e é ele que prova que ela não foi desenhada em volta de um
 * motor remoto.
 *
 * ─── O que este adapter NÃO faz ─────────────────────────────────────────────
 *
 * Não entrega, não decide efeito, não conclui turno. Ele devolve uma PROPOSTA
 * (`EngineTerminalProposalV1`): desfecho deliberativo, iterações, ids de
 * chamadas que afirma ter feito e uso reportado. Quem confronta isso com o
 * journal, congela a saída e despacha é a Maia (§5.3.3).
 *
 * ─── A memória é honesta ────────────────────────────────────────────────────
 *
 * O registro de execuções vive em MEMÓRIA do processo. Isso não é limitação
 * escondida: é a razão de `observe` devolver `not_found/inconclusive` — e nunca
 * `definitely_not_accepted` — para um run que ele não conhece. Depois de um
 * reinício, "não tenho registro" não é prova de que nada rodou, e tratar como
 * prova autorizaria o supervisor a recomeçar um turno que pode ter executado
 * ferramentas (§5.3.1). A continuidade durável é do journal (`engine_runs`),
 * não deste mapa.
 */
import { randomUUID } from 'node:crypto';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { incCounter } from '@/lib/metrics.js';
import type {
  AgentEnginePortV1,
  EngineIOV1,
  EngineObservationV1,
  EnginePinV1,
  EngineRequestV1,
  EngineRunLocatorV1,
  EngineStartResultV1,
  EngineStopV1,
  EngineTerminalProposalV1,
  ReportedUsageV1,
} from './contracts.js';
import { engineTerminalProposalV1Schema } from './schemas.js';
import { TurnOwnershipLostError } from '@/runtime/turns/execution-context.js';

/** O que o laço de raciocínio devolve — SEM nada sobre entrega ou efeito. */
export type ReasoningOutcomeV1 = {
  stop: EngineStopV1;
  iterations: number;
  observed_tool_call_ids: string[];
  usage: ReportedUsageV1;
};

/**
 * O laço de raciocínio, injetado. A próxima fatia liga aqui a extração de
 * `runReActLoop`; manter injetado é o que permite exercitar a porta inteira sem
 * provider, sem banco e sem dublar módulo.
 */
export type RunReasoningV1 = (
  request: EngineRequestV1,
  io: EngineIOV1,
) => Promise<ReasoningOutcomeV1>;

const USO_DESCONHECIDO: ReportedUsageV1 = {
  input_tokens: null,
  output_tokens: null,
  // Custo desconhecido permanece `null`. Zero seria uma medição que ninguém fez.
  cost_microusd: null,
  source: 'unavailable',
};

type Registro = {
  request_key: string;
  request_digest: string;
  remote_run_id: string;
  controller: AbortController;
  start: EngineStartResultV1;
  proposal: EngineTerminalProposalV1 | null;
};

/**
 * Sinal derivado: aborta quando o caller aborta OU quando o supervisor pede
 * cancelamento pela porta. O raciocínio recebe ESTE sinal, e não o do caller —
 * é o que faz `cancel` ter efeito observável sem exigir que todo caller
 * carregue um controlador próprio.
 */
function derivarSinal(externo: AbortSignal, controller: AbortController): AbortSignal {
  if (externo.aborted) controller.abort();
  else externo.addEventListener('abort', () => controller.abort(), { once: true });
  return controller.signal;
}

export function createMaiaEngine(deps: {
  runReasoning: RunReasoningV1;
  adapterRevision?: string;
  configurationDigest?: string;
}): AgentEnginePortV1 {
  const execucoes = new Map<string, Registro>();

  const pin: EnginePinV1 = {
    engine: 'maia_react',
    adapter_revision: deps.adapterRevision ?? 'maia-engine-0.1.0',
    configuration_digest:
      deps.configurationDigest ??
      canonicalDigest({ engine: 'maia_react', adapter: deps.adapterRevision ?? 'maia-engine-0.1.0' }),
    protocol_version: 1,
  };

  /** Monta e VALIDA a proposta. Proposta inválida é erro de protocolo nosso. */
  function montarProposta(
    request: EngineRequestV1,
    resultado: ReasoningOutcomeV1,
  ): EngineTerminalProposalV1 {
    const candidata = {
      version: 1 as const,
      run_id: request.run_id,
      request_key: request.request_key,
      stop: resultado.stop,
      iterations: resultado.iterations,
      observed_tool_call_ids: resultado.observed_tool_call_ids,
      usage: resultado.usage,
    };
    const parsed = engineTerminalProposalV1Schema.safeParse(candidata);
    if (parsed.success) return parsed.data as EngineTerminalProposalV1;
    return {
      version: 1,
      run_id: request.run_id,
      request_key: request.request_key,
      stop: { kind: 'failed', code: 'protocol_error' },
      iterations: 0,
      observed_tool_call_ids: [],
      usage: USO_DESCONHECIDO,
    };
  }

  return {
    pin,

    async start(request: EngineRequestV1, io: EngineIOV1): Promise<EngineStartResultV1> {
      /**
       * SC01 — o contador do `start`, e ele é a TESTEMUNHA das fronteiras.
       *
       * `maia_engine_start_total` responde a uma pergunta que nenhuma outra
       * série responde: o motor foi ACIONADO neste turno? Os gates
       * determinísticos (pendência, aprovação, skill, bloqueio) e a rota de
       * recovery terminam ANTES do reasoner, e um turno gated tem de terminar
       * com este contador em ZERO — senão a extração moveu o seam para o lado
       * errado dos gates sem que ninguém percebesse (§5.10.3, aceite "Fronteira
       * reasoner"). É também o denominador do caminho local: sem ele, "o motor
       * local rodou" fica indistinguível de "o motor local nunca foi chamado".
       *
       * Conta a ENTRADA, não o sucesso: um `start` que devolve o mesmo handle de
       * um reenvio idêntico ainda é uma chamada, e um `start` recusado por
       * conflito de chave também — os dois são fatos sobre o acionamento.
       */
      incCounter('maia_engine_start_total', { engine: pin.engine });
      const digest = canonicalDigest(request as unknown as Record<string, unknown>);
      const existente = execucoes.get(request.run_id);
      if (existente) {
        // §5.6.1: mesma chave com bytes diferentes é conflito TERMINAL. Devolver
        // "aceito" aqui significaria duas deliberações distintas compartilhando
        // uma identidade de pedido — e a segunda sobrescreveria a evidência da
        // primeira.
        if (existente.request_digest !== digest || existente.request_key !== request.request_key) {
          return {
            kind: 'rejected',
            definitely_not_accepted: true,
            code: 'request_key_payload_conflict',
          };
        }
        // Reenvio do MESMO start: devolve o mesmo handle, sem raciocinar de
        // novo. É o que impede um ACK perdido virar dois turnos pagos.
        return existente.start;
      }

      const controller = new AbortController();
      const remote_run_id = `local-${randomUUID()}`;
      const registro: Registro = {
        request_key: request.request_key,
        request_digest: digest,
        remote_run_id,
        controller,
        start: { kind: 'accepted', remote_run_id },
        proposal: null,
      };
      // Registrado ANTES do primeiro await: um `cancel` que chegue enquanto o
      // raciocínio roda precisa encontrar a execução.
      execucoes.set(request.run_id, registro);

      const ioDerivado: EngineIOV1 = {
        signal: derivarSinal(io.signal, controller),
        invokeTool: io.invokeTool,
      };

      try {
        const resultado = await deps.runReasoning(request, ioDerivado);
        registro.proposal = montarProposta(request, resultado);
      } catch (err) {
        if (err instanceof TurnOwnershipLostError) {
          // §5.4.2 item 1: perda de posse PRECEDE tudo e não é desfecho. A
          // execução some do registro justamente para que ninguém a "observe"
          // como concluída — quem tem a lease decide o que acontece com o turno.
          execucoes.delete(request.run_id);
          throw err;
        }
        registro.proposal = montarProposta(request, {
          stop: { kind: 'failed', code: 'reasoner_failed' },
          iterations: 0,
          observed_tool_call_ids: [],
          usage: USO_DESCONHECIDO,
        });
      }
      return registro.start;
    },

    async observe(
      locator: EngineRunLocatorV1,
      _signal: AbortSignal,
    ): Promise<EngineObservationV1> {
      const registro = execucoes.get(locator.run_id);
      // Sem registro, ou com handle divergente: INCONCLUSIVO. Ver o cabeçalho —
      // "não tenho registro" nunca vira prova de não-execução.
      if (!registro) return { kind: 'not_found', proof: 'inconclusive' };
      if (locator.remote_run_id && locator.remote_run_id !== registro.remote_run_id) {
        return { kind: 'not_found', proof: 'inconclusive' };
      }
      if (!registro.proposal) {
        return { kind: 'running', remote_run_id: registro.remote_run_id };
      }
      return {
        kind: 'terminal',
        remote_run_id: registro.remote_run_id,
        proposal: registro.proposal,
      };
    },

    async cancel(
      locator: EngineRunLocatorV1,
      _signal: AbortSignal,
    ): Promise<{ kind: 'requested' | 'already_terminal' | 'unsupported' | 'unknown' }> {
      const registro = execucoes.get(locator.run_id);
      if (!registro) return { kind: 'unknown' };
      if (registro.proposal) return { kind: 'already_terminal' };
      registro.controller.abort();
      // `requested` confirma o PEDIDO, não ausência de efeito: uma ferramenta
      // já despachada pode ter completado (§5.3.1, INV-06).
      return { kind: 'requested' };
    },
  };
}
