/**
 * Playground sandbox turn executor (issue #464).
 *
 * Runs ONE turn for the admin-console "Testar agente" chat, deliberately
 * OUTSIDE the production pipeline (`runAgentForMensagem`): no pessoa/conversa,
 * no gateway, no outbox, no post-turn cognitive graph, no memory writes, no
 * learning. The v1 sandbox contract is conservative by construction:
 *
 *   - TOOLS ARE NOT BOUND to the LLM call (deny-all — the strictest possible
 *     reading of the spec's fail-closed default). The system prompt tells the
 *     model tools are disabled in the test environment, so it answers in
 *     character instead of hallucinating executions. Tool mocking per
 *     contract (`sandbox_behavior`) is the planned v1.1 — see the spec.
 *   - The ONLY persistence is the playground tables (handled by the caller)
 *     and one `audit_logs` row (`playground_turn`) — invariant #4: even test
 *     traffic leaves a trail, marked as such.
 *
 * Profile selection: when the session pins a `profile_version_id` (typically
 * a PROPOSED version under review), that body is rendered into the system
 * prompt WITHOUT activating it — testing never mutates version state. With
 * no pin, the active version is used; with no active version, we refuse
 * (mirrors production: an agent without an active profile does not operate).
 *
 * Caller contract: MUST run inside `runWithTenantContext({tenant_id, agent_id})`
 * — the profile repo reads are tenant-guarded.
 */
import { callLLM, type LLMMessage, type LLMResponse } from '@/lib/claude.js';
import { operationalProfileVersionsRepo, playgroundRepo } from '@/db/repositories.js';
import { renderOperationalProfile } from '@/identity/profile-renderer.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { audit } from '@/governance/audit.js';
import type { PlaygroundSession, PlaygroundTurn } from '@/db/schema.js';

const SANDBOX_HEADER = [
  '# Ambiente de teste (playground)',
  'Esta é uma conversa de TESTE conduzida pelo operador no console de governança.',
  'Responda exatamente como responderia a um cliente real, seguindo o perfil abaixo.',
  'Ferramentas e ações externas estão DESATIVADAS neste ambiente: se a resposta',
  'ideal exigiria executar uma ação (consultar dados, agendar, registrar algo),',
  'diga claramente qual ação você executaria e prossiga da melhor forma possível',
  'sem inventar resultados.',
].join('\n');

const MAX_HISTORY_TURNS = 20;
const MAX_OUTPUT_TOKENS = 1024;

export type PlaygroundTurnResult =
  | { ok: true; reply: string; decision_meta: Record<string, unknown> }
  | { ok: false; reason: 'no_profile' | 'llm_error'; detail: string };

export async function runPlaygroundTurn(args: {
  session: PlaygroundSession;
  turn: PlaygroundTurn;
}): Promise<PlaygroundTurnResult> {
  const { session, turn } = args;
  const startedAt = Date.now();

  // (1) Resolve the profile version under test (pinned proposed OR active).
  const version = session.profile_version_id
    ? await operationalProfileVersionsRepo.getById(session.profile_version_id)
    : await operationalProfileVersionsRepo.getActive();
  if (!version) {
    return {
      ok: false,
      reason: 'no_profile',
      detail: session.profile_version_id
        ? 'A versão de perfil desta sessão não existe mais.'
        : 'O agente não tem perfil ativo — aprove uma versão antes de testar.',
    };
  }

  // (2) Render the profile into the same system block production uses —
  // deterministic, read-only (profile-renderer.ts).
  const rendered = renderOperationalProfile({ version });
  const system = [
    SANDBOX_HEADER,
    '',
    rendered.system_prompt_block,
    rendered.growth_hints_block ?? '',
  ]
    .filter((b) => b.length > 0)
    .join('\n\n');

  // (3) Conversation history from the sandbox itself (never from production
  // conversations — the playground is hermetic).
  const history = await playgroundRepo.recentCompletedTurns({
    session_id: session.id,
    limit: MAX_HISTORY_TURNS,
  });
  const messages: LLMMessage[] = [
    ...history.map(
      (t): LLMMessage => ({
        role: t.role === 'agent' ? 'assistant' : 'user',
        content: t.content,
      }),
    ),
    { role: 'user', content: turn.content },
  ];

  // (4) Single LLM call, no tools bound (deny-all sandbox). Wrapped in
  // runCognitiveModule — P7 §9: cognitive_module_log covers 100% of module
  // executions, sandbox traffic included.
  const moduleResult = await runCognitiveModule<LLMResponse>(
    {
      name: 'playground_turn',
      triggered_by: 'async_event',
      timeoutMs: 30_000,
    },
    async () =>
      callLLM({
        workload: 'playground',
        system,
        messages,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
  );
  if (moduleResult.status !== 'success' || !moduleResult.output) {
    return {
      ok: false,
      reason: 'llm_error',
      detail:
        moduleResult.status === 'timeout'
          ? 'Tempo esgotado ao chamar o modelo (30s).'
          : 'Falha ao chamar o modelo — veja cognitive_module_log.',
    };
  }
  const res = moduleResult.output;
  const reply =
    res.content && res.content.trim().length > 0
      ? res.content
      : '(o modelo não retornou texto)';
  const model = res.model;
  const inputTokens = res.usage.input_tokens ?? 0;
  const outputTokens = res.usage.output_tokens ?? 0;

  const decision_meta: Record<string, unknown> = {
    profile_version_id: version.id,
    profile_version: version.version,
    profile_status: version.status,
    model,
    tokens: { input: inputTokens, output: outputTokens },
    latency_ms: Date.now() - startedAt,
    sandbox: { tools: 'disabled', memory_writes: 'none', outbox: 'none' },
  };

  // (5) Audit trail — sandbox traffic is auditable, marked as such.
  await audit({
    acao: 'playground_turn',
    alvo_id: session.id,
    metadata: {
      session_id: session.id,
      turn_id: turn.id,
      created_by: session.created_by,
      ...decision_meta,
    },
  });

  return { ok: true, reply, decision_meta };
}
