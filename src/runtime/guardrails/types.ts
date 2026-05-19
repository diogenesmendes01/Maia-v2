/**
 * P9b — Guardrails layer (Camada 5) types for Late PEP.
 *
 * Spec §4.3.
 */
import type {
  DecisionPacket,
  PolicyDecision,
} from '../context-packet/types.js';
import type { PolicyEvaluator, PolicyRulesRepo } from '../decision/types.js';

/** Output candidate produced by the agent runtime (Layer 4). */
export interface AgentOutputCandidate {
  trace_id: string;
  skill_id: string;
  raw_text?: string;
  structured_output?: Record<string, unknown>;
  tool_calls?: Array<{
    tool_name: string;
    args: Record<string, unknown>;
    idempotency_key?: string;
  }>;
  meta: {
    model: string;
    tokens_used: number;
    duration_ms: number;
  };
}

/**
 * Execution context packet (Layer 3 assembly output).
 *
 * TODO(P8a #96): Replace with full ExecutionContextPacket from P8a. P9b
 * uses a minimal subset sufficient for Late PEP.
 */
export interface ExecutionContextPacket {
  trace_id: string;
  skill: {
    selected_skill?: {
      id: string;
      output_schema_ref?: string;
    };
  };
  policy: {
    applicable_rules: Array<{
      policy_id: string;
      rule_descriptor: string;
      applies_to_peps: ReadonlyArray<'early' | 'mid' | 'late'>;
    }>;
  };
}

export interface PolicyValidationResult {
  passed: boolean;
  policy_decisions: Array<{
    pep: 'late';
    policy_id: string;
    rule_descriptor: string;
    decision: PolicyDecision;
    reason: string;
  }>;
  modifications?: {
    redacted_text?: string;
    blocked_tool_calls?: string[];
  };
  final_action: 'send' | 'block' | 'escalate' | 'regenerate';
}

export interface LatePep {
  validate(
    candidate: AgentOutputCandidate,
    execContext: ExecutionContextPacket,
    decision: DecisionPacket,
    options?: { signal?: AbortSignal },
  ): Promise<PolicyValidationResult>;
}

/**
 * Schema validator stub (Late PEP step 1).
 *
 * Round-2 finding 4: `signal` lets callers cancel slow schema validation
 * (e.g. remote registry fetch) when an upstream deadline fires.
 */
export interface SkillSchemaValidator {
  validate(
    output: unknown,
    schemaRef: string | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<{ valid: boolean; errors: string[] }>;
}

export interface LatePepDeps {
  skillSchemaValidator: SkillSchemaValidator;
  policyRepo: PolicyRulesRepo;
  evaluator: PolicyEvaluator;
}
