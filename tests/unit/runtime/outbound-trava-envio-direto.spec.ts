/**
 * Issue #634 (fatia E da épica #506) — A TRAVA: nenhum caminho de produção fala
 * com o canal fora do outbox, salvo exceção INVENTARIADA.
 *
 * A issue-mãe é literal, e o critério de pronto repete: "teste arquitetural
 * verde, com lista de exceções auditável". Este arquivo é esse teste, e ele tem
 * DUAS metades que provam coisas diferentes:
 *
 *  1. ESTÁTICA — varre `src/` e exige que todo módulo que chame uma primitiva
 *     de mensagem de `LineOutput` conste de `OUTBOUND_SEND_PATHS`. Pega o caso
 *     comum: código novo que chama `line.sendText` e ninguém percebe.
 *  2. RUNTIME — `assertEgressAuthorized` recusa a chamada fora de um escopo de
 *     egresso declarado. Pega o que a varredura estática NÃO pega: envio por
 *     referência indireta, envio a partir de um módulo inventariado mas fora do
 *     trecho descrito, envio a partir de código gerado.
 *
 * POR QUE A VARREDURA REMOVE COMENTÁRIOS ANTES DE CASAR. Os módulos desta
 * épica documentam a fronteira citando as assinaturas — `LineOutput.sendPoll`,
 * `sendText(jid, text, { messageId })` — e um casamento textual ingênuo
 * acusaria `contract.ts` e `delivery-contract.ts`, que não enviam nada. A
 * alternativa (allowlist de arquivos "só comentário") seria uma lista que
 * cresce com entradas erradas. Remover comentário é a aproximação
 * CONSERVADORA no sentido certo: sobra o código executável.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_DECLARED_EXCEPTIONS,
  OUTBOUND_EXCEPTION_BLOCKERS,
  OUTBOUND_SEND_PATHS,
  RATIFIED_EXCEPTION_IDS,
  assertRatifiedInventory,
  declaredExceptions,
  isDeclaredEgressException,
  type OutboundSendPath,
} from '@/runtime/outbound/send-paths.js';
import {
  assertEgressAuthorized,
  currentEgressAuthorization,
  DirectSendViolationError,
  EGRESS_PRIMITIVES,
  withDeclaredEgressException,
  withDeclaredEgressExceptionSync,
  withOutboxEgress,
} from '@/runtime/outbound/egress-guard.js';
import { METRIC } from '@/observability/taxonomy.js';
import { renderPrometheus } from '@/lib/metrics.js';
import { moduloDeProducao } from '../../helpers/modulo-de-producao.js';

/**
 * A fronteira única de saída, carregada UMA vez por arquivo (ela arrasta o
 * Baileys, ~6s de import — ver `tests/helpers/modulo-de-producao.ts`).
 *
 * Esta spec precisa do módulo REAL, e não de um double, porque a propriedade
 * sob teste é justamente **que a trava está ligada nele**: um teste que só
 * chamasse `assertEgressAuthorized` continuaria verde com o wrapper `guarded`
 * REMOVIDO de `buildOutput`, e o envio direto voltaria a funcionar em produção
 * sem que nada ficasse vermelho.
 */
const lineOutput = moduloDeProducao(() => import('../../../src/gateway/line-output.js'));

const RAIZ = join(process.cwd(), 'src');

/** `.sendText(`, `.sendVoice(`, … — com o PONTO, que é o que distingue uma
 * CHAMADA de uma declaração de método na interface. */
const CHAMADA = /\.send(Text|Document|Voice|Poll|Reaction)\s*\(/g;

function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function arquivosTs(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) {
      if (nome === 'node_modules' || nome === '.next') continue;
      arquivosTs(p, acc);
      continue;
    }
    if (p.endsWith('.ts') || p.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

/** Módulo (relativo à raiz do repo) → primitivas que ele REALMENTE chama. */
function varredura(): Map<string, Set<string>> {
  const achados = new Map<string, Set<string>>();
  for (const abs of arquivosTs(RAIZ)) {
    const rel = abs.slice(process.cwd().length + 1);
    const corpo = semComentarios(readFileSync(abs, 'utf8'));
    const encontradas = new Set<string>();
    for (const m of corpo.matchAll(CHAMADA)) encontradas.add(`send${m[1]}`);
    if (encontradas.size > 0) achados.set(rel, encontradas);
  }
  return achados;
}

describe('#634 — trava arquitetural do envio direto', () => {
  it('todo módulo de src/ que chama uma primitiva de mensagem está no inventário', () => {
    const achados = varredura();
    const inventariados = new Set(OUTBOUND_SEND_PATHS.map((p) => p.module));
    const foraDoInventario = [...achados.keys()].filter((m) => !inventariados.has(m));
    expect(foraDoInventario).toEqual([]);
  });

  it('o inventário DESCREVE as primitivas que cada módulo realmente chama', () => {
    // Propriedade separada da anterior de propósito: um módulo pode estar
    // inventariado como "só manda texto" e ganhar um `sendVoice` depois. A
    // primeira asserção continuaria verde; esta não.
    const achados = varredura();
    const divergencias: string[] = [];
    for (const path of OUTBOUND_SEND_PATHS) {
      const reais = achados.get(path.module);
      if (!reais) continue;
      const declaradas = new Set(path.primitives);
      for (const p of reais) {
        if (!declaradas.has(p)) divergencias.push(`${path.module}: ${p} não declarado`);
      }
    }
    expect(divergencias).toEqual([]);
  });

  it('toda exceção declarada tem motivo E contenção escritos', () => {
    const excecoes = declaredExceptions();
    // A issue pede o inventário "idealmente vazio". Ele não está — e o teste
    // não finge que está. O que ele proíbe é uma exceção SEM texto.
    expect(excecoes.length).toBeGreaterThan(0);
    for (const e of excecoes) {
      expect(e.reason ?? '', `${e.id} sem reason`).not.toHaveLength(0);
      expect(e.containment ?? '', `${e.id} sem containment`).not.toHaveLength(0);
      expect(e.categories.length, `${e.id} sem categoria`).toBeGreaterThan(0);
    }
  });

  it('ids do inventário são únicos', () => {
    const ids = OUTBOUND_SEND_PATHS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('um envio FORA de qualquer escopo de egresso é recusado, e conta na métrica', async () => {
    expect(() => assertEgressAuthorized('sendText')).toThrow(DirectSendViolationError);
    // Invariante ABSOLUTA, não delta: a série `maia_outbound_direct_send_violation_total`
    // TEM de existir, com o rótulo da primitiva, e com valor > 0. Uma asserção
    // antes×depois ficaria verde na segunda tentativa do vitest (`retry: 1`),
    // que herda o contador que a primeira já incrementou.
    const total = await contarViolacoes('sendText');
    expect(total).toBeGreaterThan(0);
  });

  it('as CINCO primitivas de mensagem são recusadas fora de escopo', () => {
    for (const p of EGRESS_PRIMITIVES) {
      expect(() => assertEgressAuthorized(p), p).toThrow(DirectSendViolationError);
    }
  });

  it('dentro do escopo do outbox o envio é autorizado', async () => {
    await withOutboxEgress('outbound-1', async () => {
      expect(assertEgressAuthorized('sendVoice')).toEqual({
        via: 'outbox',
        outbound_id: 'outbound-1',
      });
    });
    // E o escopo NÃO vaza para fora do `run`.
    expect(currentEgressAuthorization()).toBeUndefined();
  });

  it('dentro de uma exceção INVENTARIADA o envio é autorizado', async () => {
    await withDeclaredEgressException('workers.briefings', async () => {
      expect(assertEgressAuthorized('sendText')).toEqual({
        via: 'exception',
        path_id: 'workers.briefings',
      });
    });
  });

  it('um id de exceção DESCONHECIDO é recusado — não dá para abrir exceção sem inventariar', () => {
    // O throw é SÍNCRONO de propósito: é erro de programação, não desfecho de
    // execução. Um `reject` faria a recusa depender de alguém dar `await` — e
    // um call site que esquecesse o `await` abriria a exceção assim mesmo.
    expect(() =>
      withDeclaredEgressException('workers.inventado', async () => undefined),
    ).toThrow(/not declared in the outbound send-path inventory/);
    expect(() =>
      withDeclaredEgressExceptionSync('workers.inventado', () => undefined),
    ).toThrow(/not declared in the outbound send-path inventory/);
  });

  it('a fronteira única RECUSA o envio quando ninguém abriu escopo — a trava está LIGADA', async () => {
    const line = lineOutput()._buildOutputForTests({
      tenant_id: 'primary',
      agent_id: 'primary',
      channel_id: '00000000-0000-4000-8000-000000000634',
    });
    // As cinco primitivas de MENSAGEM, pelo objeto que `forChannel` devolve.
    // Nenhuma delas chega ao transporte: o guard lança antes.
    await expect(line.sendText('5511@s.whatsapp.net', 'oi')).rejects.toBeInstanceOf(
      DirectSendViolationError,
    );
    await expect(
      line.sendDocument('5511@s.whatsapp.net', '/tmp/x.pdf', {
        mimetype: 'application/pdf',
        fileName: 'x.pdf',
      }),
    ).rejects.toBeInstanceOf(DirectSendViolationError);
    await expect(
      line.sendVoice('5511@s.whatsapp.net', Buffer.from('ogg')),
    ).rejects.toBeInstanceOf(DirectSendViolationError);
    await expect(
      line.sendPoll('5511@s.whatsapp.net', 'q', [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ]),
    ).rejects.toBeInstanceOf(DirectSendViolationError);
    expect(() => line.sendReaction('5511@s.whatsapp.net', '3EB0', '✅')).toThrow(
      DirectSendViolationError,
    );
    // E `startTyping`/`markRead` NÃO são travados: são presença, não mensagem.
    expect(() => line.markRead('5511@s.whatsapp.net', '3EB0')).not.toThrow();
  });

  it('um id JÁ MIGRADO não pode abrir escopo de exceção', () => {
    // `agent.output_dispatch` existe no inventário, mas com `state:'outbox'`.
    // Se ele precisar enviar, é pelo outbox — e é isso que esta asserção
    // impede de ser contornado copiando um id de outro call site.
    expect(isDeclaredEgressException('agent.output_dispatch')).toBe(false);
    expect(() =>
      withDeclaredEgressException('agent.output_dispatch', async () => undefined),
    ).toThrow(/not declared/);
  });
});

/**
 * Issue #506 (auditoria de fechamento) — A CATRACA.
 *
 * O bloco acima prova "não se envia fora do inventário". Este prova a
 * propriedade que faltava e que é a que sobrevive a esta PR: **o inventário não
 * CRESCE**.
 *
 * A distinção não é acadêmica. Com só as travas da #634, a rota paralela número
 * onze nasce exatamente por onde elas mandam — acrescenta-se uma entrada com
 * `state:'declared_exception'`, escreve-se um `reason` de boa-fé, e tudo fica
 * verde. Foi assim que dez chegaram a dez. O que os casos abaixo asseguram é que
 * a mesma manobra agora é vermelha em dois lugares: no carregamento do módulo de
 * produção e aqui.
 */
describe('#506 — a catraca: o inventário de exceções não cresce', () => {
  it('a ROTA PARALELA DE MENTIRA é recusada, mesmo com reason e containment perfeitos', () => {
    // A sonda literal que o dono pediu: uma rota paralela nova, inventariada
    // "certinho" — motivo escrito, contenção escrita, categoria válida. É o
    // formato EXATO em que as dez exceções de hoje entraram, e a única coisa
    // que a distingue delas é não estar ratificada.
    const rotaDeMentira: OutboundSendPath = {
      id: 'workers.novo_disparador_paralelo',
      module: 'src/workers/novo-disparador-paralelo.ts',
      state: 'declared_exception',
      categories: ['administrative'],
      primitives: ['sendText'],
      what: 'Dispara um aviso novo direto pelo canal.',
      reason: 'Não tem turno, como as outras dez. Justificativa impecável.',
      containment: 'Best-effort, com log de falha. Também impecável.',
      blocked_by: 'no_turn_to_anchor',
      remediation: 'Âncora durável para saída proativa.',
    };
    expect(() => assertRatifiedInventory([...OUTBOUND_SEND_PATHS, rotaDeMentira])).toThrow(
      /NÃO RATIFICADA/,
    );
  });

  it('uma exceção SEM impedimento tipado é recusada — redação não é justificativa', () => {
    // `blocked_by` é o campo que separa "decisão técnica" de "adiamento bem
    // escrito". Sem ele, a entrada é o que o dono chamou de exceção meramente
    // inventariada.
    const semImpedimento = {
      ...OUTBOUND_SEND_PATHS.find((p) => p.id === 'workers.briefings')!,
      blocked_by: undefined,
    };
    expect(() =>
      assertRatifiedInventory([
        ...OUTBOUND_SEND_PATHS.filter((p) => p.id !== 'workers.briefings'),
        semImpedimento,
      ]),
    ).toThrow(/sem 'blocked_by'/);
  });

  it('uma exceção SEM remediação é recusada — toda exceção diz o que a apaga', () => {
    const semRemediacao = {
      ...OUTBOUND_SEND_PATHS.find((p) => p.id === 'workflows.engine')!,
      remediation: '   ',
    };
    expect(() =>
      assertRatifiedInventory([
        ...OUTBOUND_SEND_PATHS.filter((p) => p.id !== 'workflows.engine'),
        semRemediacao,
      ]),
    ).toThrow(/sem 'remediation'/);
  });

  it('o inventário de PRODUÇÃO passa na própria catraca', () => {
    // O módulo já roda isto no import (fail-closed). O caso existe para que a
    // reprovação apareça como asserção nomeada, e não como um erro de import
    // que arrasta o arquivo inteiro sem dizer por quê.
    expect(() => assertRatifiedInventory(OUTBOUND_SEND_PATHS)).not.toThrow();
  });

  it('a catraca SÓ ENCOLHE: nenhum id ratificado sobra sem entrada no inventário', () => {
    // A direção oposta da anterior, e ela é o que impede a lista ratificada de
    // virar um depósito. Migrou a rota? Some com a entrada E com o id. Um id
    // órfão aqui seria uma vaga aberta esperando ocupante.
    const declarados = new Set(declaredExceptions().map((e) => e.id));
    const orfaos = RATIFIED_EXCEPTION_IDS.filter((id) => !declarados.has(id));
    expect(orfaos).toEqual([]);
  });

  it('o TETO acompanha o número real de exceções', () => {
    // Igualdade, e não `<=`: um teto folgado é uma vaga pré-aprovada. A
    // remediação de uma rota migrada inclui BAIXAR este número.
    expect(declaredExceptions()).toHaveLength(MAX_DECLARED_EXCEPTIONS);
    expect(RATIFIED_EXCEPTION_IDS).toHaveLength(MAX_DECLARED_EXCEPTIONS);
  });

  it('todo impedimento declarado pertence ao vocabulário FECHADO', () => {
    for (const e of declaredExceptions()) {
      expect(OUTBOUND_EXCEPTION_BLOCKERS, `${e.id}`).toContain(e.blocked_by);
    }
  });

  it('quem alega "não tem turno" NÃO importa o commit do outbox — a alegação é verificável', () => {
    // O anti-mentira. `no_turn_to_anchor` é o impedimento mais fácil de alegar
    // e o único que o repositório consegue CONFERIR: um módulo que importa
    // `commitOutboundIntent` ou `getOutboundTurnScope` tem, por construção,
    // acesso ao turno — e a alegação seria falsa.
    const mentirosos: string[] = [];
    for (const e of declaredExceptions()) {
      if (e.blocked_by !== 'no_turn_to_anchor') continue;
      const corpo = semComentarios(readFileSync(join(process.cwd(), e.module), 'utf8'));
      if (/commitOutboundIntent|getOutboundTurnScope/.test(corpo)) mentirosos.push(e.id);
    }
    expect(mentirosos).toEqual([]);
  });

  it('todo módulo do inventário EXISTE — uma entrada órfã não protege nada', () => {
    // Uma entrada apontando para um arquivo apagado deixaria a varredura
    // estática silenciosamente sem cobertura naquele ponto, e o inventário
    // pareceria maior do que é.
    const ausentes = OUTBOUND_SEND_PATHS.filter(
      (p) => !existsSync(join(process.cwd(), p.module)),
    ).map((p) => p.module);
    expect(ausentes).toEqual([]);
  });
});

/**
 * Lê a série do texto Prometheus REAL — o mesmo que o `/metrics` publica.
 * Ler um snapshot interno provaria que um `Map` foi escrito; ler o render
 * prova que a série chega ao scraper com o nome que a issue nomeia.
 */
async function contarViolacoes(primitive: string): Promise<number> {
  const texto = await renderPrometheus();
  let total = 0;
  for (const linha of texto.split('\n')) {
    if (!linha.startsWith(METRIC.OUTBOUND_DIRECT_SEND_VIOLATION)) continue;
    if (!linha.includes(`kind="${primitive}"`)) continue;
    const valor = Number(linha.trim().split(/\s+/).pop());
    if (Number.isFinite(valor)) total += valor;
  }
  return total;
}
