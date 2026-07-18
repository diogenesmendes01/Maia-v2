/**
 * Sonda sintética (spec §1.1/§1.4/§1.5/§1.6) — orquestração de UM tick.
 *
 * Injeta um inbound sintético pelo CAMINHO REAL (ingressUpsertMessage), espera o
 * EFEITO COLATERAL até o SLO, classifica e persiste o desfecho durável +
 * sinaliza (métrica sempre; alerta só na transição). Tudo por injeção de deps
 * para ser testável sem DB/rede; o worker (`src/workers/synthetic-probe.ts`)
 * monta as deps reais.
 */
import { proto } from '@whiskeysockets/baileys';
import type { LineIngressCtx } from '../gateway/baileys.js';
import type { ProbeScenario } from './scenarios.js';
import type { JudgeVerdict } from './judge.js';
import type { ProbeOutcome, syntheticProbeRepo } from '../db/repositories/synthetic-probe-repos.js';
import type { AuditAction } from '../governance/audit-actions.js';
import {
  PROBE_AGENT_ID,
  PROBE_CHANNEL_ID,
  PROBE_LINE_E164,
  PROBE_TENANT_ID,
  probeClientJid,
} from './constants.js';

export type { ProbeOutcome };

/** Monta um `IWebMessageInfo` mínimo (texto), com id estável por run. */
export function buildSyntheticMessage(
  prompt: string,
  wid: string,
  nowMs: number,
): proto.IWebMessageInfo {
  return {
    key: { remoteJid: probeClientJid(), fromMe: false, id: wid },
    message: { conversation: prompt },
    messageTimestamp: Math.floor(nowMs / 1000),
    pushName: 'Sonda',
  };
}

/**
 * Classificação de desfecho (§1.1 passo 5). O contrato é efeito **+ liveness**
 * (correção do review — alta): sucesso EXIGE os dois. Efeito satisfeito SEM
 * resposta (`mensagens direcao='out'`) NÃO é sucesso — a Maia "fez" mas não
 * respondeu, o que é uma falha (`wrong`); classificar como ok zeraria o outage
 * apesar do silêncio ao usuário.
 *   - efeito + liveness ⇒ ok (ou slow se passou do SLO_warn);
 *   - liveness sem efeito ⇒ wrong (respondeu, mas não fez / fez errado);
 *   - efeito sem liveness ⇒ wrong (fez, mas não respondeu);
 *   - nem efeito nem liveness ⇒ silent (não respondeu no SLO).
 * `error` é tratado à parte (exceção no run).
 */
export function classifyOutcome(input: {
  effectSatisfied: boolean;
  liveness: boolean;
  elapsedMs: number;
  slowMs: number;
}): Exclude<ProbeOutcome, 'error'> {
  if (input.effectSatisfied && input.liveness) {
    return input.elapsedMs > input.slowMs ? 'slow' : 'ok';
  }
  if (input.liveness || input.effectSatisfied) return 'wrong';
  return 'silent';
}

type ProbeRepo = Pick<
  typeof syntheticProbeRepo,
  | 'channelReady'
  | 'createRun'
  | 'setRunMensagemId'
  | 'completeRun'
  | 'cleanupRunTraffic'
  | 'recordOk'
  | 'recordFailure'
  | 'recordAlertAttempt'
>;

/** Escopo (tenant, agent) da sonda — aplicado em todo WHERE de run. */
const SCOPE = { tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID };

export type ProbeTickDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  routingMode: 'shadow' | 'exact_first' | 'strict';
  scenario: ProbeScenario;
  ingress: (
    msg: proto.IWebMessageInfo,
    line: LineIngressCtx,
  ) => Promise<'handled' | 'dropped' | 'skipped'>;
  resolveInboundId: (wid: string) => Promise<string | null>;
  latestReplyText: (mensagem_id: string) => Promise<string | null>;
  repo: ProbeRepo;
  judge: { enabled: boolean; run: (input: { intent: string; prompt: string; reply: string | null }) => Promise<JudgeVerdict> };
  audit: (input: { acao: AuditAction; metadata?: Record<string, unknown> }) => Promise<void>;
  metrics: {
    inc: (name: string, labels?: Record<string, string>) => void;
    observe: (name: string, v: number, labels?: Record<string, string>) => void;
  };
  deliverAlert: (input: { subject: string; body: string }) => Promise<boolean>;
  sloMs: number;
  slowMs: number;
  alertAfterK: number;
  pollIntervalMs: number;
  logger: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void };
};

export type ProbeTickResult = {
  status: 'prereq_unmet' | 'ingress_failed' | 'completed';
  outcome?: ProbeOutcome;
  runId?: string;
  consecutiveFailures: number;
};

/** Aplica o desfecho ao estado durável + sinaliza. Um único lugar (§1.6). */
async function applyOutcome(
  deps: ProbeTickDeps,
  runId: string,
  outcome: ProbeOutcome,
  latency_ms: number | null,
  detail: Record<string, unknown>,
  mensagem_id: string | null,
): Promise<number> {
  const success = outcome === 'ok' || outcome === 'slow';
  deps.metrics.inc('synthetic_probe_runs_total', { outcome });
  if (latency_ms != null) {
    deps.metrics.observe('synthetic_probe_latency_ms', latency_ms, { scenario: deps.scenario.id });
  }
  // Cleanup + terminal SÓ no sucesso (§1.5): num desfecho de falha um job que
  // estourou o SLO ainda pode persistir DEPOIS — deixamos terminal_at NULL e o
  // sweep de TTL recolhe mais tarde. No sucesso o efeito já ocorreu: removemos a
  // transacao (delete idempotente; pendente não mutou saldo) e marcamos terminal.
  if (success && mensagem_id) {
    detail.cleaned_transacoes = await deps.repo.cleanupRunTraffic({
      tenant_id: PROBE_TENANT_ID,
      agent_id: PROBE_AGENT_ID,
      mensagem_id,
    });
  }
  await deps.repo.completeRun(SCOPE, runId, { outcome, latency_ms, detail, terminal: success });

  if (success) {
    const rec = await deps.repo.recordOk(PROBE_TENANT_ID, PROBE_AGENT_ID);
    if (rec.recovered) {
      await deps.deliverAlert({
        subject: 'Sonda sintética: RECUPERADA',
        body: `A sonda voltou a passar (outcome=${outcome}, latency_ms=${latency_ms}).`,
      });
    }
    return 0;
  }

  const fail = await deps.repo.recordFailure({
    tenant_id: PROBE_TENANT_ID,
    agent_id: PROBE_AGENT_ID,
    alert_after_k: deps.alertAfterK,
  });
  // Alerta só na TRANSIÇÃO saudável→degradado (dedup). Entrega best-effort com
  // retry durável: recordAlertAttempt grava se entregou (limpa alert_pending) ou
  // não (o worker reentrega no próximo tick). O sinal PRIMÁRIO é o gauge.
  if (fail.transitioned_to_degraded) {
    const delivered = await deps.deliverAlert({
      subject: 'Sonda sintética: DEGRADADA',
      body: `A sonda falhou ${fail.consecutive_failures}x consecutivas (último outcome=${outcome}).`,
    });
    await deps.repo.recordAlertAttempt({
      tenant_id: PROBE_TENANT_ID,
      agent_id: PROBE_AGENT_ID,
      delivered,
    });
  }
  return fail.consecutive_failures;
}

export async function runProbeTick(deps: ProbeTickDeps): Promise<ProbeTickResult> {
  // Pré-requisito de roteamento (§1.2): fora de exact_first/strict o exact-match
  // por linha não resolve o canal da sonda — fail-closed (no-op + audit), NUNCA
  // ativa o canal (um canal ativo derrubaria o ingresso real).
  if (deps.routingMode !== 'exact_first' && deps.routingMode !== 'strict') {
    await deps.audit({ acao: 'synthetic_probe_prereq_unmet', metadata: { reason: 'routing_mode', routing_mode: deps.routingMode } });
    deps.logger.warn({ routing_mode: deps.routingMode }, 'synthetic_probe.prereq_unmet');
    return { status: 'prereq_unmet', consecutiveFailures: 0 };
  }

  // Guard de prontidão POR TICK (§1.2, correção do review — alta): o canal
  // precisa estar ATIVO + is_synthetic. Se estiver INATIVO, o exact-match falha
  // e a injeção resolveria para o catch-all `primary/primary` (tenant REAL),
  // com o sink SEM casar. Fail-closed: NÃO injeta, audita e no-opa. Cobre a
  // desativação POSTERIOR ao boot (o boot fail-fast não cobre).
  const ready = await deps.repo.channelReady({
    tenant_id: PROBE_TENANT_ID,
    agent_id: PROBE_AGENT_ID,
    channel_id: PROBE_CHANNEL_ID,
  });
  if (!ready.ok) {
    await deps.audit({ acao: 'synthetic_probe_prereq_unmet', metadata: { reason: 'channel_not_ready', detail: ready.reason } });
    deps.logger.warn({ reason: ready.reason }, 'synthetic_probe.channel_not_ready');
    return { status: 'prereq_unmet', consecutiveFailures: 0 };
  }

  const startMs = deps.now();
  // id estável na janela do minuto — idempotente contra um re-disparo do tick.
  const wid = `probe-${deps.scenario.id}-${Math.floor(startMs / 60_000)}`;
  const runId = await deps.repo.createRun({
    tenant_id: PROBE_TENANT_ID,
    agent_id: PROBE_AGENT_ID,
    channel_id: PROBE_CHANNEL_ID,
    scenario: deps.scenario.id,
    whatsapp_id: wid,
  });

  try {
    const ingressRes = await deps.ingress(buildSyntheticMessage(deps.scenario.prompt, wid, startMs), {
      botLineE164: PROBE_LINE_E164,
    });
    if (ingressRes !== 'handled') {
      const cf = await applyOutcome(deps, runId, 'error', deps.now() - startMs, { stage: 'ingress', ingressRes }, null);
      deps.logger.warn({ ingressRes }, 'synthetic_probe.ingress_not_handled');
      return { status: 'ingress_failed', outcome: 'error', runId, consecutiveFailures: cf };
    }

    // Poll pelo efeito colateral + liveness até o SLO (§1.1 passo 4).
    let mensagemId: string | null = null;
    let effect = { effect_satisfied: false, liveness: false, detail: {} as Record<string, unknown> };
    const deadline = startMs + deps.sloMs;
    for (;;) {
      if (!mensagemId) mensagemId = await deps.resolveInboundId(wid);
      if (mensagemId) {
        effect = await deps.scenario.assert(mensagemId);
        if (effect.effect_satisfied && effect.liveness) break;
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(deps.pollIntervalMs);
    }
    const elapsed = deps.now() - startMs;
    if (mensagemId) await deps.repo.setRunMensagemId(SCOPE, runId, mensagemId);

    // LLM-judge (secundário, opt-in §1.4c) — só quando houve resposta.
    let judgeVerdict: JudgeVerdict | null = null;
    if (deps.judge.enabled && mensagemId && effect.liveness) {
      const reply = await deps.latestReplyText(mensagemId);
      judgeVerdict = await deps.judge.run({
        intent: deps.scenario.intent,
        prompt: deps.scenario.prompt,
        reply,
      });
    }

    const outcome = classifyOutcome({
      effectSatisfied: effect.effect_satisfied,
      liveness: effect.liveness,
      elapsedMs: elapsed,
      slowMs: deps.slowMs,
    });
    const detail: Record<string, unknown> = {
      ...effect.detail,
      mensagem_id: mensagemId,
      judge: judgeVerdict,
    };
    const cf = await applyOutcome(deps, runId, outcome, elapsed, detail, mensagemId);
    deps.logger.info({ outcome, elapsed_ms: elapsed, run_id: runId }, 'synthetic_probe.tick_done');
    return { status: 'completed', outcome, runId, consecutiveFailures: cf };
  } catch (err) {
    deps.logger.error({ err: (err as Error).message, run_id: runId }, 'synthetic_probe.tick_error');
    const cf = await applyOutcome(
      deps,
      runId,
      'error',
      deps.now() - startMs,
      { error: (err as Error).message },
      null,
    ).catch(() => 0);
    return { status: 'completed', outcome: 'error', runId, consecutiveFailures: cf };
  }
}
