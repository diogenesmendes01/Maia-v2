/**
 * Issue #510 — self-tests do `FakeChannelProvider`, EM PROCESSO SEPARADO.
 *
 * ─── Por que estes casos são a espinha da fase outbound ──────────────────────
 *
 * A garantia de #506 é "no máximo um efeito lógico no provider". Ela só
 * significa alguma coisa se o provider souber diferenciar:
 *
 *   physical_call_count  quantas vezes a rede chegou lá
 *   logical_effect_count quantas mensagens o destinatário veria
 *
 * Um retry depois de um ACK perdido produz physical=2 / logical=1 — e é ISSO
 * que prova a garantia. Um ledger que contasse só "sends" não conseguiria
 * distinguir "retry seguro" de "mensagem duplicada para o cliente", e a matriz
 * FI-15..FI-20 inteira ficaria verde sem provar nada.
 *
 * ─── E o processo separado não é detalhe ─────────────────────────────────────
 *
 * O ledger é a única testemunha do efeito externo. Dentro do worker, todo
 * cenário que dá `SIGKILL` mataria a testemunha junto. O caso final deste
 * arquivo prova isso operacionalmente: o ledger sobrevive ao kill de outro
 * filho do mesmo supervisor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeChannelProvider, hashDePayload } from '../fakes/fake-channel-provider.js';
import { ProcessSupervisor } from '../harness/process-supervisor.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const FILHO_VIVO = resolve(join(AQUI, '..', 'fixtures', 'filho-vivo.mjs'));

let supervisor: ProcessSupervisor;
let provider: FakeChannelProvider;

beforeAll(async () => {
  supervisor = new ProcessSupervisor();
  provider = await FakeChannelProvider.iniciar(supervisor);
}, 30_000);

afterAll(async () => {
  await supervisor.dispose(1_000);
});

beforeEach(async () => {
  await provider.reset();
});

const HASH_A = hashDePayload({ texto: 'primeira versao' });
const HASH_B = hashDePayload({ texto: 'segunda versao' });

describe('#510 harness — fake provider vive em processo separado', () => {
  it('subiu como filho do supervisor, com PID próprio e porta efêmera', () => {
    expect(provider.filho.pid).toBeGreaterThan(0);
    expect(provider.filho.pid).not.toBe(process.pid);
    expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(provider.filho.vivo).toBe(true);
  });
});

describe('#510 harness — fake provider DEDUPLICA a mesma chave', () => {
  it('duas chamadas com a mesma chave e o mesmo payload = 2 físicas, 1 lógica', async () => {
    const chave = 'fi-dedupe-1';

    const primeira = await provider.enviar({
      idempotency_key: chave,
      payload_hash: HASH_A,
      tenant_id: 'fi-a',
      agent_id: 'fi-agent-a',
    });
    expect(primeira.status).toBe(200);
    expect(primeira.corpo.outcome).toBe('accepted');
    expect(primeira.corpo.deduplicated).toBe(false);

    const segunda = await provider.enviar({
      idempotency_key: chave,
      payload_hash: HASH_A,
      tenant_id: 'fi-a',
      agent_id: 'fi-agent-a',
    });
    expect(segunda.status).toBe(200);
    expect(segunda.corpo.deduplicated).toBe(true);
    // O ID de mensagem é DETERMINÍSTICO: o retry recebe o mesmo, e é assim que
    // o SUT reconcilia sem criar uma segunda linha de histórico.
    expect(segunda.corpo.provider_message_id).toBe(primeira.corpo.provider_message_id);

    const entrada = await provider.entrada(chave);
    expect(entrada?.physical_call_count).toBe(2);
    // A afirmação central da idempotência outbound.
    expect(entrada?.logical_effect_count).toBe(1);
    expect(entrada?.outcome).toBe('accepted');

    const ledger = await provider.ledger();
    expect(ledger.physical_call_total).toBe(2);
    expect(ledger.logical_effect_total).toBe(1);
  });

  it('CONTROLE: chaves DIFERENTES produzem dois efeitos lógicos', async () => {
    // Sem este caso, "logical_effect_count === 1" passaria também num ledger
    // que nunca incrementa nada.
    await provider.enviar({ idempotency_key: 'fi-k1', payload_hash: HASH_A });
    await provider.enviar({ idempotency_key: 'fi-k2', payload_hash: HASH_B });
    const ledger = await provider.ledger();
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.logical_effect_total).toBe(2);
    expect(ledger.physical_call_total).toBe(2);
    // E os IDs determinísticos são distintos por chave.
    expect(ledger.entries[0]?.provider_message_id).not.toBe(ledger.entries[1]?.provider_message_id);
  });
});

describe('#510 harness — fake provider REJEITA chave igual com payload diferente', () => {
  it('responde 409, marca conflito e NÃO cria um segundo efeito lógico', async () => {
    const chave = 'fi-colisao-1';
    const ok = await provider.enviar({ idempotency_key: chave, payload_hash: HASH_A });
    expect(ok.corpo.outcome).toBe('accepted');

    const conflito = await provider.enviar({ idempotency_key: chave, payload_hash: HASH_B });

    // Fail-closed: um provider real não sabe qual dos dois payloads é o certo.
    // Aceitar o segundo entregaria conteúdo errado sob uma chave que o emissor
    // considera já entregue.
    expect(conflito.status).toBe(409);
    expect(conflito.corpo.outcome).toBe('conflict');
    expect(conflito.corpo.reason).toBe('idempotency_key_reuse_with_different_payload');
    expect(conflito.corpo.expected_payload_hash).toBe(HASH_A);
    expect(conflito.corpo.received_payload_hash).toBe(HASH_B);

    const entrada = await provider.entrada(chave);
    expect(entrada?.physical_call_count).toBe(2);
    expect(entrada?.logical_effect_count).toBe(1);
    expect(entrada?.outcome).toBe('conflict');
    expect(entrada?.conflicts).toBe(1);
    // O payload REGISTRADO continua sendo o primeiro — imutável.
    expect(entrada?.payload_hash).toBe(HASH_A);
  });

  it('o ledger guarda HASH, nunca conteúdo — não há o que vazar no artefato', async () => {
    await provider.enviar({
      idempotency_key: 'fi-hash',
      payload_hash: hashDePayload({ texto: 'transferir 500 reais para minha mae' }),
      tenant_id: 'fi-a',
    });
    const bruto = JSON.stringify(await provider.ledger());
    expect(bruto).not.toContain('transferir');
    expect(bruto).not.toContain('mae');
  });
});

describe('#510 harness — fake provider: roteiro de outcomes', () => {
  it('`reject` não registra efeito e deixa a chave livre para nova tentativa', async () => {
    await provider.roteirizar([{ kind: 'reject', status: 422, reason: 'numero_invalido' }]);
    const r = await provider.enviar({ idempotency_key: 'fi-rej', payload_hash: HASH_A });
    expect(r.status).toBe(422);
    expect(r.corpo.outcome).toBe('rejected');
    expect(await provider.entrada('fi-rej')).toBeUndefined();

    // Roteiro esgotado → volta ao `accept`, e a MESMA chave agora acontece.
    const r2 = await provider.enviar({ idempotency_key: 'fi-rej', payload_hash: HASH_A });
    expect(r2.corpo.outcome).toBe('accepted');
    expect((await provider.entrada('fi-rej'))?.logical_effect_count).toBe(1);
  });

  it('`accept_then_drop` registra o efeito e derruba a conexão — o `delivery_unknown`', async () => {
    // FI-18: o efeito ACONTECEU e o emissor nunca vê a resposta. Um SUT que
    // concluísse "falhou" e reenviasse cegamente duplicaria a mensagem.
    await provider.roteirizar([{ kind: 'accept_then_drop' }]);
    await expect(
      provider.enviar({ idempotency_key: 'fi-drop', payload_hash: HASH_A }),
    ).rejects.toThrow();

    const entrada = await provider.entrada('fi-drop');
    expect(entrada?.logical_effect_count).toBe(1);
    expect(entrada?.outcome).toBe('unknown');

    // E o retry "cego" do SUT seria absorvido pela chave: physical 2, lógico 1.
    const retry = await provider.enviar({ idempotency_key: 'fi-drop', payload_hash: HASH_A });
    expect(retry.corpo.deduplicated).toBe(true);
    expect((await provider.entrada('fi-drop'))?.logical_effect_count).toBe(1);
  });

  it('recusa pedido sem chave de idempotência ou sem hash', async () => {
    expect((await provider.enviar({ idempotency_key: '', payload_hash: HASH_A })).status).toBe(400);
    expect((await provider.enviar({ idempotency_key: 'fi-x', payload_hash: '' })).status).toBe(400);
  });
});

describe('#510 harness — o ledger SOBREVIVE ao kill do SUT', () => {
  it('matar outro filho do mesmo supervisor não apaga o ledger', async () => {
    // É a razão de o provider viver fora do worker. Aqui o "SUT" é um filho
    // qualquer; o que se prova é que o `SIGKILL` do harness não alcança a
    // testemunha.
    await provider.enviar({ idempotency_key: 'fi-sobrevive', payload_hash: HASH_A });
    expect((await provider.entrada('fi-sobrevive'))?.logical_effect_count).toBe(1);

    const sut = supervisor.spawn({ label: 'sut-descartavel', script: FILHO_VIVO });
    await sut.esperarPronto(10_000);
    supervisor.hardKill(sut);
    expect((await sut.esperarSaida(5_000)).signal).toBe('SIGKILL');

    expect(provider.filho.vivo).toBe(true);
    const entrada = await provider.entrada('fi-sobrevive');
    expect(entrada?.logical_effect_count).toBe(1);
    expect(entrada?.physical_call_count).toBe(1);
  });
});
