/**
 * Issue #635 (fatia F da épica #506) — a PROJEÇÃO do artefato no histórico,
 * como CONTRATO puro.
 *
 * As três propriedades verificadas aqui não precisam de banco e não podem ser
 * verificadas com banco sem virar ruído:
 *
 *  1. **Totalidade.** Todo `payload_type` que o CHECK da 121 admite tem
 *     projeção declarada. Um tipo novo em #630 sem tratamento aqui produziria
 *     histórico vazio em produção, não erro.
 *  2. **Retenção.** Nenhuma referência de mídia entra no histórico — nem em
 *     `conteudo`, nem em `metadata`. É o §Retenção da issue, e a asserção
 *     percorre `OUTBOUND_PAYLOAD_TYPES` INTEIRO em vez de listar tipos à mão:
 *     acrescentar `image` amanhã sem tratar a referência quebra este arquivo.
 *  3. **A ordem do multipart.** `MULTIPART_RESOLVED_STATUSES` é uma lista de
 *     INCLUSÃO, e o que importa é quem está FORA dela.
 *
 * ─── O que este arquivo deliberadamente NÃO faz ────────────────────────────
 *
 * Não afirma que o texto do histórico é igual ao texto enviado. Não poderia:
 * as duas metades da comparação sairiam da MESMA função, e o teste mediria a si
 * mesmo (a armadilha do espelho). Esse oráculo precisa ser o que o adaptador
 * entregou ao provedor, e vive em
 * `tests/integration/outbound-historico-idempotente-real-db.spec.ts`.
 */
import { describe, it, expect } from 'vitest';

import {
  OUTBOUND_PAYLOAD_TYPES,
  type OutboundPayload,
  type OutboundPayloadType,
} from '@/runtime/outbound/contract.js';
import {
  MEDIA_BEARING_PAYLOAD_FIELDS,
  buildHistoricoFromArtifact,
  historicoProjectionCoversAllPayloadTypes,
} from '@/runtime/outbound/historico.js';
import {
  MULTIPART_RESOLVED_STATUSES,
  multipartArtifactResolved,
} from '@/runtime/outbound/delivery-contract.js';

/**
 * Um payload de cada tipo, com referências de mídia DELIBERADAMENTE
 * reconhecíveis: se qualquer uma vazar para o histórico, a asserção de retenção
 * a encontra por substring em vez de depender de conhecer a forma do vazamento.
 */
const SEGREDO_CAMINHO = '/tmp/segredo-de-midia-635.ogg';
const SEGREDO_BUCKET = 'bucket-secreto-635';
const SEGREDO_OBJETO = 'objeto/secreto/635.pdf';

const PAYLOADS: Record<OutboundPayloadType, OutboundPayload> = {
  text: { type: 'text', text: 'a resposta' },
  status_fallback: { type: 'status_fallback', text: 'não deu', reason: 'timeout' },
  audio: {
    type: 'audio',
    media: { kind: 'local_path', path: SEGREDO_CAMINHO },
    mimetype: 'audio/ogg; codecs=opus',
    source_text: 'a resposta, em voz',
  },
  document: {
    type: 'document',
    media: { kind: 'storage_object', bucket: SEGREDO_BUCKET, object_key: SEGREDO_OBJETO },
    mimetype: 'application/pdf',
    file_name: 'relatorio.pdf',
    caption: 'segue o relatório',
  },
  reaction: { type: 'reaction', target_provider_message_id: 'WA-1', emoji: '✅' },
  interactive_poll: {
    type: 'interactive_poll',
    question: 'qual?',
    options: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ],
  },
};

const CTX = {
  provider_message_id: 'WA-PROVIDER-1',
  jid: '5511900000635@s.whatsapp.net',
  in_reply_to: '00000000-0000-4000-8000-000000000635',
};

describe('#635 — a projeção do artefato no histórico', () => {
  it('cobre TODO payload_type do vocabulário de #630', () => {
    expect(historicoProjectionCoversAllPayloadTypes()).toBe(true);
    // A fixture acima também tem de cobrir a união inteira, senão as asserções
    // de retenção abaixo passariam por omissão.
    for (const tipo of OUTBOUND_PAYLOAD_TYPES) {
      expect(PAYLOADS[tipo], `fixture ausente para ${tipo}`).toBeDefined();
    }
  });

  it('é determinística — duas projeções do mesmo artefato são bit a bit iguais', () => {
    for (const tipo of OUTBOUND_PAYLOAD_TYPES) {
      const a = buildHistoricoFromArtifact(PAYLOADS[tipo], CTX);
      const b = buildHistoricoFromArtifact(PAYLOADS[tipo], CTX);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // RETENÇÃO — §Retenção da #635.
  //
  // INVARIANTE ABSOLUTA, não delta: para cada tipo, a serialização INTEIRA da
  // projeção não contém nenhum dos três segredos de mídia. Um vazamento por
  // qualquer caminho (spread do payload, campo copiado por engano, um tipo novo
  // sem tratamento) aparece aqui como substring.
  // ═════════════════════════════════════════════════════════════════════════

  it('nenhuma referência de mídia entra no histórico, em nenhum tipo', () => {
    for (const tipo of OUTBOUND_PAYLOAD_TYPES) {
      const projecao = buildHistoricoFromArtifact(PAYLOADS[tipo], CTX);
      const serializado = JSON.stringify(projecao);
      expect(serializado, `${tipo} vazou o caminho local`).not.toContain(SEGREDO_CAMINHO);
      expect(serializado, `${tipo} vazou o bucket`).not.toContain(SEGREDO_BUCKET);
      expect(serializado, `${tipo} vazou a object key`).not.toContain(SEGREDO_OBJETO);
      for (const campo of MEDIA_BEARING_PAYLOAD_FIELDS) {
        expect(
          Object.keys(projecao.metadata),
          `${tipo} carregou o campo ${campo} para o metadata`,
        ).not.toContain(campo);
      }
    }
  });

  it('a projeção não tem sequer um campo por onde uma URL de mídia entraria', () => {
    // `midia_url` é gravado como `null` LITERAL por quem insere; a projeção não
    // o oferece. Se alguém acrescentar o campo aqui, esta asserção reprova
    // ANTES de a coluna começar a receber caminhos temporários.
    for (const tipo of OUTBOUND_PAYLOAD_TYPES) {
      const projecao = buildHistoricoFromArtifact(PAYLOADS[tipo], CTX);
      expect(Object.keys(projecao).sort()).toEqual(['conteudo', 'metadata', 'tipo']);
    }
  });

  it('o áudio historia o texto que gerou a voz, nunca a referência do arquivo', () => {
    const projecao = buildHistoricoFromArtifact(PAYLOADS.audio, CTX);
    expect(projecao.conteudo).toBe('a resposta, em voz');
    expect(projecao.tipo).toBe('audio');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // A ORDEM DO MULTIPART — o que NÃO libera o artefato seguinte.
  // ═════════════════════════════════════════════════════════════════════════

  it('os estados INCERTOS bloqueiam o artefato seguinte', () => {
    // Este é o par que importa: `delivery_unknown` e `reconciling` podem ter
    // chegado ao usuário E podem ainda ser reenviados pela reconciliação. Se
    // liberassem o artefato seguinte, a resposta poderia ser lida fora de ordem.
    expect(multipartArtifactResolved('delivery_unknown')).toBe(false);
    expect(multipartArtifactResolved('reconciling')).toBe(false);
  });

  it('o trabalho EM CURSO bloqueia o artefato seguinte', () => {
    for (const status of ['pending', 'retryable', 'claimed', 'sending']) {
      expect(multipartArtifactResolved(status), status).toBe(false);
    }
  });

  it('os estados RESOLVIDOS liberam, e são exatamente cinco', () => {
    for (const status of MULTIPART_RESOLVED_STATUSES) {
      expect(multipartArtifactResolved(status), status).toBe(true);
    }
    expect([...MULTIPART_RESOLVED_STATUSES].sort()).toEqual([
      'cancelled',
      'dead_letter',
      'delivered',
      'failed_terminal',
      'completed',
    ].sort());
  });

  it('um estado DESCONHECIDO bloqueia — a lista é de inclusão', () => {
    // A propriedade que torna a lista segura contra evolução: um estado novo
    // acrescentado ao vocabulário de #630 sem decisão explícita NÃO destrava a
    // ordem por default.
    expect(multipartArtifactResolved('estado_que_ainda_nao_existe')).toBe(false);
  });
});
