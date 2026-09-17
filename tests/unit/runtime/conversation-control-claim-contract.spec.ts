/**
 * P04.6 (spec §8.2.4 linha 2394, §8.2.5 primeiro bullet) — o CONTRATO do hold de
 * admissão/claim sob controle humano.
 *
 * ─── A cláusula que este arquivo executa ───────────────────────────────────
 *
 * §8.2.4, linha da fronteira `turn-repos.ts` / `claim.ts` / `message-recovery.ts`:
 * "**Admission/claim deve consultar controle, retornar motivo fechado
 * `conversation_human_control`**; recovery/promotion não podem fabricar tentativa
 * nova que ignore a pausa. Não gastar attempts nem fazer retry storm de jobs
 * bloqueados."
 *
 * §8.2.5, primeiro bullet: "Elas podem permanecer em estado operacional não
 * terminal sob hold de controle, mas **todos os scans de recovery/claim devem
 * excluir holds**; não usar TTL Redis como fonte desse hold."
 *
 * ─── Por que esta fatia vem ANTES do cancelamento de backlog (U-P04.5b) ────
 *
 * O §8.2.5 fala em "turnos RETIDOS pelo controle". Antes desta fatia nada os
 * retinha: `claimWithinStreamExclusion` filtrava por escopo, head-of-line e
 * `agent_stream_blocks`, e `findRecoverableTurns` por head-of-line e poison —
 * nenhum dos dois consultava `conversation_controls`. A única barreira de
 * controle existente vivia em `engine-repos.ts` (`c.mode = 'bot'` + epoch), e ela
 * guarda o RUN DO MOTOR, não o turno: sob controle humano o caminho baseline
 * continuava podendo reivindicar e executar. Medido pela porta de produção em
 * `tests/integration/hermes-claim-hold-real-db.spec.ts` antes de existir
 * implementação: das treze sondas, as cinco de concessão passaram e as oito de
 * recusa falharam — inclusive a promoção, que carimbava `promoted_at` no
 * sucessor de uma conversa sob controle humano. Cancelar um backlog "retido"
 * antes de existir retenção seria escrever a limpeza de um estado inalcançável.
 *
 * ─── A régua é a da #629, ponto a ponto ───────────────────────────────────
 *
 * `streamNotPoisoned` é o precedente exato e foi seguido de propósito: predicado
 * INCONDICIONAL (sem flag), com MAIS DE UM consumidor, extraído para módulo puro
 * para que exista UMA definição, e com o número de consumidores AFIRMADO aqui —
 * de modo que acrescentar um caminho de claim sem o predicado obrigue a mexer
 * neste arquivo, que é o momento de perguntar por quê.
 *
 * ─── Por que o predicado mora em `conversation-control-sql.ts` ────────────
 *
 * Decisão registrada, com o argumento contrário junto. A favor: esse módulo já é
 * o dono de `conversation_controls` (o primeiro degrau da ordem de locks do
 * §5.6.3), e pôr o predicado em `stream-head-sql.ts` faria o módulo dono da ORDEM
 * DO TURNO passar a importar o schema de controle do P04. Contra — e é real:
 * `stream-head-sql.ts` já hospeda `streamNotPoisoned`, que também não é sobre
 * ordem, então "predicados de elegibilidade da stream ficam juntos" seria uma
 * regra igualmente defensável, e um leitor que procure "o que pode barrar um
 * claim?" agora tem dois lugares para olhar. O que torna a escolha segura em
 * qualquer dos dois casos é a contagem de consumidores abaixo, não a pasta.
 *
 * ─── Por que `predicado()` e `sonda()` são FUNÇÕES e não constantes ───────
 *
 * Porque a primeira versão deste arquivo as compilava no escopo de módulo, e com
 * a implementação ausente o arquivo inteiro deixava de carregar: ZERO casos
 * executavam e o vermelho não dizia qual comportamento faltava — só que o import
 * falhou. Adiar a chamada para dentro de cada caso é o que faz cada asserção
 * falhar pelo SEU motivo, que é a única forma de um vermelho valer como prova.
 *
 * Puro: compila o SQL com `PgDialect` (sem banco), lê a migration como TEXTO e o
 * repositório como TEXTO-FONTE. Nada aqui precisa de Postgres.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CLAIM_REJECTIONS,
  STREAM_BLOCKED_REASONS,
  STREAM_SCHEDULING_RESULTS,
} from '@/runtime/turns/claim.js';
import {
  streamNotHumanControlled,
  humanControlProbe,
} from '@/db/repositories/conversation-control-sql.js';

const raiz = resolve(__dirname, '../../..');
const migracao = readFileSync(resolve(raiz, 'migrations/140_engine_run_journal.sql'), 'utf8');
const repoFonte = readFileSync(resolve(raiz, 'src/db/repositories/turn-repos.ts'), 'utf8');

/** O SQL de verdade: sem comentários, que aqui falam sobre o que NÃO se faz. */
const semComentarios = (arquivo: string): string =>
  arquivo
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

/** O código de verdade: sem comentários de bloco nem de linha. */
const semDoc = (arquivo: string): string =>
  arquivo
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');

const dialeto = new PgDialect();
const compilar = (fragmento: ReturnType<typeof sql>): string => dialeto.sqlToQuery(fragmento).sql;

const escopo = {
  tenant: sql`${'t-1'}`,
  agent: sql`${'a-1'}`,
  alvo: sql`"agent_turns"`,
};

/** Compilado SOB DEMANDA — ver o cabeçalho sobre o vermelho fraco. */
const predicado = (): string => compilar(streamNotHumanControlled(escopo));
const sonda = (): string =>
  compilar(humanControlProbe({ tenant: sql`${'t-1'}`, agent: sql`${'a-1'}`, turn_id: 'turn-1' }));

describe('P04.6 — o vocabulário do escalonamento ganhou `conversation_human_control`', () => {
  it('é recusa de claim E motivo de bloqueio, com o MESMO nome', () => {
    // O nome NÃO é escolha minha: o §8.2.4 o escreve por extenso ("retornar
    // motivo fechado `conversation_human_control`"). Grafá-lo de outro jeito
    // seria inventar vocabulário onde a spec já deu um.
    expect(CLAIM_REJECTIONS).toContain('conversation_human_control');
    expect(STREAM_BLOCKED_REASONS).toContain('conversation_human_control');
  });

  it('entra no vocabulário central, que agora tem SETE códigos', () => {
    // Acrescentar não é redefinir: nenhuma série existente muda de significado e
    // a nova é semeada em zero, como a #629 fez com `stream_poisoned`. Este
    // teste é o pedágio — o conjunto é afirmado por extenso justamente para que
    // um oitavo código não entre sem alguém escrever por quê.
    expect([...STREAM_SCHEDULING_RESULTS].sort()).toEqual(
      [
        'conversation_human_control',
        'eligible',
        'not_head',
        'promoted',
        'stream_blocked',
        'stream_busy',
        'stream_poisoned',
      ].sort(),
    );
    expect(new Set(STREAM_SCHEDULING_RESULTS).size).toBe(STREAM_SCHEDULING_RESULTS.length);
    expect(new Set(CLAIM_REJECTIONS).size).toBe(CLAIM_REJECTIONS.length);
  });

  it('NÃO é apelido de `stream_poisoned` nem de `stream_blocked`', () => {
    // As três param a conversa e têm remediações diferentes:
    //   `stream_blocked`   -> "vá ao runbook do outbox";
    //   `stream_poisoned`  -> "nada acontece sem um humano DESBLOQUEAR";
    //   `conversation_human_control` -> "nada DEVE acontecer: um humano está
    //                                    atendendo, e a automação volta pelo
    //                                    comando `resume`, não pelo tempo".
    // Colapsá-las mandaria o operador procurar um bloqueio em
    // `agent_stream_blocks` que não existe.
    for (const r of ['stream_poisoned', 'stream_blocked', 'stream_busy'] as const) {
      expect(r).not.toBe('conversation_human_control');
      expect(CLAIM_REJECTIONS).toContain(r);
    }
  });
});

describe('P04.6 — o predicado do hold, e a ausência de uma segunda cópia', () => {
  it('compila para um NOT EXISTS sobre o controle da MESMA stream', () => {
    expect(predicado()).toContain('NOT EXISTS');
    expect(predicado()).toMatch(/controle\.stream_key\s*=\s*"agent_turns"\.stream_key/);
  });

  it('escopa por tenant E agent — a `stream_key` sozinha não basta', () => {
    // Mesma razão da #626/#629: a `stream_key` embute tenant e agent no material
    // canônico, mas embutir não é escopar. Sem o par no predicado, uma
    // `stream_key` colidida faria a pausa de um tenant reter a conversa de
    // outro — e a issue-mãe trata colisão de stream como risco de SEGURANÇA.
    expect(predicado()).toContain('controle.tenant_id');
    expect(predicado()).toContain('controle.agent_id');
    expect(semComentarios(migracao)).toMatch(
      /conversation_controls_stream_uq UNIQUE \(tenant_id, agent_id, stream_key\)/,
    );
  });

  it('retém `pausing` E `human` — o hold é "não é do bot", não "é do humano"', () => {
    // A DECISÃO mais importante do predicado. `pausing` é estado REAL (migration
    // 140: "entre a barreira e a drenagem confirmada existe I/O em voo que
    // ninguém pode declarar morto"), e é exatamente a janela em que o operador
    // já clicou e a plataforma ainda não terminou de parar. Escrever
    // `mode = 'human'` deixaria essa janela ABERTA para novos claims — isto é,
    // o bot poderia começar um turno DEPOIS do clique de pausa, que é o defeito
    // que a fatia inteira existe para impedir.
    expect(predicado()).toMatch(/controle\.mode\s*<>\s*'bot'/);
    expect(predicado()).not.toMatch(/controle\.mode\s*=\s*'human'/);
    // E o domínio dos três modos é o do banco, não uma suposição daqui.
    expect(semComentarios(migracao)).toMatch(
      /mode text NOT NULL DEFAULT 'bot' CHECK \(mode IN \('bot', 'pausing', 'human'\)\)/,
    );
  });

  it('o escape de `stream_key IS NULL` existe, e não é fail-open', () => {
    // Mesma resposta (e mesma razão) de `streamHeadOfLineNotExists` e
    // `streamNotPoisoned`: um turno sem identidade de stream não pertence a
    // conversa nenhuma, e o controle é endereçado POR STREAM
    // (`conversation_controls_stream_uq`) — não existe controle que possa
    // alcançá-lo. Recusá-lo tornaria inclaimável todo turno anterior ao
    // protocolo. Medido neste banco: 10.833 dos 10.957 turnos não têm stream, e
    // ZERO turnos têm stream sem sequência — as duas colunas são gravadas
    // juntas ou nenhuma (`createReceivedTurnTx`).
    expect(predicado()).toMatch(/"agent_turns"\.stream_key IS NULL/);
  });

  it('os consumidores do predicado no repositório chamam a MESMA função', () => {
    // Os QUATRO, espelhando exatamente os de `streamNotPoisoned`: o `WHERE` do
    // claim, o filtro do recovery, o dispatcher cross-tenant e a eleição da
    // promoção.
    //
    // Por que a PROMOÇÃO conta, e é o consumidor menos óbvio: sem o predicado
    // nela, concluir um turno numa conversa sob controle humano PROMOVE o
    // sucessor — medido, não suposto: o caso 12 da suíte de DB real viu
    // `promoted_at` carimbado antes desta fatia existir. O defeito é quase
    // invisível: o job acorda, o claim recusa com `conversation_human_control`,
    // e o único sintoma é um `promoted` que não corresponde a fila nenhuma,
    // mais o retry storm que o §8.2.4 proíbe por escrito.
    //
    // Por que o DISPATCHER cross-tenant conta: ele enumera pares (tenant,
    // agent) com trabalho recuperável. Sem o predicado, um par cujos únicos
    // candidatos estão todos retidos seria enumerado a cada varredura para o
    // inner devolver lista vazia.
    // ⚠️ **ERAM QUATRO, E FALTAVAM DOIS.** A revisão adversarial do desenho do
    // P04.5b.2 encontrou um caminho que eu não tinha visto, e a verificação
    // pessoal confirmou: o FECHADOR DE DEBOUNCE avança turnos de uma conversa
    // retida. `closeDueDebounceBatchTx` põe `status='queued'`, carimba
    // `promoted_at = now()` (dívida de wake-up), zera `next_attempt_at` e
    // empurra `last_ingress_seq` com `GREATEST(...)` — e o `WHERE` dele só
    // confere `state_version`, `debounce_closed_at` e estados reivindicáveis.
    // `listDueDebounceStreams` tampouco consulta controle.
    //
    // O hold do claim impedia a EXECUÇÃO, então nada era respondido — mas a
    // linha era mutada, e o deslocamento de `last_ingress_seq` furava o filtro
    // `last_ingress_seq <= watermark` do descarte de backlog: um head que
    // absorvesse mensagem depois do watermark escapava do cancelamento e
    // voltava a ser reivindicável assim que o modo virasse `bot`.
    //
    // Por que os DOIS, e não só o CAS: a enumeração é sempre ADVISÓRIA — uma
    // pausa pode commitar entre listar e fechar —, então o CAS é a barreira de
    // verdade e a enumeração evita trabalho desperdiçado. É exatamente como
    // `streamNotPoisoned` é usada (filtro do recovery + dispatcher + claim +
    // promoção).
    //
    // ⚠️ **SETE: faltava a RECUPERAÇÃO DE CLAIM EXPIRADO** — achado de revisão da
    // PR #766. `recoverExpiredStreamClaims` roda na transação do claim ANTES do
    // `WHERE` que consulta o controle, e comitava mesmo com o claim recusado: o
    // head vencido virava `retryable`, ganhava `promoted_at`, e o caller o
    // re-enfileirava com duas auditorias — o wake-up fabricado que o §8.2.4
    // proíbe, e que a promoção por conclusão já não fazia desde o P04.6. O
    // varredor, que tem caminho próprio para o mesmo estado, já excluía holds.
    const chamadas = semDoc(repoFonte).match(/streamNotHumanControlled\(/g) ?? [];
    expect(chamadas.length).toBe(7);
  });

  it('a recuperação de claim expirado consulta o controle NO `WHERE` do UPDATE', () => {
    // No WHERE, e não nas CTEs: `ativos` tranca todas as linhas ativas da
    // stream para que o conjunto de locks seja o MESMO em toda transação que a
    // toque (ver o comentário da função). Filtrar ali mudaria o conjunto
    // conforme o modo do controle.
    const codigo = semDoc(repoFonte);
    const inicio = codigo.indexOf('async function recoverExpiredStreamClaims');
    const fim = codigo.indexOf('async function', inicio + 1);
    expect(inicio).toBeGreaterThan(-1);
    const corpo = codigo.slice(inicio, fim);
    expect(corpo.match(/streamNotHumanControlled\(/g) ?? []).toHaveLength(1);
    expect(corpo.indexOf('streamNotHumanControlled(')).toBeGreaterThan(corpo.indexOf('FROM ativos'));
  });

  it('o repositório NÃO tem uma segunda cópia do predicado escrita à mão', () => {
    // A forma que a divergência tomaria: alguém escreve o `NOT EXISTS` inline
    // "só desta vez". O predicado E a sonda vivem em
    // `conversation-control-sql.ts`; no repositório do turno, a tabela de
    // controle não pode ser nomeada.
    const codigo = semDoc(repoFonte);
    expect(codigo).not.toMatch(/conversation_controls/);
    expect(codigo).not.toMatch(/controle\.mode/);
    // E a sonda de diagnóstico é a função, não SQL solto.
    expect(codigo).toContain('humanControlProbe(');
  });
});

describe('P04.6 — a sonda de diagnóstico', () => {
  it('devolve o MODO e o controle, para que a recusa saiba o que dizer', () => {
    // Sem ela, `explainClaimRejection` só poderia devolver `not_eligible`
    // genérico — e o §8.2.4 exige motivo FECHADO. O modo vem junto porque
    // `pausing` e `human` são leituras operacionais diferentes para o console:
    // "estamos parando" e "um humano está atendendo".
    expect(sonda()).toContain('control_id');
    expect(sonda()).toContain('mode');
  });

  it('NUNCA projeta `stream_key` — a issue-mãe a restringe a log protegido', () => {
    // Ela aparece no JOIN, que é onde a comparação acontece; o que não pode é
    // SAIR da consulta, como em `streamPoisonProbe`.
    const texto = sonda();
    const projecao = texto.slice(0, texto.toLowerCase().indexOf('from'));
    expect(projecao).not.toContain('stream_key');
  });

  it('não vaza dono, motivo nem nota — o claim não é a tela de atendimento', () => {
    // `owner_app_user_id`, `reason_code` e `reason_ref` existem na linha e NÃO
    // entram aqui: quem recusa um claim precisa saber que há hold, não quem o
    // colocou. O console lê isso por sua própria porta, com sua própria ACL.
    expect(sonda()).not.toContain('owner_app_user_id');
    expect(sonda()).not.toContain('reason_code');
    expect(sonda()).not.toContain('reason_ref');
  });
});
