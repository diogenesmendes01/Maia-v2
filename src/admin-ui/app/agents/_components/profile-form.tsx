'use client';

import * as React from 'react';
import { Card, CardHeader, CardBody } from '../../../components/ui/card.js';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { Field, Input, Select } from '../../../components/ui/field.js';
import { ListEditor } from '../../../components/ui/list-editor.js';
import { SliderField } from '../../../components/ui/slider-field.js';
import { Alert } from '../../../components/ui/states.js';

/**
 * Shared editor for an agent's operational profile. Used by the creation
 * wizard and by the "Perfil" tab on the agent detail screen, so the two
 * surfaces never drift apart.
 *
 * The form value mirrors the user-editable subset of `ProfileBody`
 * (see trpc/routers/agents.ts — schema_version/metadata are server-filled).
 */
export interface ProfileFormValue {
  role_descriptor: string;
  tone: string;
  formality: 'low' | 'medium' | 'high';
  verbosity: 'concise' | 'medium' | 'detailed';
  priorities: string[];
  principles: string[];
  language: string;
  max_inference_depth: number;
  max_speculation_in_response: number;
  confidence_floor_for_action: number;
}

export const DEFAULT_PROFILE: ProfileFormValue = {
  role_descriptor: '',
  tone: 'profissional e cordial',
  formality: 'medium',
  verbosity: 'medium',
  priorities: ['precisao', 'clareza', 'respeito'],
  principles: [],
  language: 'pt-BR',
  max_inference_depth: 3,
  max_speculation_in_response: 0.2,
  confidence_floor_for_action: 0.7,
};

/** Extract a form value from a persisted `profile_body` (defensive reads). */
export function profileBodyToForm(body: unknown): ProfileFormValue {
  const b = (body ?? {}) as Record<string, any>;
  const identity = b.identity ?? {};
  const voice = identity.voice ?? {};
  const limits = identity.cognitive_limits ?? {};
  const style = b.style ?? {};
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    role_descriptor:
      typeof identity.role_descriptor === 'string' ? identity.role_descriptor : '',
    tone: typeof voice.tone === 'string' ? voice.tone : DEFAULT_PROFILE.tone,
    formality: ['low', 'medium', 'high'].includes(voice.formality)
      ? voice.formality
      : 'medium',
    verbosity: ['concise', 'medium', 'detailed'].includes(voice.verbosity)
      ? voice.verbosity
      : 'medium',
    priorities: strArr(identity.priorities),
    principles: strArr(identity.principles),
    language:
      typeof style.language === 'string' ? style.language : DEFAULT_PROFILE.language,
    max_inference_depth:
      typeof limits.max_inference_depth === 'number' ? limits.max_inference_depth : 3,
    max_speculation_in_response:
      typeof limits.max_speculation_in_response === 'number'
        ? limits.max_speculation_in_response
        : 0.2,
    confidence_floor_for_action:
      typeof limits.confidence_floor_for_action === 'number'
        ? limits.confidence_floor_for_action
        : 0.7,
  };
}

/**
 * Build the `profile_body` mutation payload. Empty principles are sent as
 * `undefined` (= "not declared") — never auto-promoted from priorities; see
 * issues #189/#193 for the governance distinction between the two fields.
 */
export function formToProfileBodyInput(v: ProfileFormValue) {
  return {
    identity: {
      role_descriptor: v.role_descriptor.trim(),
      voice: { tone: v.tone.trim(), formality: v.formality, verbosity: v.verbosity },
      cognitive_limits: {
        max_inference_depth: v.max_inference_depth,
        max_speculation_in_response: v.max_speculation_in_response,
        confidence_floor_for_action: v.confidence_floor_for_action,
      },
      priorities: v.priorities,
      principles: v.principles.length > 0 ? v.principles : undefined,
    },
    style: { language: v.language.trim(), rhythm: {} },
  };
}

/** Same overlap rule the server enforces — surfaced early, inline. */
export function findPriorityPrincipleOverlap(v: ProfileFormValue): string | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const prioritySet = new Set(v.priorities.map(norm));
  const clash = v.principles.find((p) => prioritySet.has(norm(p)));
  return clash ?? null;
}

export function validateIdentity(v: ProfileFormValue): string | null {
  if (v.role_descriptor.trim().length === 0)
    return 'Descreva o papel do agente (ex.: "Atendente de leads do WhatsApp").';
  if (v.tone.trim().length === 0) return 'Defina o tom de voz.';
  const clash = findPriorityPrincipleOverlap(v);
  if (clash)
    return `"${clash}" aparece em prioridades E princípios — escolha um dos dois campos.`;
  if (v.principles.length > 0 && v.priorities.length === 0)
    return 'Declare ao menos uma prioridade ao definir princípios.';
  return null;
}

export function validateBehavior(v: ProfileFormValue): string | null {
  if (v.language.trim().length < 2) return 'Informe o idioma (ex.: pt-BR).';
  return null;
}

/**
 * Card avançado colapsado por padrão — progressive disclosure (fase 3 do
 * relatório de complexidade): os presets da função cobrem a maioria dos
 * casos, então o operador só encara estes campos se pedir. Colapsado, mostra
 * um resumo dos valores atuais (nada fica invisível — só fora do caminho).
 * `forceOpen` mantém aberto sem botão de ocultar (usado quando há um
 * conflito de validação que o operador precisa resolver).
 */
function AdvancedCard({
  title,
  description,
  collapsedSummary,
  forceOpen = false,
  children,
}: {
  title: string;
  description: string;
  collapsedSummary: React.ReactNode;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const isOpen = open || forceOpen;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {title}
            <Badge tone="neutral">avançado</Badge>
          </span>
        }
        description={description}
        actions={
          !forceOpen && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
              {isOpen ? 'Ocultar' : 'Editar'}
            </Button>
          )
        }
      />
      <CardBody className={isOpen ? undefined : 'py-3'}>
        {isOpen ? children : collapsedSummary}
      </CardBody>
    </Card>
  );
}

const FORMALITY_LABEL: Record<ProfileFormValue['formality'], string> = {
  low: 'Informal',
  medium: 'Equilibrado',
  high: 'Formal',
};
const VERBOSITY_LABEL: Record<ProfileFormValue['verbosity'], string> = {
  concise: 'Direto ao ponto',
  medium: 'Equilibrado',
  detailed: 'Detalhado',
};

export function IdentitySection({
  value,
  onChange,
}: {
  value: ProfileFormValue;
  onChange: (v: ProfileFormValue) => void;
}) {
  const set = <K extends keyof ProfileFormValue>(k: K, v: ProfileFormValue[K]) =>
    onChange({ ...value, [k]: v });
  const overlap = findPriorityPrincipleOverlap(value);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Papel e voz"
          description="Como o agente se apresenta e conversa com as pessoas."
        />
        <CardBody className="space-y-4">
          <Field
            label="Papel do agente"
            required
            hint="Uma frase que resume a função. Ex.: “Atendente financeiro para clientes PF no WhatsApp”."
          >
            <Input
              value={value.role_descriptor}
              onChange={(e) => set('role_descriptor', e.target.value)}
              placeholder="Atendente de leads do WhatsApp para a divisão X"
              maxLength={500}
            />
          </Field>
          <Field label="Tom de voz" required hint="Ex.: “profissional e cordial”, “descontraído mas preciso”.">
            <Input
              value={value.tone}
              onChange={(e) => set('tone', e.target.value)}
              maxLength={200}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Formalidade">
              <Select
                value={value.formality}
                onChange={(e) => set('formality', e.target.value as ProfileFormValue['formality'])}
              >
                {(['low', 'medium', 'high'] as const).map((f) => (
                  <option key={f} value={f}>
                    {FORMALITY_LABEL[f]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Extensão das respostas">
              <Select
                value={value.verbosity}
                onChange={(e) => set('verbosity', e.target.value as ProfileFormValue['verbosity'])}
              >
                {(['concise', 'medium', 'detailed'] as const).map((vv) => (
                  <option key={vv} value={vv}>
                    {VERBOSITY_LABEL[vv]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Prioridades"
          description="Rótulos operacionais que o agente pesa ao decidir o foco. Monitorados de forma branda pelo detector de drift de papel — sem congelamento automático."
        />
        <CardBody>
          <ListEditor
            items={value.priorities}
            onChange={(items) => set('priorities', items)}
            placeholder="Ex.: precisão, clareza, agilidade…"
          />
        </CardBody>
      </Card>

      <AdvancedCard
        title="Princípios (contratos de valor)"
        description="Limites invioláveis de comportamento, auditados pelo detector de valores — violações podem congelar o perfil automaticamente. A função escolhida já define um bom padrão."
        forceOpen={overlap !== null}
        collapsedSummary={
          value.principles.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {value.principles.map((p) => (
                <Badge key={p} tone="danger">
                  {p}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-500">
              Sem princípios declarados — a guarda de valores fica desativada
              para este perfil. Você pode declará-los agora ou depois.
            </p>
          )
        }
      >
        <div className="space-y-3">
          <ListEditor
            items={value.principles}
            onChange={(items) => set('principles', items)}
            placeholder="Ex.: Nunca prometer condições fora do playbook aprovado."
            tone="danger"
          />
          {overlap && (
            <Alert tone="warning" title="Conflito entre campos">
              “{overlap}” está em prioridades e princípios ao mesmo tempo. O servidor
              rejeita essa sobreposição — mantenha cada rótulo em apenas um campo.
            </Alert>
          )}
          {value.principles.length === 0 && (
            <p className="text-xs text-zinc-500">
              Sem princípios declarados, a guarda de valores fica desativada para este
              perfil — você pode declará-los depois.
            </p>
          )}
          <p className="text-xs text-zinc-500">
            Não repita prioridades aqui — são coisas diferentes (prioridades
            são pesos operacionais brandos; princípios são contratos duros).
          </p>
        </div>
      </AdvancedCard>
    </div>
  );
}

export function BehaviorSection({
  value,
  onChange,
}: {
  value: ProfileFormValue;
  onChange: (v: ProfileFormValue) => void;
}) {
  const set = <K extends keyof ProfileFormValue>(k: K, v: ProfileFormValue[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Estilo" description="Idioma principal das respostas do agente." />
        <CardBody>
          <Field label="Idioma" required hint="Código BCP-47. Ex.: pt-BR, en, es.">
            <Input
              value={value.language}
              onChange={(e) => set('language', e.target.value)}
              className="max-w-[10rem] font-mono"
              maxLength={20}
            />
          </Field>
        </CardBody>
      </Card>

      <AdvancedCard
        title="Limites cognitivos"
        description="Travas determinísticas de comportamento — o backend decide, o LLM propõe. Os padrões da função servem para a maioria dos casos."
        collapsedSummary={
          <p className="text-xs text-zinc-600">
            Profundidade de inferência{' '}
            <strong className="font-semibold">{value.max_inference_depth}</strong> ·
            teto de especulação{' '}
            <strong className="font-semibold">
              {Math.round(value.max_speculation_in_response * 100)}%
            </strong>{' '}
            · piso de confiança para agir{' '}
            <strong className="font-semibold">
              {Math.round(value.confidence_floor_for_action * 100)}%
            </strong>
          </p>
        }
      >
        <div className="space-y-5">
          <SliderField
            label="Profundidade máxima de inferência"
            value={value.max_inference_depth}
            onChange={(v) => set('max_inference_depth', v)}
            min={0}
            max={10}
            step={1}
            hint="Quantos passos de raciocínio encadeado o agente pode dar antes de responder."
          />
          <SliderField
            label="Teto de especulação nas respostas"
            value={value.max_speculation_in_response}
            onChange={(v) => set('max_speculation_in_response', v)}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            hint="0% = só fatos confirmados; valores altos toleram hipóteses sinalizadas."
          />
          <SliderField
            label="Piso de confiança para agir"
            value={value.confidence_floor_for_action}
            onChange={(v) => set('confidence_floor_for_action', v)}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            hint="Abaixo deste piso o agente pergunta em vez de executar uma ação."
          />
        </div>
      </AdvancedCard>
    </div>
  );
}
