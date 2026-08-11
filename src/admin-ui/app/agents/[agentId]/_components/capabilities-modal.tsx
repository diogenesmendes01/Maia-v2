'use client';

import * as React from 'react';
import { trpc } from '../../../../trpc/client.js';
import { Modal } from '../../../../components/ui/modal.js';
import { Button } from '../../../../components/ui/button.js';
import { Badge, StatusBadge } from '../../../../components/ui/badge.js';
import { Field, Textarea } from '../../../../components/ui/field.js';
import { ListEditor } from '../../../../components/ui/list-editor.js';
import { Alert } from '../../../../components/ui/states.js';
// grant-math é deliberadamente registry-free (importar não dispara efeitos),
// então o catálogo de packs pode ser lido direto no client — mesmo precedente
// do wizard, que importa archetype-packs.
import { TOOL_PACKS } from '../../../../../tools/grant-math.js';

interface Props {
  tenantId: string;
  agentId: string;
  /** Packs atualmente concedidos (ids), incluindo baseline e fora-de-catálogo. */
  currentPackIds: string[];
  currentDeniedTools: string[];
  onClose: () => void;
  /** Chamado após salvar com sucesso (o caller invalida getCapabilities). */
  onSaved: () => void;
}

/** Catálogo de packs de domínio elegíveis nesta superfície (sem o piso). */
const DOMAIN_PACK_IDS = Object.keys(TOOL_PACKS)
  .filter((id) => id !== 'baseline.core')
  .sort();

export default function CapabilitiesModal({
  tenantId,
  agentId,
  currentPackIds,
  currentDeniedTools,
  onClose,
  onSaved,
}: Props) {
  const mutation = trpc.agents.updateCapabilities.useMutation();

  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(currentPackIds.filter((id) => id !== 'baseline.core' && TOOL_PACKS[id])),
  );
  const [deniedTools, setDeniedTools] = React.useState<string[]>(currentDeniedTools);
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // Packs concedidos fora do catálogo (ex.: mcp.<server>) — preservados pelo
  // servidor; mostrados aqui só para o operador saber que existem.
  const unmanaged = currentPackIds.filter(
    (id) => id !== 'baseline.core' && !TOOL_PACKS[id],
  );

  const togglePack = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    setError(null);
    if (comment.trim().length < 10) {
      setError('O motivo deve ter pelo menos 10 caracteres.');
      return;
    }
    try {
      await mutation.mutateAsync({
        tenantId,
        agentId,
        granted_packs: [...selected],
        denied_tools: deniedTools,
        comment: comment.trim(),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Gerenciar capacidades"
      description={
        <>
          Packs de domínio e negações do agente{' '}
          <code className="font-mono">{agentId}</code>. Menor privilégio: o
          agente enxerga só o que a função exige.
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSubmit()} loading={mutation.isPending}>
            Salvar capacidades
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <p className="mb-2 text-xs font-medium text-zinc-500">
            Packs de domínio
          </p>
          <ul className="space-y-2">
            <li className="flex items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2 opacity-70">
              <span className="flex items-center gap-2 text-sm text-zinc-800">
                <input type="checkbox" checked disabled aria-label="baseline.core (fixo)" />
                <span className="font-medium">{TOOL_PACKS['baseline.core']?.name ?? 'Baseline'}</span>
                <code className="font-mono text-2xs text-zinc-400">baseline.core</code>
              </span>
              <Badge tone="neutral">piso da plataforma</Badge>
            </li>
            {DOMAIN_PACK_IDS.map((id) => {
              const def = TOOL_PACKS[id]!;
              const checked = selected.has(id);
              return (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-zinc-100 px-3 py-2"
                >
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-800">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePack(id)}
                    />
                    <span className="font-medium">{def.name}</span>
                    <code className="font-mono text-2xs text-zinc-400">{id}</code>
                  </label>
                  <span className="flex items-center gap-1.5">
                    {def.risk_level && <StatusBadge status={def.risk_level} />}
                    <Badge tone="neutral">
                      {def.tools.length} ferramenta{def.tools.length === 1 ? '' : 's'}
                    </Badge>
                  </span>
                </li>
              );
            })}
          </ul>
          {unmanaged.length > 0 && (
            <p className="mt-2 text-xs text-zinc-500">
              Packs geridos em outra tela (preservados ao salvar):{' '}
              {unmanaged.map((id) => (
                <code key={id} className="mr-1 font-mono text-2xs">
                  {id}
                </code>
              ))}
              — conexões MCP ficam em <strong>Conexões MCP</strong>.
            </p>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">
            Negações explícitas (hard deny)
          </p>
          <p className="mb-2 text-xs text-zinc-500">
            Ferramentas listadas aqui nunca ficam visíveis ao agente, mesmo que
            um pack as conceda — e o dispatcher as recusa. Use o nome exato da
            ferramenta.
          </p>
          <ListEditor
            items={deniedTools}
            onChange={setDeniedTools}
            placeholder="Ex.: transferencia_pix"
            tone="danger"
          />
        </div>

        <Field label="Motivo (auditado, mín. 10 caracteres)" required>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Ex.: Agente comercial não deve ver ferramentas financeiras."
          />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
