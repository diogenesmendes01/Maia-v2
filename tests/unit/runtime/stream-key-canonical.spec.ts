/**
 * Issue #505 — a derivação canônica da `stream_key` (`src/runtime/turns/stream-key.ts`).
 *
 * As três propriedades que este arquivo existe para prender, e o defeito que
 * cada uma pega:
 *
 *  1. **Encoding NÃO AMBÍGUO.** Se o material canônico voltar a ser uma
 *     concatenação com separador (`a:b:c`), pares de componentes distintos
 *     passam a produzir a MESMA chave — e duas conversas distintas passam a
 *     compartilhar ordem, lock e (na fase de enforcement) exclusão mútua. O
 *     caso `["a:b","c"] vs ["a","b:c"]` é o menor exemplo, e o teste varre uma
 *     família deles.
 *  2. **Fail-closed.** Não existe entrada incompleta que produza chave. Em
 *     particular, `tenant_id`/`agent_id` ausentes e o literal `'default'` são
 *     recusados — a invariante MUST nº 2/nº 8.
 *  3. **Versão.** A versão embutida no VALOR e a constante `STREAM_KEY_VERSION`
 *     descrevem o mesmo algoritmo, e o namespace entra no hash (duas versões
 *     nunca colidem).
 *
 * Tudo aqui é PURO: nenhum mock, nenhum banco, nenhuma flag. É o teste que
 * continua válido quando o resto do rollout mudar.
 */
import { describe, it, expect } from 'vitest';
import {
  STREAM_KEY_VERSION,
  canonicalStreamMaterial,
  deriveStreamKey,
  normalizeRemoteIdentity,
  streamKeyVersionOf,
  type StreamKeyInput,
} from '@/runtime/turns/stream-key.js';

const BASE: StreamKeyInput = Object.freeze({
  tenant_id: 'primary',
  agent_id: 'primary',
  channel_kind: 'whatsapp',
  channel_id: '11111111-1111-4111-8111-111111111111',
  remote_identity: '+5511999998888',
});

function key(over: Partial<StreamKeyInput> = {}): string {
  const derived = deriveStreamKey({ ...BASE, ...over });
  if (!derived.ok) throw new Error(`esperava chave, veio recusa: ${derived.reason}`);
  return derived.stream_key;
}

function reason(over: Partial<StreamKeyInput>): string {
  const derived = deriveStreamKey({ ...BASE, ...over });
  if (derived.ok) throw new Error(`esperava recusa, veio chave: ${derived.stream_key}`);
  return derived.reason;
}

describe('#505 — encoding canônico é injetivo (sem ambiguidade)', () => {
  // Cada par tem a MESMA concatenação sob `join(':')` e componentes DIFERENTES.
  // Sob o encoding comprimento-prefixado, os materiais têm de divergir.
  const colisoesSobSeparador: ReadonlyArray<readonly [string[], string[]]> = [
    [['a:b', 'c'], ['a', 'b:c']],
    [['t', 'a:g'], ['t:a', 'g']],
    [[':', 'x'], ['', ':x']],
    [['primary:primary', 'whatsapp'], ['primary', 'primary:whatsapp']],
    [['1', '2:3'], ['1:2', '3']],
  ];

  it.each(colisoesSobSeparador)(
    'materiais distintos para %j e %j (que colidem sob join(":"))',
    (esquerda, direita) => {
      // Sanidade da premissa: sob o encoding ingênuo, estes DOIS colidem.
      expect(esquerda.join(':')).toBe(direita.join(':'));
      expect(canonicalStreamMaterial(esquerda)).not.toBe(canonicalStreamMaterial(direita));
    },
  );

  it('o prefixo de comprimento é medido em BYTES UTF-8, não em code units', () => {
    // 'é' tem 1 code unit e 2 bytes. Medir em `.length` faria a fronteira do
    // encoding depender da codificação — a ambiguidade voltando por uma porta
    // lateral.
    expect(canonicalStreamMaterial(['é'])).toContain('2:é,');
    expect(canonicalStreamMaterial(['ab'])).toContain('2:ab,');
    expect(canonicalStreamMaterial(['é'])).not.toBe(canonicalStreamMaterial(['ab']));
  });

  it('componentes trocados de posição produzem chaves diferentes', () => {
    // tenant/agent invertidos são um par DIFERENTE, não o mesmo escopo.
    expect(key({ tenant_id: 'x', agent_id: 'y' })).not.toBe(
      key({ tenant_id: 'y', agent_id: 'x' }),
    );
  });

  it('a derivação é determinística', () => {
    expect(key()).toBe(key());
  });
});

describe('#505 — cada componente muda a chave', () => {
  it.each([
    ['tenant_id', { tenant_id: 'outro-tenant' }],
    ['agent_id', { agent_id: 'outro-agent' }],
    ['channel_id', { channel_id: '22222222-2222-4222-8222-222222222222' }],
    ['remote_identity', { remote_identity: '+5511777776666' }],
  ] as ReadonlyArray<readonly [string, Partial<StreamKeyInput>]>)(
    '%s participa do material canônico',
    (_nome, over) => {
      expect(key(over)).not.toBe(key());
    },
  );

  it('o MESMO remoto em tenants diferentes são streams DIFERENTES', () => {
    // §Falhas 7: "o mesmo remote_jid em tenants diferentes compartilha
    // lock/chave" é uma das falhas que a issue existe para impedir.
    expect(key({ tenant_id: 'tenant-a' })).not.toBe(key({ tenant_id: 'tenant-b' }));
  });

  it('o MESMO remoto em linhas diferentes do mesmo agente são streams DIFERENTES', () => {
    // Desde a migration 090 a conversa é escopada por canal: duas linhas, duas
    // conversas. Sem `channel_id` no material, as duas colapsariam numa stream.
    expect(key({ channel_id: 'linha-a' })).not.toBe(key({ channel_id: 'linha-b' }));
  });
});

describe('#505 — fail-closed: nenhuma entrada incompleta produz chave', () => {
  it.each([
    [{ tenant_id: null }, 'missing_tenant'],
    [{ tenant_id: '' }, 'missing_tenant'],
    [{ tenant_id: ' primary' }, 'missing_tenant'],
    [{ agent_id: undefined }, 'missing_agent'],
    [{ agent_id: '  ' }, 'missing_agent'],
    [{ channel_kind: null }, 'missing_channel_kind'],
    [{ channel_kind: 'carrier-pigeon' }, 'missing_channel_kind'],
    [{ channel_id: null }, 'missing_channel'],
    [{ channel_id: '' }, 'missing_channel'],
    [{ remote_identity: null }, 'missing_remote_identity'],
    [{ remote_identity: '   ' }, 'missing_remote_identity'],
    [{ remote_identity: 'não-é-telefone' }, 'unnormalizable_remote_identity'],
    [{ remote_identity: '+0' }, 'unnormalizable_remote_identity'],
  ] as ReadonlyArray<readonly [Partial<StreamKeyInput>, string]>)(
    'recusa %j com reason=%s',
    (over, esperado) => {
      expect(reason(over)).toBe(esperado);
    },
  );

  it("o literal 'default' é RECUSADO em tenant e em agent (invariante MUST nº 8)", () => {
    expect(reason({ tenant_id: 'default' })).toBe('reserved_scope_literal');
    expect(reason({ agent_id: 'default' })).toBe('reserved_scope_literal');
  });

  it("o sentinela 'system' também é recusado — um ingresso tem dono por definição", () => {
    expect(reason({ tenant_id: 'system' })).toBe('reserved_scope_literal');
    expect(reason({ agent_id: 'system' })).toBe('reserved_scope_literal');
  });

  it('a recusa NUNCA carrega chave — o retorno é um union discriminado', () => {
    const derived = deriveStreamKey({ ...BASE, tenant_id: 'default' });
    expect(derived.ok).toBe(false);
    expect(derived).not.toHaveProperty('stream_key');
  });
});

describe('#505 — normalização da identidade remota', () => {
  it('as quatro formas do MESMO interlocutor convergem para uma stream', () => {
    // O ingresso vê o telefone ora com `+`, ora sem, ora como JID, ora com
    // sufixo de dispositivo. Se não convergissem, o mesmo contato teria N
    // streams e a ordem entre elas simplesmente não existiria.
    const formas = [
      '+5511999998888',
      '5511999998888',
      '5511999998888@s.whatsapp.net',
      '5511999998888:12@s.whatsapp.net',
    ];
    const chaves = new Set(formas.map((remote_identity) => key({ remote_identity })));
    expect(chaves.size).toBe(1);
  });

  it('normaliza para a forma canônica +<dígitos>', () => {
    expect(normalizeRemoteIdentity('whatsapp', '5511999998888@s.whatsapp.net')).toBe(
      '+5511999998888',
    );
  });

  it('recusa o que não é telefone em canal de telefone', () => {
    expect(normalizeRemoteIdentity('whatsapp', 'abc@s.whatsapp.net')).toBeNull();
    expect(normalizeRemoteIdentity('whatsapp', '0511999998888')).toBeNull();
    expect(normalizeRemoteIdentity('whatsapp', '123')).toBeNull();
  });

  it('canal não-telefônico usa a forma genérica (minúscula, sem controle)', () => {
    expect(normalizeRemoteIdentity('email', 'Alguem@Exemplo.COM')).toBe('alguem@exemplo.com');
    expect(normalizeRemoteIdentity('email', 'a b')).toBeNull();
  });
});

describe('#505 — versão do algoritmo', () => {
  it('a versão embutida no VALOR concorda com STREAM_KEY_VERSION', () => {
    expect(streamKeyVersionOf(key())).toBe(STREAM_KEY_VERSION);
  });

  it('a derivação devolve a mesma versão que persistimos na coluna', () => {
    const derived = deriveStreamKey(BASE);
    expect(derived.ok).toBe(true);
    if (derived.ok) expect(derived.stream_key_version).toBe(STREAM_KEY_VERSION);
  });

  it('o formato do valor é `v<n>:<sha256 hex>`', () => {
    expect(key()).toMatch(/^v[1-9][0-9]*:[0-9a-f]{64}$/);
  });

  it('o namespace versionado entra no hash — o material não é só os componentes', () => {
    // Se o namespace saísse do material, duas versões do algoritmo com os
    // mesmos componentes produziriam o mesmo dígito e a migração de versão
    // deixaria de ser detectável.
    const componentes = ['primary', 'primary', 'whatsapp', BASE.channel_id!, '+5511999998888'];
    const material = canonicalStreamMaterial(componentes);
    expect(material.startsWith(`${`maia.stream.v${STREAM_KEY_VERSION}`.length}:maia.stream.v`)).toBe(
      true,
    );
  });
});
