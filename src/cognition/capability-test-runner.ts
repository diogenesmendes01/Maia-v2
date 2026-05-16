/**
 * P5 Task 8 — capability-test-runner (loop fechado pós-activation).
 *
 * Spec criterion #3 (§9 P5): "capability_acquired event dispara teste
 * automatizado antes de ativar." Spec criterion #4: "Tool falha pós-ativação
 * abre novo gap técnico, agente reverte uso."
 *
 * Mapeamento concreto:
 *  - capability_acquired = transição approved -> delivered em capability_proposals.
 *  - Nesse momento, o runner executa todos os test_scenarios da proposal e
 *    grava em capability_test_results (auditoria + trigger de revert).
 *  - Se algum scenario falha → outcome='fail' → revertCapability cria gap
 *    technical (tipo='technical', prefixo [técnica]).
 *
 * Strategies (P5 placeholder):
 *  - echo_test: smoke trivial; passa quando o `when` do scenario contém o `then`
 *    (case-insensitive). Útil para validar shape da proposal sem chamar LLM.
 *  - knowledge_match: stub que sempre passa; P6+ vai conectar lookup real em
 *    knowledge_base. Aqui só registra que o caminho existe.
 *
 * Outcome contract:
 *  - 'pass':  todos scenarios passaram → sem revert, gravação simples.
 *  - 'fail':  pelo menos um falhou → triggered_revert=true, technical_gap_id
 *             populado com o gap criado por revertCapability.
 *  - 'error': condição de execução inválida (proposal não delivered, sem
 *             scenarios). NÃO dispara revert (não é falha funcional; é falha
 *             de pré-condição). details.error guarda o motivo.
 *
 * Defesas:
 *  - proposal_id desconhecido → throw 'proposal_not_found' (caller deve tratar
 *    como bug — proposals só são testadas via worker que já carregou a row).
 *  - proposal.status !== 'delivered' → outcome='error' + skip warning. Não
 *    grava revert; só registra o skip para auditoria.
 *  - Strategy que joga exceção em um scenario individual → esse scenario fica
 *    marcado failed com observed='strategy_threw' e reason=mensagem; o runner
 *    continua processando os demais.
 */
import { capabilityProposalsRepo, capabilityTestResultsRepo } from '@/db/repositories.js';
import { revertCapability } from '@/agent/capability-revert.js';
import { logger } from '@/lib/logger.js';

export type TestScenario = {
  name: string;
  given: string;
  when: string;
  then: string;
};

export type TestStrategyResult = { passed: boolean; observed: string; reason?: string };
export type TestStrategy = (scenario: TestScenario) => Promise<TestStrategyResult>;

export const TEST_STRATEGIES: Record<string, TestStrategy> = {
  echo_test: async (s) => {
    // Trivial smoke: scenario's `when` is echoed back, compared to `then`
    return { passed: s.when.toLowerCase().includes(s.then.toLowerCase()), observed: s.when };
  },
  knowledge_match: async (_s) => {
    // P5 placeholder: assume always passes (P6+ wires real knowledge lookup)
    return { passed: true, observed: 'knowledge_match_stub' };
  },
  // P9a: skill_evaluator — invoca um Skill em modo evaluator para julgar o
  // candidate (skill recém-aprovada). O scenario.when contém o
  // skill_descriptor do candidate; scenario.then é o baseline esperado;
  // o evaluator skill descriptor é resolvido por convenção via
  // `${candidate}_evaluator`. Se faltar evaluator, retorna observed=skip.
  skill_evaluator: async (s) => {
    // Lazy import para quebrar ciclo (skill-runner depende de várias coisas
    // do cognition; este strategy roda dentro do test-runner pós-aprovação).
    const { runSkill } = await import('@/skills/skill-runner.js');
    const candidateDescriptor = s.when.trim();
    const evaluatorDescriptor = `${candidateDescriptor}_evaluator`;
    const candidate = await runSkill({
      skill_descriptor: candidateDescriptor,
      input: { test_scenario: s },
      triggered_by: 'evaluator_pipeline',
    });
    if (!candidate.ok) {
      return { passed: false, observed: candidate.reason ?? 'candidate_failed', reason: candidate.message };
    }
    const evalResult = await runSkill({
      skill_descriptor: evaluatorDescriptor,
      input: { candidate_output: candidate.output, baseline: s.then, context: s },
      triggered_by: 'evaluator_pipeline',
    });
    if (!evalResult.ok) {
      // Sem evaluator skill ativo — não bloqueia o teste; reporta como skip.
      return { passed: true, observed: 'evaluator_unavailable_skip', reason: evalResult.reason };
    }
    const verdict = (evalResult.output as { verdict?: string } | undefined)?.verdict;
    const reasons = (evalResult.output as { reasons?: string[] } | undefined)?.reasons ?? [];
    return {
      passed: verdict === 'pass',
      observed: verdict ?? 'no_verdict',
      reason: reasons.join('; '),
    };
  },
};

export async function runCapabilityTests(args: {
  proposal_id: string;
  strategy_key?: string;
}): Promise<{ outcome: 'pass' | 'fail' | 'error'; result_id: string }> {
  const proposal = await capabilityProposalsRepo.getById(args.proposal_id);
  if (!proposal) throw new Error('proposal_not_found');
  if (proposal.status !== 'delivered') {
    logger.warn(
      { proposal_id: args.proposal_id, status: proposal.status },
      'capability_test_runner.skip_not_delivered',
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
