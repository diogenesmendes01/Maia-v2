/**
 * Issue #506 (ratificação) — DONO, PRAZO e CONDIÇÃO DE REMOÇÃO das seis
 * exceções de egresso.
 *
 * O dono recusou ratificar as seis em bloco:
 *
 *   > "Não ratifico as seis exceções em bloco. Tragam uma tabela por exceção
 *   >  com callsite, justificativa, controle fail-closed, owner, prazo e
 *   >  condição de remoção."
 *
 * Três dos seis campos não existiam. Este arquivo é a prova de que os três
 * novos não podem apodrecer em silêncio, e ele guarda coisas DIFERENTES do
 * `outbound-trava-envio-direto.spec.ts` — aquele prova que ninguém envia fora
 * do inventário e que o inventário não cresce; este prova que cada linha do
 * inventário ou está COMPLETA ou está VISIVELMENTE incompleta.
 *
 * ─── A decisão do dono (2026-09-03) mudou o que a PRODUÇÃO afirma aqui ──────
 *
 * O dono aceitou as seis individualmente (registro textual no cabeçalho de
 * `send-paths.ts`): cinco TEMPORÁRIAS com owner `diogenesmendes01` e prazo
 * `2026-12-31`, e `agent.react_loop_tool_reaction` como CARVE-OUT best-effort
 * com revisão em `2027-03-31` — revisão de decisão, não expiração de exceção,
 * modelada como `deadline.kind === 'revisao_de_carve_out'` e cobrada por
 * `carveOutReviewsDue()` com mensagem própria. E ele corrigiu a forma das
 * condições de remoção: elas provam que o CALLSITE migrou e o SENDER DIRETO
 * sumiu (sondas `some`), não que a infraestrutura standalone passou a existir.
 * Consequências para este arquivo: `PENDING_OWNER_DECISION_IDS` esvaziou (as
 * guardas de pendência agora precisam FABRICAR uma pendência para ter
 * sujeito), o vencimento de prazo tem cinco sujeitos reais no calendário, e a
 * tripwire passou a ter DUAS direções.
 *
 * ─── As três guardas, e o que cada uma impede ──────────────────────────────
 *
 *   `owner`   — vocabulário FECHADO. Um `owner: string` aceitaria `"time"`,
 *               `"a plataforma"` e `""`. O ADR 0005 já traz `Owner: Maia
 *               maintainers` no cabeçalho, que é exatamente o dono coletivo
 *               que a recusa mira: quando o prazo vence, um time não recebe
 *               e-mail.
 *   `deadline`— uma data que VENCE. É o que separa "exceção temporária" de
 *               "exceção permanente por esquecimento" — o mesmo mecanismo do
 *               ledger de `npm audit` (#526/#574,
 *               `scripts/check-audit-exceptions.ts`), e pelo mesmo motivo.
 *   `removal` — o FATO verificável que apaga a entrada, com SONDA. É o campo
 *               mais fácil de escrever mal: "quando der" e "quando a
 *               arquitetura permitir" são adiamentos com data aberta, não
 *               condições.
 *
 * ─── A sonda de remoção é uma tripwire de DUAS pontas e DUAS direções ──────
 *
 * A tripwire não confere só que a condição está escrita: ela confere que a
 * condição é FALSA hoje — sonda `surge` com o símbolo AUSENTE (o commit
 * standalone ainda não chegou ao callsite), sonda `some` com o símbolo
 * PRESENTE (a chamada direta ainda está lá). No dia em que uma entrada tiver
 * todas as sondas acesas — os `surge` presentes, os `some` ausentes —, este
 * teste fica VERMELHO dizendo que a condição de remoção daquela exceção está
 * SATISFEITA e a entrada deve sair do inventário.
 *
 * É a diferença entre uma condição de remoção e uma promessa: a promessa
 * envelhece calada, e esta grita no dia em que passa a valer.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUTBOUND_EXCEPTION_OWNERS,
  OUTBOUND_SEND_PATHS,
  OWNER_PENDENTE,
  PENDING_OWNER_DECISION_IDS,
  assertRatifiedInventory,
  carveOutReviewsDue,
  declaredExceptions,
  expiredExceptions,
  isCalendarDate,
  isPendingOwnerDecision,
  pendingOwnerDecisions,
  todayUtc,
  type OutboundRemovalProbe,
  type OutboundSendPath,
} from '@/runtime/outbound/send-paths.js';

/**
 * Uma entrada DELIBERADAMENTE quebrada, para exercitar a guarda de RUNTIME.
 *
 * Os três campos novos são obrigatórios no TIPO: uma exceção sem dono ou sem
 * condição de remoção não compila, e essa metade da defesa não tem como ser
 * testada — código que não compila não roda. A metade que este `as` exercita é
 * a que sobra: o que atravessa um cast, um JSON, uma entrada montada em tempo
 * de execução.
 */
function comCampoQuebrado(
  base: OutboundSendPath,
  campos: Record<string, unknown>,
): OutboundSendPath {
  return { ...base, ...campos } as unknown as OutboundSendPath;
}

/** O inventário de produção com UMA exceção substituída pela versão quebrada. */
function inventarioCom(id: string, campos: Record<string, unknown>): OutboundSendPath[] {
  const cobaia = OUTBOUND_SEND_PATHS.find((p) => p.id === id);
  expect(cobaia, `a cobaia '${id}' saiu do inventário — escolha outra exceção viva`).toBeDefined();
  return [...OUTBOUND_SEND_PATHS.filter((p) => p.id !== id), comCampoQuebrado(cobaia!, campos)];
}

/** Comentário fora, código dentro — a mesma redução do teste de trava. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('#506 — dono, prazo e condição de remoção: as guardas', () => {
  it('um owner fora do vocabulário FECHADO é recusado — dono é pessoa, não time', () => {
    // A redação exata que o ADR 0005 usa no cabeçalho. Ela passaria num campo
    // de texto livre, e é o não-dono que a recusa da ratificação em bloco mira.
    expect(() =>
      assertRatifiedInventory(inventarioCom('identity.quarantine', { owner: 'Maia maintainers' })),
    ).toThrow(/fora do vocabulário FECHADO/);
  });

  it('um owner VAZIO é recusado — a string vazia é o dono coletivo mais barato', () => {
    expect(() =>
      assertRatifiedInventory(inventarioCom('identity.quarantine', { owner: '' })),
    ).toThrow(/fora do vocabulário FECHADO/);
  });

  it('uma condição de remoção VAZIA é recusada', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('workers.pending_reminder', {
          removal: { when: '   ', why_sufficient: 'qualquer coisa', probes: [] },
        }),
      ),
    ).toThrow(/sem condição de remoção/);
  });

  it('uma condição de remoção SEM sonda é recusada — sem sonda, o fato é prosa', () => {
    // O caso mais insidioso: a condição está ESCRITA, e bem. O que falta é o
    // lugar onde a máquina confere se ela já vale — e sem esse lugar a exceção
    // sobrevive à própria condição, que é como se chega a uma exceção
    // permanente sem ninguém decidir por isso.
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('workers.pending_reminder', {
          removal: {
            when: 'Quando a arquitetura permitir.',
            why_sufficient: 'Porque aí dá.',
            probes: [],
          },
        }),
      ),
    ).toThrow(/condição de remoção sem sonda/);
  });

  it('uma sonda com módulo ou símbolo vazio é recusada', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          removal: {
            when: 'x',
            why_sufficient: 'y',
            probes: [{ module: '', symbol: 'commitStandaloneOutbound' }],
          },
        }),
      ),
    ).toThrow(/sonda de remoção/);
  });

  it('um prazo que não é data de calendário é recusado — 2026-02-31 não existe', () => {
    // `Date.parse('2026-02-31')` normaliza para 2026-03-03 e daria três dias
    // de vida silenciosos a uma data que ninguém escreveu.
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          owner: 'diogenesmendes01',
          deadline: { kind: 'prazo', expires: '2026-02-31' },
        }),
      ),
    ).toThrow(/não é uma data YYYY-MM-DD existente/);
  });

  it('um prazo SEM dono é recusado — prazo que não vence para ninguém não vence', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          owner: OWNER_PENDENTE,
          deadline: { kind: 'prazo', expires: '2030-01-01' },
        }),
      ),
    ).toThrow(/Prazo exige dono/);
  });

  it('uma pendência NÃO DECLARADA é recusada — a lacuna nova não entra em silêncio', () => {
    // A manobra que esta guarda impede: uma rota ratificada perde o dono (ou
    // o prazo) e a lista de pendências não muda. Uma lacuna a mais que a lista
    // declara, e o diff sem uma linha vermelha em lugar nenhum.
    //
    // Desde a decisão do dono (2026-09-03) a lista de produção está VAZIA —
    // nenhuma exceção de produção é pendente. O caso FABRICA a pendência, e é
    // por isso que a lista entra por parâmetro: sem isso não existiria id
    // capaz de produzir a violação, e o caso seria verde vazio.
    const comPendencia = inventarioCom('identity.quarantine', {
      owner: OWNER_PENDENTE,
      deadline: { kind: 'pendente_do_dono' },
    });
    expect(() => assertRatifiedInventory(comPendencia, [])).toThrow(
      /está pendente do dono[\s\S]*não consta de PENDING_OWNER_DECISION_IDS/,
    );

    // O CONTROLE em dois tempos. Primeiro: a MESMA pendência fabricada passa
    // quando está declarada — a guarda mede a diferença entre as duas listas,
    // não reprova sempre.
    expect(() => assertRatifiedInventory(comPendencia, ['identity.quarantine'])).not.toThrow();

    // Segundo: o inventário de PRODUÇÃO passa com a lista VAZIA — que é
    // exatamente o estado pós-decisão: nada pendente, nada declarado.
    expect(() => assertRatifiedInventory(OUTBOUND_SEND_PATHS, [])).not.toThrow();
    expect(() => assertRatifiedInventory(OUTBOUND_SEND_PATHS)).not.toThrow();
  });

  it('o PRAZO VENCIDO reprova — é o que impede a exceção temporária de virar permanente', () => {
    // A guarda que o dono pediu, com o relógio congelado. O caso fabrica um
    // prazo mais curto que o real para não depender de 2027 chegar.
    const comPrazo = inventarioCom('identity.quarantine', {
      owner: 'diogenesmendes01',
      deadline: { kind: 'prazo', expires: '2026-03-31' },
    });

    // No próprio dia do vencimento ainda vale — `expires` é o último dia.
    expect(expiredExceptions(comPrazo, '2026-03-31')).toHaveLength(0);
    // No dia seguinte, não.
    const vencidas = expiredExceptions(comPrazo, '2026-04-01');
    expect(vencidas.map((e) => e.id)).toEqual(['identity.quarantine']);

    // O calendário de PRODUÇÃO, pós-decisão: em 2099 as CINCO temporárias de
    // prazo 2026-12-31 estão vencidas — e o carve-out da reação NÃO está entre
    // elas, porque revisão de carve-out não é expiração e `expiredExceptions`
    // não a conta. É a modelagem honesta que a decisão pediu: quem vence pelo
    // calendário são as temporárias; o carve-out atrasa REVISÃO, e isso é a
    // guarda seguinte.
    expect(expiredExceptions(OUTBOUND_SEND_PATHS, '2099-12-31').map((e) => e.id).sort()).toEqual([
      'agent.message_update_owner_review',
      'identity.quarantine',
      'scheduling.outbox_drain',
      'workers.idempotency_relayer',
      'workers.pending_reminder',
    ]);
  });

  it('a REVISÃO do carve-out atrasada reprova — com mensagem própria, não como prazo vencido', () => {
    // A decisão de 2026-09-03: a reação é carve-out best-effort com REVISÃO em
    // 2027-03-31. `review_on` é o último dia em que a revisão pode ficar por
    // fazer; no dia seguinte, `carveOutReviewsDue` acende. O fail-closed não
    // afrouxou — mudou a MENSAGEM: o que venceu é a revisão da decisão, não a
    // exceção.
    expect(carveOutReviewsDue(OUTBOUND_SEND_PATHS, '2027-03-31')).toHaveLength(0);
    expect(carveOutReviewsDue(OUTBOUND_SEND_PATHS, '2027-04-01').map((e) => e.id)).toEqual([
      'agent.react_loop_tool_reaction',
    ]);

    // E as duas funções não se contaminam: o carve-out nunca aparece em
    // `expiredExceptions`, e as temporárias nunca aparecem em
    // `carveOutReviewsDue` — cada vermelho pede a ação certa.
    expect(
      expiredExceptions(OUTBOUND_SEND_PATHS, '2099-12-31').map((e) => e.id),
    ).not.toContain('agent.react_loop_tool_reaction');
    expect(carveOutReviewsDue(OUTBOUND_SEND_PATHS, '2099-12-31').map((e) => e.id)).toEqual([
      'agent.react_loop_tool_reaction',
    ]);
  });

  it('uma revisão de carve-out que não é data de calendário é recusada', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('agent.react_loop_tool_reaction', {
          deadline: { kind: 'revisao_de_carve_out', review_on: '2027-02-31' },
        }),
      ),
    ).toThrow(/não é uma data YYYY-MM-DD existente/);
  });

  it('uma revisão de carve-out SEM dono é recusada — revisão que não cobra ninguém não revisa', () => {
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('agent.react_loop_tool_reaction', {
          owner: OWNER_PENDENTE,
          deadline: { kind: 'revisao_de_carve_out', review_on: '2027-03-31' },
        }),
        ['agent.react_loop_tool_reaction'],
      ),
    ).toThrow(/Revisão exige dono/);
  });

  it('uma sonda com sentido fora do vocabulário FECHADO é recusada', () => {
    // O sentido é o que diz se a sonda confere aparição (`surge`) ou
    // desaparecimento (`some`). Um sentido inventado atravessaria um `as` e a
    // tripwire leria a sonda ao contrário — em silêncio.
    expect(() =>
      assertRatifiedInventory(
        inventarioCom('identity.quarantine', {
          removal: {
            when: 'x',
            why_sufficient: 'y',
            probes: [{ module: 'src/identity/quarantine.ts', symbol: 'sendText(', kind: 'existe' }],
          },
        }),
      ),
    ).toThrow(/sonda de sentido 'existe' fora do vocabulário FECHADO/);
  });

  it('`todayUtc` é UTC, e não o fuso da máquina que roda o CI', () => {
    expect(todayUtc(new Date('2026-03-31T23:59:59Z'))).toBe('2026-03-31');
    expect(todayUtc(new Date('2026-04-01T00:00:01Z'))).toBe('2026-04-01');
  });
});

describe('#506 — o inventário de PRODUÇÃO, linha a linha', () => {
  it('os SEIS registros são exatamente os que o dono decidiu em 2026-09-03', () => {
    // A decisão, executável. Se alguém mudar um owner, um prazo ou o tipo do
    // carve-out, este caso fica vermelho citando a decisão que está sendo
    // contrariada — e mudá-lo exige transcrever uma decisão nova.
    const registros = Object.fromEntries(
      declaredExceptions().map((e) => [e.id, { owner: e.owner, deadline: e.deadline }]),
    );
    const temporaria = {
      owner: 'diogenesmendes01',
      deadline: { kind: 'prazo', expires: '2026-12-31' },
    };
    expect(registros).toEqual({
      'agent.message_update_owner_review': temporaria,
      'identity.quarantine': temporaria,
      'scheduling.outbox_drain': temporaria,
      'workers.idempotency_relayer': temporaria,
      'workers.pending_reminder': temporaria,
      'agent.react_loop_tool_reaction': {
        owner: 'diogenesmendes01',
        deadline: { kind: 'revisao_de_carve_out', review_on: '2027-03-31' },
      },
    });
  });

  it('a prioridade do dono está registrada: `workers.pending_reminder` migra primeiro', () => {
    const prioritaria = declaredExceptions().find((e) => e.id === 'workers.pending_reminder');
    expect(prioritaria?.remediation).toMatch(/PRIORITÁRIA por decisão do dono \(2026-09-03\)/);
  });

  it('nenhuma exceção declarada está VENCIDA hoje', () => {
    const vencidas = expiredExceptions(OUTBOUND_SEND_PATHS, todayUtc(new Date()));
    expect(
      vencidas.map((e) => `${e.id} (venceu em ${JSON.stringify(e.deadline)}, dono ${e.owner})`),
      'renove com nova justificativa, migre a rota, ou peça ao dono um prazo novo',
    ).toEqual([]);
  });

  it('nenhuma REVISÃO de carve-out está atrasada hoje', () => {
    const atrasadas = carveOutReviewsDue(OUTBOUND_SEND_PATHS, todayUtc(new Date()));
    expect(
      atrasadas.map((e) => `${e.id} (revisão em ${JSON.stringify(e.deadline)}, dono ${e.owner})`),
      'a decisão do carve-out precisa ser RE-REVISADA pelo dono — a exceção não venceu, a revisão atrasou',
    ).toEqual([]);
  });

  it('toda exceção tem os SEIS campos da tabela do dono preenchidos', () => {
    // Os três primeiros já existiam e estavam espalhados; os três últimos são
    // desta ratificação. O caso os cobra juntos porque é assim que o dono lê a
    // linha: ou ela responde às seis perguntas, ou ela está incompleta.
    const faltando: string[] = [];
    for (const e of declaredExceptions()) {
      if (e.module.trim() === '') faltando.push(`${e.id}: callsite (module)`);
      if (e.reason.trim() === '') faltando.push(`${e.id}: justificativa (reason)`);
      if (e.containment.trim() === '') faltando.push(`${e.id}: controle fail-closed (containment)`);
      if (!OUTBOUND_EXCEPTION_OWNERS.includes(e.owner)) faltando.push(`${e.id}: owner`);
      if (e.removal.when.trim() === '') faltando.push(`${e.id}: condição de remoção`);
      if (e.removal.why_sufficient.trim() === '') faltando.push(`${e.id}: por que a condição basta`);
      if (e.removal.probes.length === 0) faltando.push(`${e.id}: sonda da condição`);
    }
    expect(faltando).toEqual([]);
  });

  it('as pendências do dono são EXATAMENTE as declaradas — hoje: NENHUMA', () => {
    // Pós-decisão de 2026-09-03 os dois lados são vazios, e a igualdade é a
    // guarda viva: uma exceção que volte a ficar pendente sem declaração, ou
    // um id que fique listado depois de ganhar dono e prazo, quebram este
    // caso — a lista não vira depósito nem a lacuna entra em silêncio.
    expect(pendingOwnerDecisions().map((e) => e.id).sort()).toEqual(
      [...PENDING_OWNER_DECISION_IDS].sort(),
    );
    expect(pendingOwnerDecisions()).toEqual([]);
    const orfaos = PENDING_OWNER_DECISION_IDS.filter(
      (id) => !declaredExceptions().some((e) => e.id === id && isPendingOwnerDecision(e)),
    );
    expect(
      orfaos,
      'estes ids não são mais pendências — apague-os de PENDING_OWNER_DECISION_IDS',
    ).toEqual([]);
  });

  it('todo módulo de sonda EXISTE — uma sonda cega não confere nada', () => {
    const ausentes: string[] = [];
    for (const e of declaredExceptions()) {
      for (const probe of e.removal.probes) {
        if (!existsSync(join(process.cwd(), probe.module))) {
          ausentes.push(`${e.id} → ${probe.module}`);
        }
      }
    }
    expect(ausentes).toEqual([]);
  });

  /**
   * `true` quando a PARTE da condição que esta sonda vigia passou a valer:
   * uma `surge` acende quando o símbolo APARECE no módulo; uma `some`, quando
   * ele DESAPARECE. Comentários fora, como na varredura da trava.
   */
  function sondaAcesa(probe: OutboundRemovalProbe): boolean {
    const corpo = semComentarios(readFileSync(join(process.cwd(), probe.module), 'utf8'));
    const presente = corpo.includes(probe.symbol);
    return probe.kind === 'surge' ? presente : !presente;
  }

  it('toda sonda `some` vigia um símbolo que EXISTE hoje — senão ela nasceu acesa', () => {
    // A contrapartida da direção nova. Uma `surge` sobre símbolo presente é
    // pega pela tripwire abaixo; uma `some` sobre símbolo AUSENTE seria pega
    // também — mas com a mensagem errada ("condição satisfeita") para o defeito
    // certo ("a sonda aponta para um sender que nunca existiu ali"). Este caso
    // dá nome ao defeito: cada `some` de produção tem de apontar para uma
    // chamada direta viva, porque é a REMOÇÃO dela que a condição do dono
    // exige provar.
    const cegas: string[] = [];
    for (const e of declaredExceptions()) {
      for (const probe of e.removal.probes) {
        if (probe.kind !== 'some') continue;
        const corpo = semComentarios(readFileSync(join(process.cwd(), probe.module), 'utf8'));
        if (!corpo.includes(probe.symbol)) cegas.push(`${e.id} → ${probe.module}: ${probe.symbol}`);
      }
    }
    expect(
      cegas,
      'estas sondas `some` apontam para um símbolo que já não existe — ou o sender direto ' +
        'sumiu (então a condição avançou e a exceção precisa de revisão) ou a sonda está ' +
        'escrita errada',
    ).toEqual([]);
  });

  /**
   * A TRIPWIRE. Ver o cabeçalho do arquivo.
   *
   * Vermelho aqui NÃO é um defeito: é a notícia de que a condição de remoção
   * de uma exceção passou a valer — na forma corrigida pelo dono (2026-09-03):
   * o callsite migrou E o sender direto sumiu do módulo. A ação é apagar a
   * entrada do inventário, o id de `RATIFIED_EXCEPTION_IDS` e baixar
   * `MAX_DECLARED_EXCEPTIONS` — na mesma PR.
   */
  it('nenhuma condição de remoção JÁ VALE — se valesse, a exceção teria de sair', () => {
    const satisfeitas: string[] = [];
    for (const e of declaredExceptions()) {
      if (e.removal.probes.every(sondaAcesa)) {
        satisfeitas.push(
          `${e.id}: a condição "${e.removal.when}" está SATISFEITA — apague a exceção, ` +
            `o id de RATIFIED_EXCEPTION_IDS e baixe MAX_DECLARED_EXCEPTIONS na mesma PR`,
        );
      }
    }
    expect(satisfeitas).toEqual([]);
  });

  it('cada sonda individual continua apagada — meia condição não é condição', () => {
    // Separado do caso acima de propósito. Aquele responde "a condição já
    // vale?"; este responde "alguma PARTE dela já vale?", e a diferença
    // importa: `workers.pending_reminder` tem três sondas, e quando duas
    // acenderem alguém precisa saber que falta uma — não descobrir isso no dia
    // em que a terceira acender.
    const acesas: string[] = [];
    for (const e of declaredExceptions()) {
      for (const probe of e.removal.probes) {
        if (sondaAcesa(probe)) {
          acesas.push(`${e.id} → ${probe.module}: ${probe.symbol} (${probe.kind})`);
        }
      }
    }
    expect(
      acesas,
      'estas sondas acenderam: a condição de remoção correspondente avançou. Confira se a ' +
        'exceção ainda se justifica e, se não, apague-a; se ainda se justifica, a condição ' +
        'escrita está errada e precisa ser reescrita — não relaxada.',
    ).toEqual([]);
  });

  it('a prova de migração ANCORA no callsite da exceção — infra existir não satisfaz (correção do dono, 2026-09-03)', () => {
    // O buraco que este caso fecha foi encontrado por sonda de revisão: mover
    // a probe `surge commitStandaloneOutbound` do módulo do callsite para
    // `src/runtime/outbound/commit.ts` deixava as 24 asserções deste arquivo
    // VERDES — a regra "a infraestrutura existir NÃO satisfaz esta condição"
    // vivia só em prosa. Duas invariantes estruturais, cada uma com o seu
    // porquê:
    //
    //  1. Toda exceção declarada tem pelo menos UMA probe no próprio módulo
    //     do callsite — a condição de remoção fala do lugar onde o defeito
    //     mora, não de um lugar onde algo novo apareceu.
    //  2. Toda probe `surge` de `commitStandaloneOutbound` aponta para o
    //     callsite da SUA exceção — nunca para a infra de outbound. O símbolo
    //     surgindo em `commit.ts` é a infraestrutura existindo, que é
    //     exatamente o que o dono recusou como prova.
    const semAncora: string[] = [];
    const surgeForaDoCallsite: string[] = [];
    for (const exc of declaredExceptions()) {
      const probes: readonly OutboundRemovalProbe[] = exc.removal.probes;
      if (!probes.some((pr) => pr.module === exc.module)) {
        semAncora.push(`${exc.id} (callsite ${exc.module})`);
      }
      for (const pr of probes) {
        if (pr.symbol === 'commitStandaloneOutbound' && pr.kind === 'surge' && pr.module !== exc.module) {
          surgeForaDoCallsite.push(`${exc.id}: surge de commitStandaloneOutbound em ${pr.module}`);
        }
      }
    }
    // Anti-vacuidade: se `declaredExceptions()` voltar vazio, este caso não
    // olhou para nada — e o inventário diz que são seis.
    expect(declaredExceptions().length).toBeGreaterThan(0);
    expect(
      semAncora,
      'exceção sem NENHUMA probe no próprio callsite: a condição de remoção não fala do lugar ' +
        'onde o sender direto vive, e a migração poderia ser "provada" sem tocar nele.',
    ).toEqual([]);
    expect(
      surgeForaDoCallsite,
      'probe de migração apontando para fora do callsite: "commitStandaloneOutbound surge na ' +
        'infra" é a infraestrutura existindo, não o callsite migrado — a forma exata que o dono ' +
        'recusou em 2026-09-03.',
    ).toEqual([]);
  });
});
