/**
 * Issue #633 (fatia D da épica #506) — o contrato PURO da recuperação.
 *
 * Estas asserções não precisam de Postgres nem de Redis, e é isso que as torna
 * a primeira linha de defesa: a decisão "este desfecho autoriza reenvio?" é a
 * mais perigosa da épica, e ela tem de ser verificável mesmo com o CI vermelho
 * por outro motivo.
 *
 * Toda asserção é INVARIANTE ABSOLUTA sobre uma função pura — não há estado
 * mutável entre casos, então a segunda tentativa do `retry: 1` do vitest não
 * pode herdar nada da primeira.
 */
import { describe, it, expect } from 'vitest';

import {
  OUTBOUND_MAX_DELIVERY_ATTEMPTS,
  RECONCILIATION_DEADLINE_MS,
  RECONCILIATION_DISPOSITIONS,
  RECONCILIATION_GRACE_MS,
  RECONCILIATION_RESULTS,
  attemptBudgetExhausted,
  manualRearmDuplicateRisk,
  manualRearmRefusal,
  rearmIdempotencyNote,
  reconciliationDisposition,
} from '@/runtime/outbound/recovery-contract.js';
import {
  DELIVERY_UNKNOWN_OUTCOMES,
  autoResendAllowed,
} from '@/runtime/outbound/delivery-contract.js';
import {
  OUTBOUND_DELIVERY_OUTCOMES,
  OUTBOUND_PAYLOAD_TYPES,
  type OutboundPayloadType,
} from '@/runtime/outbound/contract.js';

const CANAL = 'whatsapp' as const;
/** Passou a carência, longe do prazo total — a janela em que a decisão importa. */
const IDADE_DECIDIVEL = RECONCILIATION_GRACE_MS + 1_000;

describe('#633 — a disposição da reconciliação', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // A REGRA CENTRAL: não existe reenvio cego, para NENHUM tipo sem chave.
  // ═══════════════════════════════════════════════════════════════════════

  it('nenhum tipo SEM chave nativa recebe `resend_idempotent`, em nenhum desfecho incerto', () => {
    const semChave = OUTBOUND_PAYLOAD_TYPES.filter(
      (t) => !autoResendAllowed({ outcome: 'timeout_unknown', channel: CANAL, payload_type: t }),
    );
    // A lista não é escrita à mão aqui: ela vem da capability de #632. Se
    // alguém declarar `native` para um tipo novo, este teste passa a cobri-lo
    // pelo outro caso.
    expect(semChave.length).toBeGreaterThan(0);
    for (const payload_type of semChave) {
      for (const outcome of DELIVERY_UNKNOWN_OUTCOMES) {
        const d = reconciliationDisposition({
          outcome,
          channel: CANAL,
          payload_type,
          attempt: 0,
          age_ms: IDADE_DECIDIVEL,
        });
        // INVARIANTE ABSOLUTA: a disposição de reenvio é INALCANÇÁVEL.
        expect(d).toBe('escalate_manual');
        expect(d).not.toBe('resend_idempotent');
      }
    }
  });

  it('os tipos COM chave nativa recebem `resend_idempotent` — o reenvio é do provedor, não nosso', () => {
    const comChave = OUTBOUND_PAYLOAD_TYPES.filter((t) =>
      autoResendAllowed({ outcome: 'timeout_unknown', channel: CANAL, payload_type: t }),
    );
    expect(comChave).toEqual(expect.arrayContaining(['text', 'status_fallback']));
    for (const payload_type of comChave) {
      for (const outcome of DELIVERY_UNKNOWN_OUTCOMES) {
        expect(
          reconciliationDisposition({
            outcome,
            channel: CANAL,
            payload_type,
            attempt: 0,
            age_ms: IDADE_DECIDIVEL,
          }),
        ).toBe('resend_idempotent');
      }
    }
  });

  it('a disposição NUNCA discorda de `autoResendAllowed` — a política tem um dono só', () => {
    for (const payload_type of OUTBOUND_PAYLOAD_TYPES) {
      for (const outcome of DELIVERY_UNKNOWN_OUTCOMES) {
        const permite = autoResendAllowed({ outcome, channel: CANAL, payload_type });
        const d = reconciliationDisposition({
          outcome,
          channel: CANAL,
          payload_type,
          attempt: 0,
          age_ms: IDADE_DECIDIVEL,
        });
        expect(d === 'resend_idempotent').toBe(permite);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A ORDEM DAS PERGUNTAS.
  // ═══════════════════════════════════════════════════════════════════════

  it('dentro da carência nada acontece, nem para o tipo idempotente', () => {
    expect(
      reconciliationDisposition({
        outcome: 'accepted_unconfirmed',
        channel: CANAL,
        payload_type: 'text',
        attempt: 0,
        age_ms: RECONCILIATION_GRACE_MS - 1,
      }),
    ).toBe('await_grace');
  });

  it('o teto de tentativas vence a idempotência — senão o reenvio "seguro" viraria loop', () => {
    expect(
      reconciliationDisposition({
        outcome: 'accepted_unconfirmed',
        channel: CANAL,
        payload_type: 'text',
        attempt: OUTBOUND_MAX_DELIVERY_ATTEMPTS,
        age_ms: IDADE_DECIDIVEL,
      }),
    ).toBe('dead_letter');
  });

  it('o prazo total vence a carência e a idempotência', () => {
    expect(
      reconciliationDisposition({
        outcome: 'accepted_unconfirmed',
        channel: CANAL,
        payload_type: 'text',
        attempt: 0,
        age_ms: RECONCILIATION_DEADLINE_MS,
      }),
    ).toBe('dead_letter');
  });

  it('um desfecho que NÃO é da família desconhecida é erro de programação, não uma disposição', () => {
    const conhecidos = OUTBOUND_DELIVERY_OUTCOMES.filter(
      (o) => !(DELIVERY_UNKNOWN_OUTCOMES as readonly string[]).includes(o),
    );
    for (const outcome of conhecidos) {
      expect(() =>
        reconciliationDisposition({
          outcome,
          channel: CANAL,
          payload_type: 'text',
          attempt: 0,
          age_ms: IDADE_DECIDIVEL,
        }),
      ).toThrow(/família desconhecida/);
    }
  });

  it('`resend_blind` não existe no vocabulário — o tipo não consegue expressá-lo', () => {
    expect([...RECONCILIATION_DISPOSITIONS]).toEqual([
      'await_grace',
      'resend_idempotent',
      'escalate_manual',
      'dead_letter',
    ]);
    expect(RECONCILIATION_RESULTS).toContain('noop');
    expect(RECONCILIATION_RESULTS).toContain('history_recovered');
  });

  it('o orçamento de tentativas fecha no teto, não depois dele', () => {
    expect(attemptBudgetExhausted(OUTBOUND_MAX_DELIVERY_ATTEMPTS - 1)).toBe(false);
    expect(attemptBudgetExhausted(OUTBOUND_MAX_DELIVERY_ATTEMPTS)).toBe(true);
  });
});

describe('#633 — o rearmamento manual (falha #12 da épica)', () => {
  it('há risco de duplicata SÓ quando o desfecho é incerto E o provedor não deduplica', () => {
    // Incerto + sem chave = risco.
    expect(
      manualRearmDuplicateRisk({
        outcome: 'timeout_unknown',
        channel: CANAL,
        payload_type: 'audio',
      }),
    ).toBe(true);
    // Incerto + COM chave = sem risco (o provedor colapsa os dois envios).
    expect(
      manualRearmDuplicateRisk({
        outcome: 'timeout_unknown',
        channel: CANAL,
        payload_type: 'text',
      }),
    ).toBe(false);
    // Recusa conhecida, nada saiu = sem risco.
    expect(
      manualRearmDuplicateRisk({
        outcome: 'rejected_retryable',
        channel: CANAL,
        payload_type: 'audio',
      }),
    ).toBe(false);
    // Nunca houve desfecho = nada saiu.
    expect(
      manualRearmDuplicateRisk({ outcome: null, channel: CANAL, payload_type: 'audio' }),
    ).toBe(false);
  });

  it('a confirmação é FAIL-CLOSED: ausente e `false` são recusa, só `true` passa', () => {
    const base = { status: 'dead_letter', reason: 'o cliente reclamou', duplicate_risk: true };
    expect(manualRearmRefusal(base)).toBe('duplicate_risk_unacknowledged');
    expect(manualRearmRefusal({ ...base, acknowledge_duplicate_risk: false })).toBe(
      'duplicate_risk_unacknowledged',
    );
    expect(
      manualRearmRefusal({ ...base, acknowledge_duplicate_risk: undefined }),
    ).toBe('duplicate_risk_unacknowledged');
    expect(manualRearmRefusal({ ...base, acknowledge_duplicate_risk: true })).toBeNull();
  });

  it('`reason` em branco é recusa — a auditoria é o ponto da operação', () => {
    expect(
      manualRearmRefusal({ status: 'dead_letter', reason: '   ', duplicate_risk: false }),
    ).toBe('reason_missing');
  });

  it('`failed_terminal` e os estados concluídos não são rearmáveis', () => {
    for (const status of ['failed_terminal', 'completed', 'delivered', 'sent', 'sending']) {
      expect(
        manualRearmRefusal({ status, reason: 'x', duplicate_risk: false }),
      ).toBe('status_not_rearmable');
    }
  });

  it('a nota de idempotência diz a VERDADE sobre cada tipo', () => {
    const tipos = OUTBOUND_PAYLOAD_TYPES as readonly OutboundPayloadType[];
    for (const t of tipos) {
      const nota = rearmIdempotencyNote(CANAL, t);
      const esperaNative = t === 'text' || t === 'status_fallback';
      expect(nota.support).toBe(esperaNative ? 'native' : 'none');
      expect(nota.note).toContain(t);
      if (!esperaNative) expect(nota.note).toContain('SEGUNDA mensagem');
    }
  });
});
