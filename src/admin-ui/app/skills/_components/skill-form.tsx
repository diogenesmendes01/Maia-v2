'use client';

/**
 * Admin UI — Skill propose form (Phase 3).
 *
 * Authoring form for a NEW skill version, gated to `founder` by the parent
 * page (the propose mutation re-enforces the role server-side). Fields mirror
 * the SkillContract (src/db/schema.ts:1988) plus the audited `proposed_reason`:
 *   - skill_descriptor / goal / when_to_use — plain text.
 *   - category / execution_mode — <select> over the DB check-constraint enums.
 *   - procedure / constraints / input_schema / output_schema / success_criteria
 *     / failure_modes / runtime_hints — JSON textareas with client-side
 *     JSON.parse validation + inline error (spec v1: no structured builder).
 *   - allowed_tools — a multi-select FED BY trpc.toolsCatalog.listCatalog (the
 *     Phase-1 catalog coupling). DISABLED + cleared when execution_mode is
 *     'evaluator' (mirrors the repo + router cross-field rule: evaluators MUST
 *     have empty allowed_tools).
 *   - policy_descriptors — comma/newline tag input.
 *   - proposed_reason — textarea, min 10 (the audit reason).
 *
 * On submit the JSON fields are parsed locally; only when every field parses do
 * we call the propose mutation. Success closes the form + lets the parent
 * invalidate the list.
 *
 * Server boundary: this file imports NOTHING from backend modules — only the
 * tRPC client. The catalog + propose payloads are plain JSON.
 */

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';

const CATEGORIES = [
  'classify',
  'extract',
  'compose',
  'decide',
  'tool_mediated',
  'diagnose',
  'plan',
  'evaluator',
] as const;

const EXECUTION_MODES = [
  'prompt_only',
  'procedure_adapter',
  'tool_mediated',
  'evaluator',
] as const;

type Category = (typeof CATEGORIES)[number];
type ExecutionMode = (typeof EXECUTION_MODES)[number];

// The JSON-textarea fields and their expected container kind, so we can show a
// precise inline parse/shape error per field.
type JsonField =
  | 'procedure'
  | 'constraints'
  | 'input_schema'
  | 'output_schema'
  | 'success_criteria'
  | 'failure_modes'
  | 'runtime_hints';

const JSON_FIELD_KIND: Record<JsonField, 'object' | 'array'> = {
  procedure: 'object',
  constraints: 'array',
  input_schema: 'object',
  output_schema: 'object',
  success_criteria: 'array',
  failure_modes: 'array',
  runtime_hints: 'object',
};

const JSON_FIELD_LABEL: Record<JsonField, string> = {
  procedure: 'Procedure (JSON object)',
  constraints: 'Constraints (JSON array)',
  input_schema: 'Input schema (JSON object)',
  output_schema: 'Output schema (JSON object)',
  success_criteria: 'Success criteria (JSON array)',
  failure_modes: 'Failure modes (JSON array)',
  runtime_hints: 'Runtime hints (JSON object)',
};

const DEFAULT_JSON: Record<JsonField, string> = {
  procedure: '{}',
  constraints: '[]',
  input_schema: '{}',
  output_schema: '{}',
  success_criteria: '[]',
  failure_modes: '[]',
  runtime_hints: '{}',
};

type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function parseJsonField(raw: string, kind: 'object' | 'array'): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (kind === 'array') {
    if (!Array.isArray(value)) return { ok: false, error: 'Must be a JSON array.' };
  } else {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'Must be a JSON object.' };
    }
  }
  return { ok: true, value };
}

// Split a comma/newline separated tag input into a trimmed, de-duped list.
function parseTags(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}

export function SkillForm({
  tenantId,
  agentId,
  onClose,
  onProposed,
}: {
  tenantId: string;
  agentId: string;
  onClose: () => void;
  onProposed: () => void;
}) {
  const [descriptor, setDescriptor] = React.useState('');
  const [category, setCategory] = React.useState<Category>('classify');
  const [executionMode, setExecutionMode] =
    React.useState<ExecutionMode>('prompt_only');
  const [goal, setGoal] = React.useState('');
  const [whenToUse, setWhenToUse] = React.useState('');
  const [jsonFields, setJsonFields] =
    React.useState<Record<JsonField, string>>(DEFAULT_JSON);
  const [allowedTools, setAllowedTools] = React.useState<string[]>([]);
  const [policyDescriptors, setPolicyDescriptors] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [jsonErrors, setJsonErrors] = React.useState<
    Partial<Record<JsonField, string>>
  >({});

  const isEvaluator = executionMode === 'evaluator';

  // allowed_tools picker source = the Phase-1 Tools Catalog (the coupling).
  const catalogQuery = trpc.toolsCatalog.listCatalog.useQuery();
  const tools = catalogQuery.data ?? [];
  // FIX 3 (PR #213): the set of tools the operator may actually select. A
  // disabled tool (its gating flag is off) is filtered out of allowed_tools on
  // submit so we never send a tool the server will reject. The server enforces
  // the same rule authoritatively (skills.propose).
  const enabledToolNames = React.useMemo(
    () => new Set(tools.filter((t) => t.enabled).map((t) => t.name)),
    [tools],
  );

  // Evaluator skills MUST have empty allowed_tools (repo + router rule). Clear
  // any selection the moment the operator switches to evaluator so the form
  // state matches what the server will accept.
  React.useEffect(() => {
    if (isEvaluator && allowedTools.length > 0) setAllowedTools([]);
  }, [isEvaluator, allowedTools.length]);

  const proposeMutation = trpc.skills.propose.useMutation({
    onSuccess: () => {
      onProposed();
      onClose();
    },
  });

  const reasonOk = reason.trim().length >= 10;
  const descriptorOk = descriptor.trim().length > 0;
  const goalOk = goal.trim().length > 0;
  const whenOk = whenToUse.trim().length > 0;

  const setJson = (field: JsonField, raw: string) => {
    setJsonFields((prev) => ({ ...prev, [field]: raw }));
  };

  const toggleTool = (name: string) => {
    setAllowedTools((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Parse every JSON field; collect per-field errors. Bail before the
    // mutation if any field is invalid so the operator fixes them inline.
    const parsed: Partial<Record<JsonField, unknown>> = {};
    const errors: Partial<Record<JsonField, string>> = {};
    (Object.keys(JSON_FIELD_KIND) as JsonField[]).forEach((field) => {
      const res = parseJsonField(jsonFields[field], JSON_FIELD_KIND[field]);
      if (res.ok) parsed[field] = res.value;
      else errors[field] = res.error;
    });
    setJsonErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (!descriptorOk || !goalOk || !whenOk || !reasonOk) return;

    try {
      await proposeMutation.mutateAsync({
        tenantId,
        agentId,
        skill_descriptor: descriptor.trim(),
        category,
        execution_mode: executionMode,
        goal: goal.trim(),
        when_to_use: whenToUse.trim(),
        procedure: parsed.procedure as Record<string, unknown>,
        constraints: parsed.constraints as Array<Record<string, unknown>>,
        input_schema: parsed.input_schema as Record<string, unknown>,
        output_schema: parsed.output_schema as Record<string, unknown>,
        // Evaluator → force empty regardless of any stale selection. FIX 3:
        // also drop any tool that is no longer enabled (gating flag off) so the
        // server doesn't reject the whole propose.
        allowed_tools: isEvaluator
          ? []
          : allowedTools.filter((name) => enabledToolNames.has(name)),
        policy_descriptors: parseTags(policyDescriptors),
        success_criteria: parsed.success_criteria as Array<Record<string, unknown>>,
        failure_modes: parsed.failure_modes as Array<Record<string, unknown>>,
        runtime_hints: parsed.runtime_hints as Record<string, unknown>,
        proposed_reason: reason.trim(),
      });
    } catch {
      // Error surfaces via proposeMutation.error below.
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative z-50 w-full max-w-2xl h-full overflow-y-auto bg-white shadow-xl p-6">
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-bold">Propose a new skill</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 text-sm"
            aria-label="Close"
          >
            Close ✕
          </button>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          Authoring a skill creates a <code>proposed</code> version for agent{' '}
          <code>{agentId}</code>. Activate it from the detail drawer once
          reviewed.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Descriptor
            </label>
            <input
              value={descriptor}
              onChange={(e) => setDescriptor(e.target.value)}
              className="w-full border rounded p-2 text-sm"
              placeholder="e.g. detect_legal_risk"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                className="w-full border rounded p-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Execution mode
              </label>
              <select
                value={executionMode}
                onChange={(e) =>
                  setExecutionMode(e.target.value as ExecutionMode)
                }
                className="w-full border rounded p-2 text-sm"
              >
                {EXECUTION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Goal</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={2}
              className="w-full border rounded p-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              When to use
            </label>
            <textarea
              value={whenToUse}
              onChange={(e) => setWhenToUse(e.target.value)}
              rows={2}
              className="w-full border rounded p-2 text-sm"
            />
          </div>

          {/* allowed_tools picker — fed by the Tools Catalog (Phase 1). */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Allowed tools
            </label>
            {isEvaluator ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                Evaluator-mode skills cannot declare tools — the selection is
                disabled and sent empty.
              </p>
            ) : catalogQuery.isLoading ? (
              <p className="text-xs text-gray-500">Loading tools catalog…</p>
            ) : catalogQuery.error ? (
              <p className="text-xs text-red-600">
                Could not load tools catalog: {catalogQuery.error.message}
              </p>
            ) : (
              <div className="border rounded p-2 max-h-44 overflow-auto space-y-1">
                {tools.map((t) => (
                  <label
                    key={t.name}
                    className={`flex items-center gap-2 text-sm ${
                      t.enabled ? '' : 'opacity-50'
                    }`}
                  >
                    {/* FIX 3 (PR #213): a disabled tool (gating flag off) cannot
                        be toggled on — the checkbox is disabled and the server
                        rejects it anyway. */}
                    <input
                      type="checkbox"
                      checked={allowedTools.includes(t.name)}
                      disabled={!t.enabled}
                      onChange={() => toggleTool(t.name)}
                    />
                    <code>{t.name}</code>
                    {!t.enabled && (
                      <span className="text-xs text-gray-400">(disabled)</span>
                    )}
                  </label>
                ))}
                {tools.length === 0 && (
                  <p className="text-xs text-gray-400">No tools registered.</p>
                )}
              </div>
            )}
            {!isEvaluator && allowedTools.length > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                Selected: {allowedTools.join(', ')}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Policy descriptors
            </label>
            <input
              value={policyDescriptors}
              onChange={(e) => setPolicyDescriptors(e.target.value)}
              className="w-full border rounded p-2 text-sm"
              placeholder="comma or newline separated"
            />
          </div>

          {(Object.keys(JSON_FIELD_KIND) as JsonField[]).map((field) => (
            <div key={field}>
              <label className="block text-sm font-medium mb-1">
                {JSON_FIELD_LABEL[field]}
              </label>
              <textarea
                value={jsonFields[field]}
                onChange={(e) => setJson(field, e.target.value)}
                rows={field === 'procedure' ? 4 : 2}
                spellCheck={false}
                className="w-full border rounded p-2 text-xs font-mono"
              />
              {jsonErrors[field] && (
                <p className="text-xs text-red-600 mt-1">{jsonErrors[field]}</p>
              )}
            </div>
          ))}

          <div>
            <label className="block text-sm font-medium mb-1">
              Reason (audited, min 10 chars)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full border rounded p-2 text-sm"
            />
            {reason.length > 0 && !reasonOk && (
              <p className="text-xs text-red-600 mt-1">
                At least 10 non-whitespace characters required.
              </p>
            )}
          </div>

          {proposeMutation.error && (
            <p className="text-sm text-red-600">
              {proposeMutation.error.data?.code === 'BAD_REQUEST'
                ? `Rejected: ${proposeMutation.error.message}`
                : `Error: ${proposeMutation.error.message}`}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={
                proposeMutation.isPending ||
                !descriptorOk ||
                !goalOk ||
                !whenOk ||
                !reasonOk
              }
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm disabled:opacity-50"
            >
              {proposeMutation.isPending ? 'Proposing…' : 'Propose skill'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border rounded text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
