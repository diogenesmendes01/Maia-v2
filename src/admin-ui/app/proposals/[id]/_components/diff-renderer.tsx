'use client';

import * as React from 'react';
import type { ProposalTypeId } from '../../../../trpc/types.js';
import { Card, CardHeader, CardBody } from '../../../../components/ui/card.js';
import { Alert } from '../../../../components/ui/states.js';

/**
 * Renderizador de diff por tipo de proposta (ver proposal-type-registry.ts).
 * A lógica por tipo permanece a do P8.5 v1.0: corpo bruto em JSON formatado;
 * o diff JSON detalhado chega no P8.5 v1.1 (react-diff-viewer-continued já
 * está disponível para essa evolução).
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
