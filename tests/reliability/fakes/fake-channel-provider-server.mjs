/**
 * Issue #510 — fake do provider de canal (WhatsApp), em PROCESSO SEPARADO.
 *
 * ─── Por que processo separado, e por que JavaScript puro ────────────────────
 *
 * O ledger deste fake é a única testemunha de "o efeito externo aconteceu". Se
 * ele morasse dentro do worker sob teste, todo cenário que dá `SIGKILL` no
 * worker mataria a testemunha junto — e a pergunta central da matriz FI
 * ("o provider recebeu UM efeito lógico, mesmo com o worker morrendo entre o
 * accept e o persist?") ficaria sem resposta. Ele vive fora, sobrevive ao kill,
 * e o cenário consulta o ledger DEPOIS.
 *
 * É `.mjs` e não `.ts` de propósito: sobe com `node <arquivo>` direto, sem
 * `tsx`, sem transformação, sem cache de build. Um fake que demora 2s para
 * subir some dentro do orçamento de qualquer cenário; um que sobe em ~40ms
 * não. O preço é não ter tipos aqui — pago em `fake-channel-provider.ts`, que
 * é o cliente tipado e é por onde os cenários falam com ele.
 *
 * ─── O que o ledger distingue, e por que ────────────────────────────────────
 *
 *   physical_call_count  quantas vezes a rede chegou aqui
 *   logical_effect_count quantas mensagens o destinatário realmente veria
 *
 * A distinção é o coração da idempotência outbound (#506). Um retry depois de
 * um ACK perdido produz physical=2 / logical=1 — e é ISSO que prova a
 * garantia. Um ledger que contasse só "sends" não conseguiria diferenciar
 * "retry seguro" de "mensagem duplicada para o cliente".
 *
 * ─── Chave igual com payload diferente ───────────────────────────────────────
 *
 * FAIL-CLOSED: 409, `outcome: 'conflict'`, e o efeito lógico NÃO incrementa.
 * Um provider real não tem como saber qual dos dois payloads é o certo; aceitar
 * o segundo entregaria conteúdo errado sob uma chave que o emissor considera
 * já entregue. Recusar e gritar é a única resposta honesta.
 *
 * ─── Limites deste fake (a issue pede que sejam declarados) ──────────────────
 *
 * MAIS FORTE que o WhatsApp real: aqui a chave de idempotência é honrada de
 * verdade e para sempre; o Baileys não oferece essa garantia (`messageID` do
 * cliente reduz, não elimina, duplicata em reconexão).
 * MAIS FRACO: não modela rate limit por número, ban, perda de sessão,
 * reordenação de ACK entre dispositivos, nem os erros de mídia do upload real.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

/**
 * O ledger. `Map` de `idempotency_key` para a entrada — em memória, porque o
 * processo vive mais que o SUT e isso basta: a issue exige que ele sobreviva ao
 * restart do SUT, não ao restart de si mesmo.
 */
const ledger = new Map();
/** Toda chamada física, em ordem, para a timeline do artefato. */
const chamadas = [];
/** Roteiro de comportamentos, consumido em ordem (FIFO). */
let roteiro = [];

function idDeMensagem(chave) {
  return `pm_${createHash('sha256').update(chave).digest('hex').slice(0, 12)}`;
}

function proximoComportamento() {
  return roteiro.length > 0 ? roteiro.shift() : { kind: 'accept' };
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (c) => {
      bruto += c;
      if (bruto.length > 1_000_000) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(bruto.length === 0 ? {} : JSON.parse(bruto));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function responder(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto) });
  res.end(texto);
}

/**
 * O núcleo. Separado do HTTP para que a semântica fique num lugar só e o
 * cliente tipado possa documentá-la sem duplicá-la.
 */
function registrarEnvio({ idempotency_key, payload_hash, tenant_id, agent_id }, comportamento) {
  const agora = Date.now();
  chamadas.push({ idempotency_key, payload_hash, tenant_id, agent_id, at: agora, kind: comportamento.kind });

  const existente = ledger.get(idempotency_key);

  if (existente) {
    existente.physical_call_count += 1;
    if (existente.payload_hash !== payload_hash) {
      // Chave igual, payload diferente. Fail-closed: nenhum efeito novo.
      existente.outcome = 'conflict';
      existente.conflicts = (existente.conflicts ?? 0) + 1;
      return {
        status: 409,
        corpo: {
          outcome: 'conflict',
          reason: 'idempotency_key_reuse_with_different_payload',
          idempotency_key,
          expected_payload_hash: existente.payload_hash,
          received_payload_hash: payload_hash,
          logical_effect_count: existente.logical_effect_count,
        },
      };
    }
    // Replay legítimo: o efeito lógico NÃO cresce.
    return {
      status: 200,
      corpo: {
        outcome: existente.outcome,
        deduplicated: true,
        provider_message_id: existente.provider_message_id,
        idempotency_key,
        physical_call_count: existente.physical_call_count,
        logical_effect_count: existente.logical_effect_count,
      },
    };
  }

  // Primeira vez com esta chave.
  if (comportamento.kind === 'reject') {
    // Rejeitado ANTES de aceitar: nenhum efeito, e a chave fica livre para
    // uma nova tentativa — é o que um provider real faz num 4xx de validação.
    return {
      status: comportamento.status ?? 422,
      corpo: { outcome: 'rejected', reason: comportamento.reason ?? 'rejected_by_provider', idempotency_key },
    };
  }

  const entrada = {
    idempotency_key,
    payload_hash,
    tenant_id: tenant_id ?? null,
    agent_id: agent_id ?? null,
    physical_call_count: 1,
    logical_effect_count: 1,
    provider_message_id: idDeMensagem(idempotency_key),
    outcome: comportamento.kind === 'accept_then_drop' ? 'unknown' : 'accepted',
    first_seen_at: agora,
  };
  ledger.set(idempotency_key, entrada);

  if (comportamento.kind === 'accept_then_drop') {
    // O efeito ACONTECEU e o emissor nunca vê a resposta. É o caso FI-18
    // (`delivery_unknown`): quem chamou não pode concluir "falhou".
    return { status: 'drop', corpo: null, entrada };
  }

  return {
    status: 200,
    corpo: {
      outcome: 'accepted',
      deduplicated: false,
      provider_message_id: entrada.provider_message_id,
      idempotency_key,
      physical_call_count: 1,
      logical_effect_count: 1,
    },
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    responder(res, 200, { ok: true, pid: process.pid });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/ledger') {
    responder(res, 200, {
      entries: [...ledger.values()],
      calls: chamadas,
      physical_call_total: chamadas.length,
      logical_effect_total: [...ledger.values()].reduce((s, e) => s + e.logical_effect_count, 0),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    ledger.clear();
    chamadas.length = 0;
    roteiro = [];
    responder(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/script') {
    lerCorpo(req)
      .then((corpo) => {
        roteiro = Array.isArray(corpo.behaviors) ? corpo.behaviors : [];
        responder(res, 200, { ok: true, pending: roteiro.length });
      })
      .catch((e) => responder(res, 400, { error: String(e && e.message) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    lerCorpo(req)
      .then((corpo) => {
        if (typeof corpo.idempotency_key !== 'string' || corpo.idempotency_key.length === 0) {
          responder(res, 400, { error: 'idempotency_key obrigatório' });
          return;
        }
        if (typeof corpo.payload_hash !== 'string' || corpo.payload_hash.length === 0) {
          responder(res, 400, { error: 'payload_hash obrigatório' });
          return;
        }
        const comportamento = proximoComportamento();
        const r = registrarEnvio(corpo, comportamento);

        const enviar = () => {
          if (r.status === 'drop') {
            // Conexão derrubada DEPOIS do efeito ter sido registrado.
            res.socket?.destroy();
            return;
          }
          responder(res, r.status, r.corpo);
        };

        if (comportamento.delayMs && comportamento.delayMs > 0) {
          const t = setTimeout(enviar, comportamento.delayMs);
          t.unref?.();
        } else {
          enviar();
        }
      })
      .catch((e) => responder(res, 400, { error: String(e && e.message) }));
    return;
  }

  responder(res, 404, { error: 'rota desconhecida' });
});

process.on('uncaughtException', (e) => {
  process.stdout.write(`${LINHA_FATAL} ${JSON.stringify({ tipo: 'uncaughtException', msg: String(e && e.message) })}\n`);
  process.exit(70);
});
process.on('unhandledRejection', (e) => {
  process.stdout.write(`${LINHA_FATAL} ${JSON.stringify({ tipo: 'unhandledRejection', msg: String(e) })}\n`);
  process.exit(71);
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  // Se um socket pendurado (o caso `accept_then_drop`) segurar o `close`, o
  // prazo abaixo garante que o SIGTERM continue sendo um encerramento e não
  // uma promessa. Ele NÃO é uma espera cega de sincronização — é o teto do
  // encerramento gracioso.
  const t = setTimeout(() => process.exit(0), 1_000);
  t.unref?.();
});

// Porta efêmera: o harness nunca fixa porta, senão duas worktrees colidem.
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stdout.write(`${LINHA_PRONTO} ${JSON.stringify({ port, pid: process.pid })}\n`);
});
