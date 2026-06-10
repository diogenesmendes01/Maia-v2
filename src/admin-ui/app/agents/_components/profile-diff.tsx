'use client';

import * as React from 'react';
import { Badge } from '../../../components/ui/badge.js';
import { Alert } from '../../../components/ui/states.js';
import { cn } from '../../../components/ui/cn.js';
import { profileBodyToForm, type ProfileFormValue } from './profile-form.js';

/**
 * Diff legível entre dois profile_body (issue #461) — exibido no modal de
 * "Aprovar e ativar" para que nenhuma versão seja aprovada às cegas.
 * Campos escalares mostram de→para; listas mostram itens adicionados e
 * removidos. Campos inalterados ficam discretos.
 */

const FIELD_LABEL: Record<keyof ProfileFormValue, string> = {
  role_descriptor: 'Papel',
  tone: 'Tom de voz',
  formality: 'Formalidade',
  verbosity: 'Extensão das respostas',
  priorities: 'Prioridades',
  principles: 'Princípios',
  language: 'Idioma',
  max_inference_depth: 'Profundidade máx. de inferência',
  max_speculation_in_response: 'Teto de especulação',
  confidence_floor_for_action: 'Piso de confiança para agir',
};

const SCALAR_FIELDS: Array<keyof ProfileFormValue> = [
  'role_descriptor',
  'tone',
  'formality',
  'verbosity',
  'language',
  'max_inference_depth',
  'max_speculation_in_response',
  'confidence_floor_for_action',
];

const PCT_FIELDS = new Set<keyof ProfileFormValue>([
  'max_speculation_in_response',
  'confidence_floor_for_action',
]);

function fmt(field: keyof ProfileFormValue, v: unknown): string {
  if (typeof v === 'number' && PCT_FIELDS.has(field)) return `${Math.round(v * 100)}%`;
  return String(v);
}

function listDiff(from: string[], to: string[]) {
  const fromSet = new Set(from.map((s) => s.trim().toLowerCase()));
  const toSet = new Set(to.map((s) => s.trim().toLowerCase()));
  return {
    added: to.filter((s) => !fromSet.has(s.trim().toLowerCase())),
    removed: from.filter((s) => !toSet.has(s.trim().toLowerCase())),
    kept: to.filter((s) => fromSet.has(s.trim().toLowerCase())),
  };
}

export function ProfileDiff({
  activeBody,
  proposedBody,
}: {
  /** profile_body em operação; null quando é a primeira versão (seed). */
  activeBody: unknown | null;
  proposedBody: unknown;
}) {
  const proposed = profileBodyToForm(proposedBody);

  if (!activeBody) {
    return (
      <div className="space-y-3">
        <Alert tone="info" title="Primeira versão (seed)">
          Não há versão ativa para comparar — esta aprovação coloca o perfil
          inicial em operação. Confira o conteúdo abaixo.
        </Alert>
        <DiffTable rows={SCALAR_FIELDS.map((f) => ({
          field: f,
          changed: true,
          from: null,
          to: fmt(f, proposed[f]),
        }))}
        />
        <ListBlock label="Prioridades" added={proposed.priorities} removed={[]} kept={[]} />
        <ListBlock
          label="Princípios"
          added={proposed.principles}
          removed={[]}
          kept={[]}
          danger
        />
      </div>
    );
  }

  const active = profileBodyToForm(activeBody);
  const scalarRows = SCALAR_FIELDS.map((f) => ({
    field: f,
    changed: fmt(f, active[f]) !== fmt(f, proposed[f]),
    from: fmt(f, active[f]),
    to: fmt(f, proposed[f]),
  }));
  const prio = listDiff(active.priorities, proposed.priorities);
  const princ = listDiff(active.principles, proposed.principles);
  const anyChange =
    scalarRows.some((r) => r.changed) ||
    prio.added.length + prio.removed.length > 0 ||
    princ.added.length + princ.removed.length > 0;

  return (
    <div className="space-y-3">
      {!anyChange && (
        <Alert tone="warning" title="Sem mudanças detectáveis">
          A versão proposta é idêntica à ativa nos campos comparáveis. Confirme
          se a aprovação ainda faz sentido.
        </Alert>
      )}
      <DiffTable rows={scalarRows} />
      {(prio.added.length > 0 || prio.removed.length > 0) && (
        <ListBlock label="Prioridades" {...prio} />
      )}
      {(princ.added.length > 0 || princ.removed.length > 0) && (
        <ListBlock label="Princípios" {...princ} danger />
      )}
      {princ.removed.length > 0 && (
        <Alert tone="danger" title="Princípio removido">
          Remover um princípio desativa a guarda de valores correspondente —
          o agente deixa de ser auditado contra esse contrato.
        </Alert>
      )}
    </div>
  );
}

function DiffTable({
  rows,
}: {
  rows: Array<{
    field: keyof ProfileFormValue;
    changed: boolean;
    from: string | null;
    to: string;
  }>;
}) {
  const changed = rows.filter((r) => r.changed);
  const unchanged = rows.filter((r) => !r.changed);
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200">
      <table className="w-full text-sm">
        <tbody>
          {changed.map((r) => (
            <tr key={r.field} className="border-b border-zinc-100 last:border-0">
              <td className="w-44 bg-zinc-50 px-3 py-2 align-top text-xs font-medium text-zinc-600">
                {FIELD_LABEL[r.field]}
              </td>
              <td className="px-3 py-2">
                {r.from !== null && (
                  <span className="mr-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700 line-through decoration-red-300">
                    {r.from}
                  </span>
                )}
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
                  {r.to}
                </span>
              </td>
            </tr>
          ))}
          {unchanged.length > 0 && (
            <tr>
              <td colSpan={2} className="px-3 py-2 text-2xs text-zinc-400">
                Sem mudança: {unchanged.map((r) => FIELD_LABEL[r.field]).join(' · ')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ListBlock({
  label,
  added,
  removed,
  kept,
  danger,
}: {
  label: string;
  added: string[];
  removed: string[];
  kept: string[];
  danger?: boolean;
}) {
  return (
    <div className={cn('rounded-lg border p-3', danger ? 'border-red-100' : 'border-zinc-200')}>
      <p className="mb-2 text-xs font-medium text-zinc-600">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {removed.map((item) => (
          <Badge key={`r-${item}`} tone="danger" className="line-through opacity-70">
            − {item}
          </Badge>
        ))}
        {added.map((item) => (
          <Badge key={`a-${item}`} tone="success">
            + {item}
          </Badge>
        ))}
        {kept.map((item) => (
          <Badge key={`k-${item}`} tone="neutral">
            {item}
          </Badge>
        ))}
        {added.length + removed.length + kept.length === 0 && (
          <span className="text-xs text-zinc-400">—</span>
        )}
      </div>
    </div>
  );
}
