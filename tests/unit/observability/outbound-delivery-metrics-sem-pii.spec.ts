/**
 * Issue #632 (fatia C da épica #506) — as duas métricas que a issue exige
 * publicar, e a prova de que NENHUMA delas carrega destinatário, telefone ou
 * conteúdo como label.
 *
 * ## Por que esta sonda existe, e o que ela reprova
 *
 * O critério de pronto diz: "`maia_outbound_lease_lost_total` e
 * `maia_outbound_delivery_unknown_total{channel}` publicadas, sem
 * recipient/phone/conteúdo como label". Um teste que só checasse os NOMES ficaria
 * verde no dia em que alguém acrescentasse `{ phone: pessoa.telefone }` "para
 * facilitar o debug" — e séries do Prometheus são retidas por meses.
 *
 * Então há duas afirmações independentes:
 *
 *  1. as séries EXISTEM com o nome e o rótulo que a issue nomeia (nome errado =
 *     alerta que nunca dispara);
 *  2. o texto RENDERIZADO — que é literalmente o que sai no `/metrics` — não
 *     contém o telefone, o JID nem o conteúdo, mesmo quando alguém tenta
 *     passá-los.
 *
 * A segunda é feita com o gate em modo ESTRITO (`MAIA_STRICT_METRIC_LABELS`),
 * o mesmo regime que a suíte unitária já usa: uma violação vira THROW aqui em
 * vez de vazar em silêncio em produção.
 *
 * ## Invariante ABSOLUTA, não delta
 *
 * `_resetForTests()` zera o registro a cada caso, e toda asserção é sobre o
 * CONTEÚDO renderizado ("contém esta série", "não contém este texto"), nunca
 * sobre "cresceu 1 desde antes". Uma segunda tentativa do vitest (`retry: 1`)
 * parte de um registro limpo e não pode herdar a contagem da primeira como
 * linha de base.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { counter } from '@/observability/metrics.js';
import { sanitizeLabels, _resetLabelGuardForTests } from '@/observability/labels.js';
import {
  ALLOWED_LABEL_KEYS,
  ENUM_VALUES,
  FORBIDDEN_LABEL_KEYS,
  METRIC,
} from '@/observability/taxonomy.js';
import { renderPrometheus, _resetForTests } from '@/lib/metrics.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { OUTBOUND_PROVIDER_CHANNELS } from '@/runtime/outbound/contract.js';
import { DELIVERY_LEASE_LOSS_REASONS } from '@/runtime/outbound/delivery-contract.js';

const TELEFONE = '+5511987654321';
const JID = '5511987654321@s.whatsapp.net';
const CONTEUDO = 'seu boleto de 1.234,56 vence amanha';

describe('#632 — as métricas exigidas existem com o nome e o rótulo da issue', () => {
  beforeEach(() => {
    _resetForTests();
    _resetLabelGuardForTests();
  });

  it('publica `maia_outbound_lease_lost_total` com `reason` do vocabulário fechado', async () => {
    expect(METRIC.OUTBOUND_LEASE_LOST).toBe('maia_outbound_lease_lost_total');
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, async () => {
      for (const reason of DELIVERY_LEASE_LOSS_REASONS) {
        counter(METRIC.OUTBOUND_LEASE_LOST, { reason });
      }
    });
    const out = await renderPrometheus();
    for (const reason of DELIVERY_LEASE_LOSS_REASONS) {
      expect(out).toContain(
        `maia_outbound_lease_lost_total{agent_id="a1",reason="${reason}",tenant_id="acme"} 1`,
      );
    }
  });

  it('publica `maia_outbound_delivery_unknown_total{channel}` — o rótulo sobrevive ao sanitizador', async () => {
    expect(METRIC.OUTBOUND_DELIVERY_UNKNOWN).toBe('maia_outbound_delivery_unknown_total');
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, async () => {
      counter(METRIC.OUTBOUND_DELIVERY_UNKNOWN, { channel: 'whatsapp' });
    });
    const out = await renderPrometheus();
    // A afirmação que importa: `channel` CHEGA à série. Remover `channel` de
    // `ALLOWED_LABEL_KEYS` deixa a métrica sem dimensão de canal — publicada
    // no nome e inútil no eixo que a issue pede — e este caso fica vermelho.
    expect(out).toContain(
      'maia_outbound_delivery_unknown_total{agent_id="a1",channel="whatsapp",tenant_id="acme"} 1',
    );
  });

  it('o vocabulário do rótulo `channel` é o dos canais de EGRESSO de #630', () => {
    expect(ALLOWED_LABEL_KEYS.has('channel')).toBe(true);
    expect([...ENUM_VALUES.channel]).toEqual([...OUTBOUND_PROVIDER_CHANNELS]);
  });
});

describe('#632 — nenhuma PII sobrevive como label das séries de entrega', () => {
  beforeEach(() => {
    _resetForTests();
    _resetLabelGuardForTests();
  });

  /**
   * O ataque direto: alguém acrescenta a chave "para facilitar o debug". As
   * chaves estão na deny list e o sanitizador as DERRUBA — o valor nunca chega
   * ao registro.
   */
  it('recipient/phone/jid/conteúdo como CHAVE são derrubados antes do registro', async () => {
    for (const chave of ['phone', 'telefone', 'jid', 'remote_jid', 'text', 'content', 'payload']) {
      const { labels, violations } = sanitizeLabels(METRIC.OUTBOUND_DELIVERY_UNKNOWN, {
        channel: 'whatsapp',
        [chave]: TELEFONE,
      });
      expect(Object.keys(labels), `chave ${chave} deveria ser derrubada`).not.toContain(chave);
      expect(violations.map((v) => v.key)).toContain(chave);
    }
  });

  /**
   * O ataque indireto, e o mais provável: a chave é PERMITIDA (`reason`,
   * `outcome`) e o VALOR é que carrega a PII — `reason: err.message` numa
   * mensagem de erro que cita o telefone.
   */
  it('PII no VALOR de um label permitido é substituída, nunca emitida', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'a1' }, async () => {
      counter(METRIC.OUTBOUND_LEASE_LOST, { reason: TELEFONE });
      counter(METRIC.OUTBOUND_DELIVERY_UNKNOWN, { channel: JID });
      counter(METRIC.OUTBOUND_DELIVERY_OUTCOME, {
        outcome: 'timeout_unknown',
        channel: 'whatsapp',
        kind: CONTEUDO,
      });
    });
    const out = await renderPrometheus();
    // O texto renderizado é literalmente o que sai no `/metrics`. Nenhum dos
    // três pode aparecer nele — nem inteiro, nem em pedaço reconhecível.
    expect(out).not.toContain(TELEFONE);
    expect(out).not.toContain(JID);
    expect(out).not.toContain('s.whatsapp.net');
    expect(out).not.toContain(CONTEUDO);
    expect(out).not.toContain('1.234,56');
    // As séries continuam existindo — sanitizar não é sumir com a métrica.
    expect(out).toContain('maia_outbound_lease_lost_total');
    expect(out).toContain('maia_outbound_delivery_unknown_total');
  });

  /**
   * A guarda de GOVERNANÇA: as chaves de PII continuam na deny list, e a deny
   * list vence a allowlist. Sem isto, acrescentar `phone` à allowlist num
   * momento de pressa passaria despercebido.
   */
  it('as chaves de destinatário permanecem PROIBIDAS por deny list', () => {
    for (const chave of ['phone', 'telefone', 'jid', 'remote_jid', 'pessoa_id', 'conversa_id']) {
      expect(FORBIDDEN_LABEL_KEYS.has(chave), chave).toBe(true);
      expect(ALLOWED_LABEL_KEYS.has(chave), chave).toBe(false);
    }
  });
});
