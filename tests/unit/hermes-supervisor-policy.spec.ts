/**
 * P07 (spec §5.8.1, §6.4, §6.7.2, §6.7.3, §6.11; gate G-LIFE) — o CONTRATO da
 * política do supervisor Hermes, na fatia PURA.
 *
 * `src/integrations/hermes/supervisor-policy.ts` responde três perguntas que o
 * supervisor faz e que NÃO dependem de processo, timer, banco ou rede:
 *
 *   - admissão    (`start`)   — posso lançar um processo para este pedido?
 *   - observação  (`observe`) — o que faço com o que o canal acabou de dizer?
 *   - cancelamento(`cancel`)  — qual é o próximo passo do encerramento?
 *
 * ─── Por que esta fatia é PURA, e o que isso compra ─────────────────────────
 *
 * Os desfechos que mais importam aqui são os AMBÍGUOS: ACK perdido, queda entre
 * reservar e lançar, status remoto que sumiu, lease que venceu no meio. Um teste
 * que precisasse de subprocesso real para exercitá-los mediria o escalonador do
 * sistema operacional, não a regra. Mantendo a decisão como função de um
 * INSTANTÂNEO explícito, cada um desses desfechos vira um caso determinístico.
 *
 * ─── A divisão de trabalho com `recovery.ts`, que este arquivo cobra ────────
 *
 * `src/runtime/engines/recovery.ts` (P03.8b) já é a tabela do §5.8.2: dado um
 * instantâneo do JOURNAL depois de uma queda, o que é seguro fazer com o run.
 * Esta política é outra pergunta — o que a TENTATIVA VIVA pode fazer agora — e
 * por isso ela não pode recontar a mesma decisão com outro vocabulário. O que os
 * casos abaixo exigem: vocabulários DISJUNTOS (nenhum membro repetido), e as
 * disposições que terminam numa situação durável não resolvida declaram, elas
 * mesmas, que o próximo passo é de `classifyRecovery`.
 *
 * ─── O que o vocabulário NÃO pode conseguir dizer ───────────────────────────
 *
 * INV-09 atravessa a fronteira: nem esta política pode expressar "retome a
 * sequência de ferramentas". E o §6.7.3 item 5 acrescenta a irmã dela —
 * cancelar não prova ausência de efeito —, então também não pode existir membro
 * que signifique "seguro repetir".
 *
 * Puro: nenhum caso toca banco, fila, rede ou subprocesso.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMISSION_DISPOSITIONS,
  CANCELLATION_DISPOSITIONS,
  DEFERS_TO_RECOVERY,
  EXECUTOR_OBSERVED_STATES,
  OBSERVATION_DISPOSITIONS,
  SPAWNS_PROCESS,
  decideAdmission,
  decideCancellation,
  decideObservation,
  deadlinePosture,
  mayFallBackToLocalEngine,
  type AdmissionSnapshotV1,
  type CancellationSnapshotV1,
  type ExecutorObservedStateV1,
  type ObservationSnapshotV1,
} from '@/integrations/hermes/supervisor-policy.js';
import { RECOVERY_DISPOSITIONS } from '@/runtime/engines/recovery.js';

const raiz = resolve(__dirname, '../..');
const fonte = readFileSync(resolve(raiz, 'src/integrations/hermes/supervisor-policy.ts'), 'utf8');

const EXEC_ID = '3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70';
/** Digests sintéticos: só precisam ser distintos e estáveis. */
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const TERMINAL_A = 'c'.repeat(64);
const TERMINAL_B = 'd'.repeat(64);

/** Admissão SAUDÁVEL: dono vivo, conversa do bot, prazo de pé, nada admitido. */
function adm(over: Partial<AdmissionSnapshotV1> = {}): AdmissionSnapshotV1 {
  return {
    execution_id: EXEC_ID,
    request_fingerprint: FP_A,
    existing: null,
    open_run_for_turn: false,
    lease_alive: true,
    control_mode: 'bot',
    deadline_exceeded: false,
    ...over,
  };
}

/** Observação SAUDÁVEL: posse viva, fence batendo, run em voo, nada pendente. */
function obs(over: Partial<ObservationSnapshotV1> = {}): ObservationSnapshotV1 {
  return {
    executor_state: 'running',
    lookup: 'found',
    lease_alive: true,
    fence_matches: true,
    deadline_exceeded: false,
    persisted_terminal_digest: null,
    incoming_terminal_digest: null,
    unreconciled_effect_calls: 0,
    ...over,
  };
}

/** Cancelamento no PRIMEIRO passo: nada revogado, nada enviado, nada confirmado. */
function can(over: Partial<CancellationSnapshotV1> = {}): CancellationSnapshotV1 {
  return {
    reason: 'deadline',
    capabilities_revoked: false,
    cancel_sent: false,
    cancel_ack_received: false,
    grace_exceeded: false,
    process_exit_confirmed: false,
    unreconciled_effect_calls: 0,
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// T09 — mesmo `execution_id`, payload diferente
// ───────────────────────────────────────────────────────────────────────────

describe('T09 — mesmo execution_id com payload diferente é CONFLITO', () => {
  it('1. fingerprint divergente na mesma execução conflita', () => {
    // §6.11: "Mesmo pedido de admissão retorna a mesma execução/estado; payload
    // diferente é conflito."
    const d = decideAdmission(
      adm({
        request_fingerprint: FP_B,
        existing: {
          execution_id: EXEC_ID,
          request_fingerprint: FP_A,
          executor_state: 'running',
          spawned: true,
        },
      }),
    );
    expect(d.kind).toBe('conflict_payload');
  });

  it('2. o conflito NÃO cria segundo processo', () => {
    const d = decideAdmission(
      adm({
        request_fingerprint: FP_B,
        existing: {
          execution_id: EXEC_ID,
          request_fingerprint: FP_A,
          executor_state: 'admitted',
          spawned: false,
        },
      }),
    );
    expect(d.kind).not.toBe(SPAWNS_PROCESS);
  });

  it('3. o conflito domina até uma admissão que de resto seria impecável', () => {
    // O par cirúrgico do caso 5: muda UMA variável (o fingerprint) e o desfecho
    // troca de `return_existing` para `conflict_payload`.
    const base = {
      execution_id: EXEC_ID,
      request_fingerprint: FP_A,
      executor_state: 'running' as const,
      spawned: true,
    };
    expect(decideAdmission(adm({ existing: base })).kind).toBe('return_existing');
    expect(decideAdmission(adm({ request_fingerprint: FP_B, existing: base })).kind).toBe(
      'conflict_payload',
    );
  });

  it('4. registro de OUTRA execução é defeito de programação, não decisão', () => {
    // O instantâneo modela "o registro encontrado para ESTE execution_id". Um id
    // divergente significa que alguém consultou a linha errada — devolver uma
    // disposição faria esse defeito parecer uma decisão.
    expect(() =>
      decideAdmission(
        adm({
          existing: {
            execution_id: '00000000-0000-4000-8000-000000000000',
            request_fingerprint: FP_A,
            executor_state: 'running',
            spawned: true,
          },
        }),
      ),
    ).toThrow(TypeError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T10 — ACK de admissão IPC perdido
// ───────────────────────────────────────────────────────────────────────────

describe('T10 — retry idêntico não cria outra tentativa nem outro processo', () => {
  it('5. mesmo pedido, mesma execução: devolve a existente', () => {
    const d = decideAdmission(
      adm({
        existing: {
          execution_id: EXEC_ID,
          request_fingerprint: FP_A,
          executor_state: 'running',
          spawned: true,
        },
      }),
    );
    expect(d.kind).toBe('return_existing');
  });

  it('6. NENHUM instantâneo com execução existente autoriza lançar processo', () => {
    // Invariante estrutural, provada por varredura do produto cartesiano em vez
    // de por um caso feliz: `admit_new` é a ÚNICA disposição que cria processo, e
    // ela tem de ser inalcançável enquanto existir registro para o id.
    for (const estado of EXECUTOR_OBSERVED_STATES) {
      for (const spawned of [true, false]) {
        for (const fingerprint of [FP_A, FP_B]) {
          for (const lease_alive of [true, false]) {
            for (const control_mode of ['bot', 'human']) {
              const d = decideAdmission(
                adm({
                  lease_alive,
                  control_mode,
                  existing: {
                    execution_id: EXEC_ID,
                    request_fingerprint: fingerprint,
                    executor_state: estado,
                    spawned,
                  },
                }),
              );
              expect(d.kind).not.toBe(SPAWNS_PROCESS);
            }
          }
        }
      }
    }
  });

  it('7. sem registro e sem run aberto, a admissão nova é autorizada', () => {
    // O complemento do caso 6: sem ele, uma política que SEMPRE recusasse
    // passaria em todos os casos acima e não teria sido detectada.
    expect(decideAdmission(adm()).kind).toBe('admit_new');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T11 — queda depois de reservar, antes do spawn
// ───────────────────────────────────────────────────────────────────────────

describe('T11 — admissão sem execução é um estado DISTINGUÍVEL', () => {
  it('8. admitido e não lançado tem disposição PRÓPRIA', () => {
    const d = decideAdmission(
      adm({
        existing: {
          execution_id: EXEC_ID,
          request_fingerprint: FP_A,
          executor_state: 'admitted',
          spawned: false,
        },
      }),
    );
    expect(d.kind).toBe('reconcile_admitted_not_executed');
  });

  it('9. a distinção SOBREVIVE à perda da lease — que é o caso real da queda', () => {
    // Quem cai depois de reservar perde a lease junto. Se o gate de posse viesse
    // antes da classificação, o desfecho seria `refuse` e a informação "foi
    // admitido e nunca executou" — que é EXATAMENTE o que o T11 manda distinguir
    // — se perderia dentro de uma recusa genérica.
    const d = decideAdmission(
      adm({
        lease_alive: false,
        existing: {
          execution_id: EXEC_ID,
          request_fingerprint: FP_A,
          executor_state: 'admitted',
          spawned: false,
        },
      }),
    );
    expect(d.kind).toBe('reconcile_admitted_not_executed');
  });

  it('10. o par: admitido e JÁ lançado não é o mesmo estado', () => {
    const d = decideAdmission(
      adm({
        existing: {
          execution_id: EXEC_ID,
          request_fingerprint: FP_A,
          executor_state: 'admitted',
          spawned: true,
        },
      }),
    );
    expect(d.kind).toBe('return_existing');
  });

  it('11. nova execução exige que o run anterior já esteja fechado', () => {
    // "Nova execução só por regra explícita": a política não tem membro que
    // signifique "lance de novo". A porta é cunhar um novo `execution_id` DEPOIS
    // de o journal fechar o run — e enquanto houver run aberto no turno, a
    // admissão nova é recusada. É o mesmo predicado da unique parcial
    // `engine_runs_one_open_turn_uq`, não uma segunda regra.
    const d = decideAdmission(adm({ open_run_for_turn: true }));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.reason).toBe('open_run_exists');
  });

  it('12. o vocabulário de admissão não consegue dizer "lance de novo"', () => {
    const proibidos = ['respawn', 'relaunch', 'retry_spawn', 'resume_tools', 'replay'];
    for (const p of proibidos) {
      expect(ADMISSION_DISPOSITIONS as readonly string[]).not.toContain(p);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T12 — ACK de resultado perdido
// ───────────────────────────────────────────────────────────────────────────

describe('T12 — repetir o resultado é idempotente', () => {
  it('13. mesmo digest reentregue não é resultado novo', () => {
    // §6.11: "Resultado recebido sem ACK pode ser repetido no mesmo canal com
    // mesmo digest". Repetir o ACK não duplica custo nem outbound porque não
    // reabre adoção.
    const d = decideObservation(
      obs({
        executor_state: 'completed',
        persisted_terminal_digest: TERMINAL_A,
        incoming_terminal_digest: TERMINAL_A,
      }),
    );
    expect(d).toBe('repeat_result_ack');
  });

  it('14. digest DIFERENTE para a mesma execução é conflito', () => {
    // O par do 13, e a outra metade da mesma frase do §6.11: "outro resultado
    // para mesma execução é conflito".
    const d = decideObservation(
      obs({
        executor_state: 'completed',
        persisted_terminal_digest: TERMINAL_A,
        incoming_terminal_digest: TERMINAL_B,
      }),
    );
    expect(d).toBe('conflict_terminal');
  });

  it('15. o primeiro terminal íntegro é adotado', () => {
    // O complemento dos dois acima: sem nada persistido, aceitar é o certo.
    const d = decideObservation(
      obs({
        executor_state: 'completed',
        persisted_terminal_digest: null,
        incoming_terminal_digest: TERMINAL_A,
      }),
    );
    expect(d).toBe('accept_terminal');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T13 / T16 — execução terminal não libera efeito desconhecido
// ───────────────────────────────────────────────────────────────────────────

describe('T13/T16 — terminal não libera efeito desconhecido', () => {
  it('16. terminal íntegro COM efeito não conciliado não é adotado', () => {
    // Par cirúrgico do caso 15: muda UMA variável. Mesma régua do `recovery.ts`
    // — a evidência de efeito domina o desfecho aparente.
    const d = decideObservation(
      obs({
        executor_state: 'completed',
        persisted_terminal_digest: null,
        incoming_terminal_digest: TERMINAL_A,
        unreconciled_effect_calls: 1,
      }),
    );
    expect(d).toBe('hold_effect_unknown');
  });

  it('17. o processo ter MORRIDO não converte efeito desconhecido em ausência', () => {
    // §6.11: "Crash durante/depois de tool: ledger Maia é fonte de verdade do
    // efeito. Não deduzir 'nenhum efeito' pela falta de callback/result."
    const d = decideCancellation(
      can({
        capabilities_revoked: true,
        cancel_sent: true,
        grace_exceeded: true,
        process_exit_confirmed: true,
        unreconciled_effect_calls: 1,
      }),
    );
    expect(d).toBe('reconcile_effects');
  });

  it('18. o par do 17: sem efeito pendente, o cancelamento assenta', () => {
    const d = decideCancellation(
      can({
        capabilities_revoked: true,
        cancel_sent: true,
        grace_exceeded: true,
        process_exit_confirmed: true,
        unreconciled_effect_calls: 0,
      }),
    );
    expect(d).toBe('settle_cancelled');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T14 — status remoto "não encontrado" depois de restart
// ───────────────────────────────────────────────────────────────────────────

describe('T14 — ausência de registro NÃO é prova de não execução', () => {
  it('19. `not_found` vira desconhecido, nunca "não executou"', () => {
    // §5.8.2, coluna dos proibidos: "Converter 404 em definitely_not_accepted".
    const d = decideObservation(obs({ lookup: 'not_found', executor_state: 'unknown' }));
    expect(d).toBe('treat_as_unknown');
  });

  it('20. `unavailable` recebe o mesmo tratamento', () => {
    // §5.7.1: "Timeout de rede não é negativo de efeito."
    const d = decideObservation(obs({ lookup: 'unavailable' }));
    expect(d).toBe('treat_as_unknown');
  });

  it('21. o vocabulário de observação não consegue afirmar não-execução', () => {
    const proibidos = ['definitely_not_accepted', 'never_ran', 'not_executed', 'safe_to_retry'];
    for (const p of proibidos) {
      expect(OBSERVATION_DISPOSITIONS as readonly string[]).not.toContain(p);
    }
  });

  it('22. executor terminal SEM proposta também é desconhecido', () => {
    // §6.7.2 item 8: "Falha de close/exit é condição observável, não 'done' por
    // recebimento de result." Um processo que morreu sem entregar terminal não
    // autoriza concluir nada.
    for (const estado of ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'] as const) {
      expect(decideObservation(obs({ executor_state: estado }))).toBe('treat_as_unknown');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T15 — lease expira enquanto o Hermes trabalha
// ───────────────────────────────────────────────────────────────────────────

describe('T15 — resultado de tentativa sem posse não é aceito', () => {
  it('23. fence divergente descarta ATÉ um terminal perfeito', () => {
    const d = decideObservation(
      obs({
        executor_state: 'completed',
        fence_matches: false,
        incoming_terminal_digest: TERMINAL_A,
      }),
    );
    expect(d).toBe('ignore_stale_result');
  });

  it('24. lease morta descarta o mesmo terminal perfeito', () => {
    const d = decideObservation(
      obs({
        executor_state: 'completed',
        lease_alive: false,
        incoming_terminal_digest: TERMINAL_A,
      }),
    );
    expect(d).toBe('ignore_stale_result');
  });

  it('25. as duas condições são INDEPENDENTES', () => {
    // Fence e lease protegem coisas diferentes (encarnação do supervisor vs.
    // posse do turno). Um teste que só exercitasse as duas juntas não
    // distinguiria uma política que checa só uma delas.
    expect(decideObservation(obs({ fence_matches: false, lease_alive: true }))).toBe(
      'ignore_stale_result',
    );
    expect(decideObservation(obs({ fence_matches: true, lease_alive: false }))).toBe(
      'ignore_stale_result',
    );
    expect(decideObservation(obs({ fence_matches: true, lease_alive: true }))).not.toBe(
      'ignore_stale_result',
    );
  });

  it('26. perder a posse não é sinônimo de fim: o próximo passo é do recovery', () => {
    expect(DEFERS_TO_RECOVERY as readonly string[]).toContain('ignore_stale_result');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T16 — deadline, grace e kill
// ───────────────────────────────────────────────────────────────────────────

describe('T16 — a escada deadline → cancelamento → grace → kill', () => {
  it('27. antes do prazo, nada é devido', () => {
    expect(
      deadlinePosture({
        now_ms: 1_000,
        execution_deadline_ms: 2_000,
        lease_horizon_ms: 5_000,
        grace_ms: 500,
      }),
    ).toBe('within_deadline');
  });

  it('28. passado o prazo e dentro da tolerância, cancelar', () => {
    expect(
      deadlinePosture({
        now_ms: 2_100,
        execution_deadline_ms: 2_000,
        lease_horizon_ms: 5_000,
        grace_ms: 500,
      }),
    ).toBe('cancel_due');
  });

  it('29. esgotada a tolerância, matar', () => {
    expect(
      deadlinePosture({
        now_ms: 2_600,
        execution_deadline_ms: 2_000,
        lease_horizon_ms: 5_000,
        grace_ms: 500,
      }),
    ).toBe('kill_due');
  });

  it('30. o prazo efetivo é o MÍNIMO entre execução e horizonte da lease', () => {
    // §5.8.1: "`ctx.deadline` deve ser getter `min(deadline_execucao_absoluto,
    // horizonte_lease_atual)`". Aqui quem vence é a LEASE — uma política que
    // olhasse só o deadline de execução diria `within_deadline`.
    expect(
      deadlinePosture({
        now_ms: 1_050,
        execution_deadline_ms: 9_000,
        lease_horizon_ms: 1_000,
        grace_ms: 200,
      }),
    ).toBe('cancel_due');
  });

  it('31. e o inverso: o deadline de execução vence com heartbeat saudável', () => {
    // A outra metade do `min`. §5.8.1: "Deadline de execução vence mesmo se
    // heartbeats continuam saudáveis."
    expect(
      deadlinePosture({
        now_ms: 1_050,
        execution_deadline_ms: 1_000,
        lease_horizon_ms: 9_000,
        grace_ms: 200,
      }),
    ).toBe('cancel_due');
  });

  it('32. instante não finito é defeito, não uma postura', () => {
    expect(() =>
      deadlinePosture({
        now_ms: Number.NaN,
        execution_deadline_ms: 1_000,
        lease_horizon_ms: 1_000,
        grace_ms: 0,
      }),
    ).toThrow(TypeError);
  });

  it('33. tolerância negativa é defeito', () => {
    expect(() =>
      deadlinePosture({
        now_ms: 0,
        execution_deadline_ms: 1_000,
        lease_horizon_ms: 1_000,
        grace_ms: -1,
      }),
    ).toThrow(TypeError);
  });

  it('34. o deadline observado abre o cancelamento', () => {
    expect(decideObservation(obs({ deadline_exceeded: true }))).toBe('start_cancellation');
  });

  it('35. e sem deadline vencido o supervisor segue observando', () => {
    expect(decideObservation(obs({ deadline_exceeded: false }))).toBe('keep_observing');
  });
});

describe('T16 — a ordem do encerramento é obrigatória (§6.7.3)', () => {
  it('36. revogar capacidades vem ANTES de pedir cancelamento', () => {
    // §6.7.3 item 1: Maia marca revogação e fecha admissão de novas tools ANTES
    // de o supervisor enviar `cancel`. A ordem inversa deixaria uma janela em que
    // o filho ainda pode pedir ferramenta.
    expect(decideCancellation(can({ capabilities_revoked: false }))).toBe('revoke_capabilities');
  });

  it('37. revogado, o passo seguinte é enviar o cancelamento', () => {
    expect(decideCancellation(can({ capabilities_revoked: true, cancel_sent: false }))).toBe(
      'send_cancel',
    );
  });

  it('38. o ACK de cancelamento NÃO encerra nada', () => {
    // §6.4.2: `cancel_ack` é "controle recebido; não prova de interrupção ou
    // ausência de efeito". §5.7.2: "não fechar com base só no ACK".
    const d = decideCancellation(
      can({
        capabilities_revoked: true,
        cancel_sent: true,
        cancel_ack_received: true,
        grace_exceeded: false,
        process_exit_confirmed: false,
      }),
    );
    expect(d).toBe('await_grace');
  });

  it('39. esgotada a tolerância sem exit confirmado, matar o grupo', () => {
    // §6.7.3 item 4: "terminar o processo/grupo/sandbox e aguardar o SO confirmar
    // exit".
    const d = decideCancellation(
      can({
        capabilities_revoked: true,
        cancel_sent: true,
        cancel_ack_received: true,
        grace_exceeded: true,
        process_exit_confirmed: false,
      }),
    );
    expect(d).toBe('kill_process_group');
  });

  it('40. é o EXIT confirmado que encerra, não a tolerância', () => {
    // Par do 39: com exit confirmado antes de a tolerância acabar, não se mata.
    const d = decideCancellation(
      can({
        capabilities_revoked: true,
        cancel_sent: true,
        grace_exceeded: false,
        process_exit_confirmed: true,
      }),
    );
    expect(d).toBe('settle_cancelled');
  });

  it('41. o vocabulário de cancelamento não consegue dizer "seguro repetir"', () => {
    // §6.7.3 item 5 e a regra da casa: cancelamento não prova ausência de efeito
    // e não autoriza replay. A ausência é o mecanismo, como em `recovery.ts`.
    const proibidos = ['safe_to_retry', 'no_effect', 'retry', 'replay', 'rollback'];
    for (const p of proibidos) {
      expect(CANCELLATION_DISPOSITIONS as readonly string[]).not.toContain(p);
    }
  });

  it('42. a categoria de cancelamento é a do WIRE, não uma segunda lista', () => {
    // §6.4.2: `cancel` carrega "categoria enumerada". O tipo vem de
    // `protocol.ts`; um vocabulário paralelo aqui divergiria no primeiro
    // acréscimo. A escada também não muda com a categoria.
    for (const reason of ['ownership_lost', 'operator', 'deadline', 'shutdown', 'policy'] as const) {
      expect(decideCancellation(can({ reason }))).toBe('revoke_capabilities');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T65 / T66 — rollback de engine
// ───────────────────────────────────────────────────────────────────────────

describe('T65/T66 — cair para o motor local exige reconciliação antes', () => {
  it('43. run aberto não libera fallback', () => {
    // §6.11: "Rollback altera engine somente de novos turnos ou de tentativa
    // explicitamente reautorizada após reconciliação; não rodar MaiaEngine em
    // paralelo para 'cobrir' uma HermesEngine que pode ter produzido efeito."
    expect(mayFallBackToLocalEngine({ run_closed: false, unreconciled_effect_calls: 0 })).toBe(
      false,
    );
  });

  it('44. run fechado COM efeito pendente também não libera', () => {
    expect(mayFallBackToLocalEngine({ run_closed: true, unreconciled_effect_calls: 1 })).toBe(false);
  });

  it('45. as duas condições juntas liberam', () => {
    expect(mayFallBackToLocalEngine({ run_closed: true, unreconciled_effect_calls: 0 })).toBe(true);
  });

  it('46. desligar a flag no meio do run cancela, não duplica engine', () => {
    // T66: a categoria `policy` do wire é o caminho — ela entra na MESMA escada
    // de encerramento, começando por revogar. Nada nela cria uma segunda
    // execução, porque a admissão recusa enquanto houver run aberto no turno.
    expect(decideCancellation(can({ reason: 'policy' }))).toBe('revoke_capabilities');
    const d = decideAdmission(adm({ open_run_for_turn: true }));
    expect(d.kind).not.toBe(SPAWNS_PROCESS);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Totalidade, composição com recovery.ts e pureza
// ───────────────────────────────────────────────────────────────────────────

describe('P07 — as três funções são TOTAIS', () => {
  it('47. toda observação cai numa disposição do vocabulário', () => {
    for (const executor_state of EXECUTOR_OBSERVED_STATES) {
      for (const lookup of ['found', 'not_found', 'unavailable'] as const) {
        for (const fence_matches of [true, false]) {
          for (const lease_alive of [true, false]) {
            for (const deadline_exceeded of [true, false]) {
              for (const incoming of [null, TERMINAL_A, TERMINAL_B]) {
                for (const persisted of [null, TERMINAL_A]) {
                  for (const efeitos of [0, 2]) {
                    const d = decideObservation({
                      executor_state,
                      lookup,
                      fence_matches,
                      lease_alive,
                      deadline_exceeded,
                      incoming_terminal_digest: incoming,
                      persisted_terminal_digest: persisted,
                      unreconciled_effect_calls: efeitos,
                    });
                    expect(OBSERVATION_DISPOSITIONS as readonly string[]).toContain(d);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('48. todo cancelamento cai numa disposição do vocabulário', () => {
    for (const capabilities_revoked of [true, false]) {
      for (const cancel_sent of [true, false]) {
        for (const cancel_ack_received of [true, false]) {
          for (const grace_exceeded of [true, false]) {
            for (const process_exit_confirmed of [true, false]) {
              for (const unreconciled_effect_calls of [0, 3]) {
                const d = decideCancellation({
                  reason: 'deadline',
                  capabilities_revoked,
                  cancel_sent,
                  cancel_ack_received,
                  grace_exceeded,
                  process_exit_confirmed,
                  unreconciled_effect_calls,
                });
                expect(CANCELLATION_DISPOSITIONS as readonly string[]).toContain(d);
              }
            }
          }
        }
      }
    }
  });

  it('49. toda admissão cai numa disposição do vocabulário', () => {
    const existentes: Array<AdmissionSnapshotV1['existing']> = [null];
    for (const executor_state of EXECUTOR_OBSERVED_STATES) {
      for (const spawned of [true, false]) {
        existentes.push({
          execution_id: EXEC_ID,
          request_fingerprint: FP_A,
          executor_state,
          spawned,
        });
      }
    }
    for (const existing of existentes) {
      for (const open_run_for_turn of [true, false]) {
        for (const lease_alive of [true, false]) {
          for (const control_mode of ['bot', 'human']) {
            for (const deadline_exceeded of [true, false]) {
              const d = decideAdmission(
                adm({ existing, open_run_for_turn, lease_alive, control_mode, deadline_exceeded }),
              );
              expect(ADMISSION_DISPOSITIONS as readonly string[]).toContain(d.kind);
            }
          }
        }
      }
    }
  });

  it('50. um estado de executor fora do vocabulário é defeito, não decisão', () => {
    expect(() =>
      decideObservation(obs({ executor_state: 'zumbi' as unknown as ExecutorObservedStateV1 })),
    ).toThrow(TypeError);
  });
});

describe('P07 — as recusas de admissão são distinguíveis', () => {
  it('51. controle humano recusa por motivo próprio', () => {
    const d = decideAdmission(adm({ control_mode: 'human' }));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.reason).toBe('human_control');
  });

  it('52. lease morta recusa por motivo próprio', () => {
    // §6.11: "Só uma lease válida pode lançar."
    const d = decideAdmission(adm({ lease_alive: false }));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.reason).toBe('stale_claim');
  });

  it('53. prazo vencido recusa por motivo próprio', () => {
    const d = decideAdmission(adm({ deadline_exceeded: true }));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.reason).toBe('deadline_exceeded');
  });
});

describe('P07 — a composição com `recovery.ts` não duplica a tabela', () => {
  it('54. os vocabulários são DISJUNTOS', () => {
    // Se um membro se repetisse, haveria duas tabelas respondendo à mesma
    // pergunta com nomes iguais — e a próxima mudança teria de acertar as duas.
    const meus = new Set<string>([
      ...ADMISSION_DISPOSITIONS,
      ...OBSERVATION_DISPOSITIONS,
      ...CANCELLATION_DISPOSITIONS,
    ]);
    for (const r of RECOVERY_DISPOSITIONS as readonly string[]) {
      expect(meus.has(r)).toBe(false);
    }
  });

  it('55. as disposições que terminam em incerteza durável delegam ao recovery', () => {
    for (const d of [
      'ignore_stale_result',
      'treat_as_unknown',
      'hold_effect_unknown',
      'reconcile_admitted_not_executed',
    ]) {
      expect(DEFERS_TO_RECOVERY as readonly string[]).toContain(d);
    }
  });

  it('56. o que o supervisor resolve sozinho NÃO delega', () => {
    // O complemento do 55: uma lista que contivesse tudo não diria nada.
    for (const d of ['accept_terminal', 'keep_observing', 'admit_new', 'settle_cancelled']) {
      expect(DEFERS_TO_RECOVERY as readonly string[]).not.toContain(d);
    }
  });

  it('57. `DEFERS_TO_RECOVERY` só contém membros que existem', () => {
    const meus = new Set<string>([
      ...ADMISSION_DISPOSITIONS,
      ...OBSERVATION_DISPOSITIONS,
      ...CANCELLATION_DISPOSITIONS,
    ]);
    for (const d of DEFERS_TO_RECOVERY as readonly string[]) {
      expect(meus.has(d)).toBe(true);
    }
  });
});

describe('P07 — o módulo é PURO', () => {
  it('58. não importa banco, ALS, env, métricas, subprocesso nem relógio', () => {
    // Verificação por TEXTO, como o contrato de `recovery.ts` e o de
    // `poison-policy.ts` já fazem. `Date.now(` está na lista porque uma política
    // de prazo que lesse o relógio não seria testável sem congelar tempo — o
    // instante entra como PARÂMETRO.
    const proibidos = [
      '@/db/',
      'db/client',
      'tenant-context',
      '@/config/env',
      '@/lib/metrics',
      'drizzle-orm',
      'child_process',
      '.spawn(',
      'setTimeout(',
      'setInterval(',
      'node:fs',
      'fetch(',
      'Date.now(',
      'new Date(',
    ];
    for (const p of proibidos) {
      expect(fonte).not.toContain(p);
    }
  });

  it('59. a política é SÍNCRONA — sem promessa, sem await', () => {
    // Uma decisão pura não espera nada. `async` aqui seria sinal de que alguma
    // consulta entrou na política.
    expect(fonte).not.toContain('async ');
    expect(fonte).not.toContain('await ');
  });

  it('60. as disposições citam a seção da spec que as origina', () => {
    // Vocabulário sem procedência é vocabulário inventado — a mesma régua do
    // caso 15 do contrato de `recovery.ts`.
    for (const d of [
      ...ADMISSION_DISPOSITIONS,
      ...OBSERVATION_DISPOSITIONS,
      ...CANCELLATION_DISPOSITIONS,
    ]) {
      expect(fonte).toContain(d);
    }
    expect(fonte).toContain('6.11');
    expect(fonte).toContain('6.7.3');
    expect(fonte).toContain('INV-09');
  });
});
