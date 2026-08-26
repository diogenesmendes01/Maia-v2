/**
 * Issue #632 (fatia C da épica #506) — o contrato PURO da entrega.
 *
 * Sem banco, sem Redis, sem mock: `delivery-contract.ts` e `delivery-job.ts`
 * são funções. O que este arquivo prova é que as DECISÕES que autorizam um
 * efeito externo repetido são as declaradas — e a única forma de errar aqui é
 * um mapeamento silenciosamente trocado, que é exatamente o que uma tabela
 * exaustiva pega.
 */
import { describe, it, expect } from 'vitest';
import {
  OUTBOUND_DELIVERY_OUTCOMES,
  OUTBOUND_PAYLOAD_TYPES,
  OUTBOUND_PROVIDER_CHANNELS,
  OUTBOUND_SELECTABLE_STATUSES,
  type OutboundDeliveryOutcome,
  type OutboundPayloadType,
} from '@/runtime/outbound/contract.js';
import {
  DELIVERY_CLAIMABLE_STATUSES,
  DELIVERY_TAKEOVER_STATUSES,
  DELIVERY_UNKNOWN_OUTCOMES,
  PROVIDER_IDEMPOTENCY_NATIVE,
  PROVIDER_IDEMPOTENCY_NONE,
  autoResendAllowed,
  claimDisposition,
  isDeliveryUnknown,
  normalizeProviderOutcome,
  outboundDeliveryWorkerId,
  providerIdempotencySupport,
  retrySafety,
  shouldPassIdempotencyKey,
  statusForOutcome,
  __resetDeliveryWorkerIdForTest,
} from '@/runtime/outbound/delivery-contract.js';
import {
  buildOutboundDeliveryJob,
  outboundDeliveryJobId,
  outboundIdFromJobId,
  parseOutboundDeliveryJob,
} from '@/runtime/outbound/delivery-job.js';

describe('#632 — elegibilidade do claim de entrega', () => {
  it('a lista de claim NOVO é a MESMA do índice de seleção de #630', () => {
    // Divergir faz a seleção deixar de ser indexada e virar seq scan na
    // tabela mais quente do caminho de resposta.
    expect([...DELIVERY_CLAIMABLE_STATUSES]).toEqual([...OUTBOUND_SELECTABLE_STATUSES]);
  });

  it('nenhum estado terminal é reivindicável — nem por claim novo, nem por takeover', () => {
    const reivindicaveis = new Set<string>([
      ...DELIVERY_CLAIMABLE_STATUSES,
      ...DELIVERY_TAKEOVER_STATUSES,
    ]);
    for (const terminal of [
      'delivered',
      'completed',
      'delivery_unknown',
      'reconciling',
      'failed_terminal',
      'cancelled',
    ]) {
      expect(reivindicaveis.has(terminal), `${terminal} não pode ser reivindicável`).toBe(false);
    }
  });

  it('uma linha tomada em `sending` NÃO autoriza envio — só reconciliação', () => {
    // O critério de pronto nº 3, no nível do contrato. A camada estrutural
    // (o `WHERE status = 'claimed'` de `markSending`) é verificada no teste
    // de integração; aqui garante-se que a decisão declarada é a mesma.
    expect(claimDisposition('sending')).toBe('delivery_unknown');
    expect(claimDisposition('claimed')).toBe('send');
  });
});

describe('#632 — capability de idempotência do provedor', () => {
  it('só texto e status_fallback têm chave NATIVA no WhatsApp', () => {
    // Verificado contra `LineOutput` (src/gateway/line-output.ts): apenas
    // `sendText` declara `messageId`. Declarar `native` para os outros seria
    // autorizar reenvio de um áudio que o usuário já ouviu.
    expect(providerIdempotencySupport('whatsapp', 'text')).toBe(PROVIDER_IDEMPOTENCY_NATIVE);
    expect(providerIdempotencySupport('whatsapp', 'status_fallback')).toBe(
      PROVIDER_IDEMPOTENCY_NATIVE,
    );
    for (const tipo of ['audio', 'document', 'reaction', 'interactive_poll'] as const) {
      expect(providerIdempotencySupport('whatsapp', tipo), tipo).toBe(PROVIDER_IDEMPOTENCY_NONE);
    }
  });

  it('TODO payload_type de #630 tem capability declarada — nenhum default otimista', () => {
    for (const canal of OUTBOUND_PROVIDER_CHANNELS) {
      for (const tipo of OUTBOUND_PAYLOAD_TYPES) {
        const s = providerIdempotencySupport(canal, tipo);
        expect([PROVIDER_IDEMPOTENCY_NATIVE, PROVIDER_IDEMPOTENCY_NONE], `${canal}/${tipo}`)
          .toContain(s);
      }
    }
  });

  it('a chave só é PASSADA onde a primitiva a aceita', () => {
    expect(shouldPassIdempotencyKey('whatsapp', 'text')).toBe(true);
    expect(shouldPassIdempotencyKey('whatsapp', 'document')).toBe(false);
  });
});

describe('#632 — normalização: sete categorias, nunca duas', () => {
  it('cada observação bruta mapeia para exatamente um dos SETE desfechos', () => {
    const casos: Array<[Parameters<typeof normalizeProviderOutcome>[0], OutboundDeliveryOutcome]> =
      [
        [{ kind: 'accepted_with_id', provider_message_id: '3EB0AA' }, 'accepted_confirmed'],
        [{ kind: 'accepted_without_id' }, 'accepted_unconfirmed'],
        [{ kind: 'rejected_transient', error_code: 'x' }, 'rejected_retryable'],
        [{ kind: 'rejected_permanent', error_code: 'x' }, 'rejected_terminal'],
        [{ kind: 'timeout', error_code: 'x' }, 'timeout_unknown'],
        [{ kind: 'aborted', after_send: false, error_code: 'x' }, 'cancelled_before_send'],
        [
          { kind: 'aborted', after_send: true, error_code: 'x' },
          'cancelled_after_send_unknown',
        ],
      ];
    for (const [obs, esperado] of casos) {
      expect(normalizeProviderOutcome(obs), obs.kind).toBe(esperado);
    }
    // Os sete são cobertos: a normalização não colapsa nenhuma categoria.
    const cobertos = new Set(casos.map(([, o]) => o));
    expect(cobertos.size).toBe(OUTBOUND_DELIVERY_OUTCOMES.length);
  });

  it('um throw de transporte AMBÍGUO vira timeout_unknown, não rejected_retryable', () => {
    // A distinção que impede o reenvio cego: se pode ter chegado, chamar de
    // "recusa transitória" autorizaria retry automático.
    expect(
      normalizeProviderOutcome({ kind: 'transport_throw', ambiguous: true, error_code: 'x' }),
    ).toBe('timeout_unknown');
    expect(
      normalizeProviderOutcome({ kind: 'transport_throw', ambiguous: false, error_code: 'x' }),
    ).toBe('rejected_retryable');
  });
});

describe('#632 — o estado é nomeado honestamente', () => {
  it('accepted_unconfirmed NÃO é delivered', () => {
    // A linha mais importante da tabela. "O provedor aceitou" não é "o usuário
    // recebeu": chamar isso de `delivered` tiraria a linha do radar da
    // reconciliação para sempre.
    expect(statusForOutcome('accepted_unconfirmed')).toBe('delivery_unknown');
    expect(statusForOutcome('accepted_confirmed')).toBe('delivered');
  });

  it('a tabela de estados é total e sem surpresa', () => {
    const esperado: Record<OutboundDeliveryOutcome, string> = {
      accepted_confirmed: 'delivered',
      accepted_unconfirmed: 'delivery_unknown',
      rejected_retryable: 'retryable',
      rejected_terminal: 'failed_terminal',
      timeout_unknown: 'delivery_unknown',
      cancelled_before_send: 'cancelled',
      cancelled_after_send_unknown: 'delivery_unknown',
    };
    for (const outcome of OUTBOUND_DELIVERY_OUTCOMES) {
      expect(statusForOutcome(outcome), outcome).toBe(esperado[outcome]);
    }
  });

  it('a família DESCONHECIDA é exatamente as três categorias honestas de #506', () => {
    expect([...DELIVERY_UNKNOWN_OUTCOMES].sort()).toEqual(
      ['accepted_unconfirmed', 'cancelled_after_send_unknown', 'timeout_unknown'].sort(),
    );
    for (const o of DELIVERY_UNKNOWN_OUTCOMES) expect(isDeliveryUnknown(o)).toBe(true);
  });
});

describe('#632 — política de reenvio', () => {
  it('reenvio automático só quando a semântica EXCLUI entrega anterior', () => {
    for (const outcome of ['rejected_retryable', 'cancelled_before_send'] as const) {
      // `document` é o caso sem chave nativa: mesmo assim é seguro, porque
      // nada saiu.
      expect(retrySafety({ outcome, channel: 'whatsapp', payload_type: 'document' })).toBe('safe');
    }
  });

  it('desfecho DESCONHECIDO sem chave nativa NUNCA autoriza reenvio automático', () => {
    for (const outcome of DELIVERY_UNKNOWN_OUTCOMES) {
      for (const tipo of ['audio', 'document', 'reaction', 'interactive_poll'] as const) {
        expect(
          retrySafety({ outcome, channel: 'whatsapp', payload_type: tipo }),
          `${outcome}/${tipo}`,
        ).toBe('reconcile');
        expect(autoResendAllowed({ outcome, channel: 'whatsapp', payload_type: tipo })).toBe(
          false,
        );
      }
    }
  });

  it('desfecho DESCONHECIDO com chave nativa é seguro POR PROPRIEDADE DO PROVEDOR', () => {
    for (const outcome of DELIVERY_UNKNOWN_OUTCOMES) {
      expect(retrySafety({ outcome, channel: 'whatsapp', payload_type: 'text' })).toBe(
        'idempotent',
      );
      expect(autoResendAllowed({ outcome, channel: 'whatsapp', payload_type: 'text' })).toBe(true);
    }
  });

  it('terminal nunca é reenviado — nem com chave nativa', () => {
    expect(retrySafety({ outcome: 'rejected_terminal', channel: 'whatsapp', payload_type: 'text' }))
      .toBe('reconcile');
    expect(
      autoResendAllowed({
        outcome: 'rejected_terminal',
        channel: 'whatsapp',
        payload_type: 'text',
      }),
    ).toBe(false);
  });

  it('todo par (desfecho, tipo) tem veredito — a matriz é total', () => {
    for (const outcome of OUTBOUND_DELIVERY_OUTCOMES) {
      for (const tipo of OUTBOUND_PAYLOAD_TYPES as readonly OutboundPayloadType[]) {
        expect(['safe', 'idempotent', 'reconcile'], `${outcome}/${tipo}`).toContain(
          retrySafety({ outcome, channel: 'whatsapp', payload_type: tipo }),
        );
      }
    }
  });
});

describe('#632 — identidade do worker de entrega', () => {
  it('distingue-se da identidade de turno e muda a cada encarnação', () => {
    __resetDeliveryWorkerIdForTest();
    const a = outboundDeliveryWorkerId();
    expect(a).toContain(':outbound:');
    // Memoizada dentro do processo: a posse não pode trocar de nome no meio.
    expect(outboundDeliveryWorkerId()).toBe(a);
    __resetDeliveryWorkerIdForTest();
    expect(outboundDeliveryWorkerId()).not.toBe(a);
  });
});

describe('#632 — job de entrega com id determinístico por outbound_id', () => {
  const ID = '5f2b8c1e-9a4d-4c7b-8e3f-1a2b3c4d5e6f';

  it('mesma linha ⇒ mesmo jobId, sempre', () => {
    expect(outboundDeliveryJobId(ID)).toBe(`outbound-${ID}`);
    expect(outboundDeliveryJobId(ID)).toBe(outboundDeliveryJobId(ID));
  });

  it('normaliza caixa — o jobId é uma CHAVE do Redis, não um valor', () => {
    expect(outboundDeliveryJobId(ID.toUpperCase())).toBe(outboundDeliveryJobId(ID));
  });

  it('duas linhas do MESMO turno têm jobIds diferentes (multipart não colide)', () => {
    const outro = '5f2b8c1e-9a4d-4c7b-8e3f-1a2b3c4d5e70';
    expect(outboundDeliveryJobId(outro)).not.toBe(outboundDeliveryJobId(ID));
  });

  it('não colide com o namespace do job de turno', () => {
    expect(outboundDeliveryJobId(ID).startsWith('turn-')).toBe(false);
    expect(outboundIdFromJobId(`turn-${ID}`)).toBeNull();
    expect(outboundIdFromJobId(outboundDeliveryJobId(ID))).toBe(ID);
  });

  it('FALHA ALTO em id malformado — um jobId imprevisível anula a garantia', () => {
    expect(() => outboundDeliveryJobId('nao-e-uuid')).toThrow(/outbound_id inválido/);
  });

  it('o payload carrega SÓ a identidade — nada de tenant, telefone ou texto', () => {
    expect(buildOutboundDeliveryJob(ID)).toEqual({ version: 1, outbound_id: ID });
    const comExtra = parseOutboundDeliveryJob({
      version: 1,
      outbound_id: ID,
      telefone: '+5511999999999',
    });
    // `.strict()`: campo desconhecido é REJEITADO, não ignorado em silêncio.
    expect(comExtra.kind).toBe('invalid');
  });

  it('payload irreconhecível vira resultado tipado, não throw, e não vaza o valor', () => {
    const r = parseOutboundDeliveryJob({ version: 1, outbound_id: 'lixo' });
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.issue).not.toContain('lixo');
  });
});
