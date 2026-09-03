/**
 * Issue #506 — o AVISO PROATIVO é comprometido no ledger ANTES de virar
 * mensagem.
 *
 * O que estas asserções protegem não é a forma da chamada — é a propriedade que
 * as quatro rotas eliminadas nesta fatia não tinham: **existe uma linha no
 * PostgreSQL antes de qualquer coisa sair pelo canal.** Um teste que só checasse
 * "chamou `enqueue`" continuaria verde se alguém acrescentasse um `sendText` de
 * fallback ao lado; por isso o caso do fim carrega a fronteira REAL de saída e
 * prova que ela recusa o emissor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { enqueueMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'outbox-1' })),
}));

vi.mock('@/scheduling/repos.js', () => ({ outboxRepo: { enqueue: enqueueMock } }));

import { enqueueProactiveNotice } from '@/runtime/outbound/proactive-notice.js';

beforeEach(() => {
  enqueueMock.mockClear();
  enqueueMock.mockImplementation(async () => ({ id: 'outbox-1' }));
});

describe('#506 — enqueueProactiveNotice', () => {
  it('grava a intenção no ledger de agendamento como `whatsapp_text`, sem ocorrência nem task', async () => {
    const outcome = await enqueueProactiveNotice({
      jid: '5511999@s.whatsapp.net',
      text: 'Solicitação AP-abc expirou.',
      dedupe_key: 'approval_request:11111111-1111-4111-8111-111111111111:expired',
    });

    expect(outcome).toBe('enqueued');
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe('whatsapp_text');
    expect(arg.payload).toEqual({ jid: '5511999@s.whatsapp.net', text: 'Solicitação AP-abc expirou.' });
    expect(arg.dedup_key).toBe(
      'approval_request:11111111-1111-4111-8111-111111111111:expired',
    );
    // `occurrence_id`/`task_id` NULOS de propósito: o drain só acopla conclusão
    // de task/ocorrência quando eles existem. Um aviso de governança que
    // fechasse uma ocorrência de agendamento seria um efeito colateral em
    // outro subsistema.
    expect(arg.occurrence_id).toBeNull();
    expect(arg.task_id).toBeNull();
  });

  it('NÃO fixa canal quando o chamador não o conhece — a resolução fail-closed fica com o repositório', async () => {
    await enqueueProactiveNotice({ jid: 'j', text: 't', dedupe_key: 'k1' });
    const arg = enqueueMock.mock.calls[0]![0] as Record<string, unknown>;
    expect('channel_id' in arg).toBe(false);
  });

  it('propaga o canal EXPLÍCITO quando o chamador o conhece', async () => {
    await enqueueProactiveNotice({
      jid: 'j',
      text: 't',
      dedupe_key: 'k2',
      channel_id: '00000000-0000-4000-8000-000000000506',
    });
    const arg = enqueueMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.channel_id).toBe('00000000-0000-4000-8000-000000000506');
  });

  it('colisão de chave é `already_enqueued`, não erro — o aviso já estava comprometido', async () => {
    // `outboxRepo.enqueue` devolve `null` quando o UNIQUE parcial
    // `idx_outbox_dedup` (migração 007) recusa a inserção. Confundir isso com
    // falha faria o chamador tentar de novo para sempre; confundir com sucesso
    // silencioso esconderia um erro de derivação de chave. Por isso o desfecho
    // é NOMEADO.
    enqueueMock.mockImplementationOnce(async () => null);
    const outcome = await enqueueProactiveNotice({ jid: 'j', text: 't', dedupe_key: 'k3' });
    expect(outcome).toBe('already_enqueued');
  });

  it('falha do banco SOBE — sem linha no ledger não há aviso, e seguir seria fail-open', async () => {
    enqueueMock.mockImplementationOnce(async () => {
      throw new Error('connection terminated');
    });
    await expect(
      enqueueProactiveNotice({ jid: 'j', text: 't', dedupe_key: 'k4' }),
    ).rejects.toThrow(/connection terminated/);
  });

  it('não toca primitiva de canal nenhuma — o emissor é ledger, não gateway', async () => {
    // A prova negativa que importa: se alguém acrescentar um envio direto de
    // "fallback" aqui, este caso fica vermelho ANTES de a trava arquitetural
    // de #634 reprovar o módulo.
    const fonte = await import('node:fs').then((fs) =>
      fs.readFileSync('src/runtime/outbound/proactive-notice.ts', 'utf8'),
    );
    const semComentarios = fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(semComentarios).not.toMatch(/\.send(Text|Document|Voice|Poll|Reaction)\s*\(/);
  });
});
