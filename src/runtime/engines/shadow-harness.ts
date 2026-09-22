/**
 * P11 (spec §10 linha P11, INV-10) — HARNESS DE AVALIAÇÃO EM SHADOW.
 *
 * ─── O que shadow é aqui ────────────────────────────────────────────────────
 *
 * Avaliação OFFLINE de um turno que já terminou, sobre um snapshot autorizado,
 * num armazenamento de avaliação SEPARADO. A spec fecha essa forma no §5.6:
 * "a V1 roda shadow OFFLINE sobre snapshots autorizados após encerramento do
 * turno … não cria segunda row aberta em `engine_runs` para o mesmo turno".
 *
 * Isso exclui a leitura intuitiva de "shadow" — rodar um segundo motor em
 * paralelo ao turno real. Rodar em paralelo exigiria uma segunda linha aberta
 * no journal do mesmo turno, e duas linhas abertas é a condição que o
 * supervisor usa para detectar duplicação.
 *
 * ─── INV-10, e por que ele é do harness e não do motor ──────────────────────
 *
 * "Nenhum efeito externo, envio, aprovação ou memória canônica é alterado por
 * um run shadow."
 *
 * O motor não sabe que está em shadow — ele recebe `EngineIOV1` e chama
 * `invokeTool`. Quem garante o invariante é QUEM MONTA esse `io`. Por isso o
 * harness não confia num modo passado adiante: ele entrega um `invokeTool` que
 * é incapaz de despachar, porque não tem dispatcher nenhum na mão. Um bug
 * futuro que esquecesse de checar um booleano não produziria efeito — não há
 * caminho de efeito para esquecer de checar.
 *
 * ─── A fidelidade vem da REPRODUÇÃO, não de tools falsas ────────────────────
 *
 * Uma tool que devolvesse valor sintético mediria o motor contra um mundo que
 * não existiu. O harness reproduz os resultados GRAVADOS do turno original, e
 * recusa qualquer chamada que não esteja na gravação — o que também é um dado:
 * "o motor novo quis chamar algo que o antigo não chamou" é exatamente o tipo
 * de divergência que a avaliação existe para encontrar.
 */
import { createHash } from 'node:crypto';
import type {
  AgentEnginePortV1,
  EngineRequestV1,
  EngineStopV1,
  EngineToolCallV1,
  EngineToolReplyV1,
  Json,
} from './contracts.js';

/** Uma chamada de ferramenta GRAVADA no turno original. */
export type RecordedToolCallV1 = {
  name: string;
  /** Digest canônico dos argumentos. Identifica a chamada sem guardá-los. */
  args_digest: string;
  result: Json;
  is_error: boolean;
};

/**
 * O snapshot AUTORIZADO de um turno encerrado.
 *
 * `authorized_at` e `authorized_by` não são decoração: o §10 condiciona o
 * shadow a "snapshots autorizados", e um snapshot sem autorização registrada é
 * dado de conversa de alguém sendo reprocessado sem que ninguém tenha
 * consentido.
 */
export type ShadowSnapshotV1 = {
  snapshot_id: string;
  turn_id: string;
  /** O turno PRECISA estar encerrado — ver `runShadowEvaluation`. */
  turn_closed: boolean;
  authorized_by: string;
  authorized_at: string;
  /** O pedido, exatamente como o motor original o recebeu. */
  request: EngineRequestV1;
  recorded_calls: readonly RecordedToolCallV1[];
  /** O desfecho que a produção de fato produziu. */
  production_stop: EngineStopV1;
};

export type ShadowDivergenceV1 =
  | { kind: 'stop_kind'; production: string; shadow: string }
  | { kind: 'reply_text'; note: 'texto diferente com o mesmo desfecho' }
  | { kind: 'tool_not_recorded'; call_id: string; tool: string }
  | { kind: 'tool_unused'; tool: string; args_digest: string };

/**
 * Por que não houve comparação. Vocabulário FECHADO, e o fecho é o ponto: um
 * membro genérico ("erro") deixaria "o motor recusou o trabalho" e "o motor
 * travou" no mesmo balde, e as duas pedem triagem oposta.
 */
export type ShadowNotComparableReasonV1 =
  /** `start` não devolveu `accepted`: não houve o que observar. */
  | 'engine_not_accepted'
  /** `observe` não chegou a terminal: o motor não produziu desfecho. */
  | 'engine_did_not_terminate'
  /** `start`/`observe` LANÇARAM. O motor quebrou no meio da avaliação. */
  | 'engine_threw'
  /** O prazo da avaliação estourou antes de o motor terminar. */
  | 'deadline_exceeded';

export type ShadowReportV1 = {
  snapshot_id: string;
  turn_id: string;
  /** Versão do formato. Relatório versionado é requisito do §10. */
  report_format: 1;
  engine_pin: AgentEnginePortV1['pin'];
  production_stop_kind: EngineStopV1['kind'];
  shadow_stop_kind: EngineStopV1['kind'] | 'not_produced';
  /**
   * HOUVE comparação?
   *
   * O campo existe porque `divergences: []` é ambíguo sozinho, e a ambiguidade
   * é perigosa na direção errada: "comparei e não achei diferença" e "não
   * cheguei a comparar" são o mesmo array vazio. Um consumidor que lesse só o
   * comprimento trataria um motor que travou como um motor que passou.
   *
   * `shadow_stop_kind: 'not_produced'` já dava o sinal, mas de lado — exigia
   * que o leitor soubesse procurá-lo. Aqui a pergunta é feita diretamente.
   */
  outcome: 'compared' | 'not_comparable';
  /** Preenchido exatamente quando `outcome` é `not_comparable`. */
  not_comparable_reason: ShadowNotComparableReasonV1 | null;
  divergences: ShadowDivergenceV1[];
  /** Chamadas que o motor em shadow pediu e a gravação não tinha. */
  unrecorded_calls: number;
  evaluated_at: string;
};

export type ShadowEvaluationResultV1 =
  | { kind: 'evaluated'; report: ShadowReportV1 }
  | {
      kind: 'non_comparable';
      reason: ShadowNotComparableReasonV1;
      /** O relatório de FALHA, já gravado. Ver `runShadowEvaluation`. */
      report: ShadowReportV1;
    }
  | { kind: 'refused'; reason: 'turn_not_closed' | 'not_authorized' };

/** Armazenamento de avaliação — SEPARADO do de produção (§10). */
export type ShadowReportStoreV1 = {
  save(report: ShadowReportV1): Promise<void>;
};

function digestArgs(args: Json): string {
  const ordenar = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(ordenar);
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, ordenar(val)]),
    );
  };
  return createHash('sha256')
    .update(JSON.stringify(ordenar(args)), 'utf8')
    .digest('hex');
}

/**
 * O `invokeTool` do shadow.
 *
 * Ele não recebe dispatcher, repositório nem gateway — só a gravação. Essa
 * ausência É a garantia do INV-10: não há caminho de efeito para esquecer de
 * barrar.
 *
 * Uma chamada fora da gravação é recusada com `tool_not_allowed` e REGISTRADA.
 * Recusar é o único desfecho seguro (executar seria efeito), e registrar é o
 * que transforma a recusa em achado de avaliação em vez de ruído.
 */
export function createReplayToolIO(
  snapshot: ShadowSnapshotV1,
  naoGravadas: ShadowDivergenceV1[],
): {
  invokeTool: (call: EngineToolCallV1) => Promise<EngineToolReplyV1>;
  /** Chaves da gravação que o motor em shadow NÃO pediu. */
  naoUsadas: () => RecordedToolCallV1[];
} {
  /**
   * FILA por chave, e não um valor só.
   *
   * O par (nome, digest dos argumentos) não identifica uma chamada: identifica
   * uma FORMA de chamada. Um turno que consulta o saldo duas vezes grava duas
   * entradas idênticas, e um mapa de valor único devolveria a primeira nas
   * duas vezes — o replay mediria o motor contra uma gravação que ele mesmo
   * encurtou. A fila preserva ordem e cardinalidade do turno original.
   */
  const porChave = new Map<string, RecordedToolCallV1[]>();
  for (const c of snapshot.recorded_calls) {
    const chave = `${c.name}\u0000${c.args_digest}`;
    const fila = porChave.get(chave);
    if (fila === undefined) porChave.set(chave, [c]);
    else fila.push(c);
  }
  /** Quantas da fila de cada chave já foram devolvidas. */
  const consumidos = new Map<string, number>();

  return {
    invokeTool: async (call: EngineToolCallV1): Promise<EngineToolReplyV1> => {
      const chave = `${call.name}\u0000${digestArgs(call.args)}`;
      const numConsumidos = consumidos.get(chave) ?? 0;
      /**
       * Um acesso só cobre as DUAS formas de não haver gravação: chave que o
       * turno original nunca produziu, e chave cuja fila já se esgotou (o
       * motor em shadow pediu mais vezes do que a produção pediu). Checar
       * `fila.length` à parte diria a mesma coisa em dois lugares — e deixava
       * a leitura do índice sem prova para o compilador, que é como este
       * arquivo chegou vermelho no CI.
       */
      const gravada = porChave.get(chave)?.[numConsumidos];

      if (gravada === undefined) {
        naoGravadas.push({
          kind: 'tool_not_recorded',
          call_id: call.call_id,
          tool: call.name,
        });
        return {
          kind: 'refused',
          call_id: call.call_id,
          code: 'tool_not_allowed',
        };
      }

      consumidos.set(chave, numConsumidos + 1);

      return {
        kind: 'result',
        call_id: call.call_id,
        result: gravada.result,
        is_error: gravada.is_error,
      };
    },
    naoUsadas: () => {
      const result: RecordedToolCallV1[] = [];
      for (const [chave, fila] of porChave.entries()) {
        const numConsumidos = consumidos.get(chave) ?? 0;
        const naoUsadas = fila.slice(numConsumidos);
        result.push(...naoUsadas);
      }
      return result;
    },
  };
}

/**
 * Avalia um motor contra um snapshot, sem tocar produção.
 *
 * `engine` é o motor SOB AVALIAÇÃO. Ele não é informado de que está em shadow:
 * informar exigiria que ele se comportasse diferente, e um motor que se
 * comporta diferente em avaliação não está sendo avaliado.
 */
export async function runShadowEvaluation(input: {
  snapshot: ShadowSnapshotV1;
  engine: AgentEnginePortV1;
  store: ShadowReportStoreV1;
  signal?: AbortSignal;
  /**
   * Prazo da AVALIAÇÃO, em milissegundos. Default: 2 minutos.
   *
   * Não é `snapshot.request.limits.deadline_at`: aquele é o prazo do turno
   * ORIGINAL, que já passou — usá-lo abortaria toda avaliação no primeiro
   * instante. O prazo de avaliar não é o prazo de atender.
   *
   * Sem ele, um motor que trava trava o harness junto, e uma bateria de
   * avaliação noturna amanhece parada no primeiro snapshot ruim — sem
   * relatório nenhum, que é a pior forma de falhar aqui: silêncio
   * indistinguível de "ainda não rodou".
   */
  timeout_ms?: number;
  now?: () => Date;
}): Promise<ShadowEvaluationResultV1> {
  const { snapshot, engine } = input;

  /**
   * Turno ABERTO não é avaliável.
   *
   * Rodar sobre um turno em andamento reintroduziria a forma que o §5.6
   * exclui: haveria dois motores raciocinando sobre o mesmo turno, e o
   * resultado da avaliação dependeria de qual terminasse primeiro.
   */
  if (!snapshot.turn_closed) return { kind: 'refused', reason: 'turn_not_closed' };

  // Snapshot sem autorização registrada é dado de conversa de alguém sendo
  // reprocessado sem consentimento.
  if (snapshot.authorized_by.length === 0) return { kind: 'refused', reason: 'not_authorized' };

  const divergences: ShadowDivergenceV1[] = [];
  const replay = createReplayToolIO(snapshot, divergences);

  const controller = new AbortController();
  if (input.signal?.aborted === true) controller.abort();
  const abortListener = () => controller.abort();
  input.signal?.addEventListener('abort', abortListener, { once: true });

  const relogio = input.now ?? ((): Date => new Date());

  /**
   * O RELATÓRIO DE FALHA.
   *
   * Toda saída que não seja recusa de pré-voo passa por aqui, e é isso que
   * torna o armazenamento de avaliação completo: um motor que trava ou que
   * lança deixa uma LINHA, em vez de deixar nada. Deixar nada é a falha que o
   * §5.3.1 nomeia no resto da épica — ausência de registro sendo lida como
   * ausência de evento —, e aqui ela apareceria como "aquele snapshot nunca
   * foi avaliado" quando o fato é "foi avaliado e o motor quebrou".
   *
   * As divergências acumuladas até o ponto da falha vão junto: uma chamada
   * fora da gravação continua sendo o achado mais interessante do relatório,
   * mesmo que o motor tenha morrido logo depois de fazê-la.
   */
  const relatorioDeFalha = (reason: ShadowNotComparableReasonV1): ShadowReportV1 => ({
    snapshot_id: snapshot.snapshot_id,
    turn_id: snapshot.turn_id,
    report_format: 1,
    engine_pin: engine.pin,
    production_stop_kind: snapshot.production_stop.kind,
    shadow_stop_kind: 'not_produced',
    outcome: 'not_comparable',
    not_comparable_reason: reason,
    divergences,
    unrecorded_calls: divergences.filter((d) => d.kind === 'tool_not_recorded').length,
    evaluated_at: relogio().toISOString(),
  });

  const naoComparavel = async (
    reason: ShadowNotComparableReasonV1,
  ): Promise<ShadowEvaluationResultV1> => {
    const report = relatorioDeFalha(reason);
    await input.store.save(report);
    return { kind: 'non_comparable', reason, report };
  };

  /**
   * O PRAZO. Aborta o `signal` que o motor recebeu, em vez de correr com a
   * promessa dele: cancelar de verdade é pedir ao motor que pare, não desistir
   * de esperar e deixá-lo trabalhando. `unref` para que o timer não segure o
   * processo de uma bateria que já terminou.
   */
  let estourouOPrazo = false;
  const timer = setTimeout(() => {
    estourouOPrazo = true;
    controller.abort();
  }, input.timeout_ms ?? 120_000);
  timer.unref?.();

  try {
    let shadowStop: EngineStopV1 | null = null;
    let start: Awaited<ReturnType<AgentEnginePortV1['start']>>;
    try {
      start = await engine.start(snapshot.request, {
        signal: controller.signal,
        invokeTool: replay.invokeTool,
      });
    } catch {
      // O erro não sobe. Um motor que lança é um RESULTADO da avaliação — é
      // justamente o tipo de coisa que se quer descobrir em shadow —, e
      // propagá-lo faria a bateria parar no primeiro motor ruim. O que ele
      // NÃO pode é virar aprovação silenciosa, e não vira: o relatório sai
      // com `outcome: 'not_comparable'`.
      return await naoComparavel(estourouOPrazo ? 'deadline_exceeded' : 'engine_threw');
    }

    /**
     * Se o motor foi recusado, não há comparação possível.
     * Retornar explicitamente que o resultado não é comparável, não reportar
     * como avaliado com divergences vazio, que seria confuso.
     */
    if (start.kind !== 'accepted') {
      return await naoComparavel('engine_not_accepted');
    }

    let obs: Awaited<ReturnType<AgentEnginePortV1['observe']>>;
    try {
      obs = await engine.observe(
        {
          run_id: snapshot.request.run_id,
          request_key: snapshot.request.request_key,
          remote_instance_id: 'shadow',
          remote_run_id: start.remote_run_id,
        },
        controller.signal,
      );
    } catch {
      return await naoComparavel(estourouOPrazo ? 'deadline_exceeded' : 'engine_threw');
    }

    /**
     * Se observe não retornou terminal, o motor não terminou, logo não há
     * um desfecho para comparar com a produção.
     */
    if (obs.kind !== 'terminal') {
      return await naoComparavel(estourouOPrazo ? 'deadline_exceeded' : 'engine_did_not_terminate');
    }

    shadowStop = obs.proposal.stop;

    /**
     * A comparação.
     *
     * Desfecho diferente é a divergência que importa. Texto diferente com o
     * MESMO desfecho é registrado como nota e não como defeito: dois textos
     * podem dizer a mesma coisa, e tratar variação de redação como regressão
     * afogaria o relatório em ruído.
     */
    if (shadowStop.kind !== snapshot.production_stop.kind) {
      divergences.push({
        kind: 'stop_kind',
        production: snapshot.production_stop.kind,
        shadow: shadowStop.kind,
      });
    } else if (
      shadowStop.kind === 'reply' &&
      snapshot.production_stop.kind === 'reply' &&
      shadowStop.raw_text !== snapshot.production_stop.raw_text
    ) {
      divergences.push({
        kind: 'reply_text',
        note: 'texto diferente com o mesmo desfecho',
      });
    }

    /**
     * Ferramenta que a PRODUÇÃO chamou e o shadow não pediu.
     *
     * Também é divergência, e deliberadamente sem juízo de valor: o motor novo
     * pode ter descoberto que o passo era desnecessário, ou pode ter deixado de
     * fazer algo que importava. O relatório registra; quem decide qual dos dois
     * é quem lê.
     */
    for (const naoUsada of replay.naoUsadas()) {
      divergences.push({
        kind: 'tool_unused',
        tool: naoUsada.name,
        args_digest: naoUsada.args_digest,
      });
    }

    const report: ShadowReportV1 = {
      snapshot_id: snapshot.snapshot_id,
      turn_id: snapshot.turn_id,
      report_format: 1,
      engine_pin: engine.pin,
      production_stop_kind: snapshot.production_stop.kind,
      shadow_stop_kind: shadowStop.kind,
      outcome: 'compared',
      not_comparable_reason: null,
      divergences,
      unrecorded_calls: divergences.filter((d) => d.kind === 'tool_not_recorded').length,
      evaluated_at: relogio().toISOString(),
    };

    await input.store.save(report);
    return { kind: 'evaluated', report };
  } finally {
    // Remover o listener para evitar vazamento, mesmo se houver exceção.
    input.signal?.removeEventListener('abort', abortListener);
    clearTimeout(timer);
  }
}
