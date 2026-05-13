import type { RunModuleOptions, RunModuleResult } from './types.js';
import { cognitiveModuleLogRepo } from '@/db/repositories.js';
import { tryGetCurrentContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';

export async function runCognitiveModule<TOut>(
  opts: RunModuleOptions<TOut>,
  fn: () => Promise<TOut>,
): Promise<RunModuleResult<TOut>> {
  const startTime = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const audit = opts.audit ?? true;
  let status: RunModuleResult<TOut>['status'] = 'success';
  // PR #82 review: declare output without an initial null assignment —
  // `let foo = null` followed by an unconditional re-assignment in both
  // try and catch arms trips `no-useless-assignment`. TS already forces
  // a definite assignment along every reachable path.
  let output: TOut | null;
  let fallback_triggered = false;
  let error_message: string | undefined;

  try {
    output = await Promise.race([
      fn(),
      new Promise<TOut>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);
  } catch (err) {
    const e = err as Error;
    error_message = e.message;
    status = e.message === 'timeout' ? 'timeout' : 'error';
    fallback_triggered = true;
    if (opts.fallback !== undefined) {
      output = typeof opts.fallback === 'function'
        ? (opts.fallback as () => TOut)()
        : opts.fallback;
    } else {
      output = null;
    }
  }

  const latency_ms = Date.now() - startTime;

  if (audit) {
    const ctx = tryGetCurrentContext();
    try {
      await cognitiveModuleLogRepo.record({
        tenant_id: ctx?.tenant_id ?? 'default',
        agent_id: ctx?.agent_id ?? 'default',
        conversa_id: opts.conversa_id ?? null,
        turno_id: opts.turno_id ?? null,
        module_name: opts.name,
        module_version: opts.version ?? 'v1',
        prompt_version: null,
        triggered_by: opts.triggered_by,
        started_at: new Date(startTime),
        ended_at: new Date(),
        latency_ms,
        model_used: null,
        tokens_in: null,
        tokens_out: null,
        cost_estimate: null,
        output_summary_hash: null,
        confidence: null,
        fallback_triggered,
        fallback_reason: error_message ?? null,
        status,
        metadata: {},
      });
    } catch (logErr) {
      logger.warn({ err: (logErr as Error).message, module: opts.name }, 'runner.audit_failed');
    }
  }

  return { output, status, fallback_triggered, latency_ms };
}
