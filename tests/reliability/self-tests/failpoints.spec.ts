/**
 * Issue #510 — self-tests do CATÁLOGO DE FAILPOINTS e do gate determinístico.
 *
 * ─── Por que um harness precisa de testes contra si mesmo ────────────────────
 *
 * `tests/integration/turn-claim-core-barrier-real-db.spec.ts:1-42` documenta a
 * armadilha do espelho NESTE subsistema: neutralizar o consumidor de produção
 * com `if (false && !start.started)` deixava 75 testes verdes, porque as suítes
 * provavam que o cadeado funcionava sem provar que ele estava na porta.
 *
 * Um harness tem a mesma exposição, elevada: ele é ao mesmo tempo o
 * instrumento e o objeto medido. Um `eventually` que sempre passa, um
 * `hardKill` que não mata e um sanitizador que não redige produzem uma matriz
 * FI-01..FI-25 inteiramente verde sem provar nada. Estes casos existem para que
 * a próxima fatia possa confiar no instrumento.
 *
 * Cada caso abaixo foi verificado por reintrodução cirúrgica do defeito no
 * ponto real (o módulo do harness, que é o "código de produção" desta fatia),
 * observado VERMELHO, e revertido.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DuplicateGateError,
  FAILPOINTS,
  FAILPOINT_ENABLE_ENV,
  FAILPOINT_TOKEN_ENV,
  FailpointGateRegistry,
  FailpointsForbiddenError,
  HandshakeTimeoutError,
  UnknownFailpointError,
  assertFailpointsAllowed,
  failpointNameSchema,
  failpointsHabilitados,
  parseFailpointName,
} from '../harness/failpoints.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');

function varrer(dir: string, saida: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const cheio = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      // `node_modules` do admin-ui é dependência de terceiro, não código nosso.
      if (entrada.name === 'node_modules' || entrada.name === '.next') continue;
      varrer(cheio, saida);
    } else if (entrada.isFile() && (cheio.endsWith('.ts') || cheio.endsWith('.tsx'))) {
      saida.push(cheio);
    }
  }
  return saida;
}

describe('#510 harness — catálogo de failpoints', () => {
  it('o catálogo tem os 16 nomes que a issue exige, sem duplicata', () => {
    expect(FAILPOINTS).toHaveLength(16);
    expect(new Set(FAILPOINTS).size).toBe(16);
    // Amostra nominal: os quatro que a matriz FI mais usa.
    expect(FAILPOINTS).toContain('after_inbound_persist_before_enqueue');
    expect(FAILPOINTS).toContain('after_turn_claim_before_running');
    expect(FAILPOINTS).toContain('after_outbox_commit_before_delivery_enqueue');
    expect(FAILPOINTS).toContain('after_provider_accept_before_delivery_persist');
  });

  it('failpoint inexistente falha CEDO, e a mensagem lista o catálogo', () => {
    // Este é o self-test nominal "failpoint inexistente falha cedo". O ponto do
    // "cedo" é que a reprovação acontece no `arm`, quando o cenário é escrito —
    // não trinta segundos depois, num `eventually` que nunca observa `reached`.
    expect(() => parseFailpointName('after_turn_claim_before_runing')).toThrow(UnknownFailpointError);
    try {
      parseFailpointName('nao_existe');
      throw new Error('deveria ter jogado');
    } catch (erro) {
      expect(erro).toBeInstanceOf(UnknownFailpointError);
      const msg = (erro as Error).message;
      expect(msg).toContain('nao_existe');
      expect(msg).toContain('after_running_before_llm');
    }
    expect(failpointNameSchema.safeParse('during_llm_request').success).toBe(true);
  });

  it('`arm` recusa nome inexistente pelo MESMO caminho de parse', () => {
    const registry = new FailpointGateRegistry();
    expect(() => registry.arm('failpoint_que_nao_existe')).toThrow(UnknownFailpointError);
  });

  it('gate duplicado no mesmo failpoint é REJEITADO', () => {
    const registry = new FailpointGateRegistry();
    registry.arm('after_running_before_llm', 'pause');
    expect(() => registry.arm('after_running_before_llm', 'kill')).toThrow(DuplicateGateError);
    // Duplicata IDÊNTICA também é recusada: dois `arm` iguais quase sempre são
    // dois cenários dividindo um registry por engano.
    expect(() => registry.arm('after_running_before_llm', 'pause')).toThrow(DuplicateGateError);
    // E a mensagem diz qual ação já estava lá — senão o vermelho não ajuda.
    try {
      registry.arm('after_running_before_llm', 'error');
    } catch (erro) {
      expect((erro as Error).message).toContain('"pause"');
      expect((erro as Error).message).toContain('"error"');
    }
    // Desarmar libera; e desarmar de novo é `false`, não erro (idempotência).
    expect(registry.disarm('after_running_before_llm')).toBe(true);
    expect(registry.disarm('after_running_before_llm')).toBe(false);
    expect(() => registry.arm('after_running_before_llm', 'kill')).not.toThrow();
  });

  it('timeout de handshake gera DIAGNÓSTICO — não um "timed out" mudo', async () => {
    const registry = new FailpointGateRegistry();
    registry.arm('after_turn_claim_before_running', 'kill');
    // Outro failpoint FOI alcançado: o diagnóstico precisa mostrar isso, porque
    // "chegou no ponto errado" e "não chegou em ponto nenhum" pedem
    // investigações diferentes.
    registry.reached('after_running_before_llm', { turn_id: 't-1' });

    const erro = await registry
      .waitForReached('after_turn_claim_before_running', { timeoutMs: 60 })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(erro).toBeInstanceOf(HandshakeTimeoutError);
    const d = (erro as HandshakeTimeoutError).diagnostico;
    expect(d.failpoint).toBe('after_turn_claim_before_running');
    expect(d.timeoutMs).toBe(60);
    expect(d.armados).toEqual([
      { failpoint: 'after_turn_claim_before_running', action: 'kill', remaining: 1 },
    ]);
    expect(d.alcancados.map((a) => a.failpoint)).toEqual(['after_running_before_llm']);
    const msg = (erro as Error).message;
    expect(msg).toContain('after_turn_claim_before_running');
    expect(msg).toContain('after_running_before_llm');
    expect(msg).toContain('60ms');
  });

  it('`reached` consome o gate uma vez e resolve quem esperava', async () => {
    const registry = new FailpointGateRegistry();
    registry.arm('during_lease_heartbeat', 'disconnect');
    const espera = registry.waitForReached('during_lease_heartbeat', { timeoutMs: 1_000 });

    const primeiro = registry.reached('during_lease_heartbeat', { worker_id: 'w-1' });
    expect(primeiro.action).toBe('disconnect');
    const evento = await espera;
    expect(evento.context).toEqual({ worker_id: 'w-1' });

    // Gate de uso único: a segunda passagem não repete a ação. Sem isso, um
    // `kill` armado para o primeiro turno derrubaria o quinto.
    expect(registry.reached('during_lease_heartbeat').action).toBeUndefined();
  });

  it('`waitForReached` resolve na hora quando o failpoint JÁ foi alcançado', async () => {
    // Sem isto haveria uma corrida real entre armar e esperar: um filho rápido
    // anuncia `reached` antes de o cenário chegar ao `await`.
    const registry = new FailpointGateRegistry();
    registry.reached('after_llm_before_tool', { turn_id: 't-9' });
    const evento = await registry.waitForReached('after_llm_before_tool', { timeoutMs: 30 });
    expect(evento.context).toEqual({ turn_id: 't-9' });
  });
});

describe('#510 harness — failpoints são impossíveis de habilitar em produção', () => {
  const tokenValido = 'tk-aaaa-bbbb';

  it('perfil de produção recusa MESMO com a flag ligada e token válido', () => {
    for (const producao of [{ MAIA_ENV: 'production' }, { NODE_ENV: 'production' }]) {
      const env = {
        ...producao,
        [FAILPOINT_ENABLE_ENV]: '1',
        [FAILPOINT_TOKEN_ENV]: tokenValido,
      };
      expect(() => assertFailpointsAllowed(env)).toThrow(FailpointsForbiddenError);
      expect(() => assertFailpointsAllowed(env)).toThrow(/perfil de produção/);
      expect(failpointsHabilitados(env)).toBe(false);
    }
  });

  it('produção é avaliada ANTES da flag e do token — a mensagem nunca desvia a culpa', () => {
    // Ordem importa: se a checagem de token viesse primeiro, alguém leria
    // "faltou o token" e tentaria fornecê-lo num ambiente de produção.
    const env = { MAIA_ENV: 'production' };
    expect(() => assertFailpointsAllowed(env)).toThrow(/perfil de produção/);
    expect(() => assertFailpointsAllowed(env)).not.toThrow(/não está em "1"/);
  });

  it('default é DESABILITADO: ambiente vazio recusa', () => {
    expect(() => assertFailpointsAllowed({})).toThrow(/desabilitados por default/);
    expect(failpointsHabilitados({})).toBe(false);
  });

  it('sem token, ou com token de outra rodada, recusa', () => {
    expect(() => assertFailpointsAllowed({ [FAILPOINT_ENABLE_ENV]: '1' })).toThrow(/token/i);
    expect(() =>
      assertFailpointsAllowed({ [FAILPOINT_ENABLE_ENV]: '1', [FAILPOINT_TOKEN_ENV]: 'curto' }),
    ).toThrow(/curto demais/);
    expect(() =>
      assertFailpointsAllowed(
        { [FAILPOINT_ENABLE_ENV]: '1', [FAILPOINT_TOKEN_ENV]: tokenValido },
        'tk-outro-token',
      ),
    ).toThrow(/outra/);
  });

  it('ambiente de teste completo é aceito — o CONTROLE da recusa', () => {
    // Sem este caso, "recusou" passaria também num guard que recusa sempre.
    expect(() =>
      assertFailpointsAllowed(
        { NODE_ENV: 'test', [FAILPOINT_ENABLE_ENV]: '1', [FAILPOINT_TOKEN_ENV]: tokenValido },
        tokenValido,
      ),
    ).not.toThrow();
  });
});

describe('#510 harness — teste ARQUITETURAL: nenhum input de usuário aciona failpoint', () => {
  const arquivosDeSrc = varrer(join(RAIZ, 'src'));

  it('a varredura encontrou código de verdade (controle)', () => {
    // Sem este controle, os dois casos abaixo passariam com uma lista vazia —
    // que é como uma varredura quebrada finge estar limpa.
    expect(arquivosDeSrc.length).toBeGreaterThan(300);
  });

  it('nenhum arquivo de src/ importa o harness de confiabilidade', () => {
    const ofensores = arquivosDeSrc.filter((f) =>
      /^\s*(?:import|export)\s[^\n]*['"][^'"]*tests\/reliability[^'"]*['"]/m.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(ofensores, `arquivos de src/ importando o harness: ${ofensores.join(', ')}`).toEqual([]);
  });

  it('nenhum nome do catálogo aparece em src/ — não há gatilho no caminho do usuário', () => {
    // Esta é a garantia central. Uma mensagem de WhatsApp, um payload de job,
    // um header HTTP: nenhum deles pode alcançar um failpoint, porque o
    // IDENTIFICADOR do failpoint não existe no código que os processa.
    const ofensores: string[] = [];
    for (const arquivo of arquivosDeSrc) {
      const conteudo = readFileSync(arquivo, 'utf8');
      for (const nome of FAILPOINTS) {
        if (conteudo.includes(nome)) ofensores.push(`${arquivo} → ${nome}`);
      }
      if (conteudo.includes('TEST_RELIABILITY_')) ofensores.push(`${arquivo} → TEST_RELIABILITY_*`);
    }
    expect(ofensores, `menções de failpoint em src/: ${ofensores.join(' | ')}`).toEqual([]);
  });

  it('o tsconfig do build continua excluindo tests/ — o catálogo não entra em dist/', () => {
    // A tranca mais forte não é uma flag desligada: é código AUSENTE do
    // artefato. Ela só vale enquanto o `exclude` valer, então ele é afirmado.
    const tsconfig = JSON.parse(readFileSync(join(RAIZ, 'tsconfig.json'), 'utf8')) as {
      include?: string[];
      exclude?: string[];
    };
    expect(tsconfig.exclude).toContain('tests');
    expect(tsconfig.include).toEqual(['src/**/*']);
    // E o próprio catálogo está mesmo dentro de tests/.
    expect(statSync(join(RAIZ, 'tests', 'reliability', 'harness', 'failpoints.ts')).isFile()).toBe(
      true,
    );
  });
});
