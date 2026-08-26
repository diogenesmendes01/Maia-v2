/**
 * Issue #504 — contrato PURO do claim: identidade do job, aritmética do lease e
 * leitura dual do payload.
 *
 * Estes casos não provam concorrência (isso é
 * `tests/integration/turn-claim-real-db.spec.ts`, contra Postgres real). Provam
 * o que é decidível sem infraestrutura, e que quebraria em silêncio se alguém
 * "simplificasse" a derivação do id ou afrouxasse a razão do heartbeat.
 */
import { describe, it, expect } from 'vitest';
import {
  agentTurnJobId,
  turnIdFromJobId,
  parseAgentTurnJob,
  jobVersionLabel,
  AgentTurnJobV2Schema,
  TURN_JOB_ID_PREFIX,
} from '@/runtime/turns/job.js';
import {
  checkLeaseTiming,
  assertLeaseTiming,
  UnsafeLeaseTimingError,
  MAX_HEARTBEAT_TO_TTL_RATIO,
  MAX_HEARTBEAT_FAILURES,
  turnWorkerId,
  __resetTurnWorkerIdForTest,
  CLAIMABLE_STATUSES,
  LEASE_TAKEOVER_STATUSES,
  FENCED_WRITE_STATUSES,
} from '@/runtime/turns/claim.js';
import { TURN_TRANSITIONS, TERMINAL_TURN_STATUSES } from '@/runtime/turns/contract.js';

const TURN_A = '11111111-2222-3333-4444-555555555555';
const TURN_B = '99999999-8888-7777-6666-555555555555';

describe('#504 — jobId determinístico do turno', () => {
  it('é ESTÁVEL: o mesmo turn_id produz o mesmo id em chamadas independentes', () => {
    const first = agentTurnJobId(TURN_A);
    const second = agentTurnJobId(TURN_A);
    expect(first).toBe(second);
    // O valor literal está fixado de propósito: se alguém trocar o esquema de
    // derivação, os jobs armados pelo processo antigo deixam de colidir com os
    // do processo novo durante o deploy rolling — e a duplicação volta em
    // silêncio, sem nenhum outro teste acusar.
    expect(first).toBe(`${TURN_JOB_ID_PREFIX}${TURN_A}`);
  });

  it('turnos DIFERENTES nunca colidem', () => {
    expect(agentTurnJobId(TURN_A)).not.toBe(agentTurnJobId(TURN_B));
  });

  it('normaliza o caso: o UUID em maiúsculas é o MESMO trabalho lógico', () => {
    // Sem isto, um produtor que devolvesse o UUID em maiúsculas armaria um
    // segundo job para o mesmo turno — a chave do Redis é sensível a caso.
    expect(agentTurnJobId(TURN_A.toUpperCase())).toBe(agentTurnJobId(TURN_A));
  });

  it('não usa caractere reservado da BullMQ (`:`) no id', () => {
    expect(agentTurnJobId(TURN_A)).not.toContain(':');
  });

  it('FALHA ALTO em turn_id malformado em vez de gerar um id qualquer', () => {
    expect(() => agentTurnJobId('não-é-uuid')).toThrow(/turn_id inválido/);
    expect(() => agentTurnJobId('')).toThrow(/turn_id inválido/);
  });

  it('a extração é inversa da derivação, e ignora ids de outras filas', () => {
    expect(turnIdFromJobId(agentTurnJobId(TURN_A))).toBe(TURN_A);
    expect(turnIdFromJobId('debounce:t:a:5511999999999')).toBeNull();
    expect(turnIdFromJobId('unrouted-abc')).toBeNull();
    expect(turnIdFromJobId(undefined)).toBeNull();
    expect(turnIdFromJobId(`${TURN_JOB_ID_PREFIX}nao-uuid`)).toBeNull();
  });
});

describe('#504 — contrato do payload (janela de compatibilidade V1/V2)', () => {
  it('V2 aceita SOMENTE version + turn_id', () => {
    expect(AgentTurnJobV2Schema.safeParse({ version: 2, turn_id: TURN_A }).success).toBe(true);
    // Nada de tenant no payload: o worker recarrega do banco depois do claim.
    expect(
      AgentTurnJobV2Schema.safeParse({ version: 2, turn_id: TURN_A, tenant_id: 'x' }).success,
    ).toBe(false);
    expect(AgentTurnJobV2Schema.safeParse({ version: 2, turn_id: 'x' }).success).toBe(false);
    expect(AgentTurnJobV2Schema.safeParse({ version: 1, turn_id: TURN_A }).success).toBe(false);
  });

  it('o worker novo lê V2 e V1 — é o que permite o rollout misto', () => {
    expect(parseAgentTurnJob({ version: 2, turn_id: TURN_A })).toEqual({
      kind: 'v2',
      turn_id: TURN_A,
    });
    expect(parseAgentTurnJob({ mensagem_id: TURN_B })).toEqual({
      kind: 'v1',
      mensagem_id: TURN_B,
      turn_id: null,
    });
    expect(parseAgentTurnJob({ mensagem_id: TURN_B, turn_id: TURN_A })).toEqual({
      kind: 'v1',
      mensagem_id: TURN_B,
      turn_id: TURN_A,
    });
  });

  it('#504 — um payload V2 que tenta CARREGAR escopo não parseia como nada', () => {
    // É a primeira das cinco defesas do resolvedor (`scope-resolver.ts`): o
    // tenant NUNCA pode vir do payload. `AgentTurnJobV2Schema` é `.strict()`,
    // então uma chave extra reprova o V2; e como não há `mensagem_id`, o
    // fallback V1 também reprova. O job forjado vira `invalid`, vira métrica e
    // é recusado antes de qualquer ida ao banco.
    for (const forjado of [
      { version: 2, turn_id: TURN_A, tenant_id: 'vitima' },
      { version: 2, turn_id: TURN_A, agent_id: 'vitima' },
      { version: 2, turn_id: TURN_A, scope: { tenant_id: 'vitima' } },
    ]) {
      const parsed = parseAgentTurnJob(forjado);
      expect(parsed.kind, JSON.stringify(forjado)).toBe('invalid');
    }
    // Contraste deliberado: um payload que carrega `mensagem_id` É um V1
    // legítimo (o schema V1 é `passthrough`), e o `version: 2` ali é ruído.
    // Ele NÃO alcança o resolvedor de escopo — segue o caminho legado, onde
    // quem resolve o tenant é o resolver de canal, exatamente como antes desta
    // issue. Nenhum dos dois ramos aceita tenant vindo do payload.
    expect(parseAgentTurnJob({ version: 2, turn_id: TURN_A, mensagem_id: TURN_B })).toEqual({
      kind: 'v1',
      mensagem_id: TURN_B,
      turn_id: TURN_A,
    });
  });

  it('payload irreconhecível vira resultado TIPADO, nunca throw', () => {
    const parsed = parseAgentTurnJob({ lixo: true });
    expect(parsed.kind).toBe('invalid');
    expect(jobVersionLabel(parsed)).toBe('invalid');
  });

  it('a label de versão tem cardinalidade fechada (critério de remoção do V1)', () => {
    const labels = [
      jobVersionLabel(parseAgentTurnJob({ version: 2, turn_id: TURN_A })),
      jobVersionLabel(parseAgentTurnJob({ mensagem_id: TURN_A })),
      jobVersionLabel(parseAgentTurnJob(null)),
    ];
    expect(new Set(labels)).toEqual(new Set(['v1', 'v2', 'invalid']));
  });
});

describe('#504 — aritmética do lease', () => {
  it('aceita heartbeat até um terço do TTL e recusa acima disso', () => {
    expect(checkLeaseTiming(60_000, 20_000).ok).toBe(true);
    expect(checkLeaseTiming(60_000, 15_000).ok).toBe(true);
    const tooSlow = checkLeaseTiming(60_000, 20_001);
    expect(tooSlow.ok).toBe(false);
    expect(tooSlow.ok === false && tooSlow.reason).toBe('heartbeat_too_slow');
  });

  it('recusa valores não positivos nos dois eixos', () => {
    expect(checkLeaseTiming(0, 1).ok).toBe(false);
    expect(checkLeaseTiming(-1, 1).ok).toBe(false);
    expect(checkLeaseTiming(60_000, 0).ok).toBe(false);
    expect(checkLeaseTiming(Number.NaN, 1).ok).toBe(false);
  });

  it('a razão e a tolerância a falhas são coerentes entre si', () => {
    // Com heartbeat = TTL/3, abortar na 2ª falha consecutiva ainda cai DENTRO
    // da janela (2 × TTL/3 < TTL). Se alguém afrouxar a razão para 1/2 sem
    // mexer no limite de falhas, a 2ª falha passa a cair depois do vencimento —
    // e a tentativa seguiria escrevendo com lease vencida.
    const ttl = 60_000;
    const heartbeat = ttl * MAX_HEARTBEAT_TO_TTL_RATIO;
    expect(heartbeat * MAX_HEARTBEAT_FAILURES).toBeLessThan(ttl);
  });

  it('a variante fail-loud lança com o tipo próprio', () => {
    expect(() => assertLeaseTiming(60_000, 40_000)).toThrow(UnsafeLeaseTimingError);
    expect(() => assertLeaseTiming(60_000, 15_000)).not.toThrow();
  });
});

describe('#504 — identidade do worker', () => {
  it('é estável durante a vida do processo', () => {
    expect(turnWorkerId()).toBe(turnWorkerId());
  });

  it('NÃO é só hostname+pid: duas encarnações no mesmo host se distinguem', () => {
    const first = turnWorkerId();
    __resetTurnWorkerIdForTest();
    const second = turnWorkerId();
    // Mesmo host, mesmo pid (é o mesmo processo) e ainda assim ids distintos —
    // que é o requisito explícito da issue contra reciclagem de PID.
    expect(second).not.toBe(first);
    expect(second.startsWith(first.split(':turn:')[0]!)).toBe(true);
  });
});

describe('#504 — vocabulário de elegibilidade', () => {
  it('nenhum estado TERMINAL é reivindicável', () => {
    for (const terminal of TERMINAL_TURN_STATUSES) {
      expect(CLAIMABLE_STATUSES as readonly string[]).not.toContain(terminal);
      expect(LEASE_TAKEOVER_STATUSES as readonly string[]).not.toContain(terminal);
    }
  });

  it('`outbound_pending` NÃO é tomável por lease vencida', () => {
    // A resposta já está comprometida; reexecutar o ReAct a duplicaria. Quem
    // finaliza é o outbox (#506).
    expect(LEASE_TAKEOVER_STATUSES as readonly string[]).not.toContain('outbound_pending');
    // Mas ele CONTINUA gravável pelo dono: o outbox precisa fechar o turno.
    expect(FENCED_WRITE_STATUSES as readonly string[]).toContain('outbound_pending');
  });

  it('o takeover é uma aresta que a tabela de #503 deliberadamente NÃO tem', () => {
    // Documenta a divergência: `claimed -> claimed` e `running -> claimed` só
    // existem sob lease vencida, condição que a tabela genérica não enxerga.
    // Se um dia alguém as acrescentar lá, `markClaimed` (o caminho legado, sem
    // lease) passaria a poder rebaixar um turno com dono VIVO.
    expect(TURN_TRANSITIONS.claimed).not.toContain('claimed');
    expect(TURN_TRANSITIONS.running).not.toContain('claimed');
  });
});
