'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';

interface Props {
  tenantId: string;
  onClose: (created: boolean) => void;
}

const ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

interface WizardState {
  // Step 1
  id: string;
  nome: string;
  status: 'active' | 'suspended';
  // Step 2 (identity)
  role_descriptor: string;
  tone: string;
  formality: 'low' | 'medium' | 'high';
  verbosity: 'concise' | 'medium' | 'detailed';
  priorities: string;
  // Issue #193 — principles is a DISTINCT field from priorities. Empty
  // string default keeps it opt-in: leaving the field blank reproduces the
  // current behavior (no principles configured → valoresDetector skips).
  principles: string;
  // Step 3 (style + limits)
  language: string;
  max_inference_depth: number;
  max_speculation_in_response: number;
  confidence_floor_for_action: number;
  proposed_reason: string;
}

const INITIAL: WizardState = {
  id: '',
  nome: '',
  status: 'active',
  role_descriptor: '',
  tone: 'profissional e cordial',
  formality: 'medium',
  verbosity: 'medium',
  priorities: 'precisao\nclareza\nrespeito',
  // Issue #193 — empty by default. We deliberately DO NOT pre-fill the
  // priorities text here: principles are core value contracts (violations
  // freeze the agent), not operational labels. Forcing the operator to
  // type them explicitly is the whole point of separating the two inputs.
  principles: '',
  language: 'pt-BR',
  max_inference_depth: 3,
  max_speculation_in_response: 0.2,
  confidence_floor_for_action: 0.7,
  proposed_reason: '',
};

export default function AgentWizard({ tenantId, onClose }: Props) {
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [state, setState] = React.useState<WizardState>(INITIAL);
  const [error, setError] = React.useState<string | null>(null);
  const mutation = trpc.agents.create.useMutation();

  const set = <K extends keyof WizardState>(k: K, v: WizardState[K]) => {
    setState((s) => ({ ...s, [k]: v }));
  };

  const validateStep1 = (): string | null => {
    if (!ID_REGEX.test(state.id)) return 'ID must be lowercase alnum/_/-';
    if (state.id.length > 64) return 'ID must be at most 64 chars';
    if (state.nome.trim().length === 0) return 'Nome is required';
    return null;
  };
  const validateStep2 = (): string | null => {
    if (state.role_descriptor.trim().length === 0)
      return 'role_descriptor is required';
    if (state.tone.trim().length === 0) return 'tone is required';
    return null;
  };
  const validateStep3 = (): string | null => {
    if (state.proposed_reason.trim().length < 10)
      return 'proposed_reason must be at least 10 chars';
    if (state.max_inference_depth < 0 || state.max_inference_depth > 10)
      return 'max_inference_depth ∈ [0,10]';
    if (
      state.max_speculation_in_response < 0 ||
      state.max_speculation_in_response > 1
    )
      return 'max_speculation_in_response ∈ [0,1]';
    if (
      state.confidence_floor_for_action < 0 ||
      state.confidence_floor_for_action > 1
    )
      return 'confidence_floor_for_action ∈ [0,1]';
    return null;
  };

  const next = () => {
    setError(null);
    const err = step === 1 ? validateStep1() : step === 2 ? validateStep2() : null;
    if (err) {
      setError(err);
      return;
    }
    setStep((s) => (s === 1 ? 2 : 3));
  };

  const handleSubmit = async () => {
    setError(null);
    const err = validateStep3();
    if (err) {
      setError(err);
      return;
    }
    try {
      const priorities = state.priorities
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      // Issue #193 — `principles` is a distinct collection from `priorities`.
      // We send `undefined` (not `[]`) when the operator left the field empty
      // so the server-side schema treats it as "not declared"; the resolver
      // returns no principles and valoresDetector skips silently (the
      // intentional post-#189 behavior). NEVER auto-promote priorities here.
      const principlesParsed = state.principles
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const principles =
        principlesParsed.length > 0 ? principlesParsed : undefined;
      await mutation.mutateAsync({
        tenantId,
        id: state.id,
        nome: state.nome,
        status: state.status,
        profile_body: {
          identity: {
            role_descriptor: state.role_descriptor,
            voice: {
              tone: state.tone,
              formality: state.formality,
              verbosity: state.verbosity,
            },
            cognitive_limits: {
              max_inference_depth: state.max_inference_depth,
              max_speculation_in_response: state.max_speculation_in_response,
              confidence_floor_for_action: state.confidence_floor_for_action,
            },
            priorities,
            principles,
          },
          style: {
            language: state.language,
            rhythm: {},
          },
        },
        proposed_reason: state.proposed_reason,
      });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-[640px] max-w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">New agent — step {step} of 3</h2>
          <div className="flex gap-1">
            {[1, 2, 3].map((s) => (
              <span
                key={s}
                className={`w-8 h-1 rounded ${
                  s <= step ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              />
            ))}
          </div>
        </div>

        {step === 1 && (
          <div className="space-y-3">
            <h3 className="font-medium text-sm text-gray-700">Metadata</h3>
            <label className="block">
              <span className="text-sm font-medium">ID (slug)</span>
              <input
                value={state.id}
                onChange={(e) => set('id', e.target.value)}
                placeholder="acme-bot"
                className="w-full p-2 border rounded mt-1 font-mono text-sm"
              />
              <span className="text-xs text-gray-500">
                lowercase letters/digits/_/-
              </span>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Nome</span>
              <input
                value={state.nome}
                onChange={(e) => set('nome', e.target.value)}
                placeholder="Acme Bot"
                className="w-full p-2 border rounded mt-1 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Status</span>
              <select
                value={state.status}
                onChange={(e) => set('status', e.target.value as 'active' | 'suspended')}
                className="w-full p-2 border rounded mt-1 text-sm"
              >
                <option value="active">active</option>
                <option value="suspended">suspended</option>
              </select>
            </label>
            <p className="text-xs text-gray-500">
              Tenant: <code>{tenantId}</code>
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <h3 className="font-medium text-sm text-gray-700">
              Identity (operational profile seed)
            </h3>
            <label className="block">
              <span className="text-sm font-medium">role_descriptor</span>
              <input
                value={state.role_descriptor}
                onChange={(e) => set('role_descriptor', e.target.value)}
                placeholder="Assistente financeira da empresa X"
                className="w-full p-2 border rounded mt-1 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium">voice.tone</span>
              <input
                value={state.tone}
                onChange={(e) => set('tone', e.target.value)}
                className="w-full p-2 border rounded mt-1 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium">voice.formality</span>
                <select
                  value={state.formality}
                  onChange={(e) =>
                    set('formality', e.target.value as 'low' | 'medium' | 'high')
                  }
                  className="w-full p-2 border rounded mt-1 text-sm"
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium">voice.verbosity</span>
                <select
                  value={state.verbosity}
                  onChange={(e) =>
                    set(
                      'verbosity',
                      e.target.value as 'concise' | 'medium' | 'detailed',
                    )
                  }
                  className="w-full p-2 border rounded mt-1 text-sm"
                >
                  <option value="concise">concise</option>
                  <option value="medium">medium</option>
                  <option value="detailed">detailed</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className="text-sm font-medium">priorities (one per line)</span>
              <textarea
                value={state.priorities}
                onChange={(e) => set('priorities', e.target.value)}
                rows={4}
                className="w-full p-2 border rounded mt-1 text-sm font-mono"
              />
              <span className="text-xs text-gray-500">
                Operational labels — what the agent weights when deciding what
                to focus on. Audited softly by <code>papelDriftDetector</code>{' '}
                (no auto-freeze).
              </span>
            </label>
            {/*
              Issue #193 — principles is a DISTINCT input from priorities.
              Same shape (string per line) but radically different governance:
              violations are floored to `alto` → `frozen` (or `critico` →
              `rollback`) by the decision engine. Leaving this blank is
              valid — the VALORES guardrail stays disabled for this profile
              and the operator can come back later via updateProfile. We
              intentionally do NOT copy priorities into this field.
            */}
            <label className="block">
              <span className="text-sm font-medium">
                principles (one per line) — core value contracts
              </span>
              <textarea
                value={state.principles}
                onChange={(e) => set('principles', e.target.value)}
                rows={4}
                placeholder={
                  'Ex.: Separação acima de tudo. PF é PF.\n' +
                  'Ex.: Confirme antes de agir em coisas relevantes.'
                }
                className="w-full p-2 border rounded mt-1 text-sm font-mono"
              />
              <span className="text-xs text-gray-500">
                <strong>Core values</strong> — inviolable behavioral guardrails
                audited by <code>valoresDetector</code>. Violations may
                auto-freeze the profile. Different from priorities: do{' '}
                <strong>not</strong> repeat operational labels here. Leave
                empty if you don&apos;t want to declare value guardrails yet
                (VALORES check stays disabled until principles are declared).
              </span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <h3 className="font-medium text-sm text-gray-700">
              Style + cognitive limits
            </h3>
            <label className="block">
              <span className="text-sm font-medium">style.language</span>
              <input
                value={state.language}
                onChange={(e) => set('language', e.target.value)}
                className="w-full p-2 border rounded mt-1 text-sm"
              />
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs font-medium">
                  max_inference_depth
                </span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={state.max_inference_depth}
                  onChange={(e) =>
                    set('max_inference_depth', Number(e.target.value))
                  }
                  className="w-full p-2 border rounded mt-1 text-sm"
                />
                <span className="text-[10px] text-gray-500">[0,10]</span>
              </label>
              <label className="block">
                <span className="text-xs font-medium">max_speculation</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={state.max_speculation_in_response}
                  onChange={(e) =>
                    set('max_speculation_in_response', Number(e.target.value))
                  }
                  className="w-full p-2 border rounded mt-1 text-sm"
                />
                <span className="text-[10px] text-gray-500">[0,1]</span>
              </label>
              <label className="block">
                <span className="text-xs font-medium">confidence_floor</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={state.confidence_floor_for_action}
                  onChange={(e) =>
                    set('confidence_floor_for_action', Number(e.target.value))
                  }
                  className="w-full p-2 border rounded mt-1 text-sm"
                />
                <span className="text-[10px] text-gray-500">[0,1]</span>
              </label>
            </div>
            <label className="block">
              <span className="text-sm font-medium">
                Reason (audited; min 10 chars)
              </span>
              <textarea
                value={state.proposed_reason}
                onChange={(e) => set('proposed_reason', e.target.value)}
                rows={3}
                className="w-full p-2 border rounded mt-1 text-sm"
                placeholder="Initial agent seed for the X division."
              />
            </label>
            <p className="text-xs text-gray-500">
              Profile v1 will be created with status=<code>proposed</code>.
              Activate it from the <strong>Identities</strong> screen — there
              you'll see an "Approve &amp; activate" action for any{' '}
              <code>proposed</code> row (owner or founder).
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

        <div className="flex justify-between mt-5">
          <button
            onClick={() => onClose(false)}
            disabled={mutation.isPending}
            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50"
          >
            Cancel
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                disabled={mutation.isPending}
                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50"
              >
                Back
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={next}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={mutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {mutation.isPending ? 'Creating...' : 'Create agent'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
