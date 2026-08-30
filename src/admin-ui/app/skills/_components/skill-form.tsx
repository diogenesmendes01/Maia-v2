'use client';

/**
 * Admin UI — formulário de proposta de skill (founder).
 *
 * Cria uma NOVA versão de skill com status `proposed` — o gate de papel é do
 * pai e a mutação `skills.propose` reimpõe `founder` no servidor. Os campos
 * espelham o SkillContract mais o `proposed_reason` auditado:
 *   - skill_descriptor / goal / when_to_use — texto simples.
 *   - category / execution_mode — selects sobre os enums do check-constraint.
 *   - procedure / constraints / input_schema / output_schema /
 *     success_criteria / failure_modes / runtime_hints — textareas JSON com
 *     validação JSON.parse no cliente + erro inline.
 *   - allowed_tools — multi-seleção alimentada por trpc.toolsCatalog.listCatalog.
 *     DESABILITADA + limpa quando execution_mode é 'evaluator' (regra cruzada
 *     do repo + router: evaluators DEVEM ter allowed_tools vazio).
 *   - policy_descriptors — lista de strings (ListEditor).
 *   - proposed_reason — textarea, mín. 10 (o motivo auditado).
 *
 * No submit os campos JSON são parseados localmente; só quando todos passam é
 * que a mutação propose é chamada. Sucesso fecha o formulário e o pai
 * invalida a lista.
 *
 * Fronteira de servidor: este arquivo importa apenas o cliente tRPC.
 */

import * as React from 'react';
import { trpc } from '../../../trpc/client.js';
import { Modal } from '../../../components/ui/modal.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Input, Select, Textarea } from '../../../components/ui/field.js';
import { ListEditor } from '../../../components/ui/list-editor.js';
import { Alert } from '../../../components/ui/states.js';

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

// Campos JSON e o tipo de contêiner esperado, para erro inline preciso.
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
  procedure: 'Procedimento (objeto JSON)',
  constraints: 'Restrições (array JSON)',
  input_schema: 'Schema de entrada (objeto JSON)',
  output_schema: 'Schema de saída (objeto JSON)',
  success_criteria: 'Critérios de sucesso (array JSON)',
  failure_modes: 'Modos de falha (array JSON)',
  runtime_hints: 'Dicas de runtime (objeto JSON)',
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
    return { ok: false, error: `JSON inválido: ${(e as Error).message}` };
  }
  if (kind === 'array') {
    if (!Array.isArray(value)) {
      return { ok: false, error: 'Deve ser um array JSON.' };
    }
  } else {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'Deve ser um objeto JSON.' };
    }
  }
  return { ok: true, value };
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
  const [policyDescriptors, setPolicyDescriptors] = React.useState<string[]>([]);
  const [reason, setReason] = React.useState('');
  const [jsonErrors, setJsonErrors] = React.useState<
    Partial<Record<JsonField, string>>
  >({});

  const isEvaluator = executionMode === 'evaluator';

  // Fonte do seletor de allowed_tools = o Catálogo de Ferramentas (Fase 1).
  const catalogQuery = trpc.toolsCatalog.listCatalog.useQuery();
  const tools = catalogQuery.data ?? [];
  // Conjunto de ferramentas que o operador pode de fato selecionar. Uma
  // ferramenta desabilitada (flag desligada) é removida de allowed_tools no
  // submit para nunca enviar algo que o servidor rejeitaria; o servidor impõe
  // a mesma regra de forma autoritativa (skills.propose).
  const enabledToolNames = React.useMemo(
    () => new Set(tools.filter((t) => t.enabled).map((t) => t.name)),
    [tools],
  );

  // Skills evaluator DEVEM ter allowed_tools vazio (regra do repo + router).
  // Limpa qualquer seleção assim que o operador troca para evaluator.
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

    // Parseia todos os campos JSON; coleta erros por campo. Interrompe antes
    // da mutação se algum for inválido, para o operador corrigir inline.
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
        // Evaluator → força vazio independente de seleção antiga; também
        // remove qualquer ferramenta que não esteja mais habilitada para o
        // servidor não rejeitar a proposta inteira.
        allowed_tools: isEvaluator
          ? []
          : allowedTools.filter((name) => enabledToolNames.has(name)),
        policy_descriptors: policyDescriptors,
        success_criteria: parsed.success_criteria as Array<Record<string, unknown>>,
        failure_modes: parsed.failure_modes as Array<Record<string, unknown>>,
        runtime_hints: parsed.runtime_hints as Record<string, unknown>,
        proposed_reason: reason.trim(),
      });
    } catch {
      // O erro aparece via proposeMutation.error abaixo.
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Propor nova skill"
      description={
        <>
          A proposta cria uma versão <code className="font-mono">proposed</code>{' '}
          para o agente <code className="font-mono">{agentId}</code>. Ative-a
          pelo detalhe da skill depois de revisar.
        </>
      }
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="skill-propose-form"
            loading={proposeMutation.isPending}
            disabled={!descriptorOk || !goalOk || !whenOk || !reasonOk}
          >
            Propor skill
          </Button>
        </>
      }
    >
      <form id="skill-propose-form" onSubmit={handleSubmit} className="space-y-4">
        <Field label="Descritor" required>
          <Input
            value={descriptor}
            onChange={(e) => setDescriptor(e.target.value)}
            placeholder="ex: detect_legal_risk"
            className="font-mono"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Categoria">
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Modo de execução">
            <Select
              value={executionMode}
              onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
            >
              {EXECUTION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Objetivo" required>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
          />
        </Field>

        <Field label="Quando usar" required>
          <Textarea
            value={whenToUse}
            onChange={(e) => setWhenToUse(e.target.value)}
            rows={2}
          />
        </Field>

        {/* Seletor de allowed_tools — alimentado pelo Catálogo de Ferramentas. */}
        <div className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-700">
            Ferramentas permitidas
          </span>
          {isEvaluator ? (
            <Alert tone="warning">
              Skills em modo evaluator não podem declarar ferramentas — a
              seleção fica desabilitada e é enviada vazia.
            </Alert>
          ) : catalogQuery.isLoading ? (
            <p className="text-xs text-zinc-500">Carregando catálogo de ferramentas…</p>
          ) : catalogQuery.error ? (
            <p className="text-xs text-red-600">
              Não foi possível carregar o catálogo: {catalogQuery.error.message}
            </p>
          ) : (
            <div className="scroll-thin max-h-44 space-y-1 overflow-auto rounded-lg border border-zinc-200 p-2.5">
              {tools.map((t) => (
                <label
                  key={t.name}
                  className={`flex items-center gap-2 text-sm ${
                    t.enabled ? '' : 'opacity-50'
                  }`}
                >
                  {/* Ferramenta desabilitada (flag desligada) não pode ser
                      marcada — o checkbox fica desabilitado e o servidor a
                      rejeitaria de qualquer forma. */}
                  <input
                    type="checkbox"
                    checked={allowedTools.includes(t.name)}
                    disabled={!t.enabled}
                    onChange={() => toggleTool(t.name)}
                    className="h-4 w-4 rounded-sm border-zinc-300 text-brand-600 focus:ring-brand-500"
                  />
                  <code className="font-mono text-xs">{t.name}</code>
                  {!t.enabled && (
                    <span className="text-xs text-zinc-400">(desabilitada)</span>
                  )}
                </label>
              ))}
              {tools.length === 0 && (
                <p className="text-xs text-zinc-400">Nenhuma ferramenta registrada.</p>
              )}
            </div>
          )}
          {!isEvaluator && allowedTools.length > 0 && (
            <p className="mt-1 text-xs text-zinc-500">
              Selecionadas: {allowedTools.join(', ')}
            </p>
          )}
        </div>

        <div className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-700">
            Descritores de política
          </span>
          <ListEditor
            items={policyDescriptors}
            onChange={setPolicyDescriptors}
            placeholder="ex: no_pii_disclosure"
          />
        </div>

        {(Object.keys(JSON_FIELD_KIND) as JsonField[]).map((field) => (
          <Field
            key={field}
            label={JSON_FIELD_LABEL[field]}
            error={jsonErrors[field] ?? null}
          >
            <Textarea
              value={jsonFields[field]}
              onChange={(e) => setJson(field, e.target.value)}
              rows={field === 'procedure' ? 4 : 2}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
        ))}

        <Field
          label="Motivo (auditado, mín. 10 caracteres)"
          required
          error={
            reason.length > 0 && !reasonOk
              ? 'Pelo menos 10 caracteres (sem contar espaços nas pontas).'
              : null
          }
        >
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
          />
        </Field>

        {proposeMutation.error && (
          <Alert tone="danger">
            {proposeMutation.error.data?.code === 'BAD_REQUEST'
              ? `Rejeitada: ${proposeMutation.error.message}`
              : `Erro: ${proposeMutation.error.message}`}
          </Alert>
        )}
      </form>
    </Modal>
  );
}
