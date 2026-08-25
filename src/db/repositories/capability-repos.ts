import { eq, and, inArray, desc, isNull, isNotNull, or, gte, sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  agent_capabilities_domain,
  agent_capabilities_skill,
  agent_capability_gaps,
  agent_capability_gap_observations,
  gap_escalation_rules,
  capability_proposals,
  capability_test_results,
  runtime_trace_envelopes,
  tool_request_aggregates,
  tool_request_aggregate_members,
  tool_request_issues,
  tool_request_notifications,
} from '../schema.js';
import { currentTraceId } from '@/observability/correlation.js';
import { logger } from '@/lib/logger.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type { GapLevel, ProposalStatus } from '@/types/enums.js';
import type {
  AgentCapabilityDomain,
  AgentCapabilitySkill,
  AgentCapabilityGap,
  AgentCapabilityGapObservation,
  GapEscalationRule,
  NewGapEscalationRule,
  CapabilityProposal,
  CapabilityTestResult,
  ToolRequestAggregate,
  ToolRequestAggregateMember,
  ToolRequestIssue,
  ToolRequestNotification,
} from '../schema.js';

export const capabilitiesDomainRepo = {
  async findByDomain(domain: string): Promise<AgentCapabilityDomain | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_capabilities_domain)
      .where(
        and(
          eq(agent_capabilities_domain.tenant_id, tenant_id),
          eq(agent_capabilities_domain.agent_id, agent_id),
          eq(agent_capabilities_domain.domain, domain),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertConfidence(
    domain: string,
    updates: Partial<AgentCapabilityDomain>,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Try update first
    const existing = await capabilitiesDomainRepo.findByDomain(domain);
    if (existing) {
      await db
        .update(agent_capabilities_domain)
        .set({ ...updates, updated_at: new Date() })
        .where(eq(agent_capabilities_domain.id, existing.id));
    } else {
      await db.insert(agent_capabilities_domain).values({
        tenant_id,
        agent_id,
        domain,
        ...updates,
      } as typeof agent_capabilities_domain.$inferInsert);
    }
  },

  async listAll(): Promise<AgentCapabilityDomain[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_domain)
      .where(
        and(
          eq(agent_capabilities_domain.tenant_id, tenant_id),
          eq(agent_capabilities_domain.agent_id, agent_id),
        ),
      );
  },
};

export const capabilitiesSkillRepo = {
  async findBySkill(domain: string, skill_name: string): Promise<AgentCapabilitySkill | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
          eq(agent_capabilities_skill.domain, domain),
          eq(agent_capabilities_skill.skill_name, skill_name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertConfidence(
    domain: string,
    skill_name: string,
    updates: Partial<AgentCapabilitySkill>,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const existing = await capabilitiesSkillRepo.findBySkill(domain, skill_name);
    if (existing) {
      await db
        .update(agent_capabilities_skill)
        .set({ ...updates, updated_at: new Date() })
        .where(eq(agent_capabilities_skill.id, existing.id));
    } else {
      await db.insert(agent_capabilities_skill).values({
        tenant_id,
        agent_id,
        domain,
        skill_name,
        ...updates,
      } as typeof agent_capabilities_skill.$inferInsert);
    }
  },

  async listByDomain(domain: string): Promise<AgentCapabilitySkill[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
          eq(agent_capabilities_skill.domain, domain),
        ),
      );
  },

  async listAll(): Promise<AgentCapabilitySkill[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
        ),
      );
  },
};

/**
 * #636 (fatia A da épica #471) — uma OCORRÊNCIA do gap, como o call site a viu.
 *
 * `root_trace_id` NÃO é um parâmetro que o call site precisa lembrar de passar:
 * quando o registro roda dentro do escopo de correlação do turno
 * (`runWithCorrelation`, `src/observability/correlation.ts`), o id do turno é o
 * `trace_id` da ALS — o MESMO id que `runtime_trace_envelopes.root_trace_id`
 * guarda. Herdá-lo é o que faz a situação apontar para um trace REAL sem
 * inventar plumbing novo, e é o que faz um call site fora de turno (worker,
 * backfill) registrar honestamente `null` em vez de um link falso.
 */
export type GapObservationInput = {
  /** O que o agente queria fazer nesta ocorrência. */
  intent: string;
  /** Detalhe da situação, quando houver. */
  detail?: string | null;
  conversa_id?: string | null;
  /**
   * Sobrescreve o id herdado da correlação. Use só quando o call site conhece
   * o turno mas não roda dentro do escopo dele (replay, backfill).
   */
  root_trace_id?: string | null;
  /** Id do envelope da TENTATIVA, quando o call site o conhece. */
  trace_id?: string | null;
  /** Argumentos que o agente tentou usar. `{}`/ausente = não observado. */
  attempted_args?: Record<string, unknown>;
  /** Retorno que o agente esperava. `{}`/ausente = não observado. */
  expected_output?: Record<string, unknown>;
  observed_at?: Date;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` para qualquer coisa que não caiba numa coluna `uuid`. */
function comoUuidOuNulo(v: string | null | undefined): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

/**
 * #636 — o ledger de ocorrências do gap.
 *
 * Todo método é escopado por (tenant_id, agent_id) do contexto ALS: uma
 * observação de outro escopo é INVISÍVEL, e um `gap_id` vazado de outro tenant
 * não colhe linha nenhuma (o `id` nunca é fronteira de isolamento — #367/#368).
 */
export const capabilityGapObservationsRepo = {
  async record(
    gap_id: string,
    input: GapObservationInput,
  ): Promise<AgentCapabilityGapObservation> {
    const guarded = applyTenantGuard({
      gap_id,
      intent: input.intent,
      detail: input.detail ?? null,
      conversa_id: comoUuidOuNulo(input.conversa_id),
      // Herda o id do turno da correlação quando o call site não o passa.
      root_trace_id: comoUuidOuNulo(
        input.root_trace_id !== undefined ? input.root_trace_id : currentTraceId(),
      ),
      trace_id: comoUuidOuNulo(input.trace_id),
      attempted_args: input.attempted_args ?? {},
      expected_output: input.expected_output ?? {},
      ...(input.observed_at ? { observed_at: input.observed_at } : {}),
    });
    const [row] = await db
      .insert(agent_capability_gap_observations)
      .values(guarded as typeof agent_capability_gap_observations.$inferInsert)
      .returning();
    return row!;
  },

  /**
   * `record` que NÃO propaga erro — ver a nota em `capabilityGapsRepo.upsert`:
   * o gap é o dado de governança, a observação é o enriquecimento. Devolve
   * `null` quando não conseguiu gravar, e diz no log por quê.
   */
  async recordBestEffort(
    gap_id: string,
    input: GapObservationInput,
  ): Promise<AgentCapabilityGapObservation | null> {
    try {
      return await capabilityGapObservationsRepo.record(gap_id, input);
    } catch (err) {
      logger.warn(
        { gap_id, err: (err as Error).message },
        'gap_observation.record_failed',
      );
      return null;
    }
  },

  /** As `limit` ocorrências mais recentes DESTE gap, neste escopo. */
  async listForGap(
    gap_id: string,
    limit = 20,
  ): Promise<AgentCapabilityGapObservation[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capability_gap_observations)
      .where(
        and(
          eq(agent_capability_gap_observations.tenant_id, tenant_id),
          eq(agent_capability_gap_observations.agent_id, agent_id),
          eq(agent_capability_gap_observations.gap_id, gap_id),
        ),
      )
      .orderBy(desc(agent_capability_gap_observations.observed_at))
      .limit(limit);
  },

  /**
   * Quais desses `root_trace_id` existem COMO ENVELOPE NESTE ESCOPO.
   *
   * É aqui que "link para trace real" deixa de ser promessa. A observação
   * guarda o id sem FK (o envelope é purgável por retenção — ver migração
   * 125), então quem afirma que a situação tem trace é esta leitura, e ela
   * filtra por tenant+agent: um id que aponta para o envelope de OUTRO tenant
   * não resolve, e a situação sai da proposta sem link em vez de com um link
   * que atravessa a fronteira.
   */
  async resolveTraceIdsInScope(rootTraceIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(rootTraceIds.filter((id) => comoUuidOuNulo(id) !== null))];
    if (ids.length === 0) return new Set();
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ root_trace_id: runtime_trace_envelopes.root_trace_id })
      .from(runtime_trace_envelopes)
      .where(
        and(
          eq(runtime_trace_envelopes.tenant_id, tenant_id),
          eq(runtime_trace_envelopes.agent_id, agent_id),
          inArray(runtime_trace_envelopes.root_trace_id, ids),
        ),
      );
    return new Set(rows.map((r) => r.root_trace_id).filter((v): v is string => v !== null));
  },
};

export const capabilityGapsRepo = {
  async upsert(input: {
    capability_description: string;
    tipo: 'tool' | 'knowledge' | 'procedure';
    contexto?: string;
    source_candidate_id?: string;
    /**
     * #636 — a OCORRÊNCIA que motivou este upsert. Quando presente, além de
     * incrementar `frequency_score` gravamos uma linha em
     * `agent_capability_gap_observations`: o contador diz "quantas vezes", a
     * linha diz "quando, em que turno, tentando o quê". Sem isso o pedido de
     * ferramenta não tem como carregar situações com link de trace nem janela
     * de frequência.
     *
     * FALHA ISOLADA de propósito: não gravar a observação NÃO pode derrubar o
     * upsert do gap. O gap é o dado de governança (é ele que escala e vira
     * dashboard); a observação é o enriquecimento. Perder o enriquecimento
     * degrada a proposta futura; perder o gap apaga o sinal.
     */
    observation?: GapObservationInput;
  }): Promise<AgentCapabilityGap> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Simple match by description (LIKE or exact); P3+ pode usar embedding similarity
    const existing = await db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          eq(agent_capability_gaps.capability_description, input.capability_description),
        ),
      )
      .limit(1);

    if (existing[0]) {
      // Defense in depth (#370): scope the UPDATE by tenant + agent, not by id
      // alone — mirroring updateLevel below. The id matched the tenant-scoped
      // SELECT above, but a colliding/stale id across tenants must never let this
      // bump another tenant's row ("id is not an isolation boundary"; #367/#368).
      await db
        .update(agent_capability_gaps)
        .set({
          frequency_score: existing[0].frequency_score + 1,
          last_observed: new Date(),
        })
        .where(
          and(
            eq(agent_capability_gaps.id, existing[0].id),
            eq(agent_capability_gaps.tenant_id, tenant_id),
            eq(agent_capability_gaps.agent_id, agent_id),
          ),
        );
      if (input.observation) {
        await capabilityGapObservationsRepo.recordBestEffort(
          existing[0].id,
          input.observation,
        );
      }
      return existing[0];
    }

    const [created] = await db
      .insert(agent_capability_gaps)
      .values({
        tenant_id,
        agent_id,
        capability_description: input.capability_description,
        tipo: input.tipo,
        contexto: input.contexto ?? null,
        source_candidate_id: input.source_candidate_id ?? null,
      } as typeof agent_capability_gaps.$inferInsert)
      .returning();
    if (input.observation) {
      await capabilityGapObservationsRepo.recordBestEffort(created!.id, input.observation);
    }
    return created!;
  },

  async listByLevel(level: string): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          eq(agent_capability_gaps.current_level, level),
        ),
      );
  },

  // P5: extensions ------------------------------------------------------------
  // listByLevels: plural variant for the escalation engine that needs to load
  // every gap in a set of current levels (e.g. ['silent', 'dashboard']) in one
  // query before running level-transition rules.
  //
  // #638 (fatia C da épica #471): só gaps ABERTOS. Um gap fechado — a
  // ferramenta que faltava existe e está concedida a este agente — não é
  // candidato a escalar, não é limitação a anunciar e não é pedido a repetir.
  // Sem este filtro, "o gap fecha" seria uma coluna que ninguém lê, e o worker
  // de escalada voltaria a pedir a ferramenta que acabou de ser entregue.
  async listByLevels(levels: GapLevel[]): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    if (levels.length === 0) return [];
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          inArray(agent_capability_gaps.current_level, levels),
          isNull(agent_capability_gaps.resolved_at),
        ),
      );
  },

  /**
   * #638 — a leitura do TURNO, em UMA ida ao banco: os gaps abertos nestes
   * níveis MAIS os fechados recentemente.
   *
   * As duas metades servem blocos diferentes do prompt e são fatos opostos —
   * "isto eu ainda não consigo" e "isto você já consegue" —, mas vêm da MESMA
   * tabela e do MESMO escopo. Um segundo `SELECT` para a segunda metade
   * custaria uma ida a mais no caminho mais quente do sistema (ver o orçamento
   * de round-trips em `tests/unit/turn-context-round-trips.spec.ts`), e o
   * `OR` abaixo é servido pelos dois índices parciais da migração 132.
   *
   * A JANELA existe porque um aviso de capacidade nova é notícia, não estado
   * permanente: depois dela, a ferramenta é só mais uma tool na caixa do
   * agente, e repetir o anúncio para sempre gastaria contexto todo turno.
   */
  async listParaOTurno(
    levels: GapLevel[],
    janelaDeAvisoEmDias: number,
  ): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const desde = new Date(Date.now() - janelaDeAvisoEmDias * 24 * 60 * 60 * 1000);
    const abertos =
      levels.length === 0
        ? undefined
        : and(
            inArray(agent_capability_gaps.current_level, levels),
            isNull(agent_capability_gaps.resolved_at),
          );
    const recemFechados = and(
      isNotNull(agent_capability_gaps.resolved_at),
      gte(agent_capability_gaps.resolved_at, desde),
    );
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          abertos === undefined ? recemFechados : or(abertos, recemFechados),
        ),
      );
  },

  /**
   * #638 — todos os gaps ABERTOS de um `tipo` neste escopo.
   *
   * É a entrada do monitor de fechamento: ele pergunta, gap a gap, se a
   * ferramenta que faltava já existe E está concedida. A pergunta é feita
   * sobre o gap ABERTO — um já fechado não volta a ser avaliado.
   */
  async listAbertosPorTipo(tipo: string): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          eq(agent_capability_gaps.tipo, tipo),
          isNull(agent_capability_gaps.resolved_at),
        ),
      );
  },

  /**
   * #638 — FECHA um gap, e só um ainda aberto.
   *
   * O `WHERE resolved_at IS NULL` não é zelo: ele torna o fechamento
   * idempotente sob cron. Duas passadas concorrentes do monitor não
   * sobrescrevem o motivo nem o instante do primeiro fechamento — a segunda
   * não colhe linha e devolve `null`, e o chamador sabe que não foi ele quem
   * fechou (e portanto não avisa o agente duas vezes).
   *
   * `current_level` NÃO é tocado: a história da escalada é a evidência que
   * justificou o pedido, e apagá-la ao fechar seria destruir o rastro no
   * momento exato em que ele passa a ser interessante.
   */
  async resolverGap(args: {
    id: string;
    reason: string;
    tool_name: string;
  }): Promise<AgentCapabilityGap | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(agent_capability_gaps)
      .set({
        resolved_at: new Date(),
        resolved_reason: args.reason,
        resolved_tool_name: args.tool_name,
      })
      .where(
        and(
          eq(agent_capability_gaps.id, args.id),
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          isNull(agent_capability_gaps.resolved_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  // P5: updateLevel — typed-args level setter scoped by the current
  // tenant/agent context (defense in depth: even with a leaked id from
  // another tenant, the WHERE clause filters it out). Sets
  // last_level_change_at = now() which the cooldown logic depends on.
  async updateLevel(args: { id: string; new_level: GapLevel }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(agent_capability_gaps)
      .set({ current_level: args.new_level, last_level_change_at: new Date() })
      .where(
        and(
          eq(agent_capability_gaps.id, args.id),
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
        ),
      );
  },

  // P5: daysSinceLastProposed — tenant/agent-wide MAX(last_level_change_at)
  // where current_level='proposed'. Used by the escalation engine to enforce
  // cooldown_days_proposed_to_proposed: do not raise another gap to 'proposed'
  // if the last one happened recently. Returns null if no gap was ever
  // promoted to 'proposed' for this (tenant, agent).
  async daysSinceLastProposed(): Promise<number | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ days: number | null }>(sql`
      SELECT EXTRACT(DAY FROM (now() - MAX(last_level_change_at)))::int AS days
        FROM agent_capability_gaps
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND current_level = 'proposed'
    `);
    const first = result.rows[0];
    if (!first) return null;
    return first.days ?? null;
  },

  // P5: create — straight insert via applyTenantGuard (no de-dup by
  // description like upsert does). Used by call-sites that already know
  // the gap is new — typically the dialogical-acquisition engine creating
  // technical_gap rows derived from a failed capability_test_result, where
  // grouping by description would be incorrect.
  async create(input: {
    capability_description: string;
    tipo: string;
    contexto?: string;
  }): Promise<AgentCapabilityGap> {
    const guarded = applyTenantGuard({
      capability_description: input.capability_description,
      tipo: input.tipo,
      contexto: input.contexto ?? null,
    });
    const [row] = await db
      .insert(agent_capability_gaps)
      .values(guarded as typeof agent_capability_gaps.$inferInsert)
      .returning();
    return row!;
  },
};

// P5: gap_escalation_rules — thresholds determinísticos por (tenant_id, agent_id)
// para a escalation chain (silent → dashboard → mentionable → proposed).
// Defaults vivem no schema; este repo expõe getForCurrentAgent (null se nenhuma
// regra customizada) e upsert (ON CONFLICT via UNIQUE(tenant_id, agent_id)).
export const gapEscalationRulesRepo = {
  async getForCurrentAgent(): Promise<GapEscalationRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(gap_escalation_rules)
      .where(
        and(
          eq(gap_escalation_rules.tenant_id, tenant_id),
          eq(gap_escalation_rules.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsert(input: Partial<NewGapEscalationRule>): Promise<GapEscalationRule> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Strip any tenant/agent the caller might have supplied — applyTenantGuard
    // semantics: context wins, mismatch throws.
    const { tenant_id: inTenant, agent_id: inAgent, ...rest } = input;
    if (inTenant && inTenant !== tenant_id) {
      throw new Error(`tenant mismatch: input ${inTenant} vs context ${tenant_id}`);
    }
    if (inAgent && inAgent !== agent_id) {
      throw new Error(`agent mismatch: input ${inAgent} vs context ${agent_id}`);
    }
    const now = new Date();
    const [row] = await db
      .insert(gap_escalation_rules)
      .values({
        ...rest,
        tenant_id,
        agent_id,
        updated_at: now,
      } as typeof gap_escalation_rules.$inferInsert)
      .onConflictDoUpdate({
        target: [gap_escalation_rules.tenant_id, gap_escalation_rules.agent_id],
        set: {
          ...rest,
          updated_at: now,
        },
      })
      .returning();
    return row!;
  },
};

// P5: capability_proposals — propostas formais de capability (spec gerada por
// LLM no nível 'proposed'). Fluxo de status:
//   draft → submitted → approved | rejected
//   approved → delivered
//   rejected | delivered = terminal
// transition() é typed-result (sem throw): { ok:true, updated } | { ok:false,
// reason: 'not_found' | 'invalid_transition' }. Cada transição seta um
// timestamp (submitted_at | decided_at | delivered_at) + campos opcionais
// (decided_by, decision_reason, delivery_artifact_ref).
// P9a — extended capability_type set (migration 044). 'skill' enables
// the P9a Skill Registry to flow proposals through the same approval inbox;
// 'soul_bias' / 'policy_rule' / 'holiday' antecipam P8e/P9b/scheduling sem
// ativar uso até o respectivo phase.
// #636 — 'tool_request' é o pedido de ferramenta: o gap recorrente que exige
// uma tool que NÃO EXISTE, virado documento estruturado para um dev avaliar.
// Distinto de 'tool' de propósito: 'tool' é a spec genérica que o LLM escreve
// para uma capability qualquer; 'tool_request' carrega intenção, situações com
// link de trace, janela de frequência e um RASCUNHO de contrato Zod — e é
// INERTE por construção (nada nele registra tool ou cria capability).
export type CapabilityProposalType =
  | 'tool'
  | 'knowledge'
  | 'procedure'
  | 'integration'
  | 'other'
  | 'skill'
  | 'soul_bias'
  | 'policy_rule'
  | 'holiday'
  | 'tool_request';

export const capabilityProposalsRepo = {
  async create(input: {
    gap_id?: string;
    capability_type: CapabilityProposalType;
    title: string;
    description: string;
    proposed_spec: unknown;
    motivation: string;
    expected_impact?: string;
    test_scenarios: unknown[];
  }): Promise<CapabilityProposal> {
    const guarded = applyTenantGuard({
      gap_id: input.gap_id ?? null,
      capability_type: input.capability_type,
      title: input.title,
      description: input.description,
      proposed_spec: input.proposed_spec as object,
      motivation: input.motivation,
      expected_impact: input.expected_impact ?? null,
      test_scenarios: input.test_scenarios as unknown as object,
    });
    const [row] = await db
      .insert(capability_proposals)
      .values(guarded as typeof capability_proposals.$inferInsert)
      .returning();
    return row!;
  },

  // PR #87 follow-up — transactional variant of create. Writes via the
  // caller-supplied `tx` handle so the INSERT participates in an outer
  // withTx block. Pairs with capabilityGapsRepo.updateLevelTx so the
  // gap-escalation worker can commit the proposal artifact and the gap
  // level flip in a single transaction; transient failure during the
  // gap UPDATE rolls back the proposal INSERT so the next worker tick
  // does NOT produce a duplicate proposal row.
  async createTx(
    tx: typeof db,
    input: {
      gap_id?: string;
      capability_type: CapabilityProposalType;
      title: string;
      description: string;
      proposed_spec: unknown;
      motivation: string;
      expected_impact?: string;
      test_scenarios: unknown[];
    },
  ): Promise<CapabilityProposal> {
    const guarded = applyTenantGuard({
      gap_id: input.gap_id ?? null,
      capability_type: input.capability_type,
      title: input.title,
      description: input.description,
      proposed_spec: input.proposed_spec as object,
      motivation: input.motivation,
      expected_impact: input.expected_impact ?? null,
      test_scenarios: input.test_scenarios as unknown as object,
    });
    const [row] = await tx
      .insert(capability_proposals)
      .values(guarded as typeof capability_proposals.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<CapabilityProposal | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: ProposalStatus): Promise<CapabilityProposal[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.status, status),
        ),
      )
      .orderBy(desc(capability_proposals.created_at));
  },

  async listByGap(gap_id: string): Promise<CapabilityProposal[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.gap_id, gap_id),
        ),
      )
      .orderBy(desc(capability_proposals.created_at));
  },

  // Validated state-machine transition. Retorna typed result, sem throw.
  // - not_found:           id desconhecido (ou fora do tenant/agent atual)
  // - invalid_transition:  destino não permitido a partir do source, mesmo
  //                        status (re-entrada), ou origem terminal
  //                        (rejected/reverted).
  //
  // P87-C3 (PR #87 review): activation gate. A transição approved → delivered
  // foi removida — agora exige caminho approved → testing → delivered (sucesso)
  // ou approved → testing → reverted (falha). A wiring é feita por
  // activateApprovedCapability (capability-test-runner.ts), que é o ÚNICO
  // caller production-grade do trio approved → testing → {delivered|reverted}.
  // Chamadas diretas a transition({to:'delivered'}) continuam permitidas a
  // partir de 'testing', NUNCA a partir de 'approved'.
  //
  // Side effects (timestamps + opcionais):
  //   to:'submitted' → submitted_at
  //   to:'approved'  → decided_at + decided_by? + decision_reason?
  //   to:'rejected'  → decided_at + decided_by? + decision_reason?
  //   to:'testing'   → (sem timestamp dedicado; updated_at marca)
  //   to:'delivered' → delivered_at + delivery_artifact_ref?
  //                    + last_test_outcome? + last_test_at?
  //   to:'reverted'  → reverted_at + revert_reason?
  //                    + last_test_outcome? + last_test_at?
  async transition(args: {
    id: string;
    to: ProposalStatus;
    decided_by?: string;
    decision_reason?: string;
    delivery_artifact_ref?: string;
    revert_reason?: string;
    last_test_outcome?: 'pass' | 'fail' | 'error';
  }): Promise<
    | { ok: true; updated: CapabilityProposal }
    | { ok: false; reason: 'not_found' | 'invalid_transition' }
  > {
    const row = await capabilityProposalsRepo.getById(args.id);
    if (!row) return { ok: false, reason: 'not_found' };

    const from = row.status as ProposalStatus;
    // Terminal sources — no further transitions.
    if (from === 'rejected' || from === 'reverted') {
      return { ok: false, reason: 'invalid_transition' };
    }
    if (from === args.to) {
      return { ok: false, reason: 'invalid_transition' };
    }

    const allowed: Record<string, readonly string[]> = {
      draft: ['submitted'],
      submitted: ['approved', 'rejected'],
      approved: ['testing'],
      testing: ['delivered', 'reverted'],
      // P87-C3 — delivered → reverted permitido (Superpowers Important #2):
      // tools can fail after activation; revert tooling pode marcar a row.
      delivered: ['reverted'],
    };
    if (!allowed[from]?.includes(args.to)) {
      return { ok: false, reason: 'invalid_transition' };
    }

    const now = new Date();
    const patch: Record<string, unknown> = { status: args.to, updated_at: now };
    if (args.to === 'submitted') {
      patch.submitted_at = now;
    } else if (args.to === 'approved' || args.to === 'rejected') {
      patch.decided_at = now;
      if (args.decided_by) patch.decided_by = args.decided_by;
      if (args.decision_reason) patch.decision_reason = args.decision_reason;
    } else if (args.to === 'delivered') {
      patch.delivered_at = now;
      if (args.delivery_artifact_ref)
        patch.delivery_artifact_ref = args.delivery_artifact_ref;
      if (args.last_test_outcome) {
        patch.last_test_outcome = args.last_test_outcome;
        patch.last_test_at = now;
      }
    } else if (args.to === 'reverted') {
      patch.reverted_at = now;
      if (args.revert_reason) patch.revert_reason = args.revert_reason;
      if (args.last_test_outcome) {
        patch.last_test_outcome = args.last_test_outcome;
        patch.last_test_at = now;
      }
    }

    const [updated] = await db
      .update(capability_proposals)
      .set(patch as Partial<typeof capability_proposals.$inferInsert>)
      .where(eq(capability_proposals.id, args.id))
      .returning();
    return { ok: true, updated: updated! };
  },
};

// P5: capability_test_results — auditoria do loop fechado pós-ativação. Cada
// run dos test_scenarios da proposal gera uma linha; outcome=fail/error pode
// disparar triggered_revert=true e criar um technical_gap_id (gap derivado
// para investigação). Reads ordenam por ran_at DESC (mais recente primeiro).
export const capabilityTestResultsRepo = {
  async record(input: {
    proposal_id: string;
    gap_id?: string;
    outcome: 'pass' | 'fail' | 'error';
    scenarios_run: unknown[];
    scenarios_passed: number;
    scenarios_failed: number;
    details?: unknown;
    triggered_revert?: boolean;
    technical_gap_id?: string;
  }): Promise<CapabilityTestResult> {
    // PR #87 Minor #3: defensive parity. applyTenantGuard injeta tenant/agent
    // do contexto atual, mas NÃO valida que technical_gap_id (passado pelo
    // caller) pertence ao mesmo tenant. Hoje a chain (capability-test-runner
    // → revertCapability → capabilityGapsRepo.create) sempre cria o gap
    // dentro do mesmo tenant context, então o id retornado é seguro — mas
    // callers futuros poderiam quebrar essa premissa. Faz cross-check
    // explícito para fechar a porta agora.
    if (input.technical_gap_id) {
      const tenant_id = getCurrentTenant();
      const agent_id = getCurrentAgent();
      const rows = await db
        .select({ id: agent_capability_gaps.id })
        .from(agent_capability_gaps)
        .where(
          and(
            eq(agent_capability_gaps.id, input.technical_gap_id),
            eq(agent_capability_gaps.tenant_id, tenant_id),
            eq(agent_capability_gaps.agent_id, agent_id),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new Error('capability_test_results.technical_gap_id_cross_tenant');
      }
    }
    const guarded = applyTenantGuard({
      proposal_id: input.proposal_id,
      gap_id: input.gap_id ?? null,
      outcome: input.outcome,
      scenarios_run: input.scenarios_run as unknown as object,
      scenarios_passed: input.scenarios_passed,
      scenarios_failed: input.scenarios_failed,
      details: (input.details ?? {}) as object,
      triggered_revert: input.triggered_revert ?? false,
      technical_gap_id: input.technical_gap_id ?? null,
    });
    const [row] = await db
      .insert(capability_test_results)
      .values(guarded as typeof capability_test_results.$inferInsert)
      .returning();
    return row!;
  },

  async listByProposal(proposal_id: string): Promise<CapabilityTestResult[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_test_results)
      .where(
        and(
          eq(capability_test_results.tenant_id, tenant_id),
          eq(capability_test_results.agent_id, agent_id),
          eq(capability_test_results.proposal_id, proposal_id),
        ),
      )
      .orderBy(desc(capability_test_results.ran_at));
  },

  async latestByProposal(proposal_id: string): Promise<CapabilityTestResult | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(capability_test_results)
      .where(
        and(
          eq(capability_test_results.tenant_id, tenant_id),
          eq(capability_test_results.agent_id, agent_id),
          eq(capability_test_results.proposal_id, proposal_id),
        ),
      )
      .orderBy(desc(capability_test_results.ran_at))
      .limit(1);
    return rows[0] ?? null;
  },
};

/**
 * #637 (fatia B da épica #471) — o repositório do AGRUPAMENTO de pedidos de
 * ferramenta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODA LEITURA E TODA ESCRITA SÃO ESCOPADAS POR (tenant_id, agent_id)
 * ─────────────────────────────────────────────────────────────────────────────
 * Isso não é zelo genérico: é a defesa central desta fatia. A agregação COMPARA
 * o texto de um pedido com o texto de outro. Se a busca por candidato saísse do
 * escopo, a demanda de um cliente entraria no contador de outro — e o vazamento
 * seria pelo caminho mais difícil de notar, porque o resultado é só um número
 * maior. Por isso:
 *
 *   · `candidatosParaFusao` filtra por tenant+agent ANTES de comparar, e nunca
 *     recebe escopo por parâmetro (ele vem do ALS, sempre);
 *   · `id` NUNCA é fronteira de isolamento (#367/#368): todo método que recebe
 *     um `aggregate_id` também filtra por tenant+agent, então um id vazado de
 *     outro escopo não colhe linha nenhuma;
 *   · o teste de leak (`tests/integration/tool-request-aggregation-real-db.spec.ts`)
 *     prova as duas coisas com dado semeado adversarialmente: pedidos IDÊNTICOS
 *     em dois tenants.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O CONTADOR É RECALCULADO, NUNCA INCREMENTADO
 * ─────────────────────────────────────────────────────────────────────────────
 * `member_count` e `total_occurrences` são materializados para a listagem da
 * triagem, mas toda escrita os recomputa a partir das linhas ATIVAS de
 * `tool_request_aggregate_members`. Um contador incrementado diverge da
 * realidade em silêncio no primeiro erro (uma retentativa, um destaque, um
 * membro que entrou por outro caminho); um recalculado não tem como divergir
 * sem que a tabela de membros esteja errada — e essa é a tabela que a auditoria
 * lê de qualquer jeito.
 */
export const toolRequestAggregatesRepo = {
  /**
   * Os agregados DESTE escopo comparáveis com uma assinatura da versão dada.
   *
   * Só entram agregados da MESMA `assinatura_version`: uma assinatura produzida
   * por outra regra não é comparável com esta, e comparar mesmo assim produziria
   * um número de similaridade que não significa nada.
   */
  async candidatosParaFusao(assinatura_version: number): Promise<ToolRequestAggregate[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(tool_request_aggregates)
      .where(
        and(
          eq(tool_request_aggregates.tenant_id, tenant_id),
          eq(tool_request_aggregates.agent_id, agent_id),
          eq(tool_request_aggregates.assinatura_version, assinatura_version),
        ),
      )
      .orderBy(desc(tool_request_aggregates.last_member_at));
  },

  async findById(aggregate_id: string): Promise<ToolRequestAggregate | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(tool_request_aggregates)
      .where(
        and(
          eq(tool_request_aggregates.tenant_id, tenant_id),
          eq(tool_request_aggregates.agent_id, agent_id),
          eq(tool_request_aggregates.id, aggregate_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Os membros ATIVOS de um agregado, na ordem em que entraram. */
  async membrosAtivos(aggregate_id: string): Promise<ToolRequestAggregateMember[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(tool_request_aggregate_members)
      .where(
        and(
          eq(tool_request_aggregate_members.tenant_id, tenant_id),
          eq(tool_request_aggregate_members.agent_id, agent_id),
          eq(tool_request_aggregate_members.aggregate_id, aggregate_id),
          isNull(tool_request_aggregate_members.detached_at),
        ),
      )
      .orderBy(tool_request_aggregate_members.joined_at);
  },

  /**
   * TODAS as linhas de membro deste gap — inclusive as DESTACADAS.
   *
   * As destacadas são o que impede o worker de desfazer sozinho, na rodada
   * seguinte, um destaque que um humano fez: um gap já destacado de um agregado
   * não volta a ele por similaridade. Sem esta leitura, "reversível" duraria até
   * o próximo cron.
   */
  async membrosDoGap(gap_id: string): Promise<ToolRequestAggregateMember[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(tool_request_aggregate_members)
      .where(
        and(
          eq(tool_request_aggregate_members.tenant_id, tenant_id),
          eq(tool_request_aggregate_members.agent_id, agent_id),
          eq(tool_request_aggregate_members.gap_id, gap_id),
        ),
      );
  },

  /**
   * Um membro pelo id — escopado, porque `id` NUNCA é fronteira de isolamento
   * (#367/#368): um id vazado de outro tenant não colhe linha.
   */
  async membroPorId(member_id: string): Promise<ToolRequestAggregateMember | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(tool_request_aggregate_members)
      .where(
        and(
          eq(tool_request_aggregate_members.tenant_id, tenant_id),
          eq(tool_request_aggregate_members.agent_id, agent_id),
          eq(tool_request_aggregate_members.id, member_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Cria o agregado com o seu primeiro membro — o REPRESENTANTE. */
  async criarComRepresentante(input: {
    assinatura: string;
    assinatura_version: number;
    metrica: string;
    limiar: number;
    representative_proposal_id: string;
    representative_gap_id: string;
    proposed_tool_name: string;
    nomes_propostos: string[];
    contract_state: string;
    merged_contract_draft: unknown;
    contract_conflicts: unknown;
    intent: string;
    occurrences: number;
    original_spec: unknown;
  }): Promise<{ agregado: ToolRequestAggregate; membro: ToolRequestAggregateMember }> {
    const agregadoGuardado = applyTenantGuard({
      assinatura: input.assinatura,
      assinatura_version: input.assinatura_version,
      metrica: input.metrica,
      limiar: input.limiar.toFixed(4),
      representative_proposal_id: input.representative_proposal_id,
      representative_gap_id: input.representative_gap_id,
      proposed_tool_name: input.proposed_tool_name,
      nomes_propostos: input.nomes_propostos,
      member_count: 1,
      total_occurrences: input.occurrences,
      contract_state: input.contract_state,
      merged_contract_draft: input.merged_contract_draft ?? null,
      contract_conflicts: input.contract_conflicts ?? [],
    });
    const [agregado] = await db
      .insert(tool_request_aggregates)
      .values(agregadoGuardado as typeof tool_request_aggregates.$inferInsert)
      .returning();

    const membroGuardado = applyTenantGuard({
      aggregate_id: agregado!.id,
      gap_id: input.representative_gap_id,
      proposal_id: input.representative_proposal_id,
      is_representative: true,
      assinatura: input.assinatura,
      assinatura_version: input.assinatura_version,
      metrica: input.metrica,
      limiar: input.limiar.toFixed(4),
      // O representante é comparado consigo mesmo. `1.0000` não é enfeite: é o
      // que faz a coluna ter o mesmo significado em toda linha.
      similaridade: '1.0000',
      intent: input.intent,
      occurrences: input.occurrences,
      original_spec: input.original_spec,
    });
    const [membro] = await db
      .insert(tool_request_aggregate_members)
      .values(membroGuardado as typeof tool_request_aggregate_members.$inferInsert)
      .returning();

    return { agregado: agregado!, membro: membro! };
  },

  /**
   * Acrescenta um membro a um agregado existente. NÃO cria proposta: é aqui
   * que N pedidos viram 1.
   */
  async acrescentarMembro(input: {
    aggregate_id: string;
    gap_id: string;
    assinatura: string;
    assinatura_version: number;
    metrica: string;
    limiar: number;
    similaridade: number;
    intent: string;
    occurrences: number;
    original_spec: unknown;
  }): Promise<ToolRequestAggregateMember> {
    const guardado = applyTenantGuard({
      aggregate_id: input.aggregate_id,
      gap_id: input.gap_id,
      proposal_id: null,
      is_representative: false,
      assinatura: input.assinatura,
      assinatura_version: input.assinatura_version,
      metrica: input.metrica,
      limiar: input.limiar.toFixed(4),
      similaridade: input.similaridade.toFixed(4),
      intent: input.intent,
      occurrences: input.occurrences,
      original_spec: input.original_spec,
    });
    const [row] = await db
      .insert(tool_request_aggregate_members)
      .values(guardado as typeof tool_request_aggregate_members.$inferInsert)
      .returning();
    return row!;
  },

  /**
   * Reescreve o CONTADOR e o estado do contrato a partir dos membros ativos.
   *
   * Recebe os números já calculados porque a política de fusão de rascunhos
   * (`draft-merge.ts`) é lógica de cognição e não pertence ao repositório; o
   * que pertence aqui é a escrita escopada.
   */
  async atualizarAgregado(input: {
    aggregate_id: string;
    member_count: number;
    total_occurrences: number;
    contract_state: string;
    merged_contract_draft: unknown;
    contract_conflicts: unknown;
    nomes_propostos: string[];
    last_member_at?: Date;
  }): Promise<ToolRequestAggregate | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(tool_request_aggregates)
      .set({
        member_count: input.member_count,
        total_occurrences: input.total_occurrences,
        contract_state: input.contract_state,
        merged_contract_draft: input.merged_contract_draft ?? null,
        contract_conflicts: input.contract_conflicts ?? [],
        nomes_propostos: input.nomes_propostos,
        ...(input.last_member_at ? { last_member_at: input.last_member_at } : {}),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tool_request_aggregates.tenant_id, tenant_id),
          eq(tool_request_aggregates.agent_id, agent_id),
          eq(tool_request_aggregates.id, input.aggregate_id),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * DESTACA um membro: marca `detached_at`, e NUNCA apaga.
   *
   * O `UPDATE` exige `detached_at IS NULL` para que dois destaques concorrentes
   * não sobrescrevam o motivo do primeiro — quem chegou depois não colhe linha e
   * o chamador sabe disso pelo `null`.
   */
  async destacarMembro(input: {
    member_id: string;
    reason: string;
    by: string | null;
  }): Promise<ToolRequestAggregateMember | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(tool_request_aggregate_members)
      .set({
        detached_at: new Date(),
        detached_reason: input.reason,
        detached_by: input.by,
      })
      .where(
        and(
          eq(tool_request_aggregate_members.tenant_id, tenant_id),
          eq(tool_request_aggregate_members.agent_id, agent_id),
          eq(tool_request_aggregate_members.id, input.member_id),
          isNull(tool_request_aggregate_members.detached_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /** Todos os agregados DESTE escopo, do mais demandado para o menos. */
  async listarDoEscopo(): Promise<ToolRequestAggregate[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(tool_request_aggregates)
      .where(
        and(
          eq(tool_request_aggregates.tenant_id, tenant_id),
          eq(tool_request_aggregates.agent_id, agent_id),
        ),
      )
      .orderBy(
        desc(tool_request_aggregates.member_count),
        desc(tool_request_aggregates.last_member_at),
      );
  },
};

/**
 * #638 (fatia C da épica #471) — o repositório do ACEITE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A RESERVA VEM ANTES DA CHAMADA EXTERNA. SEMPRE.
 * ─────────────────────────────────────────────────────────────────────────────
 * `reservar` é o método que faz "aceitar duas vezes cria UMA issue" ser
 * verdade, e ele funciona porque NÃO tenta ser esperto: um `INSERT ... ON
 * CONFLICT DO NOTHING` contra a UNIQUE (tenant_id, agent_id, aggregate_id). O
 * segundo clique não colhe linha, lê a existente e devolve `ja_existia`. A
 * decisão é do BANCO, e por isso vale para dois cliques simultâneos em duas
 * abas, dois processos do console e duas réplicas.
 *
 * Fazer o contrário — consultar, decidir em JS, inserir — deixaria aberta a
 * janela entre a consulta e o insert, que é exatamente onde dois cliques
 * rápidos caem.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODA LEITURA E ESCRITA DE ESCOPO SÃO POR (tenant_id, agent_id)
 * ─────────────────────────────────────────────────────────────────────────────
 * `id` nunca é fronteira de isolamento (#367/#368). A exceção declarada é
 * `listarPendentesCrossTenant`, que roda FORA de contexto de tenant porque é o
 * dispatcher do relayer — o mesmo padrão de fan-out por work-table dos outros
 * workers (#240/#251/#292). Ela devolve o escopo de cada linha justamente para
 * que o chamador ABRA o contexto certo antes de tocar em qualquer outra coisa.
 */
export const toolRequestIssuesRepo = {
  /**
   * Cria a reserva do aceite, ou devolve a que já existe.
   *
   * `ja_existia` é informação, não erro: é o que o console mostra quando o dono
   * clica de novo ("já aceito, issue #123"), em vez de uma mensagem de falha
   * que sugeriria que o aceite não valeu.
   */
  async reservar(input: {
    aggregate_id: string;
    idempotency_key: string;
    repo_slug: string;
    title: string;
    body: string;
    accepted_by: string;
  }): Promise<{ linha: ToolRequestIssue; ja_existia: boolean }> {
    const inseridas = await db
      .insert(tool_request_issues)
      .values(applyTenantGuard({ ...input, status: 'pending' }))
      .onConflictDoNothing()
      .returning();
    if (inseridas[0]) return { linha: inseridas[0], ja_existia: false };

    const existente = await this.porAgregado(input.aggregate_id);
    if (existente) return { linha: existente, ja_existia: true };
    // Conflito sem linha visível NESTE escopo só acontece se a UNIQUE global de
    // `idempotency_key` bateu com outro escopo — isto é, a derivação da chave
    // está errada. Falhar alto: silenciar produziria um aceite que não existe.
    throw new Error(
      'tool_request_issues: conflito de idempotency_key sem linha no escopo — ' +
        'a derivação da chave não está incluindo tenant+agent',
    );
  },

  async porAgregado(aggregate_id: string): Promise<ToolRequestIssue | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(tool_request_issues)
      .where(
        and(
          eq(tool_request_issues.tenant_id, tenant_id),
          eq(tool_request_issues.agent_id, agent_id),
          eq(tool_request_issues.aggregate_id, aggregate_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Todas as reservas DESTE escopo — o que a triagem mostra ao lado de cada pedido. */
  async listarDoEscopo(): Promise<ToolRequestIssue[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(tool_request_issues)
      .where(
        and(
          eq(tool_request_issues.tenant_id, tenant_id),
          eq(tool_request_issues.agent_id, agent_id),
        ),
      )
      .orderBy(desc(tool_request_issues.accepted_at));
  },

  /**
   * A FILA do relayer, cross-tenant. Roda fora de contexto de tenant — é o
   * dispatcher que decide em que escopos entrar, e devolve o escopo de cada
   * linha para que ele o abra antes de tocar em qualquer outra coisa.
   */
  async listarPendentesCrossTenant(limite: number): Promise<ToolRequestIssue[]> {
    return db
      .select()
      .from(tool_request_issues)
      .where(eq(tool_request_issues.status, 'pending'))
      .orderBy(tool_request_issues.accepted_at)
      .limit(limite);
  },

  /**
   * Registra o desfecho da chamada externa.
   *
   * O `WHERE status = 'pending'` é o que impede uma retentativa atrasada de
   * sobrescrever um resultado já gravado — dois relayers concorrentes, ou um
   * relayer lento que voltou depois de outro ter concluído.
   */
  async registrarResultado(input: {
    id: string;
    status: 'created' | 'failed';
    issue_number?: number | null;
    issue_url?: string | null;
    adopted?: boolean;
    last_error?: string | null;
  }): Promise<ToolRequestIssue | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(tool_request_issues)
      .set({
        status: input.status,
        issue_number: input.issue_number ?? null,
        issue_url: input.issue_url ?? null,
        adopted: input.adopted ?? false,
        last_error: input.last_error ?? null,
        last_attempt_at: new Date(),
        attempts: sql`${tool_request_issues.attempts} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tool_request_issues.tenant_id, tenant_id),
          eq(tool_request_issues.agent_id, agent_id),
          eq(tool_request_issues.id, input.id),
          eq(tool_request_issues.status, 'pending'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Uma tentativa que falhou de forma RECUPERÁVEL: conta a tentativa e guarda
   * o erro, mas a linha continua `pending` e volta para a fila.
   *
   * O erro guardado é a mensagem JÁ HIGIENIZADA pelo chamador. Este método não
   * sabe o que é credencial e não deve saber — quem chama é quem tem contato
   * com o token, e é lá que a higienização pertence.
   */
  async registrarTentativaFalha(input: { id: string; last_error: string }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(tool_request_issues)
      .set({
        last_error: input.last_error,
        last_attempt_at: new Date(),
        attempts: sql`${tool_request_issues.attempts} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tool_request_issues.tenant_id, tenant_id),
          eq(tool_request_issues.agent_id, agent_id),
          eq(tool_request_issues.id, input.id),
          eq(tool_request_issues.status, 'pending'),
        ),
      );
  },
};

/**
 * #638 — o repositório do AVISO ao agente.
 *
 * A UNIQUE por gap está na migração; aqui o `onConflictDoNothing` a usa para
 * que o monitor em cron não reavise. `criada` distingue "avisei agora" de "já
 * estava avisado", e essa distinção é o que impede o chamador de auditar um
 * aviso que não aconteceu.
 */
export const toolRequestNotificationsRepo = {
  async avisar(input: {
    gap_id: string;
    aggregate_id: string | null;
    tool_name: string;
    evidencia: unknown;
  }): Promise<{ linha: ToolRequestNotification | null; criada: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .insert(tool_request_notifications)
      .values(applyTenantGuard(input))
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return { linha: rows[0], criada: true };
    const existentes = await db
      .select()
      .from(tool_request_notifications)
      .where(
        and(
          eq(tool_request_notifications.tenant_id, tenant_id),
          eq(tool_request_notifications.agent_id, agent_id),
          eq(tool_request_notifications.gap_id, input.gap_id),
        ),
      )
      .limit(1);
    return { linha: existentes[0] ?? null, criada: false };
  },

  /** Os avisos DESTE escopo, do mais recente para o mais antigo. */
  async listarDoEscopo(limite: number): Promise<ToolRequestNotification[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(tool_request_notifications)
      .where(
        and(
          eq(tool_request_notifications.tenant_id, tenant_id),
          eq(tool_request_notifications.agent_id, agent_id),
        ),
      )
      .orderBy(desc(tool_request_notifications.notified_at))
      .limit(limite);
  },
};
