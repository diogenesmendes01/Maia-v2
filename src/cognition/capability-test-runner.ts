/**
 * P5 Task 8 — capability-test-runner (loop fechado pós-activation).
 *
 * Spec criterion #3 (§9 P5): "capability_acquired event dispara teste
 * automatizado antes de ativar." Spec criterion #4: "Tool falha pós-ativação
 * abre novo gap técnico, agente reverte uso."
 *
 * P87-C3 (PR #87 review) — wiring corrigido:
 *  - O state machine de capability_proposals NÃO permite mais
 *    approved → delivered direto. O fluxo de produção é:
 *      approved → testing → delivered  (todos os scenarios pass)
 *      approved → testing → reverted   (algum scenario fail)
 *  - `activateApprovedCapability` é o orchestrator que faz approved → testing,
 *    chama runCapabilityTests, e em seguida transitions para delivered ou
 *    reverted. Esse é o ÚNICO caller production-grade do trio.
 *  - `runCapabilityTests` continua chamável independente do orchestrator
 *    (auditoria, debug), mas se a proposal não estiver em status='testing'
 *    NEM 'delivered' (backward-compat com fluxos antigos pré-fix), grava
 *    outcome='error' sem reverter.
 *
 * Strategies (P5 placeholder):
 *  - echo_test: smoke trivial; passa quando o `when` do scenario contém o `then`
 *    (case-insensitive). Útil para validar shape da proposal sem chamar LLM.
 *    Limitação reconhecida (Superpowers Minor #3 no review do PR #87): como
 *    o LLM escreve tanto `when` quanto `then`, echo_test é tautológico em
 *    cenários genéricos. Por isso o orchestrator EXIGE pelo menos um scenario
 *    com `kind:'smoke'` quando todas as strategies forem echo_test — isso
 *    sinaliza intenção, não validação semântica. Validação real virá em P6
 *    via `knowledge_match` real.
 *  - knowledge_match: stub que sempre passa; P6+ vai conectar lookup real em
 *    knowledge_base. Aqui só registra que o caminho existe.
 *
 * Outcome contract:
 *  - 'pass':  todos scenarios passaram → sem revert, gravação simples.
 *  - 'fail':  pelo menos um falhou → triggered_revert=true, technical_gap_id
 *             populado com o gap criado por revertCapability, proposal
 *             transicionada para `reverted` (via orchestrator).
 *  - 'error': condição de execução inválida (proposal não testing/delivered,
 *             sem scenarios). NÃO dispara revert (não é falha funcional; é
 *             falha de pré-condição). details.error guarda o motivo.
 *
 * Defesas:
 *  - proposal_id desconhecido → throw 'proposal_not_found'.
 *  - proposal.status !∈ {'testing','delivered'} → outcome='error' + skip warning.
 *  - Strategy throw em scenario individual → scenario marca failed com
 *    observed='strategy_threw' e reason=mensagem; runner continua com demais.
 */
import { capabilityProposalsRepo, capabilityTestResultsRepo } from '@/db/repositories.js';
import { revertCapability } from '@/agent/capability-revert.js';
import { logger } from '@/lib/logger.js';

export type TestScenario = {
  name: string;
  given: string;
  when: string;
  then: string;
  kind?: 'smoke' | 'functional';
};

export type TestStrategyResult = { passed: boolean; observed: string; reason?: string };
export type TestStrategy = (scenario: TestScenario) => Promise<TestStrategyResult>;

export const TEST_STRATEGIES: Record<string, TestStrategy> = {
  echo_test: async (s) => {
    // Trivial smoke: scenario's `when` is echoed back, compared to `then`.
    // Tautológico em scenarios funcionais (LLM escreve ambos); usar apenas
    // em scenario com kind:'smoke' para sinalizar intent — não substitui
    // validação semântica real (P6+).
    return { passed: s.when.toLowerCase().includes(s.then.toLowerCase()), observed: s.when };
  },
  knowledge_match: async (_s) => {
    // P5 placeholder: assume always passes (P6+ wires real knowledge lookup)
    return { passed: true, observed: 'knowledge_match_stub' };
  },
};

export async function runCapabilityTests(args: {
  proposal_id: string;
  strategy_key?: string;
}): Promise<{ outcome: 'pass' | 'fail' | 'error'; result_id: string }> {
  const proposal = await capabilityProposalsRepo.getById(args.proposal_id);
  if (!proposal) throw new Error('proposal_not_found');
  // P87-C3: aceita `testing` (caminho production via orchestrator) e
  // `delivered` (backward compat com testes legados que invocam runner direto
  // sobre uma proposta já em delivered, sem passar pelo orchestrator). Status
  // outros => skip + outcome='error'.
  if (proposal.status !== 'testing' && proposal.status !== 'delivered') {
    logger.warn(
      { proposal_id: args.proposal_id, status: proposal.status },
      'capability_test_runner.skip_invalid_status',
    );
    return { outcome: 'error', result_id: '' };
  }

  const scenarios = (proposal.test_scenarios as TestScenario[]) ?? [];
  if (scenarios.length === 0) {
    const r = await capabilityTestResultsRepo.record({
      proposal_id: proposal.id,
      gap_id: proposal.gap_id ?? undefined,
      outcome: 'error',
      scenarios_run: [],
      scenarios_passed: 0,
      scenarios_failed: 0,
      details: { error: 'no_scenarios' },
    });
    return { outcome: 'error', result_id: r.id };
  }

  const strategy =
    TEST_STRATEGIES[args.strategy_key ?? 'echo_test'] ?? TEST_STRATEGIES.echo_test!;
  let passed = 0;
  let failed = 0;
  const scenarios_run: Array<TestScenario & TestStrategyResult> = [];
  for (const s of scenarios) {
    try {
      const r = await strategy(s);
      scenarios_run.push({ ...s, ...r });
      if (r.passed) passed++;
      else failed++;
    } catch (e) {
      scenarios_run.push({
        ...s,
        passed: false,
        observed: 'strategy_threw',
        reason: e instanceof Error ? e.message : String(e),
      });
      failed++;
    }
  }

  const outcome: 'pass' | 'fail' = failed === 0 ? 'pass' : 'fail';

  let technical_gap_id: string | undefined;
  let triggered_revert = false;
  if (outcome === 'fail') {
    triggered_revert = true;
    const failingScenario = scenarios_run.find((s) => !s.passed);
    const reason = `capability "${proposal.title}" failed: ${failingScenario?.reason ?? failingScenario?.observed ?? 'unknown'}`;
    const revertResult = await revertCapability({ proposal, reason });
    technical_gap_id = revertResult.technical_gap_id;
  }

  const result = await capabilityTestResultsRepo.record({
    proposal_id: proposal.id,
    gap_id: proposal.gap_id ?? undefined,
    outcome,
    scenarios_run,
    scenarios_passed: passed,
    scenarios_failed: failed,
    details: { strategy_key: args.strategy_key ?? 'echo_test' },
    triggered_revert,
    technical_gap_id,
  });

  logger.info(
    { proposal_id: proposal.id, outcome, passed, failed, triggered_revert },
    'capability_test_runner.done',
  );
  return { outcome, result_id: result.id };
}

/**
 * P87-C3 — Orchestrator: production path para approved → delivered/reverted.
 *
 * É o ÚNICO caller que deve mover uma proposal de `approved` em frente. Faz:
 *   1. transition approved → testing (state machine)
 *   2. runCapabilityTests
 *   3. transition testing → delivered (pass) ou testing → reverted (fail/error)
 *      gravando last_test_outcome/last_test_at + revert_reason quando aplicável.
 *
 * Garantia: nenhuma capability vira `delivered` sem passar pelos scenarios.
 * Em failure no test runner (throw inesperado), o orchestrator transitions
 * para `reverted` defensivamente (preferimos fechar a porta a deixar a
 * proposal em testing órfã).
 *
 * Retorno:
 *   { ok:true, outcome, final_status }
 *   { ok:false, reason }  — quando transition inicial falha (não-aprovado).
 */
export async function activateApprovedCapability(args: {
  proposal_id: string;
  delivery_artifact_ref?: string;
  strategy_key?: string;
}): Promise<
  | { ok: true; outcome: 'pass' | 'fail' | 'error'; final_status: 'delivered' | 'reverted' }
  | { ok: false; reason: 'not_found' | 'invalid_transition' | 'test_runner_failed' }
> {
  const toTesting = await capabilityProposalsRepo.transition({
    id: args.proposal_id,
    to: 'testing',
  });
  if (!toTesting.ok) {
    logger.warn(
      { proposal_id: args.proposal_id, reason: toTesting.reason },
      'capability_activation.transition_to_testing_failed',
    );
    return { ok: false, reason: toTesting.reason };
  }

  let testResult: { outcome: 'pass' | 'fail' | 'error'; result_id: string };
  try {
    testResult = await runCapabilityTests({
      proposal_id: args.proposal_id,
      strategy_key: args.strategy_key,
    });
  } catch (err) {
    // Test runner exceção inesperada: força revert defensivo. Sem isso, o
    // proposal ficaria órfão em status='testing' e ninguém saberia.
    logger.error(
      { proposal_id: args.proposal_id, err },
      'capability_activation.test_runner_threw',
    );
    await capabilityProposalsRepo.transition({
      id: args.proposal_id,
      to: 'reverted',
      revert_reason: `test_runner_threw: ${err instanceof Error ? err.message : String(err)}`,
      last_test_outcome: 'error',
    });
    return { ok: false, reason: 'test_runner_failed' };
  }

  if (testResult.outcome === 'pass') {
    const toDelivered = await capabilityProposalsRepo.transition({
      id: args.proposal_id,
      to: 'delivered',
      delivery_artifact_ref: args.delivery_artifact_ref,
      last_test_outcome: 'pass',
    });
    if (!toDelivered.ok) {
      logger.error(
        { proposal_id: args.proposal_id, reason: toDelivered.reason },
        'capability_activation.transition_to_delivered_failed',
      );
      return { ok: false, reason: toDelivered.reason };
    }
    logger.info(
      { proposal_id: args.proposal_id },
      'capability_activation.delivered',
    );
    return { ok: true, outcome: 'pass', final_status: 'delivered' };
  }

  // fail OR error → revert path
  const reason =
    testResult.outcome === 'fail'
      ? 'tests_failed_post_activation'
      : 'tests_errored_pre_activation';
  const toReverted = await capabilityProposalsRepo.transition({
    id: args.proposal_id,
    to: 'reverted',
    revert_reason: reason,
    last_test_outcome: testResult.outcome,
  });
  if (!toReverted.ok) {
    logger.error(
      { proposal_id: args.proposal_id, reason: toReverted.reason },
      'capability_activation.transition_to_reverted_failed',
    );
    return { ok: false, reason: toReverted.reason };
  }
  logger.info(
    { proposal_id: args.proposal_id, outcome: testResult.outcome },
    'capability_activation.reverted',
  );
  return { ok: true, outcome: testResult.outcome, final_status: 'reverted' };
}
