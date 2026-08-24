/**
 * Issue #630 (fatia A da épica #506) — contrato do outbox durável de saída.
 *
 * ------------------------------------------------------------------
 * ANCORAGEM: por que este arquivo NUNCA recalcula a fórmula
 * ------------------------------------------------------------------
 * A armadilha clássica de um teste de chave derivada é o ESPELHO: o teste
 * reimplementa a fórmula (sha256 de tal string) e compara com a produção.
 * Esse teste passa mesmo se a função de produção for DELETADA e substituída
 * por outra cópia — ele está testando a própria aritmética, não o código que
 * roda.
 *
 * Aqui não existe nenhuma cópia da fórmula. Não há hash literal esperado, não
 * há concatenação replicada, não há `sha256(...)` no arquivo. Tudo é afirmado
 * por RELAÇÃO entre saídas da função REAL de produção
 * (`src/runtime/outbound/contract.ts`) — iguais quando devem ser iguais,
 * diferentes quando devem ser diferentes — mais o formato. Se a função sumir, o
 * import quebra; se ela mudar de comportamento, a relação quebra.
 *
 * Bônus prático: sem hash literal no arquivo, não há string de alta entropia
 * para o gitleaks classificar como `generic-api-key`.
 */
import { describe, it, expect } from 'vitest';
import {
  OUTBOUND_PAYLOAD_VERSION,
  OUTBOUND_PAYLOAD_TYPES,
  OUTBOUND_PAYLOAD_TYPES_UNSUPPORTED,
  OUTBOUND_STATUSES,
  OUTBOUND_SELECTABLE_STATUSES,
  OUTBOUND_DELIVERY_OUTCOMES,
  OUTBOUND_AUTO_RETRYABLE_OUTCOMES,
  isAutoRetryable,
  outboundPayloadSchema,
  parseOutboundPayload,
  canonicalizeOutboundPayload,
  computePayloadHash,
  deriveLogicalDedupeKey,
  deriveProviderIdempotencyKey,
  deriveOutboundKeys,
  deriveOutboundKeysFromRow,
  buildOutboundArtifact,
  type OutboundPayload,
  type OutboundLogicalIdentity,
  type OutboundKeyRowProjection,
} from '@/runtime/outbound/index.js';

// Fixtures deliberadamente de BAIXA entropia e obviamente sintéticas: o
// gitleaks varre a HISTÓRIA, e uma "chave de exemplo" aleatória num teste de
// idempotência é exatamente o que a regra `generic-api-key` procura.
const TENANT = 'tenant-alfa';
const AGENT = 'agente-um';
const TURN = '00000000-0000-4000-8000-000000000001';
const OUTRO_TURN = '00000000-0000-4000-8000-000000000002';

const TEXTO: OutboundPayload = { type: 'text', text: 'bom dia' };
const OUTRO_TEXTO: OutboundPayload = { type: 'text', text: 'boa tarde' };

function identidade(over: Partial<OutboundLogicalIdentity> = {}): OutboundLogicalIdentity {
  return {
    tenant_id: TENANT,
    agent_id: AGENT,
    turn_id: TURN,
    sequence_in_turn: 0,
    payload_hash: computePayloadHash(TEXTO),
    ...over,
  };
}

// =====================================================================
// União discriminada
// =====================================================================

describe('#630 — união de payload: só o que a plataforma declara enviar', () => {
  it('aceita cada tipo suportado e recusa o tipo desconhecido', () => {
    const validos: OutboundPayload[] = [
      { type: 'text', text: 'oi' },
      {
        type: 'audio',
        media: { kind: 'local_path', path: '/tmp/voz.ogg' },
        mimetype: 'audio/ogg; codecs=opus',
        source_text: 'oi',
      },
      {
        type: 'document',
        media: { kind: 'storage_object', bucket: 'maia-docs', object_key: 'extrato.pdf' },
        mimetype: 'application/pdf',
        file_name: 'extrato.pdf',
      },
      { type: 'reaction', target_provider_message_id: 'ABC123', emoji: '✅' },
      {
        type: 'interactive_poll',
        question: 'confirma?',
        options: [
          { key: 'sim', label: 'Sim' },
          { key: 'nao', label: 'Não' },
        ],
      },
      { type: 'status_fallback', text: 'demorei demais', reason: 'timeout' },
    ];
    for (const p of validos) expect(() => parseOutboundPayload(p)).not.toThrow();
    // O conjunto acima cobre a união inteira — se alguém acrescentar um tipo
    // sem cobri-lo aqui, esta contagem denuncia.
    expect(new Set(validos.map((p) => p.type)).size).toBe(OUTBOUND_PAYLOAD_TYPES.length);
    expect(() => parseOutboundPayload({ type: 'sticker', text: 'x' })).toThrow();
  });

  it('NÃO aceita image nem video — LineOutput não declara primitiva para eles', () => {
    // #506 §Out of Scope: não implementar tipo que a plataforma ainda não
    // suporta. Uma row `image` seria um pending que nenhum worker entrega.
    expect(() =>
      parseOutboundPayload({
        type: 'image',
        media: { kind: 'local_path', path: '/tmp/a.png' },
        mimetype: 'image/png',
      }),
    ).toThrow();
    expect(() =>
      parseOutboundPayload({
        type: 'video',
        media: { kind: 'local_path', path: '/tmp/a.mp4' },
        mimetype: 'video/mp4',
      }),
    ).toThrow();
  });

  it('o inventário de não-suportados não intersecta a lista de suportados', () => {
    // Impede que o comentário e o código divirjam: acrescentar um tipo à união
    // sem tirá-lo da lista de exclusões (ou vice-versa) reprova aqui.
    const suportados = new Set<string>(OUTBOUND_PAYLOAD_TYPES);
    for (const excluido of Object.keys(OUTBOUND_PAYLOAD_TYPES_UNSUPPORTED)) {
      expect(suportados.has(excluido)).toBe(false);
    }
    expect(Object.keys(OUTBOUND_PAYLOAD_TYPES_UNSUPPORTED)).toContain('image');
    expect(Object.keys(OUTBOUND_PAYLOAD_TYPES_UNSUPPORTED)).toContain('video');
    // `interactive` genérico não existe; a única forma real é a enquete.
    expect(suportados.has('interactive')).toBe(false);
    expect(suportados.has('interactive_poll')).toBe(true);
  });

  it('recusa campo desconhecido em vez de ignorá-lo', () => {
    // Campo tolerado = conteúdo FORA do payload_hash. Duas saídas diferentes
    // passariam a hashear igual, e a chave de idempotência deixaria de
    // distinguir o que precisa distinguir.
    expect(() => parseOutboundPayload({ type: 'text', text: 'oi', extra: 1 })).toThrow();
  });

  it('mídia só existe por referência — não há forma de persistir URL assinada', () => {
    // A garantia é ESTRUTURAL: nenhuma variante aceita URL. Não depende de uma
    // lista de nomes de parâmetro de assinatura estar completa.
    expect(() =>
      parseOutboundPayload({
        type: 'document',
        media: { kind: 'url', url: 'https://exemplo.invalid/a.pdf?X-Amz-Signature=x' },
        mimetype: 'application/pdf',
        file_name: 'a.pdf',
      }),
    ).toThrow();
    expect(() =>
      parseOutboundPayload({
        type: 'document',
        media: {
          kind: 'local_path',
          path: '/tmp/a.pdf',
          signed_url: 'https://exemplo.invalid/a.pdf?sig=x',
        },
        mimetype: 'application/pdf',
        file_name: 'a.pdf',
      }),
    ).toThrow();
  });

  it('reação só admite os emojis que LineOutput.sendReaction aceita', () => {
    expect(() =>
      parseOutboundPayload({ type: 'reaction', target_provider_message_id: 'A', emoji: '🎉' }),
    ).toThrow();
  });

  it('enquete exige pelo menos duas opções', () => {
    expect(() =>
      parseOutboundPayload({
        type: 'interactive_poll',
        question: 'q',
        options: [{ key: 'a', label: 'A' }],
      }),
    ).toThrow();
  });

  it('a união é discriminada por `type`, o mesmo literal que vai para payload_type', () => {
    const parsed = outboundPayloadSchema.parse(TEXTO);
    expect(OUTBOUND_PAYLOAD_TYPES).toContain(parsed.type);
  });
});

// =====================================================================
// Serialização canônica e payload_hash
// =====================================================================

describe('#630 — serialização canônica versionada', () => {
  it('a ordem das chaves do objeto não muda o hash', () => {
    // JSON.stringify segue a ordem de INSERÇÃO. Sem canonicalização, o mesmo
    // payload hashearia diferente depois de um round-trip pelo JSONB (que
    // reordena) — e a mesma saída lógica duplicaria.
    const a = {
      type: 'document',
      media: { kind: 'storage_object', bucket: 'b', object_key: 'k' },
      mimetype: 'application/pdf',
      file_name: 'x.pdf',
    } as const;
    const b = {
      file_name: 'x.pdf',
      mimetype: 'application/pdf',
      media: { object_key: 'k', kind: 'storage_object', bucket: 'b' },
      type: 'document',
    } as const;
    expect(computePayloadHash(a as OutboundPayload)).toBe(
      computePayloadHash(b as OutboundPayload),
    );
  });

  it('a ordem das opções da enquete MUDA o hash — ali a ordem é semântica', () => {
    const p1: OutboundPayload = {
      type: 'interactive_poll',
      question: 'q',
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
    };
    const p2: OutboundPayload = {
      type: 'interactive_poll',
      question: 'q',
      options: [
        { key: 'b', label: 'B' },
        { key: 'a', label: 'A' },
      ],
    };
    expect(computePayloadHash(p1)).not.toBe(computePayloadHash(p2));
  });

  it('a serialização carrega a VERSÃO — hash antigo continua verificável pela regra antiga', () => {
    expect(canonicalizeOutboundPayload(TEXTO)).toContain(
      `maia.outbound.payload/v${OUTBOUND_PAYLOAD_VERSION}`,
    );
  });

  it('o hash tem o formato que o CHECK da migração 121 exige (64 hex minúsculo)', () => {
    expect(computePayloadHash(TEXTO)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('payloads diferentes têm hashes diferentes', () => {
    expect(computePayloadHash(TEXTO)).not.toBe(computePayloadHash(OUTRO_TEXTO));
  });
});

// =====================================================================
// AS DUAS IDENTIDADES — o núcleo da fatia
// =====================================================================

describe('#630 — as duas identidades são estáveis, distintas e não vazam', () => {
  it('mesma saída lógica ⇒ mesmas duas chaves (o retry reutiliza)', () => {
    const a = deriveOutboundKeys(identidade(), 'whatsapp');
    const b = deriveOutboundKeys(identidade(), 'whatsapp');
    expect(a.logical_dedupe_key).toBe(b.logical_dedupe_key);
    expect(a.provider_idempotency_key).toBe(b.provider_idempotency_key);
  });

  it('as duas chaves são valores DISTINTOS — nenhuma é a outra', () => {
    // Se fossem iguais, o provedor receberia o eixo de unicidade interno da
    // Maia; é a razão de existirem duas colunas e não uma.
    const k = deriveOutboundKeys(identidade(), 'whatsapp');
    expect(k.provider_idempotency_key).not.toBe(k.logical_dedupe_key);
    expect(k.logical_dedupe_key).not.toContain(k.provider_idempotency_key);
    expect(k.provider_idempotency_key).not.toContain(k.logical_dedupe_key);
  });

  it('nenhuma das duas expõe tenant, agent, turn ou conteúdo em claro', () => {
    const conteudo = 'saldo da conta do cliente';
    const payload: OutboundPayload = { type: 'text', text: conteudo };
    const k = deriveOutboundKeys(
      identidade({ payload_hash: computePayloadHash(payload) }),
      'whatsapp',
    );
    for (const chave of [k.logical_dedupe_key, k.provider_idempotency_key]) {
      expect(chave).not.toContain(TENANT);
      expect(chave).not.toContain(AGENT);
      expect(chave).not.toContain(TURN);
      expect(chave).not.toContain(conteudo);
    }
  });

  it('a chave do provedor tem o formato de message id do WhatsApp', () => {
    // `3EB0` + 18 hex maiúsculo: o mesmo formato que a plataforma já usa em
    // produção (deriveProviderDedupKey) e que o Baileys grava verbatim.
    expect(deriveProviderIdempotencyKey(identidade(), 'whatsapp')).toMatch(
      /^3EB0[0-9A-F]{18}$/,
    );
  });

  it('a chave lógica é um digest prefixado e versionado', () => {
    expect(deriveLogicalDedupeKey(identidade())).toMatch(/^mol1_[0-9a-f]{64}$/);
  });
});

describe('#630 — SONDA 1: o enquadramento por comprimento impede colisão por ambiguidade', () => {
  it('tenant/agent que contêm o separador NÃO colidem', () => {
    // `tenants.id` e `agents.id` são TEXT PRIMARY KEY sem CHECK de formato
    // (migração 007) — um id PODE conter ':'. Sob concatenação ingênua com
    // ':' estas duas tuplas produzem o MESMO material:
    //     ('acme:x', 'y')  →  "...:acme:x:y:..."
    //     ('acme', 'x:y')  →  "...:acme:x:y:..."
    // Duas tenants diferentes, uma chave só: violação de isolamento.
    const a = deriveOutboundKeys(identidade({ tenant_id: 'acme:x', agent_id: 'y' }), 'whatsapp');
    const b = deriveOutboundKeys(identidade({ tenant_id: 'acme', agent_id: 'x:y' }), 'whatsapp');
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
    expect(a.provider_idempotency_key).not.toBe(b.provider_idempotency_key);
  });

  it('nem sob outros separadores plausíveis (NUL, |, /)', () => {
    // O enquadramento por comprimento não depende de NENHUMA suposição sobre
    // o conteúdo — inclusive não depende de "ninguém usa NUL".
    for (const sep of [' ', '|', '/']) {
      const a = deriveOutboundKeys(
        identidade({ tenant_id: `acme${sep}x`, agent_id: 'y' }),
        'whatsapp',
      );
      const b = deriveOutboundKeys(
        identidade({ tenant_id: 'acme', agent_id: `x${sep}y` }),
        'whatsapp',
      );
      expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
    }
  });

  it('turn/sequence ambíguos também não colidem', () => {
    // ('...01', 12) vs ('...012', 1) — o mesmo problema, no outro par.
    const a = deriveOutboundKeys(identidade({ turn_id: 'turno-1', sequence_in_turn: 12 }), 'whatsapp');
    const b = deriveOutboundKeys(identidade({ turn_id: 'turno-12', sequence_in_turn: 1 }), 'whatsapp');
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
  });
});

describe('#630 — SONDA 2: a chave não pode depender de campo mutável', () => {
  it('a chave derivada da ROW não se move quando os campos mutáveis mudam', () => {
    // Este é o caminho REAL da #632: o worker carrega a row e deriva a chave
    // para a tentativa N. A assinatura aceita a row INTEIRA (com os mutáveis)
    // e o corpo escolhe só os imutáveis — se alguém incluir `attempt` "porque
    // identifica a tentativa", o outbox para de deduplicar e este teste cai.
    const base: OutboundKeyRowProjection = {
      ...identidade(),
      attempt: 0,
      status: 'pending',
      claimed_by: null,
      claim_token: null,
      lease_expires_at: null,
      next_attempt_at: new Date('2026-01-01T00:00:00Z'),
      provider_message_id: null,
      provider_timestamp: null,
      last_error_code: null,
      delivery_outcome: null,
      sent_at: null,
      updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    const depoisDeFalhar: OutboundKeyRowProjection = {
      ...base,
      attempt: 3,
      status: 'retryable',
      claimed_by: 'worker-b',
      claim_token: '00000000-0000-4000-8000-0000000000ff',
      lease_expires_at: new Date('2026-01-01T00:05:00Z'),
      next_attempt_at: new Date('2026-01-01T00:10:00Z'),
      provider_message_id: 'ABC',
      provider_timestamp: new Date('2026-01-01T00:02:00Z'),
      last_error_code: 'transport_timeout',
      delivery_outcome: 'timeout_unknown',
      sent_at: new Date('2026-01-01T00:02:00Z'),
      updated_at: new Date('2026-01-01T00:10:00Z'),
    };
    const antes = deriveOutboundKeysFromRow(base, 'whatsapp');
    const depois = deriveOutboundKeysFromRow(depoisDeFalhar, 'whatsapp');
    expect(depois.logical_dedupe_key).toBe(antes.logical_dedupe_key);
    expect(depois.provider_idempotency_key).toBe(antes.provider_idempotency_key);
  });

  it('a chave da row bate com a chave derivada da identidade pura', () => {
    // Ancora os dois caminhos de produção um no outro: se a projeção da row
    // divergir da derivação direta, o worker chavearia diferente do escritor.
    const id = identidade();
    expect(deriveOutboundKeysFromRow({ ...id, attempt: 7 }, 'whatsapp')).toEqual(
      deriveOutboundKeys(id, 'whatsapp'),
    );
  });
});

describe('#630 — SONDA 3: tenant e agent entram no material (isolamento)', () => {
  it('duas tenants com o MESMO turno/sequência/payload não colidem', () => {
    const a = deriveOutboundKeys(identidade({ tenant_id: 'tenant-alfa' }), 'whatsapp');
    const b = deriveOutboundKeys(identidade({ tenant_id: 'tenant-beta' }), 'whatsapp');
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
    expect(a.provider_idempotency_key).not.toBe(b.provider_idempotency_key);
  });

  it('dois agents da MESMA tenant não colidem', () => {
    const a = deriveOutboundKeys(identidade({ agent_id: 'agente-um' }), 'whatsapp');
    const b = deriveOutboundKeys(identidade({ agent_id: 'agente-dois' }), 'whatsapp');
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
    expect(a.provider_idempotency_key).not.toBe(b.provider_idempotency_key);
  });

  it('escopo incompleto FALHA FECHADO em vez de derivar chave degenerada', () => {
    // Uma chave derivada sem tenant colidiria entre tenants. Lançar é a única
    // resposta segura — devolver algo seria fail-open.
    expect(() => deriveLogicalDedupeKey(identidade({ tenant_id: '' }))).toThrow();
    expect(() => deriveLogicalDedupeKey(identidade({ agent_id: '' }))).toThrow();
    expect(() => deriveLogicalDedupeKey(identidade({ turn_id: '' }))).toThrow();
    expect(() => deriveLogicalDedupeKey(identidade({ payload_hash: '' }))).toThrow();
    expect(() => deriveLogicalDedupeKey(identidade({ sequence_in_turn: -1 }))).toThrow();
    expect(() => deriveLogicalDedupeKey(identidade({ sequence_in_turn: 1.5 }))).toThrow();
  });
});

describe('#630 — SONDA 4: payload diferente não reutiliza chave', () => {
  it('mesmo turno e mesma sequência, payload diferente ⇒ chaves diferentes', () => {
    const a = deriveOutboundKeys(
      identidade({ payload_hash: computePayloadHash(TEXTO) }),
      'whatsapp',
    );
    const b = deriveOutboundKeys(
      identidade({ payload_hash: computePayloadHash(OUTRO_TEXTO) }),
      'whatsapp',
    );
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
    expect(a.provider_idempotency_key).not.toBe(b.provider_idempotency_key);
  });

  it('pelo caminho completo do artefato também', () => {
    const base = {
      tenant_id: TENANT,
      agent_id: AGENT,
      turn_id: TURN,
      sequence_in_turn: 0,
      channel: 'whatsapp' as const,
    };
    const a = buildOutboundArtifact({ ...base, payload: TEXTO });
    const b = buildOutboundArtifact({ ...base, payload: OUTRO_TEXTO });
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
    expect(a.provider_idempotency_key).not.toBe(b.provider_idempotency_key);
  });

  it('posições diferentes do MESMO turno com o MESMO texto não colidem', () => {
    // O multipart legítimo (#635) pode repetir conteúdo; a sequência é o que
    // os distingue.
    const a = deriveOutboundKeys(identidade({ sequence_in_turn: 0 }), 'whatsapp');
    const b = deriveOutboundKeys(identidade({ sequence_in_turn: 1 }), 'whatsapp');
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
  });

  it('turnos diferentes não colidem', () => {
    const a = deriveOutboundKeys(identidade({ turn_id: TURN }), 'whatsapp');
    const b = deriveOutboundKeys(identidade({ turn_id: OUTRO_TURN }), 'whatsapp');
    expect(a.logical_dedupe_key).not.toBe(b.logical_dedupe_key);
  });
});

// =====================================================================
// Artefato e vocabulário
// =====================================================================

describe('#630 — artefato durável', () => {
  it('é determinístico e traz o tuplo completo que o CHECK da 121 exige', () => {
    const input = {
      tenant_id: TENANT,
      agent_id: AGENT,
      turn_id: TURN,
      sequence_in_turn: 0,
      payload: TEXTO,
      channel: 'whatsapp' as const,
    };
    const a = buildOutboundArtifact(input);
    expect(buildOutboundArtifact(input)).toEqual(a);
    expect(a.payload_version).toBe(OUTBOUND_PAYLOAD_VERSION);
    expect(a.payload_type).toBe('text');
    expect(a.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.logical_dedupe_key.length).toBeGreaterThan(0);
    expect(a.provider_idempotency_key.length).toBeGreaterThan(0);
    // Nenhum campo do tuplo pode nascer vazio/indefinido — é literalmente o
    // predicado de `outbound_messages_durable_row_complete_check`.
    for (const v of Object.values(a)) expect(v).not.toBeUndefined();
  });

  it('recusa payload inválido antes de derivar qualquer chave', () => {
    expect(() =>
      buildOutboundArtifact({
        tenant_id: TENANT,
        agent_id: AGENT,
        turn_id: TURN,
        sequence_in_turn: 0,
        payload: { type: 'text', text: '' } as OutboundPayload,
        channel: 'whatsapp',
      }),
    ).toThrow();
  });
});

describe('#630 — vocabulário espelhado pela migração 121', () => {
  it('os estados legados da 063 continuam válidos', () => {
    for (const s of ['pending', 'sent', 'failed', 'unknown']) {
      expect(OUTBOUND_STATUSES).toContain(s);
    }
  });

  it('os estados selecionáveis são exatamente o predicado do índice de seleção', () => {
    // Se esta lista e o `WHERE status IN (...)` de idx_outbound_messages_ready
    // divergirem, a seleção do delivery worker vira seq scan silencioso.
    expect([...OUTBOUND_SELECTABLE_STATUSES]).toEqual(['pending', 'retryable']);
    for (const s of OUTBOUND_SELECTABLE_STATUSES) expect(OUTBOUND_STATUSES).toContain(s);
  });

  it('só desfecho que EXCLUI entrega anterior é auto-retryable', () => {
    // `timeout_unknown` e `cancelled_after_send_unknown` são os estados
    // honestos: retry automático a partir deles é reenvio cego.
    expect(isAutoRetryable('rejected_retryable')).toBe(true);
    expect(isAutoRetryable('cancelled_before_send')).toBe(true);
    expect(isAutoRetryable('timeout_unknown')).toBe(false);
    expect(isAutoRetryable('cancelled_after_send_unknown')).toBe(false);
    expect(isAutoRetryable('accepted_unconfirmed')).toBe(false);
    expect(isAutoRetryable('accepted_confirmed')).toBe(false);
    expect(isAutoRetryable('rejected_terminal')).toBe(false);
    for (const o of OUTBOUND_AUTO_RETRYABLE_OUTCOMES) {
      expect(OUTBOUND_DELIVERY_OUTCOMES).toContain(o);
    }
  });
});
