/**
 * Issue #510 — self-tests do SANITIZADOR, do `ArtifactCollector` e do
 * `eventually`.
 *
 * ─── Por que estes três num arquivo só ───────────────────────────────────────
 *
 * Eles formam UMA garantia: o vermelho de um cenário FI precisa ser útil (a
 * timeline e o último estado) sem ser perigoso (telefone, segredo, conteúdo de
 * usuário num log público de CI). Testá-los separados esconderia justamente a
 * composição — o artefato escrito em disco é onde as duas metades se encontram.
 *
 * ─── Sobre os valores usados aqui ────────────────────────────────────────────
 *
 * As fixtures são curtas e de baixa entropia de propósito: o guard de
 * `secret/synthetic-fixture` deste repositório varre o HISTÓRICO e reprova
 * fixture com entropia de Shannon > 3.5 adjacente a `KEY`/`SECRET`/`TOKEN`.
 * `aaaa1111` prova a redação tão bem quanto uma string aleatória de 40 chars, e
 * não deixa uma mina no histórico.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactCollector } from '../harness/artifacts.js';
import {
  REDACTED,
  chaveSensivel,
  jsonSanitizado,
  sanitizarTexto,
  sanitizarValor,
} from '../harness/sanitize.js';
import { EventuallyTimeoutError, estavelDurante, eventually } from '../harness/eventually.js';

const temporarios: string[] = [];
function dirTemporario(): string {
  const d = mkdtempSync(join(tmpdir(), 'fi-artefatos-'));
  temporarios.push(d);
  return d;
}
afterEach(() => {
  while (temporarios.length > 0) {
    const d = temporarios.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('#510 harness — o sanitizador remove telefone, segredo e conteúdo', () => {
  it('telefone e JID somem de texto livre', () => {
    const bruto =
      'entregando para +55 11 98765-4321 via 5511987654321@s.whatsapp.net (grupo 120363000000@g.us)';
    const limpo = sanitizarTexto(bruto);
    expect(limpo).not.toContain('98765');
    expect(limpo).not.toContain('5511987654321');
    expect(limpo).not.toContain('@s.whatsapp.net');
    expect(limpo).not.toContain('@g.us');
    expect(limpo).toContain(REDACTED);
    // O ESQUELETO da frase sobrevive — um artefato todo redigido é inútil.
    expect(limpo).toContain('entregando para');
    expect(limpo).toContain('via');
  });

  it('segredo some em suas três formas: atribuição, bearer e chave de provider', () => {
    expect(sanitizarTexto('ANTHROPIC_API_KEY=aaaa1111')).toBe(`ANTHROPIC_API_KEY=${REDACTED}`);
    expect(sanitizarTexto('{"session_token": "bbbb2222"}')).toContain(REDACTED);
    expect(sanitizarTexto('{"session_token": "bbbb2222"}')).not.toContain('bbbb2222');
    expect(sanitizarTexto('Authorization: Bearer cccc3333')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(sanitizarTexto('usando sk-ant-dddd4444eeee')).not.toContain('dddd4444');
  });

  it('connection string perde a credencial e mantém o destino', () => {
    const limpo = sanitizarTexto('postgres://maia_test:senha1234@localhost:5432/maia_fi_x');
    expect(limpo).not.toContain('senha1234');
    expect(limpo).not.toContain('maia_test:');
    // Host, porta e banco continuam legíveis: é o que o diagnóstico precisa.
    expect(limpo).toContain('localhost:5432/maia_fi_x');
  });

  it('conteúdo de usuário some por NOME DE CAMPO, não por formato', () => {
    // Uma mensagem em português não tem forma nenhuma — nenhum regex a
    // reconhece. A única defesa possível é negar o campo.
    const linha = {
      turn_id: 't-42',
      tenant_id: 'fi-a',
      attempt: 3,
      content: 'oi, pode transferir 500 reais para minha mae?',
      messageText: 'segunda mensagem do cliente',
      user_prompt: 'system prompt inteiro',
      body: { nested: 'ainda conteudo' },
      payload_hash: 'abc123',
    };
    const limpo = sanitizarValor(linha) as Record<string, unknown>;

    expect(limpo.content).toBe(REDACTED);
    expect(limpo.messageText).toBe(REDACTED);
    expect(limpo.user_prompt).toBe(REDACTED);
    expect(limpo.body).toBe(REDACTED);
    // O que o oracle lê sobrevive intacto.
    expect(limpo.turn_id).toBe('t-42');
    expect(limpo.tenant_id).toBe('fi-a');
    expect(limpo.attempt).toBe(3);
    expect(limpo.payload_hash).toBe('abc123');
    // E nada do texto original vaza pelo JSON serializado.
    const texto = JSON.stringify(limpo);
    expect(texto).not.toContain('transferir');
    expect(texto).not.toContain('cliente');
    expect(texto).not.toContain('system prompt');
  });

  it('a negação por chave é case-insensitive e reconhece composto', () => {
    expect(chaveSensivel('CONTENT')).toBe(true);
    expect(chaveSensivel('apiKey')).toBe(true);
    expect(chaveSensivel('api-key')).toBe(true);
    expect(chaveSensivel('messageContent')).toBe(true);
    expect(chaveSensivel('telefone_e164')).toBe(true);
    // E não é um "nega tudo": os campos do oracle passam.
    expect(chaveSensivel('turn_id')).toBe(false);
    expect(chaveSensivel('attempt_count')).toBe(false);
    expect(chaveSensivel('claim_token')).toBe(false);
    expect(chaveSensivel('outcome')).toBe(false);
  });

  it('sobrevive a ciclo, profundidade e Error sem perder a redação', () => {
    const ciclico: Record<string, unknown> = { turn_id: 't-1' };
    ciclico.self = ciclico;
    expect(() => jsonSanitizado(ciclico)).not.toThrow();
    expect(jsonSanitizado(ciclico)).toContain('[Circular]');

    const comErro = sanitizarValor(new Error('falhou com token=eeee5555')) as {
      message: string;
    };
    expect(comErro.message).not.toContain('eeee5555');
    expect(comErro.message).toContain(REDACTED);
  });

  it('é idempotente — sanitizar o já sanitizado não corrompe', () => {
    const uma = sanitizarTexto('telefone +5511987654321 e SECRET=ffff6666');
    expect(sanitizarTexto(uma)).toBe(uma);
  });
});

describe('#510 harness — ArtifactCollector', () => {
  it('grava timeline, saída de processo e snapshots — todos sanitizados', () => {
    const coletor = new ArtifactCollector('FI-XX-self-test', 'seed-abc', 'commit-fake');
    coletor.registrarProcesso('worker-a', 4242);
    coletor.saidaDeProcesso('worker-a', 'stdout', 'enviando para +5511987654321\n');
    coletor.saidaDeProcesso('worker-a', 'stderr', 'DB_PASSWORD=gggg7777\n');
    coletor.saidaDeProcessoEncerrado('worker-a', null, 'SIGKILL');
    coletor.snapshot('turno', { turn_id: 't-1', content: 'texto do cliente', attempt: 2 });
    coletor.evento('failpoint.reached', { failpoint: 'after_turn_claim_before_running' });

    const dir = dirTemporario();
    const caminho = coletor.escrever(dir);
    const disco = readFileSync(caminho, 'utf8');

    // O útil está lá.
    expect(disco).toContain('FI-XX-self-test');
    expect(disco).toContain('seed-abc');
    expect(disco).toContain('after_turn_claim_before_running');
    expect(disco).toContain('SIGKILL');
    expect(disco).toContain('"pid": 4242');
    expect(disco).toContain('t-1');

    // O perigoso não está — nem em stdout, nem em stderr, nem no snapshot.
    expect(disco).not.toContain('5511987654321');
    expect(disco).not.toContain('gggg7777');
    expect(disco).not.toContain('texto do cliente');
    expect(disco).toContain(REDACTED);
  });

  it('dois artefatos do mesmo cenário não se sobrescrevem', () => {
    const dir = dirTemporario();
    const a = new ArtifactCollector('FI-XX', 's1').escrever(dir);
    const b = new ArtifactCollector('FI-XX', 's2').escrever(dir);
    expect(a).not.toBe(b);
  });

  it('a timeline é monotônica e crescente', () => {
    const coletor = new ArtifactCollector('FI-XX', 's');
    coletor.evento('a');
    coletor.evento('b');
    coletor.evento('c');
    const ts = coletor.timeline().map((e) => e.tMs);
    expect(ts).toHaveLength(3);
    expect(ts[1]).toBeGreaterThanOrEqual(ts[0] as number);
    expect(ts[2]).toBeGreaterThanOrEqual(ts[1] as number);
  });
});

describe('#510 harness — eventually', () => {
  it('resolve assim que a condição vira verdadeira, sem esperar o prazo', async () => {
    let n = 0;
    const t0 = Date.now();
    const valor = await eventually(
      () => {
        n += 1;
        return n >= 3 ? n : undefined;
      },
      { label: 'contador chega a 3', timeoutMs: 5_000, intervalMs: 5 },
    );
    expect(valor).toBe(3);
    // O ponto de `eventually` em vez de `sleep(500)`: ele volta em ~10ms.
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('o vermelho IMPRIME o último estado observado', async () => {
    const estado = { turnos: 1, claims: 0, outbound: 0 };
    const erro = await eventually(() => (estado.claims === 1 ? estado : undefined), {
      label: 'exatamente um claim vence',
      timeoutMs: 80,
      intervalMs: 10,
      describeState: () => estado,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(EventuallyTimeoutError);
    const msg = (erro as Error).message;
    expect(msg).toContain('exatamente um claim vence');
    expect(msg).toContain('80ms');
    expect(msg).toContain('tentativa');
    // O ESTADO — que é o que distingue este vermelho de `expected 0 to be 1`.
    expect(msg).toContain('"claims":0');
    expect(msg).toContain('"turnos":1');
    const d = (erro as EventuallyTimeoutError).diagnostico;
    expect(d.tentativas).toBeGreaterThan(1);
    expect(d.abortado).toBe(false);
  });

  it('o estado impresso no vermelho também é SANITIZADO', async () => {
    // Um `describeState` que despeja uma linha de banco não pode virar a porta
    // dos fundos por onde o conteúdo escapa para o log do CI.
    const erro = await eventually(() => undefined, {
      label: 'nunca',
      timeoutMs: 40,
      intervalMs: 10,
      describeState: () => ({ telefone: '+5511987654321', content: 'texto do cliente' }),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const msg = (erro as Error).message;
    expect(msg).not.toContain('5511987654321');
    expect(msg).not.toContain('texto do cliente');
    expect(msg).toContain(REDACTED);
  });

  it('exceção da sonda vira `ultimoErro` no diagnóstico, e não silêncio', async () => {
    // Uma sonda que joga porque o banco caiu não é o mesmo que uma condição
    // falsa. Esperar em silêncio até o prazo esconderia a causa.
    const erro = await eventually(
      () => {
        throw new Error('ECONNREFUSED ao consultar agent_turns');
      },
      { label: 'consulta ao turno', timeoutMs: 60, intervalMs: 10 },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((erro as EventuallyTimeoutError).diagnostico.ultimoErro).toContain('ECONNREFUSED');
    expect((erro as Error).message).toContain('Último erro da sonda');
  });

  it('`estavelDurante` falha CEDO quando o valor muda dentro da janela', async () => {
    let v = 0;
    const t = setTimeout(() => {
      v = 1;
    }, 30);
    t.unref?.();
    await expect(
      estavelDurante(() => v, {
        label: 'worker fenced não grava',
        janelaMs: 400,
        intervalMs: 10,
        justificativa: 'invariante negativa: não existe evento de "não aconteceu"',
      }),
    ).rejects.toThrow(/observou MUDANÇA/);
  });

  it('`estavelDurante` devolve o valor quando nada muda (controle)', async () => {
    const v = await estavelDurante(() => 7, {
      label: 'nada muda',
      janelaMs: 60,
      intervalMs: 10,
      justificativa: 'controle do caso acima',
    });
    expect(v).toBe(7);
  });
});
