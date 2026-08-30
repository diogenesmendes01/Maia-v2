'use client';

import * as React from 'react';
import { Badge } from '../../../../components/ui/badge.js';
import { Alert } from '../../../../components/ui/states.js';
import { cn } from '../../../../components/ui/cn.js';
import {
  classifyProfileChangeRisk,
  type ProfileChangeEntry,
  type ProfileRiskLevel,
} from '../../../../lib/profile-risk.js';

/**
 * Diff exaustivo do perfil operacional (spec perfil-inbox v4 §1.2) — deriva
 * do MESMO walker do classificador (`profile-risk.ts`, single source of
 * truth): tudo que o classificador enxerga, este componente renderiza —
 * incluindo `learned_voice_modifiers`, `style.rhythm` e mudança de
 * `schema_version`. Campos desconhecidos aparecem na seção "Campos não
 * reconhecidos (risco alto)" com o JSON bruto, nunca omitidos. Substitui o
 * antigo `ProfileDiff` nas duas superfícies (Inbox e aba Versões).
 */

const FIELD_LABEL: Record<string, string> = {
  schema_version: 'Versão do schema',
  'identity.role_descriptor': 'Papel',
  'identity.voice.tone': 'Tom de voz',
  'identity.voice.formality': 'Formalidade',
  'identity.voice.verbosity': 'Extensão das respostas',
  'identity.cognitive_limits.max_inference_depth': 'Profundidade máx. de inferência',
  'identity.cognitive_limits.max_speculation_in_response': 'Teto de especulação',
  'identity.cognitive_limits.confidence_floor_for_action': 'Piso de confiança para agir',
  'identity.priorities': 'Prioridades',
  'identity.principles': 'Princípios',
  'identity.learned_voice_modifiers': 'Modificadores de voz aprendidos',
  'style.language': 'Idioma',
  'style.rhythm': 'Ritmo',
  'metadata.effective_from': 'Vigência (metadata)',
  'metadata.created_by': 'Criado por (metadata)',
  'metadata.previous_version_id': 'Versão predecessora (linhagem)',
};

const PCT_PATHS = new Set([
  'identity.cognitive_limits.max_speculation_in_response',
  'identity.cognitive_limits.confidence_floor_for_action',
]);

const RISK_LABEL: Record<ProfileRiskLevel, string> = {
  high: 'Risco alto',
  medium: 'Risco médio',
  low: 'Risco baixo',
};

const RISK_TONE: Record<ProfileRiskLevel, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function fmtScalar(path: string, v: unknown): string {
  if (typeof v === 'number' && PCT_PATHS.has(path)) return `${Math.round(v * 100)}%`;
  return String(v);
}

function listDiff(from: string[], to: string[]) {
  const norm = (s: string) => s.trim().toLowerCase();
  const fromSet = new Set(from.map(norm));
  const toSet = new Set(to.map(norm));
  return {
    added: to.filter((s) => !fromSet.has(norm(s))),
    removed: from.filter((s) => !toSet.has(norm(s))),
    kept: to.filter((s) => fromSet.has(norm(s))),
  };
}

export function DiffOperationalProfile({
  predecessorBody,
  proposedBody,
}: {
  /**
   * Corpo do predecessor DECLARADO da proposta (`metadata.previous_version_id`);
   * null quando é a primeira versão (seed) ou o predecessor está ilegível —
   * o classificador faz fail-up para risco alto nesse caso.
   */
  predecessorBody: unknown | null;
  proposedBody: unknown;
}) {
  const { risk, reasons, changes } = React.useMemo(
    () => classifyProfileChangeRisk(predecessorBody, proposedBody),
    [predecessorBody, proposedBody],
  );

  const isSeed = predecessorBody === null || predecessorBody === undefined;
  const unknownEntries = changes.filter((c) => c.unknown_field);
  const knownEntries = changes.filter((c) => !c.unknown_field);
  const byRisk = (level: ProfileRiskLevel): ProfileChangeEntry[] =>
    knownEntries.filter((c) => c.risk === level);

  return (
    <div className="space-y-3">
      {isSeed && (
        <Alert tone="info" title="Primeira versão (seed)">
          Não há versão predecessora para comparar — esta aprovação coloca o
          perfil inicial em operação. Confira o conteúdo abaixo.
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-zinc-600">Risco computado:</span>
        <Badge tone={RISK_TONE[risk]}>{RISK_LABEL[risk]}</Badge>
      </div>

      {reasons.length > 0 && (
        <Alert tone={risk === 'high' ? 'danger' : 'warning'} title="Razões do classificador">
          <ul className="list-disc space-y-0.5 pl-4">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Alert>
      )}

      {changes.length === 0 && (
        <Alert tone="warning" title="Sem mudanças detectáveis">
          A versão proposta é idêntica ao predecessor declarado em todos os
          campos do schema canônico. Confirme se a aprovação ainda faz sentido.
        </Alert>
      )}

      {(['high', 'medium', 'low'] as const).map((level) => {
        const entries = byRisk(level);
        if (entries.length === 0) return null;
        return <RiskGroup key={level} level={level} entries={entries} />;
      })}

      {unknownEntries.length > 0 && (
        <div className="rounded-lg border border-red-200">
          <p className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
            Campos não reconhecidos (risco alto)
          </p>
          <div className="space-y-2 p-3">
            {unknownEntries.map((e) => (
              <UnknownFieldEntry key={e.path} entry={e} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RiskGroup({
  level,
  entries,
}: {
  level: ProfileRiskLevel;
  entries: ProfileChangeEntry[];
}) {
  const border =
    level === 'high'
      ? 'border-red-200'
      : level === 'medium'
        ? 'border-amber-200'
        : 'border-zinc-200';
  const header =
    level === 'high'
      ? 'bg-red-50 text-red-800 border-red-100'
      : level === 'medium'
        ? 'bg-amber-50 text-amber-800 border-amber-100'
        : 'bg-zinc-50 text-zinc-600 border-zinc-100';
  return (
    <div className={cn('overflow-hidden rounded-lg border', border)}>
      <p className={cn('border-b px-3 py-2 text-xs font-medium', header)}>
        {RISK_LABEL[level]}
      </p>
      <table className="w-full text-sm">
        <tbody>
          {entries.map((e) => (
            <tr key={e.path} className="border-b border-zinc-100 last:border-0">
              <td className="w-52 bg-zinc-50 px-3 py-2 align-top text-xs font-medium text-zinc-600">
                {FIELD_LABEL[e.path] ?? e.path}
              </td>
              <td className="px-3 py-2">
                <ChangeValue entry={e} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangeValue({ entry }: { entry: ProfileChangeEntry }) {
  const { path, before, after } = entry;

  // Listas de strings (prioridades/princípios): itens adicionados/removidos.
  const beforeList = before === undefined ? [] : before;
  if (isStringArray(beforeList) && isStringArray(after ?? [])) {
    const { added, removed, kept } = listDiff(beforeList, (after ?? []) as string[]);
    return (
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
          <span className="text-xs text-zinc-400">— (lista esvaziada)</span>
        )}
      </div>
    );
  }

  // Escalares: de → para. Objetos/arrays livres (rhythm, modifiers): JSON.
  const scalar = (v: unknown) =>
    v === null || ['string', 'number', 'boolean'].includes(typeof v);
  if ((before === undefined || scalar(before)) && scalar(after)) {
    return (
      <span>
        {before !== undefined && (
          <span className="mr-2 rounded-sm bg-red-50 px-1.5 py-0.5 text-xs text-red-700 line-through decoration-red-300">
            {fmtScalar(path, before)}
          </span>
        )}
        <span className="rounded-sm bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
          {fmtScalar(path, after)}
        </span>
      </span>
    );
  }

  return (
    <div className="space-y-1">
      {before !== undefined && (
        <pre className="scroll-thin max-h-40 overflow-auto rounded-sm bg-red-50 p-2 font-mono text-2xs leading-relaxed text-red-800">
          {JSON.stringify(before, null, 2)}
        </pre>
      )}
      <pre className="scroll-thin max-h-40 overflow-auto rounded-sm bg-emerald-50 p-2 font-mono text-2xs leading-relaxed text-emerald-900">
        {after === undefined ? '(removido)' : JSON.stringify(after, null, 2)}
      </pre>
    </div>
  );
}

function UnknownFieldEntry({ entry }: { entry: ProfileChangeEntry }) {
  return (
    <div className="rounded-sm border border-red-100">
      <p className="border-b border-red-100 px-2 py-1 font-mono text-2xs text-red-700">
        {entry.path}
      </p>
      <pre className="scroll-thin max-h-40 overflow-auto p-2 font-mono text-2xs leading-relaxed text-zinc-800">
        {JSON.stringify({ antes: entry.before, depois: entry.after }, null, 2)}
      </pre>
    </div>
  );
}
