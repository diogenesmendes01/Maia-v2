'use client';

import * as React from 'react';
import type { ProposalTypeId } from '../../../../trpc/types.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Alert } from '../../../../components/ui/states.js';

/**
 * Renderizador de diff por tipo de proposta (ver proposal-type-registry.ts).
 * A lógica por tipo permanece a do P8.5 v1.0: corpo bruto em JSON formatado;
 * o diff JSON detalhado chega no P8.5 v1.1.
 *
 * A dependência `react-diff-viewer-continued` foi REMOVIDA do console. Ela
 * entrou no scaffold do P8.5 (e23c8523, 2026-05-15) e nunca foi importada por
 * arquivo nenhum — virou alvo de PR de major do Dependabot por código que não
 * existe. Quem implementar a v1.1 declara a lib no mesmo PR que a usa.
 */
const SECTIONS: Record<ProposalTypeId, { title: string; description: string }> = {
  policy_rule: {
    title: 'Diff da regra de política',
    description: 'Renderização detalhada de diff JSON (P8.5 v1.1). Por enquanto: corpo bruto.',
  },
  soul_bias: {
    title: 'Diff do viés de identidade',
    description: 'Mudanças nas dimensões de viés da identidade (soul bias).',
  },
  skill: {
    title: 'Diff da skill',
    description: 'Mudanças de escopo e competência da skill.',
  },
  capability_proposal: {
    title: 'Especificação da capacidade',
    description:
      'Capacidade de ferramenta proposta pelo agente (capability_proposals.proposed_spec).',
  },
  knowledge_proposal: {
    title: 'Proposta de conhecimento',
    description: 'Entrada de conhecimento proposta para ativação.',
  },
  operational_profile: {
    title: 'Diff do perfil operacional',
    description:
      'Mudanças campo a campo vs. o predecessor declarado (DiffOperationalProfile — ' +
      'ligado na fase A da integração do perfil ao Inbox).',
  },
};

function BodyPre({ body }: { body: unknown }) {
  return (
    <pre className="scroll-thin max-h-96 overflow-auto rounded-lg bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-800">
      {JSON.stringify(body, null, 2)}
    </pre>
  );
}

export default function DiffRenderer({
  type,
  body,
}: {
  type: ProposalTypeId;
  body: unknown;
}) {
  const section = SECTIONS[type] as { title: string; description: string } | undefined;

  if (!section) {
    return (
      <Alert tone="warning" title={`Tipo de proposta desconhecido: ${String(type)}`}>
        <BodyPre body={body} />
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader title={section.title} description={section.description} />
      <CardBody>
        <BodyPre body={body} />
      </CardBody>
    </Card>
  );
}
